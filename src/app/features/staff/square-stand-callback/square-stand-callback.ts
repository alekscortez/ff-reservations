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

    // Cross-reference the handoff row (server-side) to recover the
    // reservation id + returnPath. The FE component attaches both as
    // top-level query params so we don't depend on Square POS to
    // round-trip them (state is reserved for the handoff id alone).
    this.reservationId = this.route.snapshot.queryParamMap.get('r');
    this.returnPath = this.route.snapshot.queryParamMap.get('returnPath');

    const cb = this.parsedCallback;
    if (cb.status === 'error') {
      const code = cb.errorCode ?? '';
      this.errorMessage.set(
        ERROR_LABELS[code] ||
          'Square POS reported an error (' + (code || 'unknown') + ').',
      );
      this.phase.set(code === 'payment_canceled' ? 'cancelled' : 'declined');
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
    if (!this.reservationId) this.reservationId = '';

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
          // Brief celebration, then navigate back. Mirrors the Cash App
          // path's ~1.5s timing.
          setTimeout(() => this.goBack(), 1500);
        },
        error: (err) => {
          this.errorMessage.set(
            String(err?.error?.message ?? err?.message ?? 'Failed to record payment'),
          );
          this.phase.set('error');
        },
      });
  }
}
