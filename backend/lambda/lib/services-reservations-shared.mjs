// Shared helpers for the reservations/holds domain. Carved out of
// services-reservations-holds.mjs (~2.6k lines → ~2.0k after this lift).
// Every function here is closure-free of the per-call lifecycle:
// - Pure utilities (clampNumber, time math, history sanitizers)
// - Settings resolvers (read-only, hit getAppSettings dep)
// - History writes + check-in pass orchestration
// - Read-only DDB queries (queryReservationsForEventDate, getReservationById)
// - Domain predicates (isOverdueReservation, isFrequentAutoReservation)
//
// Mutating operations (createHold/createReservation/addReservationPayment/
// cancelReservation/etc.) stay in services-reservations-holds.mjs for now.
// A follow-up PR can split those into services-holds.mjs,
// services-payment-recording.mjs, and services-reservations.mjs.
//
// Public contract: import {createReservationsShared} from this module,
// pass the same deps bag, then destructure helpers locally so existing
// call sites don't need updating.

import {
  GetCommand,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { roundToCents } from "./core-utils.mjs";

export const AUTO_RELEASE_REASON =
  "Payment deadline passed - table auto released";
export const DEFAULT_DEADLINE_TZ = "America/Chicago";
export const DEFAULT_DEADLINE_HOUR = 0;
export const DEFAULT_DEADLINE_MINUTE = 0;
export const DEFAULT_RESCHEDULE_CREDIT_TTL_DAYS = 30;
export const DEFAULT_RESCHEDULE_CUTOFF_HOUR = 22;
export const DEFAULT_RESCHEDULE_CUTOFF_MINUTE = 0;
export const DEFAULT_AUTO_RELEASE_USER = "system:auto-release";
export const DEFAULT_PAYMENT_LINK_TTL_MINUTES = 10;
export const DEFAULT_FREQUENT_PAYMENT_LINK_TTL_MINUTES = 1440;
export const DEFAULT_HOLD_TTL_SECONDS = 300;
// Allow a small grace window when converting an expiring hold. Covers the
// UX papercut where a user clicks "Confirm reservation" within ~1-2 seconds
// of their hold expiring. Audit M7. (Same hold owner only — if someone
// else placed a new hold meanwhile, the holdId match still fails.)
export const HOLD_EXPIRY_GRACE_SECONDS = 5;

export function createReservationsShared({
  ddb,
  tableNames,
  requiredEnv,
  httpError,
  nowEpoch,
  randomUUID,
  ensureCheckInPassForReservation,
  sendCheckInPassSms,
  paymentLinkTtlMinutes,
  frequentPaymentLinkTtlMinutes,
  isFrequentReservationByPhoneAndTable,
  getAppSettings,
}) {
  const { RES_TABLE } = tableNames;

  function clampNumber(value, min, max, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    const rounded = Math.round(parsed);
    return Math.min(max, Math.max(min, rounded));
  }

  function roundMoney(value) {
    return roundToCents(value ?? 0);
  }

  async function getRuntimeSettings() {
    if (typeof getAppSettings !== "function") return null;
    try {
      return await getAppSettings();
    } catch (err) {
      console.warn("get_runtime_settings_failed", {
        message: String(err?.message ?? err ?? ""),
      });
      return null;
    }
  }

  function resolveHoldTtlSeconds(settings) {
    return clampNumber(
      settings?.holdTtlSeconds,
      60,
      1800,
      DEFAULT_HOLD_TTL_SECONDS
    );
  }

  function resolveDefaultPaymentDeadlineTz(settings) {
    const fromSettings = String(settings?.operatingTz ?? "").trim();
    return fromSettings || DEFAULT_DEADLINE_TZ;
  }

  function resolveDefaultPaymentDeadlineHour(settings) {
    return clampNumber(
      settings?.defaultPaymentDeadlineHour,
      0,
      23,
      DEFAULT_DEADLINE_HOUR
    );
  }

  function resolveDefaultPaymentDeadlineMinute(settings) {
    return clampNumber(
      settings?.defaultPaymentDeadlineMinute,
      0,
      59,
      DEFAULT_DEADLINE_MINUTE
    );
  }

  function resolveRescheduleCutoffHour(settings) {
    return clampNumber(
      settings?.rescheduleCutoffHour,
      0,
      23,
      DEFAULT_RESCHEDULE_CUTOFF_HOUR
    );
  }

  function resolveRescheduleCutoffMinute(settings) {
    return clampNumber(
      settings?.rescheduleCutoffMinute,
      0,
      59,
      DEFAULT_RESCHEDULE_CUTOFF_MINUTE
    );
  }

  function resolveCashReceiptNumberRequired(settings) {
    if (typeof settings?.cashReceiptNumberRequired === "boolean") {
      return settings.cashReceiptNumberRequired;
    }
    return true;
  }

  function toTwelveHourLabel(hour24, minute) {
    const hh = Number(hour24);
    const mm = Number(minute);
    const period = hh >= 12 ? "PM" : "AM";
    const hour12 = hh % 12 || 12;
    return `${hour12}:${String(mm).padStart(2, "0")} ${period}`;
  }

  function toRescheduleCreditSk(phoneKey, creditId) {
    return `CREDIT#PHONE#${phoneKey}#${creditId}`;
  }

  function sanitizeHistoryValue(value) {
    if (value === null) return null;
    const valueType = typeof value;
    if (valueType === "string" || valueType === "number" || valueType === "boolean") {
      return value;
    }
    if (Array.isArray(value)) {
      return value
        .map((item) => sanitizeHistoryValue(item))
        .filter((item) => item !== undefined);
    }
    if (valueType === "object") {
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        const cleaned = sanitizeHistoryValue(v);
        if (cleaned !== undefined) out[k] = cleaned;
      }
      return out;
    }
    return undefined;
  }

  function toHistorySk(reservationId, at, eventId) {
    const ts = String(Number(at ?? 0) || 0).padStart(12, "0");
    return `HIST#${reservationId}#${ts}#${eventId}`;
  }

  async function appendReservationHistory({
    eventDate,
    reservationId,
    eventType,
    actor,
    source = null,
    tableId = null,
    customerName = null,
    details = null,
    at = null,
  }) {
    try {
      requiredEnv("RES_TABLE", RES_TABLE);
      const normalizedEventDate = String(eventDate ?? "").trim();
      const normalizedReservationId = String(reservationId ?? "").trim();
      const normalizedEventType = String(eventType ?? "").trim().toUpperCase();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedEventDate)) return;
      if (!normalizedReservationId || !normalizedEventType) return;
      const eventAt = Number(at ?? 0) || nowEpoch();
      const eventId = randomUUID();
      await ddb.send(
        new PutCommand({
          TableName: RES_TABLE,
          Item: {
            PK: `EVENTDATE#${normalizedEventDate}`,
            SK: toHistorySk(normalizedReservationId, eventAt, eventId),
            entityType: "RESERVATION_HISTORY",
            eventId,
            eventType: normalizedEventType,
            reservationId: normalizedReservationId,
            eventDate: normalizedEventDate,
            tableId: String(tableId ?? "").trim() || null,
            customerName: String(customerName ?? "").trim() || null,
            actor: String(actor ?? "").trim() || "system",
            source: String(source ?? "").trim() || null,
            at: eventAt,
            details: sanitizeHistoryValue(details ?? null),
          },
        })
      );
    } catch (err) {
      console.error("reservation_history_write_error", {
        reservationId: String(reservationId ?? "").trim() || null,
        eventDate: String(eventDate ?? "").trim() || null,
        eventType: String(eventType ?? "").trim() || null,
        message: String(err?.message ?? err ?? ""),
        errorName: err?.name ?? null,
      });
    }
  }

  async function tryEnsureCheckInPass(reservation, user) {
    if (typeof ensureCheckInPassForReservation !== "function") return null;
    if (!reservation) return null;
    if (String(reservation?.status ?? "").toUpperCase() !== "CONFIRMED") return null;
    if (String(reservation?.paymentStatus ?? "").toUpperCase() !== "PAID") return null;
    try {
      return await ensureCheckInPassForReservation({
        reservation,
        issuedBy: user,
        reissue: false,
      });
    } catch (err) {
      console.error("Check-in pass issuance failed", {
        reservationId: String(reservation?.reservationId ?? "").trim() || null,
        eventDate: String(reservation?.eventDate ?? "").trim() || null,
        message: String(err?.message ?? err ?? ""),
      });
      return null;
    }
  }

  function historySourceFromActor(actor) {
    const value = String(actor ?? "");
    if (value.startsWith("system:")) return "system";
    if (value.startsWith("customer:")) return "customer";
    return "staff";
  }

  async function trySendCheckInPassSms(reservation, passResult, actor) {
    if (typeof sendCheckInPassSms !== "function") return null;
    if (!reservation || !passResult || passResult.issued !== true) return null;

    const pass = passResult?.pass ?? null;
    const passUrl = String(pass?.url ?? "").trim();
    const reservationId = String(reservation?.reservationId ?? "").trim();
    const eventDate = String(reservation?.eventDate ?? "").trim();
    const tableId = String(reservation?.tableId ?? "").trim() || null;
    const customerName = String(reservation?.customerName ?? "").trim() || null;
    if (!passUrl || !reservationId || !/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) return null;

    const phone = String(reservation?.phone ?? "").trim();
    try {
      const sms = await sendCheckInPassSms({
        phone,
        customerName,
        eventDate,
        tableId,
        passUrl,
      });
      await appendReservationHistory({
        eventDate,
        reservationId,
        eventType: "CHECKIN_PASS_SMS_SENT",
        actor,
        source: historySourceFromActor(actor),
        tableId,
        customerName,
        details: {
          passId: String(pass?.passId ?? "").trim() || null,
          to: String(sms?.to ?? phone).trim() || null,
          messageId: String(sms?.messageId ?? "").trim() || null,
          provider: String(sms?.provider ?? "").trim() || null,
        },
      });
      return sms;
    } catch (err) {
      const errorMessage = String(err?.message ?? "Failed to send check-in pass SMS");
      await appendReservationHistory({
        eventDate,
        reservationId,
        eventType: "CHECKIN_PASS_SMS_FAILED",
        actor,
        source: historySourceFromActor(actor),
        tableId,
        customerName,
        details: {
          passId: String(pass?.passId ?? "").trim() || null,
          to: phone || null,
          errorMessage,
        },
      });
      console.warn("checkin_pass_sms_failed", {
        reservationId,
        eventDate,
        tableId,
        message: errorMessage,
      });
      return null;
    }
  }

  function normalizeDeadlineLocalIso(deadlineAt) {
    const raw = String(deadlineAt ?? "").trim();
    const match = raw.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (!match) return null;
    const [, ymd, hh, mm, ss] = match;
    return `${ymd}T${hh}:${mm}:${ss ?? "00"}`;
  }

  function nowInTimeZoneLocalIso(tz) {
    try {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      }).formatToParts(new Date());
      const get = (type) => parts.find((p) => p.type === type)?.value ?? "";
      const yyyy = get("year");
      const mm = get("month");
      const dd = get("day");
      const hh = get("hour");
      const min = get("minute");
      const sec = get("second");
      if (!yyyy || !mm || !dd || !hh || !min || !sec) return null;
      return `${yyyy}-${mm}-${dd}T${hh}:${min}:${sec}`;
    } catch {
      return null;
    }
  }

  function addMinutesToLocalIso(localIso, minutes) {
    const match = String(localIso ?? "")
      .trim()
      .match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/);
    if (!match) return null;
    const [, yyyy, mm, dd, hh, min, sec] = match;
    const date = new Date(
      Date.UTC(
        Number(yyyy),
        Number(mm) - 1,
        Number(dd),
        Number(hh),
        Number(min),
        Number(sec)
      )
    );
    date.setUTCMinutes(date.getUTCMinutes() + Number(minutes || 0));
    const outY = String(date.getUTCFullYear()).padStart(4, "0");
    const outM = String(date.getUTCMonth() + 1).padStart(2, "0");
    const outD = String(date.getUTCDate()).padStart(2, "0");
    const outH = String(date.getUTCHours()).padStart(2, "0");
    const outMin = String(date.getUTCMinutes()).padStart(2, "0");
    const outS = String(date.getUTCSeconds()).padStart(2, "0");
    return `${outY}-${outM}-${outD}T${outH}:${outMin}:${outS}`;
  }

  function localIsoToEpochSeconds(localIso, tz) {
    const match = String(localIso ?? "")
      .trim()
      .match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/);
    if (!match) return null;
    const [, yyyy, mm, dd, hh, min, sec] = match;
    const desired = {
      year: Number(yyyy),
      month: Number(mm),
      day: Number(dd),
      hour: Number(hh),
      minute: Number(min),
      second: Number(sec),
    };
    if (
      !Number.isFinite(desired.year) ||
      !Number.isFinite(desired.month) ||
      !Number.isFinite(desired.day) ||
      !Number.isFinite(desired.hour) ||
      !Number.isFinite(desired.minute) ||
      !Number.isFinite(desired.second)
    ) {
      return null;
    }

    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });

    const partsAt = (ms) => {
      const parts = formatter.formatToParts(new Date(ms));
      const get = (type) => Number(parts.find((p) => p.type === type)?.value ?? NaN);
      return {
        year: get("year"),
        month: get("month"),
        day: get("day"),
        hour: get("hour"),
        minute: get("minute"),
        second: get("second"),
      };
    };

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
      const actual = partsAt(guessMs);
      const actualAsUtcMs = Date.UTC(
        actual.year,
        actual.month - 1,
        actual.day,
        actual.hour,
        actual.minute,
        actual.second
      );
      const diffMs = desiredAsUtcMs - actualAsUtcMs;
      guessMs += diffMs;
      if (diffMs === 0) break;
    }

    const out = Math.floor(guessMs / 1000);
    return Number.isFinite(out) ? out : null;
  }

  function isFrequentAutoReservation(reservation) {
    const source = String(reservation?.reservationSource ?? "").trim().toUpperCase();
    if (source === "FREQUENT_AUTO") return true;
    const frequentClientId = String(reservation?.frequentClientId ?? "").trim();
    return Boolean(frequentClientId);
  }

  function resolvePaymentLinkTtlMinutes(settings, isFrequentReservation) {
    if (isFrequentReservation) {
      const fromSettings = clampNumber(
        settings?.frequentPaymentLinkTtlMinutes,
        10,
        10080,
        NaN
      );
      if (Number.isFinite(fromSettings)) return fromSettings;
      const parsedFrequent = Number(frequentPaymentLinkTtlMinutes);
      if (Number.isFinite(parsedFrequent)) {
        return Math.min(10080, Math.max(10, Math.round(parsedFrequent)));
      }
      return DEFAULT_FREQUENT_PAYMENT_LINK_TTL_MINUTES;
    }

    const fromSettings = clampNumber(settings?.paymentLinkTtlMinutes, 1, 120, NaN);
    if (Number.isFinite(fromSettings)) return fromSettings;
    const parsed = Number(paymentLinkTtlMinutes);
    if (!Number.isFinite(parsed)) return DEFAULT_PAYMENT_LINK_TTL_MINUTES;
    const rounded = Math.round(parsed);
    return Math.min(120, Math.max(1, rounded));
  }

  async function shouldUseFrequentPaymentLinkTtl(reservation) {
    if (isFrequentAutoReservation(reservation)) return true;
    if (typeof isFrequentReservationByPhoneAndTable !== "function") return false;
    try {
      return await isFrequentReservationByPhoneAndTable({
        phone: reservation?.phone,
        phoneCountry: reservation?.phoneCountry,
        tableId: reservation?.tableId,
      });
    } catch (err) {
      console.warn("frequent_reservation_detection_failed", {
        reservationId: String(reservation?.reservationId ?? "").trim() || null,
        eventDate: String(reservation?.eventDate ?? "").trim() || null,
        message: String(err?.message ?? err ?? ""),
      });
      return false;
    }
  }

  function isOverdueReservation(reservation) {
    if (String(reservation?.status ?? "").toUpperCase() !== "CONFIRMED") return false;
    const paymentStatus = String(reservation?.paymentStatus ?? "").toUpperCase();
    if (paymentStatus !== "PENDING" && paymentStatus !== "PARTIAL") return false;
    const deadlineIso = normalizeDeadlineLocalIso(reservation?.paymentDeadlineAt);
    if (!deadlineIso) return false;
    const tz =
      String(reservation?.paymentDeadlineTz ?? DEFAULT_DEADLINE_TZ).trim() ||
      DEFAULT_DEADLINE_TZ;
    const nowIso = nowInTimeZoneLocalIso(tz);
    if (!nowIso) return false;
    return deadlineIso <= nowIso;
  }

  async function queryReservationsForEventDate(eventDate) {
    requiredEnv("RES_TABLE", RES_TABLE);
    const res = await ddb.send(
      new QueryCommand({
        TableName: RES_TABLE,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeValues: {
          ":pk": `EVENTDATE#${eventDate}`,
          ":sk": "RES#",
        },
      })
    );
    return res.Items ?? [];
  }

  async function getReservationById(eventDate, reservationId) {
    requiredEnv("RES_TABLE", RES_TABLE);
    const normalizedEventDate = String(eventDate ?? "").trim();
    const normalizedReservationId = String(reservationId ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedEventDate)) {
      throw httpError(400, "eventDate must be YYYY-MM-DD");
    }
    if (!normalizedReservationId) {
      throw httpError(400, "reservationId is required");
    }

    const res = await ddb.send(
      new GetCommand({
        TableName: RES_TABLE,
        Key: {
          PK: `EVENTDATE#${normalizedEventDate}`,
          SK: `RES#${normalizedReservationId}`,
        },
      })
    );
    if (!res.Item) {
      throw httpError(404, "Reservation not found");
    }
    return res.Item;
  }

  return {
    // pure utilities
    clampNumber,
    roundMoney,
    toTwelveHourLabel,
    toRescheduleCreditSk,
    sanitizeHistoryValue,
    toHistorySk,
    historySourceFromActor,
    normalizeDeadlineLocalIso,
    nowInTimeZoneLocalIso,
    addMinutesToLocalIso,
    localIsoToEpochSeconds,
    isFrequentAutoReservation,
    isOverdueReservation,
    // settings resolvers
    getRuntimeSettings,
    resolveHoldTtlSeconds,
    resolveDefaultPaymentDeadlineTz,
    resolveDefaultPaymentDeadlineHour,
    resolveDefaultPaymentDeadlineMinute,
    resolveRescheduleCutoffHour,
    resolveRescheduleCutoffMinute,
    resolveCashReceiptNumberRequired,
    resolvePaymentLinkTtlMinutes,
    shouldUseFrequentPaymentLinkTtl,
    // history + check-in pass orchestration
    appendReservationHistory,
    tryEnsureCheckInPass,
    trySendCheckInPassSms,
    // read-only DDB
    queryReservationsForEventDate,
    getReservationById,
  };
}
