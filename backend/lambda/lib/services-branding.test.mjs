import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  BRANDING_TYPES,
  computeContentHash,
  createBrandingService,
  filenameToBrandingType,
  isKnownBrandingType,
} from "./services-branding.mjs";

function makeFakeDdb() {
  const sends = [];
  let nextGetResult = { Item: null };
  let nextQueryResult = { Items: [] };
  return {
    sends,
    setGetResult(item) {
      nextGetResult = { Item: item };
    },
    setQueryResult(items) {
      nextQueryResult = { Items: items };
    },
    send: async (cmd) => {
      sends.push(cmd);
      const ctor = cmd?.constructor?.name ?? "";
      if (ctor === "GetCommand") return nextGetResult;
      if (ctor === "QueryCommand") return nextQueryResult;
      return {};
    },
  };
}

const httpError = (status, message) => {
  const err = new Error(message);
  err.statusCode = status;
  return err;
};

const nowEpoch = () => 1_700_000_000;

const SVG_BYTES = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

describe("services-branding", () => {
  describe("filenameToBrandingType", () => {
    it("maps og-image.png → og-image", () => {
      assert.equal(filenameToBrandingType("og-image.png"), "og-image");
    });
    it("maps og-image-square.png → og-image-square", () => {
      assert.equal(filenameToBrandingType("og-image-square.png"), "og-image-square");
    });
    it("maps favicon.svg → favicon", () => {
      assert.equal(filenameToBrandingType("favicon.svg"), "favicon");
    });
    it("returns null for unknown filenames", () => {
      assert.equal(filenameToBrandingType("favicon.ico"), null);
      assert.equal(filenameToBrandingType("../etc/passwd"), null);
      assert.equal(filenameToBrandingType(""), null);
      assert.equal(filenameToBrandingType(null), null);
    });
  });

  describe("isKnownBrandingType", () => {
    it("accepts the three configured types", () => {
      assert.equal(isKnownBrandingType("og-image"), true);
      assert.equal(isKnownBrandingType("og-image-square"), true);
      assert.equal(isKnownBrandingType("favicon"), true);
    });
    it("rejects anything else", () => {
      assert.equal(isKnownBrandingType("apple-touch-icon"), false);
      assert.equal(isKnownBrandingType(""), false);
      assert.equal(isKnownBrandingType(null), false);
    });
  });

  describe("computeContentHash", () => {
    it("returns a stable 16-char hex digest", () => {
      const h1 = computeContentHash(Buffer.from("hello"));
      const h2 = computeContentHash(Buffer.from("hello"));
      assert.equal(h1, h2);
      assert.equal(h1.length, 16);
      assert.match(h1, /^[0-9a-f]{16}$/);
    });
    it("changes when bytes change", () => {
      const a = computeContentHash(Buffer.from("hello"));
      const b = computeContentHash(Buffer.from("world"));
      assert.notEqual(a, b);
    });
  });

  describe("validateUpload", () => {
    let svc;
    beforeEach(() => {
      svc = createBrandingService({
        ddb: makeFakeDdb(),
        tableNames: { SETTINGS_TABLE: "ff-settings" },
        nowEpoch,
        httpError,
      });
    });

    it("accepts a small PNG for og-image", () => {
      const result = svc.validateUpload("og-image", {
        data: PNG_BYTES,
        contentType: "image/png",
      });
      assert.equal(result.ct, "image/png");
      assert.equal(result.sizeBytes, PNG_BYTES.byteLength);
    });

    it("accepts JPEG + WebP for og-image", () => {
      svc.validateUpload("og-image", { data: PNG_BYTES, contentType: "image/jpeg" });
      svc.validateUpload("og-image", { data: PNG_BYTES, contentType: "image/webp" });
    });

    it("rejects SVG for og-image", () => {
      assert.throws(
        () => svc.validateUpload("og-image", { data: SVG_BYTES, contentType: "image/svg+xml" }),
        /Tipo de archivo no permitido/
      );
    });

    it("accepts only SVG for favicon", () => {
      svc.validateUpload("favicon", { data: SVG_BYTES, contentType: "image/svg+xml" });
      assert.throws(
        () => svc.validateUpload("favicon", { data: PNG_BYTES, contentType: "image/png" }),
        /Tipo de archivo no permitido/
      );
    });

    it("rejects empty uploads", () => {
      assert.throws(
        () => svc.validateUpload("og-image", { data: Buffer.alloc(0), contentType: "image/png" }),
        /vacío/
      );
    });

    it("rejects uploads over the per-type size cap", () => {
      const oversized = Buffer.alloc(BRANDING_TYPES["og-image"].maxBytes + 1);
      assert.throws(
        () => svc.validateUpload("og-image", { data: oversized, contentType: "image/png" }),
        /muy grande/
      );
    });

    it("rejects favicon over the 50 KB cap (smaller than og-image's 300 KB)", () => {
      const big = Buffer.alloc(60_000);
      assert.throws(
        () => svc.validateUpload("favicon", { data: big, contentType: "image/svg+xml" }),
        /muy grande/
      );
    });

    it("rejects unknown types with 400", () => {
      assert.throws(
        () => svc.validateUpload("apple-touch-icon", { data: PNG_BYTES, contentType: "image/png" }),
        (err) => err.statusCode === 400
      );
    });

    it("requires data to be bytes", () => {
      assert.throws(
        () => svc.validateUpload("og-image", { data: "not-bytes", contentType: "image/png" }),
        /raw bytes/
      );
    });
  });

  describe("setActiveAsset / getActiveAsset", () => {
    let ddb, svc;
    beforeEach(() => {
      ddb = makeFakeDdb();
      svc = createBrandingService({
        ddb,
        tableNames: { SETTINGS_TABLE: "ff-settings" },
        nowEpoch,
        httpError,
      });
    });

    it("writes a PutCommand with binary data + metadata", async () => {
      const result = await svc.setActiveAsset(
        "og-image",
        { data: PNG_BYTES, contentType: "image/png" },
        "aleks@redbone.mx"
      );
      assert.equal(result.type, "og-image");
      assert.equal(result.contentType, "image/png");
      assert.equal(result.sizeBytes, PNG_BYTES.byteLength);
      assert.equal(result.updatedBy, "aleks@redbone.mx");
      assert.match(result.contentHash, /^[0-9a-f]{16}$/);

      assert.equal(ddb.sends.length, 1);
      const put = ddb.sends[0];
      assert.equal(put.constructor.name, "PutCommand");
      assert.equal(put.input.Item.PK, "APP");
      assert.equal(put.input.Item.SK, "BRANDING#og-image");
      assert.equal(put.input.Item.brandingType, "og-image");
      assert.equal(put.input.Item.entityType, "BRANDING_ASSET");
      assert.ok(Buffer.isBuffer(put.input.Item.data));
    });

    it("falls back to 'system' when no user provided", async () => {
      const result = await svc.setActiveAsset(
        "favicon",
        { data: SVG_BYTES, contentType: "image/svg+xml" },
        ""
      );
      assert.equal(result.updatedBy, "system");
    });

    it("getActiveAsset coerces DDB Uint8Array back to Buffer", async () => {
      ddb.setGetResult({
        PK: "APP",
        SK: "BRANDING#og-image",
        brandingType: "og-image",
        data: new Uint8Array(PNG_BYTES),
        contentType: "image/png",
        sizeBytes: PNG_BYTES.byteLength,
        contentHash: "abc123",
        updatedAt: 100,
        updatedBy: "aleks",
      });
      const active = await svc.getActiveAsset("og-image");
      assert.ok(active);
      assert.ok(Buffer.isBuffer(active.data));
      assert.equal(active.contentType, "image/png");
      assert.equal(active.contentHash, "abc123");
    });

    it("getActiveAsset returns null when row missing", async () => {
      ddb.setGetResult(null);
      const active = await svc.getActiveAsset("og-image");
      assert.equal(active, null);
    });

    it("getActiveAsset returns null when row has empty bytes (treat as deleted)", async () => {
      ddb.setGetResult({
        data: new Uint8Array(0),
        contentType: "image/png",
      });
      const active = await svc.getActiveAsset("og-image");
      assert.equal(active, null);
    });

    it("getActiveAsset rejects unknown type", async () => {
      await assert.rejects(
        () => svc.getActiveAsset("apple-touch-icon"),
        (err) => err.statusCode === 400
      );
    });
  });

  describe("clearActiveAsset", () => {
    it("issues a DeleteCommand with the right key", async () => {
      const ddb = makeFakeDdb();
      const svc = createBrandingService({
        ddb,
        tableNames: { SETTINGS_TABLE: "ff-settings" },
        nowEpoch,
        httpError,
      });
      const result = await svc.clearActiveAsset("og-image-square");
      assert.equal(result.cleared, true);
      assert.equal(ddb.sends.length, 1);
      assert.equal(ddb.sends[0].constructor.name, "DeleteCommand");
      assert.equal(ddb.sends[0].input.Key.SK, "BRANDING#og-image-square");
    });
  });

  describe("listActiveAssets", () => {
    it("always returns slots for every known type, with active=null when not uploaded", async () => {
      const ddb = makeFakeDdb();
      ddb.setQueryResult([]);
      const svc = createBrandingService({
        ddb,
        tableNames: { SETTINGS_TABLE: "ff-settings" },
        nowEpoch,
        httpError,
      });
      const list = await svc.listActiveAssets();
      assert.equal(list.length, Object.keys(BRANDING_TYPES).length);
      for (const slot of list) {
        assert.equal(slot.active, null);
        assert.ok(slot.description);
        assert.ok(slot.defaultStaticPath);
      }
    });

    it("populates `active` for types that have a row", async () => {
      const ddb = makeFakeDdb();
      ddb.setQueryResult([
        {
          PK: "APP",
          SK: "BRANDING#og-image",
          brandingType: "og-image",
          data: new Uint8Array(PNG_BYTES),
          contentType: "image/png",
          sizeBytes: PNG_BYTES.byteLength,
          contentHash: "deadbeef00000000",
          updatedAt: 12345,
          updatedBy: "aleks",
        },
      ]);
      const svc = createBrandingService({
        ddb,
        tableNames: { SETTINGS_TABLE: "ff-settings" },
        nowEpoch,
        httpError,
      });
      const list = await svc.listActiveAssets();
      const og = list.find((s) => s.type === "og-image");
      assert.ok(og.active);
      assert.equal(og.active.contentHash, "deadbeef00000000");
      assert.equal(og.active.sizeBytes, PNG_BYTES.byteLength);
      assert.equal(og.active.updatedBy, "aleks");
      // Other types remain null
      assert.equal(list.find((s) => s.type === "favicon").active, null);
    });

    it("skips rows with brandingType outside the known set (forward-compat guard)", async () => {
      const ddb = makeFakeDdb();
      ddb.setQueryResult([
        {
          brandingType: "future-thing",
          data: new Uint8Array(PNG_BYTES),
          contentType: "image/png",
          sizeBytes: 12,
        },
      ]);
      const svc = createBrandingService({
        ddb,
        tableNames: { SETTINGS_TABLE: "ff-settings" },
        nowEpoch,
        httpError,
      });
      const list = await svc.listActiveAssets();
      for (const slot of list) assert.equal(slot.active, null);
    });
  });

  describe("table not configured", () => {
    it("throws 500 when SETTINGS_TABLE empty", async () => {
      const svc = createBrandingService({
        ddb: makeFakeDdb(),
        tableNames: { SETTINGS_TABLE: "" },
        nowEpoch,
        httpError,
      });
      await assert.rejects(
        () => svc.getActiveAsset("og-image"),
        (err) => err.statusCode === 500
      );
    });
  });
});
