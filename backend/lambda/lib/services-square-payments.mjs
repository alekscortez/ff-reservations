import {
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { createHmac, timingSafeEqual } from "crypto";

const SECRET_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_WEBHOOK_REPLAY_WINDOW_SECONDS = 10 * 60;
const MAX_FUTURE_CLOCK_SKEW_SECONDS = 2 * 60;

export function createSquarePaymentsService({
  secretClient,
  env,
  requiredEnv,
  httpError,
  randomUUID,
  fetchImpl = fetch,
}) {
  let cache = {
    secretArn: null,
    expiresAt: 0,
    parsed: null,
  };

  function resolveSquareEnv() {
    const value = String(env.SQUARE_ENV ?? "sandbox").trim().toLowerCase();
    return value === "production" ? "production" : "sandbox";
  }

  function resolveSquareApiBaseUrl(squareEnv) {
    return squareEnv === "production"
      ? "https://connect.squareup.com"
      : "https://connect.squareupsandbox.com";
  }

  function toAmountMoney(amount) {
    const numeric = Number(amount);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      throw httpError(400, "amount must be > 0");
    }
    return Math.round(numeric * 100);
  }

  function parseBooleanEnv(value, fallback = false) {
    const raw = String(value ?? "").trim().toLowerCase();
    if (!raw) return fallback;
    if (["1", "true", "yes", "on"].includes(raw)) return true;
    if (["0", "false", "no", "off"].includes(raw)) return false;
    return fallback;
  }

  function toSquareBuyerPhone(phone) {
    const raw = String(phone ?? "").trim();
    if (!raw) return null;
    // Square expects E.164 formatted phone numbers.
    if (!/^\+[1-9]\d{7,14}$/.test(raw)) return null;
    return raw;
  }

  function formatEventDateForLabel(eventDate) {
    const raw = String(eventDate ?? "").trim();
    const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return raw;
    const [, yyyy, mm, dd] = match;
    const weekdayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const monthNames = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ];
    const dateUtc = new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd)));
    const weekday = weekdayNames[dateUtc.getUTCDay()] ?? "";
    const monthIndex = Number(mm) - 1;
    const month = monthNames[monthIndex] ?? mm;
    return `${weekday}, ${month} ${Number(dd)}, ${yyyy}`;
  }

  function parseJsonPayload(text) {
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      return { raw: text };
    }
  }

  function parseSquareErrorMessage(payload, fallback) {
    return (
      payload?.errors?.[0]?.detail ||
      payload?.errors?.[0]?.code ||
      fallback
    );
  }

  function normalizeWebhookUrl(url) {
    return String(url ?? "").trim();
  }

  function addWebhookUrlCandidates(set, url) {
    const normalized = normalizeWebhookUrl(url);
    if (!normalized) return;
    set.add(normalized);
    if (normalized.endsWith("/")) {
      set.add(normalized.slice(0, -1));
    } else {
      set.add(`${normalized}/`);
    }
  }

  function signaturesEqual(a, b) {
    const left = Buffer.from(String(a ?? "").trim(), "utf8");
    const right = Buffer.from(String(b ?? "").trim(), "utf8");
    if (!left.length || !right.length || left.length !== right.length) return false;
    return timingSafeEqual(left, right);
  }

  function buildSquareSignature({ signatureKey, notificationUrl, rawBody }) {
    return createHmac("sha256", signatureKey)
      .update(`${notificationUrl}${rawBody}`, "utf8")
      .digest("base64");
  }

  function isUuidLike(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      String(value ?? "").trim()
    );
  }

  function isIsoDate(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? "").trim());
  }

  function extractReservationFromNote(noteRaw) {
    const note = String(noteRaw ?? "").trim();
    if (!note) return null;
    const match = note.match(
      /reservation\s+([0-9a-fA-F-]{36})\s*[·\-|]\s*(\d{4}-\d{2}-\d{2})/i
    );
    if (!match) return null;
    const reservationId = String(match[1] ?? "").trim();
    const eventDate = String(match[2] ?? "").trim();
    if (!isUuidLike(reservationId) || !isIsoDate(eventDate)) return null;
    return { reservationId, eventDate };
  }

  function extractReservationRefFromPayment(payment) {
    const metadata =
      payment?.metadata && typeof payment.metadata === "object" ? payment.metadata : {};
    const mdReservationId = String(metadata?.reservationId ?? "").trim();
    const mdEventDate = String(metadata?.eventDate ?? "").trim();
    if (isUuidLike(mdReservationId) && isIsoDate(mdEventDate)) {
      return { reservationId: mdReservationId, eventDate: mdEventDate };
    }

    const noteRef = extractReservationFromNote(payment?.note);
    if (noteRef) return noteRef;

    const referenceId = String(payment?.reference_id ?? "").trim();
    if (isUuidLike(referenceId) && isIsoDate(mdEventDate)) {
      return { reservationId: referenceId, eventDate: mdEventDate };
    }

    return null;
  }

  function toMajorAmount(amountMinor) {
    const minor = Number(amountMinor ?? 0);
    if (!Number.isFinite(minor) || minor <= 0) return 0;
    return Number((minor / 100).toFixed(2));
  }

  function resolveWebhookReplayWindowSeconds() {
    const raw = Number(env.SQUARE_WEBHOOK_REPLAY_WINDOW_SECONDS);
    if (!Number.isFinite(raw) || raw <= 0) {
      return DEFAULT_WEBHOOK_REPLAY_WINDOW_SECONDS;
    }
    return Math.round(raw);
  }

  function evaluateWebhookReplayWindow(webhookCreatedAt, nowMs = Date.now()) {
    const replayWindowSeconds = resolveWebhookReplayWindowSeconds();
    const createdAtRaw = String(webhookCreatedAt ?? "").trim();
    if (!createdAtRaw) {
      return {
        ok: false,
        reason: "missing_created_at",
        replayWindowSeconds,
      };
    }

    const createdAtMs = Date.parse(createdAtRaw);
    if (!Number.isFinite(createdAtMs)) {
      return {
        ok: false,
        reason: "invalid_created_at",
        replayWindowSeconds,
      };
    }

    const ageSeconds = Math.floor((nowMs - createdAtMs) / 1000);
    if (ageSeconds > replayWindowSeconds) {
      return {
        ok: false,
        reason: "outside_replay_window",
        replayWindowSeconds,
        ageSeconds,
      };
    }
    if (ageSeconds < -MAX_FUTURE_CLOCK_SKEW_SECONDS) {
      return {
        ok: false,
        reason: "created_at_in_future",
        replayWindowSeconds,
        ageSeconds,
      };
    }

    return {
      ok: true,
      replayWindowSeconds,
      ageSeconds,
    };
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

    const response = await fetchImpl(`${apiBaseUrl}/v2/payments`, {
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
    customerName,
    phone,
    amount,
    note,
    idempotencyKey,
  }) {
    const squareEnv = resolveSquareEnv();
    const apiBaseUrl = resolveSquareApiBaseUrl(squareEnv);
    const apiVersion = String(env.SQUARE_API_VERSION ?? "2026-01-22").trim();
    const locationId = String(requiredEnv("SQUARE_LOCATION_ID", env.SQUARE_LOCATION_ID) ?? "").trim();
    const currency = String(env.SQUARE_CURRENCY ?? "USD").trim().toUpperCase();
    const redirectUrl = String(env.SQUARE_CHECKOUT_REDIRECT_URL ?? "").trim();
    const acceptedPaymentMethods = {
      apple_pay: parseBooleanEnv(env.SQUARE_LINK_ENABLE_APPLE_PAY, true),
      google_pay: parseBooleanEnv(env.SQUARE_LINK_ENABLE_GOOGLE_PAY, true),
      cash_app_pay: parseBooleanEnv(env.SQUARE_LINK_ENABLE_CASH_APP_PAY, true),
    };

    const idempotency = String(idempotencyKey ?? "").trim() || randomUUID();
    const amountMinor = toAmountMoney(amount);
    const secret = await loadSquareSecret();
    const buyerPhoneNumber = toSquareBuyerPhone(phone);
    const reservationRefText =
      `Reservation ${String(reservationId ?? "").trim()} · ${String(eventDate ?? "").trim()}`;
    const noteText = String(note ?? "").trim();
    const paymentNote = noteText ? `${noteText} | ${reservationRefText}` : reservationRefText;
    const eventDateLabel = formatEventDateForLabel(eventDate);

    const itemNameParts = [
      eventDateLabel ? `${eventDateLabel}` : "",
      String(tableId ?? "").trim() ? `Table ${String(tableId ?? "").trim()}` : "",
      String(customerName ?? "").trim(),
    ].filter(Boolean);
    const itemName = itemNameParts.join(" • ") || "Reservation Payment";

    async function requestPaymentLink(includePhone) {
      const response = await fetchImpl(`${apiBaseUrl}/v2/online-checkout/payment-links`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secret.SQUARE_ACCESS_TOKEN}`,
          "Square-Version": apiVersion,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          idempotency_key: idempotency,
          description:
            noteText ||
            `Reservation ${String(reservationId ?? "").trim()} payment link`,
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
          pre_populated_data:
            includePhone && buyerPhoneNumber
              ? {
                  buyer_phone_number: buyerPhoneNumber,
                }
              : undefined,
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

  async function deactivatePaymentLink({ paymentLinkId }) {
    const normalizedPaymentLinkId = String(paymentLinkId ?? "").trim();
    if (!normalizedPaymentLinkId) throw httpError(400, "paymentLinkId is required");

    const squareEnv = resolveSquareEnv();
    const apiBaseUrl = resolveSquareApiBaseUrl(squareEnv);
    const apiVersion = String(env.SQUARE_API_VERSION ?? "2026-01-22").trim();
    const secret = await loadSquareSecret();

    const response = await fetchImpl(
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

    const response = await fetchImpl(
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
    verifyWebhookSignature,
    getWebhookHealthSummary,
    processSquareWebhookEvent,
  };
}
