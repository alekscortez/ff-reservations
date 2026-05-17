import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  consumeJustPaidBeacon,
  peekJustPaidBeacon,
  writeJustPaidBeacon,
} from './just-paid-beacon';

describe('just-paid-beacon', () => {
  beforeEach(() => {
    try {
      localStorage.clear();
    } catch {
      // jsdom flakes — ignore.
    }
  });

  afterEach(() => {
    try {
      localStorage.clear();
    } catch {
      // ignore
    }
  });

  describe('writeJustPaidBeacon', () => {
    it('stores reservationId + amount + paidAt + expiresAt under ff:stand-just-paid', () => {
      writeJustPaidBeacon({ reservationId: 'r-1', amount: 75 });
      const raw = localStorage.getItem('ff:stand-just-paid');
      expect(raw).toBeTruthy();
      const parsed = JSON.parse(String(raw));
      expect(parsed.reservationId).toBe('r-1');
      expect(parsed.amount).toBe(75);
      expect(typeof parsed.paidAt).toBe('number');
      expect(parsed.expiresAt).toBeGreaterThan(parsed.paidAt);
    });

    it('is a no-op when reservationId is empty', () => {
      writeJustPaidBeacon({ reservationId: '', amount: 50 });
      expect(localStorage.getItem('ff:stand-just-paid')).toBeNull();
    });

    it('is a no-op when amount is 0 or negative', () => {
      writeJustPaidBeacon({ reservationId: 'r-1', amount: 0 });
      expect(localStorage.getItem('ff:stand-just-paid')).toBeNull();
      writeJustPaidBeacon({ reservationId: 'r-1', amount: -1 });
      expect(localStorage.getItem('ff:stand-just-paid')).toBeNull();
    });
  });

  describe('consumeJustPaidBeacon', () => {
    it('returns and clears a fresh beacon', () => {
      writeJustPaidBeacon({ reservationId: 'r-1', amount: 50 });
      const out = consumeJustPaidBeacon();
      expect(out?.reservationId).toBe('r-1');
      expect(out?.amount).toBe(50);
      expect(localStorage.getItem('ff:stand-just-paid')).toBeNull();
    });

    it('returns null and clears an expired entry', () => {
      const past = Date.now() - 60 * 1000;
      localStorage.setItem(
        'ff:stand-just-paid',
        JSON.stringify({
          reservationId: 'r-1',
          amount: 50,
          paidAt: past - 10000,
          expiresAt: past,
        }),
      );
      expect(consumeJustPaidBeacon()).toBeNull();
      expect(localStorage.getItem('ff:stand-just-paid')).toBeNull();
    });

    it('returns null when absent', () => {
      expect(consumeJustPaidBeacon()).toBeNull();
    });

    it('returns null for unparseable JSON', () => {
      localStorage.setItem('ff:stand-just-paid', '{not-json');
      expect(consumeJustPaidBeacon()).toBeNull();
    });

    it('returns null for entries with missing reservationId', () => {
      localStorage.setItem(
        'ff:stand-just-paid',
        JSON.stringify({ amount: 50, expiresAt: Date.now() + 1000 }),
      );
      expect(consumeJustPaidBeacon()).toBeNull();
    });

    it('returns null for entries with non-positive amount', () => {
      localStorage.setItem(
        'ff:stand-just-paid',
        JSON.stringify({
          reservationId: 'r-1',
          amount: 0,
          expiresAt: Date.now() + 1000,
        }),
      );
      expect(consumeJustPaidBeacon()).toBeNull();
    });
  });

  describe('peekJustPaidBeacon', () => {
    it('returns the beacon without clearing it', () => {
      writeJustPaidBeacon({ reservationId: 'r-1', amount: 50 });
      const peeked = peekJustPaidBeacon();
      expect(peeked?.reservationId).toBe('r-1');
      // Still present after peek.
      expect(localStorage.getItem('ff:stand-just-paid')).toBeTruthy();
    });
  });
});
