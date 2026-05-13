import {
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { toMinorUnits } from "./core-utils.mjs";
import {
  addWebhookUrlCandidates,
  buildSquareSignature,
  DEFAULT_WEBHOOK_REPLAY_WINDOW_SECONDS,
  evaluateWebhookReplayWindowPure,
  extractReservationFromNote,
  extractReservationRefFromPayment,
  formatEventDateForLabel,
  isIsoDate,
  isUuidLike,
  MAX_FUTURE_CLOCK_SKEW_SECONDS,
  normalizeWebhookUrl,
  parseBooleanEnv,
  parseJsonPayload,
  parseSquareErrorMessage,
  resolveSquareApiBaseUrl,
  signaturesEqual,
  toMajorAmount,
  toSquareBuyerPhone,
} from "./services-square-payments-pure.mjs";

const SECRET_CACHE_TTL_MS = 5 * 60 * 1000;
// Per-request ceiling on Square API calls. Lambda's overall timeout is the
// only other bound today, which lets a single hung Square request tie up
// concurrency and inflate p95 across unrelated routes. 8s is comfortably
// above Square's typical p99 (~1-2s) while still failing fast.
const SQUARE_REQUEST_TIMEOUT_MS = 8000;

export function createSquarePaymentsService({
  secretClient,
  env,
  requiredEnv,
  httpError,
  randomUUID,
  fetchImpl = fetch,
}) {
  async function squareFetch(url, init) {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      SQUARE_REQUEST_TIMEOUT_MS
    );
    try {
      return await fetchImpl(url, { ...init, signal: controller.signal });
    } catch (err) {
      if (err?.name === "AbortError") {
        throw httpError(504, "Square request timed out");
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  let cache = {
    secretArn: null,
    expiresAt: 0,
    parsed: null,
  };

  function resolveSquareEnv() {
    const value = String(env.SQUARE_ENV ?? "sandbox").trim().toLowerCase();
    return value === "production" ? "production" : "sandbox";
  }

  function toAmountMoney(amount) {
    const numeric = Number(amount);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      throw httpError(400, "amount must be > 0");
    }
    return toMinorUnits(numeric);
  }

  function resolveWebhookReplayWindowSeconds() {
    const raw = Number(env.SQUARE_WEBHOOK_REPLAY_WINDOW_SECONDS);
    if (!Number.isFinite(raw) || raw <= 0) {
      return DEFAULT_WEBHOOK_REPLAY_WINDOW_SECONDS;
    }
    return Math.round(raw);
  }

  function evaluateWebhookReplayWindow(webhookCreatedAt, nowMs = Date.now()) {
    return evaluateWebhookReplayWindowPure({
      webhookCreatedAt,
      replayWindowSeconds: resolveWebhookReplayWindowSeconds(),
      nowMs,
    });
  }

  function parseSecretPayload(rawSecret) {
    let parsed;
    try {
      parsed = JSON.parse(rawSecret);
    } catch {
      throw httpError(500, "Square secret JSON is invalid");
    }

    const accessToken = String(parsed?.SQUARE_ACCESS_TOKEN ?? "").trim();
    const webhookSignatureKey = String(parsed?.SQUARE_WEBHOOK_SIGNATURE_KEY ?? "").trim();
    if (!accessToken) throw httpError(500, "Square secret missing SQUARE_ACCESS_TOKEN");
    if (!webhookSignatureKey) {
      throw httpError(500, "Square secret missing SQUARE_WEBHOOK_SIGNATURE_KEY");
    }

    return {
      SQUARE_ACCESS_TOKEN: accessToken,
      SQUARE_WEBHOOK_SIGNATURE_KEY: webhookSignatureKey,
    };
  }

  async function loadSquareSecret() {
    requiredEnv("SQUARE_SECRET_ARN", env.SQUARE_SECRET_ARN);
    const secretArn = String(env.SQUARE_SECRET_ARN ?? "").trim();
    const now = Date.now();

    if (
      cache.parsed &&
      cache.secretArn === secretArn &&
      now < cache.expiresAt
    ) {
      return cache.parsed;
    }

    const out = await secretClient.send(
      new GetSecretValueCommand({
        SecretId: secretArn,
      })
    );

    const secretString = out.SecretString
      ? out.SecretString
      : out.SecretBinary
      ? Buffer.from(out.SecretBinary, "base64").toString("utf8")
      : "";
    if (!secretString) throw httpError(500, "Square secret value is empty");

    const parsed = parseSecretPayload(secretString);
    cache = {
      secretArn,
      parsed,
      expiresAt: now + SECRET_CACHE_TTL_MS,
    };
    return parsed;
  }

  async function createPayment({
    reservationId,
    eventDate,
    amount,
    sourceId,
    note,
    idempotencyKey,
  }) {
    const squareEnv = resolveSquareEnv();
    const apiBaseUrl = resolveSquareApiBaseUrl(squareEnv);
    const apiVersion = String(env.SQUARE_API_VERSION ?? "2026-01-22").trim();
    const locationId = String(requiredEnv("SQUARE_LOCATION_ID", env.SQUARE_LOCATION_ID) ?? "").trim();
    const currency = String(env.SQUARE_CURRENCY ?? "USD").trim().toUpperCase();
    const source = String(sourceId ?? "").trim();
    if (!source) throw httpError(400, "sourceId is required");

    const idempotency = String(idempotencyKey ?? "").trim() || randomUUID();
    const amountMinor = toAmountMoney(amount);
    const secret = await loadSquareSecret();

    const response = await squareFetch(`${apiBaseUrl}/v2/payments`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret.SQUARE_ACCESS_TOKEN}`,
        "Square-Version": apiVersion,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        idempotency_key: idempotency,
        source_id: source,
        location_id: locationId,
        amount_money: {
          amount: amountMinor,
          currency,
        },
        autocomplete: true,
        reference_id: String(reservationId ?? "").trim() || undefined,
        note: String(note ?? "").trim() || undefined,
        metadata: {
          reservationId: String(reservationId ?? "").trim(),
          eventDate: String(eventDate ?? "").trim(),
        },
      }),
    });

    const text = await response.text();
    const payload = parseJsonPayload(text);

    if (!response.ok) {
      const message = parseSquareErrorMessage(payload, `Square payment failed (${response.status})`);
      throw httpError(502, message);
    }

    const payment = payload?.payment;
    if (!payment?.id) {
      throw httpError(502, "Square payment response missing payment id");
    }

    const status = String(payment?.status ?? "").toUpperCase();
    if (status !== "COMPLETED") {
      throw httpError(409, `Square payment not completed (status: ${status || "UNKNOWN"})`);
    }

    return {
      idempotencyKey: idempotency,
      squareEnv,
      payment,
    };
  }

  async function createPaymentLink({
    reservationId,
    eventDate,
    tableId,
    tableIds,
    customerName,
    phone,
    amount,
    note,
    idempotencyKey,
    // Optional buyer email for Square hosted checkout pre-population.
    // Square uses it to send the receipt automatically. Anonymous public
    // bookings collect this in the customer-facing form; staff routes
    // omit it (Square collects on its own page if needed).
    buyerEmail,
    // Optional per-call redirect URL override. Defaults to the env-driven
    // SQUARE_CHECKOUT_REDIRECT_URL (staff flow). Anonymous public bookings
    // pass a customer-specific URL so the customer lands on
    // /r/{reservationId}?t=... after checkout.
    redirectUrlOverride,
    // Optional override for Square's accepted_payment_methods. Falls back
    // to the env-driven defaults (apple_pay/google_pay/cash_app_pay all
    // true) when omitted. Used by /me/cashapp-link to restrict the hosted
    // checkout to Cash App only.
    acceptedPaymentMethods: acceptedPaymentMethodsOverride,
  }) {
    const squareEnv = resolveSquareEnv();
    const apiBaseUrl = resolveSquareApiBaseUrl(squareEnv);
    const apiVersion = String(env.SQUARE_API_VERSION ?? "2026-01-22").trim();
    const locationId = String(requiredEnv("SQUARE_LOCATION_ID", env.SQUARE_LOCATION_ID) ?? "").trim();
    const currency = String(env.SQUARE_CURRENCY ?? "USD").trim().toUpperCase();
    // redirectUrlOverride (from caller) wins; otherwise fall back to env.
    // Trimmed; query strings are OK and Square preserves them on return.
    const redirectUrl = String(
      redirectUrlOverride ?? env.SQUARE_CHECKOUT_REDIRECT_URL ?? ""
    ).trim();
    const acceptedPaymentMethods = acceptedPaymentMethodsOverride && typeof acceptedPaymentMethodsOverride === "object"
      ? {
          apple_pay: Boolean(acceptedPaymentMethodsOverride.apple_pay ?? false),
          google_pay: Boolean(acceptedPaymentMethodsOverride.google_pay ?? false),
          cash_app_pay: Boolean(acceptedPaymentMethodsOverride.cash_app_pay ?? false),
        }
      : {
          apple_pay: parseBooleanEnv(env.SQUARE_LINK_ENABLE_APPLE_PAY, true),
          google_pay: parseBooleanEnv(env.SQUARE_LINK_ENABLE_GOOGLE_PAY, true),
          cash_app_pay: parseBooleanEnv(env.SQUARE_LINK_ENABLE_CASH_APP_PAY, true),
        };

    const idempotency = String(idempotencyKey ?? "").trim() || randomUUID();
    const amountMinor = toAmountMoney(amount);
    const secret = await loadSquareSecret();
    const buyerPhoneNumber = toSquareBuyerPhone(phone);
    // Receipt-facing note. Customer sees this in their Square email
    // receipt, so frame the reservation reference as a normal
    // "Booking #..." instead of the operator-internal "Reservation ..."
    // that read scammy. The webhook handler still parses the UUID +
    // date from this string (extractReservationFromNote understands
    // both "Reservation" and "Booking" prefixes for back-compat with
    // existing in-flight payments).
    const reservationRefText =
      `Booking ${String(reservationId ?? "").trim()} • ${String(eventDate ?? "").trim()}`;
    const noteText = String(note ?? "").trim();
    const paymentNote = noteText ? `${noteText} | ${reservationRefText}` : reservationRefText;
    const eventDateLabel = formatEventDateForLabel(eventDate);

    // Render "Tables 1, 2, 3" for multi-table bookings; fall back to the
    // legacy scalar `tableId` for back-compat with callers that haven't
    // been multi-tabled yet.
    const tableIdListForLabel = Array.isArray(tableIds)
      ? tableIds.map((v) => String(v ?? "").trim()).filter(Boolean)
      : [];
    let tablesLabel = "";
    if (tableIdListForLabel.length > 1) {
      tablesLabel = `Tables ${tableIdListForLabel.join(", ")}`;
    } else if (tableIdListForLabel.length === 1) {
      tablesLabel = `Table ${tableIdListForLabel[0]}`;
    } else {
      const single = String(tableId ?? "").trim();
      if (single) tablesLabel = `Table ${single}`;
    }
    const itemNameParts = [
      eventDateLabel ? `${eventDateLabel}` : "",
      tablesLabel,
      String(customerName ?? "").trim(),
    ].filter(Boolean);
    const itemName = itemNameParts.join(" • ") || "Reservation Payment";

    async function requestPaymentLink(includePhone) {
      const response = await squareFetch(`${apiBaseUrl}/v2/online-checkout/payment-links`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secret.SQUARE_ACCESS_TOKEN}`,
          "Square-Version": apiVersion,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          idempotency_key: idempotency,
          // Description shows on the Square hosted checkout page above
          // the amount. Friendly default for anonymous public bookings;
          // staff-supplied notes still win when provided.
          description:
            noteText ||
            (eventDateLabel
              ? `Famoso Fuego booking — ${eventDateLabel}`
              : `Famoso Fuego reservation`),
          quick_pay: {
            name: itemName,
            price_money: {
              amount: amountMinor,
              currency,
            },
            location_id: locationId,
          },
          checkout_options: redirectUrl
            ? {
                redirect_url: redirectUrl,
                accepted_payment_methods: acceptedPaymentMethods,
              }
            : {
                accepted_payment_methods: acceptedPaymentMethods,
              },
          pre_populated_data: (() => {
            const parts = {};
            if (includePhone && buyerPhoneNumber) {
              parts.buyer_phone_number = buyerPhoneNumber;
            }
            const trimmedEmail = String(buyerEmail ?? "").trim();
            if (trimmedEmail) {
              parts.buyer_email = trimmedEmail;
            }
            return Object.keys(parts).length > 0 ? parts : undefined;
          })(),
          payment_note:
            paymentNote,
        }),
      });

      const text = await response.text();
      const payload = parseJsonPayload(text);
      return { response, payload };
    }

    const phonePrefillAttempted = Boolean(buyerPhoneNumber);
    let phonePrefillUsed = phonePrefillAttempted;
    let phonePrefillFallbackUsed = false;
    let phonePrefillStatus = phonePrefillAttempted ? "used" : "omitted_invalid_or_missing";

    let { response, payload } = await requestPaymentLink(phonePrefillAttempted);
    if (!response.ok && buyerPhoneNumber) {
      const errorDetail = String(payload?.errors?.[0]?.detail ?? "").toLowerCase();
      const errorCode = String(payload?.errors?.[0]?.code ?? "").toLowerCase();
      const phoneRejected = errorDetail.includes("phone") || errorCode.includes("phone");
      if (phoneRejected) {
        phonePrefillFallbackUsed = true;
        phonePrefillUsed = false;
        phonePrefillStatus = "omitted_after_square_rejection";
        ({ response, payload } = await requestPaymentLink(false));
      }
    }

    if (!response.ok) {
      const message = parseSquareErrorMessage(payload, `Square payment link failed (${response.status})`);
      throw httpError(502, message);
    }

    const paymentLink = payload?.payment_link;
    if (!paymentLink?.id || !paymentLink?.url) {
      throw httpError(502, "Square payment link response missing url");
    }

    return {
      idempotencyKey: idempotency,
      squareEnv,
      paymentLink,
      audit: {
        phonePrefillAttempted,
        phonePrefillUsed,
        phonePrefillFallbackUsed,
        phonePrefillStatus,
      },
    };
  }

  async function refundPayment({ paymentId, amount, idempotencyKey, reason }) {
    const normalizedPaymentId = String(paymentId ?? "").trim();
    if (!normalizedPaymentId) throw httpError(400, "paymentId is required");

    const squareEnv = resolveSquareEnv();
    const apiBaseUrl = resolveSquareApiBaseUrl(squareEnv);
    const apiVersion = String(env.SQUARE_API_VERSION ?? "2026-01-22").trim();
    const currency = String(env.SQUARE_CURRENCY ?? "USD").trim().toUpperCase();
    const idempotency = String(idempotencyKey ?? "").trim() || randomUUID();
    const amountMinor = toAmountMoney(amount);
    const secret = await loadSquareSecret();

    const response = await squareFetch(`${apiBaseUrl}/v2/refunds`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret.SQUARE_ACCESS_TOKEN}`,
        "Square-Version": apiVersion,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        idempotency_key: idempotency,
        amount_money: { amount: amountMinor, currency },
        payment_id: normalizedPaymentId,
        reason: String(reason ?? "").trim() || undefined,
      }),
    });

    const text = await response.text();
    const payload = parseJsonPayload(text);

    if (!response.ok) {
      const message = parseSquareErrorMessage(
        payload,
        `Square refund failed (${response.status})`
      );
      throw httpError(502, message);
    }

    const refund = payload?.refund;
    if (!refund?.id) {
      throw httpError(502, "Square refund response missing refund id");
    }

    return {
      idempotencyKey: idempotency,
      squareEnv,
      refund,
    };
  }

  async function deactivatePaymentLink({ paymentLinkId }) {
    const normalizedPaymentLinkId = String(paymentLinkId ?? "").trim();
    if (!normalizedPaymentLinkId) throw httpError(400, "paymentLinkId is required");

    const squareEnv = resolveSquareEnv();
    const apiBaseUrl = resolveSquareApiBaseUrl(squareEnv);
    const apiVersion = String(env.SQUARE_API_VERSION ?? "2026-01-22").trim();
    const secret = await loadSquareSecret();

    const response = await squareFetch(
      `${apiBaseUrl}/v2/online-checkout/payment-links/${encodeURIComponent(normalizedPaymentLinkId)}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${secret.SQUARE_ACCESS_TOKEN}`,
          "Square-Version": apiVersion,
          "Content-Type": "application/json",
        },
      }
    );

    const text = await response.text();
    const payload = parseJsonPayload(text);

    if (response.ok) {
      return {
        deactivated: true,
        alreadyGone: false,
        squareEnv,
        paymentLinkId: normalizedPaymentLinkId,
      };
    }

    const errorCode = String(payload?.errors?.[0]?.code ?? "").trim().toUpperCase();
    const errorDetail = String(payload?.errors?.[0]?.detail ?? "").trim().toLowerCase();
    if (
      response.status === 404 ||
      errorCode === "NOT_FOUND" ||
      errorDetail.includes("not found")
    ) {
      return {
        deactivated: false,
        alreadyGone: true,
        squareEnv,
        paymentLinkId: normalizedPaymentLinkId,
      };
    }

    const message = parseSquareErrorMessage(
      payload,
      `Square payment link delete failed (${response.status})`
    );
    throw httpError(502, message);
  }

  async function getPaymentById(paymentId) {
    const normalizedPaymentId = String(paymentId ?? "").trim();
    if (!normalizedPaymentId) throw httpError(400, "paymentId is required");

    const squareEnv = resolveSquareEnv();
    const apiBaseUrl = resolveSquareApiBaseUrl(squareEnv);
    const apiVersion = String(env.SQUARE_API_VERSION ?? "2026-01-22").trim();
    const secret = await loadSquareSecret();

    const response = await squareFetch(
      `${apiBaseUrl}/v2/payments/${encodeURIComponent(normalizedPaymentId)}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${secret.SQUARE_ACCESS_TOKEN}`,
          "Square-Version": apiVersion,
          "Content-Type": "application/json",
        },
      }
    );

    const text = await response.text();
    const payload = parseJsonPayload(text);
    if (!response.ok) {
      const message = parseSquareErrorMessage(
        payload,
        `Square payment lookup failed (${response.status})`
      );
      throw httpError(502, message);
    }
    if (!payload?.payment?.id) {
      throw httpError(502, "Square payment lookup response missing payment");
    }
    return {
      squareEnv,
      payment: payload.payment,
    };
  }

  async function verifyWebhookSignature({
    signatureHeader,
    rawBody,
    requestUrl,
  }) {
    const providedSignature = String(signatureHeader ?? "").trim();
    if (!providedSignature) return false;

    const secret = await loadSquareSecret();
    const key = String(secret.SQUARE_WEBHOOK_SIGNATURE_KEY ?? "").trim();
    if (!key) throw httpError(500, "Square webhook signature key missing");

    const bodyText = String(rawBody ?? "");
    const candidates = new Set();
    addWebhookUrlCandidates(candidates, env.SQUARE_WEBHOOK_NOTIFICATION_URL);
    addWebhookUrlCandidates(candidates, requestUrl);

    for (const candidateUrl of candidates) {
      const generated = buildSquareSignature({
        signatureKey: key,
        notificationUrl: candidateUrl,
        rawBody: bodyText,
      });
      if (signaturesEqual(generated, providedSignature)) {
        return true;
      }
    }
    return false;
  }

  async function getWebhookHealthSummary() {
    const secret = await loadSquareSecret();
    const configuredUrl = normalizeWebhookUrl(env.SQUARE_WEBHOOK_NOTIFICATION_URL);
    let notificationUrlHost = null;
    let notificationUrlPath = null;
    if (configuredUrl) {
      try {
        const parsed = new URL(configuredUrl);
        notificationUrlHost = parsed.host || null;
        notificationUrlPath = parsed.pathname || null;
      } catch {
        notificationUrlPath = "INVALID_URL";
      }
    }

    return {
      ok: true,
      env: resolveSquareEnv(),
      apiVersion: String(env.SQUARE_API_VERSION ?? "2026-01-22").trim(),
      webhook: {
        notificationUrlConfigured: Boolean(configuredUrl),
        notificationUrlHost,
        notificationUrlPath,
        replayWindowSeconds: resolveWebhookReplayWindowSeconds(),
        hasSecretArn: Boolean(String(env.SQUARE_SECRET_ARN ?? "").trim()),
        hasAccessToken: Boolean(String(secret.SQUARE_ACCESS_TOKEN ?? "").trim()),
        hasWebhookSignatureKey: Boolean(String(secret.SQUARE_WEBHOOK_SIGNATURE_KEY ?? "").trim()),
      },
    };
  }

  async function processSquareWebhookEvent({
    webhookEvent,
    addReservationPayment,
    systemUser = "system:square-webhook",
  }) {
    const eventType = String(webhookEvent?.type ?? "").trim();
    if (!eventType) {
      return { ignored: true, reason: "missing_type" };
    }
    if (!["payment.created", "payment.updated"].includes(eventType)) {
      return { ignored: true, reason: "unsupported_type", type: eventType };
    }

    const replayWindow = evaluateWebhookReplayWindow(webhookEvent?.created_at);
    if (!replayWindow.ok) {
      return {
        ignored: true,
        reason: replayWindow.reason,
        type: eventType,
        replayWindowSeconds: replayWindow.replayWindowSeconds,
        ageSeconds: replayWindow.ageSeconds ?? null,
      };
    }

    const hintedPaymentId =
      String(webhookEvent?.data?.id ?? "").trim() ||
      String(webhookEvent?.data?.object?.payment?.id ?? "").trim();
    if (!hintedPaymentId) {
      return { ignored: true, reason: "missing_payment_id", type: eventType };
    }

    let payment;
    try {
      const squarePayment = await getPaymentById(hintedPaymentId);
      payment = squarePayment.payment;
    } catch (err) {
      const statusCode = Number(err?.statusCode ?? 0);
      const detail = String(err?.message ?? "");
      if (statusCode === 404 || /not[\s_-]?found/i.test(detail)) {
        return {
          ignored: true,
          reason: "payment_not_found",
          type: eventType,
          paymentId: hintedPaymentId,
        };
      }
      throw err;
    }

    const status = String(payment?.status ?? "").toUpperCase();
    if (status !== "COMPLETED") {
      return {
        ignored: true,
        reason: "payment_not_completed",
        type: eventType,
        paymentId: hintedPaymentId,
        status,
      };
    }

    const reservationRef = extractReservationRefFromPayment(payment);
    if (!reservationRef) {
      return {
        ignored: true,
        reason: "reservation_reference_missing",
        type: eventType,
        paymentId: hintedPaymentId,
      };
    }

    const amount = toMajorAmount(payment?.amount_money?.amount);
    if (!(amount > 0)) {
      return {
        ignored: true,
        reason: "invalid_amount",
        type: eventType,
        paymentId: hintedPaymentId,
      };
    }

    try {
      await addReservationPayment(
        reservationRef.reservationId,
        {
          eventDate: reservationRef.eventDate,
          amount,
          method: "square",
          source: "square-webhook",
          note:
            String(payment?.note ?? "").trim() ||
            `Square webhook ${String(payment?.id ?? "").trim()}`,
          provider: {
            providerPaymentId: String(payment?.id ?? "").trim() || null,
            providerStatus: status,
            receiptUrl: String(payment?.receipt_url ?? "").trim() || null,
            orderId: String(payment?.order_id ?? "").trim() || null,
            sourceType: String(payment?.source_type ?? "").trim() || null,
            idempotencyKey: String(payment?.idempotency_key ?? "").trim() || null,
            amountMoney:
              payment?.amount_money && typeof payment.amount_money === "object"
                ? {
                    amount: Number(payment.amount_money.amount ?? 0),
                    currency: String(payment.amount_money.currency ?? "").trim() || null,
                  }
                : null,
          },
        },
        systemUser
      );
    } catch (err) {
      const statusCode = Number(err?.statusCode ?? 0);
      if (statusCode === 400 || statusCode === 404) {
        const detail = String(err?.message ?? "");
        const normalizedDetail = detail.toLowerCase();
        let reason = "reservation_update_ignored";
        if (normalizedDetail.includes("already fully paid")) {
          reason = "duplicate_payment_ignored";
        } else if (normalizedDetail.includes("amount cannot exceed remaining balance")) {
          reason = "overpayment_blocked";
        }
        return {
          ignored: true,
          reason,
          type: eventType,
          paymentId: hintedPaymentId,
          detail,
        };
      }
      throw err;
    }

    return {
      processed: true,
      type: eventType,
      paymentId: hintedPaymentId,
      reservationId: reservationRef.reservationId,
      eventDate: reservationRef.eventDate,
      replayWindowSeconds: replayWindow.replayWindowSeconds,
      ageSeconds: replayWindow.ageSeconds,
    };
  }

  return {
    createPayment,
    createPaymentLink,
    deactivatePaymentLink,
    refundPayment,
    verifyWebhookSignature,
    getWebhookHealthSummary,
    processSquareWebhookEvent,
  };
}
