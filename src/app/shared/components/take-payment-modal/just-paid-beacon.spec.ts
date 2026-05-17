import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  consumeJustPaidBeacon,
  peekJustPaidBeacon,
  subscribeToJustPaid,
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

  describe('subscribeToJustPaid', () => {
    // Manually dispatch StorageEvents because jsdom doesn't fire them
    // cross-test; they're meant to fire only on OTHER tabs/windows.
    function fireStorageEvent(payload: {
      key?: string | null;
      newValue?: string | null;
      oldValue?: string | null;
    }): void {
      const ev = new StorageEvent('storage', {
        key: payload.key ?? null,
        newValue: payload.newValue ?? null,
        oldValue: payload.oldValue ?? null,
      });
      window.dispatchEvent(ev);
    }

    it('fires the callback when the beacon key is written in another tab', () => {
      const beacons: Array<{ reservationId: string; amount: number }> = [];
      const unsub = subscribeToJustPaid((b) =>
        beacons.push({ reservationId: b.reservationId, amount: b.amount }),
      );
      fireStorageEvent({
        key: 'ff:stand-just-paid',
        newValue: JSON.stringify({
          reservationId: 'r-1',
          amount: 50,
          expiresAt: Date.now() + 60000,
        }),
      });
      expect(beacons).toEqual([{ reservationId: 'r-1', amount: 50 }]);
      unsub();
    });

    it('ignores storage events for OTHER keys', () => {
      const beacons: unknown[] = [];
      const unsub = subscribeToJustPaid((b) => beacons.push(b));
      fireStorageEvent({
        key: 'other-key',
        newValue: JSON.stringify({ reservationId: 'r-1', amount: 50 }),
      });
      expect(beacons).toEqual([]);
      unsub();
    });

    it('recovers payload from oldValue when newValue is null (consume event)', () => {
      // When another tab consumes the beacon (deletes it), the storage
      // event fires with newValue: null but oldValue: <the entry>. The
      // wizard should still be able to learn what was paid.
      const beacons: Array<{ reservationId: string }> = [];
      const unsub = subscribeToJustPaid((b) =>
        beacons.push({ reservationId: b.reservationId }),
      );
      fireStorageEvent({
        key: 'ff:stand-just-paid',
        newValue: null,
        oldValue: JSON.stringify({
          reservationId: 'r-consumed',
          amount: 25,
          expiresAt: Date.now() + 60000,
        }),
      });
      expect(beacons).toEqual([{ reservationId: 'r-consumed' }]);
      unsub();
    });

    it('ignores expired entries', () => {
      const beacons: unknown[] = [];
      const unsub = subscribeToJustPaid((b) => beacons.push(b));
      fireStorageEvent({
        key: 'ff:stand-just-paid',
        newValue: JSON.stringify({
          reservationId: 'r-old',
          amount: 50,
          expiresAt: Date.now() - 1000,
        }),
      });
      expect(beacons).toEqual([]);
      unsub();
    });

    it('ignores entries missing reservationId or amount', () => {
      const beacons: unknown[] = [];
      const unsub = subscribeToJustPaid((b) => beacons.push(b));
      fireStorageEvent({
        key: 'ff:stand-just-paid',
        newValue: JSON.stringify({ amount: 50 }),
      });
      fireStorageEvent({
        key: 'ff:stand-just-paid',
        newValue: JSON.stringify({ reservationId: 'r-1', amount: 0 }),
      });
      expect(beacons).toEqual([]);
      unsub();
    });

    it('survives unparseable JSON', () => {
      const beacons: unknown[] = [];
      const unsub = subscribeToJustPaid((b) => beacons.push(b));
      expect(() =>
        fireStorageEvent({
          key: 'ff:stand-just-paid',
          newValue: '{not-json',
        }),
      ).not.toThrow();
      expect(beacons).toEqual([]);
      unsub();
    });

    it('unsub stops further callbacks', () => {
      const beacons: unknown[] = [];
      const unsub = subscribeToJustPaid((b) => beacons.push(b));
      unsub();
      fireStorageEvent({
        key: 'ff:stand-just-paid',
        newValue: JSON.stringify({
          reservationId: 'r-1',
          amount: 50,
          expiresAt: Date.now() + 60000,
        }),
      });
      expect(beacons).toEqual([]);
    });
  });
});
