// Customer self-service. Reads identity from Cognito + best-effort CRM
// lookup against ff-clients.
//
// CRM merge: ff-clients is keyed by (PK=CLIENT, SK=PHONE#{e164}) and
// has no sub-based GSI. So a customer's CRM record is found by their
// phone (read from Cognito user attributes). The first time a customer
// is recognized, we attach `cognitoSub` to the existing CRM record so
// audits/admin views can correlate. We never CREATE a CRM record from
// /me — staff create them via reservation flows; customers only read.
//
// Push token storage: separate rows on CLIENTS_TABLE keyed by
// (PK=PUSHTOKEN#{sub}, SK=TOKEN#{sha256(token)}). One row per device.
// Avoids the map-merge race that a single-row "tokens map" would have
// (DDB nested-attribute updates require the parent map to exist first,
// which forces a two-step write under contention). TTL is set so stale
// tokens auto-expire if the user reinstalls and never logs in again.

import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  AdminGetUserCommand,
  AdminDeleteUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { createHash } from "node:crypto";

const PUSH_TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60; // 90 days

function hashPushToken(token) {
  return createHash("sha256").update(String(token ?? ""), "utf8").digest("hex");
}

export function createMeService({
  ddb,
  cognito,
  userPoolId,
  CLIENTS_TABLE,
  RES_TABLE,
  httpError,
  nowEpoch,
  listRescheduleCreditsByPhone,
}) {
  async function fetchCognitoUser(sub) {
    const res = await cognito.send(
      new AdminGetUserCommand({
        UserPoolId: userPoolId,
        Username: sub,
      })
    );
    const attrs = Object.fromEntries(
      (res.UserAttributes ?? []).map((a) => [a.Name, a.Value])
    );
    return {
      sub,
      phone: attrs.phone_number ?? null,
      phoneVerified: attrs.phone_number_verified === "true",
      name: attrs.name ?? null,
      // The synthetic email that's stored under `email` is an internal
      // convention (customer-{e164}@customer.famosofuego.local) and not
      // useful to the client. Don't surface it.
    };
  }

  async function fetchCrmByPhone(phone) {
    if (!phone || !CLIENTS_TABLE) return null;
    const res = await ddb.send(
      new GetCommand({
        TableName: CLIENTS_TABLE,
        Key: { PK: "CLIENT", SK: `PHONE#${phone}` },
      })
    );
    return res.Item ?? null;
  }

  async function attachSubToCrmIfMissing(phone, sub) {
    if (!phone || !sub || !CLIENTS_TABLE) return;
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: CLIENTS_TABLE,
          Key: { PK: "CLIENT", SK: `PHONE#${phone}` },
          UpdateExpression:
            "SET cognitoSub = :s, cognitoSubAttachedAt = :now",
          ExpressionAttributeValues: {
            ":s": sub,
            ":now": Date.now(),
          },
          ConditionExpression:
            "attribute_exists(SK) AND (attribute_not_exists(cognitoSub) OR cognitoSub <> :s)",
        })
      );
    } catch (err) {
      // ConditionalCheckFailed means the record already had this sub
      // (no-op) or the record disappeared. Either way, soft-fail.
      if (err?.name !== "ConditionalCheckFailedException") {
        console.warn("me_attach_sub_failed", {
          phone,
          sub,
          errorName: err?.name,
        });
      }
    }
  }

  async function getProfile(sub) {
    const identity = await fetchCognitoUser(sub);

    let crm = null;
    if (identity.phone) {
      const record = await fetchCrmByPhone(identity.phone);
      if (record) {
        crm = {
          totalReservations: Number(record.totalReservations ?? 0),
          totalSpend: Number(record.totalSpend ?? 0),
          lastReservationAt: record.lastReservationAt ?? null,
          lastEventDate: record.lastEventDate ?? null,
          lastTableId: record.lastTableId ?? null,
        };
        // First-touch merge: attach sub for future correlation.
        if (record.cognitoSub !== sub) {
          await attachSubToCrmIfMissing(identity.phone, sub);
        }
      }
    }

    return {
      sub: identity.sub,
      phone: identity.phone,
      phoneVerified: identity.phoneVerified,
      name: identity.name,
      crm,
    };
  }

  async function deleteAccount(sub) {
    // Soft-delete the CRM record before deleting the Cognito user so
    // the timestamp + sub are preserved for audit. CRM records are
    // load-bearing for staff history (totalReservations / totalSpend
    // referenced from reservation flows), so we never hard-delete.
    let phone = null;
    try {
      const identity = await fetchCognitoUser(sub);
      phone = identity.phone;
    } catch (err) {
      if (err?.name !== "UserNotFoundException") throw err;
      // User already gone — idempotent delete, nothing more to do.
      return { deleted: true, alreadyGone: true };
    }

    if (phone && CLIENTS_TABLE) {
      try {
        await ddb.send(
          new UpdateCommand({
            TableName: CLIENTS_TABLE,
            Key: { PK: "CLIENT", SK: `PHONE#${phone}` },
            UpdateExpression:
              "SET deletedAt = :now, deletedSub = :s, cognitoSub = :nullsub",
            ExpressionAttributeValues: {
              ":now": Date.now(),
              ":s": sub,
              ":nullsub": null,
            },
            ConditionExpression: "attribute_exists(SK)",
          })
        );
      } catch (err) {
        // ConditionalCheckFailed = no CRM record for this phone, fine.
        if (err?.name !== "ConditionalCheckFailedException") {
          console.warn("me_delete_crm_softdelete_failed", {
            sub,
            errorName: err?.name,
          });
        }
      }
    }

    try {
      await cognito.send(
        new AdminDeleteUserCommand({
          UserPoolId: userPoolId,
          Username: sub,
        })
      );
    } catch (err) {
      if (err?.name !== "UserNotFoundException") throw err;
      // Race: user disappeared between fetch and delete; treat as success.
    }

    return { deleted: true };
  }

  // Query the byCustomerSub GSI (sparse — only Phase-3+ reservations
  // with customerCognitoSub set appear). Sort newest event first.
  // Returns a curated shape — internal fields like paymentLinkId,
  // paymentLinkProvider, history pointers, and reschedule-credit
  // bookkeeping are intentionally not exposed.
  async function listReservations(sub) {
    if (!sub || !RES_TABLE) return [];
    const res = await ddb.send(
      new QueryCommand({
        TableName: RES_TABLE,
        IndexName: "byCustomerSub",
        KeyConditionExpression: "customerCognitoSub = :s",
        ExpressionAttributeValues: { ":s": sub },
        ScanIndexForward: false,
        Limit: 100,
      })
    );
    return (res.Items ?? []).map((r) => ({
      reservationId: r.reservationId ?? null,
      eventDate: r.eventDate ?? null,
      tableId: r.tableId ?? null,
      customerName: r.customerName ?? null,
      depositAmount: Number(r.depositAmount ?? 0),
      tablePrice: r.tablePrice != null ? Number(r.tablePrice) : null,
      amountDue: r.amountDue != null ? Number(r.amountDue) : null,
      paymentStatus: r.paymentStatus ?? null,
      paymentDeadlineAt: r.paymentDeadlineAt ?? null,
      paymentDeadlineTz: r.paymentDeadlineTz ?? null,
      paymentLinkUrl: r.paymentLinkUrl ?? null,
      paymentLinkExpiresAt: r.paymentLinkExpiresAt ?? null,
      status: r.status ?? null,
      packageSnapshot: r.packageSnapshot ?? null,
      checkedInAt: r.checkedInAt ?? null,
      cancelledAt: r.cancelledAt ?? null,
    }));
  }

  // Reschedule credit lookup. Bridges Cognito identity → phone-keyed
  // CRM credits. Returns the list and a precomputed total of remaining
  // ISSUED credits so the mobile app can render the balance without
  // duplicating the sum logic.
  async function listCreditsForCustomer(sub) {
    if (typeof listRescheduleCreditsByPhone !== "function") {
      return { items: [], totalRemaining: 0 };
    }
    let phone = null;
    try {
      const identity = await fetchCognitoUser(sub);
      phone = identity.phone;
    } catch (err) {
      if (err?.name === "UserNotFoundException") {
        return { items: [], totalRemaining: 0 };
      }
      throw err;
    }
    if (!phone) return { items: [], totalRemaining: 0 };

    const items = (await listRescheduleCreditsByPhone(phone)) ?? [];
    let totalRemaining = 0;
    for (const c of items) {
      if (String(c?.status ?? "").toUpperCase() !== "ISSUED") continue;
      const remaining = Number(c?.amountRemaining ?? 0);
      if (Number.isFinite(remaining) && remaining > 0) totalRemaining += remaining;
    }
    return {
      items: items.map((c) => ({
        creditId: c?.creditId ?? null,
        status: c?.status ?? null,
        amountTotal: Number(c?.amountTotal ?? 0),
        amountRemaining: Number(c?.amountRemaining ?? 0),
        issuedAt: c?.issuedAt ?? null,
        expiresAt: c?.expiresAt ?? null,
        sourceReservationId: c?.sourceReservationId ?? null,
        sourceEventDate: c?.sourceEventDate ?? null,
      })),
      totalRemaining: Number(totalRemaining.toFixed(2)),
    };
  }

  function ensurePushTokenInputs(token, platform) {
    if (typeof httpError !== "function") {
      throw new Error("me-service: httpError dep is required for push tokens");
    }
    const trimmedToken = String(token ?? "").trim();
    if (!trimmedToken) throw httpError(400, "token is required");
    if (trimmedToken.length > 256) {
      throw httpError(400, "token exceeds maximum length");
    }
    const trimmedPlatform = String(platform ?? "").trim().toLowerCase();
    if (!["ios", "android"].includes(trimmedPlatform)) {
      throw httpError(400, "platform must be 'ios' or 'android'");
    }
    return { token: trimmedToken, platform: trimmedPlatform };
  }

  async function registerPushToken(sub, rawToken, rawPlatform) {
    if (!CLIENTS_TABLE) return { registered: false };
    const { token, platform } = ensurePushTokenInputs(rawToken, rawPlatform);
    const tokenHash = hashPushToken(token);
    const now = typeof nowEpoch === "function" ? nowEpoch() : Math.floor(Date.now() / 1000);
    await ddb.send(
      new PutCommand({
        TableName: CLIENTS_TABLE,
        Item: {
          PK: `PUSHTOKEN#${sub}`,
          SK: `TOKEN#${tokenHash}`,
          entityType: "PUSH_TOKEN",
          sub,
          token,
          platform,
          registeredAt: now,
          lastSeenAt: now,
          ttl: now + PUSH_TOKEN_TTL_SECONDS,
        },
      })
    );
    return { registered: true, tokenHash, platform };
  }

  async function unregisterPushToken(sub, rawToken) {
    if (!CLIENTS_TABLE) return { unregistered: false };
    const token = String(rawToken ?? "").trim();
    if (!token) {
      if (typeof httpError !== "function") {
        throw new Error("me-service: httpError dep is required for push tokens");
      }
      throw httpError(400, "token is required");
    }
    const tokenHash = hashPushToken(token);
    await ddb.send(
      new DeleteCommand({
        TableName: CLIENTS_TABLE,
        Key: {
          PK: `PUSHTOKEN#${sub}`,
          SK: `TOKEN#${tokenHash}`,
        },
      })
    );
    return { unregistered: true, tokenHash };
  }

  return {
    getProfile,
    deleteAccount,
    listReservations,
    listCreditsForCustomer,
    registerPushToken,
    unregisterPushToken,
  };
}
