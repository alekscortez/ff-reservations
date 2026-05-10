// Tests for routes-users.mjs (admin user management routes).
// All endpoints require requireAdmin (no Staff access — staff can't
// create/modify other staff or admins).

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { handleUsersRoute } from "./routes-users.mjs";

function makeCtx(overrides = {}) {
  const calls = {
    json: [],
    requireAdmin: [],
    getBody: [],
    listUsers: [],
    createUser: [],
    updateUserRole: [],
    updateUserStatus: [],
    resetUserPassword: [],
  };
  return {
    calls,
    ctx: {
      method: overrides.method ?? "GET",
      path: overrides.path ?? "/admin/users",
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
      listUsers: async (args) => {
        calls.listUsers.push(args);
        return overrides.listUsersResult ?? { items: [], nextToken: null };
      },
      createUser: async (payload) => {
        calls.createUser.push(payload);
        return overrides.createUserResult ?? { username: "u1" };
      },
      updateUserRole: async (username, role) => {
        calls.updateUserRole.push({ username, role });
        return overrides.updateUserRoleResult ?? { username, role };
      },
      updateUserStatus: async (username, enabled) => {
        calls.updateUserStatus.push({ username, enabled });
        return overrides.updateUserStatusResult ?? { username, enabled };
      },
      resetUserPassword: async (username) => {
        calls.resetUserPassword.push(username);
        return overrides.resetUserPasswordResult ?? { username };
      },
    },
  };
}

describe("handleUsersRoute — path mismatch", () => {
  it("returns null on unrelated path", async () => {
    const { ctx } = makeCtx({ method: "GET", path: "/other" });
    assert.equal(await handleUsersRoute(ctx), null);
  });
});

describe("GET /admin/users", () => {
  it("requires admin first", async () => {
    const denied = Object.assign(new Error("forbidden"), { statusCode: 403 });
    const { ctx, calls } = makeCtx({
      method: "GET",
      path: "/admin/users",
      requireAdminThrows: denied,
    });
    await assert.rejects(() => handleUsersRoute(ctx), (err) => err?.statusCode === 403);
    assert.equal(calls.listUsers.length, 0);
  });

  it("dispatches with limit + nextToken from query string", async () => {
    const { ctx, calls } = makeCtx({
      method: "GET",
      path: "/admin/users",
      event: {
        queryStringParameters: { limit: "20", nextToken: "tok-abc" },
      },
    });
    await handleUsersRoute(ctx);
    assert.deepEqual(calls.listUsers[0], { limit: 20, nextToken: "tok-abc" });
  });

  it("nextToken null when query param empty", async () => {
    const { ctx, calls } = makeCtx({
      method: "GET",
      path: "/admin/users",
      event: { queryStringParameters: { limit: "10" } },
    });
    await handleUsersRoute(ctx);
    assert.equal(calls.listUsers[0].nextToken, null);
  });

  it("default limit 50 when not provided", async () => {
    const { ctx, calls } = makeCtx({
      method: "GET",
      path: "/admin/users",
      event: { queryStringParameters: {} },
    });
    await handleUsersRoute(ctx);
    assert.equal(calls.listUsers[0].limit, 50);
  });

  it("returns wrapped { items, nextToken } shape", async () => {
    const { ctx } = makeCtx({
      method: "GET",
      path: "/admin/users",
      listUsersResult: {
        items: [{ username: "u1" }, { username: "u2" }],
        nextToken: "next",
      },
    });
    const res = await handleUsersRoute(ctx);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.items.length, 2);
    assert.equal(res.body.nextToken, "next");
  });
});

describe("POST /admin/users", () => {
  it("requireAdmin + 400 on bad JSON", async () => {
    const { ctx } = makeCtx({
      method: "POST",
      path: "/admin/users",
      body: null,
    });
    const res = await handleUsersRoute(ctx);
    assert.equal(res.statusCode, 400);
  });

  it("happy path: 201 with item, body forwarded as-is to createUser", async () => {
    const { ctx, calls } = makeCtx({
      method: "POST",
      path: "/admin/users",
      body: { email: "alice@x.com", role: "Admin", name: "Alice" },
      createUserResult: { username: "alice@x.com", role: "Admin" },
    });
    const res = await handleUsersRoute(ctx);
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.item.username, "alice@x.com");
    assert.deepEqual(calls.createUser[0], {
      email: "alice@x.com",
      role: "Admin",
      name: "Alice",
    });
  });
});

describe("PUT /admin/users/{username}/role", () => {
  it("requireAdmin first", async () => {
    const denied = Object.assign(new Error("forbidden"), { statusCode: 403 });
    const { ctx, calls } = makeCtx({
      method: "PUT",
      path: "/admin/users/alice/role",
      requireAdminThrows: denied,
    });
    await assert.rejects(() => handleUsersRoute(ctx), (err) => err?.statusCode === 403);
    assert.equal(calls.updateUserRole.length, 0);
  });

  it("400 on bad JSON", async () => {
    const { ctx } = makeCtx({
      method: "PUT",
      path: "/admin/users/alice/role",
      body: null,
    });
    const res = await handleUsersRoute(ctx);
    assert.equal(res.statusCode, 400);
  });

  it("happy path: extracts username from path, role from body", async () => {
    const { ctx, calls } = makeCtx({
      method: "PUT",
      path: "/admin/users/alice/role",
      body: { role: "Staff" },
    });
    await handleUsersRoute(ctx);
    assert.deepEqual(calls.updateUserRole[0], { username: "alice", role: "Staff" });
  });

  it("URL-decodes username from path (handles email-as-username)", async () => {
    const { ctx, calls } = makeCtx({
      method: "PUT",
      path: "/admin/users/alice%40x.com/role",
      body: { role: "Admin" },
    });
    await handleUsersRoute(ctx);
    assert.equal(calls.updateUserRole[0].username, "alice@x.com");
  });
});

describe("PUT /admin/users/{username}/status", () => {
  it("happy path: extracts username + enabled from body", async () => {
    const { ctx, calls } = makeCtx({
      method: "PUT",
      path: "/admin/users/alice/status",
      body: { enabled: false },
    });
    const res = await handleUsersRoute(ctx);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(calls.updateUserStatus[0], { username: "alice", enabled: false });
  });

  it("URL-decodes username", async () => {
    const { ctx, calls } = makeCtx({
      method: "PUT",
      path: "/admin/users/alice%40x.com/status",
      body: { enabled: true },
    });
    await handleUsersRoute(ctx);
    assert.equal(calls.updateUserStatus[0].username, "alice@x.com");
  });
});

describe("POST /admin/users/{username}/reset-password", () => {
  it("requireAdmin + dispatches resetUserPassword", async () => {
    const { ctx, calls } = makeCtx({
      method: "POST",
      path: "/admin/users/alice/reset-password",
    });
    const res = await handleUsersRoute(ctx);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.match(res.body.message, /reset/);
    assert.equal(calls.resetUserPassword[0], "alice");
  });

  it("URL-decodes username", async () => {
    const { ctx, calls } = makeCtx({
      method: "POST",
      path: "/admin/users/alice%40x.com/reset-password",
    });
    await handleUsersRoute(ctx);
    assert.equal(calls.resetUserPassword[0], "alice@x.com");
  });
});
