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
import { createPaymentRecordingService } from "./services-payment-recording.mjs";
import { createHoldsService } from "./services-holds.mjs";

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

  // Payment recording (addReservationPayment + the five payment-link /
  // Cash App session state mutators) extracted to
  // services-payment-recording.mjs. Same destructure pattern as `shared`
  // — call sites in cancelReservation / createReservation continue to
  // resolve to these local bindings.
  const paymentRecording = createPaymentRecordingService(deps, shared);
  const {
    addReservationPayment,
    setReservationPaymentLinkWindow,
    setReservationCashAppLinkSession,
    revokeReservationCashAppLinkSession,
    markReservationCashAppLinkSessionUsed,
    markReservationPaymentLinkInactive,
  } = paymentRecording;

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

  // Hold lifecycle extracted to services-holds.mjs. Wired in here so the
  // closure can pass the local releaseOverdueReservationsForEventDate
  // (createHold kicks an overdue sweep before allocating the lock).
  const holds = createHoldsService(deps, shared, {
    releaseOverdueReservationsForEventDate,
  });
  const { listTableLocks, createHold, releaseHold, listHolds } = holds;

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
