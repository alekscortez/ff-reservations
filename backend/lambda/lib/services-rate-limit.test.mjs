// Run: `node --test backend/lambda/lib/` from the repo root.
//
// Tests cover the SMS rate-limit state machine end-to-end with a fake
// DocumentClient that records calls. The actual DDB and AWS SDK aren't
// loaded — the service module only imports command constructors, which
// we don't actually exercise here (the fake `send` ignores them).

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { createRateLimitService } from "./services-rate-limit.mjs";

function httpError(status, message) {
  const err = new Error(message);
  err.statusCode = status;
  return err;
}

function makeFakeDdb({ getResponses = [], putError, updateError } = {}) {
  let getCallIndex = 0;
  const calls = [];
  return {
    calls,
    send: async (cmd) => {
      const cmdName = cmd?.constructor?.name ?? "Unknown";
      calls.push({ name: cmdName, input: cmd?.input });
      if (cmdName === "GetCommand") {
        const next = getResponses[getCallIndex] ?? { Item: null };
        getCallIndex += 1;
        return next;
      }
      if (cmdName === "PutCommand") {
        if (putError) throw putError;
        return {};
      }
      if (cmdName === "UpdateCommand") {
        if (updateError) throw updateError;
        return {};
      }
      return {};
    },
  };
}

const FIXED_NOW = 1_700_000_000;
const fixedNowEpoch = () => FIXED_NOW;

describe("createRateLimitService.checkAndIncrementSmsRateLimit", () => {
  it("PUT new window when no item exists for this phone", async () => {
    const ddb = makeFakeDdb({ getResponses: [{ Item: null }] });
    const svc = createRateLimitService({
      ddb,
      tableNames: { HOLDS_TABLE: "ff-table-holds" },
      nowEpoch: fixedNowEpoch,
      httpError,
    });
    await svc.checkAndIncrementSmsRateLimit("+12025550100");

    const sequence = ddb.calls.map((c) => c.name);
    assert.deepEqual(sequence, ["GetCommand", "PutCommand"]);
    const putItem = ddb.calls[1].input?.Item;
    assert.equal(putItem.PK, "RATE");
    assert.equal(putItem.SK, "SMS#+12025550100");
    assert.equal(putItem.count, 1);
    assert.equal(putItem.windowStartedAt, FIXED_NOW);
    assert.equal(putItem.ttl, FIXED_NOW + 600);
    assert.equal(putItem.entityType, "RATE_LIMIT");
  });

  it("PUT new window when stored windowStartedAt is older than the cutoff", async () => {
    const ddb = makeFakeDdb({
      getResponses: [
        { Item: { count: 99, windowStartedAt: FIXED_NOW - 700 } },
      ],
    });
    const svc = createRateLimitService({
      ddb,
      tableNames: { HOLDS_TABLE: "ff-table-holds" },
      nowEpoch: fixedNowEpoch,
      httpError,
    });
    await svc.checkAndIncrementSmsRateLimit("+12025550100");

    const sequence = ddb.calls.map((c) => c.name);
    assert.deepEqual(sequence, ["GetCommand", "PutCommand"]);
    assert.equal(ddb.calls[1].input?.Item?.count, 1);
  });

  it("UpdateItem (increment) when within window and below cap", async () => {
    const ddb = makeFakeDdb({
      getResponses: [
        { Item: { count: 3, windowStartedAt: FIXED_NOW - 60 } },
      ],
    });
    const svc = createRateLimitService({
      ddb,
      tableNames: { HOLDS_TABLE: "ff-table-holds" },
      nowEpoch: fixedNowEpoch,
      httpError,
    });
    await svc.checkAndIncrementSmsRateLimit("+12025550100");

    const sequence = ddb.calls.map((c) => c.name);
    assert.deepEqual(sequence, ["GetCommand", "UpdateCommand"]);
    const updateInput = ddb.calls[1].input;
    assert.equal(updateInput.ConditionExpression, "#count < :max");
    assert.equal(updateInput.ExpressionAttributeValues[":max"], 5);
  });

  it("throws 429 when count is already at the cap", async () => {
    const ddb = makeFakeDdb({
      getResponses: [
        { Item: { count: 5, windowStartedAt: FIXED_NOW - 60 } },
      ],
    });
    const svc = createRateLimitService({
      ddb,
      tableNames: { HOLDS_TABLE: "ff-table-holds" },
      nowEpoch: fixedNowEpoch,
      httpError,
    });
    await assert.rejects(
      () => svc.checkAndIncrementSmsRateLimit("+12025550100"),
      (err) => err?.statusCode === 429
    );
    const sequence = ddb.calls.map((c) => c.name);
    assert.deepEqual(sequence, ["GetCommand"]);
  });

  it("throws 429 when UpdateItem hits ConditionalCheckFailedException (lost race)", async () => {
    const ccfe = new Error("ConditionalCheck failed");
    ccfe.name = "ConditionalCheckFailedException";
    const ddb = makeFakeDdb({
      getResponses: [
        { Item: { count: 4, windowStartedAt: FIXED_NOW - 60 } },
      ],
      updateError: ccfe,
    });
    const svc = createRateLimitService({
      ddb,
      tableNames: { HOLDS_TABLE: "ff-table-holds" },
      nowEpoch: fixedNowEpoch,
      httpError,
    });
    await assert.rejects(
      () => svc.checkAndIncrementSmsRateLimit("+12025550100"),
      (err) => err?.statusCode === 429
    );
  });

  it("fails open (no throw) when GetItem errors transiently", async () => {
    const ddb = {
      send: async () => {
        throw new Error("network blip");
      },
    };
    const svc = createRateLimitService({
      ddb,
      tableNames: { HOLDS_TABLE: "ff-table-holds" },
      nowEpoch: fixedNowEpoch,
      httpError,
    });
    // Should NOT throw — we'd rather waste one SMS than lock everyone out.
    await svc.checkAndIncrementSmsRateLimit("+12025550100");
  });

  it("fails open when UpdateItem errors with a non-CCFE error", async () => {
    const ddb = makeFakeDdb({
      getResponses: [
        { Item: { count: 3, windowStartedAt: FIXED_NOW - 60 } },
      ],
      updateError: new Error("ProvisionedThroughputExceededException"),
    });
    const svc = createRateLimitService({
      ddb,
      tableNames: { HOLDS_TABLE: "ff-table-holds" },
      nowEpoch: fixedNowEpoch,
      httpError,
    });
    await svc.checkAndIncrementSmsRateLimit("+12025550100");
  });

  it("no-ops silently when HOLDS_TABLE is not configured", async () => {
    const ddb = { send: async () => assert.fail("should not be called") };
    const svc = createRateLimitService({
      ddb,
      tableNames: {},
      nowEpoch: fixedNowEpoch,
      httpError,
    });
    await svc.checkAndIncrementSmsRateLimit("+12025550100");
  });

  it("no-ops silently for empty / nullish phone", async () => {
    const ddb = { send: async () => assert.fail("should not be called") };
    const svc = createRateLimitService({
      ddb,
      tableNames: { HOLDS_TABLE: "ff-table-holds" },
      nowEpoch: fixedNowEpoch,
      httpError,
    });
    await svc.checkAndIncrementSmsRateLimit("");
    await svc.checkAndIncrementSmsRateLimit(null);
    await svc.checkAndIncrementSmsRateLimit(undefined);
  });

  it("config exposes documented constants for both buckets", () => {
    const svc = createRateLimitService({
      ddb: {},
      tableNames: { HOLDS_TABLE: "ff-table-holds" },
      nowEpoch: fixedNowEpoch,
      httpError,
    });
    assert.deepEqual(svc.config, {
      sms: { windowSeconds: 600, maxAttempts: 5 },
      customerHold: { windowSeconds: 300, maxAttempts: 5 },
    });
  });
});

describe("createRateLimitService.checkAndIncrementCustomerHoldRateLimit", () => {
  const SUB = "cognito-sub-abc123";

  it("PUT new window with CUSTHOLD#{sub} key when no item exists", async () => {
    const ddb = makeFakeDdb({ getResponses: [{ Item: null }] });
    const svc = createRateLimitService({
      ddb,
      tableNames: { HOLDS_TABLE: "ff-table-holds" },
      nowEpoch: fixedNowEpoch,
      httpError,
    });
    await svc.checkAndIncrementCustomerHoldRateLimit(SUB);
    const sequence = ddb.calls.map((c) => c.name);
    assert.deepEqual(sequence, ["GetCommand", "PutCommand"]);
    const putItem = ddb.calls[1].input?.Item;
    assert.equal(putItem.PK, "RATE");
    assert.equal(putItem.SK, `CUSTHOLD#${SUB}`);
    assert.equal(putItem.count, 1);
    assert.equal(putItem.windowStartedAt, FIXED_NOW);
    // Customer-hold window is 5 min, not 10 min like SMS.
    assert.equal(putItem.ttl, FIXED_NOW + 300);
  });

  it("UpdateItem increments count when within an active window under cap", async () => {
    const ddb = makeFakeDdb({
      getResponses: [
        { Item: { count: 2, windowStartedAt: FIXED_NOW - 60 } },
      ],
    });
    const svc = createRateLimitService({
      ddb,
      tableNames: { HOLDS_TABLE: "ff-table-holds" },
      nowEpoch: fixedNowEpoch,
      httpError,
    });
    await svc.checkAndIncrementCustomerHoldRateLimit(SUB);
    const sequence = ddb.calls.map((c) => c.name);
    assert.deepEqual(sequence, ["GetCommand", "UpdateCommand"]);
    const updateInput = ddb.calls[1].input;
    assert.equal(updateInput.Key.SK, `CUSTHOLD#${SUB}`);
    assert.equal(updateInput.ExpressionAttributeValues[":max"], 5);
  });

  it("throws 429 when count is already at the cap", async () => {
    const ddb = makeFakeDdb({
      getResponses: [
        { Item: { count: 5, windowStartedAt: FIXED_NOW - 60 } },
      ],
    });
    const svc = createRateLimitService({
      ddb,
      tableNames: { HOLDS_TABLE: "ff-table-holds" },
      nowEpoch: fixedNowEpoch,
      httpError,
    });
    await assert.rejects(
      () => svc.checkAndIncrementCustomerHoldRateLimit(SUB),
      (err) =>
        err?.statusCode === 429 &&
        /tables held/i.test(String(err?.message ?? ""))
    );
  });

  it("treats expired window as fresh (PUT, not Update)", async () => {
    const ddb = makeFakeDdb({
      getResponses: [
        // Window started 400s ago — older than the 300s customer-hold window.
        { Item: { count: 99, windowStartedAt: FIXED_NOW - 400 } },
      ],
    });
    const svc = createRateLimitService({
      ddb,
      tableNames: { HOLDS_TABLE: "ff-table-holds" },
      nowEpoch: fixedNowEpoch,
      httpError,
    });
    await svc.checkAndIncrementCustomerHoldRateLimit(SUB);
    const sequence = ddb.calls.map((c) => c.name);
    assert.deepEqual(sequence, ["GetCommand", "PutCommand"]);
  });

  it("no-ops silently for empty / nullish sub", async () => {
    const ddb = { send: async () => assert.fail("should not be called") };
    const svc = createRateLimitService({
      ddb,
      tableNames: { HOLDS_TABLE: "ff-table-holds" },
      nowEpoch: fixedNowEpoch,
      httpError,
    });
    await svc.checkAndIncrementCustomerHoldRateLimit("");
    await svc.checkAndIncrementCustomerHoldRateLimit(null);
    await svc.checkAndIncrementCustomerHoldRateLimit(undefined);
  });
});
