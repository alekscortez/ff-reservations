function getHeader(headers, name) {
  if (!headers || typeof headers !== "object") return "";
  const target = String(name ?? "").toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === target) {
      return String(value ?? "").trim();
    }
  }
  return "";
}

function getRawBody(event) {
  if (!event?.body) return "";
  if (event.isBase64Encoded) {
    return Buffer.from(event.body, "base64").toString("utf8");
  }
  return String(event.body);
}

function buildRequestUrl(event) {
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
    console.info("Square webhook audit", audit);
    return json(200, { ok: true, audit, ...result });
  }

  return null;
}
