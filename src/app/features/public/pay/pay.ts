import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, NgZone, OnDestroy, OnInit, ViewChild, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import {
  CashAppChargeResponse,
  CashAppSessionResponse,
  PublicPayService,
} from '../../../core/http/public-pay.service';
import { SquareWebPaymentsService } from '../../../core/payments/square-web-payments.service';
import { HlmAlert } from '../../../shared/ui/alert';
import { HlmButton } from '../../../shared/ui/button';

@Component({
  selector: 'app-public-pay',
  imports: [CommonModule, HlmAlert, HlmButton],
  templateUrl: './pay.html',
  styleUrl: './pay.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PublicPayPage implements OnInit, OnDestroy {
  private route = inject(ActivatedRoute);
  private api = inject(PublicPayService);
  private squareWebPayments = inject(SquareWebPaymentsService);
  private zone = inject(NgZone);
  private destroyRef = inject(DestroyRef);

  readonly loading = signal(false);
  readonly preparing = signal(false);
  readonly processing = signal(false);
  readonly error = signal<string | null>(null);
  readonly notice = signal<string | null>(null);
  readonly session = signal<CashAppSessionResponse | null>(null);
  readonly result = signal<CashAppChargeResponse | null>(null);

  eventDate = '';
  reservationId = '';
  token = '';

  @ViewChild('cashAppHost') cashAppHost?: ElementRef<HTMLElement>;
  private cashAppDestroy: (() => Promise<void>) | null = null;
  private prepareRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly maxPrepareAttempts = 6;

  ngOnInit(): void {
    this.route.queryParamMap
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((params) => {
        this.eventDate = String(params.get('eventDate') ?? '').trim();
        this.reservationId = String(params.get('reservationId') ?? '').trim();
        this.token = String(params.get('token') ?? '').trim();
        this.result.set(null);
        this.clearPrepareRetryTimer();
        void this.destroyCashAppWidget();
        this.loadSession();
      });
  }

  ngOnDestroy(): void {
    this.clearPrepareRetryTimer();
    void this.destroyCashAppWidget();
  }

  expiresAtLabel(): string {
    const epoch = Number(this.session()?.session?.expiresAt ?? 0);
    if (!Number.isFinite(epoch) || epoch <= 0) return '—';
    return new Date(epoch * 1000).toLocaleString();
  }

  formatEventDateLong(value: string | null | undefined): string {
    const raw = String(value ?? '').trim();
    if (!raw) return 'Event date';
    const parsed = new Date(`${raw}T00:00:00`);
    if (Number.isNaN(parsed.getTime())) return raw;
    return parsed.toLocaleDateString(undefined, {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    });
  }

  refresh(): void {
    this.result.set(null);
    this.clearPrepareRetryTimer();
    void this.destroyCashAppWidget();
    this.loadSession();
  }

  private loadSession(): void {
    if (!this.eventDate || !this.reservationId || !this.token) {
      this.session.set(null);
      this.error.set('This payment link is invalid. Missing token or reservation context.');
      this.loading.set(false);
      return;
    }
    this.loading.set(true);
    this.error.set(null);
    this.notice.set(null);
    this.api.getSession(this.eventDate, this.reservationId, this.token).subscribe({
      next: (res) => {
        this.session.set(res);
        this.loading.set(false);
        this.schedulePrepareCashAppWidget(0);
      },
      error: (err) => {
        this.session.set(null);
        this.loading.set(false);
        this.error.set(err?.error?.message || err?.message || 'Unable to load payment link.');
      },
    });
  }

  private schedulePrepareCashAppWidget(attempt: number): void {
    if (attempt > this.maxPrepareAttempts) return;
    this.clearPrepareRetryTimer();
    const delayMs = attempt === 0 ? 0 : Math.min(200 * 2 ** (attempt - 1), 1200);
    this.prepareRetryTimer = setTimeout(() => {
      this.prepareRetryTimer = null;
      void this.prepareCashAppWidget(attempt);
    }, delayMs);
  }

  private clearPrepareRetryTimer(): void {
    if (this.prepareRetryTimer) {
      clearTimeout(this.prepareRetryTimer);
      this.prepareRetryTimer = null;
    }
  }

  private shouldRetryPrepareError(message: string | null | undefined): boolean {
    const value = String(message ?? '').trim().toLowerCase();
    if (!value) return false;
    return (
      value.includes('sdk') ||
      value.includes('loaded') ||
      value.includes('initialize') ||
      value.includes('unavailable')
    );
  }

  private async prepareCashAppWidget(attempt = 0): Promise<void> {
    const session = this.session();
    const host = this.cashAppHost?.nativeElement;
    if (!session || this.result()) return;
    if (!host) {
      this.schedulePrepareCashAppWidget(attempt + 1);
      return;
    }

    this.preparing.set(true);
    this.notice.set(null);
    this.error.set(null);
    try {
      await this.destroyCashAppWidget();
      const mounted = await this.squareWebPayments.mountCashAppPayButton({
        applicationId: session.square.applicationId,
        locationId: session.square.locationId,
        squareEnvMode: session.square.envMode,
        amount: Number(session.reservation.chargeAmount ?? 0),
        label: `Table ${session.reservation.tableId ?? ''} payment`.trim(),
        referenceId: session.reservation.reservationId,
        container: host,
        // Square's SDK fires these callbacks outside the Angular zone (it
        // doesn't know about us). Re-enter the zone so change detection
        // picks up `processing` / `error` / `result` signal writes
        // cleanly. Signal writes alone mark the view dirty, but flush
        // still needs a zone tick.
        onTokenized: (sourceId) => {
          this.zone.run(() => this.capturePayment(sourceId));
        },
        onError: (message) => {
          this.zone.run(() => {
            this.error.set(message || 'Cash App Pay was not completed.');
          });
        },
      });
      this.cashAppDestroy = mounted.destroy;
      this.notice.set('Payment options loaded. Complete payment on this page.');
    } catch (err: unknown) {
      const message =
        (err as { message?: string } | null | undefined)?.message ||
        'Unable to initialize payment options.';
      if (attempt < this.maxPrepareAttempts && this.shouldRetryPrepareError(message)) {
        this.schedulePrepareCashAppWidget(attempt + 1);
      } else {
        this.error.set(message);
      }
    } finally {
      this.preparing.set(this.prepareRetryTimer !== null);
    }
  }

  private capturePayment(sourceId: string): void {
    const session = this.session();
    if (!session || this.processing()) return;
    this.processing.set(true);
    this.error.set(null);
    this.notice.set(null);

    this.api
      .charge({
        eventDate: session.reservation.eventDate,
        reservationId: session.reservation.reservationId,
        token: this.token,
        sourceId,
      })
      .subscribe({
        next: (res) => {
          this.result.set(res);
          this.processing.set(false);
          this.notice.set('Payment completed successfully.');
          void this.destroyCashAppWidget();
        },
        error: (err) => {
          this.processing.set(false);
          this.error.set(err?.error?.message || err?.message || 'Payment failed. Please try again.');
        },
      });
  }

  private async destroyCashAppWidget(): Promise<void> {
    const destroy = this.cashAppDestroy;
    this.cashAppDestroy = null;
    if (destroy) {
      try {
        await destroy();
      } catch {
        // Best-effort teardown.
      }
    }
    const host = this.cashAppHost?.nativeElement;
    if (host) host.innerHTML = '';
  }
}
