import { TestBed } from '@angular/core/testing';
import { Observable, of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SquareStandHandoff } from './square-stand-handoff';
import {
  ReservationsService,
  StartSquareStandHandoffPayload,
  StartSquareStandHandoffResponse,
} from '../../../core/http/reservations.service';

function fakeReservationsApi() {
  let nextResponse: Observable<StartSquareStandHandoffResponse> = of({
    handoffId: 'h_test',
    callbackUrl: 'https://app.test/staff/square-stand-callback',
    expiresAt: 0,
    amount: 50,
  });
  const calls: StartSquareStandHandoffPayload[] = [];
  return {
    calls,
    setNextResponse(res: Observable<StartSquareStandHandoffResponse>): void {
      nextResponse = res;
    },
    service: {
      startSquareStandHandoff(payload: StartSquareStandHandoffPayload) {
        calls.push(payload);
        return nextResponse;
      },
    } as Pick<ReservationsService, 'startSquareStandHandoff'>,
  };
}

function createComponent(
  api: ReturnType<typeof fakeReservationsApi>,
  overrides: {
    applicationId?: string;
    amount?: number;
    reservationId?: string;
    eventDate?: string;
    success?: boolean;
  } = {},
) {
  TestBed.configureTestingModule({
    imports: [SquareStandHandoff],
    providers: [{ provide: ReservationsService, useValue: api.service }],
  });
  const fixture = TestBed.createComponent(SquareStandHandoff);
  const pad = fixture.componentInstance;
  pad.reservationId = overrides.reservationId ?? 'r-1';
  pad.eventDate = overrides.eventDate ?? '2026-05-20';
  pad.amount = overrides.amount ?? 50;
  pad.applicationId = overrides.applicationId ?? 'app_1';
  pad.confirmationCode = 'K7M3X2';
  pad.label = 'Table 3 payment';
  pad.returnPath = '/staff/reservations';
  fixture.componentRef.setInput('success', overrides.success ?? false);
  const startedCalls: StartSquareStandHandoffResponse[] = [];
  const failedCalls: string[] = [];
  const missingCalls: number[] = [];
  pad.handoffStarted.subscribe((r) => startedCalls.push(r));
  pad.handoffFailed.subscribe((m) => failedCalls.push(m));
  pad.squarePosMissing.subscribe(() => missingCalls.push(1));
  fixture.detectChanges();
  return { fixture, pad, startedCalls, failedCalls, missingCalls };
}

describe('SquareStandHandoff', () => {
  // Captured at file load so we can restore the real Location reference
  // verbatim in afterEach. Replacing window.location with a plain object
  // breaks later tests that rely on window.history.replaceState — under
  // Angular's vitest config (`isolate: false, fileParallelism: false`)
  // all spec files share one worker, so cross-file state must be cleaned
  // up properly. Failing to restore here cascades into attribution.spec.ts
  // (which uses history.replaceState to set URL fixtures).
  const ORIGINAL_LOCATION_DESCRIPTOR = Object.getOwnPropertyDescriptor(
    window,
    'location',
  );
  let lastAssignedHref: string | null;

  beforeEach(() => {
    vi.useFakeTimers();
    lastAssignedHref = null;
    // jsdom's location.href is settable but doesn't actually navigate.
    // Wrap it so we can spy without affecting the test page.
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: new Proxy(window.location, {
        set(target, prop, value) {
          if (prop === 'href') {
            lastAssignedHref = String(value);
            return true;
          }
          (target as unknown as Record<PropertyKey, unknown>)[prop] = value;
          return true;
        },
        get(target, prop) {
          if (prop === 'origin') return 'https://app.test';
          return Reflect.get(target, prop);
        },
      }),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    if (ORIGINAL_LOCATION_DESCRIPTOR) {
      Object.defineProperty(window, 'location', ORIGINAL_LOCATION_DESCRIPTOR);
    } else {
      // Fall back to a delete-then-restore via the prototype chain if
      // the descriptor wasn't captured (shouldn't happen in jsdom).
      delete (window as unknown as { location?: unknown }).location;
    }
  });

  it('starts in idle status with the default copy', () => {
    const api = fakeReservationsApi();
    const { fixture, pad } = createComponent(api);
    expect(pad.status()).toBe('idle');
    expect(fixture.nativeElement.textContent).toContain(
      'Hand off to Square POS',
    );
  });

  it('flips to success state when [success] input is true', () => {
    const api = fakeReservationsApi();
    const { fixture, pad } = createComponent(api, { success: true });
    expect(pad.status()).toBe('success');
    expect(fixture.nativeElement.textContent).toContain('Paid');
  });

  it('start() validates required inputs before any HTTP call', () => {
    const api = fakeReservationsApi();
    const { pad } = createComponent(api, { applicationId: '' });
    pad.start();
    expect(api.calls.length).toBe(0);
    expect(pad.status()).toBe('error');
    expect(pad.errorMessage()).toMatch(/Application ID/);
  });

  it('start() validates amount > 0', () => {
    const api = fakeReservationsApi();
    const { pad } = createComponent(api, { amount: 0 });
    pad.start();
    expect(api.calls.length).toBe(0);
    expect(pad.errorMessage()).toMatch(/greater than 0/);
  });

  it('happy path: POSTs start, emits handoffStarted, navigates Safari to square-commerce-v1://, schedules detection', () => {
    const api = fakeReservationsApi();
    const { pad, startedCalls } = createComponent(api);
    pad.start();
    expect(api.calls.length).toBe(1);
    expect(api.calls[0].reservationId).toBe('r-1');
    expect(api.calls[0].amount).toBe(50);
    expect(api.calls[0].returnPath).toBe('/staff/reservations');
    expect(startedCalls.length).toBe(1);
    expect(startedCalls[0].handoffId).toBe('h_test');
    expect(lastAssignedHref).toMatch(
      /^square-commerce-v1:\/\/payment\/create\?data=/,
    );
    // Decode the data param to assert the JSON payload shape. The URL
    // uses the `square-commerce-v1://` scheme which `new URL` doesn't
    // parse cleanly, so split on `?data=` directly.
    const encoded = (lastAssignedHref ?? '').split('?data=')[1] ?? '';
    const data = JSON.parse(decodeURIComponent(encoded));
    expect(data.client_id).toBe('app_1');
    expect(data.version).toBe('1.3');
    expect(data.amount_money).toEqual({ amount: 5000, currency_code: 'USD' });
    expect(data.callback_url).toBe(
      'https://app.test/staff/square-stand-callback',
    );
    expect(data.state).toBe('h_test');
    expect(data.notes).toMatch(/#FF-K7M3X2/);
    expect(data.options.supported_tender_types).toEqual(['CREDIT_CARD']);
    expect(data.options.auto_return).toBe(true);
  });

  it('treats document.visibilityState === "visible" after 2.5s as Square POS not opened', () => {
    const api = fakeReservationsApi();
    const { pad, missingCalls } = createComponent(api);
    pad.start();
    // jsdom keeps visibility as 'visible' — simulating Square POS never
    // launched. After the timer fires we expect the missing-app emit.
    vi.advanceTimersByTime(2600);
    expect(missingCalls.length).toBe(1);
    expect(pad.status()).toBe('error');
    expect(pad.errorMessage()).toMatch(/Square POS app did not open/);
  });

  it('surfaces start() failures via setError + handoffFailed', () => {
    const api = fakeReservationsApi();
    api.setNextResponse(throwError(() => ({ message: 'boom' })));
    const { pad, failedCalls } = createComponent(api);
    pad.start();
    expect(pad.status()).toBe('error');
    expect(pad.errorMessage()).toBe('boom');
    expect(failedCalls).toEqual(['boom']);
  });

  it('double-clicking start() is a no-op while a handoff is in flight', () => {
    const api = fakeReservationsApi();
    const { pad } = createComponent(api);
    pad.start();
    pad.start();
    expect(api.calls.length).toBe(1);
  });

  it('resetToIdle() clears state so staff can re-try', () => {
    const api = fakeReservationsApi();
    const { pad } = createComponent(api);
    pad.start();
    expect(pad.activeHandoffId()).toBe('h_test');
    pad.resetToIdle();
    expect(pad.status()).toBe('idle');
    expect(pad.activeHandoffId()).toBe(null);
    expect(pad.errorMessage()).toBe(null);
  });

  // ------------------------------------------------------------------
  // localStorage round-trip — Square POS strips query strings on return
  // so reservation context must be stashed locally before the deeplink
  // navigation; the /square-stand-callback page reads it back via the
  // handoffId echoed in `state`.
  // ------------------------------------------------------------------

  describe('localStorage stash on handoff', () => {
    beforeEach(() => {
      try {
        localStorage.clear();
      } catch {
        // jsdom can be flaky; ignore.
      }
    });

    it('stashes {reservationId, eventDate, returnPath, expiresAt} keyed by handoffId before navigating', () => {
      const api = fakeReservationsApi();
      const { pad } = createComponent(api, {
        reservationId: 'r-stash',
        eventDate: '2026-05-20',
      });
      pad.returnPath = '/staff/reservations';
      pad.start();
      const raw = localStorage.getItem('ff:stand-handoff:h_test');
      expect(raw).toBeTruthy();
      const stashed = JSON.parse(String(raw));
      expect(stashed.reservationId).toBe('r-stash');
      expect(stashed.eventDate).toBe('2026-05-20');
      expect(stashed.returnPath).toBe('/staff/reservations');
      expect(typeof stashed.expiresAt).toBe('number');
      expect(stashed.expiresAt).toBeGreaterThan(Date.now());
    });

    it('does not crash when localStorage.setItem throws (Safari private mode)', () => {
      const api = fakeReservationsApi();
      const { pad } = createComponent(api);
      const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('QuotaExceededError');
      });
      try {
        expect(() => pad.start()).not.toThrow();
        expect(api.calls.length).toBe(1);
        expect(lastAssignedHref).toMatch(/^square-commerce-v1:\/\//);
      } finally {
        spy.mockRestore();
      }
    });

    it('does not stash before the start HTTP call resolves', () => {
      const api = fakeReservationsApi();
      // Replace with a never-resolving observable.
      api.setNextResponse(new Observable(() => {}));
      const { pad } = createComponent(api);
      pad.start();
      expect(localStorage.getItem('ff:stand-handoff:h_test')).toBeNull();
    });
  });
});
