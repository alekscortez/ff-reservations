import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildShareMessage,
  CreatedReservationContext,
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
  it('maps client → cashapp (UI label vs API enum)', () => {
    expect(toCreatePaymentMethod('client')).toBe('cashapp');
  });
});

describe('toLinkMode', () => {
  it('returns square for square', () => {
    expect(toLinkMode('square')).toBe('square');
  });
  it('returns client for client', () => {
    expect(toLinkMode('client')).toBe('client');
  });
  it('returns null for cash (no link needed)', () => {
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
