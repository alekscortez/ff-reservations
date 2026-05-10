// Tests for routes-packages.mjs. Packages have BOTH public read routes
// (no auth, ACTIVE only) AND admin CRUD (Admin gate). The 2-stage
// delete (soft → hard) is enforced at the service layer; here we just
// verify the dispatch.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { handlePackagesRoute } from "./routes-packages.mjs";

function makeCtx(overrides = {}) {
  const calls = {
    json: [],
    requireAdmin: [],
    requireStaffOrAdmin: [],
    getBody: [],
    getUserLabel: [],
    listPackages: [],
    getPackageById: [],
    createPackage: [],
    updatePackage: [],
    deletePackage: [],
  };
  return {
    calls,
    ctx: {
      method: overrides.method ?? "GET",
      path: overrides.path ?? "/packages",
      event: overrides.event ?? {},
      cors: { "Access-Control-Allow-Origin": "*" },
      json: (status, body, cors) => {
        calls.json.push({ status, body, cors });
        return { statusCode: status, body, cors };
      },
      noContent: (status, cors) => ({ statusCode: status, cors }),
      getBody: async (event) => {
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
      listPackages: async (args) => {
        calls.listPackages.push(args);
        return overrides.packages ?? [];
      },
      getPackageById: async (id) => {
        calls.getPackageById.push(id);
        return overrides.pkg ?? null;
      },
      createPackage: async (payload, user) => {
        calls.createPackage.push({ payload, user });
        return overrides.createResult ?? { packageId: "p-new" };
      },
      updatePackage: async (id, payload, user) => {
        calls.updatePackage.push({ id, payload, user });
        return overrides.updateResult ?? { packageId: id };
      },
      deletePackage: async (id, user) => {
        calls.deletePackage.push({ id, user });
        // Use Object.hasOwn so an explicit null override survives instead
        // of being clobbered by the default.
        return Object.hasOwn(overrides, "deleteResult")
          ? overrides.deleteResult
          : { softDeleted: true, item: { packageId: id } };
      },
    },
  };
}

describe("handlePackagesRoute — path mismatch", () => {
  it("returns null on unrelated path", async () => {
    const { ctx } = makeCtx({ method: "GET", path: "/other" });
    assert.equal(await handlePackagesRoute(ctx), null);
  });
});

describe("GET /public/packages (no auth, activeOnly)", () => {
  it("calls listPackages with activeOnly=true (NO requireAdmin/Staff)", async () => {
    const { ctx, calls } = makeCtx({
      method: "GET",
      path: "/public/packages",
      packages: [{ packageId: "p1" }],
    });
    const res = await handlePackagesRoute(ctx);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(calls.listPackages[0], { activeOnly: true });
    assert.equal(calls.requireAdmin.length, 0, "no admin gate on public route");
    assert.equal(calls.requireStaffOrAdmin.length, 0);
  });
});

describe("GET /public/packages/{id} (no auth)", () => {
  it("returns 404 if package not found", async () => {
    const { ctx } = makeCtx({
      method: "GET",
      path: "/public/packages/p1",
      pkg: null,
    });
    const res = await handlePackagesRoute(ctx);
    assert.equal(res.statusCode, 404);
  });

  it("returns 404 if package is INACTIVE (privacy: don't reveal existence)", async () => {
    const { ctx } = makeCtx({
      method: "GET",
      path: "/public/packages/p1",
      pkg: { packageId: "p1", status: "INACTIVE" },
    });
    const res = await handlePackagesRoute(ctx);
    assert.equal(res.statusCode, 404);
  });

  it("returns 200 with item when ACTIVE", async () => {
    const { ctx } = makeCtx({
      method: "GET",
      path: "/public/packages/p1",
      pkg: { packageId: "p1", status: "ACTIVE" },
    });
    const res = await handlePackagesRoute(ctx);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.item.packageId, "p1");
  });
});

describe("POST /packages (admin)", () => {
  it("requireAdmin first", async () => {
    const denied = Object.assign(new Error("forbidden"), { statusCode: 403 });
    const { ctx, calls } = makeCtx({
      method: "POST",
      path: "/packages",
      requireAdminThrows: denied,
    });
    await assert.rejects(() => handlePackagesRoute(ctx), (err) => err?.statusCode === 403);
    assert.equal(calls.createPackage.length, 0);
  });

  it("400 on bad JSON", async () => {
    const { ctx } = makeCtx({ method: "POST", path: "/packages", body: null });
    const res = await handlePackagesRoute(ctx);
    assert.equal(res.statusCode, 400);
  });

  it("happy path: 201 with created item, body forwarded + user attached", async () => {
    const { ctx, calls } = makeCtx({
      method: "POST",
      path: "/packages",
      body: { name: "VIP", priceUSD: 500 },
    });
    const res = await handlePackagesRoute(ctx);
    assert.equal(res.statusCode, 201);
    assert.equal(calls.createPackage[0].user, "admin@x");
    assert.deepEqual(calls.createPackage[0].payload, { name: "VIP", priceUSD: 500 });
  });
});

describe("GET /packages (staff/admin)", () => {
  it("requireStaffOrAdmin and returns ALL packages (not activeOnly)", async () => {
    const { ctx, calls } = makeCtx({ method: "GET", path: "/packages" });
    await handlePackagesRoute(ctx);
    assert.equal(calls.requireStaffOrAdmin.length, 1);
    assert.deepEqual(calls.listPackages[0], undefined); // listPackages() — no args
  });
});

describe("GET /packages/{id} (staff/admin)", () => {
  it("404 when package not found", async () => {
    const { ctx } = makeCtx({
      method: "GET",
      path: "/packages/p1",
      pkg: null,
    });
    const res = await handlePackagesRoute(ctx);
    assert.equal(res.statusCode, 404);
  });

  it("returns item (any status — staff sees inactive too)", async () => {
    const { ctx } = makeCtx({
      method: "GET",
      path: "/packages/p1",
      pkg: { packageId: "p1", status: "INACTIVE" },
    });
    const res = await handlePackagesRoute(ctx);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.item.status, "INACTIVE");
  });
});

describe("PUT /packages/{id}", () => {
  it("requireAdmin + 400 on bad JSON", async () => {
    const { ctx } = makeCtx({
      method: "PUT",
      path: "/packages/p1",
      body: null,
    });
    const res = await handlePackagesRoute(ctx);
    assert.equal(res.statusCode, 400);
  });

  it("dispatches with id, body, user", async () => {
    const { ctx, calls } = makeCtx({
      method: "PUT",
      path: "/packages/p1",
      body: { name: "New Name" },
    });
    await handlePackagesRoute(ctx);
    assert.deepEqual(calls.updatePackage[0], {
      id: "p1",
      payload: { name: "New Name" },
      user: "admin@x",
    });
  });
});

describe("DELETE /packages/{id}", () => {
  it("requireAdmin", async () => {
    const denied = Object.assign(new Error("forbidden"), { statusCode: 403 });
    const { ctx } = makeCtx({
      method: "DELETE",
      path: "/packages/p1",
      requireAdminThrows: denied,
    });
    await assert.rejects(
      () => handlePackagesRoute(ctx),
      (err) => err?.statusCode === 403
    );
  });

  it("404 when service returns null (not found)", async () => {
    const { ctx } = makeCtx({
      method: "DELETE",
      path: "/packages/p1",
      deleteResult: null,
    });
    const res = await handlePackagesRoute(ctx);
    assert.equal(res.statusCode, 404);
  });

  it("returns delete result envelope (softDeleted or hardDeleted shape)", async () => {
    const { ctx } = makeCtx({
      method: "DELETE",
      path: "/packages/p1",
      deleteResult: { softDeleted: true, item: { packageId: "p1", status: "INACTIVE" } },
    });
    const res = await handlePackagesRoute(ctx);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.softDeleted, true);
  });
});
