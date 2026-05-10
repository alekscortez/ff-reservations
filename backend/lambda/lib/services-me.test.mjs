// Tests for services-me.mjs (customer self-service surface). Pins the
// 3 endpoints used by /me/profile, DELETE /me, and GET /me/reservations:
//
// - getProfile: Cognito identity merge with CRM by phone, first-touch
//   sub attachment for future correlation
// - deleteAccount: soft-delete CRM (preserve audit) then delete Cognito
//   user, idempotent on UserNotFoundException
// - listReservations: byCustomerSub GSI query with newest-first sort,
//   internal-field stripping (privacy regression — never leak
//   paymentLinkId, paymentLinkProvider, etc.)

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createMeService } from "./services-me.mjs";

const SUB = "cognito-sub-12345";
const PHONE = "+12025550100";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function makeFakeDdb({ getResponses = [], queryResponses = [], throwOnCommand } = {}) {
  let getIdx = 0;
  let qIdx = 0;
  const calls = [];
  return {
    calls,
    send: async (cmd) => {
      const name = cmd?.constructor?.name ?? "Unknown";
      calls.push({ name, input: cmd?.input });
      if (throwOnCommand?.[name]) throw throwOnCommand[name];
      if (name === "GetCommand") return getResponses[getIdx++] ?? { Item: null };
      if (name === "QueryCommand") return queryResponses[qIdx++] ?? { Items: [] };
      return {};
    },
  };
}

function makeFakeCognito({ userAttributes = [], throwOnCommand } = {}) {
  const calls = [];
  return {
    calls,
    send: async (cmd) => {
      const name = cmd?.constructor?.name ?? "Unknown";
      calls.push({ name, input: cmd?.input });
      if (throwOnCommand?.[name]) throw throwOnCommand[name];
      if (name === "AdminGetUserCommand") {
        return { UserAttributes: userAttributes };
      }
      return {};
    },
  };
}

function buildService(overrides = {}) {
  const ddb = overrides.ddb ?? makeFakeDdb();
  const cognito = overrides.cognito ?? makeFakeCognito();
  const svc = createMeService({
    ddb,
    cognito,
    userPoolId: "us-east-1_test",
    CLIENTS_TABLE: overrides.CLIENTS_TABLE === null ? null : "ff-clients",
    RES_TABLE: overrides.RES_TABLE === null ? null : "ff-reservations",
  });
  return { ddb, cognito, svc };
}

// ---------------------------------------------------------------------------
// getProfile
// ---------------------------------------------------------------------------

describe("getProfile", () => {
  it("returns identity-only when phone is missing (no CRM lookup)", async () => {
    const cognito = makeFakeCognito({
      userAttributes: [{ Name: "name", Value: "Alice" }],
    });
    const ddb = makeFakeDdb();
    const { svc } = buildService({ cognito, ddb });
    const out = await svc.getProfile(SUB);
    assert.equal(out.sub, SUB);
    assert.equal(out.phone, null);
    assert.equal(out.name, "Alice");
    assert.equal(out.crm, null);
    assert.equal(ddb.calls.length, 0, "no CRM lookup without phone");
  });

  it("returns identity + null crm when phone present but no CRM record", async () => {
    const cognito = makeFakeCognito({
      userAttributes: [
        { Name: "phone_number", Value: PHONE },
        { Name: "phone_number_verified", Value: "true" },
        { Name: "name", Value: "Alice" },
      ],
    });
    const ddb = makeFakeDdb({ getResponses: [{ Item: null }] });
    const { svc } = buildService({ cognito, ddb });
    const out = await svc.getProfile(SUB);
    assert.equal(out.phone, PHONE);
    assert.equal(out.phoneVerified, true);
    assert.equal(out.crm, null);
    // No UpdateCommand attempted (no CRM record to attach to)
    assert.equal(
      ddb.calls.filter((c) => c.name === "UpdateCommand").length,
      0
    );
  });

  it("phoneVerified=false when attribute is missing or != 'true'", async () => {
    const cognito = makeFakeCognito({
      userAttributes: [{ Name: "phone_number", Value: PHONE }],
    });
    const ddb = makeFakeDdb({ getResponses: [{ Item: null }] });
    const { svc } = buildService({ cognito, ddb });
    const out = await svc.getProfile(SUB);
    assert.equal(out.phoneVerified, false);
  });

  it("attaches CRM stats + first-touch sub attachment when CRM record exists without sub", async () => {
    const cognito = makeFakeCognito({
      userAttributes: [{ Name: "phone_number", Value: PHONE }],
    });
    const ddb = makeFakeDdb({
      getResponses: [
        {
          Item: {
            phone: PHONE,
            totalReservations: 5,
            totalSpend: 750.5,
            lastReservationAt: 1700000000,
            lastEventDate: "2026-01-01",
            lastTableId: "A1",
            // cognitoSub deliberately missing → first-touch attach should fire
          },
        },
      ],
    });
    const { svc } = buildService({ cognito, ddb });
    const out = await svc.getProfile(SUB);

    assert.equal(out.crm.totalReservations, 5);
    assert.equal(out.crm.totalSpend, 750.5);
    assert.equal(out.crm.lastReservationAt, 1700000000);
    assert.equal(out.crm.lastEventDate, "2026-01-01");

    // First-touch sub attachment was attempted
    const update = ddb.calls.find((c) => c.name === "UpdateCommand");
    assert.ok(update, "UpdateCommand for sub attachment was issued");
    assert.equal(update.input.Key.PK, "CLIENT");
    assert.equal(update.input.Key.SK, `PHONE#${PHONE}`);
    assert.equal(update.input.ExpressionAttributeValues[":s"], SUB);
    assert.match(
      update.input.ConditionExpression,
      /attribute_exists\(SK\) AND \(attribute_not_exists\(cognitoSub\) OR cognitoSub <> :s\)/
    );
  });

  it("skips the attach when CRM already has matching sub", async () => {
    const cognito = makeFakeCognito({
      userAttributes: [{ Name: "phone_number", Value: PHONE }],
    });
    const ddb = makeFakeDdb({
      getResponses: [
        {
          Item: {
            phone: PHONE,
            cognitoSub: SUB, // already correct — skip attach
            totalReservations: 1,
            totalSpend: 100,
          },
        },
      ],
    });
    const { svc } = buildService({ cognito, ddb });
    await svc.getProfile(SUB);
    // No UpdateCommand sent
    assert.equal(
      ddb.calls.filter((c) => c.name === "UpdateCommand").length,
      0
    );
  });

  it("never surfaces the synthetic internal email field", async () => {
    const cognito = makeFakeCognito({
      userAttributes: [
        { Name: "phone_number", Value: PHONE },
        {
          Name: "email",
          Value: "customer-+12025550100@customer.famosofuego.local",
        },
      ],
    });
    const ddb = makeFakeDdb({ getResponses: [{ Item: null }] });
    const { svc } = buildService({ cognito, ddb });
    const out = await svc.getProfile(SUB);
    assert.equal(out.email, undefined);
    // Sanity: no key contains "customer.famosofuego.local" anywhere
    const serialized = JSON.stringify(out);
    assert.ok(!serialized.includes("customer.famosofuego.local"));
  });

  it("soft-fails the sub-attach UpdateCommand and still returns a profile (CCFE swallowed silently)", async () => {
    const ccfe = new Error("conflict");
    ccfe.name = "ConditionalCheckFailedException";
    const cognito = makeFakeCognito({
      userAttributes: [{ Name: "phone_number", Value: PHONE }],
    });
    const ddb = makeFakeDdb({
      getResponses: [
        { Item: { phone: PHONE, totalReservations: 1, totalSpend: 100 } },
      ],
      throwOnCommand: { UpdateCommand: ccfe },
    });
    const { svc } = buildService({ cognito, ddb });
    const out = await svc.getProfile(SUB);
    // Still returns the profile despite the attach failing
    assert.equal(out.crm.totalReservations, 1);
  });

  it("skips CRM lookup entirely when CLIENTS_TABLE is unset", async () => {
    const cognito = makeFakeCognito({
      userAttributes: [{ Name: "phone_number", Value: PHONE }],
    });
    const ddb = makeFakeDdb();
    const { svc } = buildService({ cognito, ddb, CLIENTS_TABLE: null });
    const out = await svc.getProfile(SUB);
    assert.equal(out.crm, null);
    assert.equal(ddb.calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// deleteAccount
// ---------------------------------------------------------------------------

describe("deleteAccount", () => {
  it("idempotent on Cognito UserNotFoundException (returns alreadyGone:true)", async () => {
    const userNotFound = new Error("user gone");
    userNotFound.name = "UserNotFoundException";
    const cognito = makeFakeCognito({
      throwOnCommand: { AdminGetUserCommand: userNotFound },
    });
    const ddb = makeFakeDdb();
    const { svc } = buildService({ cognito, ddb });
    const out = await svc.deleteAccount(SUB);
    assert.deepEqual(out, { deleted: true, alreadyGone: true });
    // No DDB writes happened
    assert.equal(ddb.calls.length, 0);
  });

  it("soft-deletes CRM record (sets deletedAt + deletedSub, clears cognitoSub) before Cognito delete", async () => {
    const cognito = makeFakeCognito({
      userAttributes: [{ Name: "phone_number", Value: PHONE }],
    });
    const ddb = makeFakeDdb();
    const { svc } = buildService({ cognito, ddb });
    await svc.deleteAccount(SUB);

    const updates = ddb.calls.filter((c) => c.name === "UpdateCommand");
    assert.equal(updates.length, 1, "one CRM soft-delete UpdateCommand");
    const update = updates[0];
    assert.equal(update.input.Key.PK, "CLIENT");
    assert.equal(update.input.Key.SK, `PHONE#${PHONE}`);
    assert.match(update.input.UpdateExpression, /deletedAt = :now/);
    assert.match(update.input.UpdateExpression, /deletedSub = :s/);
    assert.match(update.input.UpdateExpression, /cognitoSub = :nullsub/);
    assert.equal(update.input.ExpressionAttributeValues[":s"], SUB);
    assert.equal(update.input.ExpressionAttributeValues[":nullsub"], null);
    assert.equal(update.input.ConditionExpression, "attribute_exists(SK)");

    // Cognito AdminDeleteUserCommand was sent after the DDB update
    const deletes = cognito.calls.filter((c) => c.name === "AdminDeleteUserCommand");
    assert.equal(deletes.length, 1);
    assert.equal(deletes[0].input.Username, SUB);
  });

  it("CCFE on the CRM soft-delete is swallowed (no CRM record present is fine)", async () => {
    const ccfe = new Error("conflict");
    ccfe.name = "ConditionalCheckFailedException";
    const cognito = makeFakeCognito({
      userAttributes: [{ Name: "phone_number", Value: PHONE }],
    });
    const ddb = makeFakeDdb({ throwOnCommand: { UpdateCommand: ccfe } });
    const { svc } = buildService({ cognito, ddb });
    const out = await svc.deleteAccount(SUB);
    assert.equal(out.deleted, true);
  });

  it("treats Cognito AdminDeleteUserCommand UserNotFoundException as success (race)", async () => {
    const userNotFound = new Error("gone");
    userNotFound.name = "UserNotFoundException";
    const cognito = makeFakeCognito({
      userAttributes: [{ Name: "phone_number", Value: PHONE }],
      throwOnCommand: { AdminDeleteUserCommand: userNotFound },
    });
    const ddb = makeFakeDdb();
    const { svc } = buildService({ cognito, ddb });
    const out = await svc.deleteAccount(SUB);
    assert.equal(out.deleted, true);
  });

  it("propagates non-UserNotFoundException Cognito errors", async () => {
    const otherErr = new Error("Throttling");
    otherErr.name = "ThrottlingException";
    const cognito = makeFakeCognito({
      throwOnCommand: { AdminGetUserCommand: otherErr },
    });
    const { svc } = buildService({ cognito });
    await assert.rejects(
      () => svc.deleteAccount(SUB),
      (err) => err?.name === "ThrottlingException"
    );
  });

  it("skips CRM soft-delete when CLIENTS_TABLE is unset (still deletes Cognito user)", async () => {
    const cognito = makeFakeCognito({
      userAttributes: [{ Name: "phone_number", Value: PHONE }],
    });
    const ddb = makeFakeDdb();
    const { svc } = buildService({ cognito, ddb, CLIENTS_TABLE: null });
    const out = await svc.deleteAccount(SUB);
    assert.equal(out.deleted, true);
    assert.equal(ddb.calls.length, 0); // no DDB calls
    // Cognito delete still attempted
    assert.equal(
      cognito.calls.filter((c) => c.name === "AdminDeleteUserCommand").length,
      1
    );
  });
});

// ---------------------------------------------------------------------------
// listReservations (byCustomerSub GSI)
// ---------------------------------------------------------------------------

describe("listReservations", () => {
  it("returns [] when sub is empty", async () => {
    const ddb = makeFakeDdb();
    const { svc } = buildService({ ddb });
    assert.deepEqual(await svc.listReservations(""), []);
    assert.deepEqual(await svc.listReservations(null), []);
    assert.equal(ddb.calls.length, 0);
  });

  it("returns [] when RES_TABLE is unset", async () => {
    const ddb = makeFakeDdb();
    const { svc } = buildService({ ddb, RES_TABLE: null });
    assert.deepEqual(await svc.listReservations(SUB), []);
    assert.equal(ddb.calls.length, 0);
  });

  it("queries the byCustomerSub GSI with sub, descending, Limit 100", async () => {
    const ddb = makeFakeDdb({ queryResponses: [{ Items: [] }] });
    const { svc } = buildService({ ddb });
    await svc.listReservations(SUB);
    const q = ddb.calls[0];
    assert.equal(q.name, "QueryCommand");
    assert.equal(q.input.TableName, "ff-reservations");
    assert.equal(q.input.IndexName, "byCustomerSub");
    assert.equal(q.input.KeyConditionExpression, "customerCognitoSub = :s");
    assert.equal(q.input.ExpressionAttributeValues[":s"], SUB);
    assert.equal(q.input.ScanIndexForward, false);
    assert.equal(q.input.Limit, 100);
  });

  it("returns curated shape with the customer-facing fields", async () => {
    const ddb = makeFakeDdb({
      queryResponses: [
        {
          Items: [
            {
              reservationId: "r1",
              eventDate: "2026-05-09",
              tableId: "A1",
              customerName: "Alice",
              depositAmount: "30",
              tablePrice: "100",
              amountDue: "100",
              paymentStatus: "PARTIAL",
              paymentDeadlineAt: "2026-05-10T18:00:00",
              paymentDeadlineTz: "America/Chicago",
              paymentLinkUrl: "https://sq.link/abc",
              paymentLinkExpiresAt: "2026-05-10T18:00:00",
              status: "CONFIRMED",
              packageSnapshot: { name: "VIP", inclusions: [] },
              checkedInAt: null,
              cancelledAt: null,
            },
          ],
        },
      ],
    });
    const { svc } = buildService({ ddb });
    const [out] = await svc.listReservations(SUB);
    assert.equal(out.reservationId, "r1");
    assert.equal(out.eventDate, "2026-05-09");
    assert.equal(out.depositAmount, 30); // coerced to number
    assert.equal(out.tablePrice, 100);
    assert.equal(out.amountDue, 100);
    assert.equal(out.paymentStatus, "PARTIAL");
    assert.equal(out.paymentLinkUrl, "https://sq.link/abc");
    assert.deepEqual(out.packageSnapshot, { name: "VIP", inclusions: [] });
  });

  it("strips internal-only fields (privacy regression — no leak of internal IDs)", async () => {
    const ddb = makeFakeDdb({
      queryResponses: [
        {
          Items: [
            {
              reservationId: "r1",
              eventDate: "2026-05-09",
              // Internal fields that should NOT be in the response
              customerCognitoSub: SUB,
              cognitoSub: SUB,
              paymentLinkId: "PL_secret_id",
              paymentLinkProvider: "square",
              paymentLinkStatus: "ACTIVE",
              cashAppLinkTokenHash: "hashed-token",
              cashAppLinkStatus: "ACTIVE",
              creditId: "credit-internal",
              refundedAmount: 100,
              refunds: [{ id: "rf1" }],
              payments: [{ paymentId: "p1", method: "square" }],
              createdBy: "staff@x",
              createdAt: 1700000000,
              PK: "EVENTDATE#2026-05-09",
              SK: "RES#r1",
            },
          ],
        },
      ],
    });
    const { svc } = buildService({ ddb });
    const [out] = await svc.listReservations(SUB);
    // Expected fields present
    assert.equal(out.reservationId, "r1");
    assert.equal(out.eventDate, "2026-05-09");
    // Internal fields stripped
    assert.equal(out.customerCognitoSub, undefined);
    assert.equal(out.cognitoSub, undefined);
    assert.equal(out.paymentLinkId, undefined);
    assert.equal(out.paymentLinkProvider, undefined);
    assert.equal(out.paymentLinkStatus, undefined);
    assert.equal(out.cashAppLinkTokenHash, undefined);
    assert.equal(out.cashAppLinkStatus, undefined);
    assert.equal(out.creditId, undefined);
    assert.equal(out.refundedAmount, undefined);
    assert.equal(out.refunds, undefined);
    assert.equal(out.payments, undefined);
    assert.equal(out.createdBy, undefined);
    assert.equal(out.createdAt, undefined);
    assert.equal(out.PK, undefined);
    assert.equal(out.SK, undefined);
  });

  it("preserves null vs missing distinction in numeric fields", async () => {
    const ddb = makeFakeDdb({
      queryResponses: [
        {
          Items: [
            {
              reservationId: "r1",
              eventDate: "2026-05-09",
              // tablePrice present but null
              tablePrice: null,
              // amountDue missing
              depositAmount: 0,
            },
          ],
        },
      ],
    });
    const { svc } = buildService({ ddb });
    const [out] = await svc.listReservations(SUB);
    // tablePrice null → null in output (tablePrice != null check filters)
    assert.equal(out.tablePrice, null);
    assert.equal(out.amountDue, null); // missing → null
    assert.equal(out.depositAmount, 0);
  });
});
