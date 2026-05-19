// Google Wallet event-ticket pass generator. Mirrors services-wallet-pass.mjs
// in surface area: factory builds a service from env + secret-client; the
// service exposes isEnabled() + a generator that returns an Add-to-Wallet
// save URL for a single reservation + check-in pass token.
//
// Design choices
// - JWT-only save flow: we embed EventTicketClass + EventTicketObject in
//   the JWT payload and hand the customer the `https://pay.google.com/gp/v/save/{jwt}`
//   URL. No pre-create REST call required — Google upserts when the user
//   taps the link. This keeps the in-band path on Lambda zero-RPC.
// - REST surface for revoke + notify is lazy-loaded so cold starts on the
//   PUBLIC save path don't pay for google-auth-library import.
// - Service-account credentials live in Secrets Manager as JSON
//   {client_email, private_key}. Parsed + cached after first load.
// - QR `barcode.value` is `ffr-checkin:{token}` — same primitive as the
//   Apple pass face. The DDB-backed scanner (verifyAndConsumePass) is
//   the security gate; Google Wallet object state is cosmetic.
// - Pure helpers are exported separately for tests.

const SAVE_URL_BASE = "https://pay.google.com/gp/v/save/";
const WALLET_OBJECTS_REST_BASE =
  "https://walletobjects.googleapis.com/walletobjects/v1";
const WALLET_OBJECTS_SCOPE = "https://www.googleapis.com/auth/wallet_object.issuer";

const DEFAULT_HEX_BACKGROUND_COLOR = "#0e0b0a";
const DEFAULT_ORG_NAME = "Famoso Fuego";
const DEFAULT_VENUE_NAME = "Famoso Fuego";
const DEFAULT_VENUE_ADDRESS = "McAllen, TX";
const DEFAULT_EVENT_HOUR_LOCAL = 20; // 8 PM local — anchors lock-screen relevance
const DEFAULT_OPERATING_TZ = "America/Chicago";

// Normalize a freeform string into a Google Wallet ID suffix. Issuer-scoped
// IDs disallow some chars; coerce to [A-Za-z0-9._-] and lowercase.
export function sanitizeIdSuffix(input) {
  return String(input ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
}

export function buildClassId(issuerId, eventDate) {
  const issuer = String(issuerId ?? "").trim();
  const date = String(eventDate ?? "").trim();
  if (!issuer || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return "";
  return `${issuer}.ff-event-${date}`;
}

export function buildObjectId(issuerId, reservationId) {
  const issuer = String(issuerId ?? "").trim();
  const suffix = sanitizeIdSuffix(reservationId);
  if (!issuer || !suffix) return "";
  return `${issuer}.res-${suffix}`;
}

export function formatEventDateLabel(eventDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) return eventDate || "";
  const [y, m, d] = eventDate.split("-").map((v) => Number(v));
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
    return eventDate;
  }
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (Number.isNaN(dt.getTime())) return eventDate;
  return dt.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function localizedString(value, language = "en-US") {
  const v = String(value ?? "").trim();
  if (!v) return undefined;
  return { defaultValue: { language, value: v } };
}

function tableFieldText(tableIds) {
  const list = Array.isArray(tableIds)
    ? tableIds.map((v) => String(v ?? "").trim()).filter(Boolean)
    : [];
  if (list.length === 0) return { header: "TABLE", body: "—" };
  if (list.length === 1) return { header: "TABLE", body: list[0] };
  return { header: "TABLES", body: list.join(", ") };
}

function depositFieldText(reservation) {
  const isCourtesy =
    String(reservation?.paymentStatus ?? "").toUpperCase() === "COURTESY";
  if (isCourtesy) return { header: "DEPOSIT", body: "Courtesy" };
  const depositAmount = Number(reservation?.depositAmount ?? 0);
  const paid = Number(reservation?.paymentTotal ?? reservation?.paid ?? depositAmount);
  if (!Number.isFinite(paid) || paid <= 0) return { header: "DEPOSIT", body: "—" };
  return { header: "DEPOSIT", body: `$${paid.toFixed(2)}` };
}

const ARRIVAL_LINES = [
  "Head straight to your table — no check-in line.",
  "Reserved all night — come whenever you like.",
  "Show this pass to any staff member if you need help.",
];

const TERMS_BODY =
  "Self-cancellation requires at least 24 hours before the event.";

// Pure: build the EventTicketClass payload. No env-derived branding apart
// from what's passed in via opts so this is fully testable.
export function buildEventTicketClass({
  classId,
  issuerName,
  eventDate,
  logoUri,
  heroImageUri,
  venueName,
  venueAddress,
  hexBackgroundColor,
}) {
  const cls = {
    id: classId,
    eventId: classId.split(".").slice(1).join(".") || classId,
    issuerName: String(issuerName ?? "").trim() || DEFAULT_ORG_NAME,
    reviewStatus: "UNDER_REVIEW",
    eventName: localizedString("Famoso Fuego Reservation"),
    confirmationCodeLabel: "RESERVATION_NUMBER",
    hexBackgroundColor: String(hexBackgroundColor ?? "").trim() ||
      DEFAULT_HEX_BACKGROUND_COLOR,
  };

  const dateTime = buildEventDateTime(eventDate);
  if (dateTime) cls.dateTime = dateTime;

  const venueNameStr = String(venueName ?? "").trim() || DEFAULT_VENUE_NAME;
  const venueAddrStr = String(venueAddress ?? "").trim() || DEFAULT_VENUE_ADDRESS;
  cls.venue = {
    name: localizedString(venueNameStr),
    address: localizedString(venueAddrStr),
  };

  if (logoUri) {
    cls.logo = {
      sourceUri: { uri: logoUri },
      contentDescription: localizedString("Famoso Fuego logo"),
    };
  }
  if (heroImageUri) {
    cls.heroImage = {
      sourceUri: { uri: heroImageUri },
      contentDescription: localizedString("Famoso Fuego event banner"),
    };
  }

  return cls;
}

function buildEventDateTime(eventDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(eventDate ?? ""))) return null;
  // Simple ISO-without-tz form is accepted in the JWT-embedded shape
  // (see Google's Node sample). The "T20:00:00" anchor mirrors Apple's
  // relevantDate convention so lock-screen relevance fires near event
  // time — Google can't infer tz from this alone but our customers are
  // all in CT and Google falls back to the device locale, which is fine
  // for v1.
  return {
    start: `${eventDate}T${String(DEFAULT_EVENT_HOUR_LOCAL).padStart(2, "0")}:00:00`,
  };
}

// Pure: build the EventTicketObject. Wraps the per-reservation data
// in the shape Google Wallet expects.
export function buildEventTicketObject({
  objectId,
  classId,
  reservation,
  checkInPassToken,
}) {
  const customerName = String(reservation?.customerName ?? "").trim() || "Guest";
  const reservationId = String(reservation?.reservationId ?? "").trim();
  const confirmationCode = String(reservation?.confirmationCode ?? "").trim();
  const friendlyCode = confirmationCode ? `FF-${confirmationCode}` : reservationId;

  const rawTableIds = Array.isArray(reservation?.tableIds)
    ? reservation.tableIds.map((v) => String(v ?? "").trim()).filter(Boolean)
    : [];
  const fallbackTableId = String(reservation?.tableId ?? "").trim();
  const tableIds =
    rawTableIds.length > 0
      ? rawTableIds
      : fallbackTableId
      ? [fallbackTableId]
      : [];
  const tableField = tableFieldText(tableIds);
  const depositField = depositFieldText(reservation);

  const obj = {
    id: objectId,
    classId,
    state: "ACTIVE",
    ticketHolderName: customerName,
    ticketNumber: friendlyCode,
    barcode: {
      type: "QR_CODE",
      value: `ffr-checkin:${String(checkInPassToken ?? "").trim()}`,
      alternateText: friendlyCode,
    },
    textModulesData: [
      { id: "tables", header: tableField.header, body: tableField.body },
      { id: "deposit", header: depositField.header, body: depositField.body },
      {
        id: "status",
        header: "STATUS",
        body: "CONFIRMED",
      },
      {
        id: "arrival",
        header: "When you arrive",
        body: ARRIVAL_LINES.join("\n"),
      },
      {
        id: "reservation-id",
        header: "Reservation ID",
        body: reservationId || "—",
      },
      {
        id: "terms",
        header: "Terms",
        body: TERMS_BODY,
      },
    ],
  };

  if (confirmationCode) {
    obj.reservationInfo = { confirmationCode: `FF-${confirmationCode}` };
  }

  return obj;
}

export function buildJwtClaims({
  clientEmail,
  origins,
  eventTicketClass,
  eventTicketObject,
  iat,
}) {
  return {
    iss: String(clientEmail ?? "").trim(),
    aud: "google",
    typ: "savetowallet",
    iat: Number.isFinite(iat) ? iat : Math.floor(Date.now() / 1000),
    origins: Array.isArray(origins) ? origins.filter(Boolean) : [],
    payload: {
      eventTicketClasses: [eventTicketClass],
      eventTicketObjects: [eventTicketObject],
    },
  };
}

export function buildSaveUrl(signedJwt) {
  const jwt = String(signedJwt ?? "").trim();
  if (!jwt) return "";
  return `${SAVE_URL_BASE}${jwt}`;
}

export function createGoogleWalletService({
  secretClient,
  env,
  httpError,
  fetchImpl,
  jwtSignImpl,
  googleAuthFactory,
}) {
  const issuerId = String(env?.GOOGLE_WALLET_ISSUER_ID ?? "").trim();
  const secretArn = String(env?.GOOGLE_WALLET_SERVICE_ACCOUNT_SECRET_ARN ?? "").trim();
  const originsRaw = String(env?.GOOGLE_WALLET_ORIGINS ?? "").trim();
  const origins = originsRaw
    ? originsRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : ["https://famosofuego.com"];
  const issuerName =
    String(env?.GOOGLE_WALLET_ISSUER_NAME ?? "").trim() || DEFAULT_ORG_NAME;
  const venueName =
    String(env?.GOOGLE_WALLET_VENUE_NAME ?? "").trim() || DEFAULT_VENUE_NAME;
  const venueAddress =
    String(env?.GOOGLE_WALLET_VENUE_ADDRESS ?? "").trim() || DEFAULT_VENUE_ADDRESS;
  const logoUri = String(env?.GOOGLE_WALLET_LOGO_URI ?? "").trim();
  const heroImageUri = String(env?.GOOGLE_WALLET_HERO_IMAGE_URI ?? "").trim();
  const hexBackgroundColor =
    String(env?.WALLET_BACKGROUND_COLOR ?? "").trim() || DEFAULT_HEX_BACKGROUND_COLOR;

  let cachedCreds = null;
  let cachedAuthClient = null;

  function isEnabled() {
    return Boolean(issuerId && secretArn);
  }

  async function resolveCredentials() {
    if (cachedCreds) return cachedCreds;
    if (!secretArn) {
      throw httpError(501, "GOOGLE_WALLET_SERVICE_ACCOUNT_SECRET_ARN is not configured");
    }
    if (!secretClient || typeof secretClient.send !== "function") {
      throw httpError(500, "Google Wallet secret client is not available");
    }
    const { GetSecretValueCommand } = await import("@aws-sdk/client-secrets-manager");
    const result = await secretClient.send(
      new GetSecretValueCommand({ SecretId: secretArn })
    );
    const raw = result?.SecretString;
    if (!raw) {
      throw httpError(500, "Google Wallet secret is empty");
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw httpError(500, "Google Wallet secret is not valid JSON");
    }
    const clientEmail = String(parsed?.client_email ?? "").trim();
    const privateKey = String(parsed?.private_key ?? "").trim();
    if (!clientEmail || !privateKey) {
      throw httpError(500, "Google Wallet secret is missing client_email/private_key");
    }
    cachedCreds = { clientEmail, privateKey };
    return cachedCreds;
  }

  async function resolveJwtSigner() {
    if (typeof jwtSignImpl === "function") return jwtSignImpl;
    const mod = await import("jsonwebtoken");
    return mod.default?.sign ?? mod.sign;
  }

  async function resolveAuthClient() {
    if (cachedAuthClient) return cachedAuthClient;
    const creds = await resolveCredentials();
    if (typeof googleAuthFactory === "function") {
      cachedAuthClient = await googleAuthFactory(creds);
      return cachedAuthClient;
    }
    const mod = await import("google-auth-library");
    const JWT = mod.JWT ?? mod.default?.JWT;
    if (!JWT) {
      throw httpError(500, "google-auth-library JWT export is unavailable");
    }
    cachedAuthClient = new JWT({
      email: creds.clientEmail,
      key: creds.privateKey,
      scopes: [WALLET_OBJECTS_SCOPE],
    });
    return cachedAuthClient;
  }

  function assertEnabled() {
    if (!isEnabled()) {
      throw httpError(
        501,
        "Google Wallet is not configured for this environment"
      );
    }
  }

  // Produce an Add-to-Google-Wallet save URL for the given reservation +
  // check-in pass. Idempotent on the Google side — re-saving the same
  // objectId is a no-op (Google updates in place).
  async function generateSaveUrlForReservation({ reservation, checkInPass }) {
    assertEnabled();

    const reservationId = String(reservation?.reservationId ?? "").trim();
    const eventDate = String(reservation?.eventDate ?? "").trim();
    if (!reservationId || !eventDate) {
      throw httpError(400, "Reservation is missing reservationId or eventDate");
    }
    const token = String(checkInPass?.token ?? "").trim();
    if (!token) {
      throw httpError(412, "Check-in pass token is required");
    }

    const classId = buildClassId(issuerId, eventDate);
    const objectId = buildObjectId(issuerId, reservationId);
    if (!classId || !objectId) {
      throw httpError(500, "Failed to build Google Wallet class/object id");
    }

    const creds = await resolveCredentials();
    const sign = await resolveJwtSigner();

    const eventTicketClass = buildEventTicketClass({
      classId,
      issuerName,
      eventDate,
      logoUri,
      heroImageUri,
      venueName,
      venueAddress,
      hexBackgroundColor,
    });
    const eventTicketObject = buildEventTicketObject({
      objectId,
      classId,
      reservation,
      checkInPassToken: token,
    });

    const claims = buildJwtClaims({
      clientEmail: creds.clientEmail,
      origins,
      eventTicketClass,
      eventTicketObject,
    });

    const signedJwt = sign(claims, creds.privateKey, { algorithm: "RS256" });
    const saveUrl = buildSaveUrl(signedJwt);

    return {
      saveUrl,
      classId,
      objectId,
    };
  }

  async function authorizedFetch(method, url, body) {
    const fetcher = typeof fetchImpl === "function" ? fetchImpl : globalThis.fetch;
    if (typeof fetcher !== "function") {
      throw httpError(500, "fetch is not available for Google Wallet REST calls");
    }
    const client = await resolveAuthClient();
    const accessToken =
      typeof client.getAccessToken === "function"
        ? (await client.getAccessToken())?.token ?? (await client.getAccessToken())
        : null;
    if (!accessToken) {
      throw httpError(500, "Failed to obtain Google Wallet access token");
    }
    const tokenStr =
      typeof accessToken === "string" ? accessToken : accessToken?.token ?? "";
    const res = await fetcher(url, {
      method,
      headers: {
        Authorization: `Bearer ${tokenStr}`,
        "Content-Type": "application/json",
      },
      body: body == null ? undefined : JSON.stringify(body),
    });
    return res;
  }

  // Flip an existing EventTicketObject's state. Used to revoke (INACTIVE)
  // on cancellation. Soft semantics: callers should swallow errors and
  // log, since cancel is source-of-truth and the DDB-backed scanner
  // already rejects regardless of wallet object state.
  async function patchObjectState(objectId, state) {
    assertEnabled();
    const id = String(objectId ?? "").trim();
    if (!id) throw httpError(400, "objectId is required");
    const url = `${WALLET_OBJECTS_REST_BASE}/eventTicketObject/${encodeURIComponent(id)}`;
    const res = await authorizedFetch("PATCH", url, { state });
    if (res?.status === 404) {
      // Object never reached Google (customer didn't tap the save link).
      // Treat as success — there's nothing to revoke.
      return { revoked: false, reason: "not_found" };
    }
    if (!res || res.status >= 400) {
      const text = typeof res?.text === "function" ? await res.text() : "";
      const err = httpError(
        res?.status ?? 500,
        `Google Wallet PATCH failed: ${text || "unknown"}`
      );
      throw err;
    }
    return { revoked: true };
  }

  async function revokeObjectForReservation(reservationId) {
    if (!isEnabled()) return { revoked: false, reason: "disabled" };
    const objectId = buildObjectId(issuerId, reservationId);
    if (!objectId) return { revoked: false, reason: "no_id" };
    return await patchObjectState(objectId, "INACTIVE");
  }

  async function patchObjectForReservation({ reservation, checkInPass }) {
    if (!isEnabled()) return { patched: false, reason: "disabled" };
    const objectId = buildObjectId(issuerId, reservation?.reservationId);
    if (!objectId) return { patched: false, reason: "no_id" };
    const token = String(checkInPass?.token ?? "").trim();
    if (!token) return { patched: false, reason: "no_token" };

    const classId = buildClassId(issuerId, reservation?.eventDate);
    if (!classId) return { patched: false, reason: "no_class" };

    const obj = buildEventTicketObject({
      objectId,
      classId,
      reservation,
      checkInPassToken: token,
    });
    // PATCH-only fields we want to refresh after a table swap or content
    // change. Avoid PATCHing barcode unless the underlying token actually
    // changed — Google will accept it either way but a no-op churns the
    // pass's Last Updated stamp.
    const patchBody = {
      state: obj.state,
      textModulesData: obj.textModulesData,
      ticketHolderName: obj.ticketHolderName,
      ticketNumber: obj.ticketNumber,
      barcode: obj.barcode,
      reservationInfo: obj.reservationInfo,
    };

    const url = `${WALLET_OBJECTS_REST_BASE}/eventTicketObject/${encodeURIComponent(objectId)}`;
    const res = await authorizedFetch("PATCH", url, patchBody);
    if (res?.status === 404) return { patched: false, reason: "not_found" };
    if (!res || res.status >= 400) {
      const text = typeof res?.text === "function" ? await res.text() : "";
      throw httpError(
        res?.status ?? 500,
        `Google Wallet object PATCH failed: ${text || "unknown"}`
      );
    }
    return { patched: true, objectId };
  }

  async function notifyObjectForReservation(reservationId, message) {
    if (!isEnabled()) return { sent: false, reason: "disabled" };
    const objectId = buildObjectId(issuerId, reservationId);
    if (!objectId) return { sent: false, reason: "no_id" };
    const header = String(message?.header ?? "").trim();
    const body = String(message?.body ?? "").trim();
    if (!header || !body) return { sent: false, reason: "empty_message" };

    const url = `${WALLET_OBJECTS_REST_BASE}/eventTicketObject/${encodeURIComponent(objectId)}/addMessage`;
    const res = await authorizedFetch("POST", url, {
      message: { header, body, messageType: "TEXT" },
    });
    if (res?.status === 404) return { sent: false, reason: "not_found" };
    if (!res || res.status >= 400) {
      const text = typeof res?.text === "function" ? await res.text() : "";
      throw httpError(
        res?.status ?? 500,
        `Google Wallet addMessage failed: ${text || "unknown"}`
      );
    }
    return { sent: true, objectId };
  }

  return {
    isEnabled,
    generateSaveUrlForReservation,
    revokeObjectForReservation,
    patchObjectForReservation,
    notifyObjectForReservation,
    // Exposed for tests + diagnostics
    _resetCacheForTests: () => {
      cachedCreds = null;
      cachedAuthClient = null;
    },
  };
}
