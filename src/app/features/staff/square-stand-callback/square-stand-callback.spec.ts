import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router } from '@angular/router';
import { Observable, of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SquareStandCallback } from './square-stand-callback';
import {
  CompleteSquareStandHandoffPayload,
  CompleteSquareStandHandoffResponse,
  ReservationsService,
} from '../../../core/http/reservations.service';

function fakeReservationsApi() {
  let nextResponse: Observable<CompleteSquareStandHandoffResponse> = of({
    item: {
      reservationId: 'r-stash',
      eventDate: '2026-05-20',
      payments: [{ amount: 75 }],
    } as unknown as CompleteSquareStandHandoffResponse['item'],
    square: { paymentId: 'pay_1', status: 'COMPLETED' } as never,
    handoff: { handoffId: 'h_test', consumedAt: 0 },
  });
  const calls: CompleteSquareStandHandoffPayload[] = [];
  return {
    calls,
    setNextResponse(res: Observable<CompleteSquareStandHandoffResponse>): void {
      nextResponse = res;
    },
    service: {
      completeSquareStandHandoff(payload: CompleteSquareStandHandoffPayload) {
        calls.push(payload);
        return nextResponse;
      },
    } as Pick<ReservationsService, 'completeSquareStandHandoff'>,
  };
}

function configureRouteWithData(dataParam: string) {
  return {
    snapshot: {
      queryParamMap: {
        get(key: string): string | null {
          if (key === 'data') return dataParam;
          return null;
        },
      },
    },
  } as unknown as ActivatedRoute;
}

function setLocalStorageHandoff(
  handoffId: string,
  payload: Record<string, unknown>,
): void {
  localStorage.setItem(`ff:stand-handoff:${handoffId}`, JSON.stringify(payload));
}

function createCallback(
  api: ReturnType<typeof fakeReservationsApi>,
  routeData: string,
): {
  router: { navigateByUrl: ReturnType<typeof vi.fn> };
  fixture: ReturnType<typeof TestBed.createComponent<SquareStandCallback>>;
  page: SquareStandCallback;
} {
  const router = { navigateByUrl: vi.fn().mockResolvedValue(true) };
  TestBed.configureTestingModule({
    imports: [SquareStandCallback],
    providers: [
      { provide: ReservationsService, useValue: api.service },
      { provide: ActivatedRoute, useValue: configureRouteWithData(routeData) },
      { provide: Router, useValue: router },
    ],
  });
  const fixture = TestBed.createComponent(SquareStandCallback);
  fixture.detectChanges();
  return {
    router: router as never,
    fixture,
    page: fixture.componentInstance,
  };
}

describe('SquareStandCallback', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    try {
      localStorage.clear();
    } catch {
      // ignore
    }
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the missing phase when there is no ?data= param', () => {
    const api = fakeReservationsApi();
    const { page } = createCallback(api, '');
    expect(page.phase()).toBe('missing');
    expect(api.calls.length).toBe(0);
  });

  it('shows error phase when ?data= is unparseable JSON', () => {
    const api = fakeReservationsApi();
    const { page } = createCallback(api, '%7B%not-json');
    expect(page.phase()).toBe('error');
    expect(page.errorMessage()).toMatch(/could not understand/i);
  });

  it('shows cancelled phase for status=error with payment_canceled', () => {
    const api = fakeReservationsApi();
    const data = encodeURIComponent(
      JSON.stringify({ status: 'error', error_code: 'payment_canceled' }),
    );
    const { page } = createCallback(api, data);
    expect(page.phase()).toBe('cancelled');
    expect(page.errorMessage()).toMatch(/cancelled/i);
  });

  it('shows declined phase for status=error with other codes', () => {
    const api = fakeReservationsApi();
    const data = encodeURIComponent(
      JSON.stringify({ status: 'error', error_code: 'transaction_failed' }),
    );
    const { page } = createCallback(api, data);
    expect(page.phase()).toBe('declined');
  });

  it('happy path: reads localStorage by handoffId, POSTs /complete, flips to done', () => {
    setLocalStorageHandoff('h_test', {
      reservationId: 'r-stash',
      eventDate: '2026-05-20',
      returnPath: '/staff/reservations',
      expiresAt: Date.now() + 60 * 1000,
    });
    const api = fakeReservationsApi();
    const data = encodeURIComponent(
      JSON.stringify({ status: 'ok', transaction_id: 'tx_1', state: 'h_test' }),
    );
    const { page } = createCallback(api, data);
    expect(api.calls.length).toBe(1);
    expect(api.calls[0].reservationId).toBe('r-stash');
    expect(api.calls[0].handoffId).toBe('h_test');
    expect(api.calls[0].transactionId).toBe('tx_1');
    expect(page.phase()).toBe('done');
    expect(page.paidAmount()).toBe(75);
    expect(localStorage.getItem('ff:stand-handoff:h_test')).toBeNull();
  });

  it('navigates to the stashed returnPath after success', () => {
    setLocalStorageHandoff('h_test', {
      reservationId: 'r-stash',
      eventDate: '2026-05-20',
      returnPath: '/staff/reservations/new',
      expiresAt: Date.now() + 60 * 1000,
    });
    const api = fakeReservationsApi();
    const data = encodeURIComponent(
      JSON.stringify({ status: 'ok', transaction_id: 'tx_1', state: 'h_test' }),
    );
    const { router } = createCallback(api, data);
    vi.advanceTimersByTime(1600);
    expect(router.navigateByUrl).toHaveBeenCalledWith('/staff/reservations/new');
  });

  it('falls back to /staff/reservations when stashed returnPath is absent', () => {
    setLocalStorageHandoff('h_test', {
      reservationId: 'r-stash',
      eventDate: '2026-05-20',
      expiresAt: Date.now() + 60 * 1000,
    });
    const api = fakeReservationsApi();
    const data = encodeURIComponent(
      JSON.stringify({ status: 'ok', transaction_id: 'tx_1', state: 'h_test' }),
    );
    const { router } = createCallback(api, data);
    vi.advanceTimersByTime(1600);
    expect(router.navigateByUrl).toHaveBeenCalledWith('/staff/reservations');
  });

  it('rejects an external returnPath via the // open-redirect trick', () => {
    setLocalStorageHandoff('h_test', {
      reservationId: 'r-stash',
      eventDate: '2026-05-20',
      returnPath: 'https://evil.com',
      expiresAt: Date.now() + 60 * 1000,
    });
    const api = fakeReservationsApi();
    const data = encodeURIComponent(
      JSON.stringify({ status: 'ok', transaction_id: 'tx_1', state: 'h_test' }),
    );
    const { router } = createCallback(api, data);
    vi.advanceTimersByTime(1600);
    expect(router.navigateByUrl).toHaveBeenCalledWith('/staff/reservations');
  });

  it('shows a helpful error when localStorage is empty (no reservation context)', () => {
    const api = fakeReservationsApi();
    const data = encodeURIComponent(
      JSON.stringify({ status: 'ok', transaction_id: 'tx_1', state: 'h_test' }),
    );
    const { page } = createCallback(api, data);
    expect(api.calls.length).toBe(0);
    expect(page.phase()).toBe('error');
    expect(page.errorMessage()).toMatch(/could not match/i);
  });

  it('ignores expired localStorage entries', () => {
    setLocalStorageHandoff('h_test', {
      reservationId: 'r-stash',
      eventDate: '2026-05-20',
      expiresAt: Date.now() - 1000,
    });
    const api = fakeReservationsApi();
    const data = encodeURIComponent(
      JSON.stringify({ status: 'ok', transaction_id: 'tx_1', state: 'h_test' }),
    );
    const { page } = createCallback(api, data);
    // Expired entry is wiped, page bails to the same "could not match"
    // error rather than trusting the stale data.
    expect(api.calls.length).toBe(0);
    expect(page.phase()).toBe('error');
    expect(localStorage.getItem('ff:stand-handoff:h_test')).toBeNull();
  });

  it('surfaces BE /complete failures', () => {
    setLocalStorageHandoff('h_test', {
      reservationId: 'r-stash',
      eventDate: '2026-05-20',
      expiresAt: Date.now() + 60 * 1000,
    });
    const api = fakeReservationsApi();
    api.setNextResponse(
      throwError(() => ({ error: { message: 'Handoff expired' } })),
    );
    const data = encodeURIComponent(
      JSON.stringify({ status: 'ok', transaction_id: 'tx_1', state: 'h_test' }),
    );
    const { page } = createCallback(api, data);
    expect(page.phase()).toBe('error');
    expect(page.errorMessage()).toMatch(/Handoff expired/);
  });

  it('clears localStorage on Square POS error so a retry does not reuse stale context', () => {
    setLocalStorageHandoff('h_test', {
      reservationId: 'r-stash',
      eventDate: '2026-05-20',
      expiresAt: Date.now() + 60 * 1000,
    });
    const api = fakeReservationsApi();
    const data = encodeURIComponent(
      JSON.stringify({
        status: 'error',
        error_code: 'payment_canceled',
        state: 'h_test',
      }),
    );
    const { page } = createCallback(api, data);
    expect(page.phase()).toBe('cancelled');
    expect(localStorage.getItem('ff:stand-handoff:h_test')).toBeNull();
  });
});
