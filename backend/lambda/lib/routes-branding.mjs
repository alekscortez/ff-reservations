// Branding asset routes. Two surfaces share this file because they
// hit the same DDB row set:
//
//   Public (no auth):
//     GET /branding/{filename}   — streams active bytes, or 302
//                                  redirects to the baked-in static
//                                  default when no admin upload exists
//
//   Admin (Admin group only — protected by API GW JWT authorizer +
//          a second-check via requireAdmin):
//     GET    /admin/branding            — list slots + active metadata
//                                          (no bytes, no Base64)
//     POST   /admin/branding/{type}     — upload {data, contentType}
//     DELETE /admin/branding/{type}     — clear the active row
//
// Public response shape: API Gateway HTTP API supports binary
// returns when the Lambda response sets isBase64Encoded=true; the
// gateway base64-decodes and writes raw bytes to the wire. We send
// a short Cache-Control + an ETag (the 16-char contentHash) so the
// browser revalidates each minute, and Meta scrapers see a new hash
// whenever the admin uploads a new image.
//
// Public-default fallback uses a 302 to the static-file path so
// the Amplify CDN keeps serving the baked-in default for free until
// someone actually uploads.

import { filenameToBrandingType, isKnownBrandingType } from "./services-branding.mjs";

const PUBLIC_DEFAULTS = {
  "og-image.png": "/og-image.png",
  "og-image-square.png": "/og-image-square.png",
  "favicon.svg": "/favicon.svg",
};

export async function handleBrandingRoute(ctx) {
  const {
    method,
    path,
    event,
    cors,
    json,
    noContent,
    httpError,
    getBody,
    getUserLabel,
    requireAdmin,
    getActiveAsset,
    setActiveAsset,
    clearActiveAsset,
    listActiveAssets,
    publicBookingReturnBaseUrl,
  } = ctx;

  // ---------- Public: GET /branding/{filename} ----------
  const publicMatch = path.match(/^\/branding\/([A-Za-z0-9._-]+)\/?$/);
  if (method === "GET" && publicMatch) {
    const filename = publicMatch[1];
    const type = filenameToBrandingType(filename);
    if (!type) {
      // Unknown filename: redirect to root so we never serve attacker
      // input back as a 200 with arbitrary content type.
      return json(404, { message: "Unknown branding asset", filename }, cors);
    }

    if (typeof getActiveAsset !== "function") {
      // Service unavailable — fall through to default static so the
      // page still renders an image instead of 500ing.
      return redirectToDefault(filename, cors, publicBookingReturnBaseUrl);
    }

    const ifNoneMatch = String(
      event?.headers?.["if-none-match"] ??
        event?.headers?.["If-None-Match"] ??
        ""
    ).trim();

    let active = null;
    try {
      active = await getActiveAsset(type);
    } catch (err) {
      console.warn("branding_public_read_failed", {
        type,
        message: String(err?.message ?? ""),
      });
      active = null;
    }

    if (!active) {
      return redirectToDefault(filename, cors, publicBookingReturnBaseUrl);
    }

    const etag = `"${active.contentHash}"`;
    if (ifNoneMatch && ifNoneMatch === etag) {
      return {
        statusCode: 304,
        headers: {
          ...cors,
          etag,
          "cache-control": "public, max-age=60, must-revalidate",
        },
        body: "",
      };
    }

    return {
      statusCode: 200,
      headers: {
        ...cors,
        "content-type": active.contentType || "application/octet-stream",
        etag,
        // 60s browser cache + must-revalidate: catches admin uploads
        // within a minute on direct re-fetches (Meta scraper, customer
        // hard-refresh). Long-tail CDN cache is at /og-image.png — the
        // static fallback — which Amplify caches harder.
        "cache-control": "public, max-age=60, must-revalidate",
        "x-branding-hash": active.contentHash,
      },
      body: active.data.toString("base64"),
      isBase64Encoded: true,
    };
  }

  // ---------- Admin: GET /admin/branding ----------
  if (method === "GET" && /^\/admin\/branding\/?$/.test(path)) {
    if (typeof requireAdmin === "function") requireAdmin(event);
    if (typeof listActiveAssets !== "function") {
      return json(501, { message: "Branding service unavailable" }, cors);
    }
    const list = await listActiveAssets();
    return json(
      200,
      { assets: list },
      { ...cors, "cache-control": "no-store", pragma: "no-cache" }
    );
  }

  // ---------- Admin: POST /admin/branding/{type} ----------
  const adminUploadMatch = path.match(/^\/admin\/branding\/([A-Za-z0-9-]+)\/?$/);
  if (method === "POST" && adminUploadMatch) {
    if (typeof requireAdmin === "function") requireAdmin(event);
    const type = adminUploadMatch[1];
    if (!isKnownBrandingType(type)) {
      return json(404, { message: `Unknown branding type: ${type}` }, cors);
    }
    if (typeof setActiveAsset !== "function") {
      return json(501, { message: "Branding service unavailable" }, cors);
    }

    const body = getBody(event);
    if (!body || typeof body !== "object") {
      throw httpError(400, "Request body must be JSON");
    }
    const rawData = String(body.data ?? "").trim();
    if (!rawData) {
      throw httpError(400, "Missing field: data (base64-encoded bytes)");
    }
    let bytes;
    try {
      bytes = Buffer.from(rawData, "base64");
    } catch {
      throw httpError(400, "Field 'data' must be valid base64");
    }
    if (!bytes || bytes.byteLength === 0) {
      throw httpError(400, "Decoded upload is empty");
    }

    const contentType = String(body.contentType ?? "").trim();
    const user = typeof getUserLabel === "function" ? await getUserLabel(event) : "admin";

    const result = await setActiveAsset(type, { data: bytes, contentType }, user);
    return json(200, { asset: result }, { ...cors, "cache-control": "no-store" });
  }

  // ---------- Admin: DELETE /admin/branding/{type} ----------
  if (method === "DELETE" && adminUploadMatch) {
    if (typeof requireAdmin === "function") requireAdmin(event);
    const type = adminUploadMatch[1];
    if (!isKnownBrandingType(type)) {
      return json(404, { message: `Unknown branding type: ${type}` }, cors);
    }
    if (typeof clearActiveAsset !== "function") {
      return json(501, { message: "Branding service unavailable" }, cors);
    }
    const result = await clearActiveAsset(type);
    return json(200, result, { ...cors, "cache-control": "no-store" });
  }

  return null;
}

function redirectToDefault(filename, cors, publicBookingReturnBaseUrl) {
  const defaultPath = PUBLIC_DEFAULTS[filename] ?? `/${filename}`;
  // Absolute redirect to the customer-facing host so the Lambda
  // response works whether the request came via the API host
  // (api.famosofuego.com/branding/...) or the SPA host through an
  // Amplify rewrite. The browser/Meta scraper follows the 302 to
  // famosofuego.com/<file> — that path serves the baked-in default.
  const base = String(publicBookingReturnBaseUrl ?? "https://famosofuego.com").replace(
    /\/$/,
    ""
  );
  const location = `${base}${defaultPath}`;
  return {
    statusCode: 302,
    headers: {
      ...cors,
      location,
      // Short cache so a fresh upload starts overriding within a minute
      // (the 302 itself is what we want to invalidate when the admin
      // uploads — otherwise the browser sticks with the 302 even after
      // bytes are available).
      "cache-control": "public, max-age=60, must-revalidate",
    },
    body: "",
  };
}
