// Tests for routes-me.mjs (customer self-service router). All 3
// endpoints require requireCustomerOwnership (defense-in-depth on
// top of the API Gateway customer authorizer).

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { handleMeRoute } from "./routes-me.mjs";

const SUB = "cognito-sub-12345";

function makeCtx(overrides = {}) {
  const calls = {
    json: [],
    requireCustomerOwnership: [],
    getProfile: [],
    listReservations: [],
    deleteAccount: [],
  };
  return {
    calls,
    ctx: {
      method: overrides.method ?? "GET",
      path: overrides.path ?? "/me/profile",
      event: overrides.event ?? {},
      cors: { "Access-Control-Allow-Origin": "*" },
      json: (status, body, cors) => {
        calls.json.push({ status, body, cors });
        return { statusCode: status, body, cors };
      },
      requireCustomerOwnership: (event) => {
        calls.requireCustomerOwnership.push(event);
        if (overrides.requireOwnershipThrows) throw overrides.requireOwnershipThrows;
        return overrides.sub ?? SUB;
      },
      getProfile: async (sub) => {
        calls.getProfile.push(sub);
        return overrides.profile ?? { sub, phone: "+12025550100" };
      },
      listReservations: async (sub) => {
        calls.listReservations.push(sub);
        return overrides.reservations ?? [];
      },
      deleteAccount: async (sub) => {
        calls.deleteAccount.push(sub);
        return overrides.deleteResult ?? { deleted: true };
      },
    },
  };
}

describe("handleMeRoute — path mismatch", () => {
  it("returns null when path doesn't match", async () => {
    const { ctx } = makeCtx({ method: "GET", path: "/other" });
    assert.equal(await handleMeRoute(ctx), null);
  });
  it("returns null on POST /me/profile (no POST handler)", async () => {
    const { ctx } = makeCtx({ method: "POST", path: "/me/profile" });
    assert.equal(await handleMeRoute(ctx), null);
  });
});

describe("GET /me/profile", () => {
  it("requires customer ownership before fetching profile", async () => {
    const denied = Object.assign(new Error("forbidden"), { statusCode: 403 });
    const { ctx, calls } = makeCtx({
      method: "GET",
      path: "/me/profile",
      requireOwnershipThrows: denied,
    });
    await assert.rejects(() => handleMeRoute(ctx), (err) => err?.statusCode === 403);
    assert.equal(calls.getProfile.length, 0);
  });
  it("happy path: returns profile for resolved sub", async () => {
    const { ctx, calls } = makeCtx({
      method: "GET",
      path: "/me/profile",
      profile: { sub: SUB, phone: "+12025550100", crm: { totalSpend: 100 } },
    });
    const res = await handleMeRoute(ctx);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.sub, SUB);
    assert.equal(res.body.crm.totalSpend, 100);
    assert.equal(calls.getProfile[0], SUB);
  });
});

describe("GET /me/reservations", () => {
  it("requires customer ownership", async () => {
    const denied = Object.assign(new Error("forbidden"), { statusCode: 403 });
    const { ctx, calls } = makeCtx({
      method: "GET",
      path: "/me/reservations",
      requireOwnershipThrows: denied,
    });
    await assert.rejects(() => handleMeRoute(ctx), (err) => err?.statusCode === 403);
    assert.equal(calls.listReservations.length, 0);
  });
  it("returns wrapped { items } shape", async () => {
    const { ctx, calls } = makeCtx({
      method: "GET",
      path: "/me/reservations",
      reservations: [{ reservationId: "r1" }, { reservationId: "r2" }],
    });
    const res = await handleMeRoute(ctx);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.items.length, 2);
    assert.equal(calls.listReservations[0], SUB);
  });
});

describe("DELETE /me", () => {
  it("requires customer ownership", async () => {
    const denied = Object.assign(new Error("forbidden"), { statusCode: 403 });
    const { ctx, calls } = makeCtx({
      method: "DELETE",
      path: "/me",
      requireOwnershipThrows: denied,
    });
    await assert.rejects(() => handleMeRoute(ctx), (err) => err?.statusCode === 403);
    assert.equal(calls.deleteAccount.length, 0);
  });
  it("happy path: returns delete result", async () => {
    const { ctx, calls } = makeCtx({
      method: "DELETE",
      path: "/me",
      deleteResult: { deleted: true, alreadyGone: false },
    });
    const res = await handleMeRoute(ctx);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.deleted, true);
    assert.equal(calls.deleteAccount[0], SUB);
  });
});
