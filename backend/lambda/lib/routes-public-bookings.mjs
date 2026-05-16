// Public anonymous-booking routes. NO Cognito auth. Customer-token-gated
// reads + writes. Four routes:
//
//   POST /public/reservations                   → create hold(s) + reservation + Square link
//   GET  /public/reservations/{id}?t={token}    → poll status (PENDING / PAID)
//   POST /public/reservations/{id}/release?t={token} → customer-initiated cancel
//   POST /public/reservations/{id}/wallet-pass?t={token} → Apple Wallet .pkpass (base64)
//
// Settings gates ALL of this. If allowAnonymousPublicBooking=false in
// /admin/settings, every route returns 410 BOOKING_DISABLED. Trial-Saturday
// flips the flag on; everything else is invisible to customers.
//
// Defenses, in order of evaluation:
//   1. Settings gate (allowAnonymousPublicBooking)
//   2. API GW throttle (200 burst / 100 rate, edge)
//   3. Cloudflare Turnstile (verifier per request — required when site key set)
//   4. Per-phone unpaid-hold cap (1 active anon hold per phone, registry in HOLDS_TABLE)
//   5. Per-event hold TTL (10 min default, settings-driven)

import { randomBytes } from "node:crypto";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import {
  getReservationTableIds,
  formatTablesLabel,
  MAX_TABLES_PER_RESERVATION,
} from "./services-reservations-shared.mjs";
import { eventToPresenceStage } from "./services-presence.mjs";
import {
  buildCodeLookupKey,
  buildSlugLookupKey,
  extractConfirmationCodeFromText,
  formatPublicConfirmationCode,
  generateConfirmationCode,
  generatePublicSlug,
} from "./services-reservation-codes.mjs";

const MAX_MINT_ATTEMPTS = 5;

// Pre-flight collision check for the confirmation code. With 887M
// combinations this is essentially never going to retry, but the
// check protects us against the bizarre worst case where two
// concurrent bookings pick the same code (the TransactWrite
// ConditionExpression on PK="CODE" would then reject one of them).
async function mintUniqueConfirmationCode(ddb, tableName) {
  for (let attempt = 0; attempt < MAX_MINT_ATTEMPTS; attempt += 1) {
    const code = generateConfirmationCode(randomBytes);
    if (!ddb || !tableName) return code; // unit-test fallback
    const existing = await ddb.send(
      new GetCommand({ TableName: tableName, Key: buildCodeLookupKey(code) })
    );
    if (!existing?.Item) return code;
  }
  throw new Error("Could not mint a unique confirmation code");
}

async function mintUniquePublicSlug(ddb, tableName) {
  for (let attempt = 0; attempt < MAX_MINT_ATTEMPTS; attempt += 1) {
    const slug = generatePublicSlug(randomBytes);
    if (!ddb || !tableName) return slug;
    const existing = await ddb.send(
      new GetCommand({ TableName: tableName, Key: buildSlugLookupKey(slug) })
    );
    if (!existing?.Item) return slug;
  }
  throw new Error("Could not mint a unique public slug");
}

const ANON_ACTOR = "anonymous-public";
const DEFAULT_ANON_MAX_TABLES = 4;
const DEFAULT_ANON_HOLD_TTL_SECONDS = 600;

// Structured funnel emitter. Every decision point in the public-booking
// flow emits one line with `step` set so the abandonment funnel is
// readable from CloudWatch Insights:
//   fields @timestamp, step, reservationId, phone
//   | filter @message like "public_booking_event"
//   | stats count() by step
// Until 2026-05-14 we only logged failures + had no idea where customers
// dropped off (Jasmine + Eric + Erika's first try all auto-cancelled with
// cancellationReason: null). Steps map to ERROR_MESSAGES on the frontend
// so emitted-step ↔ user-visible-error are 1:1.
function emitFunnel(step, details = {}) {
  try {
    console.info("public_booking_event", { step, ...details });
  } catch {
    // Logging must never break the request path.
  }
}

function newCustomerToken() {
  // 256-bit hex. Same shape as the existing Cash App session token. Fits
  // in a URL query param without escaping; opaque to humans.
  return randomBytes(32).toString("hex");
}

function bookingDisabled(json, cors) {
  return json(
    410,
    {
      message: "Anonymous public booking is currently disabled",
      code: "BOOKING_DISABLED",
    },
    cors
  );
}

function getRemoteIp(event) {
  return (
    event?.requestContext?.http?.sourceIp ??
    event?.requestContext?.identity?.sourceIp ??
    event?.headers?.["x-forwarded-for"]?.split(",")[0]?.trim() ??
    null
  );
}

// Sanitized payload for the polling endpoint. Hides phone digits,
// tablePrices, internal CRM links, etc. — everything the customer doesn't
// need to see on the confirmation page. baseUrl is optional and only used
// to build the pre-formatted shortUrl; without it the field is omitted.
function sanitizeReservationForPublic(reservation, eventName, baseUrl = "") {
  const tableIds = getReservationTableIds(reservation);
  const paymentStatus = String(reservation?.paymentStatus ?? "").toUpperCase();
  const status = String(reservation?.status ?? "").toUpperCase();

  const confirmationCode = String(reservation?.confirmationCode ?? "").trim() || null;
  const publicSlug = String(reservation?.publicSlug ?? "").trim() || null;
  const trimmedBase = String(baseUrl ?? "").trim().replace(/\/+$/, "");
  return {
    reservationId: String(reservation?.reservationId ?? "").trim(),
    eventDate: String(reservation?.eventDate ?? "").trim(),
    eventName: String(eventName ?? "").trim() || null,
    tableIds,
    tablesLabel: formatTablesLabel(tableIds),
    customerName: String(reservation?.customerName ?? "").trim(),
    amountDue: Number(reservation?.amountDue ?? 0),
    depositAmount: Number(reservation?.depositAmount ?? 0),
    paymentStatus,
    status,
    paymentDeadlineAt: reservation?.paymentDeadlineAt ?? null,
    paymentDeadlineTz: reservation?.paymentDeadlineTz ?? null,
    paymentLinkUrl:
      paymentStatus === "PENDING" || paymentStatus === "PARTIAL"
        ? String(reservation?.paymentLinkUrl ?? "").trim() || null
        : null,
    confirmationCode,
    confirmationCodeFormatted: confirmationCode
      ? formatPublicConfirmationCode(confirmationCode)
      : null,
    publicSlug,
    // Pre-formatted short URL — convenience so the frontend doesn't have
    // to know our return-base URL. Null for legacy reservations that
    // don't have a slug.
    shortUrl: publicSlug && trimmedBase ? `${trimmedBase}/p/${publicSlug}` : null,
  };
}

export async function handlePublicBookingsRoute(ctx) {
  const {
    method,
    path,
    event,
    cors,
    json,
    httpError,
    getBody,
    randomUUID,
    normalizePhoneE164,
    normalizePhoneCountry,
    // event + table data
    getEventByDate,
    getTablePriceForEvent,
    // hold + reservation lifecycle
    createHold,
    releaseHold,
    createReservation,
    cancelReservation,
    // square
    createSquarePaymentLink,
    setReservationPaymentLinkWindow,
    // anon-bookings registry
    acquireAnonBookingPhoneSlot,
    releaseAnonBookingPhoneSlot,
    verifyCustomerToken,
    // turnstile
    verifyTurnstileToken,
    loadTurnstileSecret,
    // shared
    getReservationById,
    lookupReservationBySlug,
    lookupReservationByConfirmationCode,
    upsertCrmClient,
    appendReservationHistory,
    // settings
    getAppSettings,
    // wallet pass
    getActivePassForReservation,
    issuePassForReservation,
    generateWalletPass,
    walletPassEnabled,
    // Base URL for /r/{id} customer-facing landing pages on the SPA web
    // domain. Used by GET /p/{slug} when 302'ing the customer back to
    // /r/{id}?t=…&eventDate=… (and to /check-in/pass for ?to=pass).
    publicBookingReturnBaseUrl,
    // Base URL for /p/{slug} short URLs. /p is served by API Gateway, NOT
    // by the SPA, so this MUST point at the API host (api.famosofuego.com)
    // — pointing at the web host produces a 404 because the SPA has no
    // /p/:slug route. Used for: (a) the customerReturnUrl passed to Square
    // (b) the shortUrl field in API responses (c) the "View your pass: …"
    // line we append to the Square payment_note. Falls back to the same
    // value as publicBookingReturnBaseUrl for tests / backward compat.
    publicBookingShortUrlBase,
    // ddb + table-name deps for the code/slug collision pre-check.
    // Anonymous-booking pre-flight: confirm the generated code + slug
    // aren't already taken before we ship them down through the
    // TransactWrite. Same `ddb` + `RES_TABLE` the route handler is
    // already using elsewhere indirectly.
    ddb,
    tableNames,
    // Anon-bookings registry read for /lookup-by-phone (B.3 find-my-booking).
    getAnonBookingPhoneSlot,
    // Live-presence writer (services-presence.recordPresence). Optional —
    // omitted in tests; the telemetry handler skips the write when null.
    recordPresence,
  } = ctx;

  // /p/{slug} short URL base — see destructure comment. Falls back twice:
  // first to publicBookingReturnBaseUrl (legacy single-base callers), then
  // to the production API host (so tests + bootstrap don't crash on a
  // missing env var). Trimmed once here, reused everywhere a /p URL is
  // constructed: customerReturnUrl, response.shortUrl, sanitize callers.
  const shortUrlBase = String(
    publicBookingShortUrlBase ?? publicBookingReturnBaseUrl ?? "https://api.famosofuego.com"
  ).trim().replace(/\/+$/, "");

  // ─────────────────────────────────────────────────────────────────────
  // POST /public/reservations
  // ─────────────────────────────────────────────────────────────────────
  if (method === "POST" && path === "/public/reservations") {
    const settings = (await getAppSettings()) ?? {};
    if (!settings.allowAnonymousPublicBooking) {
      emitFunnel("blocked_disabled", { ip: getRemoteIp(event) });
      return bookingDisabled(json, cors);
    }

    const body = (await getBody(event)) ?? {};
    const eventDate = String(body?.eventDate ?? "").trim();
    const tableIdsRaw = Array.isArray(body?.tableIds) ? body.tableIds : [];
    const customerNameRaw = String(body?.customer?.name ?? "").trim();
    const customerPhoneRaw = String(body?.customer?.phone ?? "").trim();
    const customerEmailRaw = String(body?.customer?.email ?? "").trim();
    const turnstileToken = String(body?.turnstileToken ?? "").trim();
    const idempotencyKey =
      String(body?.idempotencyKey ?? "").trim() || randomUUID();

    if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) {
      emitFunnel("blocked_bad_event_date", { eventDate });
      return json(400, { message: "eventDate must be YYYY-MM-DD" }, cors);
    }
    const tableIds = tableIdsRaw
      .map((v) => String(v ?? "").trim())
      .filter(Boolean);
    if (tableIds.length === 0) {
      emitFunnel("blocked_no_tables", { eventDate });
      return json(400, { message: "tableIds is required" }, cors);
    }
    const maxTables = Math.min(
      Number(settings.anonymousMaxTablesPerBooking ?? DEFAULT_ANON_MAX_TABLES),
      MAX_TABLES_PER_RESERVATION
    );
    if (tableIds.length > maxTables) {
      emitFunnel("blocked_max_tables", {
        eventDate,
        tableCount: tableIds.length,
        maxTables,
      });
      return json(
        400,
        {
          message: `Cannot reserve more than ${maxTables} tables in one booking`,
          code: "MAX_TABLES_EXCEEDED",
        },
        cors
      );
    }
    if (new Set(tableIds).size !== tableIds.length) {
      emitFunnel("blocked_dup_tables", { eventDate });
      return json(400, { message: "tableIds must be unique" }, cors);
    }
    if (!customerNameRaw) {
      emitFunnel("blocked_missing_name", { eventDate });
      return json(400, { message: "customer.name is required" }, cors);
    }
    if (!customerPhoneRaw) {
      emitFunnel("blocked_missing_phone", { eventDate });
      return json(400, { message: "customer.phone is required" }, cors);
    }
    const phoneCountry = normalizePhoneCountry("US");
    const customerPhone = normalizePhoneE164(customerPhoneRaw, phoneCountry);
    if (!customerPhone) {
      emitFunnel("blocked_invalid_phone", {
        eventDate,
        rawPhonePrefix: customerPhoneRaw.slice(0, 4),
      });
      return json(
        400,
        {
          message: "customer.phone must be a valid US or MX number",
          code: "INVALID_PHONE",
        },
        cors
      );
    }

    // Turnstile gate — required if a site key is configured. Local dev /
    // bootstrap may run with the key unset; in that case we skip verifier.
    const turnstileSiteKey = String(settings.turnstileSiteKey ?? "").trim();
    if (turnstileSiteKey) {
      if (!turnstileToken) {
        emitFunnel("blocked_turnstile_no_token", {
          eventDate,
          phone: customerPhone,
        });
        return json(
          403,
          { message: "Turnstile token is required", code: "TURNSTILE_FAILED" },
          cors
        );
      }
      const turnstileSecret =
        typeof loadTurnstileSecret === "function"
          ? await loadTurnstileSecret()
          : "";
      const verification = await verifyTurnstileToken({
        token: turnstileToken,
        secret: turnstileSecret,
        remoteIp: getRemoteIp(event),
      });
      if (!verification.success) {
        console.warn("public_booking_turnstile_rejected", {
          errorCodes: verification.errorCodes,
        });
        emitFunnel("blocked_turnstile_verify", {
          eventDate,
          phone: customerPhone,
          errorCodes: verification.errorCodes,
        });
        return json(
          403,
          {
            message: "Turnstile verification failed",
            code: "TURNSTILE_FAILED",
            errorCodes: verification.errorCodes,
          },
          cors
        );
      }
    }

    // Resolve event + validate tableIds belong to this event + price them.
    const eventRecord = await getEventByDate(eventDate);
    if (!eventRecord) {
      emitFunnel("blocked_event_not_found", {
        eventDate,
        phone: customerPhone,
      });
      return json(
        404,
        { message: "Event not found for date", code: "EVENT_NOT_FOUND" },
        cors
      );
    }
    let amountDue = 0;
    for (const tid of tableIds) {
      const price = getTablePriceForEvent(eventRecord, tid);
      if (price === null) {
        emitFunnel("blocked_table_invalid", {
          eventDate,
          phone: customerPhone,
          invalidTableId: tid,
        });
        return json(
          404,
          {
            message: `Invalid tableId for event: ${tid}`,
            code: "TABLE_INVALID",
            invalidTableId: tid,
          },
          cors
        );
      }
      amountDue += Number(price);
    }
    amountDue = Number(amountDue.toFixed(2));
    if (amountDue <= 0) {
      // Free tables don't make sense for anon flow — they'd sidestep the
      // payment-confirmed flip.
      emitFunnel("blocked_amount_zero", {
        eventDate,
        phone: customerPhone,
        tableIds,
      });
      return json(
        400,
        { message: "Selected tables have no price configured" },
        cors
      );
    }

    // Compute the anonymous hold deadline. Single timestamp drives BOTH
    // the phone-slot expiry AND the reservation's paymentDeadlineAt — so
    // both expire on the same clock.
    const anonTtlSeconds = Math.max(
      300,
      Math.min(
        1800,
        Number(settings.anonymousHoldTtlSeconds ?? DEFAULT_ANON_HOLD_TTL_SECONDS)
      )
    );
    const nowMs = Date.now();
    const expiresAtEpoch = Math.floor(nowMs / 1000) + anonTtlSeconds;
    const customerToken = newCustomerToken();
    const reservationId = randomUUID();
    // Mint short identifiers with a tiny GetItem-then-retry collision
    // check. Code space is 31^6 ≈ 887M and slug space is 62^16 ≈ 5e28,
    // so a fresh-mint collision is astronomically unlikely; the check
    // exists purely to be airtight under worst-case scenarios.
    const confirmationCode = await mintUniqueConfirmationCode(
      ddb,
      tableNames?.RES_TABLE
    );
    const publicSlug = await mintUniquePublicSlug(
      ddb,
      tableNames?.RES_TABLE
    );

    // Format paymentDeadlineAt as YYYY-MM-DDTHH:mm:ss in the operating tz.
    // createReservation expects this shape (matches normalizeDeadlineLocalIso).
    const operatingTz = String(settings?.operatingTz ?? "America/Chicago");
    const paymentDeadlineAt = new Intl.DateTimeFormat("en-CA", {
      timeZone: operatingTz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .format(new Date(expiresAtEpoch * 1000))
      .replace(", ", "T")
      .replace(/-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/, "-$1-$2T$3:$4:$5");

    // Acquire the phone slot up front. If another anon flow holds the slot
    // we 429 immediately — saves wasting a hold + Square call.
    try {
      await acquireAnonBookingPhoneSlot({
        phoneE164: customerPhone,
        reservationId,
        eventDate,
        expiresAt: expiresAtEpoch,
        customerToken,
      });
    } catch (err) {
      if (err?.code === "ACTIVE_HOLD_EXISTS") {
        emitFunnel("blocked_active_hold", {
          eventDate,
          phone: customerPhone,
          existingReservationId: err.details?.existingReservationId ?? null,
        });
        return json(
          429,
          {
            message: err.message,
            code: "ACTIVE_HOLD_EXISTS",
            existingReservationId: err.details?.existingReservationId ?? null,
            existingExpiresAt: err.details?.existingExpiresAt ?? null,
            existingEventDate: err.details?.existingEventDate ?? null,
          },
          cors
        );
      }
      throw err;
    }

    // Cleanup helper — wipes any holds we created + releases the slot.
    // Used on every failure path between here and the final return.
    const heldTableIds = [];
    async function rollback() {
      for (const tid of heldTableIds) {
        try {
          await releaseHold(eventDate, tid);
        } catch (err) {
          console.warn("public_booking_rollback_release_failed", {
            tableId: tid,
            message: String(err?.message ?? err ?? ""),
          });
        }
      }
      try {
        await releaseAnonBookingPhoneSlot({
          phoneE164: customerPhone,
          reservationId,
        });
      } catch (err) {
        console.warn("public_booking_rollback_slot_release_failed", {
          message: String(err?.message ?? err ?? ""),
        });
      }
    }

    // Create N holds. If any one fails (already held by someone else) we
    // 409 with the unavailable list.
    const holdIds = [];
    const unavailableTableIds = [];
    for (const tid of tableIds) {
      try {
        const hold = await createHold(
          {
            eventDate,
            tableId: tid,
            customerName: customerNameRaw,
            phone: customerPhone,
          },
          ANON_ACTOR
        );
        heldTableIds.push(tid);
        holdIds.push(hold?.holdId);
      } catch (err) {
        // 409 = "Table is already held or reserved"
        if (err?.statusCode === 409) {
          unavailableTableIds.push(tid);
        } else {
          await rollback();
          throw err;
        }
      }
    }
    if (unavailableTableIds.length > 0) {
      await rollback();
      emitFunnel("blocked_table_unavailable", {
        eventDate,
        phone: customerPhone,
        unavailableTableIds,
      });
      return json(
        409,
        {
          message: "One or more selected tables became unavailable",
          code: "TABLE_NOT_AVAILABLE",
          unavailableTableIds,
        },
        cors
      );
    }

    // Promote holds → reservation in a single TransactWrite via the
    // existing createReservation flow. Pass customerToken so the row
    // is gated on the public read endpoints.
    let createdReservation;
    try {
      createdReservation = await createReservation(
        {
          // Caller-supplied reservationId so the row that lands in DDB
          // matches the id we already used for the phone slot, Square
          // payment-link note, and customer-return URL. Without this,
          // createReservation generates its own id and the webhook-side
          // payment recording can't find the reservation.
          reservationId,
          eventDate,
          tableIds,
          holdIds,
          customerName: customerNameRaw,
          phone: customerPhone,
          // Default depositAmount = 0; paymentStatus auto-resolves to PENDING.
          // amountDue computed by createReservation from event prices.
          paymentDeadlineAt,
          paymentDeadlineTz: operatingTz,
          customerToken,
          // Short identifiers — createReservation will persist them on
          // the row + add PK=CODE/PK=SLUG lookup rows to the same
          // TransactWrite. Either both land or none, alongside the
          // hold upgrades, so we never end up with orphan codes.
          confirmationCode,
          publicSlug,
        },
        ANON_ACTOR,
        false
      );
    } catch (err) {
      await rollback();
      // 409 from createReservation = hold expired or someone else won the race
      if (err?.statusCode === 409) {
        emitFunnel("blocked_create_reservation_race", {
          eventDate,
          phone: customerPhone,
          message: String(err?.message ?? ""),
        });
        return json(
          409,
          { message: err.message, code: "TABLE_NOT_AVAILABLE" },
          cors
        );
      }
      throw err;
    }

    // customerReturnUrl uses shortUrlBase (= API host) because /p/{slug}
    // is registered at API Gateway, not on the SPA. API GW 302s the
    // customer back to publicBookingReturnBaseUrl/r/{id}?t=… so the SPA
    // picks them up. Two hops, both server-side, the broken /p path on
    // the web host is bypassed entirely.
    const customerReturnUrl = `${shortUrlBase}/p/${encodeURIComponent(publicSlug)}`;
    let paymentLinkUrl = null;
    let paymentLinkId = null;
    try {
      const square = await createSquarePaymentLink({
        reservationId,
        eventDate,
        tableId: tableIds[0],
        tableIds,
        customerName: customerNameRaw,
        phone: customerPhone,
        amount: amountDue,
        // No operator-internal "Anonymous public booking" prefix — it
        // appeared on the customer's Square receipt and read like a
        // scam. createPaymentLink uses the friendly "Booking #FF-XXXXXX"
        // form because we're supplying confirmationCode below.
        note: "",
        idempotencyKey,
        buyerEmail: customerEmailRaw || undefined,
        redirectUrlOverride: customerReturnUrl,
        confirmationCode,
        // publicSlug + shortUrlBase let createPaymentLink append a
        // "View your pass: {base}/p/{slug}" line to the payment_note,
        // which Square emails the customer + Cash App displays in the
        // transaction. This is the customer's recovery path if they
        // close the browser tab before /r loads.
        publicSlug,
        shortUrlBase,
      });
      const link = square?.paymentLink ?? {};
      paymentLinkUrl = String(link?.url ?? "").trim();
      paymentLinkId = String(link?.id ?? "").trim();
      if (!paymentLinkUrl) {
        throw httpError(502, "Square payment link response missing url");
      }
    } catch (err) {
      // Reservation exists but no payment link — bad state. Cancel it
      // (rolls back holds + slot via shared cancellation path) and 502.
      try {
        if (typeof cancelReservation === "function") {
          // Positional signature — see services-reservations.mjs.
          // tableId=null because cancelReservation derives the hold-
          // release list from reservation.tableIds[]. Using object-arg
          // here previously threw 400 ("eventDate must be YYYY-MM-DD")
          // and the holds stayed RESERVED until cron caught them.
          await cancelReservation(
            eventDate,
            reservationId,
            null,
            ANON_ACTOR,
            "Square payment link generation failed",
            { resolutionType: "CANCEL_NO_REFUND" }
          );
        }
      } catch (cancelErr) {
        console.warn("public_booking_payment_link_cancel_failed", {
          message: String(cancelErr?.message ?? cancelErr ?? ""),
        });
      }
      await releaseAnonBookingPhoneSlot({
        phoneE164: customerPhone,
        reservationId,
      });
      emitFunnel("blocked_square_link_failed", {
        eventDate,
        phone: customerPhone,
        reservationId,
        message: String(err?.message ?? ""),
      });
      throw err;
    }

    // Stamp paymentLinkUrl on the reservation so the polling endpoint
    // can hand it back without another Square call.
    try {
      if (typeof setReservationPaymentLinkWindow === "function") {
        await setReservationPaymentLinkWindow({
          eventDate,
          reservationId,
          paymentLinkId,
          paymentLinkUrl,
          actor: ANON_ACTOR,
        });
      }
    } catch (err) {
      console.warn("public_booking_set_link_window_failed", {
        reservationId,
        message: String(err?.message ?? err ?? ""),
      });
    }

    // Fire-and-forget CRM upsert. The phone is the join key — if the
    // customer later signs into the mobile app with the same phone, the
    // history attaches to their CRM row. Payload field names match the
    // staff path (customerName, eventDate, tableIds) so lifetime metrics
    // (totalSpend / totalReservations / totalTables) accumulate
    // consistently across booking sources.
    if (typeof upsertCrmClient === "function") {
      try {
        await upsertCrmClient(
          {
            customerName: customerNameRaw,
            phone: customerPhone,
            depositAmount: 0,
            eventDate,
            tableIds,
          },
          ANON_ACTOR
        );
      } catch (err) {
        console.warn("public_booking_crm_upsert_failed", {
          reservationId,
          message: String(err?.message ?? err ?? ""),
        });
      }
    }

    emitFunnel("created", {
      eventDate,
      phone: customerPhone,
      reservationId,
      confirmationCode,
      tableCount: tableIds.length,
      hasEmail: Boolean(customerEmailRaw),
      amountDue,
    });
    return json(
      201,
      {
        reservationId,
        customerToken,
        confirmationCode,
        confirmationCodeFormatted: formatPublicConfirmationCode(confirmationCode),
        publicSlug,
        shortUrl: `${shortUrlBase}/p/${publicSlug}`,
        paymentUrl: paymentLinkUrl,
        amountDue,
        currency: "USD",
        holdExpiresAt: paymentDeadlineAt,
        holdExpiresAtEpoch: expiresAtEpoch,
        tableIds,
      },
      cors
    );
  }

  // ─────────────────────────────────────────────────────────────────────
  // GET /public/reservations/{id}?t={token}
  // ─────────────────────────────────────────────────────────────────────
  const publicReservationGetMatch = path.match(
    /^\/public\/reservations\/([^/]+)$/
  );
  if (publicReservationGetMatch && method === "GET") {
    const reservationId = publicReservationGetMatch[1];
    const providedToken = String(
      event?.queryStringParameters?.t ?? ""
    ).trim();
    const eventDate = String(
      event?.queryStringParameters?.eventDate ?? ""
    ).trim();
    if (!providedToken) {
      return json(
        401,
        { message: "Token required", code: "INVALID_TOKEN" },
        cors
      );
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) {
      // We don't have a global reservationId GSI, so the caller MUST
      // pass eventDate (it's part of the PK). Frontend stores it in
      // localStorage alongside the token.
      return json(
        400,
        {
          message: "eventDate query param must be YYYY-MM-DD",
          code: "MISSING_EVENT_DATE",
        },
        cors
      );
    }
    let reservation;
    try {
      reservation = await getReservationById(eventDate, reservationId);
    } catch (err) {
      if (err?.statusCode === 404) {
        return json(
          404,
          {
            message: "Reservation not found",
            code: "RESERVATION_NOT_FOUND",
          },
          cors
        );
      }
      throw err;
    }
    if (!verifyCustomerToken(reservation, providedToken)) {
      return json(401, { message: "Invalid token", code: "INVALID_TOKEN" }, cors);
    }
    // Customer contact (phone) is exposed on every /r response so the
    // page can render Call/WhatsApp CTAs — particularly for the
    // paid-but-cancelled (Day-shape) recovery state where the customer
    // needs to reach us. Settings lookup is soft-fail (decorative).
    let customerContact = null;
    try {
      const reservationSettings = (await getAppSettings()) ?? {};
      const contactPhone = String(
        reservationSettings?.customerContactPhoneE164 ?? ""
      ).trim();
      customerContact = contactPhone ? { phone: contactPhone } : null;
    } catch {
      customerContact = null;
    }
    if (String(reservation?.status ?? "").toUpperCase() === "CANCELLED") {
      return json(
        410,
        {
          message: "Reservation cancelled",
          code: "RESERVATION_CANCELLED",
          reservation: sanitizeReservationForPublic(
            reservation,
            null,
            shortUrlBase
          ),
          customerContact,
        },
        cors
      );
    }
    let eventName = null;
    try {
      const eventRecord = await getEventByDate(eventDate);
      eventName = eventRecord?.eventName ?? null;
    } catch {
      // Soft-fail; eventName is decorative.
    }
    return json(
      200,
      {
        reservation: sanitizeReservationForPublic(
          reservation,
          eventName,
          shortUrlBase
        ),
        customerContact,
      },
      cors
    );
  }

  // ─────────────────────────────────────────────────────────────────────
  // POST /public/reservations/{id}/release?t={token}
  // ─────────────────────────────────────────────────────────────────────
  const publicReleaseMatch = path.match(
    /^\/public\/reservations\/([^/]+)\/release$/
  );
  if (publicReleaseMatch && method === "POST") {
    const reservationId = publicReleaseMatch[1];
    const providedToken = String(
      event?.queryStringParameters?.t ?? ""
    ).trim();
    const body = (await getBody(event)) ?? {};
    const eventDate = String(body?.eventDate ?? "").trim();
    if (!providedToken) {
      return json(
        401,
        { message: "Token required", code: "INVALID_TOKEN" },
        cors
      );
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) {
      return json(
        400,
        {
          message: "eventDate is required",
          code: "MISSING_EVENT_DATE",
        },
        cors
      );
    }

    let reservation;
    try {
      reservation = await getReservationById(eventDate, reservationId);
    } catch (err) {
      if (err?.statusCode === 404) {
        return json(
          404,
          {
            message: "Reservation not found",
            code: "RESERVATION_NOT_FOUND",
          },
          cors
        );
      }
      throw err;
    }
    if (!verifyCustomerToken(reservation, providedToken)) {
      return json(401, { message: "Invalid token", code: "INVALID_TOKEN" }, cors);
    }
    const paymentStatus = String(reservation?.paymentStatus ?? "").toUpperCase();
    if (paymentStatus === "PAID" || paymentStatus === "PARTIAL") {
      emitFunnel("release_blocked_already_paid", {
        eventDate,
        reservationId,
        paymentStatus,
      });
      return json(
        409,
        {
          message: "Cannot release a paid reservation",
          code: "ALREADY_PAID",
        },
        cors
      );
    }
    if (String(reservation?.status ?? "").toUpperCase() === "CANCELLED") {
      // Idempotent: already released.
      emitFunnel("release_idempotent_already_cancelled", {
        eventDate,
        reservationId,
      });
      return json(
        200,
        { released: true, alreadyCancelled: true, reservationId },
        cors
      );
    }

    if (typeof cancelReservation !== "function") {
      return json(
        500,
        { message: "Cancellation service is not configured" },
        cors
      );
    }
    // Positional signature — see services-reservations.mjs. tableId=null
    // because cancelReservation derives the hold-release list from
    // reservation.tableIds[]. Object-arg previously threw 400 here and
    // the customer-facing /release endpoint silently failed to cancel.
    await cancelReservation(
      eventDate,
      reservationId,
      null,
      ANON_ACTOR,
      "Released by customer",
      { resolutionType: "CANCEL_NO_REFUND" }
    );
    try {
      await releaseAnonBookingPhoneSlot({
        phoneE164: String(reservation?.phone ?? ""),
        reservationId,
      });
    } catch (err) {
      console.warn("public_booking_release_slot_release_failed", {
        reservationId,
        message: String(err?.message ?? err ?? ""),
      });
    }
    if (typeof appendReservationHistory === "function") {
      try {
        await appendReservationHistory({
          eventDate,
          reservationId,
          eventType: "RESERVATION_RELEASED_BY_CUSTOMER",
          actor: ANON_ACTOR,
          source: "customer",
          tableIds: getReservationTableIds(reservation),
          customerName: reservation?.customerName ?? null,
          details: { reason: "Released via /public release endpoint" },
        });
      } catch {
        // Soft-fail.
      }
    }
    emitFunnel("released", {
      eventDate,
      reservationId,
      tableIds: getReservationTableIds(reservation),
    });
    return json(200, { released: true, reservationId }, cors);
  }

  // ─────────────────────────────────────────────────────────────────────
  // POST /public/reservations/{id}/wallet-pass?t={token}
  // ─────────────────────────────────────────────────────────────────────
  const publicWalletMatch = path.match(
    /^\/public\/reservations\/([^/]+)\/wallet-pass$/
  );
  if (publicWalletMatch && method === "POST") {
    const reservationId = publicWalletMatch[1];
    const providedToken = String(
      event?.queryStringParameters?.t ?? ""
    ).trim();
    const body = (await getBody(event)) ?? {};
    const eventDate = String(body?.eventDate ?? "").trim();
    if (!providedToken) {
      return json(
        401,
        { message: "Token required", code: "INVALID_TOKEN" },
        cors
      );
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) {
      return json(
        400,
        { message: "eventDate is required", code: "MISSING_EVENT_DATE" },
        cors
      );
    }
    if (typeof walletPassEnabled === "function" && !walletPassEnabled()) {
      return json(
        501,
        {
          message: "Apple Wallet pass generation is not enabled",
          code: "WALLET_PASS_NOT_CONFIGURED",
        },
        cors
      );
    }

    let reservation;
    try {
      reservation = await getReservationById(eventDate, reservationId);
    } catch (err) {
      if (err?.statusCode === 404) {
        return json(
          404,
          {
            message: "Reservation not found",
            code: "RESERVATION_NOT_FOUND",
          },
          cors
        );
      }
      throw err;
    }
    if (!verifyCustomerToken(reservation, providedToken)) {
      return json(401, { message: "Invalid token", code: "INVALID_TOKEN" }, cors);
    }
    if (String(reservation?.status ?? "").toUpperCase() !== "CONFIRMED") {
      return json(
        400,
        {
          message: "Only confirmed reservations can produce a Wallet pass",
        },
        cors
      );
    }
    if (String(reservation?.paymentStatus ?? "").toUpperCase() !== "PAID") {
      return json(
        400,
        {
          message: "Reservation must be paid in full before adding to Apple Wallet",
          code: "RESERVATION_NOT_PAID",
        },
        cors
      );
    }

    let activePass = null;
    if (typeof getActivePassForReservation === "function") {
      activePass = await getActivePassForReservation(reservationId, {
        includeToken: true,
      });
    }
    if (!activePass && typeof issuePassForReservation === "function") {
      const issued = await issuePassForReservation({
        reservation,
        issuedBy: ANON_ACTOR,
        reissue: false,
      });
      activePass = issued?.pass ?? null;
    }
    if (!activePass?.token) {
      return json(
        404,
        {
          message: "No check-in pass available yet for this reservation",
          code: "PASS_NOT_READY",
        },
        cors
      );
    }

    const result = await generateWalletPass({
      reservation,
      checkInPass: activePass,
    });
    return json(
      200,
      {
        filename: result.filename,
        contentType: result.contentType,
        pkpassBase64: result.pkpassBase64,
        byteLength: result.byteLength,
      },
      cors
    );
  }

  // ─────────────────────────────────────────────────────────────────────
  // GET /p/{slug}[?to=pass] — short URL alias. Default 302s to the
  // /r confirmation page. ?to=pass sniffs the reservation, finds the
  // active check-in pass, and 302s to /check-in/pass?token=... so a
  // single short link can carry either intent (Android customers who
  // want the QR straight away vs the standard receipt landing page).
  //
  // ?to=pass falls back to the /r redirect if the reservation isn't
  // yet PAID — better than a confusing error for a customer who
  // taps the link before the webhook lands.
  // ─────────────────────────────────────────────────────────────────────
  // ─────────────────────────────────────────────────────────────────────
  // POST /public/lookup-by-phone — customer lost their /r URL (Square
  // email in spam, closed the tab, switched devices). Trades phone +
  // Turnstile for the short URL of their active anon booking. From
  // there the existing /r flow handles continue/release/wallet.
  //
  // Returns { found: true, shortUrl, paymentStatus, eventDate, expiresAt }
  // on hit, { found: false } on miss. Never reveals whether a phone
  // number is registered without a successful Turnstile (so a 200 with
  // found:false is safe to expose to enumeration). The phone slot is
  // single-active-per-phone, so this is the canonical "active booking
  // for this phone right now" lookup.
  // ─────────────────────────────────────────────────────────────────────
  if (method === "POST" && path === "/public/lookup-by-phone") {
    const settings = (await getAppSettings()) ?? {};
    if (!settings.allowAnonymousPublicBooking) {
      return bookingDisabled(json, cors);
    }
    if (typeof getAnonBookingPhoneSlot !== "function") {
      return json(500, { message: "Lookup service not configured" }, cors);
    }

    const body = (await getBody(event)) ?? {};
    const customerPhoneRaw = String(body?.phone ?? "").trim();
    const turnstileToken = String(body?.turnstileToken ?? "").trim();
    if (!customerPhoneRaw) {
      return json(
        400,
        { message: "phone is required", code: "MISSING_PHONE" },
        cors
      );
    }
    const phoneCountry = normalizePhoneCountry("US");
    const customerPhone = normalizePhoneE164(customerPhoneRaw, phoneCountry);
    if (!customerPhone) {
      return json(
        400,
        {
          message: "phone must be a valid US or MX number",
          code: "INVALID_PHONE",
        },
        cors
      );
    }

    // Turnstile gate — same as POST /public/reservations. Without this
    // the endpoint is a phone-enumeration oracle (rate-limited at API
    // GW but still cheap to scan). Fail-closed when configured.
    const turnstileSiteKey = String(settings.turnstileSiteKey ?? "").trim();
    if (turnstileSiteKey) {
      if (!turnstileToken) {
        return json(
          403,
          { message: "Turnstile token is required", code: "TURNSTILE_FAILED" },
          cors
        );
      }
      const turnstileSecret =
        typeof loadTurnstileSecret === "function"
          ? await loadTurnstileSecret()
          : "";
      const verification = await verifyTurnstileToken({
        token: turnstileToken,
        secret: turnstileSecret,
        remoteIp: getRemoteIp(event),
      });
      if (!verification.success) {
        return json(
          403,
          {
            message: "Turnstile verification failed",
            code: "TURNSTILE_FAILED",
            errorCodes: verification.errorCodes,
          },
          cors
        );
      }
    }

    const slot = await getAnonBookingPhoneSlot(customerPhone);
    if (!slot?.reservationId || !slot?.eventDate) {
      return json(200, { found: false }, cors);
    }
    // Stale slot whose TTL has passed but the cron sweep hasn't released
    // yet → treat as miss to avoid pointing the customer at a doomed row.
    const slotExpiresAt = Number(slot.expiresAt ?? 0);
    if (Number.isFinite(slotExpiresAt) && slotExpiresAt > 0 && slotExpiresAt < Math.floor(Date.now() / 1000)) {
      return json(200, { found: false }, cors);
    }

    let reservation;
    try {
      reservation = await getReservationById(slot.eventDate, slot.reservationId);
    } catch (err) {
      if (err?.statusCode === 404) {
        return json(200, { found: false }, cors);
      }
      throw err;
    }
    if (String(reservation?.status ?? "").toUpperCase() === "CANCELLED") {
      return json(200, { found: false }, cors);
    }

    const publicSlug = String(reservation?.publicSlug ?? "").trim();
    const paymentStatus = String(reservation?.paymentStatus ?? "").toUpperCase();
    const shortUrl = publicSlug ? `${shortUrlBase}/p/${publicSlug}` : null;
    return json(
      200,
      {
        found: true,
        shortUrl,
        paymentStatus,
        eventDate: slot.eventDate,
        expiresAt: slotExpiresAt || null,
        confirmationCode: String(reservation?.confirmationCode ?? "").trim() || null,
      },
      cors
    );
  }

  // ─────────────────────────────────────────────────────────────────────
  // POST /public/lookup-by-code — sibling of /lookup-by-phone. Customer
  // types their FF-XXXXXX confirmation code (from Square receipt or
  // original SMS) and we hand back the short URL. Safer than phone-only
  // lookup because the code is a customer-supplied token they already
  // possess — no PII enumeration risk. Resolves PAID + PENDING + every
  // state except CANCELLED (cancelled reservations return found:false to
  // avoid pointing customers at a dead row).
  //
  // Body: { code, turnstileToken }. Code accepts "FF-XXXXXX", "ff-xxxxxx",
  // or bare "XXXXXX" — extractConfirmationCodeFromText canonicalises.
  // Returns { found: true, shortUrl, paymentStatus, eventDate,
  // confirmationCode } or { found: false }.
  // ─────────────────────────────────────────────────────────────────────
  if (method === "POST" && path === "/public/lookup-by-code") {
    const settings = (await getAppSettings()) ?? {};
    if (!settings.allowAnonymousPublicBooking) {
      return bookingDisabled(json, cors);
    }
    if (typeof lookupReservationByConfirmationCode !== "function") {
      return json(500, { message: "Lookup service not configured" }, cors);
    }

    const body = (await getBody(event)) ?? {};
    const codeRaw = String(body?.code ?? "").trim();
    const turnstileToken = String(body?.turnstileToken ?? "").trim();
    if (!codeRaw) {
      return json(
        400,
        { message: "code is required", code: "MISSING_CODE" },
        cors
      );
    }
    const code = extractConfirmationCodeFromText(codeRaw);
    if (!code) {
      // Bad shape (wrong length, contains 0/O/1/I/L, etc). Return a
      // distinct code so the FE can surface a "double-check the code"
      // hint instead of a generic not-found.
      return json(
        400,
        {
          message: "Booking code must be 6 letters/digits (FF-XXXXXX)",
          code: "INVALID_CODE",
        },
        cors
      );
    }

    // Turnstile gate — same posture as /lookup-by-phone. Without this the
    // endpoint becomes a code-enumeration oracle (31^6 ≈ 887M combinations
    // still scannable cheaply at a few RPS). Fail-closed when configured.
    const turnstileSiteKey = String(settings.turnstileSiteKey ?? "").trim();
    if (turnstileSiteKey) {
      if (!turnstileToken) {
        return json(
          403,
          { message: "Turnstile token is required", code: "TURNSTILE_FAILED" },
          cors
        );
      }
      const turnstileSecret =
        typeof loadTurnstileSecret === "function"
          ? await loadTurnstileSecret()
          : "";
      const verification = await verifyTurnstileToken({
        token: turnstileToken,
        secret: turnstileSecret,
        remoteIp: getRemoteIp(event),
      });
      if (!verification.success) {
        return json(
          403,
          {
            message: "Turnstile verification failed",
            code: "TURNSTILE_FAILED",
            errorCodes: verification.errorCodes,
          },
          cors
        );
      }
    }

    const looked = await lookupReservationByConfirmationCode(code);
    if (!looked?.reservationId || !looked?.eventDate) {
      return json(200, { found: false }, cors);
    }

    let reservation;
    try {
      reservation = await getReservationById(looked.eventDate, looked.reservationId);
    } catch (err) {
      if (err?.statusCode === 404) {
        return json(200, { found: false }, cors);
      }
      throw err;
    }
    if (String(reservation?.status ?? "").toUpperCase() === "CANCELLED") {
      return json(200, { found: false }, cors);
    }

    const publicSlug = String(reservation?.publicSlug ?? "").trim();
    const paymentStatus = String(reservation?.paymentStatus ?? "").toUpperCase();
    const shortUrl = publicSlug ? `${shortUrlBase}/p/${publicSlug}` : null;
    return json(
      200,
      {
        found: true,
        shortUrl,
        paymentStatus,
        eventDate: looked.eventDate,
        confirmationCode: String(reservation?.confirmationCode ?? "").trim() || code,
      },
      cors
    );
  }

  // ─────────────────────────────────────────────────────────────────────
  // POST /public/telemetry — frontend funnel events. NO auth, no DDB
  // write, just a structured CloudWatch log. Pairs with emitFunnel above
  // so the FE half of the abandonment journey is readable from the same
  // CW Insights query (filter on `frontend_funnel_event` instead of
  // `public_booking_event`). Whitelisted event names so we don't grow
  // an unbounded log namespace as the frontend evolves.
  //
  // Body: { event, sessionId?, ...extra }. SessionId is a per-browser UUID
  // the frontend stores in localStorage so a customer's events thread
  // together. No PII in the recommended payload (no phone/email/name) —
  // sessionId is the join key, the actual reservation row carries the
  // human details.
  // ─────────────────────────────────────────────────────────────────────
  if (method === "POST" && path === "/public/telemetry") {
    const body = (await getBody(event)) ?? {};
    const eventName = String(body?.event ?? "").trim();
    const allowed = new Set([
      "map_loaded",
      "map_pending_hold_seen",
      "modal_opened",
      "modal_validation_error",
      "modal_submitted",
      "modal_active_hold_recovery_shown",
      "modal_active_hold_release_clicked",
      "modal_redirect_to_square",
      "pending_release_clicked",
      "pending_release_confirmed",
      "r_page_loaded",
      "r_status_paid_seen",
      "r_status_cancelled_seen",
      "r_release_clicked",
      "r_wallet_clicked",
      // Find-modal flow (Tier S, 2026-05-14). One funnel covers both
      // Phone and Booking-code lookup paths so we can compare which one
      // customers actually reach for.
      "find_modal_opened",
      "find_modal_tab_changed",
      "find_by_phone_submitted",
      "find_by_phone_not_found",
      "find_by_phone_found",
      "find_by_code_submitted",
      "find_by_code_not_found",
      "find_by_code_found",
      // Staff auth-renew observability (2026-05-14). Confirms the
      // visibility-driven refresh + interceptor retry path actually
      // fires in the field. Public endpoint by design — when auth is
      // broken on the FE, we still want the event to reach CW. Pairs
      // with `frontend_funnel_event` in CW Insights:
      //   filter @message like "frontend_funnel_event"
      //   | filter event like /^auth_/
      //   | stats count() by event, extra.source, extra.outcome
      "auth_renew_started",
      "auth_renew_succeeded",
      "auth_renew_failed",
      "auth_bootstrap_check",
      "auth_session_expired_redirect",
      // Phase 0 diagnostic (2026-05-14). Captures raw Cognito response
      // details on every request the OIDC library makes — /oauth2/token,
      // /.well-known/jwks.json, /oauth2/userInfo, the discovery doc.
      // `observed` = success, `token_error` = any error. urlPath in extras.
      "auth_cognito_observed",
      "auth_cognito_token_error",
      // Phase 1 (2026-05-15). Direct /oauth2/token refresh that bypasses
      // the OIDC library's wipe-on-failure cascade + bootstrap recovery
      // via shadow refresh-token vault.
      "auth_shadow_refresh_started",
      "auth_shadow_refresh_succeeded",
      "auth_shadow_refresh_failed",
      "auth_shadow_restored",
      // Live-presence heartbeat (2026-05-15). Fired by /reserva every
      // ~30s while the tab is visible; the telemetry handler relays it
      // to services-presence so the staff dashboard's "Live now" tile
      // sees a fresh row. No other side-effects, no entry in the funnel
      // dashboard — pure presence signal.
      "map_heartbeat",
    ]);
    if (!allowed.has(eventName)) {
      // Silent 204 — frontend telemetry must never break the user flow,
      // so we don't return an error code that the caller might log.
      return json(204, {}, cors);
    }
    try {
      console.info("frontend_funnel_event", {
        event: eventName,
        sessionId: String(body?.sessionId ?? "").trim() || null,
        eventDate: String(body?.eventDate ?? "").trim() || null,
        reservationId: String(body?.reservationId ?? "").trim() || null,
        confirmationCode: String(body?.confirmationCode ?? "").trim() || null,
        userAgent: String(event?.headers?.["user-agent"] ?? "").slice(0, 200),
        ip: getRemoteIp(event),
        extra: body?.extra ?? null,
      });
    } catch {
      // Logging must never break the request.
    }
    // Live presence — write a 90s-TTL row keyed by sessionId so the
    // staff dashboard's "Live now" tile can count active visitors. The
    // event→stage map lives in services-presence; null means this
    // event isn't a presence signal (skip the write). Failures are
    // swallowed so telemetry never breaks the user flow.
    try {
      if (typeof recordPresence === "function") {
        const stage = eventToPresenceStage(eventName);
        const sid = String(body?.sessionId ?? "").trim();
        if (stage && sid) {
          await recordPresence({
            sessionId: sid,
            stage,
            eventDate: String(body?.eventDate ?? "").trim() || null,
            ip: getRemoteIp(event),
          });
        }
      }
    } catch (err) {
      console.warn("presence_write_failed", {
        event: eventName,
        message: err?.message ?? String(err),
      });
    }
    return json(204, {}, cors);
  }

  const publicSlugMatch = path.match(/^\/p\/([^/]+)$/);
  if (publicSlugMatch && method === "GET") {
    const slug = publicSlugMatch[1];
    if (typeof lookupReservationBySlug !== "function") {
      return json(500, { message: "Slug lookup not configured" }, cors);
    }
    const looked = await lookupReservationBySlug(slug);
    if (!looked?.reservationId || !looked?.eventDate || !looked?.customerToken) {
      return json(
        404,
        { message: "Booking not found", code: "SLUG_NOT_FOUND" },
        cors
      );
    }
    const base = String(
      publicBookingReturnBaseUrl ?? "https://famosofuego.com"
    )
      .trim()
      .replace(/\/+$/, "");

    const requestedDestination = String(
      event?.queryStringParameters?.to ?? ""
    )
      .trim()
      .toLowerCase();

    if (requestedDestination === "pass") {
      try {
        const reservation = await getReservationById(
          looked.eventDate,
          looked.reservationId
        );
        const paymentStatus = String(reservation?.paymentStatus ?? "")
          .toUpperCase();
        if (paymentStatus === "PAID" || paymentStatus === "COURTESY") {
          let pass =
            typeof getActivePassForReservation === "function"
              ? await getActivePassForReservation(looked.reservationId, {
                  includeToken: true,
                })
              : null;
          if (!pass && typeof issuePassForReservation === "function") {
            const issued = await issuePassForReservation({
              reservation,
              issuedBy: ANON_ACTOR,
              reissue: false,
            });
            pass = issued?.pass ?? null;
          }
          const passToken = String(pass?.token ?? "").trim();
          if (passToken) {
            return {
              statusCode: 302,
              headers: {
                location: `${base}/check-in/pass?token=${encodeURIComponent(
                  passToken
                )}`,
                "cache-control": "no-store",
                ...cors,
              },
              body: "",
            };
          }
        }
        // PENDING / no-pass-yet → fall through to the default /r redirect
        // so the customer lands on a useful page instead of a dead end.
      } catch {
        // Soft-fail — fall through to /r.
      }
    }

    const destination = `${base}/r/${encodeURIComponent(
      looked.reservationId
    )}?t=${encodeURIComponent(looked.customerToken)}&eventDate=${encodeURIComponent(
      looked.eventDate
    )}`;
    return {
      statusCode: 302,
      headers: {
        location: destination,
        "cache-control": "no-store",
        ...cors,
      },
      body: "",
    };
  }

  return null; // not handled by this module
}
