// Apple Wallet pkpass generator. Builds a signed eventTicket pass from
// a reservation + an active check-in pass token, returns base64 so the
// mobile app can decode it to a file and hand it to PassKit via the
// iOS share sheet.
//
// Design choices
// - In-memory icon/logo buffers (passed in via DI). No filesystem reads
//   at request time — the bundle ships the PNGs in Lambda's code zip and
//   they're loaded once at cold start.
// - Cert + key PEMs + WWDR PEM live in Secrets Manager as JSON. Cached
//   after the first successful resolve; subsequent invocations skip the
//   network round-trip.
// - The QR payload mirrors the check-in scanner contract
//   (`ffr-checkin:{token}`) so a Wallet pass scanned by the staff app
//   behaves identically to one fetched from /me/reservations/{id}/check-in-pass.
// - passkit-generator is loaded via dynamic import (default `loadPkPass`)
//   so the bundle survives in environments where the dep isn't installed
//   (tests, route-level failures unrelated to wallet) and so tests can
//   inject a stub.

const DEFAULT_DESCRIPTION = "Famoso Fuego Reservation";
const DEFAULT_ORGANIZATION_NAME = "Famoso Fuego";
const DEFAULT_LOGO_TEXT = "Famoso Fuego";
const DEFAULT_BACKGROUND_COLOR = "rgb(14, 11, 10)";
const DEFAULT_FOREGROUND_COLOR = "rgb(255, 255, 255)";
const DEFAULT_LABEL_COLOR = "rgb(248, 158, 41)";

export function createWalletPassService({
  secretClient,
  env,
  httpError,
  assets,
  loadPkPass,
}) {
  const passTypeIdentifier = String(env?.WALLET_PASS_TYPE_IDENTIFIER ?? "").trim();
  const teamIdentifier = String(env?.WALLET_TEAM_IDENTIFIER ?? "").trim();
  const secretArn = String(env?.WALLET_PASS_SECRET_ARN ?? "").trim();
  const organizationName =
    String(env?.WALLET_ORGANIZATION_NAME ?? "").trim() || DEFAULT_ORGANIZATION_NAME;
  const logoText = String(env?.WALLET_LOGO_TEXT ?? "").trim() || DEFAULT_LOGO_TEXT;
  const backgroundColor =
    String(env?.WALLET_BACKGROUND_COLOR ?? "").trim() || DEFAULT_BACKGROUND_COLOR;
  const foregroundColor =
    String(env?.WALLET_FOREGROUND_COLOR ?? "").trim() || DEFAULT_FOREGROUND_COLOR;
  const labelColor =
    String(env?.WALLET_LABEL_COLOR ?? "").trim() || DEFAULT_LABEL_COLOR;

  const pkpassLoader = typeof loadPkPass === "function"
    ? loadPkPass
    : async () => {
        const mod = await import("passkit-generator");
        return mod.PKPass;
      };

  let cachedCerts = null;
  let cachedPKPass = null;

  function isEnabled() {
    return Boolean(passTypeIdentifier && teamIdentifier && secretArn);
  }

  async function resolveCertificates() {
    if (cachedCerts) return cachedCerts;
    if (!secretArn) {
      throw httpError(501, "WALLET_PASS_SECRET_ARN is not configured");
    }
    if (!secretClient || typeof secretClient.send !== "function") {
      throw httpError(500, "Wallet pass secret client is not available");
    }
    // Lazy-load GetSecretValueCommand to avoid pulling @aws-sdk/client-secrets-manager
    // into routes that don't use wallet-pass.
    const { GetSecretValueCommand } = await import("@aws-sdk/client-secrets-manager");
    const result = await secretClient.send(
      new GetSecretValueCommand({ SecretId: secretArn })
    );
    const raw = result?.SecretString;
    if (!raw) {
      throw httpError(500, "Wallet pass secret is empty");
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw httpError(500, "Wallet pass secret is not valid JSON");
    }
    const wwdr = String(parsed?.wwdr ?? "").trim();
    const signerCert = String(parsed?.signerCert ?? "").trim();
    const signerKey = String(parsed?.signerKey ?? "").trim();
    const signerKeyPassphrase = String(parsed?.signerKeyPassphrase ?? "");
    if (!wwdr || !signerCert || !signerKey) {
      throw httpError(
        500,
        "Wallet pass secret is missing wwdr/signerCert/signerKey"
      );
    }
    cachedCerts = { wwdr, signerCert, signerKey, signerKeyPassphrase };
    return cachedCerts;
  }

  async function resolvePKPass() {
    if (cachedPKPass) return cachedPKPass;
    cachedPKPass = await pkpassLoader();
    if (typeof cachedPKPass !== "function") {
      cachedPKPass = null;
      throw httpError(500, "passkit-generator PKPass export is unavailable");
    }
    return cachedPKPass;
  }

  function buildPassFields(reservation, formattedDate) {
    const customerName = String(reservation?.customerName ?? "").trim() || "Guest";
    // tableIds[] preferred; legacy scalar tableId is the fallback. Multi-
    // table bookings render as "1, 2, 3" with a "TABLES" label so guests
    // see all their tables on one pass face.
    const rawTableIds = Array.isArray(reservation?.tableIds)
      ? reservation.tableIds.map((v) => String(v ?? "").trim()).filter(Boolean)
      : [];
    const fallbackTableId = String(reservation?.tableId ?? "").trim();
    const passTableIds =
      rawTableIds.length > 0
        ? rawTableIds
        : fallbackTableId
        ? [fallbackTableId]
        : [];
    const tableLabel = passTableIds.length > 1 ? "TABLES" : "TABLE";
    const tableValue = passTableIds.length > 0 ? passTableIds.join(", ") : "—";
    const depositAmount = Number(reservation?.depositAmount ?? 0);
    const paid = Number(reservation?.paymentTotal ?? reservation?.paid ?? depositAmount);
    const isCourtesy =
      String(reservation?.paymentStatus ?? "").toUpperCase() === "COURTESY";
    // Comp reservations show "Courtesy" in place of the dollar amount so
    // staff at the door see at a glance that the guest owes nothing and
    // the customer's pass face doesn't display a misleading "$0.00".
    const depositValue = isCourtesy
      ? "Courtesy"
      : Number.isFinite(paid) && paid > 0
      ? `$${paid.toFixed(2)}`
      : "—";
    return {
      headerFields: [
        {
          key: "eventDate",
          label: "DATE",
          value: formattedDate,
          textAlignment: "PKTextAlignmentRight",
        },
      ],
      primaryFields: [
        {
          key: "guest",
          label: "GUEST",
          value: customerName,
        },
      ],
      secondaryFields: [
        {
          key: "table",
          label: tableLabel,
          value: tableValue,
          textAlignment: "PKTextAlignmentLeft",
        },
        {
          key: "deposit",
          label: "DEPOSIT",
          value: depositValue,
          textAlignment: "PKTextAlignmentRight",
        },
      ],
      auxiliaryFields: [
        {
          key: "status",
          label: "STATUS",
          value: "CONFIRMED",
          textAlignment: "PKTextAlignmentLeft",
        },
      ],
      backFields: [
        {
          key: "venue",
          label: "Venue",
          value: "Famoso Fuego",
        },
        // Arrival instructions sit near the top of the back so they're
        // the first thing the customer sees when they tap to flip the
        // pass. Plain-text sentences with newlines render cleanly in
        // Apple Wallet — bullet markers don't add value here. Mirrors
        // the "When you arrive" block on the /r confirmation page so
        // customers see the same words on both surfaces.
        {
          key: "arrival",
          label: "When you arrive",
          value:
            "Head straight to your table — no check-in line.\nReserved all night — come whenever you like.\nShow this pass to any staff member if you need help.",
        },
        {
          key: "reservationId",
          label: "Reservation ID",
          value: String(reservation?.reservationId ?? "").trim() || "—",
        },
        {
          key: "terms",
          label: "Terms",
          value:
            "Self-cancellation requires at least 24 hours before the event.",
        },
      ],
    };
  }

  function buildRelevantDate(eventDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) return null;
    // Apple's `relevantDate` makes the pass surface on the lock screen
    // around the given time. Anchor to early evening local-ish (20:00 UTC
    // ≈ 14:00 CT) — good enough for v1; can be refined to event start
    // when event records carry an explicit time.
    const ms = Date.parse(`${eventDate}T20:00:00Z`);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }

  function formatEventDateLabel(eventDate) {
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

  function assertEnabled() {
    if (!isEnabled()) {
      throw httpError(501, "Apple Wallet is not configured for this environment");
    }
  }

  // Produces base64 string + filename + content type for the caller to
  // ship back in JSON. Throws via httpError on missing data. Callers
  // should pre-validate reservation ownership / status / paid state and
  // resolve the active check-in pass before invoking — this function
  // assumes the inputs are good.
  async function generatePkpassForReservation({ reservation, checkInPass }) {
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

    if (!assets?.iconPng || !assets?.icon2xPng || !assets?.logoPng || !assets?.logo2xPng) {
      throw httpError(500, "Wallet pass icon/logo assets are not loaded");
    }

    const PKPass = await resolvePKPass();
    const certificates = await resolveCertificates();

    const formattedDate = formatEventDateLabel(eventDate);
    const fields = buildPassFields(reservation, formattedDate);
    const relevantDate = buildRelevantDate(eventDate);

    const passOptions = {
      formatVersion: 1,
      passTypeIdentifier,
      teamIdentifier,
      organizationName,
      description: `${DEFAULT_DESCRIPTION} — ${formattedDate}`,
      serialNumber: reservationId,
      logoText,
      foregroundColor,
      backgroundColor,
      labelColor,
    };
    if (relevantDate) passOptions.relevantDate = relevantDate;

    const buffers = {
      "icon.png": assets.iconPng,
      "icon@2x.png": assets.icon2xPng,
      "logo.png": assets.logoPng,
      "logo@2x.png": assets.logo2xPng,
    };
    if (assets.icon3xPng) buffers["icon@3x.png"] = assets.icon3xPng;
    if (assets.logo3xPng) buffers["logo@3x.png"] = assets.logo3xPng;

    const pass = new PKPass(buffers, certificates, passOptions);
    pass.type = "generic";

    for (const field of fields.headerFields) pass.headerFields.push(field);
    for (const field of fields.primaryFields) pass.primaryFields.push(field);
    for (const field of fields.secondaryFields) pass.secondaryFields.push(field);
    for (const field of fields.auxiliaryFields) pass.auxiliaryFields.push(field);
    for (const field of fields.backFields) pass.backFields.push(field);

    const confirmationCode = String(reservation?.confirmationCode ?? "").trim();
    const altText = confirmationCode ? `FF-${confirmationCode}` : reservationId;
    pass.setBarcodes({
      message: `ffr-checkin:${token}`,
      format: "PKBarcodeFormatQR",
      messageEncoding: "iso-8859-1",
      altText,
    });

    const buffer = pass.getAsBuffer();
    const base64 = buffer.toString("base64");
    return {
      filename: `ff-${reservationId}.pkpass`,
      contentType: "application/vnd.apple.pkpass",
      pkpassBase64: base64,
      byteLength: buffer.length,
    };
  }

  return {
    isEnabled,
    generatePkpassForReservation,
    // Exposed for tests + diagnostics.
    _resetCacheForTests: () => {
      cachedCerts = null;
      cachedPKPass = null;
    },
  };
}
