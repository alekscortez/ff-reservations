// Branding asset storage. Lets admins upload custom OG images (the
// link-preview cards Meta/WhatsApp/iMessage show when famosofuego.com
// is shared) and a custom browser icon, without a redeploy.
//
// Storage model: rows in SETTINGS_TABLE under (PK="APP", SK="BRANDING#{type}").
// Image bytes live in a DDB binary attribute, capped at 300 KB raw to
// stay well under the 400 KB DDB item-size limit. Tiny operational
// footprint (one row per type, no rotation, no S3 to manage). If we
// ever need larger images we'll lift this to S3 + signed URL.
//
// Reader: getActiveAsset(type) returns the Item or null.
//   Public route GET /branding/{filename} → if active, stream bytes
//   with Cache-Control + ETag; if null, 302 redirect to the baked-in
//   static at /og-image.png|/og-image-square.png|/favicon.svg.
//
// Writer: setActiveAsset(type, {data, contentType, sizeBytes}, user) —
//   validates contentType against an allowlist per type, validates
//   size, computes contentHash for ETag, then PutCommand-overwrites
//   the row. Returns the full metadata (minus bytes) so the caller
//   can respond without re-reading.
//
// Per-type rules (kept here, not in the route, so the test suite can
// own them):
//   og-image         — image/png | image/jpeg | image/webp, ≤300 KB
//   og-image-square  — image/png | image/jpeg | image/webp, ≤300 KB
//   favicon          — image/svg+xml only, ≤50 KB (browsers scale SVGs;
//                      we don't auto-derive PNG variants from upload,
//                      so accepting raster here would silently break
//                      non-SVG-capable clients that fall back to .ico)

import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { createHash } from "node:crypto";

const SETTINGS_PK = "APP";
const SK_PREFIX = "BRANDING#";

export const BRANDING_TYPES = Object.freeze({
  "og-image": {
    allowedContentTypes: new Set(["image/png", "image/jpeg", "image/webp"]),
    maxBytes: 300_000,
    // Hint shown in admin UI / 400 error bodies — describes the slot,
    // NOT the upload validation. Validation is allowedContentTypes/maxBytes.
    description: "Wide image (1200×630) — Facebook, Meta ads, Twitter",
    defaultStaticPath: "/og-image.png",
  },
  "og-image-square": {
    allowedContentTypes: new Set(["image/png", "image/jpeg", "image/webp"]),
    maxBytes: 300_000,
    description: "Square image (1200×1200) — WhatsApp, iMessage",
    defaultStaticPath: "/og-image-square.png",
  },
  favicon: {
    allowedContentTypes: new Set(["image/svg+xml"]),
    maxBytes: 50_000,
    description: "Browser tab icon (SVG)",
    defaultStaticPath: "/favicon.svg",
  },
});

export function isKnownBrandingType(type) {
  return Object.prototype.hasOwnProperty.call(BRANDING_TYPES, String(type ?? ""));
}

// Maps a public URL filename to a branding type. Filenames are stable
// so Meta/browsers can cache them; the underlying bytes change behind
// the same URL when an admin uploads a new asset.
export function filenameToBrandingType(filename) {
  switch (String(filename ?? "").trim()) {
    case "og-image.png":
      return "og-image";
    case "og-image-square.png":
      return "og-image-square";
    case "favicon.svg":
      return "favicon";
    default:
      return null;
  }
}

export function computeContentHash(data) {
  const buf = data instanceof Uint8Array ? Buffer.from(data) : Buffer.from(String(data ?? ""));
  return createHash("sha256").update(buf).digest("hex").slice(0, 16);
}

export function createBrandingService({ ddb, tableNames, nowEpoch, httpError }) {
  const tableName = String(tableNames?.SETTINGS_TABLE ?? "").trim();

  function assertTable() {
    if (!tableName) {
      throw httpError(500, "SETTINGS_TABLE is not configured");
    }
  }

  function assertKnownType(type) {
    if (!isKnownBrandingType(type)) {
      throw httpError(400, `Unknown branding type: ${type}`);
    }
  }

  function validateUpload(type, { data, contentType }) {
    assertKnownType(type);
    const spec = BRANDING_TYPES[type];

    const ct = String(contentType ?? "").trim().toLowerCase();
    if (!spec.allowedContentTypes.has(ct)) {
      const allowed = [...spec.allowedContentTypes].join(", ");
      throw httpError(
        400,
        `File type not allowed (${ct || "unknown"}). Allowed: ${allowed}`
      );
    }

    if (!(data instanceof Uint8Array) && !Buffer.isBuffer(data)) {
      throw httpError(400, "Upload data must be raw bytes");
    }
    const sizeBytes = data.byteLength;
    if (sizeBytes <= 0) {
      throw httpError(400, "File is empty");
    }
    if (sizeBytes > spec.maxBytes) {
      const maxKb = Math.round(spec.maxBytes / 1000);
      throw httpError(
        400,
        `File too large (${Math.round(sizeBytes / 1000)} KB). Max: ${maxKb} KB`
      );
    }

    return { ct, sizeBytes };
  }

  async function getActiveAsset(type) {
    assertTable();
    assertKnownType(type);
    const out = await ddb.send(
      new GetCommand({
        TableName: tableName,
        Key: { PK: SETTINGS_PK, SK: `${SK_PREFIX}${type}` },
      })
    );
    const item = out?.Item;
    if (!item) return null;
    // Coerce the binary attribute back to Buffer for callers that
    // need to stream bytes. DDB returns Uint8Array for binary fields.
    const data = item.data;
    const buffer = data instanceof Uint8Array ? Buffer.from(data) : null;
    if (!buffer || buffer.byteLength === 0) return null;
    return {
      type,
      data: buffer,
      contentType: String(item.contentType ?? ""),
      sizeBytes: Number(item.sizeBytes ?? buffer.byteLength),
      contentHash: String(item.contentHash ?? ""),
      updatedAt: Number(item.updatedAt ?? 0),
      updatedBy: String(item.updatedBy ?? ""),
    };
  }

  async function setActiveAsset(type, { data, contentType }, user) {
    assertTable();
    const { ct, sizeBytes } = validateUpload(type, { data, contentType });

    const buffer = data instanceof Buffer ? data : Buffer.from(data);
    const contentHash = computeContentHash(buffer);
    const now = nowEpoch();
    const item = {
      PK: SETTINGS_PK,
      SK: `${SK_PREFIX}${type}`,
      entityType: "BRANDING_ASSET",
      brandingType: type,
      data: buffer,
      contentType: ct,
      sizeBytes,
      contentHash,
      updatedAt: now,
      updatedBy: String(user ?? "").trim() || "system",
    };
    await ddb.send(new PutCommand({ TableName: tableName, Item: item }));
    return {
      type,
      contentType: ct,
      sizeBytes,
      contentHash,
      updatedAt: now,
      updatedBy: item.updatedBy,
    };
  }

  async function clearActiveAsset(type) {
    assertTable();
    assertKnownType(type);
    await ddb.send(
      new DeleteCommand({
        TableName: tableName,
        Key: { PK: SETTINGS_PK, SK: `${SK_PREFIX}${type}` },
      })
    );
    return { type, cleared: true };
  }

  // Used by the admin UI to render the current state. Skips the raw
  // binary payload so the response stays small (~1 KB regardless of
  // image size); the admin UI fetches actual bytes via the public
  // /branding/{filename} URL with a cache-buster.
  async function listActiveAssets() {
    assertTable();
    const out = await ddb.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "#pk = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeNames: { "#pk": "PK" },
        ExpressionAttributeValues: { ":pk": SETTINGS_PK, ":sk": SK_PREFIX },
      })
    );
    const byType = {};
    for (const it of out?.Items ?? []) {
      const t = String(it?.brandingType ?? "").trim();
      if (!isKnownBrandingType(t)) continue;
      const data = it.data;
      const sizeBytes = Number(
        it.sizeBytes ?? (data instanceof Uint8Array ? data.byteLength : 0)
      );
      byType[t] = {
        type: t,
        contentType: String(it.contentType ?? ""),
        sizeBytes,
        contentHash: String(it.contentHash ?? ""),
        updatedAt: Number(it.updatedAt ?? 0),
        updatedBy: String(it.updatedBy ?? ""),
      };
    }

    // Always return the full type list so the admin UI can render
    // "no custom uploaded" slots without an extra round-trip.
    const result = [];
    for (const type of Object.keys(BRANDING_TYPES)) {
      const spec = BRANDING_TYPES[type];
      result.push({
        type,
        description: spec.description,
        defaultStaticPath: spec.defaultStaticPath,
        maxBytes: spec.maxBytes,
        allowedContentTypes: [...spec.allowedContentTypes],
        active: byType[type] ?? null,
      });
    }
    return result;
  }

  return {
    getActiveAsset,
    setActiveAsset,
    clearActiveAsset,
    listActiveAssets,
    validateUpload,
  };
}
