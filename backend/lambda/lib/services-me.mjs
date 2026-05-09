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

  return { getProfile };
}
