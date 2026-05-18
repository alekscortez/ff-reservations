// Reservation lifecycle: read, create, cancel, overdue release. Final
// slice of the services-reservations-holds.mjs split (PR #8 / batch-9
// of the audit refactor). After this lands, services-reservations-holds.mjs
// is a thin barrel that composes shared + holds + payment-recording +
// this module.
//
// What this module owns
// - listReservations / listReservationHistory: read-side reservation queries
// - createReservation: the hold->reserved TransactWrite + idempotent replay,
//   initial payment recording, post-create check-in pass orchestration
// - cancelReservation: the three resolution paths (CANCEL_NO_REFUND,
//   RESCHEDULE_CREDIT, REFUND), Cash App link revocation, payment-link
//   deactivation, expired-payment-link SMS, frequent-table marking
// - releaseOverdueReservationsForEventDate / *ForAllActiveEvents: the cron
//   sweep that auto-cancels overdue reservations
// - assertRescheduleCreditAllowed, buildRescheduleCreditItem,
//   markFrequentTableReleasedForEvent: cancellation helpers
//
// Public contract: import {createReservationsService} and pass deps +
// shared + paymentRecording. The barrel composes all four modules.

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
  DEFAULT_AUTO_RELEASE_USER,
  DEFAULT_RESCHEDULE_CREDIT_TTL_DAYS,
  HOLD_EXPIRY_GRACE_SECONDS,
  MAX_TABLES_PER_RESERVATION,
  normalizeIdList,
  getReservationTableIds,
} from "./services-reservations-shared.mjs";

// Bounded concurrency for the cron sweep. With many active events, the
// serial loop is O(events) sequential DDB queries — a slow tail event
// delays the rest. Cap at 5 in flight: enough parallelism to amortize
// wall-clock without saturating Lambda's concurrent connection budget
// or starving normal request paths in the same execution.
const OVERDUE_SWEEP_CONCURRENCY = 5;

export function createReservationsService(
  {
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
    getTablePriceForEvent,
    deactivateSquarePaymentLink,
    refundSquarePayment,
    sendPaymentLinkExpiredSms,
    // Threaded so cancelReservation revokes any active check-in pass — a
    // cancelled reservation's wallet pass would otherwise still scan at
    // the door (scanner only checks pass status, not the reservation's
    // status). Soft-fail on revoke errors: the cancel is source-of-truth.
    revokeActivePassesForReservation,
  },
  shared,
  paymentRecording
) {
  const { EVENTS_TABLE, HOLDS_TABLE, RES_TABLE, CLIENTS_TABLE } = tableNames;
  const {
    roundMoney,
    toRescheduleCreditSk,
    historySourceFromActor,
    toTwelveHourLabel,
    normalizeDeadlineLocalIso,
    nowInTimeZoneLocalIso,
    addMinutesToLocalIso,
    isOverdueReservation,
    isFrequentAutoReservation,
    getRuntimeSettings,
    resolveDefaultPaymentDeadlineTz,
    resolveDefaultPaymentDeadlineHour,
    resolveDefaultPaymentDeadlineMinute,
    resolveRescheduleCutoffHour,
    resolveRescheduleCutoffMinute,
    appendReservationHistory,
    tryEnsureCheckInPass,
    trySendCheckInPassSms,
    queryReservationsForEventDate,
    getReservationById,
  } = shared;
  // When the "event_date + 1 day at default hour" default falls in the
  // past (event already happened operationally + we crossed the default
  // deadline), extend by this many minutes from now in the same tz so
  // booking doesn't break. Explicit past deadlines from clients still
  // throw — this only rescues the auto-default path.
  const PAST_DEFAULT_DEADLINE_EXTENSION_MINUTES = 4 * 60;
  const { markReservationPaymentLinkInactive } = paymentRecording;

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

    // All tables the reservation covers — drives the hold-release loop and
    // the frequent-table-released marker. Falls back to the legacy scalar
    // tableId for rows written before multi-table support landed; falls
    // back to the caller-supplied tableId only if both are missing (cron
    // and route both pass it but it's redundant now).
    const reservationTableIds = (() => {
      const fromRow = getReservationTableIds(current);
      if (fromRow.length > 0) return fromRow;
      const fromArg = String(tableId ?? "").trim();
      return fromArg ? [fromArg] : [];
    })();
    const primaryTableId = reservationTableIds[0] ?? null;

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
          tableId: primaryTableId,
          tableIds: reservationTableIds,
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
            tableId: primaryTableId,
            tableIds: reservationTableIds,
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
            tableId: primaryTableId,
            tableIds: reservationTableIds,
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
        tableId: primaryTableId,
        tableIds: reservationTableIds,
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

    // Revoke any active check-in pass so a cancelled customer's Wallet
    // pass scanner-rejects at the door. The scanner only looks at the
    // pass row's status — it never re-reads the reservation — so without
    // this revoke, a cancelled-but-PAID/COURTESY reservation's QR would
    // happily check in. Idempotent (revoke is conditional on
    // status=ISSUED) and soft-fail: the cancel above is source-of-truth,
    // an unreachable pass-revoke can be retried via the modal's reissue
    // flow (which itself revokes-then-issues).
    if (typeof revokeActivePassesForReservation === "function") {
      try {
        await revokeActivePassesForReservation(reservationId, user);
      } catch (err) {
        console.warn("checkin_pass_revoke_on_cancel_failed", {
          reservationId,
          eventDate,
          resolutionType,
          message: String(err?.message ?? err ?? ""),
        });
      }
    }

    // Release every hold row tied to this reservation. Loop is
     // independent per-table: one already-released hold doesn't block the
     // others. ConditionalCheckFailedException is normal (e.g. the hold
     // was already swept) — swallow it. Anything else surfaces.
    for (const tid of reservationTableIds) {
      try {
        await ddb.send(
          new DeleteCommand({
            TableName: HOLDS_TABLE,
            Key: { PK: pk, SK: `TABLE#${tid}` },
            ConditionExpression:
              "lockType = :reserved AND reservationId = :rid",
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
    }

    const paymentLinkId = String(cancelled?.paymentLinkId ?? "").trim();
    const shouldNotifyLinkExpired =
      cancelReason === AUTO_RELEASE_REASON &&
      paymentLinkId &&
      typeof sendPaymentLinkExpiredSms === "function";

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
      const cancelledTableIds = (() => {
        const fromRow = getReservationTableIds(cancelled);
        if (fromRow.length > 0) return fromRow;
        return reservationTableIds;
      })();
      try {
        const sms = await sendPaymentLinkExpiredSms({
          phone: cancelled?.phone,
          customerName: cancelled?.customerName,
          tableId: cancelledTableIds[0] ?? null,
          tableIds: cancelledTableIds,
        });
        await appendReservationHistory({
          eventDate,
          reservationId,
          eventType: "PAYMENT_LINK_EXPIRED_SMS_SENT",
          actor: user,
          source: String(user ?? "").startsWith("system:") ? "system" : "staff",
          tableId: cancelledTableIds[0] ?? primaryTableId,
          tableIds: cancelledTableIds,
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
          tableId: cancelledTableIds[0] ?? primaryTableId,
          tableIds: cancelledTableIds,
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
      // Mark every table released so the event's frequentReleasedTables[]
      // covers the whole booking. markFrequentTableReleasedForEvent is
      // idempotent on already-released tables.
      for (const tid of reservationTableIds) {
        await markFrequentTableReleasedForEvent(eventDate, tid, user);
      }
    }

    if (resolutionType === "RESCHEDULE_CREDIT" && issuedCredit) {
      await appendReservationHistory({
        eventDate,
        reservationId,
        eventType: "RESCHEDULE_CREDIT_ISSUED",
        actor: user,
        source: String(user ?? "").startsWith("system:") ? "system" : "staff",
        tableId: primaryTableId,
        tableIds: reservationTableIds,
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
      tableId: primaryTableId,
      tableIds: reservationTableIds,
      details: {
        reason: cancelReason,
        resolutionType,
        creditId: issuedCredit?.creditId ?? null,
        creditAmount: issuedCredit?.amountTotal ?? null,
        creditExpiresAt: issuedCredit?.expiresAt ?? null,
      },
      at: cancelAt,
    });

    return cancelled;
  }

  async function createReservation(payload, user, isAdmin) {
    requiredEnv("HOLDS_TABLE", HOLDS_TABLE);
    requiredEnv("RES_TABLE", RES_TABLE);

    const settings = await getRuntimeSettings();
    const defaultPaymentDeadlineTz = resolveDefaultPaymentDeadlineTz(settings);
    const defaultPaymentDeadlineHour = resolveDefaultPaymentDeadlineHour(settings);
    const defaultPaymentDeadlineMinute = resolveDefaultPaymentDeadlineMinute(settings);

    const eventDate = String(payload?.eventDate ?? "").trim();
    // Multi-table input: accept tableIds[]/holdIds[] OR legacy singular
    // tableId/holdId. Both forms produce N-length arrays where N is the
    // number of tables in this booking. The reservation row stores
    // tableIds[] plus tableId = tableIds[0] so legacy readers (frontend
    // dashboards, history dumps) still see something sensible.
    const tableIds = normalizeIdList(payload?.tableIds ?? payload?.tableId);
    const holdIds = normalizeIdList(payload?.holdIds ?? payload?.holdId);
    const customerName = String(payload?.customerName ?? "").trim();
    const customerCognitoSub =
      String(payload?.customerCognitoSub ?? "").trim() || null;
    // Customer-token-gated routes (anonymous public booking) use this to
    // authorize follow-up reads/releases without a Cognito sub. Stored as
    // an opaque 256-bit hex string from crypto.randomBytes(32). Optional
    // — staff/customer-app paths don't pass it, so the field is omitted
    // on the reservation row entirely.
    const customerToken =
      String(payload?.customerToken ?? "").trim() || null;
    // 6-char human-readable booking code (e.g. "K7M3X2"). Anonymous
    // public booking pre-generates this and passes it through so it can
    // show up on Square receipts + the customer-facing /r page. Staff
    // and customer-app paths leave it null. A lookup row is appended
    // to the TransactWrite below so PK=CODE/SK=CODE#XXXXXX resolves to
    // {reservationId, eventDate} on Square webhook + /p/<slug> redirects.
    const confirmationCode =
      String(payload?.confirmationCode ?? "").trim() || null;
    // 16-char base62 URL slug used by GET /p/{slug} to 302 to the
    // canonical /r/{id}?t=...&eventDate=... URL. Customer-facing
    // shareable URLs use the slug so SMS / WhatsApp links stay short.
    const publicSlug =
      String(payload?.publicSlug ?? "").trim() || null;
    // First-touch marketing attribution captured by the FE
    // (Layer 2 — UTM tracking). Already validated + truncated at the
    // route handler (`routes-public-bookings.mjs`); we just persist
    // the object as-is. Null when the visitor arrived with no
    // utm_*/fbclid/gclid params.
    const attribution =
      payload?.attribution && typeof payload.attribution === "object"
        ? payload.attribution
        : null;
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
    if (tableIds.length === 0) throw httpError(400, "tableId is required");
    if (holdIds.length === 0) throw httpError(400, "holdId is required");
    if (tableIds.length > MAX_TABLES_PER_RESERVATION) {
      throw httpError(
        400,
        `Cannot reserve more than ${MAX_TABLES_PER_RESERVATION} tables in one booking`
      );
    }
    if (tableIds.length !== holdIds.length) {
      throw httpError(400, "tableIds and holdIds must align 1:1");
    }
    if (new Set(tableIds).size !== tableIds.length) {
      throw httpError(400, "tableIds must be unique");
    }
    if (new Set(holdIds).size !== holdIds.length) {
      throw httpError(400, "holdIds must be unique");
    }
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
    // Per-table prices; tablePrice on the row is the SUM (the reservation's
    // total cost). tablePrices[] preserves the breakdown for reporting.
    const tablePrices = [];
    let tablePriceSum = 0;
    for (const tid of tableIds) {
      const price = getTablePriceForEvent(eventRecord, tid);
      if (price === null) {
        throw httpError(400, `Invalid tableId for event: ${tid}`);
      }
      tablePrices.push(Number(price));
      tablePriceSum += Number(price);
    }
    const tablePrice = roundMoney(tablePriceSum);

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
      // Track whether the deadline was supplied by the caller or
      // computed from defaults. We auto-clamp past *defaults* (a
      // system bug for after-cutoff bookings on the active business
      // day's event) but still throw on explicit past deadlines (a
      // user error that the staff form should surface).
      let usingDefault = false;
      if (!effectiveDeadlineAt) {
        usingDefault = true;
        const deadlineDate = addDaysToIsoDate(eventDate, 1);
        const hh = String(defaultPaymentDeadlineHour).padStart(2, "0");
        const mm = String(defaultPaymentDeadlineMinute).padStart(2, "0");
        effectiveDeadlineAt = `${deadlineDate}T${hh}:${mm}:00`;
      }
      let normalizedDeadline = normalizeDeadlineLocalIso(effectiveDeadlineAt);
      if (!normalizedDeadline) {
        throw httpError(400, "paymentDeadlineAt must be YYYY-MM-DDTHH:mm[:ss]");
      }
      const nowIso = nowInTimeZoneLocalIso(paymentDeadlineTz);
      if (!nowIso) {
        throw httpError(400, "paymentDeadlineTz is invalid");
      }
      if (normalizedDeadline <= nowIso) {
        if (usingDefault && typeof addMinutesToLocalIso === "function") {
          // event_date + 1d default fell past — typical at 2-5 AM on
          // the active business day for events whose date is today/
          // yesterday. Push the deadline N hours into the future in
          // the same tz so booking succeeds. Cron sweep auto-releases
          // unpaid reservations later anyway.
          const extended = addMinutesToLocalIso(
            nowIso,
            PAST_DEFAULT_DEADLINE_EXTENSION_MINUTES
          );
          const reNormalized = normalizeDeadlineLocalIso(extended);
          if (reNormalized && reNormalized > nowIso) {
            normalizedDeadline = reNormalized;
          } else {
            throw httpError(400, "paymentDeadlineAt must be in the future");
          }
        } else {
          throw httpError(400, "paymentDeadlineAt must be in the future");
        }
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
    // Accept a caller-supplied reservationId (anonymous public booking pre-
    // generates one upfront so it can stamp the phone-slot, the Square
    // hosted-checkout note, and the customer-return URL with the SAME id
    // that this row will land under). Fall back to a fresh UUID for the
    // staff/customer-app paths that don't pass one.
    const callerReservationId = String(payload?.reservationId ?? "").trim();
    const reservationId = callerReservationId || randomUUID();
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

    // Build the TransactWrite: one Update per hold (HOLD -> RESERVED with
     // matching holdId + within grace window), plus one Put for the new
     // reservation row. Either all N+1 land or none do; DynamoDB rejects
     // the whole transaction if any single CAS fails (e.g. a hold expired,
     // someone else's hold landed, or a duplicate reservationId — which
     // can only happen on UUID collision, never in practice).
    const holdItems = tableIds.map((tid, idx) => ({
      Update: {
        TableName: HOLDS_TABLE,
        Key: { PK: `EVENTDATE#${eventDate}`, SK: `TABLE#${tid}` },
        UpdateExpression:
          "SET lockType = :reserved, reservationId = :rid, customerName = :name, phone = :phone, createdAt = :now, createdBy = :by REMOVE expiresAt, holdId",
        ConditionExpression:
          "lockType = :hold AND holdId = :hid AND expiresAt >= :graceCutoff",
        ExpressionAttributeValues: {
          ":reserved": "RESERVED",
          ":hold": "HOLD",
          ":hid": holdIds[idx],
          ":rid": reservationId,
          ":name": customerName,
          ":phone": phone,
          ":now": now,
          ":graceCutoff": now - HOLD_EXPIRY_GRACE_SECONDS,
          ":by": user,
        },
      },
    }));
    const primaryHoldKey = {
      PK: `EVENTDATE#${eventDate}`,
      SK: `TABLE#${tableIds[0]}`,
    };

    try {
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            ...holdItems,
            {
              Put: {
                TableName: RES_TABLE,
                Item: {
                  PK: `EVENTDATE#${eventDate}`,
                  SK: `RES#${reservationId}`,
                  reservationId,
                  eventDate,
                  // Back-compat scalar: always tableIds[0]. Readers should
                  // prefer tableIds[] via getReservationTableIds.
                  tableId: tableIds[0],
                  tableIds,
                  customerName,
                  phone,
                  phoneCountry: normalizedPhoneCountry,
                  depositAmount: effectiveDeposit,
                  amountDue: effectiveAmountDue,
                  tablePrice,
                  tablePrices,
                  paymentStatus,
                  paymentDeadlineAt: effectiveDeadlineAt || null,
                  paymentDeadlineTz: effectiveDeadlineTz,
                  paymentMethod: effectivePaymentMethod,
                  payments,
                  status: "CONFIRMED",
                  createdAt: now,
                  createdBy: user,
                  // Conditionally attached. byCustomerSub GSI is sparse;
                  // omitting the attribute on staff-created reservations
                  // keeps them out of /me/reservations.
                  ...(customerCognitoSub ? { customerCognitoSub } : {}),
                  // Anonymous-public bookings carry a token that gates
                  // GET /public/reservations/{id}?t=... and the release
                  // / wallet routes. Omitted entirely for staff and
                  // mobile-customer paths so the attribute doesn't grow
                  // existing rows.
                  ...(customerToken ? { customerToken } : {}),
                  ...(confirmationCode ? { confirmationCode } : {}),
                  ...(publicSlug ? { publicSlug } : {}),
                  ...(attribution ? { attribution } : {}),
                },
                ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
              },
            },
            // Conditional lookup rows. Only written when the anon-flow
            // route pre-generated a code/slug. Each row carries enough
            // context to rebuild the canonical URL without a second
            // DDB hit on the reservation.
            ...(confirmationCode
              ? [
                  {
                    Put: {
                      TableName: RES_TABLE,
                      Item: {
                        PK: "CODE",
                        SK: `CODE#${confirmationCode}`,
                        entityType: "RESERVATION_CODE",
                        reservationId,
                        eventDate,
                        createdAt: now,
                      },
                      ConditionExpression: "attribute_not_exists(SK)",
                    },
                  },
                ]
              : []),
            ...(publicSlug
              ? [
                  {
                    Put: {
                      TableName: RES_TABLE,
                      Item: {
                        PK: "SLUG",
                        SK: `SLUG#${publicSlug}`,
                        entityType: "RESERVATION_SLUG",
                        reservationId,
                        eventDate,
                        customerToken,
                        createdAt: now,
                      },
                      ConditionExpression: "attribute_not_exists(SK)",
                    },
                  },
                ]
              : []),
          ],
        })
      );
    } catch (err) {
      if (err?.name !== "TransactionCanceledException") throw err;
      // Most common cause of TransactionCanceledException here: the client
      // retried POST /reservations after the first call already succeeded.
      // The first hold has been converted to RESERVED with a reservationId
      // set; look it up and return idempotently. (Audit M3.) For multi-
      // table replay, reading the first hold is sufficient — the original
      // call promoted all N atomically, so finding any one as RESERVED
      // means the whole booking landed.
      const holdRow = await ddb.send(
        new GetCommand({ TableName: HOLDS_TABLE, Key: primaryHoldKey })
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
      // Not an idempotent replay — a hold expired, was claimed by someone
      // else, or never existed. Surface a clean 409.
      throw httpError(
        409,
        "This hold is no longer available — refresh and try again."
      );
    }

    const created = {
      reservationId,
      eventDate,
      tableId: tableIds[0],
      tableIds,
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
      source: historySourceFromActor(user),
      tableId: tableIds[0],
      tableIds,
      customerName,
      at: now,
      details: {
        paymentStatus,
        paymentMethod: effectivePaymentMethod,
        amountDue: effectiveAmountDue,
        depositAmount: effectiveDeposit,
        tableIds,
      },
    });
    if (payments.length > 0) {
      await appendReservationHistory({
        eventDate,
        reservationId,
        eventType: "PAYMENT_RECORDED",
        actor: user,
        source: historySourceFromActor(user),
        tableId: tableIds[0],
        tableIds,
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
      // Echo back the short identifiers so the caller can hand them to
      // the customer (in the POST /public/reservations response) and
      // attach them to the Square payment-link note. Null for paths
      // that didn't pre-generate either.
      confirmationCode,
      publicSlug,
    };
  }

  // Customer-side reschedule. Cancels the original with RESCHEDULE_CREDIT,
  // creates the new reservation from a hold the mobile already created,
  // then applies the credit to the new reservation. Each step has its own
  // transactional guard inside the subroutine; this orchestrator's job is
  // ordering + customer-facing validation (24h gate, ownership, payment
  // status). The cancel-credit-rebook ordering is deliberate: if cancel
  // succeeds but createReservation fails afterward, the customer keeps
  // the credit and can re-book manually. If createReservation succeeds
  // but credit application fails, the new reservation simply remains
  // PENDING and the credit stays ACTIVE for retry — strictly better than
  // a half-rolled-back state.
  async function rescheduleReservationForCustomer(payload) {
    const originalEventDate = String(payload?.originalEventDate ?? "").trim();
    const originalReservationId = String(payload?.originalReservationId ?? "").trim();
    const newEventDate = String(payload?.newEventDate ?? "").trim();
    const newTableId = String(payload?.newTableId ?? "").trim();
    const newHoldId = String(payload?.newHoldId ?? "").trim();
    const newCustomerName = String(payload?.newCustomerName ?? "").trim();
    const customerCognitoSub = String(payload?.customerCognitoSub ?? "").trim();
    const newPaymentDeadlineAt = String(payload?.newPaymentDeadlineAt ?? "").trim();
    const newPaymentDeadlineTz = String(payload?.newPaymentDeadlineTz ?? "").trim();
    const reason = String(payload?.reason ?? "").trim() || "Customer rescheduled via mobile app";
    const actor = String(payload?.actor ?? "").trim();
    const hoursBefore =
      Number.isFinite(Number(payload?.hoursBefore)) && Number(payload?.hoursBefore) > 0
        ? Number(payload?.hoursBefore)
        : 24;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(originalEventDate)) {
      throw httpError(400, "originalEventDate must be YYYY-MM-DD");
    }
    if (!originalReservationId) {
      throw httpError(400, "originalReservationId is required");
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(newEventDate)) {
      throw httpError(400, "newEventDate must be YYYY-MM-DD");
    }
    if (!newTableId) throw httpError(400, "newTableId is required");
    if (!newHoldId) throw httpError(400, "newHoldId is required");
    if (!newCustomerName) throw httpError(400, "newCustomerName is required");
    if (!customerCognitoSub) {
      throw httpError(400, "customerCognitoSub is required");
    }
    if (!actor) throw httpError(400, "actor is required");

    const original = await getReservationById(originalEventDate, originalReservationId);
    if (!original) {
      throw httpError(404, "Original reservation not found");
    }
    if (String(original?.customerCognitoSub ?? "") !== customerCognitoSub) {
      throw httpError(403, "Reservation is not yours");
    }
    if (String(original?.status ?? "").toUpperCase() !== "CONFIRMED") {
      throw httpError(
        409,
        `Reservation must be CONFIRMED to reschedule. Current status: ${
          String(original?.status ?? "").toUpperCase() || "UNKNOWN"
        }`
      );
    }
    const paymentStatus = String(original?.paymentStatus ?? "").toUpperCase();
    if (paymentStatus !== "PAID" && paymentStatus !== "PARTIAL") {
      throw httpError(
        409,
        "Only paid or partially paid reservations can be rescheduled. Cancel and book a new table instead."
      );
    }

    // 24h-before-event gate. Mirrors routes-me self-cancel: 23:59:59Z of
    // the event date as the effective end-of-event marker, minus the
    // policy hours. Slightly conservative (pushes the cutoff earlier in
    // local time) which is the right direction for a customer-facing
    // rule.
    const eventEndUtcMs = Date.parse(`${originalEventDate}T23:59:59Z`);
    if (!Number.isFinite(eventEndUtcMs)) {
      throw httpError(500, "Invalid event date");
    }
    const cutoffMs = eventEndUtcMs - hoursBefore * 60 * 60 * 1000;
    if (Date.now() >= cutoffMs) {
      throw httpError(
        409,
        `Reschedule is only allowed at least ${hoursBefore} hours before the event.`
      );
    }

    const originalTableId = String(original?.tableId ?? "").trim();
    if (!originalTableId) {
      throw httpError(500, "Original reservation is missing tableId");
    }

    // Step 1: cancel original with RESCHEDULE_CREDIT.
    const cancelled = await cancelReservation(
      originalEventDate,
      originalReservationId,
      originalTableId,
      actor,
      reason,
      { resolutionType: "RESCHEDULE_CREDIT" }
    );
    const creditId = String(cancelled?.creditId ?? "").trim();
    const creditAmountTotal = Number(cancelled?.creditAmount ?? 0);
    const creditRemainingFromCancel = Number(cancelled?.creditRemainingAmount ?? 0);

    // Step 2: create the new reservation from the hold the mobile already
    // made. If this throws, the customer is left with a credit they can
    // apply manually — surface that explicitly so the mobile UX can
    // direct them to /me/credits.
    let newReservationId = null;
    try {
      const created = await createReservation(
        {
          eventDate: newEventDate,
          tableId: newTableId,
          holdId: newHoldId,
          customerName: newCustomerName,
          phone: String(original?.phone ?? "").trim(),
          phoneCountry: String(original?.phoneCountry ?? "US").trim() || "US",
          customerCognitoSub,
          paymentDeadlineAt: newPaymentDeadlineAt || undefined,
          paymentDeadlineTz: newPaymentDeadlineTz || undefined,
        },
        actor,
        false
      );
      newReservationId = String(created?.reservationId ?? "").trim();
    } catch (err) {
      const message = String(err?.message ?? err ?? "");
      throw httpError(
        502,
        `Reschedule could not complete: ${message}. Your previous reservation has been cancelled and a credit (${creditId || "pending"}) is on your account. Apply it on a new booking.`
      );
    }

    if (!newReservationId) {
      throw httpError(
        502,
        `Reschedule did not return a new reservation id. Credit ${creditId || "pending"} is on your account.`
      );
    }

    // Step 3: apply credit to the new reservation. Best-effort: if it
    // fails, the new reservation stays PENDING and the credit stays
    // ACTIVE. The mobile UX can prompt the customer to re-apply or pay
    // via Square.
    let appliedCredit = null;
    if (creditId && creditRemainingFromCancel > 0) {
      const newReservation = await getReservationById(newEventDate, newReservationId);
      const newAmountDue = Number(newReservation?.amountDue ?? 0);
      const newPaid = Number(newReservation?.depositAmount ?? 0);
      const newRemaining = Math.max(0, Number((newAmountDue - newPaid).toFixed(2)));
      if (newRemaining > 0) {
        const applyAmount = Number(
          Math.min(creditRemainingFromCancel, newRemaining).toFixed(2)
        );
        try {
          const updated = await paymentRecording.addReservationPayment(
            newReservationId,
            {
              eventDate: newEventDate,
              amount: applyAmount,
              method: "credit",
              creditId,
              note: `Reschedule credit from ${originalEventDate}`,
              source: "reschedule-credit",
            },
            actor
          );
          appliedCredit = {
            creditId,
            amountApplied: applyAmount,
            creditRemainingAfter: Number(
              Math.max(0, creditRemainingFromCancel - applyAmount).toFixed(2)
            ),
            applied: true,
            updatedReservation: updated ?? null,
          };
        } catch (err) {
          console.error("reschedule_credit_apply_failed", {
            creditId,
            newReservationId,
            newEventDate,
            applyAmount,
            errorMessage: String(err?.message ?? err ?? ""),
          });
          appliedCredit = {
            creditId,
            amountApplied: 0,
            creditRemainingAfter: creditRemainingFromCancel,
            applied: false,
            errorMessage:
              "Credit could not be applied automatically. It is available on your account.",
          };
        }
      } else {
        // New reservation already had no remaining balance (e.g. zero-
        // priced table). Leave the credit untouched.
        appliedCredit = {
          creditId,
          amountApplied: 0,
          creditRemainingAfter: creditRemainingFromCancel,
          applied: false,
          errorMessage: null,
        };
      }
    }

    const finalReservation =
      appliedCredit?.updatedReservation ??
      (await getReservationById(newEventDate, newReservationId));

    return {
      newReservation: finalReservation ?? { reservationId: newReservationId, eventDate: newEventDate },
      cancelled: {
        reservationId: originalReservationId,
        eventDate: originalEventDate,
      },
      creditIssued: creditId
        ? {
            creditId,
            amountTotal: Number(creditAmountTotal.toFixed(2)),
          }
        : null,
      appliedCredit: appliedCredit
        ? {
            creditId: appliedCredit.creditId,
            amountApplied: appliedCredit.amountApplied,
            creditRemainingAfter: appliedCredit.creditRemainingAfter,
            applied: appliedCredit.applied,
            errorMessage: appliedCredit.errorMessage ?? null,
          }
        : null,
    };
  }

  return {
    listReservations,
    listReservationHistory,
    cancelReservation,
    createReservation,
    releaseOverdueReservationsForEventDate,
    releaseOverdueReservationsForAllActiveEvents,
    rescheduleReservationForCustomer,
  };
}
