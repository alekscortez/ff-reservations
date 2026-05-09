// Customer self-service. Reads identity from Cognito + best-effort CRM
// lookup against ff-clients.
//
// CRM merge: ff-clients is keyed by (PK=CLIENT, SK=PHONE#{e164}) and
// has no sub-based GSI. So a customer's CRM record is found by their
// phone (read from Cognito user attributes). The first time a customer
// is recognized, we attach `cognitoSub` to the existing CRM record so
// audits/admin views can correlate. We never CREATE a CRM record from
// /me — staff create them via reservation flows; customers only read.

import {
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  AdminGetUserCommand,
  AdminDeleteUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";

export function createMeService({
  ddb,
  cognito,
  userPoolId,
  CLIENTS_TABLE,
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

  return { getProfile, deleteAccount };
}
