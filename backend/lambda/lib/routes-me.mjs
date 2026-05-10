// Customer self-service routes. All require a customer access token
// (enforced by API Gateway via the customer-only authorizer + by
// requireCustomerOwnership at the Lambda layer for defense in depth).
//
// Layout:
//   GET    /me/profile                                — identity + CRM
//   GET    /me/reservations                           — list own reservations
//   DELETE /me                                        — delete account
//   POST   /me/holds                                  — create own hold (rate-limited)
//   POST   /me/reservations                           — upgrade own hold → reservation
//   POST   /me/reservations/{id}/payment/square       — pay via Square SDK (in-app)
//   POST   /me/reservations/{id}/payment-link/square  — Square hosted payment link (WebView)
//   POST   /me/reservations/{id}/cashapp-link/square  — Cash App-only Square hosted link (WebView)
//   POST   /me/reservations/{id}/reschedule           — atomic cancel-with-credit + rebook
//   PUT    /me/reservations/{id}/cancel               — self-cancel (≥24h, credit only)
//   GET    /me/reservations/{id}/check-in-pass        — re-fetch own pass
//   POST   /me/reservations/{id}/wallet-pass          — Apple Wallet (501 until cert)
//   GET    /me/credits                                — reschedule credit balance
//   POST   /me/push-tokens                            — register Expo push token
//   DELETE /me/push-tokens/{token}                    — unregister push token
//
// Ownership is always rechecked against the caller's Cognito sub before
// any reservation-scoped action — the API Gateway authorizer alone is
// not trusted (defense in depth).

const SELF_CANCEL_HOURS_BEFORE_EVENT = 24;
const RESCHEDULE_HOURS_BEFORE_EVENT = 24;
const HOLD_TTL_FOR_CUSTOMER_SECONDS = 600; // 10 minutes (informational; service uses settings)

function actorLabelFromSub(sub) {
  return `customer:${sub}`;
}

function isValidEventDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

// Self-cancel deadline. v1 uses 23:59:59 UTC of the event date as the
// effective end-of-event marker, then subtracts the policy hours. In
// practice this maps to roughly "≥24h before end of event night in
// local tz" — a small rounding error vs. true 24h-before-event-start
// that we accept until event records carry an explicit startTime.
function selfCancelDeadlineMs(eventDate) {
  const eventEndUtcMs = Date.parse(`${eventDate}T23:59:59Z`);
  if (!Number.isFinite(eventEndUtcMs)) return null;
  return eventEndUtcMs - SELF_CANCEL_HOURS_BEFORE_EVENT * 60 * 60 * 1000;
}

export async function handleMeRoute(ctx) {
  const {
    method,
    path,
    event,
    cors,
    json,
    noContent,
    httpError,
    getBody,
    requireCustomerOwnership,
    // identity
    getProfile,
    deleteAccount,
    // reservations + holds
    listReservations,
    getReservationById,
    createHold,
    createReservation,
    cancelReservation,
    rescheduleReservationForCustomer,
    // pass
    getActivePassForReservation,
    // payments
    createSquarePayment,
    createSquarePaymentLink,
    setReservationPaymentLinkWindow,
    addReservationPayment,
    refundSquarePayment,
    appendReservationHistory,
    // credits + push
    listCreditsForCustomer,
    registerPushToken,
    unregisterPushToken,
    // rate limit
    checkAndIncrementCustomerHoldRateLimit,
  } = ctx;

  // ─────────────────────────────────────────────────────────────────
  // Identity
  // ─────────────────────────────────────────────────────────────────

  if (method === "GET" && path === "/me/profile") {
    const sub = requireCustomerOwnership(event);
    const profile = await getProfile(sub);
    return json(200, profile, cors);
  }

  if (method === "GET" && path === "/me/reservations") {
    const sub = requireCustomerOwnership(event);
    const items = await listReservations(sub);
    return json(200, { items }, cors);
  }

  if (method === "DELETE" && path === "/me") {
    const sub = requireCustomerOwnership(event);
    const result = await deleteAccount(sub);
    return json(200, result, cors);
  }

  // ─────────────────────────────────────────────────────────────────
  // Holds
  // ─────────────────────────────────────────────────────────────────

  if (method === "POST" && path === "/me/holds") {
    const sub = requireCustomerOwnership(event);
    const body = (await getBody(event)) ?? {};
    const eventDate = String(body?.eventDate ?? "").trim();
    const tableId = String(body?.tableId ?? "").trim();
    if (!isValidEventDate(eventDate)) {
      return json(400, { message: "eventDate must be YYYY-MM-DD" }, cors);
    }
    if (!tableId) {
      return json(400, { message: "tableId is required" }, cors);
    }

    if (typeof checkAndIncrementCustomerHoldRateLimit === "function") {
      await checkAndIncrementCustomerHoldRateLimit(sub);
    }

    // Phone + name are best-effort enrichments only — they let staff see
    // the customer in the Holds list without staring at a Cognito sub.
    // The hold doesn't need them; the createReservation step will.
    let customerName = null;
    let phone = null;
    try {
      const profile = await getProfile(sub);
      customerName = profile?.name ?? null;
      phone = profile?.phone ?? null;
    } catch {
      // Soft-fail. Hold can still be created without these fields.
    }

    const item = await createHold(
      {
        eventDate,
        tableId,
        customerName,
        phone,
        customerCognitoSub: sub,
      },
      actorLabelFromSub(sub)
    );
    return json(
      201,
      {
        item,
        ttlSeconds: HOLD_TTL_FOR_CUSTOMER_SECONDS,
      },
      cors
    );
  }

  // ─────────────────────────────────────────────────────────────────
  // Reservations
  // ─────────────────────────────────────────────────────────────────

  if (method === "POST" && path === "/me/reservations") {
    const sub = requireCustomerOwnership(event);
    const body = (await getBody(event)) ?? {};
    const eventDate = String(body?.eventDate ?? "").trim();
    const tableId = String(body?.tableId ?? "").trim();
    const holdId = String(body?.holdId ?? "").trim();
    const customerName = String(body?.customerName ?? "").trim();
    if (!isValidEventDate(eventDate)) {
      return json(400, { message: "eventDate must be YYYY-MM-DD" }, cors);
    }
    if (!tableId) return json(400, { message: "tableId is required" }, cors);
    if (!holdId) return json(400, { message: "holdId is required" }, cors);
    if (!customerName) {
      return json(400, { message: "customerName is required" }, cors);
    }

    const profile = await getProfile(sub);
    const phone = profile?.phone;
    if (!phone) {
      // The customer's phone is set at OTP signup; missing here would be
      // a Cognito-side anomaly. Surface as 409 so the mobile app can
      // prompt re-login.
      return json(
        409,
        { message: "Customer phone is missing on the account. Please sign in again." },
        cors
      );
    }

    const item = await createReservation(
      {
        eventDate,
        tableId,
        holdId,
        customerName,
        phone,
        customerCognitoSub: sub,
      },
      actorLabelFromSub(sub),
      false
    );
    return json(201, { item }, cors);
  }

  // ─────────────────────────────────────────────────────────────────
  // /me/reservations/{id}/... — pattern-matched routes
  // ─────────────────────────────────────────────────────────────────

  const meReservationPaymentMatch = path.match(
    /^\/me\/reservations\/([^/]+)\/payment\/square$/
  );
  if (meReservationPaymentMatch && method === "POST") {
    const sub = requireCustomerOwnership(event);
    const reservationId = meReservationPaymentMatch[1];
    const body = (await getBody(event)) ?? {};

    const eventDate = String(body?.eventDate ?? "").trim();
    const sourceId = String(body?.sourceId ?? "").trim();
    const amount = Number(body?.amount ?? 0);
    const idempotencyKey = String(body?.idempotencyKey ?? "").trim();

    if (!isValidEventDate(eventDate)) {
      return json(400, { message: "eventDate must be YYYY-MM-DD" }, cors);
    }
    if (!sourceId) return json(400, { message: "sourceId is required" }, cors);
    if (!Number.isFinite(amount) || amount <= 0) {
      return json(400, { message: "amount must be > 0" }, cors);
    }

    const reservation = await getReservationById(eventDate, reservationId);
    if (!reservation) return json(404, { message: "Reservation not found" }, cors);
    if (String(reservation?.customerCognitoSub ?? "") !== sub) {
      return json(403, { message: "Reservation is not yours" }, cors);
    }
    if (String(reservation?.status ?? "").toUpperCase() !== "CONFIRMED") {
      return json(409, { message: "Reservation is not in a payable state" }, cors);
    }
    const paymentStatus = String(reservation?.paymentStatus ?? "").toUpperCase();
    if (paymentStatus === "PAID" || paymentStatus === "COURTESY") {
      return json(409, { message: "Reservation is already settled" }, cors);
    }
    if (paymentStatus !== "PENDING" && paymentStatus !== "PARTIAL") {
      return json(409, { message: "Reservation is not eligible for online payment" }, cors);
    }
    const amountDue = Number(reservation?.amountDue ?? 0);
    const paid = Number(reservation?.depositAmount ?? 0);
    const remainingAmount = Math.max(0, Number((amountDue - paid).toFixed(2)));
    if (remainingAmount <= 0) {
      return json(409, { message: "Reservation is already paid" }, cors);
    }
    if (amount > remainingAmount) {
      return json(400, { message: "amount cannot exceed remaining balance" }, cors);
    }

    const actor = actorLabelFromSub(sub);
    const square = await createSquarePayment({
      reservationId,
      eventDate,
      amount,
      sourceId,
      note: "Customer self-payment",
      idempotencyKey: idempotencyKey || undefined,
    });
    const squarePaymentId = String(square?.payment?.id ?? "").trim();
    let updated;
    try {
      updated = await addReservationPayment(
        reservationId,
        {
          eventDate,
          amount,
          method: "square",
          // omit explicit source: addReservationPayment's auto-default
          // ("square-direct" for non-webhook square payments) is the
          // correct value here. The actor "customer:{sub}" identifies
          // who initiated the payment; payment.source records the
          // technical channel and is constrained to a fixed enum.
          provider: {
            providerPaymentId: squarePaymentId,
            providerStatus: String(square?.payment?.status ?? "").trim(),
            providerSourceType: String(square?.payment?.source_type ?? "").trim(),
            providerReceiptUrl: String(square?.payment?.receipt_url ?? "").trim(),
          },
          idempotencyKey: idempotencyKey || undefined,
        },
        actor
      );
    } catch (recordErr) {
      // Audit C2: money already left the customer's card; refund or alarm.
      let refundResult = null;
      if (typeof refundSquarePayment === "function" && squarePaymentId) {
        try {
          const refund = await refundSquarePayment({
            paymentId: squarePaymentId,
            amount,
            idempotencyKey: `auto-refund-${squarePaymentId}`,
            reason: "Self-service payment record failed — auto refund",
          });
          refundResult = {
            refunded: true,
            refundId: refund?.refund?.id ?? null,
          };
          if (typeof appendReservationHistory === "function") {
            await appendReservationHistory({
              eventDate,
              reservationId,
              eventType: "AUTO_REFUND_AFTER_RECORD_FAILURE",
              actor,
              source: "customer",
              details: {
                paymentId: squarePaymentId,
                refundId: refund?.refund?.id ?? null,
                amount,
                recordErrorMessage: String(recordErr?.message ?? recordErr ?? "").slice(0, 256),
              },
            });
          }
        } catch (refundErr) {
          console.error("auto_refund_failed", {
            reservationId,
            eventDate,
            paymentId: squarePaymentId,
            amount,
            refundError: String(refundErr?.message ?? refundErr ?? ""),
            recordError: String(recordErr?.message ?? recordErr ?? ""),
            actor,
          });
          if (typeof appendReservationHistory === "function") {
            try {
              await appendReservationHistory({
                eventDate,
                reservationId,
                eventType: "AUTO_REFUND_FAILED",
                actor,
                source: "customer",
                details: {
                  paymentId: squarePaymentId,
                  amount,
                  refundErrorMessage: String(refundErr?.message ?? refundErr ?? "").slice(0, 256),
                  recordErrorMessage: String(recordErr?.message ?? recordErr ?? "").slice(0, 256),
                },
              });
            } catch {
              // best-effort
            }
          }
          refundResult = {
            refunded: false,
            errorMessage: String(refundErr?.message ?? refundErr ?? ""),
          };
        }
      }
      return json(
        502,
        {
          message: "Payment was charged but could not be recorded. Auto-refund attempted.",
          paymentId: squarePaymentId,
          refund: refundResult,
        },
        cors
      );
    }

    return json(
      200,
      {
        ok: true,
        reservation: updated,
        square: {
          paymentId: squarePaymentId,
          status: String(square?.payment?.status ?? "").trim(),
          receiptUrl: String(square?.payment?.receipt_url ?? "").trim() || null,
        },
      },
      cors
    );
  }

  const meReservationPaymentLinkMatch = path.match(
    /^\/me\/reservations\/([^/]+)\/payment-link\/square$/
  );
  if (meReservationPaymentLinkMatch && method === "POST") {
    const sub = requireCustomerOwnership(event);
    const reservationId = meReservationPaymentLinkMatch[1];
    const body = (await getBody(event)) ?? {};
    const eventDate = String(body?.eventDate ?? "").trim();
    if (!isValidEventDate(eventDate)) {
      return json(400, { message: "eventDate must be YYYY-MM-DD" }, cors);
    }

    const reservation = await getReservationById(eventDate, reservationId);
    if (!reservation) return json(404, { message: "Reservation not found" }, cors);
    if (String(reservation?.customerCognitoSub ?? "") !== sub) {
      return json(403, { message: "Reservation is not yours" }, cors);
    }
    if (String(reservation?.status ?? "").toUpperCase() !== "CONFIRMED") {
      return json(409, { message: "Reservation is not in a payable state" }, cors);
    }
    const paymentStatus = String(reservation?.paymentStatus ?? "").toUpperCase();
    if (paymentStatus === "PAID" || paymentStatus === "COURTESY") {
      return json(409, { message: "Reservation is already settled" }, cors);
    }
    if (paymentStatus !== "PENDING" && paymentStatus !== "PARTIAL") {
      return json(409, { message: "Reservation is not eligible for online payment" }, cors);
    }

    const amountDue = Number(reservation?.amountDue ?? 0);
    const paid = Number(reservation?.depositAmount ?? 0);
    const remainingAmount = Math.max(0, Number((amountDue - paid).toFixed(2)));
    if (remainingAmount <= 0) {
      return json(409, { message: "Reservation is already paid" }, cors);
    }

    if (typeof createSquarePaymentLink !== "function") {
      return json(503, { message: "Payment link service is unavailable" }, cors);
    }

    const actor = actorLabelFromSub(sub);
    const square = await createSquarePaymentLink({
      reservationId,
      eventDate,
      tableId: String(reservation?.tableId ?? "").trim(),
      customerName: String(reservation?.customerName ?? "").trim(),
      phone: String(reservation?.phone ?? "").trim(),
      amount: remainingAmount,
      note: "Customer self-payment",
    });
    const paymentLink = square?.paymentLink ?? {};
    const paymentLinkUrl = String(paymentLink?.url ?? "").trim();
    const paymentLinkId = String(paymentLink?.id ?? "").trim();
    if (!paymentLinkUrl) {
      return json(502, { message: "Square payment link response missing url" }, cors);
    }

    let reservationAfterLink = reservation;
    if (typeof setReservationPaymentLinkWindow === "function") {
      reservationAfterLink = await setReservationPaymentLinkWindow({
        eventDate,
        reservationId,
        paymentLinkId,
        paymentLinkUrl,
        actor,
      });
    }

    return json(
      200,
      {
        reservation: {
          reservationId,
          eventDate,
          paymentStatus:
            reservationAfterLink?.paymentStatus ?? reservation?.paymentStatus ?? null,
          amountDue,
          paid,
          remainingAmount,
          paymentDeadlineAt:
            reservationAfterLink?.paymentDeadlineAt ??
            reservation?.paymentDeadlineAt ??
            null,
        },
        paymentLink: {
          id: paymentLinkId || null,
          url: paymentLinkUrl,
          amount: remainingAmount,
        },
      },
      cors
    );
  }

  const meReservationCashAppLinkMatch = path.match(
    /^\/me\/reservations\/([^/]+)\/cashapp-link\/square$/
  );
  if (meReservationCashAppLinkMatch && method === "POST") {
    const sub = requireCustomerOwnership(event);
    const reservationId = meReservationCashAppLinkMatch[1];
    const body = (await getBody(event)) ?? {};
    const eventDate = String(body?.eventDate ?? "").trim();
    if (!isValidEventDate(eventDate)) {
      return json(400, { message: "eventDate must be YYYY-MM-DD" }, cors);
    }

    const reservation = await getReservationById(eventDate, reservationId);
    if (!reservation) return json(404, { message: "Reservation not found" }, cors);
    if (String(reservation?.customerCognitoSub ?? "") !== sub) {
      return json(403, { message: "Reservation is not yours" }, cors);
    }
    if (String(reservation?.status ?? "").toUpperCase() !== "CONFIRMED") {
      return json(409, { message: "Reservation is not in a payable state" }, cors);
    }
    const paymentStatus = String(reservation?.paymentStatus ?? "").toUpperCase();
    if (paymentStatus === "PAID" || paymentStatus === "COURTESY") {
      return json(409, { message: "Reservation is already settled" }, cors);
    }
    if (paymentStatus !== "PENDING" && paymentStatus !== "PARTIAL") {
      return json(409, { message: "Reservation is not eligible for online payment" }, cors);
    }

    const amountDue = Number(reservation?.amountDue ?? 0);
    const paid = Number(reservation?.depositAmount ?? 0);
    const remainingAmount = Math.max(0, Number((amountDue - paid).toFixed(2)));
    if (remainingAmount <= 0) {
      return json(409, { message: "Reservation is already paid" }, cors);
    }

    if (typeof createSquarePaymentLink !== "function") {
      return json(503, { message: "Payment link service is unavailable" }, cors);
    }

    const actor = actorLabelFromSub(sub);
    // Cash App Pay only — square hosted checkout will hide card / Apple
    // Pay / Google Pay options. Customer flow: button in the mobile app
    // → expo-web-browser opens this URL → tap "Cash App Pay" → user
    // confirms in Cash App app (or sees a $cashtag QR for desktop) →
    // Square webhook flips reservation to PAID via the existing
    // /webhooks/square pipeline.
    const square = await createSquarePaymentLink({
      reservationId,
      eventDate,
      tableId: String(reservation?.tableId ?? "").trim(),
      customerName: String(reservation?.customerName ?? "").trim(),
      phone: String(reservation?.phone ?? "").trim(),
      amount: remainingAmount,
      note: "Customer self-payment via Cash App",
      acceptedPaymentMethods: {
        apple_pay: false,
        google_pay: false,
        cash_app_pay: true,
      },
    });
    const paymentLink = square?.paymentLink ?? {};
    const paymentLinkUrl = String(paymentLink?.url ?? "").trim();
    const paymentLinkId = String(paymentLink?.id ?? "").trim();
    if (!paymentLinkUrl) {
      return json(502, { message: "Square payment link response missing url" }, cors);
    }

    let reservationAfterLink = reservation;
    if (typeof setReservationPaymentLinkWindow === "function") {
      reservationAfterLink = await setReservationPaymentLinkWindow({
        eventDate,
        reservationId,
        paymentLinkId,
        paymentLinkUrl,
        actor,
      });
    }

    return json(
      200,
      {
        reservation: {
          reservationId,
          eventDate,
          paymentStatus:
            reservationAfterLink?.paymentStatus ?? reservation?.paymentStatus ?? null,
          amountDue,
          paid,
          remainingAmount,
          paymentDeadlineAt:
            reservationAfterLink?.paymentDeadlineAt ??
            reservation?.paymentDeadlineAt ??
            null,
        },
        paymentLink: {
          id: paymentLinkId || null,
          url: paymentLinkUrl,
          amount: remainingAmount,
        },
      },
      cors
    );
  }

  const meReservationRescheduleMatch = path.match(
    /^\/me\/reservations\/([^/]+)\/reschedule$/
  );
  if (meReservationRescheduleMatch && method === "POST") {
    const sub = requireCustomerOwnership(event);
    const originalReservationId = meReservationRescheduleMatch[1];
    const body = (await getBody(event)) ?? {};

    const originalEventDate = String(body?.originalEventDate ?? "").trim();
    const newEventDate = String(body?.newEventDate ?? "").trim();
    const newTableId = String(body?.newTableId ?? "").trim();
    const newHoldId = String(body?.newHoldId ?? "").trim();
    const customerName = String(body?.customerName ?? "").trim();
    const newPaymentDeadlineAt = String(body?.newPaymentDeadlineAt ?? "").trim();
    const newPaymentDeadlineTz = String(body?.newPaymentDeadlineTz ?? "").trim();
    const reason =
      String(body?.reason ?? "").trim() || "Customer rescheduled via mobile app";

    if (!isValidEventDate(originalEventDate)) {
      return json(400, { message: "originalEventDate must be YYYY-MM-DD" }, cors);
    }
    if (!isValidEventDate(newEventDate)) {
      return json(400, { message: "newEventDate must be YYYY-MM-DD" }, cors);
    }
    if (!newTableId) return json(400, { message: "newTableId is required" }, cors);
    if (!newHoldId) return json(400, { message: "newHoldId is required" }, cors);
    if (!customerName) {
      return json(400, { message: "customerName is required" }, cors);
    }
    if (typeof rescheduleReservationForCustomer !== "function") {
      return json(503, { message: "Reschedule service is unavailable" }, cors);
    }

    const result = await rescheduleReservationForCustomer({
      originalEventDate,
      originalReservationId,
      newEventDate,
      newTableId,
      newHoldId,
      newCustomerName: customerName,
      customerCognitoSub: sub,
      newPaymentDeadlineAt: newPaymentDeadlineAt || undefined,
      newPaymentDeadlineTz: newPaymentDeadlineTz || undefined,
      reason,
      actor: actorLabelFromSub(sub),
      hoursBefore: RESCHEDULE_HOURS_BEFORE_EVENT,
    });

    return json(201, result, cors);
  }

  const meReservationCancelMatch = path.match(
    /^\/me\/reservations\/([^/]+)\/cancel$/
  );
  if (meReservationCancelMatch && method === "PUT") {
    const sub = requireCustomerOwnership(event);
    const reservationId = meReservationCancelMatch[1];
    const body = (await getBody(event)) ?? {};
    const eventDate = String(body?.eventDate ?? "").trim();
    const reason =
      String(body?.reason ?? "").trim() || "Customer cancelled via mobile app";
    if (!isValidEventDate(eventDate)) {
      return json(400, { message: "eventDate must be YYYY-MM-DD" }, cors);
    }

    const reservation = await getReservationById(eventDate, reservationId);
    if (!reservation) return json(404, { message: "Reservation not found" }, cors);
    if (String(reservation?.customerCognitoSub ?? "") !== sub) {
      return json(403, { message: "Reservation is not yours" }, cors);
    }
    const status = String(reservation?.status ?? "").toUpperCase();
    if (status !== "CONFIRMED") {
      return json(
        409,
        { message: `Reservation cannot be cancelled. Status: ${status || "UNKNOWN"}` },
        cors
      );
    }

    const cutoffMs = selfCancelDeadlineMs(eventDate);
    if (cutoffMs === null || Date.now() >= cutoffMs) {
      return json(
        409,
        {
          message:
            "Self-cancel is only allowed at least 24 hours before the event. Please contact the restaurant.",
          policyHours: SELF_CANCEL_HOURS_BEFORE_EVENT,
        },
        cors
      );
    }

    const tableId = String(reservation?.tableId ?? "").trim();
    const item = await cancelReservation(
      eventDate,
      reservationId,
      tableId,
      actorLabelFromSub(sub),
      reason,
      { resolutionType: "RESCHEDULE_CREDIT" }
    );
    return json(200, { item }, cors);
  }

  const meReservationPassMatch = path.match(
    /^\/me\/reservations\/([^/]+)\/check-in-pass$/
  );
  if (meReservationPassMatch && method === "GET") {
    const sub = requireCustomerOwnership(event);
    const reservationId = meReservationPassMatch[1];
    const eventDate = String(event?.queryStringParameters?.eventDate ?? "").trim();
    if (!isValidEventDate(eventDate)) {
      return json(400, { message: "eventDate query parameter is required (YYYY-MM-DD)" }, cors);
    }

    const reservation = await getReservationById(eventDate, reservationId);
    if (!reservation) return json(404, { message: "Reservation not found" }, cors);
    if (String(reservation?.customerCognitoSub ?? "") !== sub) {
      return json(403, { message: "Reservation is not yours" }, cors);
    }

    const pass = await getActivePassForReservation(reservationId, {
      includeToken: true,
    });
    if (!pass) {
      return json(
        404,
        {
          message: "No check-in pass available yet for this reservation.",
          code: "PASS_NOT_READY",
        },
        cors
      );
    }
    return json(200, { pass }, cors);
  }

  const meReservationWalletPassMatch = path.match(
    /^\/me\/reservations\/([^/]+)\/wallet-pass$/
  );
  if (meReservationWalletPassMatch && method === "POST") {
    // Ownership check first so unauthorized callers don't learn the
    // route exists. Then return 501 — the Apple Pass Type ID cert
    // and signing endpoint are not yet provisioned. Mobile app should
    // hide the "Add to Wallet" CTA when this returns 501.
    const sub = requireCustomerOwnership(event);
    const reservationId = meReservationWalletPassMatch[1];
    const body = (await getBody(event)) ?? {};
    const eventDate = String(body?.eventDate ?? "").trim();
    if (!isValidEventDate(eventDate)) {
      return json(400, { message: "eventDate must be YYYY-MM-DD" }, cors);
    }
    const reservation = await getReservationById(eventDate, reservationId);
    if (!reservation) return json(404, { message: "Reservation not found" }, cors);
    if (String(reservation?.customerCognitoSub ?? "") !== sub) {
      return json(403, { message: "Reservation is not yours" }, cors);
    }
    return json(
      501,
      {
        message: "Apple Wallet pass generation is not yet enabled. Coming soon.",
        code: "WALLET_PASS_NOT_CONFIGURED",
      },
      cors
    );
  }

  // ─────────────────────────────────────────────────────────────────
  // Credits
  // ─────────────────────────────────────────────────────────────────

  if (method === "GET" && path === "/me/credits") {
    const sub = requireCustomerOwnership(event);
    const result = await listCreditsForCustomer(sub);
    return json(200, result, cors);
  }

  // ─────────────────────────────────────────────────────────────────
  // Push tokens
  // ─────────────────────────────────────────────────────────────────

  if (method === "POST" && path === "/me/push-tokens") {
    const sub = requireCustomerOwnership(event);
    const body = (await getBody(event)) ?? {};
    const result = await registerPushToken(sub, body?.token, body?.platform);
    return json(201, result, cors);
  }

  const pushTokenDeleteMatch = path.match(/^\/me\/push-tokens\/([^/]+)$/);
  if (pushTokenDeleteMatch && method === "DELETE") {
    const sub = requireCustomerOwnership(event);
    const tokenFromPath = decodeURIComponent(pushTokenDeleteMatch[1]);
    const result = await unregisterPushToken(sub, tokenFromPath);
    return json(200, result, cors);
  }

  return null;
}
