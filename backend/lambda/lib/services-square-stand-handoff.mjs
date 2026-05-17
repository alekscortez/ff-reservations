// Square Stand handoff: server-side state for the iPad URL-scheme bridge.
//
// Flow (single-iPad — Safari + Square POS app on the same device, paired
// with a Square Stand reader):
//   1. Staff opens take-payment modal in Safari, picks "Card on Stand".
//   2. FE POST /reservations/{id}/payment/square-stand/start
//      → startHandoff writes a 15-min TTL row to HOLDS_TABLE under
//        PK="STANDPAY", SK="HANDOFF#{uuid}". Carries reservationId,
//        eventDate, amount, returnPath, expectedConfirmationCode.
//   3. FE constructs `square-commerce-v1://payment/create?data=...` with
//      `state: handoffId`, navigates Safari → iOS launches Square POS app.
//   4. Customer's card is swiped on the Stand reader. Square POS captures
//      the payment, then redirects Safari to the registered callback URL.
//   5. /staff/square-stand-callback page POSTs `/complete` with
//      {handoffId, transactionId}.
//   6. completeHandoff loads the handoff row, resolves transactionId →
//      Order → Payment via the Square Payments + Orders APIs, validates
//      amount, then dispatches addReservationPayment with
//      method:"square" source:"square-stand".
//
// Idempotency:
// - The same handoffId can be completed twice (e.g. user double-click on
//   the callback page). We re-fetch the Payment and rely on
//   addReservationPayment's providerPaymentId dedupe in
//   services-payment-recording. Result: second call returns the existing
//   reservation row without double-recording.
// - The `payment.created` webhook also fires for any Stand payment.
//   processSquareWebhookEvent extracts the reservation reference from
//   `payment.note` (we set it to "Booking #FF-XXXXXX • date" in the POS
//   API request) and routes through the same addReservationPayment.
//   Same dedupe protects us.

import {
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

const STANDPAY_PK = "STANDPAY";
const HANDOFF_SK_PREFIX = "HANDOFF#";
// 15 minutes — long enough for a customer to fumble with a card / signature
// without losing the handoff, short enough that abandoned rows TTL out
// before they accumulate. DDB TTL eviction has up to 48h lag, but we also
// check expiresAt at read time so a stale row gets rejected synchronously.
const DEFAULT_HANDOFF_TTL_SECONDS = 15 * 60;
const VALID_STATUSES = new Set([
  "PENDING",
  "CONSUMED",
  "CANCELLED",
]);

export function createSquareStandHandoffService({
  ddb,
  tableNames,
  httpError,
  nowEpoch,
  randomUUID,
  getOrderById,
  getPaymentById,
  addReservationPayment,
  getReservationById,
  // Optional: when set, completeHandoff auto-refunds Square charges that
  // can't be recorded against the reservation (concurrent payment landed,
  // reservation cancelled mid-flow, captured amount exceeds handoff).
  // Mirrors autoRefundAfterRecordFailure from routes-reservations-holds.
  // Omit only in tests that explicitly cover the no-refund fallback.
  refundSquarePayment,
  // Optional: fire-and-forget history hook for audit trail of refunds.
  // Same shape as services-reservations-shared.appendReservationHistory.
  appendReservationHistory,
  // Optional: override the callback URL (e.g. for tests). When omitted,
  // the route handler is expected to inject the URL it computed from the
  // request origin + path.
  defaultCallbackUrl,
  // Optional: override TTL (seconds). Tests pass a short value to exercise
  // expiry; prod uses DEFAULT_HANDOFF_TTL_SECONDS.
  handoffTtlSeconds = DEFAULT_HANDOFF_TTL_SECONDS,
}) {
  const tableName = String(tableNames?.HOLDS_TABLE ?? "").trim();

  function ensureTable() {
    if (!tableName) {
      throw httpError(500, "HOLDS_TABLE is not configured");
    }
  }

  function handoffKey(handoffId) {
    return {
      PK: STANDPAY_PK,
      SK: `${HANDOFF_SK_PREFIX}${handoffId}`,
    };
  }

  function roundMoney(value) {
    return Math.round(Number(value ?? 0) * 100) / 100;
  }

  // Auto-refund a Square charge whose reservation-recording leg failed.
  // Idempotency key is stable per Square paymentId so retries are safe and
  // Square returns the existing refund. Mirrors the pattern in
  // routes-reservations-holds.autoRefundAfterRecordFailure — kept here so
  // the service stays the single owner of the Square-side state machine.
  async function tryAutoRefund({
    paymentId,
    amount,
    eventDate,
    reservationId,
    recordError,
    actor,
  }) {
    if (typeof refundSquarePayment !== "function") {
      // eslint-disable-next-line no-console
      console.error("auto_refund_skipped_no_refund_service", {
        scope: "square-stand",
        reservationId,
        eventDate,
        paymentId,
        recordError: String(recordError?.message ?? recordError ?? ""),
      });
      return { refunded: false, reason: "refund_service_unavailable" };
    }
    if (!paymentId || !(amount > 0)) {
      return { refunded: false, reason: "missing_payment_or_amount" };
    }
    try {
      const refund = await refundSquarePayment({
        paymentId,
        amount,
        idempotencyKey: `auto-refund-${paymentId}`,
        reason: "Card on Stand reservation update failed — auto refund",
      });
      // eslint-disable-next-line no-console
      console.warn("auto_refund_after_record_failure", {
        scope: "square-stand",
        reservationId,
        eventDate,
        paymentId,
        refundId: refund?.refund?.id ?? null,
        amount,
        recordError: String(recordError?.message ?? recordError ?? ""),
      });
      if (typeof appendReservationHistory === "function") {
        try {
          await appendReservationHistory({
            eventDate,
            reservationId,
            eventType: "AUTO_REFUND_AFTER_RECORD_FAILURE",
            actor: String(actor ?? "").trim() || "system:square-stand",
            source: "system",
            details: {
              paymentId,
              refundId: refund?.refund?.id ?? null,
              amount,
              recordErrorMessage: String(
                recordError?.message ?? recordError ?? ""
              ).slice(0, 256),
              integration: "square-stand",
            },
          });
        } catch {
          // Best-effort history write — never block the refund response.
        }
      }
      return {
        refunded: true,
        refundId: refund?.refund?.id ?? null,
        refundStatus: refund?.refund?.status ?? null,
      };
    } catch (refundErr) {
      // eslint-disable-next-line no-console
      console.error("auto_refund_failed", {
        scope: "square-stand",
        reservationId,
        eventDate,
        paymentId,
        amount,
        refundError: String(refundErr?.message ?? refundErr ?? ""),
        recordError: String(recordError?.message ?? recordError ?? ""),
      });
      if (typeof appendReservationHistory === "function") {
        try {
          await appendReservationHistory({
            eventDate,
            reservationId,
            eventType: "AUTO_REFUND_FAILED",
            actor: String(actor ?? "").trim() || "system:square-stand",
            source: "system",
            details: {
              paymentId,
              amount,
              refundErrorMessage: String(
                refundErr?.message ?? refundErr ?? ""
              ).slice(0, 256),
              recordErrorMessage: String(
                recordError?.message ?? recordError ?? ""
              ).slice(0, 256),
              integration: "square-stand",
            },
          });
        } catch {
          // Best-effort.
        }
      }
      return {
        refunded: false,
        reason: "refund_failed",
        refundErrorMessage: String(refundErr?.message ?? refundErr ?? ""),
      };
    }
  }

  async function startHandoff({
    reservationId,
    eventDate,
    amount,
    note,
    returnPath,
    callbackUrl,
    actor,
  }) {
    ensureTable();
    const normalizedReservationId = String(reservationId ?? "").trim();
    if (!normalizedReservationId) {
      throw httpError(400, "reservationId is required");
    }
    const normalizedEventDate = String(eventDate ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedEventDate)) {
      throw httpError(400, "eventDate must be YYYY-MM-DD");
    }
    const amountNum = roundMoney(amount);
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      throw httpError(400, "amount must be > 0");
    }

    // Re-validate the reservation: only CONFIRMED + (PENDING|PARTIAL) is
    // eligible. Mirrors the existing /payment/square route's guard.
    const reservation = await getReservationById(
      normalizedEventDate,
      normalizedReservationId
    );
    if (String(reservation?.status ?? "").toUpperCase() !== "CONFIRMED") {
      throw httpError(400, "Only confirmed reservations can receive payments");
    }
    if (String(reservation?.paymentStatus ?? "").toUpperCase() === "COURTESY") {
      throw httpError(400, "Cannot add payments to courtesy reservations");
    }
    const amountDue = roundMoney(reservation?.amountDue ?? 0);
    const paid = roundMoney(reservation?.depositAmount ?? 0);
    const remaining = roundMoney(Math.max(0, amountDue - paid));
    if (remaining <= 0) {
      throw httpError(400, "Reservation is already fully paid");
    }
    if (amountNum > remaining) {
      throw httpError(400, "amount cannot exceed remaining balance");
    }

    const handoffId = randomUUID();
    const now = nowEpoch();
    const resolvedCallbackUrl = String(
      callbackUrl ?? defaultCallbackUrl ?? ""
    ).trim();

    const item = {
      ...handoffKey(handoffId),
      entityType: "SQUARE_STAND_HANDOFF",
      handoffId,
      reservationId: normalizedReservationId,
      eventDate: normalizedEventDate,
      amount: amountNum,
      note: String(note ?? "").trim() || null,
      returnPath: String(returnPath ?? "").trim() || null,
      callbackUrl: resolvedCallbackUrl || null,
      confirmationCode:
        String(reservation?.confirmationCode ?? "").trim() || null,
      status: "PENDING",
      createdAt: now,
      createdBy: String(actor ?? "").trim() || null,
      expiresAt: now + handoffTtlSeconds,
    };

    await ddb.send(
      new PutCommand({
        TableName: tableName,
        Item: item,
      })
    );

    return {
      handoffId,
      callbackUrl: resolvedCallbackUrl,
      expiresAt: item.expiresAt,
      amount: amountNum,
    };
  }

  async function loadHandoff(handoffId) {
    ensureTable();
    const normalizedHandoffId = String(handoffId ?? "").trim();
    if (!normalizedHandoffId) {
      throw httpError(400, "handoffId is required");
    }
    const out = await ddb.send(
      new GetCommand({
        TableName: tableName,
        Key: handoffKey(normalizedHandoffId),
      })
    );
    if (!out?.Item) {
      throw httpError(404, "Handoff not found or expired");
    }
    return out.Item;
  }

  async function completeHandoff({
    reservationId,
    handoffId,
    transactionId,
    actor,
  }) {
    ensureTable();
    const normalizedHandoffId = String(handoffId ?? "").trim();
    const normalizedTransactionId = String(transactionId ?? "").trim();
    const normalizedReservationId = String(reservationId ?? "").trim();
    if (!normalizedHandoffId) {
      throw httpError(400, "handoffId is required");
    }
    if (!normalizedTransactionId) {
      throw httpError(400, "transactionId is required");
    }

    const handoff = await loadHandoff(normalizedHandoffId);
    if (
      normalizedReservationId &&
      handoff.reservationId !== normalizedReservationId
    ) {
      throw httpError(400, "reservationId does not match the handoff record");
    }

    const status = String(handoff.status ?? "").toUpperCase();
    if (status === "CANCELLED") {
      throw httpError(409, "Handoff was cancelled");
    }
    const now = nowEpoch();
    if (Number(handoff.expiresAt ?? 0) <= now && status !== "CONSUMED") {
      throw httpError(409, "Handoff expired");
    }

    // Square POS returns transaction_id, which is the Order id.
    // RetrieveOrder → tenders[].payment_id → GetPayment.
    const orderRes = await getOrderById(normalizedTransactionId);
    const tenders = Array.isArray(orderRes?.order?.tenders)
      ? orderRes.order.tenders
      : [];
    const firstPaymentId = tenders
      .map((t) => String(t?.payment_id ?? "").trim())
      .find(Boolean);
    if (!firstPaymentId) {
      throw httpError(502, "Square order has no payment tender yet");
    }

    const paymentRes = await getPaymentById(firstPaymentId);
    const payment = paymentRes?.payment;
    const paymentStatus = String(payment?.status ?? "").toUpperCase();
    if (paymentStatus !== "COMPLETED") {
      throw httpError(
        409,
        `Square payment not completed (status: ${paymentStatus || "UNKNOWN"})`
      );
    }

    const minorAmount = Number(payment?.amount_money?.amount ?? 0);
    if (!Number.isFinite(minorAmount) || minorAmount <= 0) {
      throw httpError(502, "Square payment amount missing");
    }
    const majorAmount = roundMoney(minorAmount / 100);

    const resolvedActor =
      String(actor ?? "").trim() || "system:square-stand";
    const squarePaymentId = String(payment?.id ?? "").trim() || null;

    // Captured-vs-handoff cap (audit finding #2). Square POS captures the
    // payment locally based on the seller's POS settings — if tipping is
    // re-enabled on the Stand iPad, the customer can add a tip that
    // inflates the captured amount past what we asked for. The downstream
    // addReservationPayment cap (`amount > remainingAmount`) would then
    // reject AFTER the card was charged, leaving the customer overpaid
    // and unhappy.
    //
    // We treat any overage > $0.01 as a misconfiguration: refund the WHOLE
    // payment (not just the delta — partial refunds on tipped card
    // transactions risk leaving the reservation half-recorded) and surface
    // a clear seller-side error.
    const requestedAmount = roundMoney(handoff.amount);
    const overage = roundMoney(majorAmount - requestedAmount);
    if (overage > 0.01) {
      const refund = await tryAutoRefund({
        paymentId: squarePaymentId,
        amount: majorAmount,
        eventDate: handoff.eventDate,
        reservationId: handoff.reservationId,
        recordError: new Error(
          `captured_amount_exceeds_handoff: captured=${majorAmount} expected=${requestedAmount}`
        ),
        actor: resolvedActor,
      });
      throw httpError(
        refund.refunded ? 409 : 502,
        refund.refunded
          ? "Square POS captured more than the deposit (tipping is on?). The charge has been refunded automatically. Disable tipping in Square POS settings and retry."
          : `Square POS captured more than the deposit AND the auto-refund FAILED. Manual reconciliation required for Square payment ${squarePaymentId ?? "(unknown)"}.`
      );
    }

    let item;
    try {
      item = await addReservationPayment(
        handoff.reservationId,
        {
          eventDate: handoff.eventDate,
          amount: majorAmount,
          method: "square",
          source: "square-stand",
          note: String(payment?.note ?? handoff.note ?? "").trim() ||
            `Card on Stand · handoff ${normalizedHandoffId}`,
          provider: {
            providerPaymentId: squarePaymentId,
            providerStatus: paymentStatus,
            receiptUrl: String(payment?.receipt_url ?? "").trim() || null,
            orderId: String(payment?.order_id ?? "").trim() || null,
            sourceType: String(payment?.source_type ?? "").trim() || null,
            idempotencyKey:
              String(payment?.idempotency_key ?? "").trim() || null,
            amountMoney:
              payment?.amount_money && typeof payment.amount_money === "object"
                ? {
                    amount: Number(payment.amount_money.amount ?? 0),
                    currency:
                      String(payment.amount_money.currency ?? "").trim() ||
                      null,
                  }
                : null,
          },
        },
        resolvedActor
      );
    } catch (recordErr) {
      // Square already captured the customer's card. The reservation
      // record FAILED — typically because another payment landed first
      // (CCFE 409), the reservation was cancelled between start +
      // complete, or the captured amount exceeded remaining balance.
      // Auto-refund and surface a clear, money-state-aware error.
      const refund = await tryAutoRefund({
        paymentId: squarePaymentId,
        amount: majorAmount,
        eventDate: handoff.eventDate,
        reservationId: handoff.reservationId,
        recordError: recordErr,
        actor: resolvedActor,
      });
      const base =
        String(recordErr?.message ?? "Failed to record payment after charge");
      const msg = refund.refunded
        ? `${base}. The Square charge has been refunded automatically (refund ${refund.refundId ?? "issued"}).`
        : `${base}. Auto-refund FAILED — manual reconciliation required for Square payment ${squarePaymentId ?? "(unknown)"}.`;
      throw httpError(refund.refunded ? 409 : 502, msg);
    }

    // Mark CONSUMED so a later callback retry returns the same record
    // path through addReservationPayment's providerPaymentId dedupe
    // (which short-circuits to the existing row).
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: tableName,
          Key: handoffKey(normalizedHandoffId),
          ConditionExpression:
            "attribute_exists(PK) AND attribute_exists(SK) AND #status <> :consumed",
          UpdateExpression:
            "SET #status = :consumed, #consumedAt = :now, #transactionId = :tx, #paymentId = :pid",
          ExpressionAttributeNames: {
            "#status": "status",
            "#consumedAt": "consumedAt",
            "#transactionId": "transactionId",
            "#paymentId": "paymentId",
          },
          ExpressionAttributeValues: {
            ":consumed": "CONSUMED",
            ":now": now,
            ":tx": normalizedTransactionId,
            ":pid": String(payment?.id ?? "").trim() || null,
          },
        })
      );
    } catch (err) {
      // Already-consumed is fine — fan-in race or double-callback. Other
      // errors surface so we don't quietly lose audit data, but the
      // payment itself is already recorded so we don't throw.
      if (err?.name !== "ConditionalCheckFailedException") {
        // eslint-disable-next-line no-console
        console.warn("[square-stand] handoff status update failed", err);
      }
    }

    return {
      item,
      square: {
        paymentId: String(payment?.id ?? "").trim() || null,
        status: paymentStatus,
        receiptUrl: String(payment?.receipt_url ?? "").trim() || null,
        orderId: String(payment?.order_id ?? "").trim() || null,
        sourceType: String(payment?.source_type ?? "").trim() || null,
        idempotencyKey:
          String(payment?.idempotency_key ?? "").trim() || null,
        env: paymentRes?.squareEnv ?? null,
      },
      handoff: {
        handoffId: normalizedHandoffId,
        consumedAt: now,
      },
    };
  }

  async function cancelHandoff({ handoffId, reason, actor }) {
    ensureTable();
    const normalizedHandoffId = String(handoffId ?? "").trim();
    if (!normalizedHandoffId) {
      throw httpError(400, "handoffId is required");
    }
    const now = nowEpoch();
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: tableName,
          Key: handoffKey(normalizedHandoffId),
          ConditionExpression:
            "attribute_exists(PK) AND attribute_exists(SK) AND #status = :pending",
          UpdateExpression:
            "SET #status = :cancelled, #cancelledAt = :now, #cancelledBy = :actor, #cancelReason = :reason",
          ExpressionAttributeNames: {
            "#status": "status",
            "#cancelledAt": "cancelledAt",
            "#cancelledBy": "cancelledBy",
            "#cancelReason": "cancelReason",
          },
          ExpressionAttributeValues: {
            ":pending": "PENDING",
            ":cancelled": "CANCELLED",
            ":now": now,
            ":actor": String(actor ?? "").trim() || "system",
            ":reason": String(reason ?? "").trim() || "staff_cancelled",
          },
        })
      );
      return { handoffId: normalizedHandoffId, cancelled: true };
    } catch (err) {
      if (err?.name === "ConditionalCheckFailedException") {
        return { handoffId: normalizedHandoffId, cancelled: false };
      }
      throw err;
    }
  }

  return {
    startHandoff,
    completeHandoff,
    cancelHandoff,
    loadHandoff,
    DEFAULT_HANDOFF_TTL_SECONDS,
    VALID_STATUSES,
  };
}
