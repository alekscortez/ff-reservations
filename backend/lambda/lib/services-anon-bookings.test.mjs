// Tests for the anonymous-booking phone-slot registry + customer-token
// verifier (services-anon-bookings.mjs). Fake DDB records calls; no AWS
// SDK round-trips happen.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createAnonBookingsService } from "./services-anon-bookings.mjs";

function httpError(status, message) {
  const err = new Error(message);
  err.statusCode = status;
  return err;
}

class ConditionalCheckFailedException extends Error {
  constructor(message = "ConditionalCheckFailed") {
    super(message);
    this.name = "ConditionalCheckFailedException";
  }
}

function makeFakeDdb({
  putError,
  deleteError,
  getResponses = [{ Item: null }],
} = {}) {
  let getIndex = 0;
  const calls = [];
  return {
    calls,
    send: async (cmd) => {
      const name = cmd?.constructor?.name ?? "Unknown";
      calls.push({ name, input: cmd?.input });
      if (name === "GetCommand") {
        const next = getResponses[getIndex] ?? { Item: null };
        getIndex += 1;
        return next;
      }
      if (name === "PutCommand") {
        if (putError) throw putError;
        return {};
      }
      if (name === "DeleteCommand") {
        if (deleteError) throw deleteError;
        return {};
      }
      return {};
    },
  };
}

const FIXED_NOW = 1_700_000_000;
const fixedNowEpoch = () => FIXED_NOW;

const VALID_INPUT = {
  phoneE164: "+18557656160",
  reservationId: "res-abc",
  eventDate: "2026-05-16",
  expiresAt: FIXED_NOW + 600,
  customerToken: "a".repeat(64),
};

describe("createAnonBookingsService.acquireAnonBookingPhoneSlot", () => {
  it("happy path: PutCommand carries slot row + ConditionExpression", async () => {
    const ddb = makeFakeDdb();
    const svc = createAnonBookingsService({
      ddb,
      tableNames: { HOLDS_TABLE: "ff-table-holds" },
      nowEpoch: fixedNowEpoch,
      httpError,
    });
    await svc.acquireAnonBookingPhoneSlot(VALID_INPUT);

    assert.equal(ddb.calls.length, 1);
    const put = ddb.calls[0];
    assert.equal(put.name, "PutCommand");
    assert.equal(put.input?.Item?.PK, "RATE");
    assert.equal(put.input?.Item?.SK, "ANONHOLD#18557656160");
    assert.equal(put.input?.Item?.entityType, "ANON_BOOKING_SLOT");
    assert.equal(put.input?.Item?.reservationId, "res-abc");
    assert.equal(put.input?.Item?.eventDate, "2026-05-16");
    assert.equal(put.input?.Item?.expiresAt, FIXED_NOW + 600);
    assert.equal(put.input?.Item?.ttl, FIXED_NOW + 600);
    assert.match(
      String(put.input?.ConditionExpression ?? ""),
      /attribute_not_exists\(PK\) OR expiresAt < :now/
    );
  });

  it("conflict: throws 429 ACTIVE_HOLD_EXISTS with details on existing slot", async () => {
    const existingSlot = {
      reservationId: "res-existing",
      eventDate: "2026-05-15",
      expiresAt: FIXED_NOW + 300,
      customerToken: "b".repeat(64),
    };
    const ddb = makeFakeDdb({
      putError: new ConditionalCheckFailedException(),
      getResponses: [{ Item: existingSlot }],
    });
    const svc = createAnonBookingsService({
      ddb,
      tableNames: { HOLDS_TABLE: "ff-table-holds" },
      nowEpoch: fixedNowEpoch,
      httpError,
    });

    let caught;
    try {
      await svc.acquireAnonBookingPhoneSlot(VALID_INPUT);
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, "expected throw");
    assert.equal(caught.statusCode, 429);
    assert.equal(caught.code, "ACTIVE_HOLD_EXISTS");
    assert.deepEqual(caught.details, {
      existingReservationId: "res-existing",
      existingExpiresAt: FIXED_NOW + 300,
      existingEventDate: "2026-05-15",
    });
  });

  it("rethrows non-Conditional DDB errors", async () => {
    const ddb = makeFakeDdb({ putError: new Error("ThrottlingException") });
    const svc = createAnonBookingsService({
      ddb,
      tableNames: { HOLDS_TABLE: "ff-table-holds" },
      nowEpoch: fixedNowEpoch,
      httpError,
    });
    await assert.rejects(
      svc.acquireAnonBookingPhoneSlot(VALID_INPUT),
      /ThrottlingException/
    );
  });

  it("400s on invalid inputs", async () => {
    const svc = createAnonBookingsService({
      ddb: makeFakeDdb(),
      tableNames: { HOLDS_TABLE: "ff-table-holds" },
      nowEpoch: fixedNowEpoch,
      httpError,
    });
    await assert.rejects(
      svc.acquireAnonBookingPhoneSlot({ ...VALID_INPUT, phoneE164: "" }),
      /phone is required/
    );
    await assert.rejects(
      svc.acquireAnonBookingPhoneSlot({ ...VALID_INPUT, expiresAt: 0 }),
      /expiresAt must be in the future/
    );
    await assert.rejects(
      svc.acquireAnonBookingPhoneSlot({
        ...VALID_INPUT,
        reservationId: "",
      }),
      /reservationId is required/
    );
    await assert.rejects(
      svc.acquireAnonBookingPhoneSlot({
        ...VALID_INPUT,
        eventDate: "not-a-date",
      }),
      /eventDate must be YYYY-MM-DD/
    );
    await assert.rejects(
      svc.acquireAnonBookingPhoneSlot({
        ...VALID_INPUT,
        customerToken: "",
      }),
      /customerToken is required/
    );
  });

  it("500 when HOLDS_TABLE not configured", async () => {
    const svc = createAnonBookingsService({
      ddb: makeFakeDdb(),
      tableNames: {},
      nowEpoch: fixedNowEpoch,
      httpError,
    });
    await assert.rejects(
      svc.acquireAnonBookingPhoneSlot(VALID_INPUT),
      /HOLDS_TABLE is not configured/
    );
  });
});

describe("createAnonBookingsService.releaseAnonBookingPhoneSlot", () => {
  it("happy path: DeleteCommand with reservationId condition", async () => {
    const ddb = makeFakeDdb();
    const svc = createAnonBookingsService({
      ddb,
      tableNames: { HOLDS_TABLE: "ff-table-holds" },
      nowEpoch: fixedNowEpoch,
      httpError,
    });
    await svc.releaseAnonBookingPhoneSlot({
      phoneE164: "+18557656160",
      reservationId: "res-abc",
    });

    assert.equal(ddb.calls.length, 1);
    const del = ddb.calls[0];
    assert.equal(del.name, "DeleteCommand");
    assert.equal(del.input?.Key?.SK, "ANONHOLD#18557656160");
    assert.equal(del.input?.ExpressionAttributeValues?.[":rid"], "res-abc");
  });

  it("swallows ConditionalCheckFailed (slot already released or rebound)", async () => {
    const ddb = makeFakeDdb({
      deleteError: new ConditionalCheckFailedException(),
    });
    const svc = createAnonBookingsService({
      ddb,
      tableNames: { HOLDS_TABLE: "ff-table-holds" },
      nowEpoch: fixedNowEpoch,
      httpError,
    });
    await svc.releaseAnonBookingPhoneSlot({
      phoneE164: "+18557656160",
      reservationId: "res-abc",
    });
  });

  it("no-op on missing inputs (no throw, no DDB call)", async () => {
    const ddb = makeFakeDdb();
    const svc = createAnonBookingsService({
      ddb,
      tableNames: { HOLDS_TABLE: "ff-table-holds" },
      nowEpoch: fixedNowEpoch,
      httpError,
    });
    await svc.releaseAnonBookingPhoneSlot({});
    await svc.releaseAnonBookingPhoneSlot({ phoneE164: "+18557656160" });
    await svc.releaseAnonBookingPhoneSlot({ reservationId: "res-abc" });
    assert.equal(ddb.calls.length, 0);
  });

  it("swallows arbitrary delete errors (slot will expire on its own ttl)", async () => {
    const ddb = makeFakeDdb({ deleteError: new Error("InternalError") });
    const svc = createAnonBookingsService({
      ddb,
      tableNames: { HOLDS_TABLE: "ff-table-holds" },
      nowEpoch: fixedNowEpoch,
      httpError,
    });
    // Should not throw.
    await svc.releaseAnonBookingPhoneSlot({
      phoneE164: "+18557656160",
      reservationId: "res-abc",
    });
  });
});

describe("createAnonBookingsService.getAnonBookingPhoneSlot", () => {
  it("returns the stored item when present", async () => {
    const item = {
      reservationId: "res-abc",
      expiresAt: FIXED_NOW + 600,
      eventDate: "2026-05-16",
    };
    const ddb = makeFakeDdb({ getResponses: [{ Item: item }] });
    const svc = createAnonBookingsService({
      ddb,
      tableNames: { HOLDS_TABLE: "ff-table-holds" },
      nowEpoch: fixedNowEpoch,
      httpError,
    });
    const out = await svc.getAnonBookingPhoneSlot("+18557656160");
    assert.deepEqual(out, item);
  });

  it("returns null when no row exists", async () => {
    const ddb = makeFakeDdb({ getResponses: [{ Item: null }] });
    const svc = createAnonBookingsService({
      ddb,
      tableNames: { HOLDS_TABLE: "ff-table-holds" },
      nowEpoch: fixedNowEpoch,
      httpError,
    });
    const out = await svc.getAnonBookingPhoneSlot("+18557656160");
    assert.equal(out, null);
  });

  it("returns null on bad phone (no DDB call)", async () => {
    const ddb = makeFakeDdb();
    const svc = createAnonBookingsService({
      ddb,
      tableNames: { HOLDS_TABLE: "ff-table-holds" },
      nowEpoch: fixedNowEpoch,
      httpError,
    });
    const out = await svc.getAnonBookingPhoneSlot("");
    assert.equal(out, null);
    assert.equal(ddb.calls.length, 0);
  });
});

describe("createAnonBookingsService.verifyCustomerToken", () => {
  const svc = createAnonBookingsService({
    ddb: makeFakeDdb(),
    tableNames: { HOLDS_TABLE: "ff-table-holds" },
    nowEpoch: fixedNowEpoch,
    httpError,
  });

  it("matches identical tokens", () => {
    assert.equal(
      svc.verifyCustomerToken({ customerToken: "abc123" }, "abc123"),
      true
    );
  });

  it("rejects mismatched tokens", () => {
    assert.equal(
      svc.verifyCustomerToken({ customerToken: "abc123" }, "abc124"),
      false
    );
  });

  it("rejects empty stored or provided", () => {
    assert.equal(svc.verifyCustomerToken({ customerToken: "" }, "x"), false);
    assert.equal(svc.verifyCustomerToken({ customerToken: "x" }, ""), false);
    assert.equal(svc.verifyCustomerToken({}, "x"), false);
    assert.equal(svc.verifyCustomerToken(null, "x"), false);
  });

  it("rejects length mismatch (timingSafeEqual would otherwise throw)", () => {
    assert.equal(
      svc.verifyCustomerToken({ customerToken: "short" }, "muchlongerinput"),
      false
    );
  });
});
