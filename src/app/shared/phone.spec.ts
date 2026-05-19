import { describe, expect, it } from 'vitest';
import {
  formatPhoneAsYouType,
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

describe('formatPhoneAsYouType — US (default)', () => {
  it('empty input returns empty string', () => {
    expect(formatPhoneAsYouType('', 'US')).toBe('');
    expect(formatPhoneAsYouType(null, 'US')).toBe('');
    expect(formatPhoneAsYouType(undefined, 'US')).toBe('');
  });
  it('1 digit emits open paren', () => {
    expect(formatPhoneAsYouType('9', 'US')).toBe('(9');
  });
  it('2 digits stay inside paren', () => {
    expect(formatPhoneAsYouType('95', 'US')).toBe('(95');
  });
  it('exactly 3 digits closes the paren so user sees the area code is done', () => {
    expect(formatPhoneAsYouType('956', 'US')).toBe('(956)');
  });
  it('4 digits → "(956) 1"', () => {
    expect(formatPhoneAsYouType('9561', 'US')).toBe('(956) 1');
  });
  it('6 digits → "(956) 123"', () => {
    expect(formatPhoneAsYouType('956123', 'US')).toBe('(956) 123');
  });
  it('7 digits → "(956) 123-4"', () => {
    expect(formatPhoneAsYouType('9561234', 'US')).toBe('(956) 123-4');
  });
  it('10 digits → "(956) 123-4567"', () => {
    expect(formatPhoneAsYouType('9561234567', 'US')).toBe('(956) 123-4567');
  });
  it('strips any "1" country-code prefix when total is 11 digits', () => {
    expect(formatPhoneAsYouType('19561234567', 'US')).toBe('(956) 123-4567');
  });
  it('truncates extras past 10 digits', () => {
    expect(formatPhoneAsYouType('95612345678901', 'US')).toBe('(956) 123-4567');
  });
  it('strips non-digit characters', () => {
    expect(formatPhoneAsYouType('(956) 123-4567', 'US')).toBe('(956) 123-4567');
    expect(formatPhoneAsYouType('+1 956 123 4567', 'US')).toBe('(956) 123-4567');
    expect(formatPhoneAsYouType('abc956def', 'US')).toBe('(956)');
  });
  it('defaults to US when country omitted', () => {
    expect(formatPhoneAsYouType('9561234567')).toBe('(956) 123-4567');
  });
});

describe('formatPhoneAsYouType — MX', () => {
  it('empty input returns empty string', () => {
    expect(formatPhoneAsYouType('', 'MX')).toBe('');
  });
  it('1-3 digits emitted raw (no paren convention in MX)', () => {
    expect(formatPhoneAsYouType('8', 'MX')).toBe('8');
    expect(formatPhoneAsYouType('89', 'MX')).toBe('89');
    expect(formatPhoneAsYouType('899', 'MX')).toBe('899');
  });
  it('4 digits → "899 1"', () => {
    expect(formatPhoneAsYouType('8991', 'MX')).toBe('899 1');
  });
  it('6 digits → "899 105"', () => {
    expect(formatPhoneAsYouType('899105', 'MX')).toBe('899 105');
  });
  it('10 digits → "899 105 4670"', () => {
    expect(formatPhoneAsYouType('8991054670', 'MX')).toBe('899 105 4670');
  });
  it('strips "52" prefix when total is 12 digits', () => {
    expect(formatPhoneAsYouType('528991054670', 'MX')).toBe('899 105 4670');
  });
  it('strips "521" mobile prefix when total is 13 digits', () => {
    expect(formatPhoneAsYouType('5218991054670', 'MX')).toBe('899 105 4670');
  });
  it('truncates extras past 10 digits', () => {
    expect(formatPhoneAsYouType('89910546709999', 'MX')).toBe('899 105 4670');
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
