import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  EventEmitter,
  Input,
  NgZone,
  OnDestroy,
  Output,
  ViewChild,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';

import { SquareWebPaymentsService } from '../../../core/payments/square-web-payments.service';
import { HlmAlert } from '../../ui/alert';
import { HlmBadge, BadgeVariants } from '../../ui/badge';

type CashAppPadStatus =
  | 'idle'
  | 'preparing'
  | 'ready'
  | 'awaiting-approval'
  | 'success'
  | 'error';

type BaseStatus = Exclude<CashAppPadStatus, 'success'>;

@Component({
  selector: 'cash-app-qr-pad',
  standalone: true,
  imports: [CommonModule, HlmAlert, HlmBadge],
  templateUrl: './cash-app-qr-pad.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CashAppQrPad implements OnDestroy {
  // Square Web Payments configuration. Parent feeds these in from
  // `/admin/settings`-driven runtime config.
  @Input() applicationId = '';
  @Input() locationId = '';
  @Input() squareEnvMode: 'sandbox' | 'production' = 'sandbox';
  @Input() amount = 0;
  @Input() label = 'Reservation payment';
  @Input() referenceId = '';

  // Parent flips to `true` after the backend confirms the charge — the
  // pad shows a green "Paid" state for ~1.5s before the parent dismisses
  // the modal. The pre-tokenization states (preparing → ready →
  // awaiting-approval) are driven internally by the SDK callbacks; the
  // parent never needs to thread "charging" through.
  //
  // Use the signal-backed `input()` so binding writes during CD don't
  // re-enter the component's own change-detection (the @Input setter
  // pattern triggers Angular's dev-mode ExpressionChangedAfterItHasBeen
  // CheckedError).
  readonly success = input(false);

  @Output() tokenized = new EventEmitter<string>();
  @Output() errored = new EventEmitter<string>();

  @ViewChild('cashAppPayHost', { static: true })
  cashAppPayHost!: ElementRef<HTMLElement>;

  private squareWebPayments = inject(SquareWebPaymentsService);
  private zone = inject(NgZone);

  private destroyFn: (() => Promise<void>) | null = null;

  // Internal SDK-driven status. The parent-driven `success` input is
  // composed over this via the `status` computed below — `success` wins
  // when set, otherwise the SDK lifecycle drives the label.
  private readonly _baseStatus = signal<BaseStatus>('idle');
  private readonly _errorMessage = signal<string | null>(null);

  // Detected once at construction; the SDK renders a tap-to-deep-link
  // button on phone-class viewports (instead of a QR), which defeats the
  // "staff shows, customer scans" pattern. Surface a hint so the staff
  // knows to switch to the host-stand iPad.
  readonly showPhoneHint = (() => {
    if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
    const touch = Number((navigator as { maxTouchPoints?: number }).maxTouchPoints ?? 0);
    const narrow = window.innerWidth < 768;
    return touch > 1 && narrow;
  })();

  readonly status = computed<CashAppPadStatus>(() =>
    this.success() ? 'success' : this._baseStatus()
  );
  readonly preparing = computed(() => this.status() === 'preparing');
  readonly ready = computed(() => {
    const s = this.status();
    return s === 'ready' || s === 'awaiting-approval';
  });
  readonly errorMessage = computed(() => this._errorMessage());

  readonly statusLabel = computed(() => {
    switch (this.status()) {
      case 'idle':
        return 'Tap "Show Cash App QR" below.';
      case 'preparing':
        return 'Preparing the QR…';
      case 'ready':
        return 'Scan with Cash App to pay';
      case 'awaiting-approval':
        return 'Recording payment with Square…';
      case 'success':
        return 'Paid';
      case 'error':
        return this._errorMessage() ?? 'Something went wrong.';
    }
  });

  readonly statusBadgeText = computed(() => {
    switch (this.status()) {
      case 'idle':
        return 'Off';
      case 'preparing':
        return 'Loading';
      case 'ready':
        return 'Waiting for scan';
      case 'awaiting-approval':
        return 'Processing';
      case 'success':
        return 'Done';
      case 'error':
        return 'Error';
    }
  });

  readonly statusBadgeVariant = computed<BadgeVariants['variant']>(() => {
    switch (this.status()) {
      case 'success':
        return 'success';
      case 'error':
        return 'danger';
      case 'idle':
        return 'secondary';
      default:
        return 'warning';
    }
  });

  ngOnDestroy(): void {
    void this.destroy();
  }

  async prepare(): Promise<void> {
    const host = this.cashAppPayHost?.nativeElement;
    if (!host) {
      this.setError('Cash App Pay UI is not ready. Close and reopen, then try again.');
      return;
    }
    if (!this.applicationId || !this.locationId) {
      this.setError('Square is not configured. Set application id and location id in Lambda env vars.');
      return;
    }
    if (!Number.isFinite(this.amount) || this.amount <= 0) {
      this.setError('Amount must be greater than 0.');
      return;
    }

    this._baseStatus.set('preparing');
    this._errorMessage.set(null);

    try {
      await this.destroy();
      const session = await this.squareWebPayments.mountCashAppPayButton({
        applicationId: this.applicationId,
        locationId: this.locationId,
        amount: this.amount,
        container: host,
        label: this.label,
        referenceId: this.referenceId,
        squareEnvMode: this.squareEnvMode,
        // The SDK fires callbacks outside the Angular zone (it doesn't
        // know about us). Re-enter the zone so signal writes flush CD.
        onTokenized: (sourceId) => {
          this.zone.run(() => {
            this._baseStatus.set('awaiting-approval');
            this.tokenized.emit(sourceId);
          });
        },
        onError: (message) => {
          this.zone.run(() => {
            this.setError(message || 'Cash App Pay was not completed.');
            this.errored.emit(message || 'Cash App Pay was not completed.');
          });
        },
      });
      this.destroyFn = session.destroy;
      this._baseStatus.set('ready');
      // Square's SDK doesn't render the QR inline — `attach()` mounts a
      // "Cash App Pay" pill button, and the QR appears in their own
      // lightbox/overlay only after the button is clicked. For the
      // staff-shows-customer-scans pattern we want one staff click
      // ("Show Cash App QR") to take them straight to the QR, so we
      // synthesize the button click here on desktop-class viewports.
      //
      // On phone-class viewports the SDK deep-links to the Cash App app
      // on the same device instead of showing a QR — useless for the
      // in-venue flow — so we skip auto-click there (the inline hint
      // already nudges staff to switch to the host iPad).
      if (!this.showPhoneHint) {
        setTimeout(() => this.triggerSdkButton(), 0);
      }
    } catch (err: unknown) {
      const message =
        (err as { message?: string } | null | undefined)?.message ??
        'Failed to initialize Cash App Pay.';
      this.setError(message);
      this.errored.emit(message);
    }
  }

  async destroy(): Promise<void> {
    const fn = this.destroyFn;
    this.destroyFn = null;
    if (fn) {
      try {
        await fn();
      } catch {
        // Best-effort teardown.
      }
    }
    const host = this.cashAppPayHost?.nativeElement;
    if (host) host.innerHTML = '';
    if (this._baseStatus() !== 'error') {
      this._baseStatus.set('idle');
    }
  }

  reset(): void {
    this._baseStatus.set('idle');
    this._errorMessage.set(null);
  }

  private setError(message: string): void {
    this._errorMessage.set(message);
    this._baseStatus.set('error');
  }

  // Find the SDK-rendered "Cash App Pay" pill button and click it so the
  // QR overlay opens without a second user gesture. Public so a staff
  // template button can also drive it ("Open Cash App QR again") if the
  // overlay was closed accidentally.
  triggerSdkButton(): void {
    const host = this.cashAppPayHost?.nativeElement;
    if (!host) return;
    // The SDK can wrap its button in different elements across versions
    // (button, [role="button"], div.sq-button…). Pick the first
    // interactive descendant.
    const candidate =
      (host.querySelector('button') as HTMLElement | null) ??
      (host.querySelector('[role="button"]') as HTMLElement | null) ??
      (host.querySelector('div[onclick], div[tabindex]') as HTMLElement | null);
    if (candidate && typeof (candidate as HTMLElement).click === 'function') {
      (candidate as HTMLElement).click();
    }
  }
}
