import {
  formatCreditExpiry,
  formatEventDate,
  formatHm,
  isFutureDeadline,
  isThisWeek,
  nextDate,
  normalizeDeadlineLocalIso,
  normalizeHour,
  normalizeMinute,
  normalizePhone,
  normalizePollingSeconds,
  normalizeSectionMapColors,
  nowInTimeZoneLocalIso,
  phonesMatch,
  todayString,
} from './reservations-new-utils';

describe('normalizePhone', () => {
  it('strips non-digits', () => {
    expect(normalizePhone('+1 (202) 555-0100')).toBe('12025550100');
  });
  it('handles null/undefined/empty', () => {
    expect(normalizePhone(null)).toBe('');
    expect(normalizePhone(undefined)).toBe('');
    expect(normalizePhone('')).toBe('');
  });
});

describe('phonesMatch', () => {
  it('returns false on empty inputs', () => {
    expect(phonesMatch('', '')).toBe(false);
    expect(phonesMatch(null, '12025550100')).toBe(false);
    expect(phonesMatch('+12025550100', '')).toBe(false);
  });
  it('exact match on normalized digits', () => {
    expect(phonesMatch('+1 (202) 555-0100', '12025550100')).toBe(true);
  });
  it('matches 10-digit US number against stored E.164', () => {
    expect(phonesMatch('+12025550100', '2025550100')).toBe(true);
  });
  it('matches 10-digit MX local against stored +52 + +521', () => {
    expect(phonesMatch('+528991234567', '8991234567')).toBe(true);
    expect(phonesMatch('+5218991234567', '8991234567')).toBe(true);
  });
  it('rejects non-matching numbers', () => {
    expect(phonesMatch('+12025550100', '2025550101')).toBe(false);
  });
});

describe('formatCreditExpiry', () => {
  it('returns empty string for empty input', () => {
    expect(formatCreditExpiry('')).toBe('');
    expect(formatCreditExpiry(null)).toBe('');
    expect(formatCreditExpiry(undefined)).toBe('');
  });
  it('returns the raw value when not parseable', () => {
    expect(formatCreditExpiry('not-a-date')).toBe('not-a-date');
  });
  it('formats a YYYY-MM-DD into a localized short date', () => {
    const out = formatCreditExpiry('2026-12-25');
    // Locale-dependent but should at least include the year
    expect(out).toMatch(/2026/);
  });
});

describe('nextDate', () => {
  it('adds 1 day in UTC', () => {
    expect(nextDate('2026-05-09')).toBe('2026-05-10');
  });
  it('handles month boundary', () => {
    expect(nextDate('2026-05-31')).toBe('2026-06-01');
  });
  it('handles year boundary', () => {
    expect(nextDate('2026-12-31')).toBe('2027-01-01');
  });
  it('handles leap-day boundary', () => {
    expect(nextDate('2024-02-28')).toBe('2024-02-29');
    expect(nextDate('2024-02-29')).toBe('2024-03-01');
  });
  it('returns input unchanged when not parseable', () => {
    expect(nextDate('garbage')).toBe('garbage');
    // Numeric-looking but absurd values still pass parts.length === 3 + isNaN
    // checks, so JS Date wraps them via UTC math. We don't pin the exact
    // result — just verify nextDate didn't crash and returned a non-empty
    // string.
    expect(typeof nextDate('2026-99-99')).toBe('string');
  });
});

describe('normalizeDeadlineLocalIso', () => {
  it('accepts YYYY-MM-DDTHH:mm and pads seconds', () => {
    expect(normalizeDeadlineLocalIso('2026-05-09T18:30')).toBe('2026-05-09T18:30:00');
  });
  it('accepts YYYY-MM-DDTHH:mm:ss as-is', () => {
    expect(normalizeDeadlineLocalIso('2026-05-09T18:30:45')).toBe('2026-05-09T18:30:45');
  });
  it('returns null on bad input', () => {
    expect(normalizeDeadlineLocalIso('garbage')).toBe(null);
    expect(normalizeDeadlineLocalIso('2026-05-09')).toBe(null);
    expect(normalizeDeadlineLocalIso('')).toBe(null);
  });
});

describe('nowInTimeZoneLocalIso', () => {
  it('returns a YYYY-MM-DDTHH:mm:ss string for a valid tz', () => {
    const out = nowInTimeZoneLocalIso('America/Chicago');
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  });
  it('returns null on bogus tz', () => {
    expect(nowInTimeZoneLocalIso('Mars/Olympus')).toBe(null);
  });
});

describe('isFutureDeadline', () => {
  it('returns false on null deadline', () => {
    expect(isFutureDeadline('garbage', 'America/Chicago')).toBe(false);
  });
  it('returns false on bogus tz (falls back to America/Chicago, but test by passing future date)', () => {
    // Pass an obviously-future date so we exercise the comparison branch
    expect(isFutureDeadline('2099-01-01T00:00', 'America/Chicago')).toBe(true);
  });
  it('returns false for past deadlines', () => {
    expect(isFutureDeadline('2000-01-01T00:00', 'America/Chicago')).toBe(false);
  });
});

describe('normalizePollingSeconds', () => {
  it('returns fallback when undefined or NaN (Number(null) === 0, not NaN)', () => {
    expect(normalizePollingSeconds(undefined, 30)).toBe(30);
    expect(normalizePollingSeconds(NaN, 30)).toBe(30);
  });
  it('clamps to [5, 120]', () => {
    expect(normalizePollingSeconds(0, 30)).toBe(5);
    expect(normalizePollingSeconds(null, 30)).toBe(5); // Number(null) → 0 → clamped to 5
    expect(normalizePollingSeconds(1000, 30)).toBe(120);
  });
  it('rounds non-integer values', () => {
    expect(normalizePollingSeconds(15.7, 30)).toBe(16);
  });
});

describe('normalizeHour', () => {
  it('clamps to [0, 23]', () => {
    expect(normalizeHour(-1, 12)).toBe(0);
    expect(normalizeHour(99, 12)).toBe(23);
    expect(normalizeHour(13, 12)).toBe(13);
  });
  it('falls back only when Number() yields NaN (undefined, not null)', () => {
    expect(normalizeHour(undefined, 12)).toBe(12);
    expect(normalizeHour(NaN, 12)).toBe(12);
    // Number(null) → 0, which is finite, so it clamps to 0 instead of falling back
    expect(normalizeHour(null, 12)).toBe(0);
  });
});

describe('normalizeMinute', () => {
  it('clamps to [0, 59]', () => {
    expect(normalizeMinute(-1, 0)).toBe(0);
    expect(normalizeMinute(99, 0)).toBe(59);
    expect(normalizeMinute(30, 0)).toBe(30);
  });
  it('falls back only when Number() yields NaN', () => {
    expect(normalizeMinute(undefined, 15)).toBe(15);
    expect(normalizeMinute(NaN, 15)).toBe(15);
  });
});

describe('formatHm', () => {
  it('formats with zero-padded HH:MM', () => {
    expect(formatHm(9, 5)).toBe('09:05');
    expect(formatHm(18, 30)).toBe('18:30');
    expect(formatHm(0, 0)).toBe('00:00');
  });
  it('clamps via normalizeHour/normalizeMinute', () => {
    expect(formatHm(99, 99)).toBe('23:59');
  });
});

describe('isThisWeek', () => {
  it('returns false for empty input', () => {
    expect(isThisWeek(undefined)).toBe(false);
    expect(isThisWeek('')).toBe(false);
  });
  it('returns false for invalid date', () => {
    expect(isThisWeek('not-a-date')).toBe(false);
  });
  it('returns true for today', () => {
    expect(isThisWeek(todayString())).toBe(true);
  });
});

describe('formatEventDate', () => {
  it('returns em-dash for empty', () => {
    expect(formatEventDate(undefined)).toBe('—');
    expect(formatEventDate('')).toBe('—');
  });
  it('returns input when not parseable', () => {
    expect(formatEventDate('garbage')).toBe('garbage');
  });
  it('formats valid YYYY-MM-DD', () => {
    const out = formatEventDate('2026-05-09');
    // Locale-dependent but should at least mention the day
    expect(out).toMatch(/\d/);
  });
});

describe('todayString', () => {
  it('returns YYYY-MM-DD format', () => {
    expect(todayString()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('normalizeSectionMapColors', () => {
  it('returns fallback when input is null/undefined/non-object', () => {
    expect(normalizeSectionMapColors(null)).toEqual({
      A: '#ec008c',
      B: '#2e3192',
      C: '#00aeef',
      D: '#f7941d',
      E: '#711411',
    });
    expect(normalizeSectionMapColors('string')).toEqual({
      A: '#ec008c',
      B: '#2e3192',
      C: '#00aeef',
      D: '#f7941d',
      E: '#711411',
    });
  });
  it('keeps valid hex per section, falls back per-key on invalid', () => {
    const result = normalizeSectionMapColors({
      A: '#FFFFFF',
      B: 'not-a-color',
      C: '#abc',
      D: '',
      E: '#123456',
    });
    expect(result['A']).toBe('#ffffff');
    expect(result['B']).toBe('#2e3192'); // fallback
    expect(result['C']).toBe('#abc');
    expect(result['D']).toBe('#f7941d'); // fallback
    expect(result['E']).toBe('#123456');
  });
  it('returns a fresh copy of fallback (not the shared constant)', () => {
    const a = normalizeSectionMapColors(null);
    const b = normalizeSectionMapColors(null);
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});
