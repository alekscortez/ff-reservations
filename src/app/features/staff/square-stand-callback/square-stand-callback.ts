import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';

import { ReservationsService } from '../../../core/http/reservations.service';
import { writeJustPaidBeacon } from '../../../shared/components/take-payment-modal/just-paid-beacon';
import { HlmAlert } from '../../../shared/ui/alert';
import { HlmButton } from '../../../shared/ui/button';

interface ParsedCallback {
  status: string;
  transactionId: string | null;
  clientTransactionId: string | null;
  state: string | null;
  errorCode: string | null;
}

type CallbackPhase =
  | 'parsing'
  | 'recording'
  | 'done'
  | 'cancelled'
  | 'declined'
  | 'error'
  | 'missing';

const ERROR_LABELS: Record<string, string> = {
  payment_canceled: 'Customer cancelled in Square POS.',
  transaction_failed: 'The transaction failed in Square POS.',
  not_authorized: 'Square POS is not authorized for this app yet.',
  invalid_request: 'Square POS rejected the request payload.',
  unsupported_tender_type:
    'That tender type is not supported for Stand handoff. Try card.',
  user_not_logged_in:
    'Square POS is not signed in. Open Square POS and sign in, then try again.',
  invalid_authentication_token:
    'Square POS authentication is no longer valid. Re-open the reservation and try again.',
  invalid_callback_url:
    'The callback URL is not registered in the Square Developer Console.',
};

@Component({
  selector: 'square-stand-callback',
  standalone: true,
  imports: [CommonModule, HlmAlert, HlmButton],
  templateUrl: './square-stand-callback.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SquareStandCallback implements OnInit {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private reservationsApi = inject(ReservationsService);
  private destroyRef = inject(DestroyRef);

  readonly phase = signal<CallbackPhase>('parsing');
  readonly errorMessage = signal<string>('');
  readonly paidAmount = signal<number | null>(null);
  private parsedCallback: ParsedCallback | null = null;
  private reservationId: string | null = null;
  private returnPath: string | null = null;
  readonly recording = computed(() => this.phase() === 'recording');

  ngOnInit(): void {
    const dataParam = this.route.snapshot.queryParamMap.get('data') ?? '';
    if (!dataParam) {
      this.phase.set('missing');
      return;
    }

    try {
      const parsed = JSON.parse(decodeURIComponent(dataParam));
      this.parsedCallback = {
        status: String(parsed?.status ?? '').toLowerCase(),
        transactionId: String(parsed?.transaction_id ?? '').trim() || null,
        clientTransactionId:
          String(parsed?.client_transaction_id ?? '').trim() || null,
        state: String(parsed?.state ?? '').trim() || null,
        errorCode: String(parsed?.error_code ?? '').trim().toLowerCase() || null,
      };
    } catch {
      this.phase.set('error');
      this.errorMessage.set(
        'Square POS returned data we could not understand. Open the reservation to check.',
      );
      return;
    }

    // Square POS replaces the URL with `?data=…` on return, dropping any
    // query strings we tried to round-trip. The <square-stand-handoff>
    // component stashes {reservationId, returnPath, eventDate} in
    // localStorage keyed by handoffId BEFORE the deeplink navigation;
    // we recover them here.
    const cb = this.parsedCallback;
    this.restoreHandoffContext(cb.state);
    if (cb.status === 'error') {
      const code = cb.errorCode ?? '';
      this.errorMessage.set(
        ERROR_LABELS[code] ||
          'Square POS reported an error (' + (code || 'unknown') + ').',
      );
      this.phase.set(code === 'payment_canceled' ? 'cancelled' : 'declined');
      this.clearHandoffContext(cb.state);
      return;
    }

    if (cb.status !== 'ok' || !cb.transactionId || !cb.state) {
      this.phase.set('error');
      this.errorMessage.set(
        'Square POS returned an unexpected payload. Open the reservation to check.',
      );
      return;
    }

    this.complete();
  }

  retry(): void {
    if (!this.parsedCallback) return;
    if (this.parsedCallback.status !== 'ok') return;
    this.complete();
  }

  goBack(): void {
    const path =
      this.returnPath && this.returnPath.startsWith('/')
        ? this.returnPath
        : '/staff/reservations';
    void this.router.navigateByUrl(path);
  }

  private complete(): void {
    const cb = this.parsedCallback;
    if (!cb || !cb.transactionId || !cb.state) {
      this.phase.set('error');
      return;
    }
    if (!this.reservationId) {
      this.errorMessage.set(
        'We could not match this Stand payment to a reservation. The reservation was likely paid (the Square webhook will catch it within ~1 minute) — open the reservation to confirm.',
      );
      this.phase.set('error');
      return;
    }

    this.phase.set('recording');
    this.errorMessage.set('');
    this.reservationsApi
      .completeSquareStandHandoff({
        reservationId: this.reservationId,
        handoffId: cb.state,
        transactionId: cb.transactionId,
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          const payments = Array.isArray((res.item as { payments?: unknown[] })?.payments)
            ? ((res.item as { payments: { amount?: number }[] }).payments ?? [])
            : [];
          const latest = payments[payments.length - 1];
          const amount = Number(latest?.amount ?? 0);
          if (Number.isFinite(amount) && amount > 0) this.paidAmount.set(amount);
          this.phase.set('done');
          this.clearHandoffContext(cb.state);
          // Write the just-paid beacon so the destination page (wizard or
          // /staff/reservations) can suppress the spurious "pending stand
          // payment" banner and show a toast instead. See
          // just-paid-beacon.ts for the rationale + TTL.
          if (this.reservationId && amount > 0) {
            writeJustPaidBeacon({ reservationId: this.reservationId, amount });
          }
          // Brief celebration, then navigate back. Mirrors the Cash App
          // path's ~1.5s timing.
          setTimeout(() => this.goBack(), 1500);
        },
        error: (err) => {
          const status = Number(
            (err as { status?: number; statusCode?: number })?.status ??
              (err as { status?: number; statusCode?: number })?.statusCode ??
              0,
          );
          if (status === 401) {
            this.errorMessage.set(
              "Your session expired during Square POS. The payment will still be recorded automatically within ~1 minute — open the reservation to confirm.",
            );
          } else {
            this.errorMessage.set(
              String(
                err?.error?.message ?? err?.message ?? 'Failed to record payment',
              ),
            );
          }
          this.phase.set('error');
        },
      });
  }

  private restoreHandoffContext(handoffId: string | null | undefined): void {
    if (typeof localStorage === 'undefined') return;
    const id = String(handoffId ?? '').trim();
    if (!id) return;
    try {
      const raw = localStorage.getItem(`ff:stand-handoff:${id}`);
      if (!raw) return;
      const parsed = JSON.parse(raw) as {
        reservationId?: string;
        returnPath?: string;
        expiresAt?: number;
      };
      const expiresAt = Number(parsed?.expiresAt ?? 0);
      if (Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt < Date.now()) {
        localStorage.removeItem(`ff:stand-handoff:${id}`);
        return;
      }
      const reservationId = String(parsed?.reservationId ?? '').trim();
      const returnPath = String(parsed?.returnPath ?? '').trim();
      if (reservationId) this.reservationId = reservationId;
      if (returnPath) this.returnPath = returnPath;
    } catch {
      // Corrupt entry; ignore — the rest of the page will fall through to
      // the "open the reservation" error state.
    }
  }

  private clearHandoffContext(handoffId: string | null | undefined): void {
    if (typeof localStorage === 'undefined') return;
    const id = String(handoffId ?? '').trim();
    if (!id) return;
    try {
      localStorage.removeItem(`ff:stand-handoff:${id}`);
    } catch {
      // Storage quota / private mode — best-effort cleanup, safe to ignore.
    }
  }
}
