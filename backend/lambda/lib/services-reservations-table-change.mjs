// Change the tables on an existing reservation, atomically swapping
// hold/RESERVED locks and (when the new tables cost more) collecting
// the delta from staff in the same transaction.
//
// Three subcases:
//   delta = 0  swap only, no money moves
//   delta > 0  swap + bundled cash/credit payment for exactly the delta
//   delta < 0  swap + post-swap overpayment resolution
//              (CREDIT issue reschedule credit | REFUND partial Square
//              refund | LEAVE log only)
//
// Atomicity model
//   Single TransactWriteCommand: Delete per removed RESERVED row +
//   Update per added HOLD->RESERVED + one Update on the reservation row
//   + (when method=credit) one Update on the credit row in CLIENTS_TABLE.
//   Conditions pin #depositAmount and #tablePrice on the reservation row
//   so a concurrent payment or a concurrent swap loses (audit C3 pattern
//   from services-payment-recording.mjs).
//
// What stays out of the transaction
//   - TABLE_CHANGED + PAYMENT_RECORDED history writes (fire-and-forget,
//     mirrors createReservation).
//   - Active Square payment-link deactivation (the link encodes the old
//     amount and would let the customer pay the wrong total). We do not
//     auto-regenerate; staff regenerates with the new amount if needed.
//   - delta<0 surplus resolution: issue credit, partial Square refund,
//     or log overpayment. If the credit Put or the refund call fails the
//     swap stays in place and a 502 surfaces -- same risk shape as the
//     cancel-with-REFUND path that can leave money at Square if the
//     reservation status update fails afterward.
//
// Phase 1 payment-method scope for delta > 0
//   cash and credit (reschedule credit) only. Square / Square Stand /
//   Cash App settle asynchronously and can't be bundled into one
//   transaction without leaving the reservation in a half-committed
//   state, so they're deferred. The validation rejects them with a
//   clear message.

import {
  GetCommand,
  PutCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";

import {
  DEFAULT_RESCHEDULE_CREDIT_TTL_DAYS,
  HOLD_EXPIRY_GRACE_SECONDS,
  MAX_TABLES_PER_RESERVATION,
  normalizeIdList,
  getReservationTableIds,
} from "./services-reservations-shared.mjs";

export function createReservationsTableChangeService(
  {
    ddb,
    tableNames,
    requiredEnv,
    httpError,
    nowEpoch,
    addDaysToIsoDate,
    randomUUID,
    normalizePhone,
    getEventByDate,
    getTablePriceForEvent,
    deactivateSquarePaymentLink,
    refundSquarePayment,
    // Optional. When wired, the deferred-payment path uses this to
    // invalidate the existing check-in pass at swap time (since the
    // reservation drops to PARTIAL and the old pass shows stale
    // tables). On payment landing the regular addReservationPayment
    // flow issues a fresh pass automatically.
    revokeActivePassesForReservation,
    // Optional. When wired, the table-change flow auto-mints a fresh
    // Square payment link for FREQUENT reservations that land back at
    // PENDING|PARTIAL with a remaining balance. Mirrors the eager
    // link-gen we already do at FREQUENT_AUTO creation so frequent
    // guests don't lose their shareable link across a table swap.
    // Best-effort: Square failures log a warning and leave the
    // reservation without a link; staff regenerates via the Payment
    // Links panel or Take Payment modal.
    createSquarePaymentLink,
    // Optional. When wired, the table-change flow PATCHes the saved
    // Google Wallet object so Android customers see the new tables /
    // deposit reflected in their Wallet card, then sends an addMessage
    // so the system notification fires. Soft-fail like the Apple
    // pass-reissue path — table-change should not roll back on a
    // wallet hiccup.
    revokeGoogleWalletObjectForReservation,
    patchGoogleWalletObjectForReservation,
    notifyGoogleWalletObjectForReservation,
  },
  shared,
  paymentRecording
) {
  const { HOLDS_TABLE, RES_TABLE, CLIENTS_TABLE } = tableNames;
  const {
    roundMoney,
    toRescheduleCreditSk,
    historySourceFromActor,
    getRuntimeSettings,
    resolveDefaultPaymentDeadlineTz,
    nowInTimeZoneLocalIso,
    resolveCashReceiptNumberRequired,
    appendReservationHistory,
    getReservationById,
    // Predicate that closes over the clientsService's frequent-table
    // lookup at index-mjs wiring time. Drives the auto-link-regen
    // gate below — non-frequent reservations keep the old behavior
    // (link stays deactivated; staff regenerates manually).
    shouldUseFrequentPaymentLinkTtl,
    // Post-swap pass refresh: the customer's check-in pass shows the
    // OLD table label until we revoke it + mint a new one. We pipe
    // through the same helpers createReservation uses so the SMS +
    // history events look identical (CHECKIN_PASS_REISSUED +
    // CHECKIN_PASS_SMS_SENT vs CHECKIN_PASS_ISSUED at creation).
    tryEnsureCheckInPass,
    trySendCheckInPassSms,
  } = shared;
  const {
    markReservationPaymentLinkInactive,
    setReservationPaymentLinkWindow,
  } = paymentRecording;

  async function changeReservationTables(payload, user) {
    requiredEnv("HOLDS_TABLE", HOLDS_TABLE);
    requiredEnv("RES_TABLE", RES_TABLE);

    // ----- input shape -----
    const reservationId = String(payload?.reservationId ?? "").trim();
    const eventDate = String(payload?.eventDate ?? "").trim();
    const newTableIds = normalizeIdList(payload?.newTableIds);
    const expectedTablePriceTotal = Number(payload?.expectedTablePriceTotal);
    const reason = String(payload?.reason ?? "").trim();
    const overpaymentResolutionInput = String(
      payload?.overpaymentResolution ?? ""
    )
      .trim()
      .toUpperCase();
    const paymentInput =
      payload?.payment && typeof payload.payment === "object"
        ? payload.payment
        : null;
    // Alternative to `payment` for delta > 0: when the staff wants to
    // collect the difference via Square Stand, Square link, or Cash App
    // QR (all async settlement loops), the FE skips the bundled payment
    // and sends `deferredPaymentMethod` instead. The swap commits with
    // status dropping to PARTIAL; the parent immediately opens the
    // take-payment modal pre-loaded for that method. Tracked in history
    // so the partial state is auditable.
    const deferredPaymentMethodInput = String(
      payload?.deferredPaymentMethod ?? ""
    )
      .trim()
      .toLowerCase();
    const newHoldsByTableIdInput =
      payload?.newHoldsByTableId && typeof payload.newHoldsByTableId === "object"
        ? payload.newHoldsByTableId
        : {};

    if (!reservationId) throw httpError(400, "reservationId is required");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) {
      throw httpError(400, "eventDate must be YYYY-MM-DD");
    }
    if (newTableIds.length === 0) {
      throw httpError(400, "newTableIds is required");
    }
    if (newTableIds.length > MAX_TABLES_PER_RESERVATION) {
      throw httpError(
        400,
        `Cannot reserve more than ${MAX_TABLES_PER_RESERVATION} tables in one booking`
      );
    }
    if (new Set(newTableIds).size !== newTableIds.length) {
      throw httpError(400, "newTableIds must be unique");
    }
    if (!Number.isFinite(expectedTablePriceTotal) || expectedTablePriceTotal < 0) {
      throw httpError(400, "expectedTablePriceTotal must be a number >= 0");
    }
    if (!reason) {
      throw httpError(400, "reason is required");
    }

    // ----- load reservation + event -----
    const current = await getReservationById(eventDate, reservationId);
    const currentStatus = String(current?.status ?? "").trim().toUpperCase();
    if (currentStatus !== "CONFIRMED") {
      throw httpError(
        409,
        `Reservation must be CONFIRMED to change tables. Current status: ${currentStatus || "UNKNOWN"}`
      );
    }
    const currentPaymentStatusEnum = String(current?.paymentStatus ?? "")
      .trim()
      .toUpperCase();
    if (currentPaymentStatusEnum === "COURTESY") {
      throw httpError(400, "Cannot change tables on courtesy reservations");
    }
    if (currentPaymentStatusEnum === "REFUNDED") {
      throw httpError(400, "Cannot change tables on refunded reservations");
    }

    const currentTableIds = getReservationTableIds(current);
    if (currentTableIds.length === 0) {
      throw httpError(500, "Reservation has no tableIds — cannot change tables");
    }

    const addedTableIds = newTableIds.filter(
      (tid) => !currentTableIds.includes(tid)
    );
    const removedTableIds = currentTableIds.filter(
      (tid) => !newTableIds.includes(tid)
    );
    if (addedTableIds.length === 0 && removedTableIds.length === 0) {
      throw httpError(
        400,
        "newTableIds is identical to current tables — no change to apply"
      );
    }

    // Each added table needs a freshly-created HOLD owned by the caller.
    // Kept tables (intersection of old and new) stay RESERVED untouched.
    const newHoldsByTableId = {};
    for (const tid of addedTableIds) {
      const holdId = String(newHoldsByTableIdInput?.[tid] ?? "").trim();
      if (!holdId) {
        throw httpError(
          400,
          `Missing holdId for new table ${tid}. Create a hold first via POST /holds.`
        );
      }
      newHoldsByTableId[tid] = holdId;
    }

    const eventRecord = await getEventByDate(eventDate);
    if (!eventRecord) throw httpError(404, "Event not found for date");

    const newTablePrices = [];
    let newTablePriceSum = 0;
    for (const tid of newTableIds) {
      const price = getTablePriceForEvent(eventRecord, tid);
      if (price === null) {
        throw httpError(400, `Invalid tableId for event: ${tid}`);
      }
      newTablePrices.push(Number(price));
      newTablePriceSum += Number(price);
    }
    newTablePriceSum = roundMoney(newTablePriceSum);

    const expectedTablePriceTotalRounded = roundMoney(expectedTablePriceTotal);
    if (expectedTablePriceTotalRounded !== newTablePriceSum) {
      throw httpError(
        409,
        `Table prices changed (expected $${expectedTablePriceTotalRounded.toFixed(2)}, actual $${newTablePriceSum.toFixed(2)}). Refresh and try again.`
      );
    }

    const currentTablePrice = roundMoney(current?.tablePrice ?? 0);
    const currentAmountDue = roundMoney(current?.amountDue ?? 0);
    const currentDeposit = roundMoney(current?.depositAmount ?? 0);
    const delta = roundMoney(newTablePriceSum - currentTablePrice);
    const newAmountDue = roundMoney(currentAmountDue + delta);

    // ----- shape validation by delta sign -----

    // Cross-field consistency: deferredPaymentMethod is only meaningful
    // when delta > 0 (it's how we collect the extra). Reject early so
    // the more specific resolution / payment errors below don't mask it.
    if (delta <= 0 && deferredPaymentMethodInput) {
      throw httpError(
        400,
        "deferredPaymentMethod must not be provided when delta <= 0"
      );
    }
    if (paymentInput && deferredPaymentMethodInput) {
      throw httpError(
        400,
        "payment and deferredPaymentMethod are mutually exclusive"
      );
    }

    // overpaymentResolution: must be present iff delta < 0; never with delta >= 0.
    const overpaymentResolution = overpaymentResolutionInput;
    if (delta < 0) {
      if (paymentInput) {
        throw httpError(400, "payment must not be provided when delta < 0");
      }
      if (!["CREDIT", "REFUND", "LEAVE"].includes(overpaymentResolution)) {
        throw httpError(
          400,
          "overpaymentResolution must be CREDIT | REFUND | LEAVE when delta < 0"
        );
      }
      if (overpaymentResolution === "REFUND") {
        if (typeof refundSquarePayment !== "function") {
          throw httpError(
            501,
            "Refund workflow requires Square refund service to be configured"
          );
        }
        const existingPayments = Array.isArray(current?.payments)
          ? current.payments
          : [];
        const refundable = existingPayments.find((p) => {
          const method = String(p?.method ?? "").trim().toLowerCase();
          if (method !== "square") return false;
          const providerPaymentId = String(
            p?.provider?.providerPaymentId ?? ""
          ).trim();
          if (!providerPaymentId) return false;
          const amt = Number(p?.amount ?? 0);
          return Number.isFinite(amt) && amt > 0;
        });
        if (!refundable) {
          throw httpError(
            400,
            "No refundable Square payment found on this reservation. Use CREDIT or LEAVE instead."
          );
        }
      }
    } else if (overpaymentResolution) {
      throw httpError(
        400,
        "overpaymentResolution must not be provided when delta >= 0"
      );
    }

    if (delta === 0 && paymentInput) {
      throw httpError(400, "payment must not be provided when prices are unchanged");
    }

    // Async settlement intent for delta > 0. Validate the method early
    // so the swap doesn't commit if the FE is asking for something we
    // don't support yet.
    const allowedDeferredMethods = new Set([
      "square_stand",
      "square",
      "cashapp",
    ]);
    if (
      deferredPaymentMethodInput &&
      !allowedDeferredMethods.has(deferredPaymentMethodInput)
    ) {
      throw httpError(
        400,
        "deferredPaymentMethod must be square_stand | square | cashapp"
      );
    }

    // payment: must be present iff delta > 0; method in {cash, credit}; amount == delta.
    // OR: deferredPaymentMethod set, in which case no bundled payment.
    let bundledPayment = null;
    let creditPrep = null;
    if (delta > 0 && !deferredPaymentMethodInput) {
      if (!paymentInput) {
        throw httpError(
          400,
          "payment or deferredPaymentMethod is required when new tables cost more"
        );
      }
      const settings = await getRuntimeSettings();
      const paymentMethod = String(paymentInput?.method ?? "")
        .trim()
        .toLowerCase();
      const paymentAmount = roundMoney(paymentInput?.amount ?? 0);
      const receiptNumber = String(paymentInput?.receiptNumber ?? "").trim();
      const note = String(paymentInput?.note ?? "").trim();
      const creditId = String(paymentInput?.creditId ?? "").trim();

      if (!["cash", "credit"].includes(paymentMethod)) {
        throw httpError(
          400,
          "payment.method must be cash or credit. Async payment methods (Square, Cash App, Square Stand) are not supported for table changes yet."
        );
      }
      if (paymentAmount !== delta) {
        throw httpError(
          400,
          `payment.amount must equal delta (expected $${delta.toFixed(2)}, got $${paymentAmount.toFixed(2)})`
        );
      }
      if (receiptNumber.length > 64) {
        throw httpError(400, "payment.receiptNumber must be 64 characters or fewer");
      }
      if (receiptNumber && !/^\d+$/.test(receiptNumber)) {
        throw httpError(400, "payment.receiptNumber must contain digits only");
      }
      if (
        paymentMethod === "cash" &&
        resolveCashReceiptNumberRequired(settings) &&
        !receiptNumber
      ) {
        throw httpError(
          400,
          "payment.receiptNumber is required when payment.method is cash"
        );
      }
      if (paymentMethod === "credit" && !creditId) {
        throw httpError(
          400,
          "payment.creditId is required when payment.method is credit"
        );
      }

      bundledPayment = {
        method: paymentMethod,
        amount: paymentAmount,
        receiptNumber: paymentMethod === "cash" ? receiptNumber : null,
        note: note || "Table change payment",
        creditId: paymentMethod === "credit" ? creditId : null,
      };

      // Credit method: pre-fetch + validate the credit row so the
      // TransactWrite Update on CLIENTS_TABLE can carry stable
      // next-remaining + next-status values. CCFE in the transaction
      // will catch races between the read and the write.
      if (paymentMethod === "credit") {
        requiredEnv("CLIENTS_TABLE", CLIENTS_TABLE);
        const phone = String(current?.phone ?? "").trim();
        const phoneCountry =
          String(current?.phoneCountry ?? "US").trim() || "US";
        const phoneKey = normalizePhone(phone, phoneCountry);
        if (!phone || !phoneKey) {
          throw httpError(
            400,
            "Reservation must include a valid client phone to apply credit"
          );
        }
        const creditGet = await ddb.send(
          new GetCommand({
            TableName: CLIENTS_TABLE,
            Key: {
              PK: "CLIENT",
              SK: toRescheduleCreditSk(phoneKey, creditId),
            },
          })
        );
        const credit = creditGet?.Item;
        if (!credit) {
          throw httpError(404, "Reschedule credit not found for this client");
        }
        if (
          String(credit?.entityType ?? "").toUpperCase() !==
          "RESCHEDULE_CREDIT"
        ) {
          throw httpError(409, "Invalid credit record type");
        }
        const creditStatus = String(credit?.status ?? "")
          .trim()
          .toUpperCase();
        if (creditStatus !== "ACTIVE") {
          throw httpError(
            409,
            `Credit is not active. Current status: ${creditStatus || "UNKNOWN"}`
          );
        }
        const creditRemaining = roundMoney(credit?.amountRemaining ?? 0);
        if (creditRemaining <= 0) {
          throw httpError(409, "Credit has no remaining balance");
        }
        if (delta > creditRemaining) {
          throw httpError(
            400,
            "payment.amount cannot exceed credit remaining balance"
          );
        }
        const operatingTz = resolveDefaultPaymentDeadlineTz(settings);
        const nowLocalIso = nowInTimeZoneLocalIso(operatingTz);
        const todayIso = String(nowLocalIso ?? "").slice(0, 10);
        const creditExpiresAt = String(credit?.expiresAt ?? "").trim();
        if (creditExpiresAt && todayIso && creditExpiresAt < todayIso) {
          throw httpError(409, `Credit expired on ${creditExpiresAt}`);
        }
        const nextCreditRemaining = roundMoney(
          Math.max(0, creditRemaining - delta)
        );
        const nextCreditStatus = nextCreditRemaining <= 0 ? "USED" : "ACTIVE";
        creditPrep = {
          phoneKey,
          creditId,
          todayIso,
          amount: delta,
          nextRemaining: nextCreditRemaining,
          nextStatus: nextCreditStatus,
        };
      }
    }

    // ----- compute next state -----
    const nextDeposit =
      bundledPayment !== null
        ? roundMoney(currentDeposit + bundledPayment.amount)
        : currentDeposit;
    let nextStatus;
    if (newAmountDue <= 0) {
      // Theoretical: free tables. Mirror createReservation's PENDING for
      // depositAmount==0 path; otherwise PAID.
      nextStatus = nextDeposit > 0 ? "PAID" : "PENDING";
    } else if (nextDeposit >= newAmountDue) {
      nextStatus = "PAID";
    } else if (nextDeposit > 0) {
      nextStatus = "PARTIAL";
    } else {
      nextStatus = "PENDING";
    }

    const now = nowEpoch();
    const paymentEntries = [];
    if (bundledPayment) {
      paymentEntries.push({
        paymentId: randomUUID(),
        amount: bundledPayment.amount,
        method: bundledPayment.method,
        receiptNumber: bundledPayment.receiptNumber,
        source: bundledPayment.method === "credit" ? "reschedule-credit" : "manual",
        note: bundledPayment.note,
        provider: null,
        credit: bundledPayment.creditId ? { creditId: bundledPayment.creditId } : null,
        createdAt: now,
        createdBy: user,
      });
    }

    // ----- build atomic TransactWrite -----
    const transactItems = [];

    for (const tid of removedTableIds) {
      transactItems.push({
        Delete: {
          TableName: HOLDS_TABLE,
          Key: { PK: `EVENTDATE#${eventDate}`, SK: `TABLE#${tid}` },
          ConditionExpression:
            "lockType = :reserved AND reservationId = :rid",
          ExpressionAttributeValues: {
            ":reserved": "RESERVED",
            ":rid": reservationId,
          },
        },
      });
    }

    for (const tid of addedTableIds) {
      transactItems.push({
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
            ":hid": newHoldsByTableId[tid],
            ":rid": reservationId,
            ":name": String(current?.customerName ?? ""),
            ":phone": String(current?.phone ?? ""),
            ":now": now,
            ":graceCutoff": now - HOLD_EXPIRY_GRACE_SECONDS,
            ":by": user,
          },
        },
      });
    }

    const resSetClauses = [
      "#tableId = :newTableId",
      "#tableIds = :newTableIds",
      "#tablePrice = :newTablePrice",
      "#tablePrices = :newTablePrices",
      "#amountDue = :newAmountDue",
      "#paymentStatus = :paymentStatus",
      "#updatedAt = :now",
      "#updatedBy = :by",
    ];
    const resRemoveClauses = [];
    const resNames = {
      "#status": "status",
      "#depositAmount": "depositAmount",
      "#tableId": "tableId",
      "#tableIds": "tableIds",
      "#tablePrice": "tablePrice",
      "#tablePrices": "tablePrices",
      "#amountDue": "amountDue",
      "#paymentStatus": "paymentStatus",
      "#updatedAt": "updatedAt",
      "#updatedBy": "updatedBy",
    };
    const resValues = {
      ":confirmed": "CONFIRMED",
      ":currentPaid": currentDeposit,
      ":oldTablePrice": currentTablePrice,
      ":newTableId": newTableIds[0],
      ":newTableIds": newTableIds,
      ":newTablePrice": newTablePriceSum,
      ":newTablePrices": newTablePrices,
      ":newAmountDue": newAmountDue,
      ":paymentStatus": nextStatus,
      ":now": now,
      ":by": user,
    };

    if (paymentEntries.length > 0) {
      resSetClauses.push(
        "#depositAmount = :newDeposit",
        "#paymentMethod = :paymentMethod",
        "#payments = list_append(if_not_exists(#payments, :empty), :newPayments)"
      );
      resNames["#paymentMethod"] = "paymentMethod";
      resNames["#payments"] = "payments";
      resValues[":newDeposit"] = nextDeposit;
      resValues[":paymentMethod"] = bundledPayment.method;
      resValues[":empty"] = [];
      resValues[":newPayments"] = paymentEntries;
    }

    if (nextStatus === "PAID") {
      resNames["#paymentDeadlineAt"] = "paymentDeadlineAt";
      resNames["#paymentDeadlineTz"] = "paymentDeadlineTz";
      resRemoveClauses.push("#paymentDeadlineAt", "#paymentDeadlineTz");
    }

    const resUpdateExpression =
      resRemoveClauses.length > 0
        ? `SET ${resSetClauses.join(", ")} REMOVE ${resRemoveClauses.join(", ")}`
        : `SET ${resSetClauses.join(", ")}`;

    transactItems.push({
      Update: {
        TableName: RES_TABLE,
        Key: {
          PK: `EVENTDATE#${eventDate}`,
          SK: `RES#${reservationId}`,
        },
        UpdateExpression: resUpdateExpression,
        // Pin status, depositAmount, and tablePrice so concurrent
        // payments + concurrent swaps both lose. Mirrors the audit-C3
        // pattern used in addReservationPayment.
        ConditionExpression:
          "#status = :confirmed AND #depositAmount = :currentPaid AND #tablePrice = :oldTablePrice",
        ExpressionAttributeNames: resNames,
        ExpressionAttributeValues: resValues,
      },
    });

    if (creditPrep) {
      const creditKey = {
        PK: "CLIENT",
        SK: toRescheduleCreditSk(creditPrep.phoneKey, creditPrep.creditId),
      };
      let creditUpdateExpression =
        "SET #amountRemaining = :creditRemaining, #status = :creditStatus, #updatedAt = :now, #updatedBy = :by";
      if (creditPrep.nextStatus === "USED") {
        creditUpdateExpression += ", #usedAt = :now, #usedBy = :by";
      } else {
        creditUpdateExpression += " REMOVE #usedAt, #usedBy";
      }
      transactItems.push({
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
            ":amount": creditPrep.amount,
            ":today": creditPrep.todayIso,
            ":creditRemaining": creditPrep.nextRemaining,
            ":creditStatus": creditPrep.nextStatus,
            ":now": now,
            ":by": user,
          },
        },
      });
    }

    // ----- execute -----
    try {
      await ddb.send(new TransactWriteCommand({ TransactItems: transactItems }));
    } catch (err) {
      if (err?.name !== "TransactionCanceledException") throw err;
      // Idempotent replay: if reservation already shows newTableIds, the
      // first call landed and this is a retry. Otherwise the swap raced
      // (hold expired, table claimed, concurrent payment, concurrent
      // swap) — surface 409.
      let replay = null;
      try {
        replay = await getReservationById(eventDate, reservationId);
      } catch {
        replay = null;
      }
      const replayTableIds = getReservationTableIds(replay);
      const matchesTarget =
        replay &&
        replayTableIds.length === newTableIds.length &&
        replayTableIds.every((tid) => newTableIds.includes(tid));
      if (matchesTarget) {
        return {
          reservation: { ...replay, idempotentReplay: true },
          delta,
          newAmountDue: roundMoney(replay?.amountDue ?? newAmountDue),
          newTablePrice: roundMoney(replay?.tablePrice ?? newTablePriceSum),
          newTablePrices: Array.isArray(replay?.tablePrices)
            ? replay.tablePrices
            : newTablePrices,
          payment: null,
          overpayment: null,
          idempotentReplay: true,
        };
      }
      throw httpError(
        409,
        "Table change could not complete — a hold expired, a table was claimed, or the reservation changed concurrently. Refresh and try again."
      );
    }

    // ----- post-transaction side effects (fire-and-forget) -----

    const customerName = String(current?.customerName ?? "").trim() || null;
    const oldTablePrices = Array.isArray(current?.tablePrices)
      ? current.tablePrices
      : null;

    await appendReservationHistory({
      eventDate,
      reservationId,
      eventType: "TABLE_CHANGED",
      actor: user,
      source: historySourceFromActor(user),
      tableId: newTableIds[0],
      tableIds: newTableIds,
      customerName,
      at: now,
      details: {
        fromTableIds: currentTableIds,
        fromTablePrices: oldTablePrices,
        fromTablePrice: currentTablePrice,
        toTableIds: newTableIds,
        toTablePrices: newTablePrices,
        toTablePrice: newTablePriceSum,
        delta,
        newAmountDue,
        addedTableIds,
        removedTableIds,
        reason,
        deferredPaymentMethod: deferredPaymentMethodInput || null,
      },
    });

    if (deferredPaymentMethodInput) {
      // Document the staff's intent to collect the delta via an async
      // settlement loop. The reservation is now PARTIAL; the parent FE
      // opens the take-payment modal pre-loaded for this method. If
      // collection fails or the staff abandons, the reservation just
      // stays PARTIAL until its payment deadline (then the cron sweep
      // auto-cancels).
      await appendReservationHistory({
        eventDate,
        reservationId,
        eventType: "DELTA_PAYMENT_DEFERRED",
        actor: user,
        source: historySourceFromActor(user),
        tableId: newTableIds[0],
        tableIds: newTableIds,
        customerName,
        at: now,
        details: {
          method: deferredPaymentMethodInput,
          amount: delta,
          newAmountDue,
          fromTableChange: true,
        },
      });
    }

    if (paymentEntries.length > 0) {
      const payment = paymentEntries[0];
      const remainingAfter = Math.max(0, newAmountDue - nextDeposit);
      await appendReservationHistory({
        eventDate,
        reservationId,
        eventType: "PAYMENT_RECORDED",
        actor: user,
        source: payment.source,
        tableId: newTableIds[0],
        tableIds: newTableIds,
        customerName,
        at: now,
        details: {
          amount: payment.amount,
          method: payment.method,
          paymentStatus: nextStatus,
          amountDue: newAmountDue,
          paidTotal: nextDeposit,
          remainingAmount: remainingAfter,
          receiptNumber: payment.receiptNumber,
          note: payment.note,
          creditId: payment.method === "credit" ? creditPrep?.creditId ?? null : null,
          fromTableChange: true,
        },
      });
      if (payment.method === "credit") {
        await appendReservationHistory({
          eventDate,
          reservationId,
          eventType: "RESCHEDULE_CREDIT_APPLIED",
          actor: user,
          source: "staff",
          tableId: newTableIds[0],
          tableIds: newTableIds,
          customerName,
          at: now,
          details: {
            creditId: creditPrep?.creditId ?? null,
            amount: payment.amount,
            paymentStatus: nextStatus,
            amountDue: newAmountDue,
            paidTotal: nextDeposit,
            remainingAmount: remainingAfter,
            creditRemainingAmount: creditPrep?.nextRemaining ?? null,
            fromTableChange: true,
          },
        });
      }
    }

    // Active Square payment link encodes the old amount; deactivate so a
    // customer can't pay the wrong total via a stale link. Frequent
    // reservations get an auto-regen further down (post `updatedReservation`
    // build) so the shareable link doesn't go dark across a swap. Non-
    // frequent reservations stay on the manual-regen path.
    const paymentLinkId = String(current?.paymentLinkId ?? "").trim();
    const paymentLinkStatusEnum = String(current?.paymentLinkStatus ?? "")
      .toUpperCase();
    if (
      paymentLinkId &&
      paymentLinkStatusEnum === "ACTIVE" &&
      typeof deactivateSquarePaymentLink === "function"
    ) {
      let inactiveStatus = "DEACTIVATED";
      let inactiveReason = "table-changed-amount-may-differ";
      try {
        const deactivation = await deactivateSquarePaymentLink({ paymentLinkId });
        if (deactivation?.alreadyGone) {
          inactiveStatus = "NOT_FOUND";
          inactiveReason =
            "table-changed-amount-may-differ (payment link already unavailable)";
        }
      } catch (linkErr) {
        inactiveStatus = "DEACTIVATION_FAILED";
        inactiveReason = `table-changed-amount-may-differ (deactivation failed: ${String(
          linkErr?.message ?? linkErr ?? "unknown"
        )})`;
        console.warn("table_change_payment_link_deactivation_failed", {
          reservationId,
          eventDate,
          paymentLinkId,
          message: String(linkErr?.message ?? linkErr ?? ""),
        });
      }
      try {
        await markReservationPaymentLinkInactive({
          eventDate,
          reservationId,
          status: inactiveStatus,
          actor: user,
          reason: inactiveReason,
        });
      } catch (markErr) {
        // Best-effort: don't fail the change on a logging-style update.
        console.warn("table_change_mark_link_inactive_failed", {
          reservationId,
          eventDate,
          paymentLinkId,
          message: String(markErr?.message ?? markErr ?? ""),
        });
      }
    }

    // delta < 0 surplus resolution. The reservation row was updated above
    // without touching depositAmount, so currentDeposit is still on the
    // row and may now exceed newAmountDue.
    let issuedCredit = null;
    let partialRefund = null;
    const surplus =
      delta < 0 ? roundMoney(Math.max(0, currentDeposit - newAmountDue)) : 0;
    if (delta < 0 && surplus > 0) {
      if (overpaymentResolution === "CREDIT") {
        try {
          const creditItem = await buildOverpaymentCreditItem({
            reservation: current,
            eventDate,
            reservationId,
            surplus,
            actor: user,
            reason,
            issuedAt: now,
          });
          await ddb.send(
            new PutCommand({
              TableName: CLIENTS_TABLE,
              Item: creditItem,
              ConditionExpression:
                "attribute_not_exists(PK) AND attribute_not_exists(SK)",
            })
          );
          issuedCredit = {
            creditId: creditItem.creditId,
            amountTotal: creditItem.amountTotal,
            amountRemaining: creditItem.amountRemaining,
            expiresAt: creditItem.expiresAt,
          };
          await appendReservationHistory({
            eventDate,
            reservationId,
            eventType: "OVERPAYMENT_CREDIT_ISSUED",
            actor: user,
            source: historySourceFromActor(user),
            tableId: newTableIds[0],
            tableIds: newTableIds,
            customerName,
            at: now,
            details: {
              creditId: creditItem.creditId,
              amount: surplus,
              expiresAt: creditItem.expiresAt,
              phone: creditItem.phone,
              fromTableChange: true,
            },
          });
        } catch (creditErr) {
          console.error("table_change_overpayment_credit_failed", {
            reservationId,
            eventDate,
            surplus,
            message: String(creditErr?.message ?? creditErr ?? ""),
          });
          await appendReservationHistory({
            eventDate,
            reservationId,
            eventType: "OVERPAYMENT_CREDIT_FAILED",
            actor: user,
            source: historySourceFromActor(user),
            tableId: newTableIds[0],
            tableIds: newTableIds,
            customerName,
            at: now,
            details: {
              surplus,
              errorMessage: String(
                creditErr?.message ?? creditErr ?? ""
              ).slice(0, 256),
              fromTableChange: true,
            },
          });
          throw httpError(
            502,
            `Tables swapped but overpayment credit could not be issued ($${surplus.toFixed(2)}). Manual reconciliation required.`
          );
        }
      } else if (overpaymentResolution === "REFUND") {
        const existingPayments = Array.isArray(current?.payments)
          ? current.payments
          : [];
        const refundCandidate = [...existingPayments]
          .reverse()
          .find((p) => {
            const method = String(p?.method ?? "").trim().toLowerCase();
            if (method !== "square") return false;
            const providerPaymentId = String(
              p?.provider?.providerPaymentId ?? ""
            ).trim();
            return Boolean(providerPaymentId);
          });
        if (!refundCandidate) {
          throw httpError(
            502,
            `Tables swapped but no refundable Square payment found for the surplus ($${surplus.toFixed(2)}). Manual reconciliation required.`
          );
        }
        const providerPaymentId = String(
          refundCandidate.provider.providerPaymentId
        ).trim();
        const paymentLocalId = String(
          refundCandidate.paymentId ?? "fallback"
        ).trim();
        const idempotencyKey = `refund-tablechange-${reservationId}-${paymentLocalId}`;
        try {
          const result = await refundSquarePayment({
            paymentId: providerPaymentId,
            amount: surplus,
            idempotencyKey,
            reason: reason.slice(0, 192),
          });
          partialRefund = {
            providerPaymentId,
            amount: surplus,
            refundId: String(result?.refund?.id ?? "").trim() || null,
            refundStatus:
              String(result?.refund?.status ?? "").toUpperCase() || null,
            idempotencyKey,
          };
          await appendReservationHistory({
            eventDate,
            reservationId,
            eventType: "PARTIAL_REFUND_ISSUED",
            actor: user,
            source: historySourceFromActor(user),
            tableId: newTableIds[0],
            tableIds: newTableIds,
            customerName,
            at: now,
            details: {
              ...partialRefund,
              fromTableChange: true,
            },
          });
        } catch (refundErr) {
          console.error("table_change_partial_refund_failed", {
            reservationId,
            eventDate,
            providerPaymentId,
            surplus,
            message: String(refundErr?.message ?? refundErr ?? ""),
          });
          await appendReservationHistory({
            eventDate,
            reservationId,
            eventType: "PARTIAL_REFUND_FAILED",
            actor: user,
            source: historySourceFromActor(user),
            tableId: newTableIds[0],
            tableIds: newTableIds,
            customerName,
            at: now,
            details: {
              providerPaymentId,
              amount: surplus,
              errorMessage: String(
                refundErr?.message ?? refundErr ?? ""
              ).slice(0, 256),
              idempotencyKey,
              fromTableChange: true,
            },
          });
          throw httpError(
            502,
            `Tables swapped but partial refund failed ($${surplus.toFixed(2)}). Manual reconciliation required for Square payment ${providerPaymentId}.`
          );
        }
      } else {
        await appendReservationHistory({
          eventDate,
          reservationId,
          eventType: "OVERPAYMENT_RECORDED",
          actor: user,
          source: historySourceFromActor(user),
          tableId: newTableIds[0],
          tableIds: newTableIds,
          customerName,
          at: now,
          details: {
            surplus,
            resolution: "LEAVE",
            fromTableChange: true,
          },
        });
      }
    }

    // Post-swap pass refresh.
    //
    // Two branches:
    //   nextStatus === PAID: revoke + reissue + SMS. The customer's
    //     wallet pass gets a fresh url/token + correct table label.
    //   nextStatus !== PAID (deferred-payment path): just revoke the
    //     active pass. We can't issue a new one until paymentStatus is
    //     PAID again (pass module rejects). When the delta payment
    //     lands via the chained take-payment modal, the existing
    //     addReservationPayment -> tryEnsureCheckInPass(reissue:false)
    //     path sees no active pass and issues a fresh one with the
    //     new tables.
    //
    // Both branches are fire-and-forget: failures are logged + append
    // CHECKIN_PASS_*_FAILED but don't fail the swap response.
    let reissuedPass = null;
    if (nextStatus !== "PAID" && typeof revokeActivePassesForReservation === "function") {
      try {
        const res = await revokeActivePassesForReservation(reservationId, user);
        if (res?.revoked > 0) {
          await appendReservationHistory({
            eventDate,
            reservationId,
            eventType: "CHECKIN_PASS_REVOKED",
            actor: user,
            source: historySourceFromActor(user),
            tableId: newTableIds[0],
            tableIds: newTableIds,
            customerName,
            at: now,
            details: {
              passesRevoked: res.revoked,
              reason: "table-change-deferred-payment",
              fromTableChange: true,
            },
          });
        }
      } catch (revokeErr) {
        console.warn("table_change_pass_revoke_failed", {
          reservationId,
          eventDate,
          message: String(revokeErr?.message ?? revokeErr ?? ""),
        });
      }
    }
    if (nextStatus === "PAID") {
      const reservationForPass = {
        ...current,
        tableId: newTableIds[0],
        tableIds: newTableIds,
        tablePrice: newTablePriceSum,
        tablePrices: newTablePrices,
        amountDue: newAmountDue,
        depositAmount: nextDeposit,
        paymentStatus: nextStatus,
        paymentMethod:
          bundledPayment !== null
            ? bundledPayment.method
            : current?.paymentMethod ?? null,
        status: "CONFIRMED",
      };
      try {
        const passResult = await tryEnsureCheckInPass(reservationForPass, user, {
          reissue: true,
        });
        if (passResult?.issued) {
          reissuedPass = passResult?.pass ?? null;
          // SMS the new pass URL. If SMS fails, trySendCheckInPassSms
          // appends CHECKIN_PASS_SMS_FAILED itself; nothing to do here.
          await trySendCheckInPassSms(reservationForPass, passResult, user);
        }
      } catch (passErr) {
        // tryEnsureCheckInPass already logs + swallows; this catch is
        // a belt-and-suspenders for any future throw path.
        console.warn("table_change_pass_reissue_failed", {
          reservationId,
          eventDate,
          message: String(passErr?.message ?? passErr ?? ""),
        });
      }
    }

    // Google Wallet sibling. Two branches mirror Apple:
    //   nextStatus === PAID: PATCH the existing object so its textModulesData
    //     + barcode reflect the new tables + fresh check-in pass token, then
    //     addMessage so the Android system notification fires.
    //   nextStatus !== PAID: revoke (state=INACTIVE) the existing object so
    //     the saved card shows as invalid until the delta payment lands and
    //     a new pass is issued (at which point the customer re-saves via the
    //     same Add-to-Google-Wallet flow).
    // All branches are best-effort. Google Wallet object state is purely
    // cosmetic — the DDB-backed scanner already rejects via pass status.
    try {
      if (
        nextStatus !== "PAID" &&
        typeof revokeGoogleWalletObjectForReservation === "function"
      ) {
        await revokeGoogleWalletObjectForReservation(reservationId);
      } else if (
        nextStatus === "PAID" &&
        reissuedPass &&
        typeof patchGoogleWalletObjectForReservation === "function"
      ) {
        const reservationForPatch = {
          ...current,
          tableId: newTableIds[0],
          tableIds: newTableIds,
          tablePrice: newTablePriceSum,
          tablePrices: newTablePrices,
          depositAmount: nextDeposit,
          paymentStatus: nextStatus,
          paymentTotal: nextDeposit,
        };
        await patchGoogleWalletObjectForReservation({
          reservation: reservationForPatch,
          checkInPass: reissuedPass,
        });
        if (typeof notifyGoogleWalletObjectForReservation === "function") {
          const tableLabel =
            newTableIds.length > 1
              ? `Tables: ${newTableIds.join(", ")}`
              : `Table: ${newTableIds[0]}`;
          await notifyGoogleWalletObjectForReservation(reservationId, {
            header: "Your table changed",
            body: `${tableLabel}. Show this pass at the door.`,
          });
        }
      }
    } catch (gwErr) {
      console.warn("table_change_google_wallet_update_failed", {
        reservationId,
        eventDate,
        message: String(gwErr?.message ?? gwErr ?? ""),
      });
    }

    // Build the response. Mirror the row shape the FE expects so it can
    // refresh state without a second GET.
    let updatedReservation = {
      ...current,
      tableId: newTableIds[0],
      tableIds: newTableIds,
      tablePrice: newTablePriceSum,
      tablePrices: newTablePrices,
      amountDue: newAmountDue,
      depositAmount: nextDeposit,
      paymentStatus: nextStatus,
      paymentMethod:
        bundledPayment !== null
          ? bundledPayment.method
          : current?.paymentMethod ?? null,
      paymentDeadlineAt:
        nextStatus === "PAID" ? null : current?.paymentDeadlineAt ?? null,
      paymentDeadlineTz:
        nextStatus === "PAID" ? null : current?.paymentDeadlineTz ?? null,
      updatedAt: now,
      updatedBy: user,
      payments: [
        ...(Array.isArray(current?.payments) ? current.payments : []),
        ...paymentEntries,
      ],
    };

    // Auto-regen the Square payment link for FREQUENT reservations that
    // land back at PENDING|PARTIAL with a remaining balance. The old
    // link was already deactivated above (delta != 0 path) — without
    // this, frequent guests would lose their shareable link across a
    // table swap and staff would have to mint a new one by hand.
    //
    // Gates:
    //   - Square deps wired (createSquarePaymentLink +
    //     setReservationPaymentLinkWindow). Tests without them silently
    //     skip.
    //   - nextStatus is PENDING or PARTIAL (PAID means no remaining;
    //     COURTESY shouldn't have a link).
    //   - Remaining > 0 after the swap.
    //   - shouldUseFrequentPaymentLinkTtl(updatedReservation) is true.
    //     Non-frequent reservations keep the old "staff regenerates
    //     manually" behavior so the blast radius of this change is
    //     scoped to the frequent path.
    //
    // Best-effort: any failure (Square 5xx, network, etc.) logs a
    // warning and leaves the reservation without a link. The Payment
    // Links panel + Take Payment modal both surface "Generate link"
    // for recovery.
    const remainingAfterSwap = roundMoney(
      Math.max(0, Number(newAmountDue) - Number(nextDeposit))
    );
    const autoRegenEligible =
      remainingAfterSwap > 0 &&
      (nextStatus === "PENDING" || nextStatus === "PARTIAL") &&
      typeof createSquarePaymentLink === "function" &&
      typeof setReservationPaymentLinkWindow === "function" &&
      typeof shouldUseFrequentPaymentLinkTtl === "function";
    if (autoRegenEligible) {
      let isFrequent = false;
      try {
        isFrequent = await shouldUseFrequentPaymentLinkTtl(updatedReservation);
      } catch (predicateErr) {
        // Treat predicate failures as "not frequent" — the worst case is
        // the existing manual-regen behavior, which is what every
        // non-frequent reservation already gets.
        console.warn("table_change_auto_regen_predicate_failed", {
          reservationId,
          eventDate,
          message: String(predicateErr?.message ?? predicateErr ?? ""),
        });
      }
      if (isFrequent) {
        try {
          const square = await createSquarePaymentLink({
            reservationId,
            eventDate,
            tableId: newTableIds[0],
            tableIds: newTableIds,
            customerName: String(updatedReservation.customerName ?? "").trim(),
            phone: String(updatedReservation.phone ?? "").trim(),
            amount: remainingAfterSwap,
            note: "",
            // Distinct from the FREQUENT_AUTO eager key
            // (`freq:{id}:v1`) so a creation-time idempotency cache hit
            // doesn't suppress this post-swap mint. Timestamp keeps
            // multiple swaps on the same reservation independent.
            idempotencyKey: `freq:tablechange:${reservationId}:${now}`,
          });
          const link = square?.paymentLink ?? {};
          const linkUrl = String(link?.url ?? "").trim();
          const linkId = String(link?.id ?? "").trim();
          if (linkUrl && linkId) {
            await setReservationPaymentLinkWindow({
              eventDate,
              reservationId,
              paymentLinkId: linkId,
              paymentLinkUrl: linkUrl,
              actor: user,
            });
            // Refresh from DDB so the response mirrors the post-stamp
            // row exactly (paymentLinkStatus / paymentLinkExpiresAt /
            // paymentDeadlineAt are all set by setReservation
            // PaymentLinkWindow; building them by hand is fragile).
            try {
              const refreshed = await getReservationById(eventDate, reservationId);
              if (refreshed) updatedReservation = refreshed;
            } catch {
              // Refresh is cosmetic — the FE can still re-fetch on its
              // own. Don't fail the swap on a read.
            }
          }
        } catch (linkErr) {
          console.warn("table_change_auto_regen_failed", {
            reservationId,
            eventDate,
            message: String(linkErr?.message ?? linkErr ?? ""),
          });
        }
      }
    }

    return {
      reservation: updatedReservation,
      delta,
      newAmountDue,
      newTablePrice: newTablePriceSum,
      newTablePrices,
      payment: paymentEntries[0] ?? null,
      overpayment:
        surplus > 0
          ? {
              surplus,
              resolution: overpaymentResolution,
              credit: issuedCredit,
              refund: partialRefund,
            }
          : null,
      // Reissued pass surfaced so the FE can refresh its cached
      // check-in pass URL + state without a second GET. null when the
      // reservation isn't PAID (no pass to reissue), or reissue failed.
      reissuedPass,
      // Echo the deferred payment intent back so the FE knows which
      // payment method to chain into post-swap (Square Stand / Square
      // link / Cash App QR). null when bundled-payment path was used.
      deferredPaymentMethod: deferredPaymentMethodInput || null,
    };
  }

  // Reschedule-credit row used when delta<0 + resolution=CREDIT. Same
  // shape as services-reservations.mjs buildRescheduleCreditItem but
  // skips the reschedule-cutoff check (this credit is the by-product of
  // a staff-initiated table swap, not a customer-initiated cancel).
  async function buildOverpaymentCreditItem({
    reservation,
    eventDate,
    reservationId,
    surplus,
    actor,
    reason,
    issuedAt,
  }) {
    requiredEnv("CLIENTS_TABLE", CLIENTS_TABLE);
    const phone = String(reservation?.phone ?? "").trim();
    const phoneCountryHint =
      String(reservation?.phoneCountry ?? "US").trim() || "US";
    const phoneKey = normalizePhone(phone, phoneCountryHint);
    if (!phone || !phoneKey) {
      throw httpError(
        400,
        "Cannot issue overpayment credit without a valid client phone"
      );
    }
    const settings = await getRuntimeSettings();
    const operatingTz = resolveDefaultPaymentDeadlineTz(settings);
    const nowLocalIso = nowInTimeZoneLocalIso(operatingTz);
    const issuedDate = String(nowLocalIso ?? "").slice(0, 10) || eventDate;
    const expiresAt = addDaysToIsoDate(
      issuedDate,
      DEFAULT_RESCHEDULE_CREDIT_TTL_DAYS
    );
    const creditId = randomUUID();
    const amount = roundMoney(surplus);
    return {
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
      amountTotal: amount,
      amountRemaining: amount,
      issuedAt,
      issuedBy: String(actor ?? "").trim() || "system",
      expiresAt,
      reason: String(reason ?? "").trim() || "Table change overpayment",
    };
  }

  return {
    changeReservationTables,
  };
}
