// Anonymous public-booking helpers. Two responsibilities:
//
// 1. Per-phone "1 active unpaid hold" cap. Stored as a single registry row
//    in HOLDS_TABLE under (PK="RATE", SK="ANONHOLD#{phoneKey}"). This sits
//    in the same RATE partition as services-rate-limit.mjs uses for SMS +
//    customer-hold caps; different SK prefix so they don't collide.
//
//    Acquire is a conditional Put — fails 429 ACTIVE_HOLD_EXISTS if the
//    slot is already held by an unexpired entry. Releases happen on
//    payment-confirmed (webhook), explicit release, hold expiry sweep,
//    or any failure between acquire and reservation-create. The slot
//    always carries the same `expiresAt` as the underlying hold so a
//    crashed Lambda can't permanently lock a phone — the slot expires
//    on its own clock.
//
//    Why a registry instead of scanning ff-reservations: ff-reservations
//    has no phone GSI, only PK=EVENTDATE#... Scan for a hot-path 429
//    check would burn RCU + add latency. Registry is O(1).
//
// 2. Customer-token verification. Wraps safeStringEquals so route handlers
//    don't have to import core-utils directly. Returns boolean; caller
//    formats the 401 response.

import {
  DeleteCommand,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import { normalizePhone, safeStringEquals } from "./core-utils.mjs";

const RATE_PK = "RATE";
const ANON_HOLD_SK_PREFIX = "ANONHOLD#";

function phoneSlotKey(phoneE164) {
  const phoneKey = normalizePhone(phoneE164);
  if (!phoneKey) return null;
  return { PK: RATE_PK, SK: `${ANON_HOLD_SK_PREFIX}${phoneKey}` };
}

export function createAnonBookingsService({
  ddb,
  tableNames,
  nowEpoch,
  httpError,
}) {
  const tableName = String(tableNames?.HOLDS_TABLE ?? "").trim();

  // Atomic "claim a phone slot" gate. Caller must call releaseAnonBookingPhoneSlot
  // on every exit path that follows a successful acquire (payment, expiry,
  // manual release, or any failure between acquire and reservation-create).
  //
  // Slot semantics:
  // - Empty / never written → claim succeeds.
  // - Existing slot whose `expiresAt` is in the past → claim succeeds
  //   (overwrites the stale slot). Recovers from crashes mid-flow.
  // - Existing slot still in TTL → throws 429 ACTIVE_HOLD_EXISTS with
  //   the existing reservationId + expiresAt so the frontend can show
  //   the active-hold banner instead of looking dead.
  async function acquireAnonBookingPhoneSlot({
    phoneE164,
    reservationId,
    eventDate,
    expiresAt,
    customerToken,
  }) {
    if (!tableName) {
      throw httpError(500, "HOLDS_TABLE is not configured");
    }
    const key = phoneSlotKey(phoneE164);
    if (!key) {
      throw httpError(400, "phone is required to acquire anon booking slot");
    }
    const ttl = Number(expiresAt ?? 0);
    if (!Number.isFinite(ttl) || ttl <= nowEpoch()) {
      throw httpError(400, "expiresAt must be in the future");
    }
    const reservationIdStr = String(reservationId ?? "").trim();
    if (!reservationIdStr) {
      throw httpError(400, "reservationId is required");
    }
    const eventDateStr = String(eventDate ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDateStr)) {
      throw httpError(400, "eventDate must be YYYY-MM-DD");
    }
    const tokenStr = String(customerToken ?? "").trim();
    if (!tokenStr) {
      throw httpError(400, "customerToken is required");
    }

    const now = nowEpoch();
    try {
      await ddb.send(
        new PutCommand({
          TableName: tableName,
          Item: {
            ...key,
            entityType: "ANON_BOOKING_SLOT",
            reservationId: reservationIdStr,
            eventDate: eventDateStr,
            expiresAt: ttl,
            customerToken: tokenStr,
            createdAt: now,
            ttl,
          },
          // Allow overwrite if the existing slot is past its expiresAt.
          // attribute_not_exists(PK) covers the never-written case;
          // expiresAt < :now covers the recover-from-crash case.
          ConditionExpression:
            "attribute_not_exists(PK) OR expiresAt < :now",
          ExpressionAttributeValues: { ":now": now },
        })
      );
    } catch (err) {
      if (err?.name === "ConditionalCheckFailedException") {
        // Read the existing slot so we can hand the frontend something
        // useful (the existing hold's id + when it expires).
        const existing = await getAnonBookingPhoneSlot(phoneE164);
        const conflict = httpError(
          429,
          "An active unpaid hold exists for this phone number"
        );
        conflict.code = "ACTIVE_HOLD_EXISTS";
        conflict.details = {
          existingReservationId: existing?.reservationId ?? null,
          existingExpiresAt: existing?.expiresAt ?? null,
          existingEventDate: existing?.eventDate ?? null,
        };
        throw conflict;
      }
      throw err;
    }
  }

  // Best-effort delete. Caller passes the reservationId so we don't release
  // a slot that was re-acquired by a different reservation in between.
  // Conditional delete — if reservationId doesn't match, leave the row.
  async function releaseAnonBookingPhoneSlot({ phoneE164, reservationId }) {
    if (!tableName) return;
    const key = phoneSlotKey(phoneE164);
    if (!key) return;
    const reservationIdStr = String(reservationId ?? "").trim();
    if (!reservationIdStr) return;

    try {
      await ddb.send(
        new DeleteCommand({
          TableName: tableName,
          Key: key,
          ConditionExpression: "reservationId = :rid",
          ExpressionAttributeValues: { ":rid": reservationIdStr },
        })
      );
    } catch (err) {
      if (err?.name === "ConditionalCheckFailedException") {
        // Slot was already released or rebound to a newer reservation. Fine.
        return;
      }
      // Any other failure is logged + swallowed — the slot will expire
      // on its own ttl. We don't want release errors to cascade into
      // payment-flow failures.
      console.warn("anon_booking_release_failed", {
        phoneKey: String(key.SK).slice(ANON_HOLD_SK_PREFIX.length),
        reservationId: reservationIdStr,
        message: String(err?.message ?? err ?? ""),
      });
    }
  }

  async function getAnonBookingPhoneSlot(phoneE164) {
    if (!tableName) return null;
    const key = phoneSlotKey(phoneE164);
    if (!key) return null;
    try {
      const out = await ddb.send(
        new GetCommand({ TableName: tableName, Key: key })
      );
      return out?.Item ?? null;
    } catch (err) {
      console.warn("anon_booking_slot_read_failed", {
        message: String(err?.message ?? err ?? ""),
      });
      return null;
    }
  }

  // Compare a customer-supplied token (from ?t=... query) against the
  // token stored on the reservation. Constant-time compare via
  // safeStringEquals. Returns boolean.
  function verifyCustomerToken(reservation, providedToken) {
    const stored = String(reservation?.customerToken ?? "");
    return safeStringEquals(stored, String(providedToken ?? ""));
  }

  return {
    acquireAnonBookingPhoneSlot,
    releaseAnonBookingPhoneSlot,
    getAnonBookingPhoneSlot,
    verifyCustomerToken,
  };
}
