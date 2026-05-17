import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  EventEmitter,
  Input,
  OnDestroy,
  Output,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import {
  ReservationsService,
  StartSquareStandHandoffResponse,
} from '../../../core/http/reservations.service';
import { HlmAlert } from '../../ui/alert';
import { HlmBadge, BadgeVariants } from '../../ui/badge';
import { HlmButton } from '../../ui/button';

type HandoffStatus =
  | 'idle'
  | 'starting'
  | 'handing-off'
  | 'awaiting-callback'
  | 'success'
  | 'cancelled'
  | 'error';

type BaseStatus = Exclude<HandoffStatus, 'success'>;

/**
 * Stand-handoff button. Mounts inside the take-payment modal + wizard
 * post-create section when staff picks "Card on Stand".
 *
 * Flow:
 *  1. Tap "Hand off to Square POS" → POST /payment/square-stand/start
 *     mints a handoff id (server-side row, 15-min TTL).
 *  2. Build the `square-commerce-v1://payment/create?data=...` URL with:
 *      - amount_money (cents)
 *      - callback_url (the absolute origin path of /staff/square-stand-callback)
 *      - client_id (Square Application ID, configured in /admin/settings)
 *      - state (handoffId — round-tripped via Square POS)
 *      - notes (Booking #FF-XXXXXX · date — webhook can also parse this)
 *      - options.supported_tender_types: ["CREDIT_CARD"] (locked — we
 *        don't want cash/other tenders through the URL-scheme path)
 *      - options.auto_return: true (Square POS hops back to Safari)
 *  3. window.location.href = the URL → iOS launches Square POS.
 *  4. After Square POS finishes, it redirects Safari to /staff/square-stand-callback.
 *     That route component completes the handoff via the server.
 *
 * If Square POS isn't installed, iOS silently no-ops the URL scheme.
 * We detect that by checking document.visibilityState ~2.5s after the
 * navigation: still "visible" means the app never opened.
 */
@Component({
  selector: 'square-stand-handoff',
  standalone: true,
  imports: [CommonModule, HlmAlert, HlmBadge, HlmButton],
  templateUrl: './square-stand-handoff.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SquareStandHandoff implements OnDestroy {
  // Required: reservation context.
  @Input({ required: true }) reservationId = '';
  @Input({ required: true }) eventDate = '';
  @Input({ required: true }) amount = 0;

  // Required: Square Application ID (the same one used for Web Payments
  // SDK / Cash App QR). Comes from /admin/settings runtime config.
  @Input() applicationId = '';

  // Optional cosmetic + control inputs.
  @Input() note = '';
  // Where to send the user after the callback completes successfully.
  // Defaults to /staff/reservations. Wizard passes /staff/reservations-new.
  @Input() returnPath = '/staff/reservations';
  @Input() label = 'Reservation payment';
  // Short, customer-facing FF-XXXXXX. Used in the Square POS `notes`
  // field so the webhook can match the payment back to the reservation
  // even if our synchronous callback never completes.
  @Input() confirmationCode: string | null | undefined = null;
  // Currency for amount_money. Matches the BE SQUARE_CURRENCY default.
  @Input() currencyCode = 'USD';

  // When true, the pad doesn't render its own "Hand off" button — the
  // caller (e.g. take-payment-modal) drives `start()` via its own
  // submit button. Status + error UI still render.
  @Input() hideInternalButton = false;

  // Parent flips this to true when the callback page POSTs /complete
  // successfully — the pad shows a green "Paid" state. Use the
  // signal-input form so binding writes during CD don't trip
  // ExpressionChangedAfterItHasBeenCheckedError.
  readonly success = input(false);

  @Output() handoffStarted = new EventEmitter<StartSquareStandHandoffResponse>();
  @Output() handoffFailed = new EventEmitter<string>();
  // Fired when the URL scheme didn't appear to open Square POS
  // (page still visible after the timer). Lets the parent show an
  // install-Square-POS hint without re-implementing the detection.
  @Output() squarePosMissing = new EventEmitter<void>();

  private reservationsApi = inject(ReservationsService);
  private destroyRef = inject(DestroyRef);

  private readonly _baseStatus = signal<BaseStatus>('idle');
  private readonly _errorMessage = signal<string | null>(null);
  private readonly _activeHandoffId = signal<string | null>(null);
  private timer: ReturnType<typeof setTimeout> | null = null;

  // The URL scheme works only on iOS devices that have Square POS
  // installed (iPad + Stand). Surface a hint when we're on a phone-class
  // viewport so staff knows to switch to the host iPad. Reactive to
  // window resize so rotating the iPad (or resizing a dev window during
  // testing) re-evaluates without remounting the component.
  private readonly _viewportNarrow = signal(SquareStandHandoff.detectNarrow());
  readonly showPhoneHint = computed(() => this._viewportNarrow());

  constructor() {
    if (typeof window === 'undefined') return;
    const handler = (): void =>
      this._viewportNarrow.set(SquareStandHandoff.detectNarrow());
    window.addEventListener('resize', handler);
    this.destroyRef.onDestroy(() => window.removeEventListener('resize', handler));
  }

  private static detectNarrow(): boolean {
    if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
    const touch = Number((navigator as { maxTouchPoints?: number }).maxTouchPoints ?? 0);
    const narrow = window.innerWidth < 768;
    return touch > 1 && narrow;
  }

  readonly status = computed<HandoffStatus>(() =>
    this.success() ? 'success' : this._baseStatus(),
  );
  readonly errorMessage = computed(() => this._errorMessage());
  readonly activeHandoffId = computed(() => this._activeHandoffId());
  readonly isWorking = computed(() => {
    const s = this.status();
    return s === 'starting' || s === 'handing-off' || s === 'awaiting-callback';
  });

  readonly statusLabel = computed(() => {
    switch (this.status()) {
      case 'idle':
        return 'Hand off to Square POS to take a card on the Stand reader.';
      case 'starting':
        return 'Preparing handoff…';
      case 'handing-off':
        return 'Opening Square POS…';
      case 'awaiting-callback':
        return 'Waiting for the customer to swipe…';
      case 'success':
        return 'Paid';
      case 'cancelled':
        return 'Handoff cancelled.';
      case 'error':
        return this._errorMessage() ?? 'Something went wrong.';
    }
  });

  readonly statusBadgeText = computed(() => {
    switch (this.status()) {
      case 'idle':
        return 'Off';
      case 'starting':
      case 'handing-off':
        return 'Loading';
      case 'awaiting-callback':
        return 'Waiting';
      case 'success':
        return 'Done';
      case 'cancelled':
        return 'Cancelled';
      case 'error':
        return 'Error';
    }
  });

  readonly statusBadgeVariant = computed<BadgeVariants['variant']>(() => {
    switch (this.status()) {
      case 'success':
        return 'success';
      case 'error':
      case 'cancelled':
        return 'danger';
      case 'idle':
        return 'secondary';
      default:
        return 'warning';
    }
  });

  ngOnDestroy(): void {
    this.clearTimer();
  }

  /**
   * Mint a handoff row server-side, then navigate Safari to the
   * `square-commerce-v1://` URL. Idempotent against double-clicks via
   * the isWorking guard.
   */
  start(): void {
    if (this.isWorking()) return;
    if (this.success()) return;
    if (!this.applicationId) {
      this.setError(
        'Square is not configured. Set the Square Application ID in /admin/settings.',
      );
      return;
    }
    if (!Number.isFinite(this.amount) || this.amount <= 0) {
      this.setError('Amount must be greater than 0.');
      return;
    }
    if (!this.reservationId || !this.eventDate) {
      this.setError('Missing reservation context.');
      return;
    }

    this._baseStatus.set('starting');
    this._errorMessage.set(null);

    this.reservationsApi
      .startSquareStandHandoff({
        reservationId: this.reservationId,
        eventDate: this.eventDate,
        amount: this.amount,
        note: this.note,
        returnPath: this.returnPath,
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this._activeHandoffId.set(res.handoffId);
          this.handoffStarted.emit(res);
          this.openSquarePos(res);
        },
        error: (err) => {
          const message = String(
            err?.error?.message ?? err?.message ?? 'Failed to start handoff',
          );
          this.setError(message);
          this.handoffFailed.emit(message);
        },
      });
  }

  /** Mark this pad as cancelled by an external action (e.g. parent
   *  fired cancel on the server side). Resets UI to idle so staff can
   *  re-try without remounting. */
  resetToIdle(): void {
    this.clearTimer();
    this._baseStatus.set('idle');
    this._errorMessage.set(null);
    this._activeHandoffId.set(null);
  }

  private openSquarePos(handoff: StartSquareStandHandoffResponse): void {
    if (typeof window === 'undefined') return;

    const callbackUrl =
      String(handoff.callbackUrl ?? '').trim() ||
      `${window.location.origin}/square-stand-callback`;

    const data = {
      client_id: this.applicationId,
      version: '1.3',
      amount_money: {
        amount: Math.round(this.amount * 100),
        currency_code: this.currencyCode,
      },
      callback_url: callbackUrl,
      // Round-tripped by Square POS in the callback URL as `state`. We
      // bind it to the handoff id so the callback page can prove the
      // round-trip wasn't spoofed.
      state: handoff.handoffId,
      // Receipt-facing note. Webhook also reads this — we use the same
      // "Booking #FF-XXXXXX • date" format as Square hosted-checkout
      // links so extractReservationFromNote matches.
      notes: this.buildNotes(),
      options: {
        // Locked to CREDIT_CARD: the customer paying for a deposit on
        // the Stand should never see "Cash" or "Other" tender options
        // (we record those separately in our app). Apple Pay / Google
        // Pay route through the card tender on iOS so they still work.
        supported_tender_types: ['CREDIT_CARD'],
        auto_return: true,
        clear_default_fees: true,
        skip_receipt: false,
      },
    };

    let serialized: string;
    try {
      serialized = encodeURIComponent(JSON.stringify(data));
    } catch (err) {
      this.setError('Failed to encode handoff payload.');
      return;
    }

    const url = `square-commerce-v1://payment/create?data=${serialized}`;
    this._baseStatus.set('handing-off');

    // Stash reservation context locally so the callback page can recover
    // it. Square POS replaces the entire URL with `?data=…` on return, so
    // any query-string-based round-trip is lost. localStorage is per-
    // origin and survives Safari being backgrounded while Square POS is
    // foregrounded (same iPad, same Safari tab).
    this.stashHandoffContext(handoff.handoffId);

    // Schedule the "Square POS didn't open" detection BEFORE we navigate
    // so it runs even if iOS swallows the navigation silently.
    this.scheduleMissingAppCheck();

    // iOS handoff. Use location.href; assignment (vs replace) keeps the
    // Safari back-stack intact so the callback page can also use
    // history.back as a fallback.
    window.location.href = url;
  }

  private stashHandoffContext(handoffId: string): void {
    if (typeof window === 'undefined' || typeof localStorage === 'undefined') return;
    try {
      const payload = {
        reservationId: this.reservationId,
        eventDate: this.eventDate,
        returnPath: this.returnPath,
        expiresAt: Date.now() + 30 * 60 * 1000,
      };
      localStorage.setItem(`ff:stand-handoff:${handoffId}`, JSON.stringify(payload));
    } catch {
      // localStorage can be full, blocked by Safari private mode, etc.
      // The BE handoff row is still the source of truth — the FE can fall
      // back to a "look up handoff" call if we ever wire one.
    }
  }

  private scheduleMissingAppCheck(): void {
    this.clearTimer();
    if (typeof document === 'undefined') return;
    this.timer = setTimeout(() => {
      this.timer = null;
      // visibilityState !== 'visible' means iOS backgrounded Safari —
      // i.e. Square POS opened. Anything else means the URL scheme
      // didn't resolve. We treat hidden+prerender as success too.
      const vis = String(document.visibilityState ?? 'visible');
      if (vis === 'visible' && this._baseStatus() === 'handing-off') {
        this.setError(
          'Square POS app did not open. Confirm it is installed and signed in on this iPad.',
        );
        this.squarePosMissing.emit();
        return;
      }
      // Square POS opened — flip to awaiting-callback. The page may
      // never re-render this state (Safari was backgrounded), but if
      // the customer cancels and the user lands back on this page,
      // they'll see the "Waiting" copy.
      if (this._baseStatus() === 'handing-off') {
        this._baseStatus.set('awaiting-callback');
      }
    }, 2500);
  }

  private clearTimer(): void {
    if (this.timer != null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private setError(message: string): void {
    this._errorMessage.set(message);
    this._baseStatus.set('error');
    this.clearTimer();
  }

  private buildNotes(): string {
    const code = String(this.confirmationCode ?? '').trim();
    const date = String(this.eventDate ?? '').trim();
    const codeText = code ? `#FF-${code}` : `#${this.reservationId.slice(0, 8)}`;
    const datePart = date ? ` • ${date}` : '';
    const labelPart = this.label && this.label !== 'Reservation payment'
      ? ` • ${this.label}`
      : '';
    return `Booking ${codeText}${datePart}${labelPart}`;
  }
}
