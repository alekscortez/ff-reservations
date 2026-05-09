// Pure utility helpers extracted from reservations-new.ts (the
// ~2k-line component). Slice 1 of the frontend monolith split, mirroring
// the backend services-reservations-shared.mjs extraction.
//
// Everything here is a pure function: no Angular imports, no `this`
// binding, no DI. Each one is unit-testable in isolation.
//
// Component callers
// - Some of these (isThisWeek, formatEventDate, todayString) are bound
//   to the template, so the component re-exports them as 1-line
//   delegating members. Private helpers are imported and called
//   directly.

const PHONE_DIGITS_REGEX = /\D/g;

export function normalizePhone(value: string | null | undefined): string {
  return String(value ?? '').replace(PHONE_DIGITS_REGEX, '');
}

export function phonesMatch(
  storedPhone: string | null | undefined,
  enteredDigits: string
): boolean {
  const stored = normalizePhone(storedPhone);
  if (!stored || !enteredDigits) return false;
  if (stored === enteredDigits) return true;
  if (enteredDigits.length === 10) {
    if (stored === `1${enteredDigits}`) return true;
    if (stored === `52${enteredDigits}`) return true;
    if (stored === `521${enteredDigits}`) return true;
  }
  return false;
}

export function formatCreditExpiry(value: string | null | undefined): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const date = new Date(`${raw}T00:00:00`);
  if (Number.isNaN(date.getTime())) return raw;
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function nextDate(date: string): string {
  const parts = date.split('-').map((part) => Number(part));
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) {
    return date;
  }
  const [year, month, day] = parts;
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCDate(d.getUTCDate() + 1);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

const DEADLINE_LOCAL_ISO_REGEX = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

export function normalizeDeadlineLocalIso(value: string): string | null {
  const raw = String(value ?? '').trim();
  const match = raw.match(DEADLINE_LOCAL_ISO_REGEX);
  if (!match) return null;
  const [, ymd, hh, mm, ss] = match;
  return `${ymd}T${hh}:${mm}:${ss ?? '00'}`;
}

export function nowInTimeZoneLocalIso(tz: string): string | null {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date());
    const get = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((p) => p.type === type)?.value ?? '';
    const yyyy = get('year');
    const mm = get('month');
    const dd = get('day');
    const hh = get('hour');
    const min = get('minute');
    const sec = get('second');
    if (!yyyy || !mm || !dd || !hh || !min || !sec) return null;
    return `${yyyy}-${mm}-${dd}T${hh}:${min}:${sec}`;
  } catch {
    return null;
  }
}

export function isFutureDeadline(deadlineAt: string, tz: string): boolean {
  const normalizedDeadline = normalizeDeadlineLocalIso(deadlineAt);
  if (!normalizedDeadline) return false;
  const nowIso = nowInTimeZoneLocalIso(tz || 'America/Chicago');
  if (!nowIso) return false;
  return normalizedDeadline > nowIso;
}

export function normalizePollingSeconds(
  value: number | null | undefined,
  fallback: number
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(120, Math.max(5, Math.round(parsed)));
}

export function normalizeHour(value: number | null | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(23, Math.max(0, Math.round(parsed)));
}

export function normalizeMinute(value: number | null | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(59, Math.max(0, Math.round(parsed)));
}

export function formatHm(hour: number, minute: number): string {
  return `${String(normalizeHour(hour, 0)).padStart(2, '0')}:${String(
    normalizeMinute(minute, 0)
  ).padStart(2, '0')}`;
}

export function isThisWeek(eventDate: string | undefined): boolean {
  if (!eventDate) return false;
  const date = new Date(`${eventDate}T00:00:00`);
  if (Number.isNaN(date.getTime())) return false;
  const today = new Date();
  // Monday-start week (matches the original component's day = (getDay()+6)%7)
  const day = (today.getDay() + 6) % 7;
  const start = new Date(today);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - day);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  return date >= start && date <= end;
}

export function formatEventDate(eventDate: string | undefined): string {
  if (!eventDate) return '—';
  const date = new Date(`${eventDate}T00:00:00`);
  if (Number.isNaN(date.getTime())) return eventDate;
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

export function todayString(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

const SECTION_COLOR_FALLBACK = {
  A: '#ec008c',
  B: '#2e3192',
  C: '#00aeef',
  D: '#f7941d',
  E: '#711411',
} as const;

const HEX_COLOR_REGEX = /^#(?:[A-Fa-f0-9]{3}|[A-Fa-f0-9]{6})$/;

export function normalizeSectionMapColors(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object') return { ...SECTION_COLOR_FALLBACK };
  const isHexColor = (value: unknown): value is string =>
    HEX_COLOR_REGEX.test(String(value ?? '').trim());
  const value = raw as Record<string, unknown>;
  return {
    A: isHexColor(value['A']) ? String(value['A']).toLowerCase() : SECTION_COLOR_FALLBACK.A,
    B: isHexColor(value['B']) ? String(value['B']).toLowerCase() : SECTION_COLOR_FALLBACK.B,
    C: isHexColor(value['C']) ? String(value['C']).toLowerCase() : SECTION_COLOR_FALLBACK.C,
    D: isHexColor(value['D']) ? String(value['D']).toLowerCase() : SECTION_COLOR_FALLBACK.D,
    E: isHexColor(value['E']) ? String(value['E']).toLowerCase() : SECTION_COLOR_FALLBACK.E,
  };
}
