import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  createPresenceService,
  eventToPresenceStage,
} from "./services-presence.mjs";

function makeFakeDdb() {
  const sends = [];
  let nextQueryResult = { Items: [] };
  return {
    sends,
    setQueryResult(items) {
      nextQueryResult = { Items: items };
    },
    send: async (cmd) => {
      sends.push(cmd);
      const ctor = cmd?.constructor?.name ?? "";
      if (ctor === "QueryCommand") return nextQueryResult;
      return {};
    },
  };
}

const httpError = (status, message) => {
  const err = new Error(message);
  err.statusCode = status;
  return err;
};

describe("services-presence", () => {
  describe("eventToPresenceStage", () => {
    it("maps map_loaded → map", () => {
      assert.equal(eventToPresenceStage("map_loaded"), "map");
    });
    it("maps map_heartbeat → map (the live-presence signal)", () => {
      assert.equal(eventToPresenceStage("map_heartbeat"), "map");
    });
    it("maps modal_redirect_to_square → checkout", () => {
      assert.equal(eventToPresenceStage("modal_redirect_to_square"), "checkout");
    });
    it("maps r_page_loaded → paid_landing", () => {
      assert.equal(eventToPresenceStage("r_page_loaded"), "paid_landing");
    });
    it("returns null for unrelated events", () => {
      assert.equal(eventToPresenceStage("auth_renew_succeeded"), null);
      assert.equal(eventToPresenceStage("find_modal_opened"), null);
      assert.equal(eventToPresenceStage(""), null);
      assert.equal(eventToPresenceStage(undefined), null);
    });
  });

  describe("recordPresence", () => {
    let ddb;
    let svc;
    beforeEach(() => {
      ddb = makeFakeDdb();
      svc = createPresenceService({
        ddb,
        tableNames: { HOLDS_TABLE: "ff-table-holds" },
        nowEpoch: () => 1_000_000,
        httpError,
      });
    });

    it("writes a single row keyed by sessionId with TTL = now + 90s", async () => {
      await svc.recordPresence({ sessionId: "sess-abc", stage: "map" });
      assert.equal(ddb.sends.length, 1);
      const item = ddb.sends[0].input.Item;
      assert.equal(item.PK, "PRESENCE");
      assert.equal(item.SK, "SESSION#sess-abc");
      assert.equal(item.stage, "map");
      assert.equal(item.updatedAt, 1_000_000);
      assert.equal(item.expiresAt, 1_000_000 + 90);
    });

    it("silently ignores empty sessionId (telemetry must not break flow)", async () => {
      await svc.recordPresence({ sessionId: "", stage: "map" });
      await svc.recordPresence({ sessionId: undefined, stage: "map" });
      assert.equal(ddb.sends.length, 0);
    });

    it("silently ignores unknown stages", async () => {
      await svc.recordPresence({ sessionId: "sess-abc", stage: "bogus" });
      await svc.recordPresence({ sessionId: "sess-abc", stage: "" });
      assert.equal(ddb.sends.length, 0);
    });

    it("includes eventDate and ip when provided", async () => {
      await svc.recordPresence({
        sessionId: "sess-1",
        stage: "modal",
        eventDate: "2026-05-16",
        ip: "203.0.113.1",
      });
      const item = ddb.sends[0].input.Item;
      assert.equal(item.eventDate, "2026-05-16");
      assert.equal(item.ip, "203.0.113.1");
    });
  });

  describe("listPresence", () => {
    let ddb;
    let svc;
    beforeEach(() => {
      ddb = makeFakeDdb();
      svc = createPresenceService({
        ddb,
        tableNames: { HOLDS_TABLE: "ff-table-holds" },
        nowEpoch: () => 1_000_000,
        httpError,
      });
    });

    it("returns count + byStage breakdown for live rows only", async () => {
      ddb.setQueryResult([
        { SK: "SESSION#a", stage: "map", expiresAt: 1_000_050 },
        { SK: "SESSION#b", stage: "map", expiresAt: 1_000_050 },
        { SK: "SESSION#c", stage: "modal", expiresAt: 1_000_050 },
        { SK: "SESSION#d", stage: "checkout", expiresAt: 1_000_050 },
        { SK: "SESSION#e", stage: "paid_landing", expiresAt: 1_000_050 },
      ]);
      const result = await svc.listPresence();
      assert.equal(result.count, 5);
      assert.deepEqual(result.byStage, {
        map: 2,
        modal: 1,
        checkout: 1,
        paid_landing: 1,
      });
      assert.equal(result.updatedAt, 1_000_000);
    });

    it("filters out rows whose expiresAt has passed (DDB TTL lag guard)", async () => {
      ddb.setQueryResult([
        { SK: "SESSION#a", stage: "map", expiresAt: 1_000_050 }, // live
        { SK: "SESSION#b", stage: "map", expiresAt: 999_999 }, // expired
        { SK: "SESSION#c", stage: "modal", expiresAt: 999_000 }, // expired
      ]);
      const result = await svc.listPresence();
      assert.equal(result.count, 1);
      assert.deepEqual(result.byStage, {
        map: 1,
        modal: 0,
        checkout: 0,
        paid_landing: 0,
      });
    });

    it("returns zero counts when no rows exist", async () => {
      ddb.setQueryResult([]);
      const result = await svc.listPresence();
      assert.equal(result.count, 0);
      assert.deepEqual(result.byStage, {
        map: 0,
        modal: 0,
        checkout: 0,
        paid_landing: 0,
      });
    });

    it("ignores rows with unknown stages in the bucket count but still totals them", async () => {
      ddb.setQueryResult([
        { SK: "SESSION#a", stage: "map", expiresAt: 1_000_050 },
        { SK: "SESSION#b", stage: "garbage", expiresAt: 1_000_050 },
      ]);
      const result = await svc.listPresence();
      assert.equal(result.count, 2);
      assert.deepEqual(result.byStage, {
        map: 1,
        modal: 0,
        checkout: 0,
        paid_landing: 0,
      });
    });
  });
});
