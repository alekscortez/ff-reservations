// Payment recording + payment-link / Cash App session state. Lifted out of
// services-reservations-holds.mjs (PR #6 / batch-7 of the audit refactor).
//
// What this module owns:
// - addReservationPayment: the full payment-recording state machine
//   (cash / square / cashapp / credit), including the credit-redemption
//   TransactWrite, the CAS on depositAmount (audit C3), the provider
//   dedupe, and the post-update history + check-in pass orchestration.
// - setReservationPaymentLinkWindow: stamp Square payment-link metadata
//   onto the reservation row + extend the deadline.
// - setReservationCashAppLinkSession: same idea for Cash App self-pay.
// - revokeReservationCashAppLinkSession: ACTIVE -> REVOKED (cancellation).
// - markReservationCashAppLinkSessionUsed: ACTIVE -> USED (post-charge).
// - markReservationPaymentLinkInactive: payment-link cleanup after cancel
//   or deactivate.
//
// Public contract: import {createPaymentRecordingService} and pass the
// same deps bag plus the `shared` object built by createReservationsShared.
// Every helper here closes over deps + shared at factory time.

import {
  GetCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

import { DEFAULT_DEADLINE_TZ } from "./services-reservations-shared.mjs";

export function createPaymentRecordingService(
  {
    ddb,
    tableNames,
    requiredEnv,
    httpError,
    nowEpoch,
    randomUUID,
    addDaysToIsoDate,
    normalizePhone,
  },
  shared
) {
  const { RES_TABLE, CLIENTS_TABLE } = tableNames;
  const {
    roundMoney,
    toRescheduleCreditSk,
    appendReservationHistory,
    tryEnsureCheckInPass,
    trySendCheckInPassSms,
    getRuntimeSettings,
    getReservationById,
    resolveCashReceiptNumberRequired,
    resolveDefaultPaymentDeadlineTz,
    resolveDefaultPaymentDeadlineHour,
    resolveDefaultPaymentDeadlineMinute,
    resolvePaymentLinkTtlMinutes,
    shouldUseFrequentPaymentLinkTtl,
    normalizeDeadlineLocalIso,
    nowInTimeZoneLocalIso,
    addMinutesToLocalIso,
    localIsoToEpochSeconds,
  } = shared;

  async function setReservationPaymentLinkWindow({
    eventDate,
    reservationId,
    paymentLinkId,
    paymentLinkUrl,
    actor,
  }) {
    requiredEnv("RES_TABLE", RES_TABLE);
    const normalizedEventDate = String(eventDate ?? "").trim();
    const normalizedReservationId = String(reservationId ?? "").trim();
    const normalizedPaymentLinkId = String(paymentLinkId ?? "").trim();
    const normalizedPaymentLinkUrl = String(paymentLinkUrl ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedEventDate)) {
      throw httpError(400, "eventDate must be YYYY-MM-DD");
    }
    if (!normalizedReservationId) {
      throw httpError(400, "reservationId is required");
    }
    if (!normalizedPaymentLinkId || !normalizedPaymentLinkUrl) {
      throw httpError(400, "paymentLinkId and paymentLinkUrl are required");
    }

    const current = await getReservationById(normalizedEventDate, normalizedReservationId);
    if (String(current?.status ?? "").toUpperCase() !== "CONFIRMED") {
      throw httpError(400, "Only confirmed reservations can receive payment links");
    }
    const currentPaymentStatus = String(current?.paymentStatus ?? "").toUpperCase();
    if (currentPaymentStatus !== "PENDING" && currentPaymentStatus !== "PARTIAL") {
      throw httpError(400, "Only pending or partial reservations can receive payment links");
    }

    const deadlineTz =
      String(current?.paymentDeadlineTz ?? DEFAULT_DEADLINE_TZ).trim() ||
      DEFAULT_DEADLINE_TZ;
    const nowLocal = nowInTimeZoneLocalIso(deadlineTz);
    if (!nowLocal) {
      throw httpError(500, "Unable to resolve local time for payment link deadline");
    }
    const settings = await getRuntimeSettings();
    const isFrequentReservation = await shouldUseFrequentPaymentLinkTtl(current);
    const expiresAtLocal = addMinutesToLocalIso(
      nowLocal,
      resolvePaymentLinkTtlMinutes(settings, isFrequentReservation)
    );
    if (!expiresAtLocal) {
      throw httpError(500, "Unable to compute payment link expiration");
    }
    const existingDeadlineAt = normalizeDeadlineLocalIso(current?.paymentDeadlineAt);
    const existingDeadlineTz =
      String(current?.paymentDeadlineTz ?? deadlineTz).trim() || deadlineTz;
    const fallbackTz = resolveDefaultPaymentDeadlineTz(settings);
    const fallbackDeadlineDate = addDaysToIsoDate(normalizedEventDate, 1);
    const fallbackHour = resolveDefaultPaymentDeadlineHour(settings);
    const fallbackMinute = resolveDefaultPaymentDeadlineMinute(settings);
    const fallbackDeadlineAt = `${fallbackDeadlineDate}T${String(fallbackHour).padStart(2, "0")}:${String(fallbackMinute).padStart(2, "0")}:00`;

    const reservationDeadlineAt = existingDeadlineAt || fallbackDeadlineAt;
    const reservationDeadlineTz = existingDeadlineAt ? existingDeadlineTz : fallbackTz;

    let effectiveDeadlineAt = expiresAtLocal;
    let effectiveDeadlineTz = deadlineTz;
    if (currentPaymentStatus === "PARTIAL" || isFrequentReservation) {
      effectiveDeadlineAt = reservationDeadlineAt;
      effectiveDeadlineTz = reservationDeadlineTz;
    }
    const effectiveLinkExpiresAt = isFrequentReservation
      ? reservationDeadlineAt
      : expiresAtLocal;
    const now = nowEpoch();
    const user = String(actor ?? "").trim() || "system";

    const res = await ddb.send(
      new UpdateCommand({
        TableName: RES_TABLE,
        Key: {
          PK: `EVENTDATE#${normalizedEventDate}`,
          SK: `RES#${normalizedReservationId}`,
        },
        ConditionExpression:
          "#status = :confirmed AND (#paymentStatus = :pending OR #paymentStatus = :partial)",
        UpdateExpression:
          "SET #paymentDeadlineAt = :deadlineAt, #paymentDeadlineTz = :deadlineTz, #paymentLinkProvider = :provider, #paymentLinkId = :paymentLinkId, #paymentLinkUrl = :paymentLinkUrl, #paymentLinkStatus = :linkStatus, #paymentLinkCreatedAt = :now, #paymentLinkExpiresAt = :linkExpiresAt, #paymentLinkUpdatedAt = :now, #paymentLinkUpdatedBy = :by, #updatedAt = :now, #updatedBy = :by REMOVE #paymentLinkDeactivatedAt, #paymentLinkDeactivatedBy, #paymentLinkDeactivationReason",
        ExpressionAttributeNames: {
          "#status": "status",
          "#paymentStatus": "paymentStatus",
          "#paymentDeadlineAt": "paymentDeadlineAt",
          "#paymentDeadlineTz": "paymentDeadlineTz",
          "#paymentLinkProvider": "paymentLinkProvider",
          "#paymentLinkId": "paymentLinkId",
          "#paymentLinkUrl": "paymentLinkUrl",
          "#paymentLinkStatus": "paymentLinkStatus",
          "#paymentLinkCreatedAt": "paymentLinkCreatedAt",
          "#paymentLinkExpiresAt": "paymentLinkExpiresAt",
          "#paymentLinkUpdatedAt": "paymentLinkUpdatedAt",
          "#paymentLinkUpdatedBy": "paymentLinkUpdatedBy",
          "#paymentLinkDeactivatedAt": "paymentLinkDeactivatedAt",
          "#paymentLinkDeactivatedBy": "paymentLinkDeactivatedBy",
          "#paymentLinkDeactivationReason": "paymentLinkDeactivationReason",
          "#updatedAt": "updatedAt",
          "#updatedBy": "updatedBy",
        },
        ExpressionAttributeValues: {
          ":confirmed": "CONFIRMED",
          ":pending": "PENDING",
          ":partial": "PARTIAL",
          ":deadlineAt": effectiveDeadlineAt,
          ":deadlineTz": effectiveDeadlineTz,
          ":provider": "square",
          ":paymentLinkId": normalizedPaymentLinkId,
          ":paymentLinkUrl": normalizedPaymentLinkUrl,
          ":linkStatus": "ACTIVE",
          ":linkExpiresAt": effectiveLinkExpiresAt,
          ":now": now,
          ":by": user,
        },
        ReturnValues: "ALL_NEW",
      })
    );

    await appendReservationHistory({
      eventDate: normalizedEventDate,
      reservationId: normalizedReservationId,
      eventType: "PAYMENT_LINK_ISSUED",
      actor: user,
      source: "staff",
      tableId: String(res?.Attributes?.tableId ?? current?.tableId ?? "").trim() || null,
      customerName:
        String(res?.Attributes?.customerName ?? current?.customerName ?? "").trim() || null,
      details: {
        paymentLinkId: normalizedPaymentLinkId,
        paymentLinkExpiresAt: effectiveLinkExpiresAt,
      },
      at: now,
    });

    return res.Attributes ?? null;
  }

  async function setReservationCashAppLinkSession({
    eventDate,
    reservationId,
    tokenHash,
    amount,
    expiresAt,
    actor,
  }) {
    requiredEnv("RES_TABLE", RES_TABLE);
    const normalizedEventDate = String(eventDate ?? "").trim();
    const normalizedReservationId = String(reservationId ?? "").trim();
    const normalizedTokenHash = String(tokenHash ?? "").trim().toLowerCase();
    const normalizedAmount = roundMoney(amount);
    const normalizedExpiresAt = Number(expiresAt ?? 0);
    const user = String(actor ?? "").trim() || "system";

    if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedEventDate)) {
      throw httpError(400, "eventDate must be YYYY-MM-DD");
    }
    if (!normalizedReservationId) {
      throw httpError(400, "reservationId is required");
    }
    if (!/^[a-f0-9]{64}$/.test(normalizedTokenHash)) {
      throw httpError(400, "tokenHash must be a SHA-256 hex string");
    }
    if (!Number.isFinite(normalizedAmount) || normalizedAmount <= 0) {
      throw httpError(400, "amount must be > 0");
    }
    if (!Number.isFinite(normalizedExpiresAt) || normalizedExpiresAt <= nowEpoch()) {
      throw httpError(400, "expiresAt must be a future epoch value");
    }

    const current = await getReservationById(normalizedEventDate, normalizedReservationId);
    if (String(current?.status ?? "").toUpperCase() !== "CONFIRMED") {
      throw httpError(400, "Only confirmed reservations can receive Cash App links");
    }
    const currentPaymentStatus = String(current?.paymentStatus ?? "").toUpperCase();
    if (currentPaymentStatus !== "PENDING" && currentPaymentStatus !== "PARTIAL") {
      throw httpError(
        400,
        "Only pending or partial reservations can receive Cash App links"
      );
    }

    const amountDue = Number(current?.amountDue ?? 0);
    const paid = Number(current?.depositAmount ?? 0);
    const remainingAmount = Math.max(0, roundMoney(amountDue - paid));
    if (remainingAmount <= 0) {
      throw httpError(400, "Reservation is already fully paid");
    }
    if (normalizedAmount > remainingAmount) {
      throw httpError(400, "amount cannot exceed remaining balance");
    }

    const settings = await getRuntimeSettings();
    const deadlineTz =
      String(current?.paymentDeadlineTz ?? DEFAULT_DEADLINE_TZ).trim() ||
      DEFAULT_DEADLINE_TZ;
    const nowLocal = nowInTimeZoneLocalIso(deadlineTz);
    if (!nowLocal) {
      throw httpError(500, "Unable to resolve local time for payment link deadline");
    }
    const secondsUntilExpiry = Math.max(1, Math.ceil(normalizedExpiresAt - nowEpoch()));
    const minutesUntilExpiry = Math.max(1, Math.ceil(secondsUntilExpiry / 60));
    const expiresAtLocal = addMinutesToLocalIso(nowLocal, minutesUntilExpiry);
    if (!expiresAtLocal) {
      throw httpError(500, "Unable to calculate payment deadline for Cash App link");
    }
    const isFrequentReservation = await shouldUseFrequentPaymentLinkTtl(current);
    const existingDeadlineAt = normalizeDeadlineLocalIso(current?.paymentDeadlineAt);
    const existingDeadlineTz =
      String(current?.paymentDeadlineTz ?? deadlineTz).trim() || deadlineTz;
    const fallbackTz = resolveDefaultPaymentDeadlineTz(settings);
    const fallbackDeadlineDate = addDaysToIsoDate(normalizedEventDate, 1);
    const fallbackHour = resolveDefaultPaymentDeadlineHour(settings);
    const fallbackMinute = resolveDefaultPaymentDeadlineMinute(settings);
    const fallbackDeadlineAt = `${fallbackDeadlineDate}T${String(fallbackHour).padStart(2, "0")}:${String(fallbackMinute).padStart(2, "0")}:00`;

    const reservationDeadlineAt = existingDeadlineAt || fallbackDeadlineAt;
    const reservationDeadlineTz = existingDeadlineAt ? existingDeadlineTz : fallbackTz;

    let effectiveDeadlineAt = expiresAtLocal;
    let effectiveDeadlineTz = deadlineTz;
    if (currentPaymentStatus === "PARTIAL" || isFrequentReservation) {
      effectiveDeadlineAt = reservationDeadlineAt;
      effectiveDeadlineTz = reservationDeadlineTz;
    }

    let effectiveCashAppLinkExpiresAt = normalizedExpiresAt;
    if (isFrequentReservation) {
      const deadlineEpoch = localIsoToEpochSeconds(
        reservationDeadlineAt,
        reservationDeadlineTz
      );
      if (Number.isFinite(deadlineEpoch) && deadlineEpoch > nowEpoch()) {
        effectiveCashAppLinkExpiresAt = deadlineEpoch;
      }
    }

    const now = nowEpoch();
    const res = await ddb.send(
      new UpdateCommand({
        TableName: RES_TABLE,
        Key: {
          PK: `EVENTDATE#${normalizedEventDate}`,
          SK: `RES#${normalizedReservationId}`,
        },
        ConditionExpression:
          "#status = :confirmed AND (#paymentStatus = :pending OR #paymentStatus = :partial)",
        UpdateExpression:
          "SET #paymentDeadlineAt = :deadlineAt, #paymentDeadlineTz = :deadlineTz, #cashAppLinkStatus = :active, #cashAppLinkTokenHash = :tokenHash, #cashAppLinkAmount = :amount, #cashAppLinkExpiresAt = :expiresAt, #cashAppLinkCreatedAt = :now, #cashAppLinkCreatedBy = :by, #updatedAt = :now, #updatedBy = :by REMOVE #cashAppLinkUsedAt, #cashAppLinkUsedBy",
        ExpressionAttributeNames: {
          "#status": "status",
          "#paymentStatus": "paymentStatus",
          "#paymentDeadlineAt": "paymentDeadlineAt",
          "#paymentDeadlineTz": "paymentDeadlineTz",
          "#cashAppLinkStatus": "cashAppLinkStatus",
          "#cashAppLinkTokenHash": "cashAppLinkTokenHash",
          "#cashAppLinkAmount": "cashAppLinkAmount",
          "#cashAppLinkExpiresAt": "cashAppLinkExpiresAt",
          "#cashAppLinkCreatedAt": "cashAppLinkCreatedAt",
          "#cashAppLinkCreatedBy": "cashAppLinkCreatedBy",
          "#cashAppLinkUsedAt": "cashAppLinkUsedAt",
          "#cashAppLinkUsedBy": "cashAppLinkUsedBy",
          "#updatedAt": "updatedAt",
          "#updatedBy": "updatedBy",
        },
        ExpressionAttributeValues: {
          ":confirmed": "CONFIRMED",
          ":pending": "PENDING",
          ":partial": "PARTIAL",
          ":deadlineAt": effectiveDeadlineAt,
          ":deadlineTz": effectiveDeadlineTz,
          ":active": "ACTIVE",
          ":tokenHash": normalizedTokenHash,
          ":amount": normalizedAmount,
          ":expiresAt": effectiveCashAppLinkExpiresAt,
          ":now": now,
          ":by": user,
        },
        ReturnValues: "ALL_NEW",
      })
    );

    await appendReservationHistory({
      eventDate: normalizedEventDate,
      reservationId: normalizedReservationId,
      eventType: "CASH_APP_LINK_ISSUED",
      actor: user,
      source: "staff",
      tableId: String(res?.Attributes?.tableId ?? current?.tableId ?? "").trim() || null,
      customerName:
        String(res?.Attributes?.customerName ?? current?.customerName ?? "").trim() || null,
      details: {
        amount: normalizedAmount,
        expiresAt: effectiveCashAppLinkExpiresAt,
        paymentDeadlineAt: effectiveDeadlineAt,
        paymentDeadlineTz: effectiveDeadlineTz,
      },
      at: now,
    });

    return res.Attributes ?? null;
  }

  async function revokeReservationCashAppLinkSession({
    eventDate,
    reservationId,
    actor,
  }) {
    requiredEnv("RES_TABLE", RES_TABLE);
    const normalizedEventDate = String(eventDate ?? "").trim();
    const normalizedReservationId = String(reservationId ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedEventDate)) return null;
    if (!normalizedReservationId) return null;

    const now = nowEpoch();
    const user = String(actor ?? "").trim() || "system";
    try {
      const res = await ddb.send(
        new UpdateCommand({
          TableName: RES_TABLE,
          Key: {
            PK: `EVENTDATE#${normalizedEventDate}`,
            SK: `RES#${normalizedReservationId}`,
          },
          // Only flip ACTIVE → REVOKED. If it's already USED/REVOKED or
          // never existed, leave it alone.
          ConditionExpression: "#cashAppLinkStatus = :active",
          UpdateExpression:
            "SET #cashAppLinkStatus = :revoked, #cashAppLinkRevokedAt = :now, #cashAppLinkRevokedBy = :by, #updatedAt = :now, #updatedBy = :by REMOVE #cashAppLinkTokenHash",
          ExpressionAttributeNames: {
            "#cashAppLinkStatus": "cashAppLinkStatus",
            "#cashAppLinkRevokedAt": "cashAppLinkRevokedAt",
            "#cashAppLinkRevokedBy": "cashAppLinkRevokedBy",
            "#cashAppLinkTokenHash": "cashAppLinkTokenHash",
            "#updatedAt": "updatedAt",
            "#updatedBy": "updatedBy",
          },
          ExpressionAttributeValues: {
            ":active": "ACTIVE",
            ":revoked": "REVOKED",
            ":now": now,
            ":by": user,
          },
          ReturnValues: "ALL_NEW",
        })
      );
      return res.Attributes ?? null;
    } catch (err) {
      if (err?.name === "ConditionalCheckFailedException") return null;
      throw err;
    }
  }

  async function markReservationCashAppLinkSessionUsed({
    eventDate,
    reservationId,
    tokenHash,
    actor,
  }) {
    requiredEnv("RES_TABLE", RES_TABLE);
    const normalizedEventDate = String(eventDate ?? "").trim();
    const normalizedReservationId = String(reservationId ?? "").trim();
    const normalizedTokenHash = String(tokenHash ?? "").trim().toLowerCase();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedEventDate) || !normalizedReservationId) {
      return null;
    }
    if (!/^[a-f0-9]{64}$/.test(normalizedTokenHash)) {
      return null;
    }

    const now = nowEpoch();
    const user = String(actor ?? "").trim() || "system";
    try {
      const res = await ddb.send(
        new UpdateCommand({
          TableName: RES_TABLE,
          Key: {
            PK: `EVENTDATE#${normalizedEventDate}`,
            SK: `RES#${normalizedReservationId}`,
          },
          ConditionExpression:
            "#cashAppLinkStatus = :active AND #cashAppLinkTokenHash = :tokenHash",
          UpdateExpression:
            "SET #cashAppLinkStatus = :used, #cashAppLinkUsedAt = :now, #cashAppLinkUsedBy = :by, #updatedAt = :now, #updatedBy = :by REMOVE #cashAppLinkTokenHash",
          ExpressionAttributeNames: {
            "#cashAppLinkStatus": "cashAppLinkStatus",
            "#cashAppLinkTokenHash": "cashAppLinkTokenHash",
            "#cashAppLinkUsedAt": "cashAppLinkUsedAt",
            "#cashAppLinkUsedBy": "cashAppLinkUsedBy",
            "#updatedAt": "updatedAt",
            "#updatedBy": "updatedBy",
          },
          ExpressionAttributeValues: {
            ":active": "ACTIVE",
            ":used": "USED",
            ":tokenHash": normalizedTokenHash,
            ":now": now,
            ":by": user,
          },
          ReturnValues: "ALL_NEW",
        })
      );
      return res.Attributes ?? null;
    } catch (err) {
      if (err?.name === "ConditionalCheckFailedException") return null;
      throw err;
    }
  }

  async function markReservationPaymentLinkInactive({
    eventDate,
    reservationId,
    status,
    actor,
    reason,
  }) {
    requiredEnv("RES_TABLE", RES_TABLE);
    const normalizedEventDate = String(eventDate ?? "").trim();
    const normalizedReservationId = String(reservationId ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedEventDate)) return null;
    if (!normalizedReservationId) return null;
    const normalizedStatus = String(status ?? "").trim().toUpperCase();
    if (!normalizedStatus) return null;
    const now = nowEpoch();
    const user = String(actor ?? "").trim() || "system";
    const normalizedReason = String(reason ?? "").trim();
    const expressionAttributeNames = {
      "#paymentLinkStatus": "paymentLinkStatus",
      "#paymentLinkDeactivatedAt": "paymentLinkDeactivatedAt",
      "#paymentLinkDeactivatedBy": "paymentLinkDeactivatedBy",
      "#paymentLinkUpdatedAt": "paymentLinkUpdatedAt",
      "#paymentLinkUpdatedBy": "paymentLinkUpdatedBy",
      "#paymentLinkDeactivationReason": "paymentLinkDeactivationReason",
      "#paymentLinkUrl": "paymentLinkUrl",
      "#updatedAt": "updatedAt",
      "#updatedBy": "updatedBy",
    };
    const expressionAttributeValues = {
      ":status": normalizedStatus,
      ":now": now,
      ":by": user,
    };
    const setClauses = [
      "#paymentLinkStatus = :status",
      "#paymentLinkDeactivatedAt = :now",
      "#paymentLinkDeactivatedBy = :by",
      "#paymentLinkUpdatedAt = :now",
      "#paymentLinkUpdatedBy = :by",
      "#updatedAt = :now",
      "#updatedBy = :by",
    ];
    const removeClauses = ["#paymentLinkUrl"];
    if (normalizedReason) {
      setClauses.push("#paymentLinkDeactivationReason = :reason");
      expressionAttributeValues[":reason"] = normalizedReason;
    } else {
      removeClauses.push("#paymentLinkDeactivationReason");
    }
    const finalUpdateExpression = `SET ${setClauses.join(", ")} REMOVE ${removeClauses.join(", ")}`;

    try {
      const res = await ddb.send(
        new UpdateCommand({
          TableName: RES_TABLE,
          Key: {
            PK: `EVENTDATE#${normalizedEventDate}`,
            SK: `RES#${normalizedReservationId}`,
          },
          ConditionExpression: "attribute_exists(PK) AND attribute_exists(SK)",
          UpdateExpression: finalUpdateExpression,
          ExpressionAttributeNames: expressionAttributeNames,
          ExpressionAttributeValues: expressionAttributeValues,
          ReturnValues: "ALL_NEW",
        })
      );
      return res.Attributes ?? null;
    } catch (err) {
      if (err?.name === "ConditionalCheckFailedException") return null;
      throw err;
    }
  }

  async function addReservationPayment(reservationId, payload, user) {
    requiredEnv("RES_TABLE", RES_TABLE);
    const runtimeSettings = await getRuntimeSettings();
    const eventDate = String(payload?.eventDate ?? "").trim();
    const amount = roundMoney(payload?.amount ?? 0);
    const method = String(payload?.method ?? "").trim();
    const sourceInput = String(payload?.source ?? "").trim().toLowerCase();
    const note = String(payload?.note ?? "").trim();
    const creditId = String(payload?.creditId ?? "").trim();
    const receiptNumber = String(payload?.receiptNumber ?? "").trim();
    const providerInput =
      payload?.provider && typeof payload.provider === "object"
        ? payload.provider
        : null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) {
      throw httpError(400, "eventDate must be YYYY-MM-DD");
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      throw httpError(400, "amount must be > 0");
    }
    if (!["cash", "square", "cashapp", "credit"].includes(method)) {
      throw httpError(400, "method must be cash | square | cashapp | credit");
    }
    if (receiptNumber.length > 64) {
      throw httpError(400, "receiptNumber must be 64 characters or fewer");
    }
    if (receiptNumber && !/^\d+$/.test(receiptNumber)) {
      throw httpError(400, "receiptNumber must contain digits only");
    }
    if (method === "cash" && resolveCashReceiptNumberRequired(runtimeSettings) && !receiptNumber) {
      throw httpError(400, "receiptNumber is required when method is cash");
    }
    if (method === "credit" && !creditId) {
      throw httpError(400, "creditId is required when method is credit");
    }
    if (providerInput && method !== "square" && method !== "cashapp") {
      throw httpError(400, "provider metadata is only supported when method is square or cashapp");
    }

    const allowedSources = new Set([
      "manual",
      "square-direct",
      "square-webhook",
      "reschedule-credit",
    ]);
    let paymentSource = sourceInput || "";
    if (paymentSource && !allowedSources.has(paymentSource)) {
      throw httpError(
        400,
        "source must be manual | square-direct | square-webhook | reschedule-credit"
      );
    }
    if (!paymentSource) {
      if (method === "square" || method === "cashapp") {
        paymentSource = String(user ?? "").startsWith("system:square-webhook")
          ? "square-webhook"
          : "square-direct";
      } else if (method === "credit") {
        paymentSource = "reschedule-credit";
      } else {
        paymentSource = "manual";
      }
    }

    const key = {
      PK: `EVENTDATE#${eventDate}`,
      SK: `RES#${reservationId}`,
    };
    const current = await ddb.send(
      new GetCommand({
        TableName: RES_TABLE,
        Key: key,
      })
    );
    const item = current.Item;
    if (!item) throw httpError(404, "Reservation not found");
    if (item.status !== "CONFIRMED") {
      throw httpError(400, "Only confirmed reservations can receive payments");
    }
    if (String(item.paymentStatus ?? "").toUpperCase() === "COURTESY") {
      throw httpError(400, "Cannot add payments to courtesy reservations");
    }

    const now = nowEpoch();
    const amountDue = roundMoney(item.amountDue ?? 0);
    const currentPaid = roundMoney(item.depositAmount ?? 0);
    const remainingAmount = roundMoney(Math.max(0, amountDue - currentPaid));
    if (remainingAmount <= 0) {
      throw httpError(400, "Reservation is already fully paid");
    }
    if (amount > remainingAmount) {
      throw httpError(400, "amount cannot exceed remaining balance");
    }

    const providerPaymentIdInput = String(providerInput?.providerPaymentId ?? "").trim();
    const providerIdempotencyKeyInput = String(providerInput?.idempotencyKey ?? "").trim();
    const existingPayments = Array.isArray(item.payments) ? item.payments : [];
    if (
      (method === "square" || method === "cashapp") &&
      providerInput &&
      (providerPaymentIdInput || providerIdempotencyKeyInput)
    ) {
      const duplicateProviderPayment = existingPayments.find((p) => {
        const existingProvider = p?.provider && typeof p.provider === "object" ? p.provider : null;
        if (!existingProvider) return false;
        const existingProviderPaymentId = String(existingProvider?.providerPaymentId ?? "").trim();
        const existingIdempotencyKey = String(existingProvider?.idempotencyKey ?? "").trim();
        return (
          (providerPaymentIdInput && existingProviderPaymentId === providerPaymentIdInput) ||
          (providerIdempotencyKeyInput && existingIdempotencyKey === providerIdempotencyKeyInput)
        );
      });
      if (duplicateProviderPayment) {
        return item;
      }
    }

    const nextPaid = roundMoney(currentPaid + amount);
    const nextStatus = nextPaid >= amountDue ? "PAID" : "PARTIAL";
    const nextDeadline = nextStatus === "PAID" ? null : item.paymentDeadlineAt ?? null;
    const nextDeadlineTz =
      nextStatus === "PAID" ? null : item.paymentDeadlineTz ?? "America/Chicago";
    const payment = {
      paymentId: randomUUID(),
      amount,
      method,
      receiptNumber: method === "cash" ? receiptNumber : null,
      source: paymentSource,
      note: note || null,
      provider:
        providerInput && (method === "square" || method === "cashapp")
          ? {
              provider: "square",
              providerPaymentId: providerPaymentIdInput || null,
              providerStatus: String(providerInput?.providerStatus ?? "").trim() || null,
              receiptUrl: String(providerInput?.receiptUrl ?? "").trim() || null,
              orderId: String(providerInput?.orderId ?? "").trim() || null,
              sourceType: String(providerInput?.sourceType ?? "").trim() || null,
              idempotencyKey: providerIdempotencyKeyInput || null,
              amountMoney:
                providerInput?.amountMoney && typeof providerInput.amountMoney === "object"
                  ? {
                      amount: Number(providerInput.amountMoney.amount ?? 0),
                      currency: String(providerInput.amountMoney.currency ?? "").trim() || null,
                    }
                  : null,
            }
          : null,
      credit:
        method === "credit"
          ? {
              creditId: creditId || null,
            }
          : null,
      createdAt: now,
      createdBy: user,
    };

    let updated = null;
    let creditRemainingAfter = null;
    if (method === "credit") {
      requiredEnv("CLIENTS_TABLE", CLIENTS_TABLE);
      const phone = String(item?.phone ?? "").trim();
      const phoneCountry = String(item?.phoneCountry ?? "US").trim() || "US";
      const phoneKey = normalizePhone(phone, phoneCountry);
      if (!phone || !phoneKey) {
        throw httpError(400, "Reservation must include a valid client phone to apply credit");
      }

      const creditKey = {
        PK: "CLIENT",
        SK: toRescheduleCreditSk(phoneKey, creditId),
      };
      const creditGet = await ddb.send(
        new GetCommand({
          TableName: CLIENTS_TABLE,
          Key: creditKey,
        })
      );
      const credit = creditGet.Item;
      if (!credit) {
        throw httpError(404, "Reschedule credit not found for this client");
      }
      if (String(credit?.entityType ?? "").toUpperCase() !== "RESCHEDULE_CREDIT") {
        throw httpError(409, "Invalid credit record type");
      }
      const creditStatus = String(credit?.status ?? "").trim().toUpperCase();
      if (creditStatus !== "ACTIVE") {
        throw httpError(409, `Credit is not active. Current status: ${creditStatus || "UNKNOWN"}`);
      }
      const creditRemaining = roundMoney(credit?.amountRemaining ?? 0);
      if (creditRemaining <= 0) {
        throw httpError(409, "Credit has no remaining balance");
      }
      if (amount > creditRemaining) {
        throw httpError(400, "amount cannot exceed credit remaining balance");
      }

      const operatingTz = resolveDefaultPaymentDeadlineTz(runtimeSettings);
      const nowLocalIso = nowInTimeZoneLocalIso(operatingTz);
      if (!nowLocalIso) {
        throw httpError(500, "Unable to resolve local time for credit expiration check");
      }
      const todayIso = nowLocalIso.slice(0, 10);
      const creditExpiresAt = String(credit?.expiresAt ?? "").trim();
      if (creditExpiresAt && creditExpiresAt < todayIso) {
        throw httpError(409, `Credit expired on ${creditExpiresAt}`);
      }

      const nextCreditRemaining = roundMoney(Math.max(0, creditRemaining - amount));
      const nextCreditStatus = nextCreditRemaining <= 0 ? "USED" : "ACTIVE";
      creditRemainingAfter = nextCreditRemaining;

      const creditSetClauses = [
        "#amountRemaining = :creditRemaining",
        "#status = :creditStatus",
        "#updatedAt = :now",
        "#updatedBy = :by",
      ];
      let creditUpdateExpression = `SET ${creditSetClauses.join(", ")}`;
      if (nextCreditStatus === "USED") {
        creditUpdateExpression += ", #usedAt = :now, #usedBy = :by";
      } else {
        creditUpdateExpression += " REMOVE #usedAt, #usedBy";
      }

      try {
        await ddb.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Update: {
                  TableName: RES_TABLE,
                  Key: key,
                  // Pin #depositAmount to :currentPaid so concurrent payment
                  // recordings can't both compute nextPaid from the same
                  // stale snapshot and overwrite each other (audit C3).
                  ConditionExpression:
                    "#status = :confirmed AND #depositAmount = :currentPaid",
                  UpdateExpression:
                    "SET #depositAmount = :paid, #paymentStatus = :paymentStatus, #paymentMethod = :paymentMethod, #paymentDeadlineAt = :deadline, #paymentDeadlineTz = :deadlineTz, #updatedAt = :now, #updatedBy = :by, #payments = list_append(if_not_exists(#payments, :empty), :newPayment)",
                  ExpressionAttributeNames: {
                    "#status": "status",
                    "#depositAmount": "depositAmount",
                    "#paymentStatus": "paymentStatus",
                    "#paymentMethod": "paymentMethod",
                    "#paymentDeadlineAt": "paymentDeadlineAt",
                    "#paymentDeadlineTz": "paymentDeadlineTz",
                    "#updatedAt": "updatedAt",
                    "#updatedBy": "updatedBy",
                    "#payments": "payments",
                  },
                  ExpressionAttributeValues: {
                    ":confirmed": "CONFIRMED",
                    ":currentPaid": currentPaid,
                    ":paid": nextPaid,
                    ":paymentStatus": nextStatus,
                    ":paymentMethod": method,
                    ":deadline": nextDeadline,
                    ":deadlineTz": nextDeadlineTz,
                    ":now": now,
                    ":by": user,
                    ":empty": [],
                    ":newPayment": [payment],
                  },
                },
              },
              {
                Update: {
                  TableName: CLIENTS_TABLE,
                  Key: creditKey,
                  ConditionExpression:
                    "#entityType = :creditType AND #status = :creditActive AND #amountRemaining >= :amount AND (attribute_not_exists(#expiresAt) OR #expiresAt >= :today)",
                  UpdateExpression: creditUpdateExpression,
                  ExpressionAttributeNames: {
                    "#entityType": "entityType",
                    "#status": "status",
                    "#amountRemaining": "amountRemaining",
                    "#expiresAt": "expiresAt",
                    "#updatedAt": "updatedAt",
                    "#updatedBy": "updatedBy",
                    "#usedAt": "usedAt",
                    "#usedBy": "usedBy",
                  },
                  ExpressionAttributeValues: {
                    ":creditType": "RESCHEDULE_CREDIT",
                    ":creditActive": "ACTIVE",
                    ":amount": amount,
                    ":today": todayIso,
                    ":creditRemaining": nextCreditRemaining,
                    ":creditStatus": nextCreditStatus,
                    ":now": now,
                    ":by": user,
                  },
                },
              },
            ],
          })
        );
      } catch (err) {
        const message = String(err?.message ?? "");
        if (
          err?.name === "TransactionCanceledException" &&
          message.includes("ConditionalCheckFailed")
        ) {
          throw httpError(
            409,
            "Credit could not be applied due to concurrent update or invalid credit state. Refresh and try again."
          );
        }
        throw err;
      }

      updated = {
        ...item,
        depositAmount: nextPaid,
        paymentStatus: nextStatus,
        paymentMethod: method,
        paymentDeadlineAt: nextDeadline,
        paymentDeadlineTz: nextDeadlineTz,
        updatedAt: now,
        updatedBy: user,
        payments: [...existingPayments, payment],
      };
    } else {
      try {
        const res = await ddb.send(
          new UpdateCommand({
            TableName: RES_TABLE,
            Key: key,
            // Pin #depositAmount to :currentPaid so concurrent payment
            // recordings can't both compute nextPaid from the same stale
            // snapshot and overwrite each other (audit C3). On CCFE the
            // caller can retry — the GET-then-update at the top of this
            // function will refresh currentPaid.
            ConditionExpression:
              "#status = :confirmed AND #depositAmount = :currentPaid",
            UpdateExpression:
              "SET #depositAmount = :paid, #paymentStatus = :paymentStatus, #paymentMethod = :paymentMethod, #paymentDeadlineAt = :deadline, #paymentDeadlineTz = :deadlineTz, #updatedAt = :now, #updatedBy = :by, #payments = list_append(if_not_exists(#payments, :empty), :newPayment)",
            ExpressionAttributeNames: {
              "#status": "status",
              "#depositAmount": "depositAmount",
              "#paymentStatus": "paymentStatus",
              "#paymentMethod": "paymentMethod",
              "#paymentDeadlineAt": "paymentDeadlineAt",
              "#paymentDeadlineTz": "paymentDeadlineTz",
              "#updatedAt": "updatedAt",
              "#updatedBy": "updatedBy",
              "#payments": "payments",
            },
            ExpressionAttributeValues: {
              ":confirmed": "CONFIRMED",
              ":currentPaid": currentPaid,
              ":paid": nextPaid,
              ":paymentStatus": nextStatus,
              ":paymentMethod": method,
              ":deadline": nextDeadline,
              ":deadlineTz": nextDeadlineTz,
              ":now": now,
              ":by": user,
              ":empty": [],
              ":newPayment": [payment],
            },
            ReturnValues: "ALL_NEW",
          })
        );
        updated = res.Attributes ?? null;
      } catch (err) {
        if (err?.name === "ConditionalCheckFailedException") {
          throw httpError(
            409,
            "Reservation changed concurrently — refresh and try again."
          );
        }
        throw err;
      }
    }

    if (updated) {
      await appendReservationHistory({
        eventDate,
        reservationId,
        eventType: "PAYMENT_RECORDED",
        actor: user,
        source: paymentSource,
        tableId: String(updated?.tableId ?? item?.tableId ?? "").trim() || null,
        customerName:
          String(updated?.customerName ?? item?.customerName ?? "").trim() || null,
        at: now,
        details: {
          amount,
          method,
          paymentStatus: nextStatus,
          amountDue,
          paidTotal: nextPaid,
          remainingAmount: Math.max(0, Number(amountDue) - Number(nextPaid)),
          receiptNumber: method === "cash" ? receiptNumber : null,
          note: note || null,
          creditId: method === "credit" ? creditId || null : null,
          creditRemainingAmount:
            method === "credit" ? roundMoney(creditRemainingAfter ?? 0) : null,
          providerPaymentId: providerPaymentIdInput || null,
          providerStatus:
            providerInput && (method === "square" || method === "cashapp")
              ? String(providerInput?.providerStatus ?? "").trim() || null
              : null,
        },
      });
      if (method === "credit") {
        await appendReservationHistory({
          eventDate,
          reservationId,
          eventType: "RESCHEDULE_CREDIT_APPLIED",
          actor: user,
          source: "staff",
          tableId: String(updated?.tableId ?? item?.tableId ?? "").trim() || null,
          customerName:
            String(updated?.customerName ?? item?.customerName ?? "").trim() || null,
          at: now,
          details: {
            creditId: creditId || null,
            amount,
            paymentStatus: nextStatus,
            amountDue,
            paidTotal: nextPaid,
            remainingAmount: Math.max(0, Number(amountDue) - Number(nextPaid)),
            creditRemainingAmount: roundMoney(creditRemainingAfter ?? 0),
          },
        });
      }
    }
    const checkInPass = await tryEnsureCheckInPass(updated, user);
    await trySendCheckInPassSms(updated, checkInPass, user);
    if (!updated) return updated;
    return {
      ...updated,
      checkInPass: checkInPass?.pass ?? null,
    };
  }

  return {
    addReservationPayment,
    setReservationPaymentLinkWindow,
    setReservationCashAppLinkSession,
    revokeReservationCashAppLinkSession,
    markReservationCashAppLinkSessionUsed,
    markReservationPaymentLinkInactive,
  };
}
