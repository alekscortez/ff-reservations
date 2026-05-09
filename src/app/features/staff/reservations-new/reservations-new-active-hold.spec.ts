import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import {
  ACTIVE_HOLD_STORAGE_KEY,
  ActiveHoldSession,
  clearActiveHoldSessionStorage,
  extractTableIdFromHoldLock,
  findActiveHoldLock,
  readActiveHoldSession,
  writeActiveHoldSession,
} from './reservations-new-active-hold';

const FIXED_NOW_EPOCH = 1_700_000_000;

function makeSession(overrides: Partial<ActiveHoldSession> = {}): ActiveHoldSession {
  return {
    eventDate: '2026-05-09',
    tableId: 'T1',
    holdId: 'h1',
    holdExpiresAt: FIXED_NOW_EPOCH + 3600,
    holdCreatedByMe: true,
    showReservationModal: false,
    customerName: 'Alice',
    phone: '+12025550100',
    phoneCountry: 'US',
    amountDue: 100,
    depositAmount: 30,
    paymentStatus: 'PAID',
    paymentMethod: 'square',
    allowCustomDeposit: false,
    paymentDeadlineEnabled: true,
    paymentDeadlineDate: '2026-05-10',
    paymentDeadlineTime: '18:00',
    savedAt: FIXED_NOW_EPOCH * 1000,
    ...overrides,
  };
}

describe('writeActiveHoldSession + readActiveHoldSession', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

  it('round-trips a session through localStorage', () => {
    const session = makeSession();
    writeActiveHoldSession(session);
    expect(readActiveHoldSession()).toEqual(session);
  });

  it('returns null when nothing is stored', () => {
    expect(readActiveHoldSession()).toBe(null);
  });

  it('returns null when stored value is malformed JSON', () => {
    localStorage.setItem(ACTIVE_HOLD_STORAGE_KEY, '{not json');
    expect(readActiveHoldSession()).toBe(null);
  });

  it('returns null when stored object lacks eventDate / tableId / holdId', () => {
    localStorage.setItem(ACTIVE_HOLD_STORAGE_KEY, JSON.stringify({ eventDate: '2026-05-09' }));
    expect(readActiveHoldSession()).toBe(null);
  });

  it('coerces unknown paymentStatus to PAID', () => {
    const session = makeSession();
    localStorage.setItem(
      ACTIVE_HOLD_STORAGE_KEY,
      JSON.stringify({ ...session, paymentStatus: 'WHATEVER' })
    );
    expect(readActiveHoldSession()?.paymentStatus).toBe('PAID');
  });

  it('coerces unknown paymentMethod to square', () => {
    const session = makeSession();
    localStorage.setItem(
      ACTIVE_HOLD_STORAGE_KEY,
      JSON.stringify({ ...session, paymentMethod: 'wire' })
    );
    expect(readActiveHoldSession()?.paymentMethod).toBe('square');
  });

  it('coerces non-finite holdExpiresAt to null', () => {
    const session = makeSession();
    localStorage.setItem(
      ACTIVE_HOLD_STORAGE_KEY,
      JSON.stringify({ ...session, holdExpiresAt: 'not a number' })
    );
    expect(readActiveHoldSession()?.holdExpiresAt).toBe(null);
  });

  it('defaults missing booleans to true (holdCreatedByMe + showReservationModal)', () => {
    const session = makeSession();
    const partial: Partial<ActiveHoldSession> = {
      eventDate: session.eventDate,
      tableId: session.tableId,
      holdId: session.holdId,
    };
    localStorage.setItem(ACTIVE_HOLD_STORAGE_KEY, JSON.stringify(partial));
    const out = readActiveHoldSession();
    expect(out?.holdCreatedByMe).toBe(true);
    expect(out?.showReservationModal).toBe(true);
  });
});

describe('clearActiveHoldSessionStorage', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('removes a previously stored session', () => {
    writeActiveHoldSession(makeSession());
    expect(localStorage.getItem(ACTIVE_HOLD_STORAGE_KEY)).not.toBe(null);
    clearActiveHoldSessionStorage();
    expect(localStorage.getItem(ACTIVE_HOLD_STORAGE_KEY)).toBe(null);
  });

  it('is a no-op when nothing is stored', () => {
    expect(() => clearActiveHoldSessionStorage()).not.toThrow();
    expect(readActiveHoldSession()).toBe(null);
  });
});

describe('extractTableIdFromHoldLock', () => {
  it('extracts the suffix after TABLE#', () => {
    expect(extractTableIdFromHoldLock({ SK: 'TABLE#T1' } as any)).toBe('T1');
    expect(extractTableIdFromHoldLock({ SK: 'TABLE#A12' } as any)).toBe('A12');
  });

  it('returns null when SK does not start with TABLE#', () => {
    expect(extractTableIdFromHoldLock({ SK: 'OTHER#x' } as any)).toBe(null);
  });

  it('returns null when SK is empty / whitespace / missing', () => {
    expect(extractTableIdFromHoldLock({ SK: '' } as any)).toBe(null);
    expect(extractTableIdFromHoldLock({ SK: 'TABLE#' } as any)).toBe(null);
    expect(extractTableIdFromHoldLock({} as any)).toBe(null);
  });
});

describe('findActiveHoldLock', () => {
  function makeLock(overrides: Record<string, unknown> = {}): any {
    return {
      SK: 'TABLE#T1',
      lockType: 'HOLD',
      holdId: 'h1',
      expiresAt: FIXED_NOW_EPOCH + 3600,
      ...overrides,
    };
  }

  it('returns null when items is empty / null', () => {
    expect(findActiveHoldLock([], makeSession(), FIXED_NOW_EPOCH)).toBe(null);
    expect(findActiveHoldLock(null as any, makeSession(), FIXED_NOW_EPOCH)).toBe(null);
  });

  it('matches on lockType=HOLD + holdId + tableId', () => {
    const items = [makeLock()];
    const out = findActiveHoldLock(items, makeSession(), FIXED_NOW_EPOCH);
    expect(out).toEqual({ expiresAt: FIXED_NOW_EPOCH + 3600 });
  });

  it('skips RESERVED locks', () => {
    const items = [makeLock({ lockType: 'RESERVED' })];
    expect(findActiveHoldLock(items, makeSession(), FIXED_NOW_EPOCH)).toBe(null);
  });

  it('skips locks with mismatched holdId', () => {
    const items = [makeLock({ holdId: 'other' })];
    expect(findActiveHoldLock(items, makeSession(), FIXED_NOW_EPOCH)).toBe(null);
  });

  it('skips locks for a different table', () => {
    const items = [makeLock({ SK: 'TABLE#T2' })];
    expect(findActiveHoldLock(items, makeSession(), FIXED_NOW_EPOCH)).toBe(null);
  });

  it('skips expired locks (expiresAt <= now)', () => {
    const items = [makeLock({ expiresAt: FIXED_NOW_EPOCH - 10 })];
    expect(findActiveHoldLock(items, makeSession(), FIXED_NOW_EPOCH)).toBe(null);
  });

  it('returns null expiresAt when expiresRaw is invalid (and still matches)', () => {
    const items = [makeLock({ expiresAt: 'garbage' })];
    expect(findActiveHoldLock(items, makeSession(), FIXED_NOW_EPOCH)).toEqual({
      expiresAt: null,
    });
  });

  it('returns the first matching lock', () => {
    const items = [
      makeLock({ holdId: 'other', SK: 'TABLE#T1' }),
      makeLock({ expiresAt: FIXED_NOW_EPOCH + 1000 }),
      makeLock({ expiresAt: FIXED_NOW_EPOCH + 9999 }),
    ];
    const out = findActiveHoldLock(items, makeSession(), FIXED_NOW_EPOCH);
    expect(out).toEqual({ expiresAt: FIXED_NOW_EPOCH + 1000 });
  });
});
