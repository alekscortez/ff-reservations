// Tests for routes-settings.mjs. The /admin/settings endpoints gate
// on requireAdmin. /events/context/current is the staff-app dashboard
// bootstrap (returns business date + current/next event).

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { handleSettingsRoute } from "./routes-settings.mjs";

function makeCtx(overrides = {}) {
  const calls = {
    json: [],
    requireAdmin: [],
    requireStaffOrAdmin: [],
    getBody: [],
    getUserLabel: [],
    getAppSettings: [],
    updateAppSettings: [],
    resolveBusinessDate: [],
    runtimeSettingsSubset: [],
    getEventByDate: [],
    listEvents: [],
  };
  return {
    calls,
    ctx: {
      method: overrides.method ?? "GET",
      path: overrides.path ?? "/admin/settings",
      event: overrides.event ?? {},
      cors: { "Access-Control-Allow-Origin": "*" },
      json: (status, body, cors) => {
        calls.json.push({ status, body, cors });
        return { statusCode: status, body, cors };
      },
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
      getUserLabel: async (event) => {
        calls.getUserLabel.push(event);
        return overrides.userLabel ?? "admin@x";
      },
      getAppSettings: async () => {
        calls.getAppSettings.push(true);
        return overrides.settings ?? { holdTtlSeconds: 300, smsEnabled: true };
      },
      updateAppSettings: async (patch, user) => {
        calls.updateAppSettings.push({ patch, user });
        return overrides.updatedSettings ?? { ...patch };
      },
      resolveBusinessDate: async () => {
        calls.resolveBusinessDate.push(true);
        return overrides.businessCtx ?? {
          businessDate: "2026-05-09",
          operatingTz: "America/Chicago",
          cutoffHour: 5,
        };
      },
      runtimeSettingsSubset: (settings) => {
        calls.runtimeSettingsSubset.push(settings);
        return overrides.runtimeSubset ?? { holdTtlSeconds: settings?.holdTtlSeconds };
      },
      getEventByDate: async (date) => {
        calls.getEventByDate.push(date);
        return overrides.currentEvent ?? null;
      },
      listEvents: async () => {
        calls.listEvents.push(true);
        return overrides.events ?? [];
      },
    },
  };
}

describe("handleSettingsRoute — path mismatch", () => {
  it("returns null on unrelated path", async () => {
    const { ctx } = makeCtx({ method: "GET", path: "/other" });
    assert.equal(await handleSettingsRoute(ctx), null);
  });
});

describe("GET /admin/settings", () => {
  it("requireAdmin first", async () => {
    const denied = Object.assign(new Error("forbidden"), { statusCode: 403 });
    const { ctx, calls } = makeCtx({ requireAdminThrows: denied });
    await assert.rejects(() => handleSettingsRoute(ctx), (err) => err?.statusCode === 403);
    assert.equal(calls.getAppSettings.length, 0);
  });

  it("returns wrapped { item }", async () => {
    const { ctx } = makeCtx({
      settings: { holdTtlSeconds: 600, smsEnabled: false },
    });
    const res = await handleSettingsRoute(ctx);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.item.holdTtlSeconds, 600);
  });
});

describe("PUT /admin/settings", () => {
  it("400 on bad JSON", async () => {
    const { ctx } = makeCtx({
      method: "PUT",
      path: "/admin/settings",
      body: null,
    });
    const res = await handleSettingsRoute(ctx);
    assert.equal(res.statusCode, 400);
  });

  it("dispatches with patch + user label", async () => {
    const { ctx, calls } = makeCtx({
      method: "PUT",
      path: "/admin/settings",
      body: { holdTtlSeconds: 600 },
      userLabel: "admin@x",
    });
    const res = await handleSettingsRoute(ctx);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(calls.updateAppSettings[0], {
      patch: { holdTtlSeconds: 600 },
      user: "admin@x",
    });
  });
});

describe("GET /events/context/current", () => {
  it("requireStaffOrAdmin (not admin-only — staff dashboard uses this)", async () => {
    const denied = Object.assign(new Error("forbidden"), { statusCode: 403 });
    const { ctx } = makeCtx({
      method: "GET",
      path: "/events/context/current",
      requireStaffOrAdminThrows: denied,
    });
    await assert.rejects(
      () => handleSettingsRoute(ctx),
      (err) => err?.statusCode === 403
    );
  });

  it("happy path with current event found: returns event + null nextEvent", async () => {
    const { ctx, calls } = makeCtx({
      method: "GET",
      path: "/events/context/current",
      currentEvent: { eventId: "e1", eventDate: "2026-05-09", eventName: "Friday" },
    });
    const res = await handleSettingsRoute(ctx);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.businessDate, "2026-05-09");
    assert.equal(res.body.event.eventId, "e1");
    assert.equal(res.body.nextEvent, null);
    assert.equal(res.body.operatingTz, "America/Chicago");
    assert.equal(res.body.operatingDayCutoffHour, 5);
    // No listEvents call when current event found
    assert.equal(calls.listEvents.length, 0);
  });

  it("when no current event: queries listEvents to find the next ACTIVE event ≥ businessDate", async () => {
    const { ctx } = makeCtx({
      method: "GET",
      path: "/events/context/current",
      currentEvent: null, // no event for today
      events: [
        { eventId: "e-past", eventDate: "2026-05-01", status: "ACTIVE" }, // past, ignored
        { eventId: "e-inactive", eventDate: "2026-05-15", status: "INACTIVE" }, // inactive, ignored
        { eventId: "e-next", eventDate: "2026-05-20", status: "ACTIVE" },
        { eventId: "e-later", eventDate: "2026-06-01", status: "ACTIVE" },
      ],
    });
    const res = await handleSettingsRoute(ctx);
    assert.equal(res.body.event, null);
    assert.equal(res.body.nextEvent.eventId, "e-next"); // earliest ACTIVE ≥ businessDate
  });

  it("nextEvent null when no upcoming ACTIVE events", async () => {
    const { ctx } = makeCtx({
      method: "GET",
      path: "/events/context/current",
      currentEvent: null,
      events: [{ eventId: "e-past", eventDate: "2026-05-01", status: "ACTIVE" }],
    });
    const res = await handleSettingsRoute(ctx);
    assert.equal(res.body.nextEvent, null);
  });

  it("getEventByDate exception is swallowed (currentEvent treated as null)", async () => {
    const { ctx, calls } = makeCtx({
      method: "GET",
      path: "/events/context/current",
      events: [],
    });
    // Override getEventByDate to throw
    ctx.getEventByDate = async () => {
      throw new Error("DDB blip");
    };
    const res = await handleSettingsRoute(ctx);
    // Should not throw — currentEvent set to null + listEvents fallback runs
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.event, null);
  });
});
