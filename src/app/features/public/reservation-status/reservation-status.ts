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
  | 'expired'
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

  private reservationId = '';
  private customerToken = '';
  private eventDate = '';
  private pollSub: Subscription | null = null;

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
  }

  ngOnDestroy(): void {
    this.pollSub?.unsubscribe();
    this.pollSub = null;
  }

  readonly isPaid = computed(() => this.status() === 'paid');
  readonly isPending = computed(() => this.status() === 'pending');

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
          this.errorMessage.set(null);
          this.applyStatusFromReservation(res.reservation);
        },
        error: (err: unknown) => {
          if (err instanceof HttpErrorResponse) {
            const code = String(
              (err.error as { code?: string } | null)?.code ?? ''
            );
            if (code === 'RESERVATION_CANCELLED') {
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
      if (status === 'paid' || status === 'cancelled' || status === 'expired') {
        return;
      }
      this.fetchStatus();
    });
  }
}
