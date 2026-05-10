// Tests for services-events.mjs. The module is a thin wrapper over
// DynamoDB writes, but it owns the **one-event-per-date** invariant
// via a (PK="EVENTDATE", SK="DATE#YYYY-MM-DD") lock row that's
// transactionally tied to the event row. These tests pin the
// TransactWrite shapes and the status-transition lock lifecycle.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createEventsService } from "./services-events.mjs";

const FIXED_NOW = 1_700_000_000;

function httpError(status, message) {
  const err = new Error(message);
  err.statusCode = status;
  return err;
}

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
      if (name === "UpdateCommand") {
        return {
          Attributes: { ...(cmd.input?.ExpressionAttributeValues ?? {}), _updateEcho: true },
        };
      }
      return {};
    },
  };
}

function buildService(overrides = {}) {
  const ddb = overrides.ddb ?? makeFakeDdb();
  const frequentCalls = [];
  const svc = createEventsService({
    ddb,
    tableNames: { EVENTS_TABLE: "ff-events" },
    nowEpoch: () => FIXED_NOW,
    httpError,
    randomUUID: overrides.randomUUID ?? (() => "uuid-1"),
    createFrequentReservationsForEvent: async (eventItem, user) => {
      frequentCalls.push({ eventItem, user });
    },
  });
  return { ddb, svc, frequentCalls };
}

// ---------------------------------------------------------------------------
// listEvents
// ---------------------------------------------------------------------------

describe("listEvents", () => {
  it("queries with the EVENT# SK prefix and sorts by eventDate ascending", async () => {
    const items = [
      { eventId: "e2", eventName: "B", eventDate: "2026-05-10" },
      { eventId: "e1", eventName: "A", eventDate: "2026-05-09" },
      { eventId: "e3", eventName: "C", eventDate: "2026-05-11" },
    ];
    const ddb = makeFakeDdb({ queryResponses: [{ Items: items }] });
    const { svc } = buildService({ ddb });
    const out = await svc.listEvents();
    assert.equal(ddb.calls[0].name, "QueryCommand");
    assert.equal(ddb.calls[0].input.ExpressionAttributeValues[":pk"], "EVENT");
    assert.equal(ddb.calls[0].input.ExpressionAttributeValues[":sk"], "EVENT#");
    assert.deepEqual(
      out.map((e) => e.eventId),
      ["e1", "e2", "e3"]
    );
  });

  it("defaults missing optional collections to empty / {}", async () => {
    const items = [{ eventId: "e1", eventDate: "2026-05-09" }];
    const ddb = makeFakeDdb({ queryResponses: [{ Items: items }] });
    const { svc } = buildService({ ddb });
    const [event] = await svc.listEvents();
    assert.deepEqual(event.tablePricing, {});
    assert.deepEqual(event.sectionPricing, {});
    assert.deepEqual(event.disabledTables, []);
    assert.deepEqual(event.disabledClients, []);
    assert.deepEqual(event.frequentReleasedTables, []);
  });

  it("returns empty when no items", async () => {
    const ddb = makeFakeDdb({ queryResponses: [{ Items: [] }] });
    const { svc } = buildService({ ddb });
    const out = await svc.listEvents();
    assert.deepEqual(out, []);
  });
});

// ---------------------------------------------------------------------------
// createEvent
// ---------------------------------------------------------------------------

describe("createEvent validation", () => {
  it("400 on missing eventName", async () => {
    const { svc } = buildService();
    await assert.rejects(
      () => svc.createEvent({ eventDate: "2026-05-09" }, "u"),
      (err) => err?.statusCode === 400 && /eventName/.test(err.message)
    );
  });
  it("400 on bad eventDate", async () => {
    const { svc } = buildService();
    await assert.rejects(
      () => svc.createEvent({ eventName: "X", eventDate: "garbage" }, "u"),
      (err) => err?.statusCode === 400 && /YYYY-MM-DD/.test(err.message)
    );
  });
  it("400 on negative minDeposit", async () => {
    const { svc } = buildService();
    await assert.rejects(
      () =>
        svc.createEvent(
          { eventName: "X", eventDate: "2026-05-09", minDeposit: -1 },
          "u"
        ),
      (err) => err?.statusCode === 400 && /minDeposit/.test(err.message)
    );
  });
});

describe("createEvent happy path", () => {
  it("issues a TransactWrite with EVENTDATE lock + EVENT row, both attribute_not_exists guarded", async () => {
    const ddb = makeFakeDdb();
    const { svc, frequentCalls } = buildService({ ddb });
    const out = await svc.createEvent(
      {
        eventName: "Friday Night",
        eventDate: "2026-05-09",
        minDeposit: 50,
        tablePricing: { A1: 100 },
      },
      "staff@x"
    );

    const txn = ddb.calls.find((c) => c.name === "TransactWriteCommand");
    assert.ok(txn, "TransactWriteCommand sent");
    assert.equal(txn.input.TransactItems.length, 2);

    // First item: EVENTDATE lock with conditional
    const lockPut = txn.input.TransactItems[0].Put;
    assert.equal(lockPut.TableName, "ff-events");
    assert.equal(lockPut.Item.PK, "EVENTDATE");
    assert.equal(lockPut.Item.SK, "DATE#2026-05-09");
    assert.equal(
      lockPut.ConditionExpression,
      "attribute_not_exists(PK) AND attribute_not_exists(SK)"
    );

    // Second item: event row
    const eventPut = txn.input.TransactItems[1].Put;
    assert.equal(eventPut.Item.PK, "EVENT");
    assert.match(eventPut.Item.SK, /^EVENT#/);
    assert.equal(eventPut.Item.eventName, "Friday Night");
    assert.equal(eventPut.Item.status, "ACTIVE");
    assert.equal(eventPut.Item.minDeposit, 50);
    assert.equal(eventPut.Item.createdAt, FIXED_NOW);
    assert.equal(eventPut.Item.createdBy, "staff@x");

    // Returned item matches the event row
    assert.equal(out.eventName, "Friday Night");

    // Frequent reservations bootstrap was called
    assert.equal(frequentCalls.length, 1);
    assert.equal(frequentCalls[0].user, "staff@x");
  });

  it("TransactionCanceledException → 409 'event already exists for date'", async () => {
    const txnErr = new Error("conflict");
    txnErr.name = "TransactionCanceledException";
    const ddb = makeFakeDdb({ throwOnCommand: { TransactWriteCommand: txnErr } });
    const { svc } = buildService({ ddb });
    await assert.rejects(
      () => svc.createEvent({ eventName: "X", eventDate: "2026-05-09" }, "u"),
      (err) =>
        err?.statusCode === 409 && /already exists for 2026-05-09/.test(err.message)
    );
  });

  it("propagates non-TCE errors unchanged", async () => {
    const otherErr = new Error("Throughput");
    otherErr.name = "ProvisionedThroughputExceededException";
    const ddb = makeFakeDdb({ throwOnCommand: { TransactWriteCommand: otherErr } });
    const { svc } = buildService({ ddb });
    await assert.rejects(
      () => svc.createEvent({ eventName: "X", eventDate: "2026-05-09" }, "u"),
      (err) => err?.name === "ProvisionedThroughputExceededException"
    );
  });

  it("falls back actor to 'system' when not provided", async () => {
    const ddb = makeFakeDdb();
    const { svc, frequentCalls } = buildService({ ddb });
    await svc.createEvent({ eventName: "X", eventDate: "2026-05-09" });
    const txn = ddb.calls.find((c) => c.name === "TransactWriteCommand");
    assert.equal(txn.input.TransactItems[1].Put.Item.createdBy, "system");
    assert.equal(frequentCalls[0].user, "system");
  });
});

// ---------------------------------------------------------------------------
// getEventById + getEventByDate
// ---------------------------------------------------------------------------

describe("getEventById", () => {
  it("Gets the EVENT# row by id", async () => {
    const ddb = makeFakeDdb({ getResponses: [{ Item: { eventId: "e1" } }] });
    const { svc } = buildService({ ddb });
    const out = await svc.getEventById("e1");
    assert.equal(out.eventId, "e1");
    assert.equal(ddb.calls[0].input.Key.PK, "EVENT");
    assert.equal(ddb.calls[0].input.Key.SK, "EVENT#e1");
  });

  it("returns null when not found", async () => {
    const ddb = makeFakeDdb({ getResponses: [{ Item: null }] });
    const { svc } = buildService({ ddb });
    assert.equal(await svc.getEventById("e1"), null);
  });
});

describe("getEventByDate", () => {
  it("400 on bad date format", async () => {
    const { svc } = buildService();
    await assert.rejects(
      () => svc.getEventByDate("garbage"),
      (err) => err?.statusCode === 400 && /YYYY-MM-DD/.test(err.message)
    );
  });

  it("returns null when no EVENTDATE lock exists", async () => {
    const ddb = makeFakeDdb({ getResponses: [{ Item: null }] });
    const { svc } = buildService({ ddb });
    assert.equal(await svc.getEventByDate("2026-05-09"), null);
  });

  it("follows the lock's eventId to the EVENT# row", async () => {
    const ddb = makeFakeDdb({
      getResponses: [
        { Item: { eventDate: "2026-05-09", eventId: "e1" } },
        { Item: { eventId: "e1", eventName: "X" } },
      ],
    });
    const { svc } = buildService({ ddb });
    const out = await svc.getEventByDate("2026-05-09");
    assert.equal(out.eventId, "e1");
    // Two GetCommands: lock + event
    const getCalls = ddb.calls.filter((c) => c.name === "GetCommand");
    assert.equal(getCalls.length, 2);
    assert.equal(getCalls[0].input.Key.PK, "EVENTDATE");
    assert.equal(getCalls[0].input.Key.SK, "DATE#2026-05-09");
    assert.equal(getCalls[1].input.Key.SK, "EVENT#e1");
  });
});

// ---------------------------------------------------------------------------
// updateEvent
// ---------------------------------------------------------------------------

describe("updateEvent validation", () => {
  it("404 when event not found", async () => {
    const ddb = makeFakeDdb({ getResponses: [{ Item: null }] });
    const { svc } = buildService({ ddb });
    await assert.rejects(
      () => svc.updateEvent("e1", { eventName: "X" }, "u"),
      (err) => err?.statusCode === 404
    );
  });

  it("ignores unknown fields and still bumps updatedAt (no 400 because the unconditional push makes 'No fields to update' dead code)", async () => {
    // The implementation pushes `#updatedAt = :updatedAt` unconditionally
    // before the `updates.length === 0` check, so the 400 path is unreachable.
    // This test documents the actual behavior: an update with only an unknown
    // field still issues an UpdateCommand that just bumps updatedAt.
    const ddb = makeFakeDdb({
      getResponses: [
        { Item: { eventId: "e1", eventDate: "2026-05-09", status: "ACTIVE" } },
      ],
    });
    const { svc } = buildService({ ddb });
    await svc.updateEvent("e1", { unknownField: "X" }, "u");
    const update = ddb.calls.find((c) => c.name === "UpdateCommand");
    assert.ok(update, "UpdateCommand was issued");
    assert.equal(update.input.UpdateExpression, "SET #updatedAt = :updatedAt");
    assert.equal(update.input.ExpressionAttributeValues[":updatedAt"], FIXED_NOW);
    assert.equal(update.input.ExpressionAttributeValues[":unknownField"], undefined);
  });

  it("400 when changing eventDate on an ACTIVE event", async () => {
    const ddb = makeFakeDdb({
      getResponses: [{ Item: { eventId: "e1", eventDate: "2026-05-09", status: "ACTIVE" } }],
    });
    const { svc } = buildService({ ddb });
    await assert.rejects(
      () => svc.updateEvent("e1", { eventDate: "2026-05-10" }, "u"),
      (err) => err?.statusCode === 400 && /Changing eventDate/.test(err.message)
    );
  });
});

describe("updateEvent ACTIVE → INACTIVE", () => {
  it("transactionally updates the event row and deletes the EVENTDATE lock (with eventId condition)", async () => {
    const ddb = makeFakeDdb({
      getResponses: [
        { Item: { eventId: "e1", eventDate: "2026-05-09", status: "ACTIVE" } },
        { Item: { eventId: "e1", eventDate: "2026-05-09", status: "INACTIVE" } },
      ],
    });
    const { svc } = buildService({ ddb });
    const out = await svc.updateEvent("e1", { status: "INACTIVE" }, "staff@x");

    const txn = ddb.calls.find((c) => c.name === "TransactWriteCommand");
    assert.ok(txn, "TransactWriteCommand sent");
    assert.equal(txn.input.TransactItems.length, 2);

    // 0: event update
    const eventUpdate = txn.input.TransactItems[0].Update;
    assert.equal(eventUpdate.Key.SK, "EVENT#e1");
    assert.match(eventUpdate.UpdateExpression, /#status = :status/);
    assert.equal(eventUpdate.ExpressionAttributeValues[":status"], "INACTIVE");

    // 1: EVENTDATE lock delete with eventId condition (so we don't delete a different event's lock)
    const lockDelete = txn.input.TransactItems[1].Delete;
    assert.equal(lockDelete.Key.PK, "EVENTDATE");
    assert.equal(lockDelete.Key.SK, "DATE#2026-05-09");
    assert.equal(lockDelete.ConditionExpression, "eventId = :eid");
    assert.equal(lockDelete.ExpressionAttributeValues[":eid"], "e1");

    assert.equal(out.eventId, "e1");
  });
});

describe("updateEvent INACTIVE → ACTIVE", () => {
  it("re-creates the lock with attribute_not_exists guard, calls createFrequentReservationsForEvent", async () => {
    const ddb = makeFakeDdb({
      getResponses: [
        { Item: { eventId: "e1", eventDate: "2026-05-09", status: "INACTIVE" } },
        { Item: { eventId: "e1", eventDate: "2026-05-09", status: "ACTIVE" } },
      ],
    });
    const { svc, frequentCalls } = buildService({ ddb });
    await svc.updateEvent("e1", { status: "ACTIVE" }, "staff@x");

    const txn = ddb.calls.find((c) => c.name === "TransactWriteCommand");
    assert.ok(txn);
    assert.equal(txn.input.TransactItems.length, 2);

    // 0: lock Put with attribute_not_exists
    const lockPut = txn.input.TransactItems[0].Put;
    assert.equal(lockPut.Item.PK, "EVENTDATE");
    assert.equal(lockPut.Item.SK, "DATE#2026-05-09");
    assert.equal(lockPut.Item.eventId, "e1");
    assert.equal(
      lockPut.ConditionExpression,
      "attribute_not_exists(PK) AND attribute_not_exists(SK)"
    );

    // 1: event update with status=ACTIVE
    const eventUpdate = txn.input.TransactItems[1].Update;
    assert.equal(eventUpdate.ExpressionAttributeValues[":status"], "ACTIVE");

    assert.equal(frequentCalls.length, 1, "createFrequentReservationsForEvent was called");
  });

  it("TransactionCanceledException → 409 'event already exists for date'", async () => {
    const txnErr = new Error("conflict");
    txnErr.name = "TransactionCanceledException";
    const ddb = makeFakeDdb({
      getResponses: [
        { Item: { eventId: "e1", eventDate: "2026-05-09", status: "INACTIVE" } },
      ],
      throwOnCommand: { TransactWriteCommand: txnErr },
    });
    const { svc } = buildService({ ddb });
    await assert.rejects(
      () => svc.updateEvent("e1", { status: "ACTIVE" }, "u"),
      (err) =>
        err?.statusCode === 409 && /already exists for 2026-05-09/.test(err.message)
    );
  });
});

describe("updateEvent (generic field updates, no status transition)", () => {
  it("issues a plain UpdateCommand with the provided allowed fields", async () => {
    const ddb = makeFakeDdb({
      getResponses: [
        { Item: { eventId: "e1", eventDate: "2026-05-09", status: "ACTIVE" } },
      ],
    });
    const { svc } = buildService({ ddb });
    await svc.updateEvent("e1", { eventName: "New Name", minDeposit: 75 }, "u");

    const update = ddb.calls.find((c) => c.name === "UpdateCommand");
    assert.ok(update);
    assert.match(update.input.UpdateExpression, /#eventName = :eventName/);
    assert.match(update.input.UpdateExpression, /#minDeposit = :minDeposit/);
    assert.equal(update.input.ExpressionAttributeValues[":eventName"], "New Name");
    assert.equal(update.input.ExpressionAttributeValues[":minDeposit"], 75);
    assert.equal(update.input.ExpressionAttributeValues[":updatedAt"], FIXED_NOW);
  });
});

// ---------------------------------------------------------------------------
// deleteEvent
// ---------------------------------------------------------------------------

describe("deleteEvent", () => {
  it("no-ops when event doesn't exist (silent return)", async () => {
    const ddb = makeFakeDdb({ getResponses: [{ Item: null }] });
    const { svc } = buildService({ ddb });
    await svc.deleteEvent("e1"); // should not throw
    // Only the Get call, no Delete/Transact
    assert.equal(ddb.calls.length, 1);
    assert.equal(ddb.calls[0].name, "GetCommand");
  });

  it("ACTIVE: deletes both event row + EVENTDATE lock atomically", async () => {
    const ddb = makeFakeDdb({
      getResponses: [{ Item: { eventId: "e1", eventDate: "2026-05-09", status: "ACTIVE" } }],
    });
    const { svc } = buildService({ ddb });
    await svc.deleteEvent("e1");

    const txn = ddb.calls.find((c) => c.name === "TransactWriteCommand");
    assert.ok(txn);
    assert.equal(txn.input.TransactItems.length, 2);

    const eventDelete = txn.input.TransactItems[0].Delete;
    assert.equal(eventDelete.Key.SK, "EVENT#e1");

    const lockDelete = txn.input.TransactItems[1].Delete;
    assert.equal(lockDelete.Key.PK, "EVENTDATE");
    assert.equal(lockDelete.Key.SK, "DATE#2026-05-09");
    assert.equal(lockDelete.ConditionExpression, "eventId = :eid");
    assert.equal(lockDelete.ExpressionAttributeValues[":eid"], "e1");
  });

  it("INACTIVE: just deletes the event row (no lock to remove)", async () => {
    const ddb = makeFakeDdb({
      getResponses: [{ Item: { eventId: "e1", eventDate: "2026-05-09", status: "INACTIVE" } }],
    });
    const { svc } = buildService({ ddb });
    await svc.deleteEvent("e1");

    // No TransactWrite — just a single DeleteCommand
    assert.equal(
      ddb.calls.filter((c) => c.name === "TransactWriteCommand").length,
      0
    );
    const del = ddb.calls.find((c) => c.name === "DeleteCommand");
    assert.ok(del);
    assert.equal(del.input.Key.SK, "EVENT#e1");
  });
});
