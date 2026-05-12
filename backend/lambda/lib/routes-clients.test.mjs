// Tests for routes-clients.mjs. Frequent clients (admin CRUD) + CRM
// clients (admin/staff search + reschedule credits). The split between
// requireAdmin and requireStaffOrAdmin is meaningful — staff can search
// but can't modify.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { handleClientsRoute } from "./routes-clients.mjs";

function makeCtx(overrides = {}) {
  const calls = {
    json: [],
    requireAdmin: [],
    requireStaffOrAdmin: [],
    getBody: [],
    listFrequentClients: [],
    createFrequentClient: [],
    getFrequentClientById: [],
    updateFrequentClient: [],
    deleteFrequentClient: [],
    listCrmClients: [],
    updateCrmClient: [],
    deleteCrmClient: [],
    searchCrmClients: [],
    listRescheduleCreditsByPhone: [],
    bulkImportCrmClients: [],
  };
  return {
    calls,
    ctx: {
      method: overrides.method ?? "GET",
      path: overrides.path ?? "/frequent-clients",
      event: overrides.event ?? {},
      cors: { "Access-Control-Allow-Origin": "*" },
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
      getUserLabel: async () => overrides.userLabel ?? "user@x",
      listFrequentClients: async () => overrides.frequentClients ?? [],
      createFrequentClient: async (payload, user) => {
        calls.createFrequentClient.push({ payload, user });
        return overrides.createResult ?? { clientId: "fc1" };
      },
      getFrequentClientById: async (id) => {
        calls.getFrequentClientById.push(id);
        return overrides.client ?? null;
      },
      updateFrequentClient: async (id, body) => {
        calls.updateFrequentClient.push({ id, body });
        return overrides.updateResult ?? { clientId: id };
      },
      deleteFrequentClient: async (id) => {
        calls.deleteFrequentClient.push(id);
      },
      listCrmClients: async () => overrides.crmClients ?? [],
      updateCrmClient: async (phone, body, user) => {
        calls.updateCrmClient.push({ phone, body, user });
        return overrides.crmUpdateResult ?? { phone };
      },
      deleteCrmClient: async (phone) => {
        calls.deleteCrmClient.push(phone);
      },
      searchCrmClients: async (phone) => {
        calls.searchCrmClients.push(phone);
        return overrides.searchResult ?? [];
      },
      listRescheduleCreditsByPhone: async (phone, country) => {
        calls.listRescheduleCreditsByPhone.push({ phone, country });
        return overrides.creditsResult ?? [];
      },
      bulkImportCrmClients: async (body, user) => {
        calls.bulkImportCrmClients.push({ body, user });
        return overrides.bulkImportResult ?? {
          imported: 0,
          skipped: 0,
          invalid: 0,
          errors: 0,
          invalidDetails: [],
          errorDetails: [],
        };
      },
    },
  };
}

describe("handleClientsRoute — path mismatch", () => {
  it("returns null on unrelated path", async () => {
    const { ctx } = makeCtx({ method: "GET", path: "/other" });
    assert.equal(await handleClientsRoute(ctx), null);
  });
});

describe("GET /frequent-clients (staff/admin)", () => {
  it("requireStaffOrAdmin (staff can read)", async () => {
    const { ctx, calls } = makeCtx({
      method: "GET",
      path: "/frequent-clients",
    });
    await handleClientsRoute(ctx);
    assert.equal(calls.requireStaffOrAdmin.length, 1);
    assert.equal(calls.requireAdmin.length, 0);
  });
});

describe("POST /frequent-clients (admin only)", () => {
  it("requireAdmin (staff CANNOT create)", async () => {
    const denied = Object.assign(new Error("forbidden"), { statusCode: 403 });
    const { ctx, calls } = makeCtx({
      method: "POST",
      path: "/frequent-clients",
      requireAdminThrows: denied,
    });
    await assert.rejects(() => handleClientsRoute(ctx), (err) => err?.statusCode === 403);
    assert.equal(calls.createFrequentClient.length, 0);
  });

  it("400 on bad JSON", async () => {
    const { ctx } = makeCtx({
      method: "POST",
      path: "/frequent-clients",
      body: null,
    });
    const res = await handleClientsRoute(ctx);
    assert.equal(res.statusCode, 400);
  });

  it("201 with item on create", async () => {
    const { ctx, calls } = makeCtx({
      method: "POST",
      path: "/frequent-clients",
      body: { name: "Alice", phone: "+12025550100", defaultTableIds: ["A1"] },
      userLabel: "admin@x",
    });
    const res = await handleClientsRoute(ctx);
    assert.equal(res.statusCode, 201);
    assert.equal(calls.createFrequentClient[0].user, "admin@x");
  });
});

describe("GET /frequent-clients/{id} (staff/admin)", () => {
  it("requireStaffOrAdmin", async () => {
    const { ctx, calls } = makeCtx({
      method: "GET",
      path: "/frequent-clients/fc1",
      client: { clientId: "fc1" },
    });
    await handleClientsRoute(ctx);
    assert.equal(calls.requireStaffOrAdmin.length, 1);
  });

  it("404 when not found", async () => {
    const { ctx } = makeCtx({
      method: "GET",
      path: "/frequent-clients/fc1",
      client: null,
    });
    const res = await handleClientsRoute(ctx);
    assert.equal(res.statusCode, 404);
  });
});

describe("PUT /frequent-clients/{id} (admin)", () => {
  it("requireAdmin", async () => {
    const denied = Object.assign(new Error("forbidden"), { statusCode: 403 });
    const { ctx } = makeCtx({
      method: "PUT",
      path: "/frequent-clients/fc1",
      body: { name: "X" },
      requireAdminThrows: denied,
    });
    await assert.rejects(() => handleClientsRoute(ctx), (err) => err?.statusCode === 403);
  });

  it("400 on bad JSON", async () => {
    const { ctx } = makeCtx({
      method: "PUT",
      path: "/frequent-clients/fc1",
      body: null,
    });
    const res = await handleClientsRoute(ctx);
    assert.equal(res.statusCode, 400);
  });

  it("dispatches with id + body", async () => {
    const { ctx, calls } = makeCtx({
      method: "PUT",
      path: "/frequent-clients/fc1",
      body: { name: "Updated" },
    });
    await handleClientsRoute(ctx);
    assert.deepEqual(calls.updateFrequentClient[0], {
      id: "fc1",
      body: { name: "Updated" },
    });
  });
});

describe("DELETE /frequent-clients/{id} (admin)", () => {
  it("requireAdmin + returns 204", async () => {
    const { ctx, calls } = makeCtx({
      method: "DELETE",
      path: "/frequent-clients/fc1",
    });
    const res = await handleClientsRoute(ctx);
    assert.equal(res.statusCode, 204);
    assert.equal(calls.deleteFrequentClient[0], "fc1");
  });
});

describe("GET /clients (admin only — full CRM list)", () => {
  it("requireAdmin (staff can't enumerate the full CRM)", async () => {
    const denied = Object.assign(new Error("forbidden"), { statusCode: 403 });
    const { ctx, calls } = makeCtx({
      method: "GET",
      path: "/clients",
      requireAdminThrows: denied,
    });
    await assert.rejects(() => handleClientsRoute(ctx), (err) => err?.statusCode === 403);
    assert.equal(calls.listCrmClients.length, 0);
  });
});

describe("PUT /clients/{phone} (admin)", () => {
  it("dispatches with phone + body + user", async () => {
    const { ctx, calls } = makeCtx({
      method: "PUT",
      path: "/clients/12025550100",
      body: { name: "Updated" },
    });
    await handleClientsRoute(ctx);
    assert.equal(calls.updateCrmClient[0].phone, "12025550100");
    assert.equal(calls.updateCrmClient[0].user, "user@x");
  });
});

describe("DELETE /clients/{phone} (admin)", () => {
  it("returns 204", async () => {
    const { ctx, calls } = makeCtx({
      method: "DELETE",
      path: "/clients/12025550100",
    });
    const res = await handleClientsRoute(ctx);
    assert.equal(res.statusCode, 204);
    assert.equal(calls.deleteCrmClient[0], "12025550100");
  });
});

describe("GET /clients/search (staff/admin)", () => {
  it("requireStaffOrAdmin (search is okay for staff)", async () => {
    const { ctx, calls } = makeCtx({
      method: "GET",
      path: "/clients/search",
      event: { queryStringParameters: { phone: "2025550100" } },
    });
    await handleClientsRoute(ctx);
    assert.equal(calls.requireStaffOrAdmin.length, 1);
  });

  it("400 when both phone and q are missing", async () => {
    const { ctx } = makeCtx({
      method: "GET",
      path: "/clients/search",
      event: { queryStringParameters: {} },
    });
    const res = await handleClientsRoute(ctx);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /phone or q/);
  });

  it("dispatches phone to searchCrmClients as { phone, q }", async () => {
    const { ctx, calls } = makeCtx({
      method: "GET",
      path: "/clients/search",
      event: { queryStringParameters: { phone: "2025550100" } },
    });
    await handleClientsRoute(ctx);
    assert.deepEqual(calls.searchCrmClients[0], { phone: "2025550100", q: "" });
  });

  it("dispatches q-only as { phone: '', q: 'julio' }", async () => {
    const { ctx, calls } = makeCtx({
      method: "GET",
      path: "/clients/search",
      event: { queryStringParameters: { q: "julio" } },
    });
    await handleClientsRoute(ctx);
    assert.deepEqual(calls.searchCrmClients[0], { phone: "", q: "julio" });
  });

  it("dispatches both phone and q together", async () => {
    const { ctx, calls } = makeCtx({
      method: "GET",
      path: "/clients/search",
      event: { queryStringParameters: { phone: "956", q: "julio" } },
    });
    await handleClientsRoute(ctx);
    assert.deepEqual(calls.searchCrmClients[0], { phone: "956", q: "julio" });
  });
});

describe("GET /clients/credits (staff/admin)", () => {
  it("400 when phone missing", async () => {
    const { ctx } = makeCtx({
      method: "GET",
      path: "/clients/credits",
      event: { queryStringParameters: {} },
    });
    const res = await handleClientsRoute(ctx);
    assert.equal(res.statusCode, 400);
  });

  it("dispatches with phone + phoneCountry (default US)", async () => {
    const { ctx, calls } = makeCtx({
      method: "GET",
      path: "/clients/credits",
      event: { queryStringParameters: { phone: "2025550100" } },
    });
    await handleClientsRoute(ctx);
    assert.deepEqual(calls.listRescheduleCreditsByPhone[0], {
      phone: "2025550100",
      country: "US",
    });
  });

  it("respects phoneCountry=MX", async () => {
    const { ctx, calls } = makeCtx({
      method: "GET",
      path: "/clients/credits",
      event: {
        queryStringParameters: { phone: "8991054670", phoneCountry: "MX" },
      },
    });
    await handleClientsRoute(ctx);
    assert.equal(calls.listRescheduleCreditsByPhone[0].country, "MX");
  });
});

describe("POST /clients/bulk-import (admin only)", () => {
  it("requireAdmin (staff CANNOT import)", async () => {
    const denied = Object.assign(new Error("forbidden"), { statusCode: 403 });
    const { ctx, calls } = makeCtx({
      method: "POST",
      path: "/clients/bulk-import",
      requireAdminThrows: denied,
    });
    await assert.rejects(() => handleClientsRoute(ctx), (err) => err?.statusCode === 403);
    assert.equal(calls.bulkImportCrmClients.length, 0);
  });

  it("400 on missing JSON body", async () => {
    const { ctx } = makeCtx({
      method: "POST",
      path: "/clients/bulk-import",
      body: null,
    });
    const res = await handleClientsRoute(ctx);
    assert.equal(res.statusCode, 400);
  });

  it("forwards body + user; returns the summary as 200", async () => {
    const { ctx, calls } = makeCtx({
      method: "POST",
      path: "/clients/bulk-import",
      body: { contacts: [{ name: "Alice", phone: "+12025550100" }] },
      userLabel: "admin@x",
      bulkImportResult: {
        imported: 1, skipped: 0, invalid: 0, errors: 0,
        invalidDetails: [], errorDetails: [],
      },
    });
    const res = await handleClientsRoute(ctx);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.imported, 1);
    assert.equal(calls.bulkImportCrmClients[0].user, "admin@x");
    assert.equal(calls.bulkImportCrmClients[0].body.contacts.length, 1);
  });

  it("does not collide with PUT /clients/:phone (different methods)", async () => {
    // Sanity: /clients/bulk-import as PUT should fall through to updateCrmClient
    // with phone="bulk-import" (which the service would later reject) — i.e. our
    // POST handler does not steal other verbs.
    const { ctx, calls } = makeCtx({
      method: "PUT",
      path: "/clients/bulk-import",
      body: { name: "Whatever" },
    });
    await handleClientsRoute(ctx);
    assert.equal(calls.bulkImportCrmClients.length, 0);
    assert.equal(calls.updateCrmClient.length, 1);
    assert.equal(calls.updateCrmClient[0].phone, "bulk-import");
  });
});
