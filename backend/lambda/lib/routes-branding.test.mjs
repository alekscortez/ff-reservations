import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { handleBrandingRoute } from "./routes-branding.mjs";

const json = (statusCode, body, extraHeaders = {}) => ({
  statusCode,
  headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
  body: JSON.stringify(body),
});
const noContent = (statusCode = 204, extraHeaders = {}) => ({
  statusCode,
  headers: { ...extraHeaders },
  body: "",
});
const getBody = (event) => {
  if (!event.body) return null;
  return JSON.parse(event.body);
};
const httpError = (statusCode, message) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
};

function eventOf(method, path, extras = {}) {
  return {
    requestContext: {
      http: { method, path },
      authorizer: { jwt: { claims: { sub: "u1", "cognito:groups": ["Admin"] } } },
    },
    headers: extras.headers ?? {},
    body: extras.body ?? null,
    queryStringParameters: extras.qs ?? null,
  };
}

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

function makeCtx(overrides = {}) {
  return {
    method: "GET",
    path: "/",
    event: {},
    cors: {},
    json,
    noContent,
    httpError,
    getBody,
    getUserLabel: async () => "aleks@redbone.mx",
    requireAdmin: () => {},
    getActiveAsset: async () => null,
    setActiveAsset: async () => ({ type: "og-image", contentHash: "abc" }),
    clearActiveAsset: async () => ({ type: "og-image", cleared: true }),
    listActiveAssets: async () => [],
    publicBookingReturnBaseUrl: "https://famosofuego.com",
    ...overrides,
  };
}

describe("routes-branding", () => {
  describe("public GET /branding/{filename}", () => {
    it("404s on unknown filename", async () => {
      const ctx = makeCtx({
        method: "GET",
        path: "/branding/passwords.txt",
        event: eventOf("GET", "/branding/passwords.txt"),
      });
      const res = await handleBrandingRoute(ctx);
      assert.equal(res.statusCode, 404);
    });

    it("redirects to baked-in default when no active asset", async () => {
      const ctx = makeCtx({
        method: "GET",
        path: "/branding/og-image.png",
        event: eventOf("GET", "/branding/og-image.png"),
      });
      const res = await handleBrandingRoute(ctx);
      assert.equal(res.statusCode, 302);
      assert.equal(res.headers.location, "https://famosofuego.com/og-image.png");
    });

    it("returns active bytes as base64-encoded body with proper headers", async () => {
      const ctx = makeCtx({
        method: "GET",
        path: "/branding/og-image-square.png",
        event: eventOf("GET", "/branding/og-image-square.png"),
        getActiveAsset: async (type) => {
          assert.equal(type, "og-image-square");
          return {
            type,
            data: PNG_BYTES,
            contentType: "image/png",
            contentHash: "abc123def4567890",
            sizeBytes: PNG_BYTES.byteLength,
            updatedAt: 100,
            updatedBy: "aleks",
          };
        },
      });
      const res = await handleBrandingRoute(ctx);
      assert.equal(res.statusCode, 200);
      assert.equal(res.isBase64Encoded, true);
      assert.equal(res.headers["content-type"], "image/png");
      assert.equal(res.headers.etag, '"abc123def4567890"');
      assert.match(res.headers["cache-control"], /max-age=60/);
      assert.equal(res.body, PNG_BYTES.toString("base64"));
    });

    it("returns 304 when If-None-Match matches the active ETag", async () => {
      const ctx = makeCtx({
        method: "GET",
        path: "/branding/og-image.png",
        event: eventOf("GET", "/branding/og-image.png", {
          headers: { "if-none-match": '"abc123def4567890"' },
        }),
        getActiveAsset: async () => ({
          type: "og-image",
          data: PNG_BYTES,
          contentType: "image/png",
          contentHash: "abc123def4567890",
        }),
      });
      const res = await handleBrandingRoute(ctx);
      assert.equal(res.statusCode, 304);
      assert.equal(res.body, "");
    });

    it("falls back to default redirect when the read throws (defensive)", async () => {
      const ctx = makeCtx({
        method: "GET",
        path: "/branding/favicon.svg",
        event: eventOf("GET", "/branding/favicon.svg"),
        getActiveAsset: async () => {
          throw new Error("DDB blew up");
        },
      });
      const res = await handleBrandingRoute(ctx);
      assert.equal(res.statusCode, 302);
      assert.equal(res.headers.location, "https://famosofuego.com/favicon.svg");
    });
  });

  describe("admin GET /admin/branding", () => {
    it("returns the list of slots", async () => {
      const ctx = makeCtx({
        method: "GET",
        path: "/admin/branding",
        event: eventOf("GET", "/admin/branding"),
        listActiveAssets: async () => [{ type: "og-image", active: null }],
      });
      const res = await handleBrandingRoute(ctx);
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.deepEqual(body.assets, [{ type: "og-image", active: null }]);
      assert.equal(res.headers["cache-control"], "no-store");
    });

    it("enforces admin via requireAdmin", async () => {
      let called = false;
      const ctx = makeCtx({
        method: "GET",
        path: "/admin/branding",
        event: eventOf("GET", "/admin/branding"),
        requireAdmin: () => {
          called = true;
          throw httpError(403, "Admin privileges required");
        },
      });
      await assert.rejects(() => handleBrandingRoute(ctx), (err) => err.statusCode === 403);
      assert.equal(called, true);
    });
  });

  describe("admin POST /admin/branding/{type}", () => {
    it("decodes base64 body + writes via setActiveAsset", async () => {
      let captured = null;
      const ctx = makeCtx({
        method: "POST",
        path: "/admin/branding/og-image",
        event: eventOf("POST", "/admin/branding/og-image", {
          body: JSON.stringify({
            data: PNG_BYTES.toString("base64"),
            contentType: "image/png",
          }),
        }),
        setActiveAsset: async (type, payload, user) => {
          captured = { type, payload, user };
          return {
            type,
            contentType: payload.contentType,
            sizeBytes: payload.data.byteLength,
            contentHash: "h",
          };
        },
      });
      const res = await handleBrandingRoute(ctx);
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.asset.type, "og-image");
      assert.equal(captured.type, "og-image");
      assert.equal(captured.payload.payload, undefined);
      assert.ok(Buffer.isBuffer(captured.payload.data));
      assert.equal(captured.payload.contentType, "image/png");
      assert.equal(captured.user, "aleks@redbone.mx");
    });

    it("404s on unknown type", async () => {
      const ctx = makeCtx({
        method: "POST",
        path: "/admin/branding/apple-touch-icon",
        event: eventOf("POST", "/admin/branding/apple-touch-icon", {
          body: JSON.stringify({ data: "x", contentType: "image/png" }),
        }),
      });
      const res = await handleBrandingRoute(ctx);
      assert.equal(res.statusCode, 404);
    });

    it("400s when missing 'data'", async () => {
      const ctx = makeCtx({
        method: "POST",
        path: "/admin/branding/og-image",
        event: eventOf("POST", "/admin/branding/og-image", {
          body: JSON.stringify({ contentType: "image/png" }),
        }),
      });
      await assert.rejects(() => handleBrandingRoute(ctx), (err) => err.statusCode === 400);
    });

    it("400s when body isn't JSON object", async () => {
      const ctx = makeCtx({
        method: "POST",
        path: "/admin/branding/og-image",
        event: eventOf("POST", "/admin/branding/og-image", { body: "" }),
      });
      await assert.rejects(() => handleBrandingRoute(ctx), (err) => err.statusCode === 400);
    });

    it("enforces admin", async () => {
      let blocked = false;
      const ctx = makeCtx({
        method: "POST",
        path: "/admin/branding/og-image",
        event: eventOf("POST", "/admin/branding/og-image", {
          body: JSON.stringify({ data: PNG_BYTES.toString("base64"), contentType: "image/png" }),
        }),
        requireAdmin: () => {
          blocked = true;
          throw httpError(403, "Admin privileges required");
        },
      });
      await assert.rejects(() => handleBrandingRoute(ctx), (err) => err.statusCode === 403);
      assert.equal(blocked, true);
    });
  });

  describe("admin DELETE /admin/branding/{type}", () => {
    it("calls clearActiveAsset", async () => {
      let cleared = null;
      const ctx = makeCtx({
        method: "DELETE",
        path: "/admin/branding/og-image-square",
        event: eventOf("DELETE", "/admin/branding/og-image-square"),
        clearActiveAsset: async (type) => {
          cleared = type;
          return { type, cleared: true };
        },
      });
      const res = await handleBrandingRoute(ctx);
      assert.equal(res.statusCode, 200);
      assert.equal(cleared, "og-image-square");
    });

    it("404s on unknown type", async () => {
      const ctx = makeCtx({
        method: "DELETE",
        path: "/admin/branding/whatever",
        event: eventOf("DELETE", "/admin/branding/whatever"),
      });
      const res = await handleBrandingRoute(ctx);
      assert.equal(res.statusCode, 404);
    });
  });

  describe("non-matching paths", () => {
    it("returns null for unrelated paths", async () => {
      const ctx = makeCtx({
        method: "GET",
        path: "/admin/users",
        event: eventOf("GET", "/admin/users"),
      });
      const res = await handleBrandingRoute(ctx);
      assert.equal(res, null);
    });
  });
});
