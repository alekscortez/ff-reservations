export function getHeader(headers, name) {
  if (!headers || typeof headers !== "object") return "";
  const target = String(name ?? "").toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === target) {
      return String(value ?? "").trim();
    }
  }
  return "";
}

export function getRawBody(event) {
  if (!event?.body) return "";
  if (event.isBase64Encoded) {
    return Buffer.from(event.body, "base64").toString("utf8");
  }
  return String(event.body);
}

export function buildRequestUrl(event) {
  const headers = event?.headers ?? {};
  const proto = getHeader(headers, "x-forwarded-proto") || "https";
  const host =
    getHeader(headers, "x-forwarded-host") ||
    getHeader(headers, "host");
  const path =
    String(event?.rawPath ?? "").trim() ||
    String(event?.requestContext?.http?.path ?? "").trim() ||
    "/";
  const rawQuery = String(event?.rawQueryString ?? "").trim();
  if (!host) return "";
  return `${proto}://${host}${path}${rawQuery ? `?${rawQuery}` : ""}`;
}

export async function handleSquareWebhookRoute(ctx) {
  const {
    method,
    path,
    event,
    cors,
    json,
    requireAdmin,
    getSquareWebhookHealthSummary,
    verifySquareWebhookSignature,
    processSquareWebhookEvent,
    addReservationPayment,
    // Optional CODE-lookup so the webhook can resolve a confirmation
    // code in payment.note (the friendlier receipt format) back to a
    // {reservationId, eventDate}. When missing, the new note format
    // gracefully degrades to `ignored: code_lookup_unavailable`.
    lookupReservationByConfirmationCode,
    // Optional: after a webhook successfully records a payment we look
    // up the reservation to decide whether to fire the Meta CAPI
    // Purchase event. Both deps are optional — when missing, the
    // Purchase event isn't fired.
    getReservationById,
    metaCapi,
    publicBookingReturnBaseUrl,
  } = ctx;

  if (method === "GET" && /^\/admin\/square\/webhook-health\/?$/.test(path)) {
    requireAdmin(event);
    const summary = await getSquareWebhookHealthSummary();
    return json(200, summary, cors);
  }

  if (method === "POST" && /^\/webhooks\/square\/?$/.test(path)) {
    const rawBody = getRawBody(event);
    if (!rawBody) return json(400, { message: "Missing body" });

    const signature = getHeader(event?.headers, "x-square-hmacsha256-signature");
    const requestUrl = buildRequestUrl(event);
    const signatureValid = await verifySquareWebhookSignature({
      signatureHeader: signature,
      rawBody,
      requestUrl,
    });
    if (!signatureValid) return json(403, { message: "Invalid signature" });

    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return json(400, { message: "Invalid JSON body" });
    }

    const result = await processSquareWebhookEvent({
      webhookEvent: payload,
      addReservationPayment,
      lookupReservationByConfirmationCode,
    });
    const audit = {
      handledAs: result?.processed ? "processed" : "ignored",
      eventType: String(payload?.type ?? result?.type ?? "").trim() || null,
      eventId: String(payload?.event_id ?? "").trim() || null,
      paymentId:
        String(result?.paymentId ?? payload?.data?.id ?? payload?.data?.object?.payment?.id ?? "").trim() ||
        null,
      reservationId: String(result?.reservationId ?? "").trim() || null,
      reason: String(result?.reason ?? "").trim() || null,
    };
    console.info("square_webhook_audit", audit);
    // Meta CAPI Purchase. Fires when a payment successfully lands on a
    // PAID reservation. Dedupe key = `purchase_${reservationId}` so
    // duplicate webhook fires (or replays) produce the same event_id
    // and Meta deduplicates on its side. user_data is populated from
    // the reservation row: hashed phone + email (Layer 1 advanced
    // matching) + the attribution.fbc/fbp captured at first-touch.
    // Failures are swallowed — CAPI must never block a webhook 200.
    try {
      if (
        result?.processed &&
        result?.reservationId &&
        result?.eventDate &&
        metaCapi &&
        typeof metaCapi.isEnabled === "function" &&
        metaCapi.isEnabled() &&
        typeof getReservationById === "function"
      ) {
        const reservation = await getReservationById(
          result.eventDate,
          result.reservationId
        );
        const paymentStatus = String(reservation?.paymentStatus ?? "").toUpperCase();
        const status = String(reservation?.status ?? "").toUpperCase();
        if (paymentStatus === "PAID" && status !== "CANCELLED") {
          const attribution =
            reservation?.attribution && typeof reservation.attribution === "object"
              ? reservation.attribution
              : null;
          // Synthesize fbc from the first-touch fbclid we captured if
          // the FE didn't manage to read the _fbc cookie at booking time.
          // Format per Meta spec: fb.{subdomain_idx}.{first_touch_ms}.{fbclid}
          // For famosofuego.com subdomain_idx = 1 (eTLD+1).
          let fbc = null;
          if (attribution?.fbc) {
            fbc = String(attribution.fbc);
          } else if (attribution?.fbclid && attribution?.firstTouchAt) {
            fbc = `fb.1.${attribution.firstTouchAt}.${attribution.fbclid}`;
          }
          const eventSourceUrl = publicBookingReturnBaseUrl
            ? `${String(publicBookingReturnBaseUrl).replace(/\/+$/, "")}/r/${encodeURIComponent(
                reservation.reservationId
              )}`
            : null;
          await metaCapi.trackPurchase({
            eventId: `purchase_${reservation.reservationId}`,
            eventSourceUrl,
            userData: {
              email: reservation?.customerEmail ?? null,
              phone: reservation?.phone ?? null,
              fbc,
              fbp: attribution?.fbp ?? null,
              externalId: reservation.reservationId,
            },
            value: Number(reservation?.depositAmount ?? 0),
            currency: "USD",
            orderId: reservation.reservationId,
            contentIds: Array.isArray(reservation?.tableIds)
              ? reservation.tableIds.map((id) => `table_${id}`)
              : undefined,
          });
        }
      }
    } catch (err) {
      console.warn("meta_capi_purchase_failed", {
        reservationId: result?.reservationId ?? null,
        message: err?.message ?? String(err),
      });
    }
    return json(200, { ok: true, audit, ...result });
  }

  return null;
}
