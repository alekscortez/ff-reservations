// Tests for routes-events.mjs (events CRUD + table state + the
// public availability endpoint). The public availability path is
// the most-trafficked unauthenticated route — it composes events,
// tables, locks, and frequent-table disable into a single response.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { handleEventsAndTablesRoute } from "./routes-events.mjs";

const TABLE_TEMPLATE = {
  sections: ["A", "B", "C", "D", "E"],
  tables: [
    { id: "A1", number: 1, section: "A", price: 100 },
    { id: "B1", number: 2, section: "B", price: 200 },
  ],
};

function makeCtx(overrides = {}) {
  const calls = {
    json: [],
    requireAdmin: [],
    requireStaffOrAdmin: [],
    getBody: [],
    listEvents: [],
    getEventByDate: [],
    listTableLocks: [],
    listReservations: [],
    getDisabledTablesFromFrequent: [],
    getEffectiveTables: [],
    createEvent: [],
    getEventById: [],
    updateEvent: [],
    deleteEvent: [],
    getAppSettings: [],
    resolveBusinessDate: [],
  };
  return {
    calls,
    ctx: {
      method: overrides.method ?? "GET",
      path: overrides.path ?? "/events",
      event: overrides.event ?? {},
      cors: { "Access-Control-Allow-Origin": "*" },
      TABLE_TEMPLATE: overrides.TABLE_TEMPLATE ?? TABLE_TEMPLATE,
      json: (status, body, cors) => {
        calls.json.push({ status, body, cors });
        return { statusCode: status, body, cors };
      },
      noContent: (status, cors) => ({ statusCode: status, cors }),
      getBody: (event) => {
        calls.getBody.push(event);
        return overrides.body !== undefined ? overrides.body : null;
      },
      requireAdmin: (event) => {
        calls.requireAdmin.push(event);
        if (overrides.requireAdminThrows) throw overrides.requireAdminThrows;
      },
      requireStaffOrAdmin: (event) => {
        calls.requireStaffOrAdmin.push(event);
        if (overrides.requireStaffOrAdminThrows) throw overrides.requireStaffOrAdminThrows;
      },
      getUserLabel: async () => overrides.userLabel ?? "admin@x",
      listEvents: async () => {
        calls.listEvents.push(true);
        return overrides.events ?? [];
      },
      getEventByDate: async (date) => {
        calls.getEventByDate.push(date);
        return overrides.eventForDate ?? null;
      },
      listTableLocks: async (date) => {
        calls.listTableLocks.push(date);
        return overrides.locks ?? [];
      },
      listReservations: async (date) => {
        calls.listReservations.push(date);
        return overrides.reservations ?? [];
      },
      releaseOverdueReservationsForEventDate: async () => {},
      getDisabledTablesFromFrequent: async (eventRecord) => {
        calls.getDisabledTablesFromFrequent.push(eventRecord);
        return overrides.disabledTables ?? new Set();
      },
      getEffectiveTables: (eventRecord, disabled) => {
        calls.getEffectiveTables.push({ eventRecord, disabled });
        return (
          overrides.effectiveTables ??
          TABLE_TEMPLATE.tables.map((t) => ({ ...t, disabled: false }))
        );
      },
      createEvent: async (payload, user) => {
        calls.createEvent.push({ payload, user });
        return overrides.createResult ?? { eventId: "new" };
      },
      getEventById: async (id) => {
        calls.getEventById.push(id);
        return overrides.eventById ?? null;
      },
      updateEvent: async (id, body, user) => {
        calls.updateEvent.push({ id, body, user });
        return overrides.updateResult ?? { eventId: id };
      },
      deleteEvent: async (id) => {
        calls.deleteEvent.push(id);
      },
      getAppSettings: async () => {
        calls.getAppSettings.push(true);
        return (
          overrides.settings ?? {
            showClientFacingMap: false,
            tableAvailabilityPollingSeconds: 10,
          }
        );
      },
      resolveBusinessDate: async () => {
        calls.resolveBusinessDate.push(true);
        return overrides.businessCtx ?? { businessDate: "2026-05-09" };
      },
    },
  };
}

describe("handleEventsAndTablesRoute — path mismatch", () => {
  it("returns null on unrelated path", async () => {
    const { ctx } = makeCtx({ method: "GET", path: "/other" });
    assert.equal(await handleEventsAndTablesRoute(ctx), null);
  });
});

describe("GET /events", () => {
  it("requireStaffOrAdmin + returns wrapped { items }", async () => {
    const { ctx, calls } = makeCtx({
      method: "GET",
      path: "/events",
      events: [{ eventId: "e1" }],
    });
    const res = await handleEventsAndTablesRoute(ctx);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.items.length, 1);
    assert.equal(calls.requireStaffOrAdmin.length, 1);
  });
});

describe("GET /tables/template", () => {
  it("requireStaffOrAdmin + returns the static template", async () => {
    const { ctx } = makeCtx({ method: "GET", path: "/tables/template" });
    const res = await handleEventsAndTablesRoute(ctx);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.template, TABLE_TEMPLATE);
  });
});

describe("GET /tables/for-event/{date}", () => {
  it("404 when no event for date", async () => {
    const { ctx } = makeCtx({
      method: "GET",
      path: "/tables/for-event/2026-05-09",
      eventForDate: null,
    });
    const res = await handleEventsAndTablesRoute(ctx);
    assert.equal(res.statusCode, 404);
  });

  it("composes event + tables (with status from locks)", async () => {
    const { ctx } = makeCtx({
      method: "GET",
      path: "/tables/for-event/2026-05-09",
      eventForDate: { eventId: "e1", eventDate: "2026-05-09" },
      locks: [
        { SK: "TABLE#A1", lockType: "RESERVED", reservationId: "r1" },
      ],
      reservations: [{ reservationId: "r1", paymentStatus: "PAID" }],
    });
    const res = await handleEventsAndTablesRoute(ctx);
    assert.equal(res.statusCode, 200);
    const t1 = res.body.tables.find((t) => t.id === "A1");
    assert.equal(t1.status, "RESERVED");
    const t2 = res.body.tables.find((t) => t.id === "B1");
    assert.equal(t2.status, "AVAILABLE");
  });

  it("PARTIAL/PENDING reservation → status PENDING_PAYMENT", async () => {
    const { ctx } = makeCtx({
      method: "GET",
      path: "/tables/for-event/2026-05-09",
      eventForDate: { eventId: "e1" },
      locks: [
        { SK: "TABLE#A1", lockType: "RESERVED", reservationId: "r1" },
      ],
      reservations: [{ reservationId: "r1", paymentStatus: "PARTIAL" }],
    });
    const res = await handleEventsAndTablesRoute(ctx);
    const t1 = res.body.tables.find((t) => t.id === "A1");
    assert.equal(t1.status, "PENDING_PAYMENT");
  });

  it("HOLD lock → status HOLD", async () => {
    const { ctx } = makeCtx({
      method: "GET",
      path: "/tables/for-event/2026-05-09",
      eventForDate: { eventId: "e1" },
      locks: [{ SK: "TABLE#A1", lockType: "HOLD" }],
    });
    const res = await handleEventsAndTablesRoute(ctx);
    const t1 = res.body.tables.find((t) => t.id === "A1");
    assert.equal(t1.status, "HOLD");
  });

  it("disabled table → DISABLED status (no lock present)", async () => {
    const { ctx } = makeCtx({
      method: "GET",
      path: "/tables/for-event/2026-05-09",
      eventForDate: { eventId: "e1" },
      effectiveTables: [
        { id: "A1", number: 1, section: "A", price: 100, disabled: true },
      ],
    });
    const res = await handleEventsAndTablesRoute(ctx);
    assert.equal(res.body.tables[0].status, "DISABLED");
  });
});

describe("GET /public/availability (no auth)", () => {
  it("404 when settings.showClientFacingMap=false", async () => {
    const { ctx } = makeCtx({
      method: "GET",
      path: "/public/availability",
      settings: { showClientFacingMap: false },
    });
    const res = await handleEventsAndTablesRoute(ctx);
    assert.equal(res.statusCode, 404);
    assert.match(res.body.message, /not enabled/);
  });

  it("404 when no upcoming ACTIVE events", async () => {
    const { ctx } = makeCtx({
      method: "GET",
      path: "/public/availability",
      settings: { showClientFacingMap: true, tableAvailabilityPollingSeconds: 10 },
      events: [], // no events
    });
    const res = await handleEventsAndTablesRoute(ctx);
    assert.equal(res.statusCode, 404);
    assert.match(res.body.message, /No upcoming/);
  });

  it("returns sanitized public table state for the next ACTIVE event", async () => {
    const { ctx } = makeCtx({
      method: "GET",
      path: "/public/availability",
      settings: {
        showClientFacingMap: true,
        tableAvailabilityPollingSeconds: 15,
        sectionMapColors: { A: "#abc" },
      },
      events: [
        { eventId: "e1", eventDate: "2026-05-09", status: "ACTIVE", eventName: "Friday" },
      ],
      eventForDate: { eventId: "e1", eventDate: "2026-05-09", status: "ACTIVE", eventName: "Friday" },
      locks: [{ SK: "TABLE#A1", lockType: "RESERVED" }],
      effectiveTables: [
        { id: "A1", number: 1, section: "A", price: 100, disabled: false },
        { id: "B1", number: 2, section: "B", price: 200, disabled: false },
      ],
    });
    const res = await handleEventsAndTablesRoute(ctx);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.event.eventId, "e1");
    assert.equal(res.body.refreshSeconds, 15);
    assert.deepEqual(res.body.sectionMapColors, { A: "#abc" });
    // **Public table shape**: only id, number, section, price, status, available
    assert.deepEqual(Object.keys(res.body.tables[0]).sort(), [
      "available",
      "id",
      "number",
      "price",
      "section",
      "status",
    ]);
    // Status sanitization: AVAILABLE or UNAVAILABLE only
    for (const t of res.body.tables) {
      assert.ok(["AVAILABLE", "UNAVAILABLE"].includes(t.status));
    }
    assert.equal(res.body.counts.total, 2);
    assert.equal(res.body.counts.available, 1);
    assert.equal(res.body.counts.unavailable, 1);
  });

  it("respects requested eventDate query when it's in the upcoming events", async () => {
    const { ctx, calls } = makeCtx({
      method: "GET",
      path: "/public/availability",
      event: { queryStringParameters: { eventDate: "2026-05-15" } },
      settings: { showClientFacingMap: true, tableAvailabilityPollingSeconds: 10 },
      events: [
        { eventId: "e1", eventDate: "2026-05-09", status: "ACTIVE", eventName: "Today" },
        { eventId: "e2", eventDate: "2026-05-15", status: "ACTIVE", eventName: "Friday" },
      ],
      eventForDate: { eventId: "e2", eventDate: "2026-05-15", status: "ACTIVE", eventName: "Friday" },
    });
    await handleEventsAndTablesRoute(ctx);
    // getEventByDate called with the requested date
    assert.ok(calls.getEventByDate.some((d) => d === "2026-05-15"));
  });

  it("ignores requested eventDate when not in upcoming events (uses earliest)", async () => {
    const { ctx, calls } = makeCtx({
      method: "GET",
      path: "/public/availability",
      event: { queryStringParameters: { eventDate: "2099-01-01" } }, // not in list
      settings: { showClientFacingMap: true, tableAvailabilityPollingSeconds: 10 },
      events: [
        { eventId: "e1", eventDate: "2026-05-09", status: "ACTIVE", eventName: "Today" },
      ],
      eventForDate: { eventId: "e1", eventDate: "2026-05-09", status: "ACTIVE" },
    });
    await handleEventsAndTablesRoute(ctx);
    // Falls back to the earliest upcoming event
    assert.ok(calls.getEventByDate.some((d) => d === "2026-05-09"));
  });

  it("emits customerContactPhoneE164 when configured; omits when empty", async () => {
    // Configured
    {
      const { ctx } = makeCtx({
        method: "GET",
        path: "/public/availability",
        settings: {
          showClientFacingMap: true,
          tableAvailabilityPollingSeconds: 10,
          customerContactPhoneE164: "+18557656160",
        },
        events: [
          { eventId: "e1", eventDate: "2026-05-09", status: "ACTIVE", eventName: "Friday" },
        ],
        eventForDate: { eventId: "e1", eventDate: "2026-05-09", status: "ACTIVE" },
      });
      const res = await handleEventsAndTablesRoute(ctx);
      assert.equal(res.body.customerContactPhoneE164, "+18557656160");
    }
    // Not configured (empty string)
    {
      const { ctx } = makeCtx({
        method: "GET",
        path: "/public/availability",
        settings: {
          showClientFacingMap: true,
          tableAvailabilityPollingSeconds: 10,
          customerContactPhoneE164: "",
        },
        events: [
          { eventId: "e1", eventDate: "2026-05-09", status: "ACTIVE", eventName: "Friday" },
        ],
        eventForDate: { eventId: "e1", eventDate: "2026-05-09", status: "ACTIVE" },
      });
      const res = await handleEventsAndTablesRoute(ctx);
      assert.equal(res.body.customerContactPhoneE164, undefined);
    }
  });

  it("emits anon-booking flags + turnstile site key on /public/availability", async () => {
    // All configured
    {
      const { ctx } = makeCtx({
        method: "GET",
        path: "/public/availability",
        settings: {
          showClientFacingMap: true,
          tableAvailabilityPollingSeconds: 10,
          allowAnonymousPublicBooking: true,
          anonymousMaxTablesPerBooking: 3,
          turnstileSiteKey: "0x4AAAAAAAAA",
        },
        events: [
          { eventId: "e1", eventDate: "2026-05-09", status: "ACTIVE", eventName: "Friday" },
        ],
        eventForDate: { eventId: "e1", eventDate: "2026-05-09", status: "ACTIVE" },
      });
      const res = await handleEventsAndTablesRoute(ctx);
      assert.equal(res.body.allowAnonymousPublicBooking, true);
      assert.equal(res.body.anonymousMaxTablesPerBooking, 3);
      assert.equal(res.body.turnstileSiteKey, "0x4AAAAAAAAA");
    }
    // Disabled + no site key
    {
      const { ctx } = makeCtx({
        method: "GET",
        path: "/public/availability",
        settings: {
          showClientFacingMap: true,
          tableAvailabilityPollingSeconds: 10,
          allowAnonymousPublicBooking: false,
          anonymousMaxTablesPerBooking: 4,
          turnstileSiteKey: "",
        },
        events: [
          { eventId: "e1", eventDate: "2026-05-09", status: "ACTIVE", eventName: "Friday" },
        ],
        eventForDate: { eventId: "e1", eventDate: "2026-05-09", status: "ACTIVE" },
      });
      const res = await handleEventsAndTablesRoute(ctx);
      assert.equal(res.body.allowAnonymousPublicBooking, false);
      assert.equal(res.body.anonymousMaxTablesPerBooking, 4);
      assert.equal(res.body.turnstileSiteKey, undefined);
    }
  });
});

describe("POST /events (admin)", () => {
  it("requireAdmin first", async () => {
    const denied = Object.assign(new Error("forbidden"), { statusCode: 403 });
    const { ctx, calls } = makeCtx({
      method: "POST",
      path: "/events",
      requireAdminThrows: denied,
    });
    await assert.rejects(
      () => handleEventsAndTablesRoute(ctx),
      (err) => err?.statusCode === 403
    );
    assert.equal(calls.createEvent.length, 0);
  });

  it("400 on bad JSON", async () => {
    const { ctx } = makeCtx({
      method: "POST",
      path: "/events",
      body: null,
    });
    const res = await handleEventsAndTablesRoute(ctx);
    assert.equal(res.statusCode, 400);
  });

  it("201 with item on create", async () => {
    const { ctx, calls } = makeCtx({
      method: "POST",
      path: "/events",
      body: { eventName: "X", eventDate: "2026-05-09" },
    });
    const res = await handleEventsAndTablesRoute(ctx);
    assert.equal(res.statusCode, 201);
    assert.equal(calls.createEvent[0].user, "admin@x");
  });
});

describe("GET /events/by-date/{date}", () => {
  it("404 when not found", async () => {
    const { ctx } = makeCtx({
      method: "GET",
      path: "/events/by-date/2026-05-09",
      eventForDate: null,
    });
    const res = await handleEventsAndTablesRoute(ctx);
    assert.equal(res.statusCode, 404);
  });
  it("returns event when found", async () => {
    const { ctx } = makeCtx({
      method: "GET",
      path: "/events/by-date/2026-05-09",
      eventForDate: { eventId: "e1" },
    });
    const res = await handleEventsAndTablesRoute(ctx);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.item.eventId, "e1");
  });
});

describe("GET /events/{id}", () => {
  it("404 when not found", async () => {
    const { ctx } = makeCtx({
      method: "GET",
      path: "/events/e1",
      eventById: null,
    });
    const res = await handleEventsAndTablesRoute(ctx);
    assert.equal(res.statusCode, 404);
  });
});

describe("PUT /events/{id}", () => {
  it("requireAdmin + 400 on bad JSON", async () => {
    const { ctx } = makeCtx({
      method: "PUT",
      path: "/events/e1",
      body: null,
    });
    const res = await handleEventsAndTablesRoute(ctx);
    assert.equal(res.statusCode, 400);
  });
});

describe("DELETE /events/{id}", () => {
  it("requireAdmin + returns 204", async () => {
    const { ctx, calls } = makeCtx({
      method: "DELETE",
      path: "/events/e1",
    });
    const res = await handleEventsAndTablesRoute(ctx);
    assert.equal(res.statusCode, 204);
    assert.equal(calls.deleteEvent[0], "e1");
  });
});
