import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createAnalyticsService } from "./services-analytics.mjs";

function makeFakeDdb() {
  const sends = [];
  let queryItems = [];
  let scanPages = [[]];
  return {
    sends,
    setQueryItems(items) {
      queryItems = items;
    },
    setScanPages(pages) {
      scanPages = pages;
    },
    send: async (cmd) => {
      sends.push(cmd);
      const ctor = cmd?.constructor?.name ?? "";
      if (ctor === "QueryCommand") return { Items: queryItems };
      if (ctor === "ScanCommand") {
        const page = scanPages.shift() ?? [];
        return { Items: page, LastEvaluatedKey: scanPages.length > 0 ? { x: 1 } : undefined };
      }
      return {};
    },
  };
}

const httpError = (status, message) => {
  const err = new Error(message);
  err.statusCode = status;
  return err;
};

describe("services-analytics", () => {
  describe("sanitizeSourceBucket", () => {
    let svc;
    beforeEach(() => {
      svc = createAnalyticsService({
        ddb: makeFakeDdb(),
        tableNames: { HOLDS_TABLE: "ff-holds", RES_TABLE: "ff-res" },
        nowEpoch: () => 1_000_000,
        httpError,
      });
    });

    it("returns (none) for empty/null source (organic bucket)", () => {
      assert.equal(svc._sanitizeSourceBucket(""), "(none)");
      assert.equal(svc._sanitizeSourceBucket(null), "(none)");
      assert.equal(svc._sanitizeSourceBucket(undefined), "(none)");
    });

    it("lowercases known sources", () => {
      assert.equal(svc._sanitizeSourceBucket("Meta"), "meta");
      assert.equal(svc._sanitizeSourceBucket("GOOGLE_ADS"), "google_ads");
    });

    it("strips unsafe chars so the SK stays small + safe", () => {
      assert.equal(svc._sanitizeSourceBucket("meta<script>"), "metascript");
      assert.equal(
        svc._sanitizeSourceBucket("meta\nads"),
        "metaads"
      );
    });

    it("caps at 60 chars", () => {
      const huge = "x".repeat(200);
      assert.equal(svc._sanitizeSourceBucket(huge).length, 60);
    });
  });

  describe("recordVisit", () => {
    let ddb;
    let svc;
    beforeEach(() => {
      ddb = makeFakeDdb();
      svc = createAnalyticsService({
        ddb,
        tableNames: { HOLDS_TABLE: "ff-holds", RES_TABLE: "ff-res" },
        nowEpoch: () => 1_000_000,
        httpError,
      });
    });

    it("ADD-increments the counter row at PK=ANALYTICS SK=VISIT#date#source", async () => {
      await svc.recordVisit({ utmSource: "meta", dateUtc: "2026-05-16" });
      assert.equal(ddb.sends.length, 1);
      const cmd = ddb.sends[0].input;
      assert.equal(cmd.Key.PK, "ANALYTICS");
      assert.equal(cmd.Key.SK, "VISIT#2026-05-16#meta");
      assert.match(cmd.UpdateExpression, /ADD #c :one/);
      assert.equal(cmd.ExpressionAttributeValues[":one"], 1);
      assert.equal(cmd.ExpressionAttributeValues[":s"], "meta");
      assert.equal(cmd.ExpressionAttributeValues[":d"], "2026-05-16");
    });

    it("falls back to (none) when source is empty", async () => {
      await svc.recordVisit({ utmSource: "", dateUtc: "2026-05-16" });
      const cmd = ddb.sends[0].input;
      assert.equal(cmd.Key.SK, "VISIT#2026-05-16#(none)");
    });
  });

  describe("readVisits", () => {
    let ddb;
    let svc;
    beforeEach(() => {
      ddb = makeFakeDdb();
      svc = createAnalyticsService({
        ddb,
        tableNames: { HOLDS_TABLE: "ff-holds", RES_TABLE: "ff-res" },
        nowEpoch: () => 1_000_000,
        httpError,
      });
    });

    it("aggregates returned rows into byDate + bySource + total", async () => {
      ddb.setQueryItems([
        { date: "2026-05-15", source: "meta", count: 30 },
        { date: "2026-05-15", source: "(none)", count: 10 },
        { date: "2026-05-16", source: "meta", count: 70 },
        { date: "2026-05-16", source: "google", count: 5 },
      ]);
      const result = await svc.readVisits({
        startDate: "2026-05-15",
        endDate: "2026-05-16",
      });
      assert.equal(result.total, 115);
      assert.equal(result.bySource.meta, 100);
      assert.equal(result.bySource.google, 5);
      assert.equal(result.bySource["(none)"], 10);
      assert.deepEqual(result.byDate["2026-05-15"], { meta: 30, "(none)": 10 });
    });

    it("rejects malformed date inputs", async () => {
      await assert.rejects(
        () => svc.readVisits({ startDate: "bad", endDate: "2026-05-16" })
      );
    });
  });

  describe("readBookings + summary", () => {
    let ddb;
    let svc;
    beforeEach(() => {
      ddb = makeFakeDdb();
      svc = createAnalyticsService({
        ddb,
        tableNames: { HOLDS_TABLE: "ff-holds", RES_TABLE: "ff-res" },
        nowEpoch: () => 1_000_000,
        httpError,
      });
    });

    it("buckets reservations by attribution.utm_source and sums revenue on PAID", async () => {
      ddb.setQueryItems([
        { date: "2026-05-16", source: "meta", count: 50 },
        { date: "2026-05-16", source: "(none)", count: 20 },
      ]);
      ddb.setScanPages([
        [
          {
            paymentStatus: "PAID",
            status: "CONFIRMED",
            depositAmount: 50,
            attribution: { utm_source: "meta" },
          },
          {
            paymentStatus: "PAID",
            status: "CONFIRMED",
            depositAmount: 30,
            attribution: { utm_source: "meta" },
          },
          {
            paymentStatus: "PENDING",
            status: "CONFIRMED",
            depositAmount: 0,
            attribution: { utm_source: "meta" },
          },
          {
            paymentStatus: "PAID",
            status: "CONFIRMED",
            depositAmount: 20,
            // No attribution → bucketed as (none).
          },
          {
            paymentStatus: "PAID",
            status: "CANCELLED",
            depositAmount: 10,
            attribution: { utm_source: "google" },
          },
        ],
      ]);
      const summary = await svc.getAnalyticsSummary({
        startDate: "2026-05-16",
        endDate: "2026-05-16",
      });
      // 3 sources: meta, (none), google
      const byName = Object.fromEntries(summary.rows.map((r) => [r.source, r]));
      assert.equal(byName.meta.visits, 50);
      assert.equal(byName.meta.bookingsStarted, 3);
      assert.equal(byName.meta.bookingsPaid, 2);
      assert.equal(byName.meta.depositRevenue, 80);
      assert.equal(byName.meta.conversionRate, 0.04); // 2 / 50

      assert.equal(byName["(none)"].visits, 20);
      assert.equal(byName["(none)"].bookingsPaid, 1);
      assert.equal(byName["(none)"].depositRevenue, 20);

      // Google: 0 visits, 1 paid (cancelled) — conversionRate null when no visits
      assert.equal(byName.google.visits, 0);
      assert.equal(byName.google.bookingsCancelled, 1);
      assert.equal(byName.google.conversionRate, null);

      assert.equal(summary.totals.visits, 70);
      // 3 paid won (2 meta + 1 none); the google PAID+CANCELLED row is
      // excluded — we count only currently-won customers, not historical
      // gross charges that were refunded/cancelled.
      assert.equal(summary.totals.bookingsPaid, 3);
      assert.equal(summary.totals.depositRevenue, 100);
    });

    it("sorts rows by revenue desc, then visits desc, then source asc", async () => {
      ddb.setQueryItems([
        { date: "2026-05-16", source: "meta", count: 100 },
        { date: "2026-05-16", source: "google", count: 100 },
      ]);
      ddb.setScanPages([
        [
          { paymentStatus: "PAID", status: "CONFIRMED", depositAmount: 100, attribution: { utm_source: "google" } },
          { paymentStatus: "PAID", status: "CONFIRMED", depositAmount: 50, attribution: { utm_source: "meta" } },
        ],
      ]);
      const summary = await svc.getAnalyticsSummary({
        startDate: "2026-05-16",
        endDate: "2026-05-16",
      });
      assert.equal(summary.rows[0].source, "google"); // higher revenue
      assert.equal(summary.rows[1].source, "meta");
    });

    it("returns at least one organic row when no data exists", async () => {
      ddb.setQueryItems([]);
      ddb.setScanPages([[]]);
      const summary = await svc.getAnalyticsSummary({
        startDate: "2026-05-16",
        endDate: "2026-05-16",
      });
      assert.equal(summary.rows.length, 1);
      assert.equal(summary.rows[0].source, "(none)");
      assert.equal(summary.rows[0].visits, 0);
      assert.equal(summary.rows[0].bookingsPaid, 0);
    });
  });
});
