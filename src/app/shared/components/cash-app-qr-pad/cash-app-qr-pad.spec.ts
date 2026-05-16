import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { CashAppQrPad } from './cash-app-qr-pad';
import { SquareWebPaymentsService } from '../../../core/payments/square-web-payments.service';

function fakeSquarePaymentsService() {
  const calls: Array<{
    onTokenized: (sourceId: string) => void;
    onError: (message: string) => void;
  }> = [];
  const destroyCalls: string[] = [];
  let nextResult: 'mount' | 'reject' = 'mount';
  let rejectMessage = '';
  return {
    calls,
    destroyCalls,
    mountResolves(): void {
      nextResult = 'mount';
    },
    mountRejects(message: string): void {
      nextResult = 'reject';
      rejectMessage = message;
    },
    service: {
      async mountCashAppPayButton(args: {
        onTokenized: (sourceId: string) => void;
        onError: (message: string) => void;
      }) {
        if (nextResult === 'reject') throw new Error(rejectMessage);
        calls.push({ onTokenized: args.onTokenized, onError: args.onError });
        return {
          destroy: async () => {
            destroyCalls.push('called');
          },
        };
      },
    },
  };
}

// Mount the pad directly (no parent template) so binding-propagation
// CD edge cases don't show up here. Component inputs are set via
// `componentRef.setInput` (signal-inputs require this path).
function createPad(
  square: ReturnType<typeof fakeSquarePaymentsService>,
  overrides: {
    applicationId?: string;
    locationId?: string;
    amount?: number;
    success?: boolean;
  } = {}
) {
  TestBed.configureTestingModule({
    imports: [CashAppQrPad],
    providers: [{ provide: SquareWebPaymentsService, useValue: square.service }],
  });
  const fixture = TestBed.createComponent(CashAppQrPad);
  const pad = fixture.componentInstance;
  pad.applicationId = overrides.applicationId ?? 'app-1';
  pad.locationId = overrides.locationId ?? 'loc-1';
  pad.amount = overrides.amount ?? 25;
  pad.label = 'Table 1 payment';
  pad.referenceId = 'r-1';
  pad.squareEnvMode = 'sandbox';
  fixture.componentRef.setInput('success', overrides.success ?? false);
  const tokenizedCalls: string[] = [];
  const erroredCalls: string[] = [];
  pad.tokenized.subscribe((s) => tokenizedCalls.push(s));
  pad.errored.subscribe((m) => erroredCalls.push(m));
  fixture.detectChanges();
  return { fixture, pad, tokenizedCalls, erroredCalls };
}

describe('CashAppQrPad', () => {
  it('starts in idle status', () => {
    const square = fakeSquarePaymentsService();
    const { fixture, pad } = createPad(square);
    expect(pad.status()).toBe('idle');
    expect(fixture.nativeElement.textContent).toContain('Tap "Show Cash App QR" below.');
  });

  it('400s on invalid amount before reaching Square', async () => {
    const square = fakeSquarePaymentsService();
    const { pad } = createPad(square, { amount: 0 });
    await pad.prepare();
    expect(square.calls.length).toBe(0);
    expect(pad.status()).toBe('error');
  });

  it('400s when application id is missing', async () => {
    const square = fakeSquarePaymentsService();
    const { pad } = createPad(square, { applicationId: '' });
    await pad.prepare();
    expect(square.calls.length).toBe(0);
    expect(pad.status()).toBe('error');
  });

  it('mounts the SDK on prepare() and reaches ready status', async () => {
    const square = fakeSquarePaymentsService();
    const { pad } = createPad(square);
    await pad.prepare();
    expect(square.calls.length).toBe(1);
    expect(pad.status()).toBe('ready');
  });

  it('emits tokenized and transitions to awaiting-approval when SDK tokenizes', async () => {
    const square = fakeSquarePaymentsService();
    const { pad, tokenizedCalls } = createPad(square);
    await pad.prepare();
    square.calls[0].onTokenized('src-1');
    expect(tokenizedCalls).toEqual(['src-1']);
    expect(pad.status()).toBe('awaiting-approval');
  });

  it('emits errored and flips to error status when SDK errors', async () => {
    const square = fakeSquarePaymentsService();
    const { pad, erroredCalls } = createPad(square);
    await pad.prepare();
    square.calls[0].onError('Cancelled');
    expect(erroredCalls).toEqual(['Cancelled']);
    expect(pad.status()).toBe('error');
  });

  it('success input overrides base status', async () => {
    const square = fakeSquarePaymentsService();
    const { fixture, pad } = createPad(square);
    await pad.prepare();
    fixture.componentRef.setInput('success', true);
    expect(pad.status()).toBe('success');
  });

  it('handles SDK mount failure as error state without emitting tokenized', async () => {
    const square = fakeSquarePaymentsService();
    square.mountRejects('Square SDK is unavailable.');
    const { pad, erroredCalls } = createPad(square);
    await pad.prepare();
    expect(square.calls.length).toBe(0);
    expect(pad.status()).toBe('error');
    expect(erroredCalls.length).toBe(1);
  });

  it('cleans up the previous mount on prepare() retry', async () => {
    const square = fakeSquarePaymentsService();
    const { pad } = createPad(square);
    await pad.prepare();
    await pad.prepare();
    expect(square.calls.length).toBe(2);
    expect(square.destroyCalls.length).toBeGreaterThanOrEqual(1);
  });
});
