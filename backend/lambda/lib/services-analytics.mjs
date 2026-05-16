// Marketing-analytics aggregation for /admin/analytics (Layer 2 dashboard).
//
// Two data sources stitched together:
//
// 1. **Daily visit counters** in HOLDS_TABLE under
//    (PK="ANALYTICS", SK="VISIT#YYYY-MM-DD#utm_source"). Each row stores
//    a `count` attribute that we ADD-increment via UpdateCommand on
//    every `map_loaded` telemetry hit. utm_source defaults to "(none)"
//    when the visit had no attribution params — counted as organic.
//    O(1) read + write, predictable cost (~0.0000013/visit), and no
//    CloudWatch Insights query latency to wait on at render time.
//
// 2. **Reservation rollups** from ff-reservations. Scanned by event-date
//    partitions in the requested window so we can group by
//    attribution.utm_source and sum depositAmount. Volume is small at
//    our scale (a few hundred reservations/week) — scan cost is in the
//    pennies-per-month range. If volume grows past a few thousand rows
//    per scan we'll want a GSI on attribution.utm_source.
//
// Conversion rate is computed in-memory at read time:
//   conversionRate = paidBookings / visits
// Sources with 0 visits but >0 bookings (e.g. legacy reservations created
// before Layer 2 shipped) show conversionRate=null rather than infinity.

import {
  GetCommand,
  QueryCommand,
  UpdateCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";

const ANALYTICS_PK = "ANALYTICS";
const VISIT_SK_PREFIX = "VISIT#";
const ORGANIC_BUCKET = "(none)";

function sanitizeSourceBucket(raw) {
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s) return ORGANIC_BUCKET;
  // Mirror the FE/BE attribution validator — only safe chars + max 60
  // (counter key length is bounded so the row size stays small).
  return s.replace(/[^a-z0-9_.-]/g, "").slice(0, 60) || ORGANIC_BUCKET;
}

function isoDateUtc(epochMs) {
  return new Date(epochMs).toISOString().slice(0, 10);
}

export function createAnalyticsService({ ddb, tableNames, nowEpoch, httpError }) {
  const holdsTable = String(tableNames?.HOLDS_TABLE ?? "").trim();
  const resTable = String(tableNames?.RES_TABLE ?? "").trim();

  // Fire-and-forget counter increment. Called by the telemetry handler
  // when a `map_loaded` event arrives. We treat one map_loaded per
  // session per day as a "visit"; the telemetry handler dedupes by
  // sessionId before calling — see the precondition note in routes.
  async function recordVisit({ utmSource, dateUtc }) {
    if (!holdsTable) {
      throw httpError(500, "HOLDS_TABLE is not configured");
    }
    const source = sanitizeSourceBucket(utmSource);
    const date =
      typeof dateUtc === "string" && /^\d{4}-\d{2}-\d{2}$/.test(dateUtc)
        ? dateUtc
        : isoDateUtc(nowEpoch() * 1000);
    await ddb.send(
      new UpdateCommand({
        TableName: holdsTable,
        Key: { PK: ANALYTICS_PK, SK: `${VISIT_SK_PREFIX}${date}#${source}` },
        UpdateExpression:
          "ADD #c :one SET #d = :d, #s = :s, #u = :now, entityType = :et",
        ExpressionAttributeNames: {
          "#c": "count",
          "#d": "date",
          "#s": "source",
          "#u": "updatedAt",
        },
        ExpressionAttributeValues: {
          ":one": 1,
          ":d": date,
          ":s": source,
          ":now": nowEpoch(),
          ":et": "ANALYTICS_VISIT",
        },
      })
    );
  }

  // Read all visit counters for the inclusive date range. Returns
  // { byDate: { date: { source: count } }, bySource: { source: count }, total }.
  async function readVisits({ startDate, endDate }) {
    if (!holdsTable) {
      throw httpError(500, "HOLDS_TABLE is not configured");
    }
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(startDate) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(endDate)
    ) {
      throw httpError(400, "startDate and endDate must be YYYY-MM-DD");
    }
    // Single Query over PK=ANALYTICS with SK BETWEEN bounds. Sorted
    // lexicographically by SK = "VISIT#date#source" so we walk the
    // partition once.
    const out = await ddb.send(
      new QueryCommand({
        TableName: holdsTable,
        KeyConditionExpression: "#pk = :pk AND SK BETWEEN :lo AND :hi",
        ExpressionAttributeNames: { "#pk": "PK" },
        ExpressionAttributeValues: {
          ":pk": ANALYTICS_PK,
          ":lo": `${VISIT_SK_PREFIX}${startDate}#`,
          // ￿ sorts after any printable suffix — safe upper bound
          ":hi": `${VISIT_SK_PREFIX}${endDate}#￿`,
        },
      })
    );
    const items = Array.isArray(out?.Items) ? out.Items : [];
    const byDate = {};
    const bySource = {};
    let total = 0;
    for (const it of items) {
      const date = String(it?.date ?? "").trim();
      const source = String(it?.source ?? "").trim() || ORGANIC_BUCKET;
      const count = Number(it?.count ?? 0);
      if (!date || !Number.isFinite(count) || count <= 0) continue;
      if (!byDate[date]) byDate[date] = {};
      byDate[date][source] = (byDate[date][source] ?? 0) + count;
      bySource[source] = (bySource[source] ?? 0) + count;
      total += count;
    }
    return { byDate, bySource, total };
  }

  // Reservation rollups across the date window. Scans ff-reservations
  // with a FilterExpression on the SK prefix; for our scale (few hundred
  // rows/week) scan is fine. Returns rollups split by attribution source.
  async function readBookings({ startDate, endDate }) {
    if (!resTable) {
      throw httpError(500, "RES_TABLE is not configured");
    }
    // Scan with a SK begins_with("RES#") filter — pulls only the actual
    // reservation rows, skipping HIST# / SLUG / CODE partitions in the
    // same table.
    const items = [];
    let exclusiveStartKey;
    do {
      const out = await ddb.send(
        new ScanCommand({
          TableName: resTable,
          FilterExpression:
            "begins_with(SK, :rs) AND #pk BETWEEN :lo AND :hi",
          ExpressionAttributeNames: { "#pk": "PK" },
          ExpressionAttributeValues: {
            ":rs": "RES#",
            ":lo": `EVENTDATE#${startDate}`,
            ":hi": `EVENTDATE#${endDate}￿`,
          },
          ExclusiveStartKey: exclusiveStartKey,
        })
      );
      const got = Array.isArray(out?.Items) ? out.Items : [];
      items.push(...got);
      exclusiveStartKey = out?.LastEvaluatedKey;
    } while (exclusiveStartKey);

    // Aggregate by source. Reservations without an `attribution` field
    // (legacy + staff-created) bucket as "(none)". Status=CANCELLED
    // counts as a started-but-not-paid booking.
    const bySource = {};
    const ensureBucket = (src) => {
      if (!bySource[src]) {
        bySource[src] = {
          bookingsStarted: 0,
          bookingsPaid: 0,
          bookingsCancelled: 0,
          depositRevenue: 0,
        };
      }
      return bySource[src];
    };
    for (const it of items) {
      const attribution =
        it?.attribution && typeof it.attribution === "object"
          ? it.attribution
          : null;
      const source = sanitizeSourceBucket(attribution?.utm_source);
      const bucket = ensureBucket(source);
      bucket.bookingsStarted += 1;
      const paymentStatus = String(it?.paymentStatus ?? "").toUpperCase();
      const status = String(it?.status ?? "").toUpperCase();
      // Count as "paid won customer" only when PAID + not CANCELLED.
      // Mid-flow PAID + CANCELLED (briefly between charge + refund) or
      // PAID + CANCELLED-without-refund both represent revenue we no
      // longer have — exclude from the headline number so admin sees
      // *current* won customers, not gross historical charges. The
      // refund / cancellation reasons stay visible in financials.
      if (paymentStatus === "PAID" && status !== "CANCELLED") {
        bucket.bookingsPaid += 1;
        bucket.depositRevenue += Number(it?.depositAmount ?? 0);
      }
      if (status === "CANCELLED") bucket.bookingsCancelled += 1;
    }
    return { bySource, total: items.length };
  }

  // Stitch visits + bookings into the per-source rows the FE renders.
  // Conversion rate = paid / visits; null if visits=0 (legacy bookings
  // without an originating visit recorded — common during the cutover
  // week).
  async function getAnalyticsSummary({ startDate, endDate }) {
    const [visits, bookings] = await Promise.all([
      readVisits({ startDate, endDate }),
      readBookings({ startDate, endDate }),
    ]);
    const sources = new Set([
      ...Object.keys(visits.bySource),
      ...Object.keys(bookings.bySource),
    ]);
    if (sources.size === 0) sources.add(ORGANIC_BUCKET);
    const rows = [];
    let totalVisits = 0;
    let totalBookingsStarted = 0;
    let totalBookingsPaid = 0;
    let totalRevenue = 0;
    for (const source of sources) {
      const v = visits.bySource[source] ?? 0;
      const b = bookings.bySource[source] ?? {
        bookingsStarted: 0,
        bookingsPaid: 0,
        bookingsCancelled: 0,
        depositRevenue: 0,
      };
      rows.push({
        source,
        visits: v,
        bookingsStarted: b.bookingsStarted,
        bookingsPaid: b.bookingsPaid,
        bookingsCancelled: b.bookingsCancelled,
        depositRevenue: Number((b.depositRevenue ?? 0).toFixed(2)),
        conversionRate:
          v > 0
            ? Number((b.bookingsPaid / v).toFixed(4))
            : null,
      });
      totalVisits += v;
      totalBookingsStarted += b.bookingsStarted;
      totalBookingsPaid += b.bookingsPaid;
      totalRevenue += b.depositRevenue ?? 0;
    }
    // Sort: paid revenue desc, then visits desc, then source asc.
    rows.sort((a, b) => {
      if (b.depositRevenue !== a.depositRevenue) {
        return b.depositRevenue - a.depositRevenue;
      }
      if (b.visits !== a.visits) return b.visits - a.visits;
      return a.source.localeCompare(b.source);
    });
    return {
      startDate,
      endDate,
      rows,
      totals: {
        visits: totalVisits,
        bookingsStarted: totalBookingsStarted,
        bookingsPaid: totalBookingsPaid,
        depositRevenue: Number(totalRevenue.toFixed(2)),
        conversionRate:
          totalVisits > 0
            ? Number((totalBookingsPaid / totalVisits).toFixed(4))
            : null,
      },
      byDate: visits.byDate,
      generatedAt: nowEpoch(),
    };
  }

  return {
    recordVisit,
    readVisits,
    readBookings,
    getAnalyticsSummary,
    // exposed for tests
    _sanitizeSourceBucket: sanitizeSourceBucket,
    _ORGANIC_BUCKET: ORGANIC_BUCKET,
  };
}
