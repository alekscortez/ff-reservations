import {
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import { normalizePhoneE164 } from "./core-utils.mjs";

const SETTINGS_PK = "APP";
const SETTINGS_SK = "CONFIG";
const CACHE_TTL_MS = 30_000;
const SECTION_KEYS = ["A", "B", "C", "D", "E"];
export const DEFAULT_SECTION_MAP_COLORS = Object.freeze({
  A: "#ec008c",
  B: "#2e3192",
  C: "#00aeef",
  D: "#f7941d",
  E: "#711411",
});

export function parseBoolean(value, fallback) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (!normalized) return fallback;
    if (["true", "1", "yes", "on", "enabled"].includes(normalized)) return true;
    if (["false", "0", "no", "off", "disabled"].includes(normalized)) return false;
  }
  return fallback;
}

export function parseInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.round(parsed);
}

export function clampInteger(value, min, max, fallback) {
  const parsed = parseInteger(value, fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function isValidTimeZone(timeZone) {
  const raw = String(timeZone ?? "").trim();
  if (!raw) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: raw }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function normalizeIsoDate(value) {
  const raw = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  return raw;
}

export function isHexColor(value) {
  return /^#(?:[A-Fa-f0-9]{3}|[A-Fa-f0-9]{6})$/.test(String(value ?? "").trim());
}

export function normalizeSectionMapColors(value, fallback) {
  const base = {
    ...DEFAULT_SECTION_MAP_COLORS,
    ...(fallback && typeof fallback === "object" ? fallback : {}),
  };
  if (value == null) return base;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("sectionMapColors must be an object");
  }
  const out = { ...base };
  for (const key of SECTION_KEYS) {
    if (!(key in value)) continue;
    const candidate = String(value[key] ?? "").trim();
    if (!candidate) {
      out[key] = base[key];
      continue;
    }
    if (!isHexColor(candidate)) {
      throw new Error(`sectionMapColors.${key} must be HEX like #RRGGBB`);
    }
    out[key] = candidate.toLowerCase();
  }
  return out;
}

export function subtractOneIsoDay(isoDate) {
  const normalized = normalizeIsoDate(isoDate);
  if (!normalized) return isoDate;
  const [yyyy, mm, dd] = normalized.split("-").map((part) => Number(part));
  const date = new Date(Date.UTC(yyyy, mm - 1, dd));
  date.setUTCDate(date.getUTCDate() - 1);
  const outY = String(date.getUTCFullYear()).padStart(4, "0");
  const outM = String(date.getUTCMonth() + 1).padStart(2, "0");
  const outD = String(date.getUTCDate()).padStart(2, "0");
  return `${outY}-${outM}-${outD}`;
}

export function localPartsForZone(nowMs, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(nowMs));
  const get = (type) => parts.find((p) => p.type === type)?.value ?? "";
  const year = get("year");
  const month = get("month");
  const day = get("day");
  const hour = get("hour");
  const minute = get("minute");
  const second = get("second");
  if (!year || !month || !day || !hour || !minute || !second) {
    return null;
  }
  return {
    isoDate: `${year}-${month}-${day}`,
    hour: Number(hour),
    minute: Number(minute),
    second: Number(second),
  };
}

export function buildDefaults(env) {
  const operatingTzCandidate = String(env?.OPERATING_TZ ?? "").trim();
  const operatingTz = isValidTimeZone(operatingTzCandidate)
    ? operatingTzCandidate
    : "America/Chicago";

  const squareEnv = String(env?.SQUARE_ENV ?? "sandbox").trim().toLowerCase();
  const squareEnvMode = squareEnv === "production" ? "production" : "sandbox";
  const squareApplicationId = String(env?.SQUARE_APPLICATION_ID ?? "").trim();
  const squareLocationId = String(env?.SQUARE_LOCATION_ID ?? "").trim();

  return {
    operatingTz,
    operatingDayCutoffHour: clampInteger(env?.OPERATING_DAY_CUTOFF_HOUR, 0, 23, 5),
    holdTtlSeconds: clampInteger(env?.HOLD_TTL_SECONDS, 60, 1800, 300),
    cashReceiptNumberRequired: parseBoolean(env?.CASH_RECEIPT_NUMBER_REQUIRED, true),
    paymentLinkTtlMinutes: clampInteger(env?.PAYMENT_LINK_TTL_MINUTES, 1, 120, 10),
    frequentPaymentLinkTtlMinutes: clampInteger(
      env?.FREQUENT_PAYMENT_LINK_TTL_MINUTES,
      10,
      10080,
      1440
    ),
    autoSendSquareLinkSms: parseBoolean(env?.AUTO_SEND_SQUARE_LINK_SMS, false),
    smsEnabled: parseBoolean(env?.SMS_ENABLED, true),
    defaultPaymentDeadlineHour: clampInteger(env?.DEFAULT_PAYMENT_DEADLINE_HOUR, 0, 23, 0),
    defaultPaymentDeadlineMinute: clampInteger(
      env?.DEFAULT_PAYMENT_DEADLINE_MINUTE,
      0,
      59,
      0
    ),
    rescheduleCutoffHour: clampInteger(env?.RESCHEDULE_CUTOFF_HOUR, 0, 23, 22),
    rescheduleCutoffMinute: clampInteger(
      env?.RESCHEDULE_CUTOFF_MINUTE,
      0,
      59,
      0
    ),
    allowPastEventEdits: parseBoolean(env?.ALLOW_PAST_EVENT_EDITS, false),
    allowPastEventPayments: parseBoolean(env?.ALLOW_PAST_EVENT_PAYMENTS, false),
    dashboardPollingSeconds: clampInteger(env?.DASHBOARD_POLLING_SECONDS, 5, 120, 15),
    tableAvailabilityPollingSeconds: clampInteger(
      env?.TABLE_AVAILABILITY_POLLING_SECONDS,
      5,
      120,
      10
    ),
    clientAvailabilityPollingSeconds: clampInteger(
      env?.CLIENT_AVAILABILITY_POLLING_SECONDS,
      5,
      120,
      15
    ),
    urgentPaymentWindowMinutes: clampInteger(
      env?.URGENT_PAYMENT_WINDOW_MINUTES,
      5,
      1440,
      360
    ),
    checkInPassTtlDays: clampInteger(env?.CHECKIN_PASS_TTL_DAYS, 1, 30, 2),
    checkInPassBaseUrl: String(env?.CHECKIN_PASS_BASE_URL ?? "").trim(),
    showClientFacingMap: parseBoolean(env?.SHOW_CLIENT_FACING_MAP, false),
    customerContactPhoneE164: normalizePhoneE164(
      env?.CUSTOMER_CONTACT_PHONE_E164,
      "US"
    ),
    allowAnonymousPublicBooking: parseBoolean(
      env?.ALLOW_ANONYMOUS_PUBLIC_BOOKING,
      false
    ),
    anonymousHoldTtlSeconds: clampInteger(
      env?.ANONYMOUS_HOLD_TTL_SECONDS,
      300,
      1800,
      600
    ),
    anonymousMaxTablesPerBooking: clampInteger(
      env?.ANONYMOUS_MAX_TABLES_PER_BOOKING,
      1,
      10,
      4
    ),
    turnstileSiteKey: String(env?.TURNSTILE_SITE_KEY ?? "").trim(),
    auditVerboseLogging: parseBoolean(env?.AUDIT_VERBOSE_LOGGING, false),
    squareEnvMode,
    squareApplicationId,
    squareLocationId,
    sectionMapColors: normalizeSectionMapColors(
      {
        A: env?.SECTION_COLOR_A,
        B: env?.SECTION_COLOR_B,
        C: env?.SECTION_COLOR_C,
        D: env?.SECTION_COLOR_D,
        E: env?.SECTION_COLOR_E,
      },
      DEFAULT_SECTION_MAP_COLORS
    ),
  };
}

const KNOWN_KEYS = new Set(Object.keys(buildDefaults({})));

export function normalizeValueForKey(key, value, fallback) {
  switch (key) {
    case "operatingTz": {
      const candidate = String(value ?? "").trim();
      if (!candidate) return fallback;
      if (!isValidTimeZone(candidate)) throw new Error("operatingTz must be a valid IANA timezone");
      return candidate;
    }
    case "operatingDayCutoffHour":
      return clampInteger(value, 0, 23, fallback);
    case "holdTtlSeconds":
      return clampInteger(value, 60, 1800, fallback);
    case "paymentLinkTtlMinutes":
      return clampInteger(value, 1, 120, fallback);
    case "frequentPaymentLinkTtlMinutes":
      return clampInteger(value, 10, 10080, fallback);
    case "autoSendSquareLinkSms":
    case "smsEnabled":
    case "cashReceiptNumberRequired":
    case "allowPastEventEdits":
    case "allowPastEventPayments":
    case "showClientFacingMap":
    case "allowAnonymousPublicBooking":
    case "auditVerboseLogging":
      return parseBoolean(value, fallback);
    case "defaultPaymentDeadlineHour":
      return clampInteger(value, 0, 23, fallback);
    case "defaultPaymentDeadlineMinute":
      return clampInteger(value, 0, 59, fallback);
    case "rescheduleCutoffHour":
      return clampInteger(value, 0, 23, fallback);
    case "rescheduleCutoffMinute":
      return clampInteger(value, 0, 59, fallback);
    case "dashboardPollingSeconds":
    case "tableAvailabilityPollingSeconds":
    case "clientAvailabilityPollingSeconds":
      return clampInteger(value, 5, 120, fallback);
    case "urgentPaymentWindowMinutes":
      return clampInteger(value, 5, 1440, fallback);
    case "checkInPassTtlDays":
      return clampInteger(value, 1, 30, fallback);
    case "checkInPassBaseUrl":
      return String(value ?? "").trim();
    case "customerContactPhoneE164": {
      const raw = String(value ?? "").trim();
      if (!raw) return "";
      const normalized = normalizePhoneE164(raw, "US");
      if (!normalized) {
        throw new Error(
          "customerContactPhoneE164 must be an E.164 phone number"
        );
      }
      return normalized;
    }
    case "anonymousHoldTtlSeconds":
      return clampInteger(value, 300, 1800, fallback);
    case "anonymousMaxTablesPerBooking":
      return clampInteger(value, 1, 10, fallback);
    case "turnstileSiteKey":
      return String(value ?? "").trim();
    case "squareEnvMode": {
      // Always env-managed; do not allow persisted settings to override.
      return fallback;
    }
    case "squareApplicationId":
    case "squareLocationId":
      // Always env-managed; do not allow persisted settings to override.
      return fallback;
    case "sectionMapColors":
      return normalizeSectionMapColors(value, fallback);
    default:
      return fallback;
  }
}

export function normalizePatch(current, patch, { strictUnknown }) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new Error("Settings payload must be an object");
  }
  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (!KNOWN_KEYS.has(key)) {
      if (strictUnknown) throw new Error(`Unknown setting key: ${key}`);
      continue;
    }
    next[key] = normalizeValueForKey(key, value, current[key]);
  }
  return next;
}

export function createSettingsService({
  ddb,
  tableNames,
  env,
  nowEpoch,
  httpError,
}) {
  const tableName = String(tableNames?.SETTINGS_TABLE ?? "").trim();
  const defaults = buildDefaults(env ?? {});

  let cache = {
    expiresAtMs: 0,
    value: defaults,
  };

  async function loadStoredSettings() {
    if (!tableName) return null;
    const out = await ddb.send(
      new GetCommand({
        TableName: tableName,
        Key: { PK: SETTINGS_PK, SK: SETTINGS_SK },
      })
    );
    const item = out?.Item;
    if (!item) return null;
    if (item.settings && typeof item.settings === "object") return item.settings;
    return item;
  }

  async function getAppSettings(forceRefresh = false) {
    const nowMs = Date.now();
    if (!forceRefresh && cache.expiresAtMs > nowMs) {
      return cache.value;
    }

    let merged = { ...defaults };
    try {
      const stored = await loadStoredSettings();
      if (stored && typeof stored === "object") {
        merged = normalizePatch(merged, stored, { strictUnknown: false });
      }
    } catch (err) {
      console.warn("settings_load_failed_using_defaults", {
        message: String(err?.message ?? err ?? ""),
      });
    }

    cache = {
      expiresAtMs: nowMs + CACHE_TTL_MS,
      value: merged,
    };
    return merged;
  }

  async function updateAppSettings(patch, user) {
    if (!tableName) {
      throw httpError(500, "SETTINGS_TABLE is not configured");
    }
    let next;
    try {
      const current = await getAppSettings(true);
      next = normalizePatch(current, patch, { strictUnknown: true });
    } catch (err) {
      throw httpError(400, String(err?.message ?? "Invalid settings payload"));
    }

    const now = nowEpoch();
    await ddb.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          PK: SETTINGS_PK,
          SK: SETTINGS_SK,
          entityType: "APP_SETTINGS",
          settings: next,
          updatedAt: now,
          updatedBy: String(user ?? "").trim() || "system",
        },
      })
    );

    cache = {
      expiresAtMs: Date.now() + CACHE_TTL_MS,
      value: next,
    };

    return next;
  }

  async function resolveBusinessDate(nowMs = Date.now()) {
    const settings = await getAppSettings();
    const operatingTz = String(settings?.operatingTz ?? defaults.operatingTz).trim() || defaults.operatingTz;
    const cutoffHour = clampInteger(
      settings?.operatingDayCutoffHour,
      0,
      23,
      defaults.operatingDayCutoffHour
    );
    const local = localPartsForZone(nowMs, operatingTz);
    if (!local) {
      const fallbackDate = normalizeIsoDate(
        new Date(nowMs).toISOString().slice(0, 10)
      ) ?? "1970-01-01";
      return {
        businessDate: fallbackDate,
        operatingTz,
        cutoffHour,
      };
    }
    const businessDate =
      local.hour < cutoffHour ? subtractOneIsoDay(local.isoDate) : local.isoDate;
    return {
      businessDate,
      operatingTz,
      cutoffHour,
    };
  }

  function runtimeSettingsSubset(settings) {
    const value = settings ?? defaults;
    return {
      operatingTz: value.operatingTz,
      operatingDayCutoffHour: value.operatingDayCutoffHour,
      defaultPaymentDeadlineHour: value.defaultPaymentDeadlineHour,
      defaultPaymentDeadlineMinute: value.defaultPaymentDeadlineMinute,
      cashReceiptNumberRequired: value.cashReceiptNumberRequired,
      rescheduleCutoffHour: value.rescheduleCutoffHour,
      rescheduleCutoffMinute: value.rescheduleCutoffMinute,
      dashboardPollingSeconds: value.dashboardPollingSeconds,
      tableAvailabilityPollingSeconds: value.tableAvailabilityPollingSeconds,
      clientAvailabilityPollingSeconds: value.clientAvailabilityPollingSeconds,
      urgentPaymentWindowMinutes: value.urgentPaymentWindowMinutes,
      showClientFacingMap: value.showClientFacingMap,
      squareEnvMode: value.squareEnvMode,
      squareApplicationId: value.squareApplicationId,
      squareLocationId: value.squareLocationId,
      squareWebPaymentsEnabled:
        Boolean(String(value.squareApplicationId ?? "").trim()) &&
        Boolean(String(value.squareLocationId ?? "").trim()),
      sectionMapColors: normalizeSectionMapColors(
        value.sectionMapColors,
        defaults.sectionMapColors
      ),
    };
  }

  return {
    getAppSettings,
    updateAppSettings,
    resolveBusinessDate,
    runtimeSettingsSubset,
  };
}
