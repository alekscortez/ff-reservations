// Tests for routes-admin.mjs. The /admin/whoami endpoint is the
// frontend's auth-health probe — it surfaces whether the Pre Token
// Generation Lambda injected groups, so the staff app can show the
// red "Auth misconfigured" banner if PreTokenGen broke.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { handleAdminRoute } from "./routes-admin.mjs";

function makeCtx(overrides = {}) {
  const calls = { json: [], getGroupsFromEvent: [] };
  return {
    calls,
    ctx: {
      method: overrides.method ?? "GET",
      path: overrides.path ?? "/admin/whoami",
      event: overrides.event ?? {},
      cors: { "Access-Control-Allow-Origin": "*" },
      json: (status, body, hdrs) => {
        calls.json.push({ status, body, hdrs });
        return { statusCode: status, body, headers: hdrs };
      },
      getGroupsFromEvent: (event) => {
        calls.getGroupsFromEvent.push(event);
        return overrides.groups ?? [];
      },
    },
  };
}

function makeJwtClaims(claims = {}) {
  return {
    requestContext: {
      authorizer: { jwt: { claims } },
    },
  };
}

describe("handleAdminRoute — path mismatch", () => {
  it("returns null on unrelated path", async () => {
    const { ctx } = makeCtx({ method: "GET", path: "/other" });
    assert.equal(await handleAdminRoute(ctx), null);
  });
  it("returns null on POST", async () => {
    const { ctx } = makeCtx({ method: "POST", path: "/admin/whoami" });
    assert.equal(await handleAdminRoute(ctx), null);
  });
  it("matches with trailing slash", async () => {
    const { ctx } = makeCtx({
      method: "GET",
      path: "/admin/whoami/",
      event: makeJwtClaims({ sub: "s1", "cognito:username": "u1" }),
    });
    const res = await handleAdminRoute(ctx);
    assert.equal(res.statusCode, 200);
  });
});

describe("GET /admin/whoami", () => {
  it("401 when neither sub nor username present", async () => {
    const { ctx } = makeCtx({ event: makeJwtClaims({}) });
    const res = await handleAdminRoute(ctx);
    assert.equal(res.statusCode, 401);
    assert.match(res.body.message, /Authentication required/);
  });

  it("returns full identity payload + role inference (Admin > Staff > User)", async () => {
    const { ctx } = makeCtx({
      event: makeJwtClaims({
        sub: "s1",
        "cognito:username": "u1",
        email: "alice@x.com",
        "custom:name": "Alice",
        token_use: "access",
      }),
      groups: ["Staff", "Admin"],
    });
    const res = await handleAdminRoute(ctx);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.sub, "s1");
    assert.equal(res.body.username, "u1");
    assert.equal(res.body.email, "alice@x.com");
    assert.equal(res.body.name, "Alice");
    assert.deepEqual(res.body.groups, ["Staff", "Admin"]);
    assert.equal(res.body.role, "Admin");
    assert.equal(res.body.hasGroups, true);
    assert.equal(res.body.tokenUse, "access");
    assert.equal(res.body.diagnostic.missingGroupsLikelyPreTokenGen, false);
  });

  it("role: Staff when only Staff group present", async () => {
    const { ctx } = makeCtx({
      event: makeJwtClaims({ sub: "s1" }),
      groups: ["Staff"],
    });
    const res = await handleAdminRoute(ctx);
    assert.equal(res.body.role, "Staff");
  });

  it("role: User when no groups", async () => {
    const { ctx } = makeCtx({
      event: makeJwtClaims({ sub: "s1" }),
      groups: [],
    });
    const res = await handleAdminRoute(ctx);
    assert.equal(res.body.role, "User");
    assert.equal(res.body.hasGroups, false);
  });

  it("**diagnostic.missingGroupsLikelyPreTokenGen=true** when access token has no groups (PreTokenGen broken)", async () => {
    const { ctx } = makeCtx({
      event: makeJwtClaims({ sub: "s1", token_use: "access" }),
      groups: [],
    });
    const res = await handleAdminRoute(ctx);
    assert.equal(res.body.diagnostic.missingGroupsLikelyPreTokenGen, true);
  });

  it("diagnostic.missingGroupsLikelyPreTokenGen=false for ID tokens (no groups expected)", async () => {
    const { ctx } = makeCtx({
      event: makeJwtClaims({ sub: "s1", token_use: "id" }),
      groups: [],
    });
    const res = await handleAdminRoute(ctx);
    assert.equal(res.body.diagnostic.missingGroupsLikelyPreTokenGen, false);
  });

  it("groupsClaimSource: 'cognito:groups' when that claim is present (after PreTokenGen)", async () => {
    const { ctx } = makeCtx({
      event: makeJwtClaims({
        sub: "s1",
        "cognito:groups": ["Admin"],
      }),
      groups: ["Admin"],
    });
    const res = await handleAdminRoute(ctx);
    assert.equal(res.body.groupsClaimSource, "cognito:groups");
  });

  it("groupsClaimSource: 'custom:groups' when that's the source", async () => {
    const { ctx } = makeCtx({
      event: makeJwtClaims({
        sub: "s1",
        "custom:groups": "Staff",
      }),
      groups: ["Staff"],
    });
    const res = await handleAdminRoute(ctx);
    assert.equal(res.body.groupsClaimSource, "custom:groups");
  });

  it("groupsClaimSource: null when no groups", async () => {
    const { ctx } = makeCtx({
      event: makeJwtClaims({ sub: "s1" }),
      groups: [],
    });
    const res = await handleAdminRoute(ctx);
    assert.equal(res.body.groupsClaimSource, null);
  });

  it("name falls back to 'name' claim when 'custom:name' missing", async () => {
    const { ctx } = makeCtx({
      event: makeJwtClaims({ sub: "s1", name: "Alice" }),
    });
    const res = await handleAdminRoute(ctx);
    assert.equal(res.body.name, "Alice");
  });

  it("**no-store cache headers** on response (identity payload, never cache)", async () => {
    const { ctx } = makeCtx({
      event: makeJwtClaims({ sub: "s1" }),
    });
    const res = await handleAdminRoute(ctx);
    assert.equal(res.headers["cache-control"], "no-store");
    assert.equal(res.headers.pragma, "no-cache");
  });
});
