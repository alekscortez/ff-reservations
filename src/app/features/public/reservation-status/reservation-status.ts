import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnDestroy,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { HttpErrorResponse } from '@angular/common/http';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Meta, Title } from '@angular/platform-browser';
import { Subscription, interval } from 'rxjs';
import { HlmAlert } from '../../../shared/ui/alert';
import { HlmButton } from '../../../shared/ui/button';
import {
  PublicBookingsService,
  PublicCustomerContact,
  PublicReservationView,
} from '../../../core/http/public-bookings.service';
import {
  clearPendingHold,
  readPendingHold,
  writePendingHold,
} from '../availability/pending-hold.store';

const POLL_INTERVAL_MS = 3000;

type StatusKind =
  | 'loading'
  | 'pending'
  | 'paid'
  | 'cancelled'
  | 'error';

@Component({
  selector: 'app-reservation-status',
  standalone: true,
  imports: [CommonModule, RouterLink, HlmAlert, HlmButton],
  templateUrl: './reservation-status.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReservationStatus implements OnInit, OnDestroy {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private bookings = inject(PublicBookingsService);
  private destroyRef = inject(DestroyRef);
  private title = inject(Title);
  private meta = inject(Meta);

  readonly reservation = signal<PublicReservationView | null>(null);
  readonly status = signal<StatusKind>('loading');
  readonly errorMessage = signal<string | null>(null);
  readonly walletDownloading = signal(false);
  readonly walletError = signal<string | null>(null);
  readonly customerContact = signal<PublicCustomerContact | null>(null);
  // Seconds remaining on the payment hold. Driven by a 1Hz interval that
  // reads reservation().paymentDeadlineAt and computes the diff. Null
  // when the deadline isn't set or hasn't been parsed yet.
  readonly secondsRemaining = signal<number | null>(null);

  // Arrival instructions shown on the PAID card. Hardcoded for v1 — same
  // three lines as the Apple Wallet pass back-fields (services-wallet-pass.mjs)
  // so the customer sees identical wording on both surfaces. Promote to a
  // setting if/when this needs to vary by event or tier.
  readonly arrivalInstructions: readonly string[] = [
    'Head straight to your table — no check-in line',
    'Reserved all night — come whenever you like',
    'Show this pass to any staff member if you need help',
  ];

  // Apple's official "Add to Apple Wallet" badge — locale-aware. Uses the
  // Spanish (Mexico) variant for `es-*` browsers, English elsewhere. Apple
  // ships 46+ locales but EN + ES-MX cover FF's McAllen audience.
  readonly walletBadgeSrc = computed(() => {
    const lang = (typeof navigator !== 'undefined' ? navigator.language : '')
      .toLowerCase();
    return lang.startsWith('es')
      ? '/assets/wallet/add-to-apple-wallet-es-mx.svg'
      : '/assets/wallet/add-to-apple-wallet-en.svg';
  });

  readonly walletBadgeLabel = computed(() =>
    this.walletBadgeSrc().includes('es-mx')
      ? 'Agregar a Apple Wallet'
      : 'Add to Apple Wallet'
  );

  // Android customers can't use Apple Wallet — hide the badge and
  // promote the "View check-in pass" link as the primary CTA instead.
  // (Google Wallet integration is on the backlog post-Saturday.) UA
  // sniffing is fine here: the only thing it gates is which CTA looks
  // primary; pressing the View pass button works on every browser.
  readonly isAndroid = computed(() => {
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
    return /Android/i.test(ua);
  });

  private reservationId = '';
  private customerToken = '';
  private eventDate = '';
  private pollSub: Subscription | null = null;
  private countdownSub: Subscription | null = null;

  ngOnInit(): void {
    this.title.setTitle('Famoso Fuego — Your Reservation');
    this.meta.updateTag({
      name: 'description',
      content: 'Track your reservation status and download your check-in pass.',
    });

    const params = this.route.snapshot.paramMap;
    const query = this.route.snapshot.queryParamMap;
    this.reservationId = String(params.get('id') ?? '').trim();
    this.customerToken = String(query.get('t') ?? '').trim();
    // eventDate is part of the DDB key; pulled from query first, falling
    // back to localStorage (set when the booking was created so we can
    // recover after the Square hosted-checkout redirect).
    this.eventDate = String(query.get('eventDate') ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(this.eventDate)) {
      const stored = readPendingHold();
      if (stored && stored.reservationId === this.reservationId) {
        this.eventDate = stored.eventDate;
        // Backfill the customer token if missing from query — covers
        // direct visits to /r/{id} without the ?t= param.
        if (!this.customerToken) {
          this.customerToken = stored.customerToken;
        }
      }
    }

    if (!this.reservationId || !this.customerToken || !this.eventDate) {
      this.status.set('error');
      this.errorMessage.set(
        'Reservation link is incomplete. Please use the link from your Square email.'
      );
      return;
    }

    this.fetchStatus();
    this.startPolling();
    this.startCountdown();
  }

  ngOnDestroy(): void {
    this.pollSub?.unsubscribe();
    this.pollSub = null;
    this.countdownSub?.unsubscribe();
    this.countdownSub = null;
  }

  readonly isPaid = computed(() => this.status() === 'paid');
  readonly isPending = computed(() => this.status() === 'pending');

  // Mm:ss countdown label rendered on the PENDING card. Returns null
  // while the deadline isn't loaded yet, "Hold expired" once it lapses
  // (we keep showing it briefly until the next poll flips status to
  // cancelled), and "M:SS" otherwise.
  readonly countdownLabel = computed(() => {
    if (!this.isPending()) return null;
    const s = this.secondsRemaining();
    if (s === null) return null;
    if (s <= 0) return 'Hold expired';
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${String(sec).padStart(2, '0')}`;
  });

  // Differentiate the two CANCELLED shapes on /r so customers get useful
  // copy instead of a generic "this was cancelled" wall:
  //   - 'auto-released' → hold expired before payment landed
  //     (paymentStatus stays PENDING; just need to start over)
  //   - 'paid-but-cancelled' → Day-shape: customer paid but webhook
  //     missed and the reservation got auto-cancelled. They need to
  //     contact us; the money is recoverable.
  readonly cancellationKind = computed(() => {
    if (this.status() !== 'cancelled') return null;
    const ps = String(this.reservation()?.paymentStatus ?? '').toUpperCase();
    if (ps === 'PAID' || ps === 'PARTIAL' || ps === 'COURTESY') {
      return 'paid-but-cancelled' as const;
    }
    return 'auto-released' as const;
  });

  // Contact CTAs for the paid-but-cancelled card (Day-shape recovery).
  // Mirrors the pattern in availability.ts so behavior matches /map.
  readonly contactPhoneHref = computed<string | null>(() => {
    const phone = String(this.customerContact()?.phone ?? '').trim();
    return phone ? `tel:${phone}` : null;
  });

  readonly contactWhatsappHref = computed<string | null>(() => {
    const phone = String(this.customerContact()?.phone ?? '').trim();
    if (!phone) return null;
    const digits = phone.replace(/[^\d]/g, '');
    return digits ? `https://wa.me/${digits}` : null;
  });

  continueToPayment(): void {
    const url = this.reservation()?.paymentLinkUrl;
    if (url && typeof window !== 'undefined') {
      window.location.href = url;
    }
  }

  refresh(): void {
    this.fetchStatus();
  }

  downloadWalletPass(): void {
    if (this.walletDownloading()) return;
    this.walletDownloading.set(true);
    this.walletError.set(null);
    this.bookings
      .generateWalletPass(this.reservationId, this.customerToken, this.eventDate)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.triggerPkpassDownload(res.pkpassBase64, res.filename, res.contentType);
          this.walletDownloading.set(false);
        },
        error: (err: unknown) => {
          this.walletDownloading.set(false);
          if (err instanceof HttpErrorResponse) {
            this.walletError.set(
              String(
                (err.error as { message?: string } | null)?.message ??
                  'Could not generate Wallet pass right now.'
              )
            );
          } else {
            this.walletError.set('Could not generate Wallet pass right now.');
          }
        },
      });
  }

  private triggerPkpassDownload(
    base64: string,
    filename: string,
    contentType: string
  ): void {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    try {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
      }
      const blob = new Blob([bytes], { type: contentType || 'application/vnd.apple.pkpass' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename || 'reservation.pkpass';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      this.walletError.set('Could not save Wallet pass to your device.');
    }
  }

  private fetchStatus(): void {
    this.bookings
      .getReservation(this.reservationId, this.customerToken, this.eventDate)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.reservation.set(res.reservation);
          this.customerContact.set(res.customerContact ?? null);
          this.errorMessage.set(null);
          this.applyStatusFromReservation(res.reservation);
        },
        error: (err: unknown) => {
          if (err instanceof HttpErrorResponse) {
            const body = err.error as
              | {
                  code?: string;
                  reservation?: PublicReservationView;
                  customerContact?: PublicCustomerContact | null;
                }
              | null;
            const code = String(body?.code ?? '');
            if (code === 'RESERVATION_CANCELLED') {
              // Backend returns the sanitized reservation + contact in
              // the 410 body so we can differentiate auto-release (hold
              // expired, no payment) from a Day-shape paid-but-cancelled
              // state. The template branches off paymentStatus, and
              // customerContact powers the WhatsApp/Call CTAs in the
              // paid-but-cancelled card.
              if (body?.reservation) {
                this.reservation.set(body.reservation);
              }
              if (body?.customerContact !== undefined) {
                this.customerContact.set(body.customerContact ?? null);
              }
              this.status.set('cancelled');
              clearPendingHold();
              this.pollSub?.unsubscribe();
              this.pollSub = null;
              return;
            }
            if (code === 'RESERVATION_NOT_FOUND') {
              this.status.set('error');
              this.errorMessage.set('Reservation not found.');
              this.pollSub?.unsubscribe();
              this.pollSub = null;
              return;
            }
            if (code === 'INVALID_TOKEN') {
              this.status.set('error');
              this.errorMessage.set(
                'Your reservation link is invalid or has expired.'
              );
              this.pollSub?.unsubscribe();
              this.pollSub = null;
              return;
            }
          }
          this.status.set('error');
          this.errorMessage.set('Could not load reservation status. Retrying…');
        },
      });
  }

  private applyStatusFromReservation(reservation: PublicReservationView): void {
    const paymentStatus = String(reservation.paymentStatus ?? '').toUpperCase();
    const status = String(reservation.status ?? '').toUpperCase();

    if (status === 'CANCELLED') {
      this.status.set('cancelled');
      clearPendingHold();
      this.pollSub?.unsubscribe();
      this.pollSub = null;
      return;
    }
    if (paymentStatus === 'PAID' || paymentStatus === 'COURTESY') {
      this.status.set('paid');
      clearPendingHold();
      this.pollSub?.unsubscribe();
      this.pollSub = null;
      return;
    }

    // Keep the pending hold in localStorage in sync — if the customer
    // refreshes to /r/{id}, the banner on /map should still recognize
    // the in-flight reservation.
    if (reservation.paymentLinkUrl) {
      const stored = readPendingHold();
      writePendingHold({
        reservationId: reservation.reservationId,
        customerToken: this.customerToken,
        eventDate: reservation.eventDate,
        paymentUrl: reservation.paymentLinkUrl,
        // Best-effort: preserve the original expiry if we have one,
        // otherwise default to now + 600s (anonymous TTL).
        holdExpiresAtEpoch:
          stored?.holdExpiresAtEpoch ?? Math.floor(Date.now() / 1000) + 600,
      });
    }
    this.status.set('pending');
  }

  private startPolling(): void {
    this.pollSub?.unsubscribe();
    this.pollSub = interval(POLL_INTERVAL_MS).subscribe(() => {
      if (
        typeof document !== 'undefined' &&
        document.visibilityState === 'hidden'
      ) {
        return;
      }
      // Don't keep polling after a terminal state.
      const status = this.status();
      if (status === 'paid' || status === 'cancelled') {
        return;
      }
      this.fetchStatus();
    });
  }

  // 1Hz countdown ticker: reads the reservation's paymentDeadlineAt and
  // updates secondsRemaining. Naive parse — assumes the customer's
  // browser TZ matches the venue (America/Chicago for McAllen). Worst
  // case is a few-hour offset for cross-TZ customers, which is fine
  // since the UX is just visual urgency; the server-side hold expiry
  // is the authoritative gate.
  private startCountdown(): void {
    this.countdownSub?.unsubscribe();
    this.countdownSub = interval(1000).subscribe(() => this.tickCountdown());
    this.tickCountdown();
  }

  private tickCountdown(): void {
    const deadlineStr = this.reservation()?.paymentDeadlineAt;
    if (!deadlineStr) {
      this.secondsRemaining.set(null);
      return;
    }
    const deadlineMs = new Date(deadlineStr).getTime();
    if (isNaN(deadlineMs)) {
      this.secondsRemaining.set(null);
      return;
    }
    const remaining = Math.max(0, Math.floor((deadlineMs - Date.now()) / 1000));
    this.secondsRemaining.set(remaining);
  }
}
