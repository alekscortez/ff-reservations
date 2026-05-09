import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  AUTO_RELEASE_REASON,
  DEFAULT_DEADLINE_TZ,
  DEFAULT_RESCHEDULE_CREDIT_TTL_DAYS,
  DEFAULT_AUTO_RELEASE_USER,
  HOLD_EXPIRY_GRACE_SECONDS,
  createReservationsShared,
} from "./services-reservations-shared.mjs";

export function createReservationsHoldsService(deps) {
  const {
    ddb,
    tableNames,
    requiredEnv,
    httpError,
    nowEpoch,
    addDaysToIsoDate,
    randomUUID,
    normalizePhone,
    normalizePhoneE164,
    normalizePhoneCountry,
    detectPhoneCountryFromE164,
    getEventByDate,
    listEvents,
    getDisabledTablesFromFrequent,
    deactivateSquarePaymentLink,
    refundSquarePayment,
    sendPaymentLinkExpiredSms,
  } = deps;
  const { EVENTS_TABLE, HOLDS_TABLE, RES_TABLE, CLIENTS_TABLE } = tableNames;

  // Shared helpers extracted to services-reservations-shared.mjs (pure
  // utilities, settings resolvers, history writes, check-in pass
  // orchestration, read-only DDB queries, domain predicates). The
  // destructure below keeps existing call sites in this file unchanged —
  // every reference like `appendReservationHistory(...)` continues to
  // resolve to the local binding.
  const shared = createReservationsShared(deps);
  const {
    clampNumber,
    roundMoney,
    toTwelveHourLabel,
    toRescheduleCreditSk,
    historySourceFromActor,
    normalizeDeadlineLocalIso,
    nowInTimeZoneLocalIso,
    addMinutesToLocalIso,
    localIsoToEpochSeconds,
    isFrequentAutoReservation,
    isOverdueReservation,
    getRuntimeSettings,
    resolveHoldTtlSeconds,
    resolveDefaultPaymentDeadlineTz,
    resolveDefaultPaymentDeadlineHour,
    resolveDefaultPaymentDeadlineMinute,
    resolveRescheduleCutoffHour,
    resolveRescheduleCutoffMinute,
    resolveCashReceiptNumberRequired,
    resolvePaymentLinkTtlMinutes,
    shouldUseFrequentPaymentLinkTtl,
    appendReservationHistory,
    tryEnsureCheckInPass,
    trySendCheckInPassSms,
    queryReservationsForEventDate,
    getReservationById,
  } = shared;

  async function assertRescheduleCreditAllowed(eventDate) {
    const normalizedEventDate = String(eventDate ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedEventDate)) {
      throw httpError(400, "eventDate must be YYYY-MM-DD");
    }

    const settings = await getRuntimeSettings();
    const operatingTz = resolveDefaultPaymentDeadlineTz(settings);
    const cutoffHour = resolveRescheduleCutoffHour(settings);
    const cutoffMinute = resolveRescheduleCutoffMinute(settings);
    const nowIso = nowInTimeZoneLocalIso(operatingTz);
    if (!nowIso) {
      throw httpError(500, "Unable to resolve local time for reschedule cutoff");
    }
    const cutoffIso = `${normalizedEventDate}T${String(cutoffHour).padStart(2, "0")}:${String(cutoffMinute).padStart(2, "0")}:00`;
    if (nowIso >= cutoffIso) {
      const cutoffLabel = toTwelveHourLabel(cutoffHour, cutoffMinute);
      throw httpError(
        409,
        `Reschedule credit cutoff passed at ${cutoffLabel} (${operatingTz}) for ${normalizedEventDate}`
      );
    }
    return {
      operatingTz,
      cutoffHour,
      cutoffMinute,
    };
  }

  async function buildRescheduleCreditItem({
    reservation,
    eventDate,
    reservationId,
    actor,
    cancelReason,
    cancelAt,
  }) {
    requiredEnv("CLIENTS_TABLE", CLIENTS_TABLE);
    const phone = String(reservation?.phone ?? "").trim();
    const phoneCountryHint = String(reservation?.phoneCountry ?? "US").trim() || "US";
    const phoneKey = normalizePhone(phone, phoneCountryHint);
    if (!phone || !phoneKey) {
      throw httpError(400, "Cannot issue reservation credit without a valid client phone");
    }

    const amount = Number(reservation?.depositAmount ?? 0);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw httpError(400, "Reschedule credit requires a paid amount greater than 0");
    }

    const settings = await getRuntimeSettings();
    const operatingTz = resolveDefaultPaymentDeadlineTz(settings);
    const nowLocalIso = nowInTimeZoneLocalIso(operatingTz);
    if (!nowLocalIso) {
      throw httpError(500, "Unable to resolve local time for reservation credit");
    }
    const issuedDate = String(nowLocalIso).slice(0, 10);
    const expiresAt = addDaysToIsoDate(issuedDate, DEFAULT_RESCHEDULE_CREDIT_TTL_DAYS);

    const creditId = randomUUID();
    const credit = {
      PK: "CLIENT",
      SK: toRescheduleCreditSk(phoneKey, creditId),
      entityType: "RESCHEDULE_CREDIT",
      creditId,
      status: "ACTIVE",
      phone,
      phoneCountry: phoneCountryHint,
      phoneKey,
      customerName: String(reservation?.customerName ?? "").trim() || null,
      sourceReservationId: reservationId,
      sourceEventDate: eventDate,
      amountTotal: Number(amount.toFixed(2)),
      amountRemaining: Number(amount.toFixed(2)),
      issuedAt: cancelAt,
      issuedBy: String(actor ?? "").trim() || "system",
      expiresAt,
      reason: String(cancelReason ?? "").trim() || null,
    };

    return credit;
  }

  async function listTableLocks(eventDate) {
    requiredEnv("HOLDS_TABLE", HOLDS_TABLE);
    const pk = `EVENTDATE#${eventDate}`;
    const res = await ddb.send(
      new QueryCommand({
        TableName: HOLDS_TABLE,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeValues: {
          ":pk": pk,
          ":sk": "TABLE#",
        },
      })
    );
    return res.Items ?? [];
  }

  async function createHold(payload, user) {
    requiredEnv("HOLDS_TABLE", HOLDS_TABLE);
    const eventDate = String(payload?.eventDate ?? "").trim();
    const tableId = String(payload?.tableId ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) {
      throw httpError(400, "eventDate must be YYYY-MM-DD");
    }
    if (!tableId) throw httpError(400, "tableId is required");
    await releaseOverdueReservationsForEventDate(eventDate, DEFAULT_AUTO_RELEASE_USER);
    const eventRecord = await getEventByDate(eventDate);
    if (!eventRecord) throw httpError(404, "Event not found for date");
    const disabledFromFrequent = await getDisabledTablesFromFrequent(eventRecord);
    if (
      disabledFromFrequent.has(tableId) ||
      (eventRecord.disabledTables ?? []).includes(tableId)
    ) {
      throw httpError(409, "Table is disabled for this event");
    }

    const settings = await getRuntimeSettings();
    const holdId = randomUUID();
    const now = nowEpoch();
    const expiresAt = now + resolveHoldTtlSeconds(settings);
    const holdPhoneCountry = normalizePhoneCountry(payload?.phoneCountry ?? "US");
    const holdPhone = normalizePhoneE164(payload?.phone ?? "", holdPhoneCountry);
    const holdPhoneCountryFinal = holdPhone
      ? detectPhoneCountryFromE164(holdPhone) ?? holdPhoneCountry
      : null;
    const item = {
      PK: `EVENTDATE#${eventDate}`,
      SK: `TABLE#${tableId}`,
      lockType: "HOLD",
      holdId,
      expiresAt,
      createdAt: now,
      createdBy: user,
      customerName: payload?.customerName ?? null,
      phone: holdPhone || null,
      phoneCountry: holdPhoneCountryFinal,
    };

    try {
      await ddb.send(
        new PutCommand({
          TableName: HOLDS_TABLE,
          Item: item,
          ConditionExpression:
            "attribute_not_exists(PK) AND attribute_not_exists(SK) OR (lockType = :hold AND expiresAt < :now)",
          ExpressionAttributeValues: {
            ":hold": "HOLD",
            ":now": now,
          },
        })
      );
    } catch (err) {
      if (err?.name === "ConditionalCheckFailedException") {
        throw httpError(409, "Table is already held or reserved");
      }
      throw err;
    }

    return item;
  }

  async function releaseHold(eventDate, tableId) {
    requiredEnv("HOLDS_TABLE", HOLDS_TABLE);
    await ddb.send(
      new DeleteCommand({
        TableName: HOLDS_TABLE,
        Key: { PK: `EVENTDATE#${eventDate}`, SK: `TABLE#${tableId}` },
        ConditionExpression: "lockType = :hold",
        ExpressionAttributeValues: { ":hold": "HOLD" },
      })
    );
  }

  async function listHolds(eventDate) {
    return await listTableLocks(eventDate);
  }

  async function listReservations(eventDate) {
    return await queryReservationsForEventDate(eventDate);
  }

  async function listReservationHistory(eventDate, reservationId) {
    requiredEnv("RES_TABLE", RES_TABLE);
    const normalizedEventDate = String(eventDate ?? "").trim();
    const normalizedReservationId = String(reservationId ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedEventDate)) {
      throw httpError(400, "eventDate must be YYYY-MM-DD");
    }
    if (!normalizedReservationId) {
      throw httpError(400, "reservationId is required");
    }
    const out = await ddb.send(
      new QueryCommand({
        TableName: RES_TABLE,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeValues: {
          ":pk": `EVENTDATE#${normalizedEventDate}`,
          ":sk": `HIST#${normalizedReservationId}#`,
        },
        ScanIndexForward: false,
        Limit: 200,
      })
    );
    return out.Items ?? [];
  }

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

  // Bounded concurrency for the cron sweep. With many active events, the
  // serial loop is O(events) sequential DDB queries — a slow tail event
  // delays the rest. Cap at 5 in flight: enough parallelism to amortize
  // wall-clock without saturating Lambda's concurrent connection budget
  // or starving normal request paths in the same execution.
  const OVERDUE_SWEEP_CONCURRENCY = 5;

  async function releaseOverdueReservationsForAllActiveEvents(user = DEFAULT_AUTO_RELEASE_USER) {
    if (typeof listEvents !== "function") {
      throw httpError(500, "listEvents dependency is not configured");
    }
    const events = await listEvents();
    const candidates = (events ?? [])
      .filter((item) => String(item?.status ?? "").toUpperCase() === "ACTIVE")
      .filter((item) => /^\d{4}-\d{2}-\d{2}$/.test(String(item?.eventDate ?? "")))
      .map((item) => String(item.eventDate));

    let releasedTotal = 0;
    const failures = [];
    for (let i = 0; i < candidates.length; i += OVERDUE_SWEEP_CONCURRENCY) {
      const slice = candidates.slice(i, i + OVERDUE_SWEEP_CONCURRENCY);
      const results = await Promise.all(
        slice.map(async (eventDate) => {
          try {
            const { released } = await releaseOverdueReservationsForEventDate(
              eventDate,
              user
            );
            return { ok: true, eventDate, released };
          } catch (err) {
            return {
              ok: false,
              eventDate,
              message: String(err?.message ?? err ?? ""),
            };
          }
        })
      );
      for (const r of results) {
        if (r.ok) {
          releasedTotal += Number(r.released ?? 0);
        } else {
          failures.push({ eventDate: r.eventDate, message: r.message });
        }
      }
    }
    return {
      eventsScanned: candidates.length,
      released: releasedTotal,
      failures,
    };
  }

  async function releaseOverdueReservationsForEventDate(eventDate, user = DEFAULT_AUTO_RELEASE_USER) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(eventDate ?? "").trim())) {
      throw httpError(400, "eventDate must be YYYY-MM-DD");
    }
    const reservations = await queryReservationsForEventDate(eventDate);
    let released = 0;
    for (const reservation of reservations) {
      if (!isOverdueReservation(reservation)) continue;
      const reservationId = String(reservation?.reservationId ?? "").trim();
      const tableId = String(reservation?.tableId ?? "").trim();
      if (!reservationId || !tableId) continue;
      try {
        await cancelReservation(eventDate, reservationId, tableId, user, AUTO_RELEASE_REASON);
        released += 1;
      } catch (err) {
        if (err?.name === "ConditionalCheckFailedException") {
          continue;
        }
        throw err;
      }
    }
    return { released };
  }

  async function markFrequentTableReleasedForEvent(eventDate, tableId, user) {
    requiredEnv("EVENTS_TABLE", EVENTS_TABLE);
    const normalizedEventDate = String(eventDate ?? "").trim();
    const normalizedTableId = String(tableId ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedEventDate)) return;
    if (!normalizedTableId) return;

    const eventRecord = await getEventByDate(normalizedEventDate);
    const eventId = String(eventRecord?.eventId ?? "").trim();
    if (!eventId) return;

    const alreadyReleased = Array.isArray(eventRecord?.frequentReleasedTables)
      ? eventRecord.frequentReleasedTables.includes(normalizedTableId)
      : false;
    if (alreadyReleased) return;

    try {
      await ddb.send(
        new UpdateCommand({
          TableName: EVENTS_TABLE,
          Key: { PK: "EVENT", SK: `EVENT#${eventId}` },
          UpdateExpression:
            "SET #frequentReleasedTables = list_append(if_not_exists(#frequentReleasedTables, :empty), :tableId), #updatedAt = :now, #updatedBy = :by",
          ExpressionAttributeNames: {
            "#frequentReleasedTables": "frequentReleasedTables",
            "#updatedAt": "updatedAt",
            "#updatedBy": "updatedBy",
          },
          ExpressionAttributeValues: {
            ":empty": [],
            ":tableId": [normalizedTableId],
            ":now": nowEpoch(),
            ":by": user ?? DEFAULT_AUTO_RELEASE_USER,
          },
        })
      );
    } catch (err) {
      console.warn("mark_frequent_table_released_failed", {
        eventDate: normalizedEventDate,
        eventId,
        tableId: normalizedTableId,
        message: String(err?.message ?? err ?? ""),
      });
    }
  }

  async function cancelReservation(eventDate, reservationId, tableId, user, reason, options = {}) {
    requiredEnv("RES_TABLE", RES_TABLE);
    requiredEnv("HOLDS_TABLE", HOLDS_TABLE);

    const pk = `EVENTDATE#${eventDate}`;
    const sk = `RES#${reservationId}`;
    const cancelReason = String(reason ?? "").trim();
    const resolutionType = String(options?.resolutionType ?? "CANCEL_NO_REFUND")
      .trim()
      .toUpperCase();
    if (!["CANCEL_NO_REFUND", "RESCHEDULE_CREDIT", "REFUND"].includes(resolutionType)) {
      throw httpError(
        400,
        "resolutionType must be CANCEL_NO_REFUND | RESCHEDULE_CREDIT | REFUND"
      );
    }
    if (!cancelReason) {
      throw httpError(400, "cancelReason is required");
    }
    if (resolutionType === "REFUND" && typeof refundSquarePayment !== "function") {
      throw httpError(501, "Refund workflow requires Square refund service to be configured");
    }
    if (resolutionType === "RESCHEDULE_CREDIT") {
      await assertRescheduleCreditAllowed(eventDate);
    }

    const current = await getReservationById(eventDate, reservationId);
    if (!current) {
      throw httpError(404, "Reservation not found");
    }
    const currentStatus = String(current?.status ?? "").trim().toUpperCase();
    if (currentStatus !== "CONFIRMED") {
      throw httpError(
        409,
        `Reservation must be CONFIRMED to cancel. Current status: ${currentStatus || "UNKNOWN"}`
      );
    }

    const cancelAt = nowEpoch();
    let issuedCredit = null;
    let cancelled = null;

    if (resolutionType === "RESCHEDULE_CREDIT") {
      issuedCredit = await buildRescheduleCreditItem({
        reservation: current,
        eventDate,
        reservationId,
        actor: user,
        cancelReason,
        cancelAt,
      });

      try {
        await ddb.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Update: {
                  TableName: RES_TABLE,
                  Key: { PK: pk, SK: sk },
                  UpdateExpression:
                    "SET #status = :cancelled, #updatedAt = :now, #updatedBy = :by, #cancelReason = :reason, #cancelledAt = :now, #cancelledBy = :by, #creditId = :creditId, #creditStatus = :creditStatus, #creditAmount = :creditAmount, #creditRemainingAmount = :creditRemainingAmount, #creditExpiresAt = :creditExpiresAt, #creditIssuedAt = :creditIssuedAt, #creditIssuedBy = :creditIssuedBy",
                  ExpressionAttributeNames: {
                    "#status": "status",
                    "#updatedAt": "updatedAt",
                    "#updatedBy": "updatedBy",
                    "#cancelReason": "cancelReason",
                    "#cancelledAt": "cancelledAt",
                    "#cancelledBy": "cancelledBy",
                    "#creditId": "creditId",
                    "#creditStatus": "creditStatus",
                    "#creditAmount": "creditAmount",
                    "#creditRemainingAmount": "creditRemainingAmount",
                    "#creditExpiresAt": "creditExpiresAt",
                    "#creditIssuedAt": "creditIssuedAt",
                    "#creditIssuedBy": "creditIssuedBy",
                  },
                  ExpressionAttributeValues: {
                    ":cancelled": "CANCELLED",
                    ":confirmed": "CONFIRMED",
                    ":now": cancelAt,
                    ":by": user,
                    ":reason": cancelReason,
                    ":creditId": issuedCredit.creditId,
                    ":creditStatus": "ISSUED",
                    ":creditAmount": issuedCredit.amountTotal,
                    ":creditRemainingAmount": issuedCredit.amountRemaining,
                    ":creditExpiresAt": issuedCredit.expiresAt,
                    ":creditIssuedAt": issuedCredit.issuedAt,
                    ":creditIssuedBy": issuedCredit.issuedBy,
                  },
                  ConditionExpression: "#status = :confirmed",
                },
              },
              {
                Put: {
                  TableName: CLIENTS_TABLE,
                  Item: issuedCredit,
                  ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
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
            "Reservation changed and is no longer CONFIRMED. Refresh and try again."
          );
        }
        throw err;
      }

      cancelled = {
        ...current,
        status: "CANCELLED",
        updatedAt: cancelAt,
        updatedBy: user,
        cancelReason,
        cancelledAt: cancelAt,
        cancelledBy: user,
        creditId: issuedCredit.creditId,
        creditStatus: "ISSUED",
        creditAmount: issuedCredit.amountTotal,
        creditRemainingAmount: issuedCredit.amountRemaining,
        creditExpiresAt: issuedCredit.expiresAt,
        creditIssuedAt: issuedCredit.issuedAt,
        creditIssuedBy: issuedCredit.issuedBy,
      };
    } else if (resolutionType === "REFUND") {
      const existingPayments = Array.isArray(current?.payments) ? current.payments : [];
      const refundCandidates = existingPayments
        .map((p, idx) => ({ p, idx }))
        .filter(({ p }) => {
          const method = String(p?.method ?? "").trim().toLowerCase();
          if (method !== "square" && method !== "cashapp") return false;
          const providerPaymentId = String(p?.provider?.providerPaymentId ?? "").trim();
          if (!providerPaymentId) return false;
          const amt = Number(p?.amount ?? 0);
          if (!Number.isFinite(amt) || amt <= 0) return false;
          // skip already-refunded payments
          if (p?.refund && String(p.refund?.refundId ?? "").trim()) return false;
          return true;
        });

      if (refundCandidates.length === 0) {
        throw httpError(
          400,
          "No refundable Square or Cash App payments found on this reservation. Use CANCEL_NO_REFUND or RESCHEDULE_CREDIT instead."
        );
      }

      const refundResults = [];
      let totalRefundedAmount = 0;
      let allSucceeded = true;

      for (const { p, idx } of refundCandidates) {
        const providerPaymentId = String(p.provider.providerPaymentId).trim();
        const refundAmount = roundMoney(p.amount);
        const paymentLocalId = String(p?.paymentId ?? `idx-${idx}`).trim();
        const idemKey = `refund-${reservationId}-${paymentLocalId}`;
        try {
          const result = await refundSquarePayment({
            paymentId: providerPaymentId,
            amount: refundAmount,
            idempotencyKey: idemKey,
            reason: cancelReason.slice(0, 192),
          });
          const status = String(result?.refund?.status ?? "").toUpperCase();
          refundResults.push({
            paymentLocalId,
            providerPaymentId,
            amount: refundAmount,
            method: String(p.method).toLowerCase(),
            refundId: String(result?.refund?.id ?? "").trim() || null,
            refundStatus: status || null,
            idempotencyKey: idemKey,
            success: true,
          });
          totalRefundedAmount = roundMoney(totalRefundedAmount + refundAmount);
        } catch (err) {
          allSucceeded = false;
          refundResults.push({
            paymentLocalId,
            providerPaymentId,
            amount: refundAmount,
            method: String(p.method).toLowerCase(),
            success: false,
            errorMessage: String(err?.message ?? err ?? "Refund failed").slice(0, 256),
          });
          console.warn("refund_payment_failed", {
            reservationId,
            providerPaymentId,
            message: String(err?.message ?? err ?? ""),
          });
        }
      }

      if (!allSucceeded) {
        await appendReservationHistory({
          eventDate,
          reservationId,
          eventType: "REFUND_FAILED",
          actor: user,
          source: historySourceFromActor(user),
          tableId,
          customerName: String(current?.customerName ?? "").trim() || null,
          details: {
            cancelReason,
            totalRefundedAmount,
            refunds: refundResults,
          },
          at: cancelAt,
        });
        const failures = refundResults.filter((r) => !r.success);
        const firstFailure = failures[0]?.errorMessage ?? "Unknown refund failure";
        throw httpError(
          502,
          `Refund partially failed for ${failures.length} of ${refundResults.length} payment(s): ${firstFailure}. Manual reconciliation may be required.`
        );
      }

      try {
        const cancelResult = await ddb.send(
          new UpdateCommand({
            TableName: RES_TABLE,
            Key: { PK: pk, SK: sk },
            UpdateExpression:
              "SET #status = :cancelled, #paymentStatus = :refunded, #updatedAt = :now, #updatedBy = :by, #cancelReason = :reason, #cancelledAt = :now, #cancelledBy = :by, #refundedAmount = :refundedAmount, #refundedAt = :now, #refundedBy = :by, #refunds = :refunds",
            ExpressionAttributeNames: {
              "#status": "status",
              "#paymentStatus": "paymentStatus",
              "#updatedAt": "updatedAt",
              "#updatedBy": "updatedBy",
              "#cancelReason": "cancelReason",
              "#cancelledAt": "cancelledAt",
              "#cancelledBy": "cancelledBy",
              "#refundedAmount": "refundedAmount",
              "#refundedAt": "refundedAt",
              "#refundedBy": "refundedBy",
              "#refunds": "refunds",
            },
            ExpressionAttributeValues: {
              ":cancelled": "CANCELLED",
              ":confirmed": "CONFIRMED",
              ":refunded": "REFUNDED",
              ":now": cancelAt,
              ":by": user,
              ":reason": cancelReason,
              ":refundedAmount": totalRefundedAmount,
              ":refunds": refundResults,
            },
            ConditionExpression: "#status = :confirmed",
            ReturnValues: "ALL_NEW",
          })
        );
        cancelled = cancelResult?.Attributes ?? null;
      } catch (err) {
        if (err?.name === "ConditionalCheckFailedException") {
          // Refunds already issued at Square but reservation status changed
          // mid-flight (e.g. raced with another cancellation). Surface loudly.
          await appendReservationHistory({
            eventDate,
            reservationId,
            eventType: "REFUND_ORPHANED",
            actor: user,
            source: historySourceFromActor(user),
            tableId,
            customerName: String(current?.customerName ?? "").trim() || null,
            details: {
              cancelReason,
              totalRefundedAmount,
              refunds: refundResults,
              errorMessage:
                "Reservation status changed between refund and cancellation update. Refunds were issued at Square but reservation may not show as REFUNDED.",
            },
            at: cancelAt,
          });
          // Emit a stable log marker so the CloudWatch metric filter
          // ff-res-refund-orphaned can count occurrences and alarm via
          // RefundOrphanedCount in FFReservations/Payments.
          console.error("refund_orphaned", {
            reservationId,
            eventDate,
            tableId,
            cancelReason,
            totalRefundedAmount,
            refundCount: refundResults.length,
          });
          throw httpError(
            409,
            "Refund issued at Square but reservation status changed concurrently. Manual reconciliation required."
          );
        }
        throw err;
      }

      await appendReservationHistory({
        eventDate,
        reservationId,
        eventType: "REFUND_ISSUED",
        actor: user,
        source: historySourceFromActor(user),
        tableId,
        customerName: String(current?.customerName ?? "").trim() || null,
        details: {
          cancelReason,
          totalRefundedAmount,
          refunds: refundResults,
        },
        at: cancelAt,
      });
    } else {
      const cancelResult = await ddb.send(
        new UpdateCommand({
          TableName: RES_TABLE,
          Key: { PK: pk, SK: sk },
          UpdateExpression:
            "SET #status = :cancelled, #updatedAt = :now, #updatedBy = :by, #cancelReason = :reason, #cancelledAt = :now, #cancelledBy = :by",
          ExpressionAttributeNames: {
            "#status": "status",
            "#updatedAt": "updatedAt",
            "#updatedBy": "updatedBy",
            "#cancelReason": "cancelReason",
            "#cancelledAt": "cancelledAt",
            "#cancelledBy": "cancelledBy",
          },
          ExpressionAttributeValues: {
            ":cancelled": "CANCELLED",
            ":confirmed": "CONFIRMED",
            ":now": cancelAt,
            ":by": user,
            ":reason": cancelReason,
          },
          ConditionExpression: "#status = :confirmed",
          ReturnValues: "ALL_NEW",
        })
      );
      cancelled = cancelResult?.Attributes ?? null;
    }

    try {
      await ddb.send(
        new DeleteCommand({
          TableName: HOLDS_TABLE,
          Key: { PK: pk, SK: `TABLE#${tableId}` },
          ConditionExpression: "lockType = :reserved AND reservationId = :rid",
          ExpressionAttributeValues: {
            ":reserved": "RESERVED",
            ":rid": reservationId,
          },
        })
      );
    } catch (err) {
      if (err?.name !== "ConditionalCheckFailedException") {
        throw err;
      }
    }

    const paymentLinkId = String(cancelled?.paymentLinkId ?? "").trim();
    const shouldNotifyLinkExpired =
      cancelReason === AUTO_RELEASE_REASON &&
      paymentLinkId &&
      typeof sendPaymentLinkExpiredSms === "function";

    // Revoke any active Cash App self-pay session so a stale link can't go
    // through after the reservation is cancelled. The /cashapp/session/charge
    // route also re-checks reservation status, but flipping the link state
    // here keeps audits/reports consistent and the public pay page honest.
    const cashAppLinkStatus = String(cancelled?.cashAppLinkStatus ?? "")
      .trim()
      .toUpperCase();
    if (cashAppLinkStatus === "ACTIVE") {
      try {
        await revokeReservationCashAppLinkSession({
          eventDate,
          reservationId,
          actor: user,
        });
      } catch (err) {
        console.warn("cash_app_link_revoke_failed", {
          reservationId,
          eventDate,
          message: String(err?.message ?? err ?? ""),
        });
      }
    }

    if (paymentLinkId && typeof deactivateSquarePaymentLink === "function") {
      let inactiveStatus = "DEACTIVATED";
      let inactiveReason = cancelReason;
      try {
        const deactivation = await deactivateSquarePaymentLink({ paymentLinkId });
        if (deactivation?.alreadyGone) {
          inactiveStatus = "NOT_FOUND";
          inactiveReason = `${cancelReason} (payment link already unavailable)`;
        }
      } catch (err) {
        inactiveStatus = "DEACTIVATION_FAILED";
        inactiveReason = `${cancelReason} (payment link deactivation failed: ${
          String(err?.message ?? err ?? "unknown error")
        })`;
        console.warn("payment_link_deactivation_failed", {
          reservationId,
          eventDate,
          paymentLinkId,
          message: String(err?.message ?? err ?? ""),
        });
      }
      await markReservationPaymentLinkInactive({
        eventDate,
        reservationId,
        status: inactiveStatus,
        actor: user,
        reason: inactiveReason,
      });
    }

    if (shouldNotifyLinkExpired) {
      try {
        const sms = await sendPaymentLinkExpiredSms({
          phone: cancelled?.phone,
          customerName: cancelled?.customerName,
          tableId: cancelled?.tableId,
        });
        await appendReservationHistory({
          eventDate,
          reservationId,
          eventType: "PAYMENT_LINK_EXPIRED_SMS_SENT",
          actor: user,
          source: String(user ?? "").startsWith("system:") ? "system" : "staff",
          tableId: String(cancelled?.tableId ?? tableId ?? "").trim() || null,
          customerName: String(cancelled?.customerName ?? "").trim() || null,
          details: {
            to: String(sms?.to ?? "").trim() || null,
            messageId: String(sms?.messageId ?? "").trim() || null,
            provider: String(sms?.provider ?? "").trim() || null,
            paymentLinkId: paymentLinkId || null,
          },
          at: cancelAt,
        });
      } catch (err) {
        console.warn("payment_link_expired_sms_failed", {
          reservationId,
          eventDate,
          paymentLinkId: paymentLinkId || null,
          message: String(err?.message ?? err ?? ""),
        });
        await appendReservationHistory({
          eventDate,
          reservationId,
          eventType: "PAYMENT_LINK_EXPIRED_SMS_FAILED",
          actor: user,
          source: String(user ?? "").startsWith("system:") ? "system" : "staff",
          tableId: String(cancelled?.tableId ?? tableId ?? "").trim() || null,
          customerName: String(cancelled?.customerName ?? "").trim() || null,
          details: {
            to: String(cancelled?.phone ?? "").trim() || null,
            paymentLinkId: paymentLinkId || null,
            errorMessage: String(err?.message ?? "Failed to send expired payment link SMS"),
          },
          at: cancelAt,
        });
      }
    }

    if (
      cancelReason === AUTO_RELEASE_REASON &&
      isFrequentAutoReservation(current)
    ) {
      await markFrequentTableReleasedForEvent(eventDate, tableId, user);
    }

    if (resolutionType === "RESCHEDULE_CREDIT" && issuedCredit) {
      await appendReservationHistory({
        eventDate,
        reservationId,
        eventType: "RESCHEDULE_CREDIT_ISSUED",
        actor: user,
        source: String(user ?? "").startsWith("system:") ? "system" : "staff",
        tableId: String(cancelled?.tableId ?? tableId ?? "").trim() || null,
        customerName: String(cancelled?.customerName ?? "").trim() || null,
        details: {
          creditId: issuedCredit.creditId,
          amount: issuedCredit.amountTotal,
          remainingAmount: issuedCredit.amountRemaining,
          expiresAt: issuedCredit.expiresAt,
          phone: issuedCredit.phone,
        },
        at: cancelAt,
      });
    }

    await appendReservationHistory({
      eventDate,
      reservationId,
      eventType: "RESERVATION_CANCELLED",
      actor: user,
      source: String(user ?? "").startsWith("system:") ? "system" : "staff",
      tableId,
      details: {
        reason: cancelReason,
        resolutionType,
        creditId: issuedCredit?.creditId ?? null,
        creditAmount: issuedCredit?.amountTotal ?? null,
        creditExpiresAt: issuedCredit?.expiresAt ?? null,
      },
      at: cancelAt,
    });
  }

  async function createReservation(payload, user, isAdmin) {
    requiredEnv("HOLDS_TABLE", HOLDS_TABLE);
    requiredEnv("RES_TABLE", RES_TABLE);

    const settings = await getRuntimeSettings();
    const defaultPaymentDeadlineTz = resolveDefaultPaymentDeadlineTz(settings);
    const defaultPaymentDeadlineHour = resolveDefaultPaymentDeadlineHour(settings);
    const defaultPaymentDeadlineMinute = resolveDefaultPaymentDeadlineMinute(settings);

    const eventDate = String(payload?.eventDate ?? "").trim();
    const tableId = String(payload?.tableId ?? "").trim();
    const holdId = String(payload?.holdId ?? "").trim();
    const customerName = String(payload?.customerName ?? "").trim();
    const phoneRaw = String(payload?.phone ?? "").trim();
    const phoneCountry = normalizePhoneCountry(payload?.phoneCountry ?? "US");
    const phone = normalizePhoneE164(phoneRaw, phoneCountry);
    const phoneKey = normalizePhone(phone, phoneCountry);
    const normalizedPhoneCountry =
      detectPhoneCountryFromE164(phone) ?? phoneCountry;
    const paymentMethodInput = String(payload?.paymentMethod ?? "").trim();
    const depositAmount = Number(payload?.depositAmount ?? 0);
    const amountDueInput = payload?.amountDue !== undefined ? Number(payload?.amountDue) : null;
    const paymentStatusInput = payload?.paymentStatus
      ? String(payload?.paymentStatus).toUpperCase()
      : "";
    const paymentDeadlineAt = String(payload?.paymentDeadlineAt ?? "").trim();
    const paymentDeadlineTzInput = String(
      payload?.paymentDeadlineTz ?? defaultPaymentDeadlineTz
    ).trim();
    const paymentDeadlineTz = paymentDeadlineTzInput || defaultPaymentDeadlineTz;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) {
      throw httpError(400, "eventDate must be YYYY-MM-DD");
    }
    if (!tableId) throw httpError(400, "tableId is required");
    if (!holdId) throw httpError(400, "holdId is required");
    if (!customerName) throw httpError(400, "customerName is required");
    if (!phone || !phoneKey) {
      throw httpError(400, "phone must be a valid US or MX number");
    }
    if (!Number.isFinite(depositAmount) || depositAmount < 0) {
      throw httpError(400, "depositAmount must be >= 0");
    }

    const eventRecord = await getEventByDate(eventDate);
    if (!eventRecord) throw httpError(404, "Event not found for date");
    if (!isAdmin && depositAmount < (eventRecord.minDeposit ?? 0)) {
      throw httpError(400, "depositAmount is below minimum for this event");
    }
    const tablePrice = getTablePriceForEvent(eventRecord, tableId);
    if (tablePrice === null) throw httpError(400, "Invalid tableId for event");

    const amountDue =
      amountDueInput !== null && Number.isFinite(amountDueInput) ? amountDueInput : tablePrice;
    let paymentStatus = "PENDING";
    if (paymentStatusInput) {
      if (!["PENDING", "PARTIAL", "PAID", "COURTESY"].includes(paymentStatusInput)) {
        throw httpError(400, "paymentStatus must be PENDING | PARTIAL | PAID | COURTESY");
      }
      paymentStatus = paymentStatusInput;
    } else {
      if (depositAmount <= 0) paymentStatus = "PENDING";
      else if (depositAmount >= amountDue) paymentStatus = "PAID";
      else paymentStatus = "PARTIAL";
    }

    let effectiveDeposit = depositAmount;
    let effectiveAmountDue = amountDue;
    if (paymentStatus === "COURTESY") {
      effectiveAmountDue = 0;
      effectiveDeposit = 0;
    } else if (paymentStatus === "PAID") {
      effectiveDeposit = effectiveAmountDue;
    } else if (paymentStatus === "PENDING") {
      effectiveDeposit = 0;
    }

    let effectiveDeadlineAt = paymentDeadlineAt;
    let effectiveDeadlineTz = null;
    if (paymentStatus === "PENDING" || paymentStatus === "PARTIAL") {
      if (!effectiveDeadlineAt) {
        const deadlineDate = addDaysToIsoDate(eventDate, 1);
        const hh = String(defaultPaymentDeadlineHour).padStart(2, "0");
        const mm = String(defaultPaymentDeadlineMinute).padStart(2, "0");
        effectiveDeadlineAt = `${deadlineDate}T${hh}:${mm}:00`;
      }
      const normalizedDeadline = normalizeDeadlineLocalIso(effectiveDeadlineAt);
      if (!normalizedDeadline) {
        throw httpError(400, "paymentDeadlineAt must be YYYY-MM-DDTHH:mm[:ss]");
      }
      const nowIso = nowInTimeZoneLocalIso(paymentDeadlineTz);
      if (!nowIso) {
        throw httpError(400, "paymentDeadlineTz is invalid");
      }
      if (normalizedDeadline <= nowIso) {
        throw httpError(400, "paymentDeadlineAt must be in the future");
      }
      effectiveDeadlineAt = normalizedDeadline;
      effectiveDeadlineTz = paymentDeadlineTz;
    } else {
      effectiveDeadlineAt = "";
      effectiveDeadlineTz = null;
    }

    const needsMethod = paymentStatus === "PAID" || paymentStatus === "PARTIAL";
    if (needsMethod && !["cash", "square", "cashapp"].includes(paymentMethodInput)) {
      throw httpError(400, "paymentMethod is required for PAID or PARTIAL reservations");
    }
    const effectivePaymentMethod =
      paymentStatus === "PENDING" || paymentStatus === "COURTESY"
        ? null
        : paymentMethodInput;

    const now = nowEpoch();
    const reservationId = randomUUID();
    const payments =
      effectiveDeposit > 0 && effectivePaymentMethod
        ? [
            {
              paymentId: randomUUID(),
              amount: effectiveDeposit,
              method: effectivePaymentMethod,
              // addReservationPayment tags every later row with `source` —
              // tag the initial deposit too so reports / financial filters
              // don't see a one-off untagged row.
              source: "manual",
              note: "Initial payment",
              createdAt: now,
              createdBy: user,
            },
          ]
        : [];

    const holdKey = { PK: `EVENTDATE#${eventDate}`, SK: `TABLE#${tableId}` };

    try {
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: HOLDS_TABLE,
                Key: holdKey,
                UpdateExpression:
                  "SET lockType = :reserved, reservationId = :rid, customerName = :name, phone = :phone, createdAt = :now, createdBy = :by REMOVE expiresAt, holdId",
                ConditionExpression:
                  "lockType = :hold AND holdId = :hid AND expiresAt >= :graceCutoff",
                ExpressionAttributeValues: {
                  ":reserved": "RESERVED",
                  ":hold": "HOLD",
                  ":hid": holdId,
                  ":rid": reservationId,
                  ":name": customerName,
                  ":phone": phone,
                  ":now": now,
                  ":graceCutoff": now - HOLD_EXPIRY_GRACE_SECONDS,
                  ":by": user,
                },
              },
            },
            {
              Put: {
                TableName: RES_TABLE,
                Item: {
                  PK: `EVENTDATE#${eventDate}`,
                  SK: `RES#${reservationId}`,
                  reservationId,
                  eventDate,
                  tableId,
                  customerName,
                  phone,
                  phoneCountry: normalizedPhoneCountry,
                  depositAmount: effectiveDeposit,
                  amountDue: effectiveAmountDue,
                  tablePrice,
                  paymentStatus,
                  paymentDeadlineAt: effectiveDeadlineAt || null,
                  paymentDeadlineTz: effectiveDeadlineTz,
                  paymentMethod: effectivePaymentMethod,
                  payments,
                  status: "CONFIRMED",
                  createdAt: now,
                  createdBy: user,
                },
                ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
              },
            },
          ],
        })
      );
    } catch (err) {
      if (err?.name !== "TransactionCanceledException") throw err;
      // Most common cause of TransactionCanceledException here: the client
      // retried POST /reservations after the first call already succeeded.
      // The hold has been converted to RESERVED with a reservationId set.
      // Look it up and return idempotently. (Audit M3.)
      const holdRow = await ddb.send(
        new GetCommand({ TableName: HOLDS_TABLE, Key: holdKey })
      );
      const lock = holdRow?.Item;
      if (lock?.lockType === "RESERVED") {
        const existingReservationId = String(lock.reservationId ?? "").trim();
        if (existingReservationId) {
          const resRow = await ddb.send(
            new GetCommand({
              TableName: RES_TABLE,
              Key: {
                PK: `EVENTDATE#${eventDate}`,
                SK: `RES#${existingReservationId}`,
              },
            })
          );
          const existing = resRow?.Item;
          if (existing) {
            return {
              reservationId: existingReservationId,
              checkInPass: null,
              idempotentReplay: true,
            };
          }
        }
      }
      // Not an idempotent replay — the hold expired, was claimed by someone
      // else, or never existed. Surface a clean 409.
      throw httpError(
        409,
        "This hold is no longer available — refresh and try again."
      );
    }

    const created = {
      reservationId,
      eventDate,
      tableId,
      customerName,
      phone,
      depositAmount: effectiveDeposit,
      amountDue: effectiveAmountDue,
      paymentMethod: effectivePaymentMethod,
      paymentStatus,
      status: "CONFIRMED",
    };
    await appendReservationHistory({
      eventDate,
      reservationId,
      eventType: "RESERVATION_CREATED",
      actor: user,
      source: "staff",
      tableId,
      customerName,
      at: now,
      details: {
        paymentStatus,
        paymentMethod: effectivePaymentMethod,
        amountDue: effectiveAmountDue,
        depositAmount: effectiveDeposit,
      },
    });
    if (payments.length > 0) {
      await appendReservationHistory({
        eventDate,
        reservationId,
        eventType: "PAYMENT_RECORDED",
        actor: user,
        source: "staff",
        tableId,
        customerName,
        at: now,
        details: {
          amount: effectiveDeposit,
          method: effectivePaymentMethod,
          paymentStatus,
          amountDue: effectiveAmountDue,
          paidTotal: effectiveDeposit,
          remainingAmount: Math.max(0, Number(effectiveAmountDue) - Number(effectiveDeposit)),
          note: "Initial payment",
        },
      });
    }
    const checkInPass = await tryEnsureCheckInPass(created, user);
    await trySendCheckInPassSms(created, checkInPass, user);
    return {
      reservationId,
      checkInPass: checkInPass?.pass ?? null,
    };
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
    listTableLocks,
    createHold,
    releaseHold,
    listHolds,
    listReservations,
    listReservationHistory,
    getReservationById,
    releaseOverdueReservationsForEventDate,
    releaseOverdueReservationsForAllActiveEvents,
    cancelReservation,
    createReservation,
    addReservationPayment,
    setReservationPaymentLinkWindow,
    setReservationCashAppLinkSession,
    markReservationCashAppLinkSessionUsed,
    appendReservationHistory,
  };
}
