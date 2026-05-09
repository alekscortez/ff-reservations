// Hold lifecycle. Lifted out of services-reservations-holds.mjs
// (PR #7 / batch-8 of the audit refactor).
//
// Hold semantics:
// - A "hold" is an exclusive lock on a (eventDate, tableId) tuple with
//   a TTL (default 5 min, settings.holdTtlSeconds in [60, 1800]).
// - createHold first kicks an overdue-release sweep so abandoned
//   reservations don't block fresh holds, then conditionally writes
//   the lock — either when the row doesn't exist, OR when the existing
//   row is itself an expired HOLD (so we can reclaim it).
// - releaseHold deletes only HOLD locks; RESERVED locks are immune
//   here (cancellation handles those).
//
// Public contract: import {createHoldsService} and pass deps + shared.
// The releaseOverdueReservationsForEventDate dependency is threaded as
// a third arg (a `{ releaseOverdueReservationsForEventDate }` bag) so
// the barrel can wire it in after the reservations factory is built.

import {
  DeleteCommand,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";

import { DEFAULT_AUTO_RELEASE_USER } from "./services-reservations-shared.mjs";

export function createHoldsService(
  {
    ddb,
    tableNames,
    requiredEnv,
    httpError,
    nowEpoch,
    randomUUID,
    normalizePhoneCountry,
    normalizePhoneE164,
    detectPhoneCountryFromE164,
    getEventByDate,
    getDisabledTablesFromFrequent,
  },
  shared,
  { releaseOverdueReservationsForEventDate }
) {
  const { HOLDS_TABLE } = tableNames;
  const { getRuntimeSettings, resolveHoldTtlSeconds } = shared;

  async function listTableLocks(eventDate) {
    requiredEnv("HOLDS_TABLE", HOLDS_TABLE);
    const pk = `EVENTDATE#${eventDate}`;
    const res = await ddb.send(
      new QueryCommand({
        TableName: HOLDS_TABLE,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeValues: {
          ":pk": pk,
          ":sk": "TABLE#",
        },
      })
    );
    return res.Items ?? [];
  }

  async function createHold(payload, user) {
    requiredEnv("HOLDS_TABLE", HOLDS_TABLE);
    const eventDate = String(payload?.eventDate ?? "").trim();
    const tableId = String(payload?.tableId ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) {
      throw httpError(400, "eventDate must be YYYY-MM-DD");
    }
    if (!tableId) throw httpError(400, "tableId is required");
    await releaseOverdueReservationsForEventDate(eventDate, DEFAULT_AUTO_RELEASE_USER);
    const eventRecord = await getEventByDate(eventDate);
    if (!eventRecord) throw httpError(404, "Event not found for date");
    const disabledFromFrequent = await getDisabledTablesFromFrequent(eventRecord);
    if (
      disabledFromFrequent.has(tableId) ||
      (eventRecord.disabledTables ?? []).includes(tableId)
    ) {
      throw httpError(409, "Table is disabled for this event");
    }

    const settings = await getRuntimeSettings();
    const holdId = randomUUID();
    const now = nowEpoch();
    const expiresAt = now + resolveHoldTtlSeconds(settings);
    const holdPhoneCountry = normalizePhoneCountry(payload?.phoneCountry ?? "US");
    const holdPhone = normalizePhoneE164(payload?.phone ?? "", holdPhoneCountry);
    const holdPhoneCountryFinal = holdPhone
      ? detectPhoneCountryFromE164(holdPhone) ?? holdPhoneCountry
      : null;
    const item = {
      PK: `EVENTDATE#${eventDate}`,
      SK: `TABLE#${tableId}`,
      lockType: "HOLD",
      holdId,
      expiresAt,
      createdAt: now,
      createdBy: user,
      customerName: payload?.customerName ?? null,
      phone: holdPhone || null,
      phoneCountry: holdPhoneCountryFinal,
    };

    try {
      await ddb.send(
        new PutCommand({
          TableName: HOLDS_TABLE,
          Item: item,
          ConditionExpression:
            "attribute_not_exists(PK) AND attribute_not_exists(SK) OR (lockType = :hold AND expiresAt < :now)",
          ExpressionAttributeValues: {
            ":hold": "HOLD",
            ":now": now,
          },
        })
      );
    } catch (err) {
      if (err?.name === "ConditionalCheckFailedException") {
        throw httpError(409, "Table is already held or reserved");
      }
      throw err;
    }

    return item;
  }

  async function releaseHold(eventDate, tableId) {
    requiredEnv("HOLDS_TABLE", HOLDS_TABLE);
    await ddb.send(
      new DeleteCommand({
        TableName: HOLDS_TABLE,
        Key: { PK: `EVENTDATE#${eventDate}`, SK: `TABLE#${tableId}` },
        ConditionExpression: "lockType = :hold",
        ExpressionAttributeValues: { ":hold": "HOLD" },
      })
    );
  }

  async function listHolds(eventDate) {
    return await listTableLocks(eventDate);
  }

  return {
    listTableLocks,
    createHold,
    releaseHold,
    listHolds,
  };
}
