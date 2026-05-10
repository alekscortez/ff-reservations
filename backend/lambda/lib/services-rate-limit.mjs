// In-Lambda rate-limit backstop. Cloudflare WAF rate-limits /auth/customer/*
// at the edge (per the cloudflare_dns_provider memo + CLAUDE.md), but this
// stops abuse if the API Gateway URL is hit directly bypassing the CDN.
// Cost of being wrong (false positive 429 on a legitimate user) is low —
// they retry in a few minutes; cost of being silent (uncapped SMS to a
// target phone, or inventory-locking spam holds) is real money + carrier
// or operator complaints.
//
// Storage: HOLDS_TABLE. The hold partition uses PK=`EVENTDATE#{date}` and
// the events table uses PK=`EVENT`, so PK=`RATE` here doesn't collide.
// Rows carry a `ttl` attribute so they auto-expire if/when DynamoDB TTL
// is enabled on the table; until then orphaned rows are overwritten on
// the next attempt for the same identifier (the GET-then-PUT-on-expired
// branch).

import {
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

const SMS_WINDOW_SECONDS = 600;        // 10 minutes
const SMS_MAX_ATTEMPTS = 5;             // per window per phone

// Customer self-service hold creation. Sized to be friendly to a real
// customer iterating through tables ("I'll try table 12... oh I want 8
// instead") while stopping a hostile client from locking the whole map.
// 5 holds per 5 minutes is ~1 every minute average — enough for normal
// shopping behavior, well under what's needed to lock the floor.
const CUSTOMER_HOLD_WINDOW_SECONDS = 300;  // 5 minutes
const CUSTOMER_HOLD_MAX_ATTEMPTS = 5;       // per window per Cognito sub

export function createRateLimitService({
  ddb,
  tableNames,
  nowEpoch,
  httpError,
}) {
  const tableName = tableNames?.HOLDS_TABLE;

  function rateLimitKey(skPrefix, identifier) {
    return { PK: "RATE", SK: `${skPrefix}#${identifier}` };
  }

  // Two-step: GET to read the window, then PUT (new window) or UpdateItem
  // (gated increment). Concurrent callers can race here and both pass the
  // count check; worst case is one extra attempt, which is acceptable for
  // an anti-abuse cap (not a hard at-most-N invariant).
  async function checkAndIncrement({
    skPrefix,
    identifier,
    windowSeconds,
    maxAttempts,
    tooManyMessage,
    logTag,
  }) {
    if (!tableName) return; // table not configured; fail open, log nothing
    const id = String(identifier ?? "").trim();
    if (!id) return;        // caller validated upstream

    const now = nowEpoch();
    const expiredCutoff = now - windowSeconds;
    const key = rateLimitKey(skPrefix, id);

    let existing;
    try {
      existing = await ddb.send(
        new GetCommand({ TableName: tableName, Key: key })
      );
    } catch (err) {
      // If we can't read the table, fail open rather than locking everyone
      // out. Edge / WAF defenses still apply; this is belt-and-suspenders.
      console.warn(`${logTag}_get_failed_open`, {
        identifier: id,
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
              ttl: now + windowSeconds,
            },
          })
        );
      } catch (err) {
        console.warn(`${logTag}_reset_failed_open`, {
          identifier: id,
          message: String(err?.message ?? err ?? ""),
        });
      }
      return;
    }

    if (count >= maxAttempts) {
      throw httpError(429, tooManyMessage);
    }

    try {
      await ddb.send(
        new UpdateCommand({
          TableName: tableName,
          Key: key,
          UpdateExpression: "SET #count = #count + :one",
          ConditionExpression: "#count < :max",
          ExpressionAttributeNames: { "#count": "count" },
          ExpressionAttributeValues: { ":one": 1, ":max": maxAttempts },
        })
      );
    } catch (err) {
      if (err?.name === "ConditionalCheckFailedException") {
        // Lost a race — another concurrent call hit the cap. Treat as 429.
        throw httpError(429, tooManyMessage);
      }
      // Transient infra error: fail open (log + proceed). Same rationale
      // as the GET above.
      console.warn(`${logTag}_increment_failed_open`, {
        identifier: id,
        message: String(err?.message ?? err ?? ""),
      });
    }
  }

  async function checkAndIncrementSmsRateLimit(phoneE164) {
    return checkAndIncrement({
      skPrefix: "SMS",
      identifier: phoneE164,
      windowSeconds: SMS_WINDOW_SECONDS,
      maxAttempts: SMS_MAX_ATTEMPTS,
      tooManyMessage:
        "Too many code requests for this phone. Please try again in a few minutes.",
      logTag: "sms_rate_limit",
    });
  }

  async function checkAndIncrementCustomerHoldRateLimit(cognitoSub) {
    return checkAndIncrement({
      skPrefix: "CUSTHOLD",
      identifier: cognitoSub,
      windowSeconds: CUSTOMER_HOLD_WINDOW_SECONDS,
      maxAttempts: CUSTOMER_HOLD_MAX_ATTEMPTS,
      tooManyMessage:
        "Too many tables held recently. Please wait a few minutes before trying another table.",
      logTag: "customer_hold_rate_limit",
    });
  }

  return {
    checkAndIncrementSmsRateLimit,
    checkAndIncrementCustomerHoldRateLimit,
    config: {
      sms: {
        windowSeconds: SMS_WINDOW_SECONDS,
        maxAttempts: SMS_MAX_ATTEMPTS,
      },
      customerHold: {
        windowSeconds: CUSTOMER_HOLD_WINDOW_SECONDS,
        maxAttempts: CUSTOMER_HOLD_MAX_ATTEMPTS,
      },
    },
  };
}
