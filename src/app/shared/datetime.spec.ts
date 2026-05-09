import { localIsoInTimeZoneToEpochMs } from './datetime';

describe('localIsoInTimeZoneToEpochMs', () => {
  it('returns null for missing or malformed input', () => {
    expect(localIsoInTimeZoneToEpochMs(null, 'America/Chicago')).toBeNull();
    expect(localIsoInTimeZoneToEpochMs('', 'America/Chicago')).toBeNull();
    expect(localIsoInTimeZoneToEpochMs('not-a-date', 'America/Chicago')).toBeNull();
    expect(localIsoInTimeZoneToEpochMs('2026-13-40T00:00', 'America/Chicago')).not.toBeNull(); // JS normalizes
  });

  it('returns null for an unknown timezone', () => {
    expect(
      localIsoInTimeZoneToEpochMs('2026-05-09T22:00:00', 'Not/A_Real_Tz')
    ).toBeNull();
  });

  it('falls back to UTC interpretation when tz is empty', () => {
    const got = localIsoInTimeZoneToEpochMs('2026-05-09T22:00:00', '');
    expect(got).toBe(Date.UTC(2026, 4, 9, 22, 0, 0));
  });

  it('interprets the wall clock in the given zone (CST, no DST)', () => {
    // 2026-01-15 22:00 in America/Chicago = 2026-01-16 04:00 UTC (UTC-6)
    const got = localIsoInTimeZoneToEpochMs('2026-01-15T22:00:00', 'America/Chicago');
    expect(got).toBe(Date.UTC(2026, 0, 16, 4, 0, 0));
  });

  it('interprets the wall clock in the given zone (CDT, in DST)', () => {
    // 2026-07-15 22:00 in America/Chicago = 2026-07-16 03:00 UTC (UTC-5)
    const got = localIsoInTimeZoneToEpochMs('2026-07-15T22:00:00', 'America/Chicago');
    expect(got).toBe(Date.UTC(2026, 6, 16, 3, 0, 0));
  });

  it('handles the day after the spring-forward transition', () => {
    // 2026-03-09 02:00 Chicago is right after spring forward; UTC-5 effective
    const got = localIsoInTimeZoneToEpochMs('2026-03-09T02:00:00', 'America/Chicago');
    expect(got).toBe(Date.UTC(2026, 2, 9, 7, 0, 0));
  });

  it('handles the day after fall-back', () => {
    // 2026-11-02 02:00 Chicago is post-DST; UTC-6 effective
    const got = localIsoInTimeZoneToEpochMs('2026-11-02T02:00:00', 'America/Chicago');
    expect(got).toBe(Date.UTC(2026, 10, 2, 8, 0, 0));
  });

  it('accepts the optional :SS component', () => {
    const withSec = localIsoInTimeZoneToEpochMs('2026-05-09T22:00:30', 'America/Chicago');
    const noSec = localIsoInTimeZoneToEpochMs('2026-05-09T22:00:00', 'America/Chicago');
    expect(withSec).toBe(noSec! + 30_000);
  });

  it('produces a value that round-trips via Intl in the same zone', () => {
    const got = localIsoInTimeZoneToEpochMs('2026-08-01T15:30:00', 'America/Mexico_City');
    expect(got).not.toBeNull();
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Mexico_City',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(got!));
    const part = (t: Intl.DateTimeFormatPartTypes) =>
      parts.find((p) => p.type === t)?.value;
    expect(part('year')).toBe('2026');
    expect(part('month')).toBe('08');
    expect(part('day')).toBe('01');
    expect(part('hour')).toBe('15');
    expect(part('minute')).toBe('30');
    expect(part('second')).toBe('00');
  });
});
