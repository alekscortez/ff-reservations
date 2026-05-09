// Convert a "local-ISO" timestamp + IANA tz to an epoch in milliseconds.
//
// Inputs from the API are shaped like { paymentDeadlineAt: '2026-05-10T22:00:00',
// paymentDeadlineTz: 'America/Chicago' }. The browser's Date.parse interprets
// that string in the *user's* local zone, which is wrong whenever the staff
// member is browsing from a non-CST machine. This util fixes that by binary-
// searching the UTC ms whose Intl.DateTimeFormat representation in `tz`
// matches the wall-clock components we were given.

const LOCAL_ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

export function localIsoInTimeZoneToEpochMs(
  localIso: string | null | undefined,
  tz: string | null | undefined
): number | null {
  const raw = String(localIso ?? '').trim();
  const match = raw.match(LOCAL_ISO_RE);
  if (!match) return null;
  const [, yyyy, mm, dd, hh, min, sec] = match;
  const desired = {
    year: Number(yyyy),
    month: Number(mm),
    day: Number(dd),
    hour: Number(hh),
    minute: Number(min),
    second: Number(sec ?? '0'),
  };
  for (const v of Object.values(desired)) {
    if (!Number.isFinite(v)) return null;
  }

  const zone = String(tz ?? '').trim();
  if (!zone) {
    // Fall back to interpreting the wall-clock as UTC. Better than the user's
    // browser-local zone, which is what Date.parse(localIso) would do.
    return Date.UTC(
      desired.year,
      desired.month - 1,
      desired.day,
      desired.hour,
      desired.minute,
      desired.second
    );
  }

  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
  } catch {
    return null;
  }

  const desiredAsUtcMs = Date.UTC(
    desired.year,
    desired.month - 1,
    desired.day,
    desired.hour,
    desired.minute,
    desired.second
  );

  let guessMs = desiredAsUtcMs;
  for (let i = 0; i < 4; i += 1) {
    const parts = formatter.formatToParts(new Date(guessMs));
    const get = (type: Intl.DateTimeFormatPartTypes): number =>
      Number(parts.find((p) => p.type === type)?.value ?? NaN);
    const actualAsUtcMs = Date.UTC(
      get('year'),
      get('month') - 1,
      get('day'),
      get('hour'),
      get('minute'),
      get('second')
    );
    if (!Number.isFinite(actualAsUtcMs)) return null;
    const diff = desiredAsUtcMs - actualAsUtcMs;
    guessMs += diff;
    if (diff === 0) break;
  }

  return Number.isFinite(guessMs) ? guessMs : null;
}
