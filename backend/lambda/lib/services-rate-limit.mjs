// In-Lambda rate-limit backstop. Cloudflare WAF rate-limits /auth/customer/*
// at the edge (per the cloudflare_dns_provider memo + CLAUDE.md), but this
// stops a SMS-bomb if the API Gateway URL is hit directly bypassing the
// CDN. Cost of being wrong (false positive 429 on a legitimate user) is
// low — they retry in a few minutes; cost of being silent (uncapped SMS
// to a target phone) is real money + carrier complaint.
//
// Storage: HOLDS_TABLE. The hold partition uses PK=`EVENTDATE#{date}` and
// the events table uses PK=`EVENT`, so PK=`RATE` here doesn't collide.
// Rows carry a `ttl` attribute so they auto-expire if/when DynamoDB TTL
// is enabled on the table; until then orphaned rows are overwritten on
// the next attempt for the same phone (the GET-then-PUT-on-expired branch).

import {
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

const SMS_WINDOW_SECONDS = 600;   // 10 minutes
const SMS_MAX_ATTEMPTS = 5;        // per window per phone

export function createRateLimitService({
  ddb,
  tableNames,
  nowEpoch,
  httpError,
}) {
  const tableName = tableNames?.HOLDS_TABLE;

  function rateLimitKey(phoneE164) {
    return { PK: "RATE", SK: `SMS#${phoneE164}` };
  }

  function tooManyError() {
    return httpError(
      429,
      "Too many code requests for this phone. Please try again in a few minutes."
    );
  }

  // Two-step: GET to read the window, then PUT (new window) or UpdateItem
  // (gated increment). Concurrent callers can race here and both pass the
  // count check; worst case is one extra SMS, which is acceptable for an
  // anti-abuse cap (not a hard at-most-N invariant).
  async function checkAndIncrementSmsRateLimit(phoneE164) {
    if (!tableName) return; // table not configured; fail open, log nothing
    const phone = String(phoneE164 ?? "").trim();
    if (!phone) return;     // caller validated E.164 already

    const now = nowEpoch();
    const expiredCutoff = now - SMS_WINDOW_SECONDS;
    const key = rateLimitKey(phone);

    let existing;
    try {
      existing = await ddb.send(
        new GetCommand({ TableName: tableName, Key: key })
      );
    } catch (err) {
      // If we can't read the table, fail open rather than locking everyone
      // out. Cloudflare WAF is the primary defense; this is belt-and-
      // suspenders.
      console.warn("sms_rate_limit_get_failed_open", {
        phone,
        message: String(err?.message ?? err ?? ""),
      });
      return;
    }

    const item = existing?.Item;
    const windowStartedAt = Number(item?.windowStartedAt ?? 0);
    const count = Number(item?.count ?? 0);

    if (!item || windowStartedAt < expiredCutoff) {
      // Window expired or never existed — start fresh.
      try {
        await ddb.send(
          new PutCommand({
            TableName: tableName,
            Item: {
              ...key,
              entityType: "RATE_LIMIT",
              count: 1,
              windowStartedAt: now,
              ttl: now + SMS_WINDOW_SECONDS,
            },
          })
        );
      } catch (err) {
        console.warn("sms_rate_limit_reset_failed_open", {
          phone,
          message: String(err?.message ?? err ?? ""),
        });
      }
      return;
    }

    if (count >= SMS_MAX_ATTEMPTS) {
      throw tooManyError();
    }

    try {
      await ddb.send(
        new UpdateCommand({
          TableName: tableName,
          Key: key,
          UpdateExpression: "SET #count = #count + :one",
          ConditionExpression: "#count < :max",
          ExpressionAttributeNames: { "#count": "count" },
          ExpressionAttributeValues: { ":one": 1, ":max": SMS_MAX_ATTEMPTS },
        })
      );
    } catch (err) {
      if (err?.name === "ConditionalCheckFailedException") {
        // Lost a race — another concurrent call hit the cap. Treat as 429.
        throw tooManyError();
      }
      // Transient infra error: fail open (log + proceed). Same rationale
      // as the GET above.
      console.warn("sms_rate_limit_increment_failed_open", {
        phone,
        message: String(err?.message ?? err ?? ""),
      });
    }
  }

  return {
    checkAndIncrementSmsRateLimit,
    config: {
      windowSeconds: SMS_WINDOW_SECONDS,
      maxAttempts: SMS_MAX_ATTEMPTS,
    },
  };
}
