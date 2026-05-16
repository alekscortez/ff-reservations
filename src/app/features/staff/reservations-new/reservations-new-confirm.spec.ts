import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildShareMessage,
  CreatedReservationContext,
  formatTablesLabel,
  toCreatePaymentMethod,
  toLinkMode,
  toSmsRecipient,
  toWhatsAppRecipient,
  writeClipboard,
} from './reservations-new-confirm';

function makeCtx(overrides: Partial<CreatedReservationContext> = {}): CreatedReservationContext {
  return {
    reservationId: 'r1',
    eventDate: '2026-05-09',
    tableId: 'A1',
    tableIds: ['A1'],
    customerName: 'Alice',
    phone: '+12025550100',
    amount: 100,
    linkMode: 'square',
    ...overrides,
  };
}

describe('toCreatePaymentMethod', () => {
  it('maps cash → cash', () => {
    expect(toCreatePaymentMethod('cash')).toBe('cash');
  });
  it('maps square → square', () => {
    expect(toCreatePaymentMethod('square')).toBe('square');
  });
  it('maps cashapp → cashapp (in-venue QR; never a link)', () => {
    expect(toCreatePaymentMethod('cashapp')).toBe('cashapp');
  });
});

describe('toLinkMode', () => {
  it('returns square for square (hosted-checkout link follow-up)', () => {
    expect(toLinkMode('square')).toBe('square');
  });
  it('returns cashapp for cashapp (in-venue QR follow-up)', () => {
    expect(toLinkMode('cashapp')).toBe('cashapp');
  });
  it('returns null for cash (recorded at create, no follow-up)', () => {
    expect(toLinkMode('cash')).toBe(null);
  });
});

describe('buildShareMessage', () => {
  it('formats the share text with name + date + table + url', () => {
    const out = buildShareMessage(makeCtx(), 'https://x/y');
    expect(out).toBe(
      'Hi Alice, here is your table link for 2026-05-09 table A1: https://x/y'
    );
  });
  it('handles empty customer name without crashing', () => {
    const out = buildShareMessage(makeCtx({ customerName: '' }), 'https://x');
    expect(out).toBe('Hi , here is your table link for 2026-05-09 table A1: https://x');
  });
  it('renders "tables 1, 2, 3" + "tables link" for multi-table bookings', () => {
    const out = buildShareMessage(
      makeCtx({ tableId: 'A1', tableIds: ['A1', 'B3', 'C2'] }),
      'https://x/y'
    );
    expect(out).toBe(
      'Hi Alice, here is your tables link for 2026-05-09 tables A1, B3, C2: https://x/y'
    );
  });
  it('prefers tableIds[] over the scalar tableId', () => {
    const out = buildShareMessage(
      makeCtx({ tableId: 'OLD', tableIds: ['A1', 'B3'] }),
      'https://x'
    );
    expect(out).toContain('tables A1, B3');
    expect(out).not.toContain('OLD');
  });
});

describe('formatTablesLabel', () => {
  it('returns "table N" for a single-table list', () => {
    expect(formatTablesLabel(['A1'])).toBe('table A1');
  });
  it('returns "tables N, M, ..." for multi-table lists', () => {
    expect(formatTablesLabel(['A1', 'B3', 'C2'])).toBe('tables A1, B3, C2');
  });
  it('returns "" for empty / nullish input', () => {
    expect(formatTablesLabel([])).toBe('');
    expect(formatTablesLabel(null)).toBe('');
    expect(formatTablesLabel(undefined)).toBe('');
  });
  it('trims whitespace + drops empty entries', () => {
    expect(formatTablesLabel(['A1', '  ', 'B3'])).toBe('tables A1, B3');
  });
});

describe('toSmsRecipient', () => {
  it('keeps the leading + and digits, strips everything else', () => {
    expect(toSmsRecipient('+1 (202) 555-0100')).toBe('+12025550100');
    expect(toSmsRecipient('+52-899-105-4670')).toBe('+528991054670');
  });
  it('handles raw digits without a +', () => {
    expect(toSmsRecipient('2025550100')).toBe('2025550100');
  });
  it('returns empty string for empty input', () => {
    expect(toSmsRecipient('')).toBe('');
    expect(toSmsRecipient(undefined)).toBe('');
  });
  it('returns empty string for whitespace-only input', () => {
    expect(toSmsRecipient('   ')).toBe('');
  });
});

describe('toWhatsAppRecipient', () => {
  it('strips everything except digits (no leading +)', () => {
    expect(toWhatsAppRecipient('+1 (202) 555-0100')).toBe('12025550100');
    expect(toWhatsAppRecipient('+52-899-105-4670')).toBe('528991054670');
  });
  it('returns empty string for empty / whitespace input', () => {
    expect(toWhatsAppRecipient('')).toBe('');
    expect(toWhatsAppRecipient(undefined)).toBe('');
    expect(toWhatsAppRecipient('   ')).toBe('');
  });
});

describe('writeClipboard', () => {
  let originalNavigator: any;

  beforeEach(() => {
    originalNavigator = (globalThis as any).navigator;
  });

  afterEach(() => {
    (globalThis as any).navigator = originalNavigator;
  });

  it('returns false on empty input (no clipboard call)', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    (globalThis as any).navigator = { clipboard: { writeText } };
    expect(await writeClipboard('')).toBe(false);
    expect(await writeClipboard('   ')).toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });

  it('returns false when navigator.clipboard.writeText is missing', async () => {
    (globalThis as any).navigator = {};
    expect(await writeClipboard('hello')).toBe(false);
  });

  it('returns true on successful clipboard write', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    (globalThis as any).navigator = { clipboard: { writeText } };
    expect(await writeClipboard('hello')).toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello');
  });

  it('returns false when writeText rejects (permission denied / blocked)', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('NotAllowedError'));
    (globalThis as any).navigator = { clipboard: { writeText } };
    expect(await writeClipboard('hello')).toBe(false);
  });

  it('trims whitespace from input before writing', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    (globalThis as any).navigator = { clipboard: { writeText } };
    await writeClipboard('  hello  ');
    expect(writeText).toHaveBeenCalledWith('hello');
  });
});
