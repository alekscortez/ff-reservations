import { describe, expect, it } from 'vitest';
import { RescheduleCredit } from '../../../core/http/clients.service';
import {
  computeCreditAppliedAmount,
  computeCreditRemainingAmount,
  findCreditById,
  formatCreditLabel,
  sumCreditsRemaining,
} from './reservations-new-credits';

function makeCredit(overrides: Partial<RescheduleCredit> = {}): RescheduleCredit {
  return {
    creditId: 'c1',
    amountTotal: 100,
    amountRemaining: 50,
    expiresAt: '2026-12-31',
    status: 'ACTIVE',
    sourceReservationId: 'r1',
    sourceEventDate: '2026-01-01',
    issuedAt: 1_700_000_000,
    issuedBy: 'staff',
    phone: '+12025550100',
    customerName: 'Alice',
    ...overrides,
  } as RescheduleCredit;
}

describe('sumCreditsRemaining', () => {
  it('returns 0 for empty / null / undefined', () => {
    expect(sumCreditsRemaining([])).toBe(0);
    expect(sumCreditsRemaining(null as any)).toBe(0);
    expect(sumCreditsRemaining(undefined as any)).toBe(0);
  });

  it('sums amountRemaining across credits', () => {
    expect(
      sumCreditsRemaining([
        makeCredit({ amountRemaining: 30 }),
        makeCredit({ amountRemaining: 20.5 }),
        makeCredit({ amountRemaining: 49.5 }),
      ])
    ).toBe(100);
  });

  it('rounds the total to 2 decimal places', () => {
    expect(
      sumCreditsRemaining([
        makeCredit({ amountRemaining: 0.1 }),
        makeCredit({ amountRemaining: 0.2 }),
      ])
    ).toBe(0.3);
  });

  it('treats invalid amounts as 0 (NaN-tolerant)', () => {
    expect(
      sumCreditsRemaining([
        makeCredit({ amountRemaining: 30 }),
        makeCredit({ amountRemaining: 'bad' as any }),
        makeCredit({ amountRemaining: null as any }),
        makeCredit({ amountRemaining: undefined as any }),
      ])
    ).toBe(30);
  });
});

describe('formatCreditLabel', () => {
  it('formats with expiry when present', () => {
    const out = formatCreditLabel(makeCredit({ amountRemaining: 50, expiresAt: '2026-12-31' }));
    expect(out).toMatch(/^\$50\.00 · Expires/);
  });

  it('falls back to "No expiry" when expiresAt is empty / null', () => {
    expect(formatCreditLabel(makeCredit({ amountRemaining: 25, expiresAt: '' }))).toBe(
      '$25.00 · No expiry'
    );
    expect(formatCreditLabel(makeCredit({ amountRemaining: 25, expiresAt: null as any }))).toBe(
      '$25.00 · No expiry'
    );
  });

  it('renders 0 amount cleanly', () => {
    expect(formatCreditLabel(makeCredit({ amountRemaining: 0 }))).toMatch(/^\$0\.00 · /);
  });

  it('uses the unparseable expiry value as-is (formatCreditExpiry passthrough)', () => {
    const out = formatCreditLabel(makeCredit({ amountRemaining: 100, expiresAt: 'garbage' }));
    expect(out).toBe('$100.00 · Expires garbage');
  });
});

describe('findCreditById', () => {
  const credits = [
    makeCredit({ creditId: 'c1' }),
    makeCredit({ creditId: 'c2' }),
    makeCredit({ creditId: 'c3' }),
  ];

  it('returns the matching credit', () => {
    expect(findCreditById(credits, 'c2')?.creditId).toBe('c2');
  });

  it('returns null when id is empty / missing', () => {
    expect(findCreditById(credits, '')).toBe(null);
    expect(findCreditById(credits, '   ')).toBe(null);
    expect(findCreditById(credits, null as any)).toBe(null);
  });

  it('returns null when id does not match', () => {
    expect(findCreditById(credits, 'nope')).toBe(null);
  });

  it('returns null when credits list is empty / null', () => {
    expect(findCreditById([], 'c1')).toBe(null);
    expect(findCreditById(null as any, 'c1')).toBe(null);
  });

  it('trims whitespace from id before matching', () => {
    expect(findCreditById(credits, '  c2  ')?.creditId).toBe('c2');
  });
});

describe('computeCreditAppliedAmount', () => {
  it('returns 0 when credit is null', () => {
    expect(computeCreditAppliedAmount(null, 100)).toBe(0);
  });

  it('returns the lesser of amountDue and credit remaining', () => {
    expect(computeCreditAppliedAmount(makeCredit({ amountRemaining: 30 }), 100)).toBe(30);
    expect(computeCreditAppliedAmount(makeCredit({ amountRemaining: 200 }), 100)).toBe(100);
  });

  it('clamps negative amountDue to 0', () => {
    expect(computeCreditAppliedAmount(makeCredit({ amountRemaining: 50 }), -10)).toBe(0);
  });

  it('treats invalid amountDue as 0 (NaN guard)', () => {
    expect(computeCreditAppliedAmount(makeCredit({ amountRemaining: 50 }), NaN)).toBe(0);
  });

  it('treats invalid credit amountRemaining as 0', () => {
    expect(
      computeCreditAppliedAmount(
        makeCredit({ amountRemaining: 'bad' as any }),
        100
      )
    ).toBe(0);
  });

  it('rounds to 2 decimal places', () => {
    expect(
      computeCreditAppliedAmount(makeCredit({ amountRemaining: 50.456 }), 100)
    ).toBe(50.46);
  });
});

describe('computeCreditRemainingAmount', () => {
  it('returns amountDue when applied is 0', () => {
    expect(computeCreditRemainingAmount(100, 0)).toBe(100);
  });

  it('subtracts applied from amountDue', () => {
    expect(computeCreditRemainingAmount(100, 30)).toBe(70);
  });

  it('saturates at 0 when applied >= amountDue', () => {
    expect(computeCreditRemainingAmount(100, 100)).toBe(0);
    expect(computeCreditRemainingAmount(100, 200)).toBe(0);
  });

  it('treats invalid inputs as 0 (NaN-tolerant)', () => {
    expect(computeCreditRemainingAmount(NaN, 50)).toBe(0);
    expect(computeCreditRemainingAmount(100, NaN)).toBe(0);
  });

  it('rounds to 2 decimal places', () => {
    expect(computeCreditRemainingAmount(100, 33.333)).toBe(66.67);
  });
});
