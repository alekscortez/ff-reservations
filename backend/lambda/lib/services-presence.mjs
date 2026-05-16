// Live-visitor presence tracking for the staff dashboard. Backed by
// HOLDS_TABLE rows under PK="PRESENCE", SK="SESSION#{sessionId}". Each
// row has a `stage` field (map / modal / checkout / paid_landing) and a
// short TTL (~90s) on `expiresAt` — DynamoDB evicts stale rows for us
// so there's no cron / sweep / cleanup to maintain.
//
// Writer: services-presence.recordPresence(sessionId, stage) — called
//   from the /public/telemetry handler whenever a stage-bearing event
//   fires. Overwrites the existing row (sessionId is the dedupe key),
//   so a single visitor moving through the funnel counts as one row
//   whose stage advances with them.
//
// Reader: services-presence.listPresence() — Query on PK="PRESENCE",
//   filter out any rows whose expiresAt has already passed (DDB TTL has
//   up to 48h eviction lag, so we double-check at read time), then
//   bucket by stage. Used by GET /admin/live-visitors.
//
// Cost: at ~30s heartbeat cadence, 1k unique visitors/day = ~30k writes/day
//   = under $0.05/mo. Reads are a single Query per staff poll.

import { PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";

const PRESENCE_PK = "PRESENCE";
const SESSION_SK_PREFIX = "SESSION#";
// 90 seconds — comfortably longer than the 30s FE heartbeat so a single
// missed beat doesn't drop the visitor off the count.
const PRESENCE_TTL_SECONDS = 90;
const VALID_STAGES = new Set(["map", "modal", "checkout", "paid_landing"]);

export function createPresenceService({ ddb, tableNames, nowEpoch, httpError }) {
  const tableName = String(tableNames?.HOLDS_TABLE ?? "").trim();

  async function recordPresence({ sessionId, stage, eventDate, ip }) {
    if (!tableName) {
      throw httpError(500, "HOLDS_TABLE is not configured");
    }
    const sid = String(sessionId ?? "").trim();
    if (!sid) return; // silent — telemetry must never break the user flow
    const stageStr = String(stage ?? "").trim();
    if (!VALID_STAGES.has(stageStr)) return;

    const now = nowEpoch();
    const item = {
      PK: PRESENCE_PK,
      SK: `${SESSION_SK_PREFIX}${sid}`,
      entityType: "PRESENCE",
      stage: stageStr,
      eventDate: String(eventDate ?? "").trim() || null,
      ip: String(ip ?? "").trim() || null,
      updatedAt: now,
      expiresAt: now + PRESENCE_TTL_SECONDS,
    };
    await ddb.send(
      new PutCommand({ TableName: tableName, Item: item })
    );
  }

  async function listPresence() {
    if (!tableName) {
      throw httpError(500, "HOLDS_TABLE is not configured");
    }
    const now = nowEpoch();
    const out = await ddb.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "#pk = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeNames: { "#pk": "PK" },
        ExpressionAttributeValues: {
          ":pk": PRESENCE_PK,
          ":sk": SESSION_SK_PREFIX,
        },
      })
    );
    const items = Array.isArray(out?.Items) ? out.Items : [];
    const live = items.filter((it) => {
      const exp = Number(it?.expiresAt ?? 0);
      return Number.isFinite(exp) && exp > now;
    });
    const byStage = { map: 0, modal: 0, checkout: 0, paid_landing: 0 };
    for (const it of live) {
      const stage = String(it?.stage ?? "").trim();
      if (VALID_STAGES.has(stage)) byStage[stage] += 1;
    }
    return {
      count: live.length,
      byStage,
      updatedAt: now,
    };
  }

  return {
    recordPresence,
    listPresence,
    // Exposed for tests + the telemetry handler's event→stage mapping.
    PRESENCE_TTL_SECONDS,
    VALID_STAGES,
  };
}

// Maps a telemetry event name to a presence stage, or null if the event
// should not write a presence row (most events are funnel observations,
// not "still here" signals). Kept out of the route handler so the list
// is testable in isolation.
export function eventToPresenceStage(eventName) {
  switch (String(eventName ?? "").trim()) {
    case "map_loaded":
    case "map_heartbeat":
    case "map_pending_hold_seen":
      return "map";
    case "modal_opened":
    case "modal_submitted":
    case "modal_validation_error":
      return "modal";
    case "modal_redirect_to_square":
      return "checkout";
    case "r_page_loaded":
    case "r_status_paid_seen":
      return "paid_landing";
    default:
      return null;
  }
}
