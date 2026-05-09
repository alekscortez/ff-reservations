import { describe, expect, it } from 'vitest';
import {
  inferPhoneCountryFromE164,
  normalizePhoneCountry,
  normalizePhoneToDigits,
  normalizePhoneToE164,
} from './phone';

describe('normalizePhoneCountry', () => {
  it('passes through US and MX', () => {
    expect(normalizePhoneCountry('US')).toBe('US');
    expect(normalizePhoneCountry('MX')).toBe('MX');
  });
  it('uppercases lowercase input', () => {
    expect(normalizePhoneCountry('us')).toBe('US');
    expect(normalizePhoneCountry('mx')).toBe('MX');
  });
  it('trims whitespace', () => {
    expect(normalizePhoneCountry('  US  ')).toBe('US');
  });
  it('falls back to US for unsupported / empty / null', () => {
    expect(normalizePhoneCountry('CA')).toBe('US');
    expect(normalizePhoneCountry('')).toBe('US');
    expect(normalizePhoneCountry(null)).toBe('US');
    expect(normalizePhoneCountry(undefined)).toBe('US');
  });
});

describe('normalizePhoneToE164 — international (+) input', () => {
  it('parses +1 US number', () => {
    expect(normalizePhoneToE164('+12025550100')).toBe('+12025550100');
  });
  it('parses +1 with formatting', () => {
    expect(normalizePhoneToE164('+1 (202) 555-0100')).toBe('+12025550100');
  });
  it('parses +52 MX number (10-digit national)', () => {
    expect(normalizePhoneToE164('+528991054670')).toBe('+528991054670');
  });
  it('strips +521 mobile prefix to canonical +52 form (audit-aligned)', () => {
    expect(normalizePhoneToE164('+5218991054670')).toBe('+528991054670');
  });
  it('rejects bogus +1 length (too short)', () => {
    expect(normalizePhoneToE164('+1202555')).toBe('');
  });
  it('rejects unsupported country code', () => {
    expect(normalizePhoneToE164('+44123456789')).toBe('');
  });
  it('treats 00-prefix as +', () => {
    expect(normalizePhoneToE164('0012025550100')).toBe('+12025550100');
  });
});

describe('normalizePhoneToE164 — national digits with country hint', () => {
  it('10-digit US default → +1', () => {
    expect(normalizePhoneToE164('2025550100')).toBe('+12025550100');
    expect(normalizePhoneToE164('2025550100', 'US')).toBe('+12025550100');
  });
  it('10-digit with MX hint → +52', () => {
    expect(normalizePhoneToE164('8991054670', 'MX')).toBe('+528991054670');
  });
  it('11-digit starting with 1 → +1 (US)', () => {
    expect(normalizePhoneToE164('12025550100')).toBe('+12025550100');
  });
  it('12-digit starting with 52 → +52', () => {
    expect(normalizePhoneToE164('528991054670')).toBe('+528991054670');
  });
  it('13-digit starting with 521 → strips the 1 (MX mobile canonical)', () => {
    expect(normalizePhoneToE164('5218991054670')).toBe('+528991054670');
  });
  it('handles formatted input', () => {
    expect(normalizePhoneToE164('(202) 555-0100')).toBe('+12025550100');
    expect(normalizePhoneToE164('202.555.0100')).toBe('+12025550100');
  });
  it('returns empty on bad lengths', () => {
    expect(normalizePhoneToE164('123')).toBe('');
    expect(normalizePhoneToE164('999999999999999')).toBe('');
  });
  it('returns empty for empty / null input', () => {
    expect(normalizePhoneToE164('')).toBe('');
    expect(normalizePhoneToE164(null)).toBe('');
    expect(normalizePhoneToE164(undefined)).toBe('');
    expect(normalizePhoneToE164('   ')).toBe('');
  });
  it('coerces invalid country hint to US', () => {
    expect(normalizePhoneToE164('2025550100', 'CA' as any)).toBe('+12025550100');
  });
});

describe('normalizePhoneToDigits', () => {
  it('returns digits-only of E.164 (drops the +)', () => {
    expect(normalizePhoneToDigits('+12025550100')).toBe('12025550100');
    expect(normalizePhoneToDigits('2025550100')).toBe('12025550100');
    expect(normalizePhoneToDigits('8991054670', 'MX')).toBe('528991054670');
  });
  it('returns empty when input is unparseable', () => {
    expect(normalizePhoneToDigits('garbage')).toBe('');
    expect(normalizePhoneToDigits('')).toBe('');
  });
});

describe('inferPhoneCountryFromE164', () => {
  it('detects US from +1', () => {
    expect(inferPhoneCountryFromE164('+12025550100')).toBe('US');
  });
  it('detects MX from +52', () => {
    expect(inferPhoneCountryFromE164('+528991054670')).toBe('MX');
  });
  it('returns null when not parseable', () => {
    expect(inferPhoneCountryFromE164('+44123456789')).toBe(null);
    expect(inferPhoneCountryFromE164('garbage')).toBe(null);
    expect(inferPhoneCountryFromE164('')).toBe(null);
  });
  it('infers from a national 10-digit US-default input', () => {
    // Goes through normalizePhoneToE164(phone, 'US') first
    expect(inferPhoneCountryFromE164('2025550100')).toBe('US');
  });
});
