import { CommonModule } from '@angular/common';
import { Component, ElementRef, OnDestroy, OnInit, ViewChild, inject } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { Subscription } from 'rxjs';
import {
  PublicPayChargeResponse,
  PublicPayService,
  PublicPaySessionResponse,
} from '../../../core/http/public-pay.service';
import { SquareWebPaymentsService } from '../../../core/payments/square-web-payments.service';

@Component({
  selector: 'app-public-pay',
  imports: [CommonModule],
  templateUrl: './pay.html',
  styleUrl: './pay.scss',
})
export class PublicPayPage implements OnInit, OnDestroy {
  private route = inject(ActivatedRoute);
  private api = inject(PublicPayService);
  private squareWebPayments = inject(SquareWebPaymentsService);

  loading = false;
  preparing = false;
  processing = false;
  error: string | null = null;
  notice: string | null = null;
  session: PublicPaySessionResponse | null = null;
  result: PublicPayChargeResponse | null = null;

  eventDate = '';
  reservationId = '';
  token = '';

  @ViewChild('cashAppHost') cashAppHost?: ElementRef<HTMLElement>;
  private routeSub: Subscription | null = null;
  private cashAppDestroy: (() => Promise<void>) | null = null;
  private prepareRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly maxPrepareAttempts = 6;

  ngOnInit(): void {
    this.routeSub = this.route.queryParamMap.subscribe((params) => {
      this.eventDate = String(params.get('eventDate') ?? '').trim();
      this.reservationId = String(params.get('reservationId') ?? '').trim();
      this.token = String(params.get('token') ?? '').trim();
      this.result = null;
      this.clearPrepareRetryTimer();
      void this.destroyCashAppWidget();
      this.loadSession();
    });
  }

  ngOnDestroy(): void {
    this.routeSub?.unsubscribe();
    this.routeSub = null;
    this.clearPrepareRetryTimer();
    void this.destroyCashAppWidget();
  }

  expiresAtLabel(): string {
    const epoch = Number(this.session?.session?.expiresAt ?? 0);
    if (!Number.isFinite(epoch) || epoch <= 0) return '—';
    return new Date(epoch * 1000).toLocaleString();
  }

  refresh(): void {
    this.result = null;
    this.clearPrepareRetryTimer();
    void this.destroyCashAppWidget();
    this.loadSession();
  }

  private loadSession(): void {
    if (!this.eventDate || !this.reservationId || !this.token) {
      this.session = null;
      this.error = 'This payment link is invalid. Missing token or reservation context.';
      this.loading = false;
      return;
    }
    this.loading = true;
    this.error = null;
    this.notice = null;
    this.api.getSession(this.eventDate, this.reservationId, this.token).subscribe({
      next: (res) => {
        this.session = res;
        this.loading = false;
        this.schedulePrepareCashAppWidget(0);
      },
      error: (err) => {
        this.session = null;
        this.loading = false;
        this.error = err?.error?.message || err?.message || 'Unable to load payment link.';
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
    const session = this.session;
    const host = this.cashAppHost?.nativeElement;
    if (!session || this.result) return;
    if (!host) {
      this.schedulePrepareCashAppWidget(attempt + 1);
      return;
    }

    this.preparing = true;
    this.notice = null;
    this.error = null;
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
        onTokenized: (sourceId) => {
          setTimeout(() => {
            this.capturePayment(sourceId);
          }, 0);
        },
        onError: (message) => {
          setTimeout(() => {
            this.error = message || 'Cash App Pay was not completed.';
          }, 0);
        },
      });
      this.cashAppDestroy = mounted.destroy;
      this.notice = 'Payment options loaded. Complete payment on this page.';
    } catch (err: unknown) {
      const message =
        (err as { message?: string } | null | undefined)?.message ||
        'Unable to initialize payment options.';
      if (attempt < this.maxPrepareAttempts && this.shouldRetryPrepareError(message)) {
        this.schedulePrepareCashAppWidget(attempt + 1);
      } else {
        this.error = message;
      }
    } finally {
      this.preparing = this.prepareRetryTimer !== null;
    }
  }

  private capturePayment(sourceId: string): void {
    const session = this.session;
    if (!session || this.processing) return;
    this.processing = true;
    this.error = null;
    this.notice = null;

    this.api
      .charge({
        eventDate: session.reservation.eventDate,
        reservationId: session.reservation.reservationId,
        token: this.token,
        sourceId,
      })
      .subscribe({
        next: (res) => {
          this.result = res;
          this.processing = false;
          this.notice = 'Payment completed successfully.';
          void this.destroyCashAppWidget();
        },
        error: (err) => {
          this.processing = false;
          this.error = err?.error?.message || err?.message || 'Payment failed. Please try again.';
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
