import {
  formatTablesLabel,
  getReservationTableIds,
} from "./services-reservations-shared.mjs";

export async function handleReservationsAndHoldsRoute(ctx) {
  const {
    method,
    path,
    event,
    cors,
    json,
    noContent,
    httpError,
    getBody,
    getUserLabel,
    getGroupsFromEvent,
    autoSendSquareLinkSmsEnabled,
    requireStaffOrAdmin,
    createHold,
    listHolds,
    releaseHold,
    createReservation,
    upsertCrmClient,
    listReservations,
    listReservationHistory,
    getReservationById,
    lookupReservationByConfirmationCode,
    releaseOverdueReservationsForEventDate,
    addReservationPayment,
    setReservationPaymentLinkWindow,
    appendReservationHistory,
    createSquarePayment,
    createSquarePaymentLink,
    refundSquarePayment,
    sendPaymentLinkSms,
    cancelReservation,
    changeReservationTables,
    extendReservationPaymentDeadline,
    getRuntimeSettingsSubset,
    getEventByDate,
    listEvents,
    resolveBusinessDate,
    checkInPassBaseUrl,
    // Square Stand handoff (URL-scheme bridge). See
    // services-square-stand-handoff.mjs.
    startSquareStandHandoff,
    completeSquareStandHandoff,
    cancelSquareStandHandoff,
    squareStandCallbackUrl,
  } = ctx;

  // After a Square charge succeeds, addReservationPayment may still reject
  // (e.g. another payment landed first and remainingAmount is now 0). The
  // money is already at Square; we MUST refund automatically or the customer
  // is double-charged. Idempotency key is stable (per Square paymentId) so
  // retries are safe and Square will return the existing refund.
  const autoRefundAfterRecordFailure = async ({
    paymentId,
    amount,
    eventDate,
    reservationId,
    recordError,
    actor,
  }) => {
    if (typeof refundSquarePayment !== "function") {
      console.error("auto_refund_skipped_no_refund_service", {
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
        reason: "Reservation update failed after charge — auto refund",
      });
      console.warn("auto_refund_after_record_failure", {
        reservationId,
        eventDate,
        paymentId,
        refundId: refund?.refund?.id ?? null,
        amount,
        recordError: String(recordError?.message ?? recordError ?? ""),
      });
      if (typeof appendReservationHistory === "function") {
        await appendReservationHistory({
          eventDate,
          reservationId,
          eventType: "AUTO_REFUND_AFTER_RECORD_FAILURE",
          actor: String(actor ?? "").trim() || "system",
          source: "system",
          details: {
            paymentId,
            refundId: refund?.refund?.id ?? null,
            amount,
            recordErrorMessage: String(recordError?.message ?? recordError ?? "").slice(0, 256),
          },
        });
      }
      return {
        refunded: true,
        refundId: refund?.refund?.id ?? null,
        refundStatus: refund?.refund?.status ?? null,
      };
    } catch (refundErr) {
      console.error("auto_refund_failed", {
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
            actor: String(actor ?? "").trim() || "system",
            source: "system",
            details: {
              paymentId,
              amount,
              refundErrorMessage: String(refundErr?.message ?? refundErr ?? "").slice(0, 256),
              recordErrorMessage: String(recordError?.message ?? recordError ?? "").slice(0, 256),
            },
          });
        } catch {
          // Best-effort history write.
        }
      }
      return {
        refunded: false,
        reason: "refund_failed",
        refundErrorMessage: String(refundErr?.message ?? refundErr ?? "Refund failed"),
      };
    }
  };

  const resolvePublicSquareSettings = async () => {
    const settings =
      typeof getRuntimeSettingsSubset === "function"
        ? await getRuntimeSettingsSubset()
        : null;
    const envMode =
      String(settings?.squareEnvMode ?? "").trim().toLowerCase() === "production"
        ? "production"
        : "sandbox";
    return {
      envMode,
      applicationId: String(settings?.squareApplicationId ?? "").trim(),
      locationId: String(settings?.squareLocationId ?? "").trim(),
      enabled:
        Boolean(String(settings?.squareApplicationId ?? "").trim()) &&
        Boolean(String(settings?.squareLocationId ?? "").trim()),
    };
  };

  if (method === "POST" && path === "/holds") {
    requireStaffOrAdmin(event);
    const body = getBody(event);
    if (!body) return json(400, { message: "Invalid JSON body" }, cors);
    const user = await getUserLabel(event);
    const item = await createHold(body, user);
    return json(201, { item }, cors);
  }

  if (method === "GET" && path === "/holds") {
    requireStaffOrAdmin(event);
    const eventDate = event.queryStringParameters?.eventDate;
    if (!eventDate) return json(400, { message: "eventDate is required" }, cors);
    if (typeof releaseOverdueReservationsForEventDate === "function") {
      await releaseOverdueReservationsForEventDate(eventDate);
    }
    const items = await listHolds(eventDate);
    return json(200, { items }, cors);
  }

  const holdMatch = path.match(/^\/holds\/(\d{4}-\d{2}-\d{2})\/([^/]+)$/);
  if (holdMatch && method === "DELETE") {
    requireStaffOrAdmin(event);
    const eventDate = holdMatch[1];
    const tableId = holdMatch[2];
    await releaseHold(eventDate, tableId);
    return noContent(204, cors);
  }

  if (method === "POST" && path === "/reservations") {
    requireStaffOrAdmin(event);
    const body = getBody(event);
    if (!body) return json(400, { message: "Invalid JSON body" }, cors);
    const user = await getUserLabel(event);
    const requestedPaymentMethod = String(body?.paymentMethod ?? "")
      .trim()
      .toLowerCase();
    const groups = getGroupsFromEvent(event);
    const isAdmin = groups.includes("Admin");
    const item = await createReservation(body, user, isAdmin);
    const isIdempotentReplay = Boolean(item?.idempotentReplay);
    if (!isIdempotentReplay) {
      try {
        await upsertCrmClient(body, user);
      } catch (crmErr) {
        console.error("CRM upsert failed after reservation create", crmErr);
      }
    }
    let autoSquareLinkSms = isIdempotentReplay
      ? { attempted: false, sent: false, reason: "idempotent_replay" }
      : null;
    const shouldAutoSendDigitalLinkSms =
      !isIdempotentReplay && Boolean(autoSendSquareLinkSmsEnabled);
    if (shouldAutoSendDigitalLinkSms && typeof sendPaymentLinkSms === "function") {
      const eventDate = String(body?.eventDate ?? "").trim();
      const reservationId = String(item?.reservationId ?? "").trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(eventDate) && reservationId) {
        let autoPaymentMethod = null;
        let autoLinkType = null;
        try {
          const reservation = await getReservationById(eventDate, reservationId);
          const status = String(reservation?.status ?? "").toUpperCase();
          const paymentStatus = String(reservation?.paymentStatus ?? "").toUpperCase();
          const paymentMethod = String(reservation?.paymentMethod ?? "")
            .trim()
            .toLowerCase();
          const isSquareRequested =
            paymentMethod === "square" || requestedPaymentMethod === "square";
          const hasActiveLink =
            String(reservation?.paymentLinkStatus ?? "").toUpperCase() === "ACTIVE" &&
            String(reservation?.paymentLinkId ?? "").trim().length > 0;
          const amountDue = Number(reservation?.amountDue ?? 0);
          const paid = Number(reservation?.depositAmount ?? 0);
          const remainingAmount = Math.max(0, amountDue - paid);

          if (
            status === "CONFIRMED" &&
            (paymentStatus === "PENDING" || paymentStatus === "PARTIAL") &&
            !hasActiveLink &&
            remainingAmount > 0
          ) {
            if (
              isSquareRequested &&
              typeof createSquarePaymentLink === "function" &&
              typeof setReservationPaymentLinkWindow === "function"
            ) {
              autoPaymentMethod = "square";
              autoLinkType = "square";
              const reservationTableIds = getReservationTableIds(reservation);
              const reservationTablesLabel =
                formatTablesLabel(reservationTableIds) || "reservation";
              const square = await createSquarePaymentLink({
                reservationId,
                eventDate,
                tableId: reservationTableIds[0] ?? null,
                tableIds: reservationTableIds,
                customerName: String(reservation?.customerName ?? "").trim(),
                phone: String(reservation?.phone ?? "").trim(),
                amount: remainingAmount,
                note: `Auto Square link for ${reservationTablesLabel.toLowerCase()} via SMS`,
              });

              const paymentLink = square?.paymentLink ?? {};
              const paymentLinkId = String(paymentLink?.id ?? "").trim();
              const paymentLinkUrl = String(paymentLink?.url ?? "").trim();
              if (!paymentLinkId || !paymentLinkUrl) {
                throw new Error("Square payment link response missing id or url");
              }

              const reservationAfterLink = await setReservationPaymentLinkWindow({
                eventDate,
                reservationId,
                paymentLinkId,
                paymentLinkUrl,
                actor: user,
              });

              const linkTableIds =
                getReservationTableIds(reservationAfterLink ?? reservation);

              const sms = await sendPaymentLinkSms({
                phone: reservationAfterLink?.phone ?? reservation?.phone,
                customerName:
                  reservationAfterLink?.customerName ?? reservation?.customerName,
                eventDate,
                tableId: linkTableIds[0] ?? null,
                tableIds: linkTableIds,
                paymentLinkUrl,
              });

              if (typeof appendReservationHistory === "function") {
                await appendReservationHistory({
                  eventDate,
                  reservationId,
                  eventType: "PAYMENT_LINK_SMS_SENT",
                  actor: user,
                  source: "staff",
                  tableId: linkTableIds[0] ?? null,
                  tableIds: linkTableIds,
                  customerName:
                    reservationAfterLink?.customerName ?? reservation?.customerName,
                  details: {
                    auto: true,
                    paymentMethod: "square",
                    linkType: "square",
                    linkAmount: remainingAmount,
                    paymentLinkId,
                    to:
                      String(
                        sms?.to ??
                          reservationAfterLink?.phone ??
                          reservation?.phone ??
                          ""
                      ).trim() || null,
                    messageId: String(sms?.messageId ?? "").trim() || null,
                    provider: String(sms?.provider ?? "").trim() || null,
                  },
                });
              }

              autoSquareLinkSms = {
                attempted: true,
                sent: true,
                paymentMethod: "square",
                linkType: "square",
                linkAmount: remainingAmount,
                paymentLinkId,
                to: String(sms?.to ?? "").trim() || null,
                messageId: String(sms?.messageId ?? "").trim() || null,
              };
            }
          }
        } catch (autoSmsErr) {
          if (typeof appendReservationHistory === "function" && reservationId) {
            await appendReservationHistory({
              eventDate,
              reservationId,
              eventType: "PAYMENT_LINK_SMS_FAILED",
              actor: user,
              source: "staff",
              details: {
                auto: true,
                paymentMethod: autoPaymentMethod,
                linkType: autoLinkType,
                errorMessage: String(
                  autoSmsErr?.message ?? "Failed to auto send payment link SMS"
                ),
              },
            });
          }
          console.warn("auto_square_payment_link_sms_failed", {
            reservationId,
            eventDate,
            message: String(autoSmsErr?.message ?? autoSmsErr ?? ""),
          });
          autoSquareLinkSms = {
            attempted: true,
            sent: false,
            errorMessage: String(
              autoSmsErr?.message ?? "Failed to auto send payment link SMS"
            ),
          };
        }
      }
    }
    return json(201, { item, autoSquareLinkSms }, cors);
  }

  // Staff lookup by 6-char confirmation code (FF-XXXXXX shown on
  // customer receipts and the /r page). Accepts the code with or
  // without the "FF-" prefix so staff can paste exactly what the
  // customer reads off their phone. Returns the full reservation row
  // so the caller can navigate to the reservations page filtered by
  // its eventDate and open the detail modal.
  const byCodeMatch = path.match(/^\/reservations\/by-code\/([^/]+)$/);
  if (byCodeMatch && method === "GET") {
    requireStaffOrAdmin(event);
    if (typeof lookupReservationByConfirmationCode !== "function") {
      return json(500, { message: "Code lookup not configured" }, cors);
    }
    let code = String(byCodeMatch[1] ?? "").trim().toUpperCase();
    if (code.startsWith("FF-")) code = code.slice(3);
    if (!/^[A-Z0-9]{6}$/.test(code)) {
      return json(
        400,
        {
          message: "Confirmation code must be 6 alphanumeric characters.",
          code: "BAD_CONFIRMATION_CODE",
        },
        cors
      );
    }
    const looked = await lookupReservationByConfirmationCode(code);
    if (!looked?.reservationId || !looked?.eventDate) {
      return json(
        404,
        {
          message: `No reservation found for code FF-${code}.`,
          code: "RESERVATION_NOT_FOUND",
        },
        cors
      );
    }
    const reservation = await getReservationById(
      looked.eventDate,
      looked.reservationId
    );
    if (!reservation) {
      // Index row exists but reservation row doesn't — orphaned lookup
      // (rare but possible if a backfill ran without the reservation
      // write). Surface as not found; ops can spot via metric filter.
      console.warn("by_code_orphaned_index", { code, ...looked });
      return json(
        404,
        {
          message: `No reservation found for code FF-${code}.`,
          code: "RESERVATION_NOT_FOUND",
        },
        cors
      );
    }
    return json(200, { reservation }, cors);
  }

  if (method === "GET" && path === "/reservations/recent") {
    requireStaffOrAdmin(event);
    if (typeof listEvents !== "function" || typeof resolveBusinessDate !== "function") {
      return json(500, { message: "Recent reservations endpoint is not configured" }, cors);
    }
    const maxEventsRaw = Number(event.queryStringParameters?.maxEvents ?? 3);
    const maxEvents = Number.isFinite(maxEventsRaw)
      ? Math.min(7, Math.max(1, Math.floor(maxEventsRaw)))
      : 3;
    const limitRaw = Number(event.queryStringParameters?.limit ?? 50);
    const limit = Number.isFinite(limitRaw)
      ? Math.min(200, Math.max(1, Math.floor(limitRaw)))
      : 50;

    const businessCtx = await resolveBusinessDate();
    const businessDate = String(businessCtx?.businessDate ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) {
      return json(500, { message: "Failed to resolve business date" }, cors);
    }

    const allEvents = (await listEvents()) ?? [];
    const upcoming = allEvents
      .filter(
        (e) =>
          String(e?.status ?? "").toUpperCase() === "ACTIVE" &&
          /^\d{4}-\d{2}-\d{2}$/.test(String(e?.eventDate ?? "")) &&
          String(e.eventDate) >= businessDate
      )
      .sort((a, b) => String(a.eventDate).localeCompare(String(b.eventDate)))
      .slice(0, maxEvents);

    // Fan out per event. Failures on a single event don't poison the whole
    // call — caller still gets partial results from the other events.
    const eventDates = upcoming.map((e) => String(e.eventDate));
    const perEvent = await Promise.all(
      eventDates.map(async (date) => {
        try {
          const items = await listReservations(date);
          return Array.isArray(items) ? items : [];
        } catch {
          return [];
        }
      })
    );
    const merged = perEvent.flat();
    return json(
      200,
      {
        items: merged.slice(0, limit),
        eventDates,
        asOfEpoch: Math.floor(Date.now() / 1000),
      },
      cors
    );
  }

  if (method === "GET" && path === "/reservations") {
    requireStaffOrAdmin(event);
    const eventDate = event.queryStringParameters?.eventDate;
    if (!eventDate) return json(400, { message: "eventDate is required" }, cors);
    // `suppressRelease=1` skips the per-event overdue sweep that staff
    // hot-paths use as a belt-and-suspenders against the EventBridge cron.
    // Reporting consumers (admin Financials) fan out across many events
    // and don't want the read to mutate hold state mid-load. The cron
    // (`runScheduledMaintenance`) still owns active-event sweeping.
    const suppressRelease =
      String(event.queryStringParameters?.suppressRelease ?? "").trim() === "1";
    if (!suppressRelease && typeof releaseOverdueReservationsForEventDate === "function") {
      await releaseOverdueReservationsForEventDate(eventDate);
    }
    const items = await listReservations(eventDate);
    return json(200, { items }, cors);
  }

  const reservationHistoryMatch = path.match(/^\/reservations\/([^/]+)\/history\/?$/);
  if (reservationHistoryMatch && method === "GET") {
    requireStaffOrAdmin(event);
    const reservationId = String(reservationHistoryMatch[1] ?? "").trim();
    const eventDate = String(event.queryStringParameters?.eventDate ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) {
      return json(400, { message: "eventDate is required (YYYY-MM-DD)" }, cors);
    }
    if (!reservationId) {
      return json(400, { message: "reservationId is required" }, cors);
    }
    const items = await listReservationHistory(eventDate, reservationId);
    return json(200, { items }, cors);
  }

  const paymentMatch = path.match(/^\/reservations\/([^/]+)\/payment$/);
  if (paymentMatch && method === "PUT") {
    requireStaffOrAdmin(event);
    const reservationId = paymentMatch[1];
    const body = getBody(event);
    if (!body) return json(400, { message: "Invalid JSON body" }, cors);
    const user = await getUserLabel(event);
    const item = await addReservationPayment(reservationId, body, user);
    return json(200, { item }, cors);
  }

  const squarePaymentMatch = path.match(/^\/reservations\/([^/]+)\/payment\/square$/);
  if (squarePaymentMatch && method === "POST") {
    requireStaffOrAdmin(event);
    const reservationId = squarePaymentMatch[1];
    const body = getBody(event);
    if (!body) return json(400, { message: "Invalid JSON body" }, cors);

    const eventDate = String(body?.eventDate ?? "").trim();
    const amount = Number(body?.amount ?? 0);
    const sourceId = String(body?.sourceId ?? "").trim();
    const note = String(body?.note ?? "").trim();
    const idempotencyKey = String(body?.idempotencyKey ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) {
      return json(400, { message: "eventDate must be YYYY-MM-DD" }, cors);
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return json(400, { message: "amount must be > 0" }, cors);
    }
    if (!sourceId) {
      return json(400, { message: "sourceId is required" }, cors);
    }

    if (typeof releaseOverdueReservationsForEventDate === "function") {
      await releaseOverdueReservationsForEventDate(eventDate);
    }
    const reservation = await getReservationById(eventDate, reservationId);
    if (String(reservation?.status ?? "").toUpperCase() !== "CONFIRMED") {
      return json(400, { message: "Only confirmed reservations can receive payments" }, cors);
    }
    if (String(reservation?.paymentStatus ?? "").toUpperCase() === "COURTESY") {
      return json(400, { message: "Cannot add payments to courtesy reservations" }, cors);
    }
    const amountDue = Number(reservation?.amountDue ?? 0);
    const paid = Number(reservation?.depositAmount ?? 0);
    const remainingAmount = Math.max(0, amountDue - paid);
    if (remainingAmount <= 0) {
      return json(400, { message: "Reservation is already fully paid" }, cors);
    }
    if (amount > remainingAmount) {
      return json(400, { message: "amount cannot exceed remaining balance" }, cors);
    }

    const user = await getUserLabel(event);
    const square = await createSquarePayment({
      reservationId,
      eventDate,
      amount,
      sourceId,
      note,
      idempotencyKey: idempotencyKey || undefined,
    });
    const squareSourceType = String(square?.payment?.source_type ?? "")
      .trim()
      .toUpperCase();
    const recordedMethod = squareSourceType === "CASH_APP" ? "cashapp" : "square";
    const squarePaymentId = String(square?.payment?.id ?? "").trim();

    let item;
    try {
      item = await addReservationPayment(
        reservationId,
        {
          eventDate,
          amount,
          method: recordedMethod,
          source: "square-direct",
          note,
          provider: {
            providerPaymentId: squarePaymentId || null,
            providerStatus: square.payment?.status,
            receiptUrl: square.payment?.receipt_url,
            orderId: square.payment?.order_id,
            sourceType: square.payment?.source_type,
            idempotencyKey: square.idempotencyKey,
            amountMoney: square.payment?.amount_money ?? null,
          },
        },
        user
      );
    } catch (recordErr) {
      // Square already took the money. Auto-refund and surface a clear error.
      const refund = await autoRefundAfterRecordFailure({
        paymentId: squarePaymentId,
        amount,
        eventDate,
        reservationId,
        recordError: recordErr,
        actor: user,
      });
      const baseMessage =
        String(recordErr?.message ?? "Failed to record payment after charge");
      const message = refund.refunded
        ? `${baseMessage}. The Square charge has been refunded automatically (refund ${refund.refundId ?? "issued"}).`
        : `${baseMessage}. Auto-refund FAILED — manual reconciliation required for Square payment ${squarePaymentId || "(unknown)"}.`;
      throw httpError(refund.refunded ? 409 : 502, message);
    }

    return json(
      200,
      {
        item,
        square: {
          method: recordedMethod,
          paymentId: squarePaymentId || null,
          status: square.payment?.status,
          receiptUrl: square.payment?.receipt_url ?? null,
          orderId: square.payment?.order_id ?? null,
          sourceType: square.payment?.source_type ?? null,
          idempotencyKey: square.idempotencyKey,
          env: square.squareEnv,
        },
      },
      cors
    );
  }

  const squarePaymentLinkMatch = path.match(/^\/reservations\/([^/]+)\/payment-link\/square$/);
  if (squarePaymentLinkMatch && method === "POST") {
    requireStaffOrAdmin(event);
    const reservationId = squarePaymentLinkMatch[1];
    const body = getBody(event);
    if (!body) return json(400, { message: "Invalid JSON body" }, cors);

    const eventDate = String(body?.eventDate ?? "").trim();
    const amountInput = body?.amount;
    const note = String(body?.note ?? "").trim();
    const idempotencyKey = String(body?.idempotencyKey ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) {
      return json(400, { message: "eventDate must be YYYY-MM-DD" }, cors);
    }

    if (typeof releaseOverdueReservationsForEventDate === "function") {
      await releaseOverdueReservationsForEventDate(eventDate);
    }
    const reservation = await getReservationById(eventDate, reservationId);
    if (String(reservation?.status ?? "").toUpperCase() !== "CONFIRMED") {
      return json(400, { message: "Only confirmed reservations can receive payment links" }, cors);
    }
    if (String(reservation?.paymentStatus ?? "").toUpperCase() === "COURTESY") {
      return json(400, { message: "Cannot create payment links for courtesy reservations" }, cors);
    }

    const amountDue = Number(reservation?.amountDue ?? 0);
    const paid = Number(reservation?.depositAmount ?? 0);
    const remainingAmount = Math.max(0, amountDue - paid);
    if (remainingAmount <= 0) {
      return json(400, { message: "Reservation is already fully paid" }, cors);
    }

    let requestedAmount = remainingAmount;
    if (amountInput !== undefined && amountInput !== null && String(amountInput).trim() !== "") {
      const parsed = Number(amountInput);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return json(400, { message: "amount must be > 0" }, cors);
      }
      if (parsed > remainingAmount) {
        return json(400, { message: "amount cannot exceed remaining balance" }, cors);
      }
      requestedAmount = parsed;
    }

    const reservationTableIdsForLink = getReservationTableIds(reservation);
    const square = await createSquarePaymentLink({
      reservationId,
      eventDate,
      tableId: reservationTableIdsForLink[0] ?? null,
      tableIds: reservationTableIdsForLink,
      customerName: String(reservation?.customerName ?? "").trim(),
      phone: String(reservation?.phone ?? "").trim(),
      amount: requestedAmount,
      note,
      idempotencyKey: idempotencyKey || undefined,
    });

    const paymentLink = square.paymentLink ?? {};
    const paymentLinkUrl = String(paymentLink?.url ?? "").trim();
    if (!paymentLinkUrl) {
      return json(502, { message: "Square payment link response missing url" }, cors);
    }
    const user = await getUserLabel(event);
    const reservationAfterLink =
      typeof setReservationPaymentLinkWindow === "function"
        ? await setReservationPaymentLinkWindow({
            eventDate,
            reservationId,
            paymentLinkId: String(paymentLink?.id ?? "").trim(),
            paymentLinkUrl,
            actor: user,
          })
        : reservation;
    const afterLinkTableIds = getReservationTableIds(
      reservationAfterLink ?? reservation
    );

    return json(
      200,
      {
        reservation: {
          reservationId,
          eventDate,
          tableId: afterLinkTableIds[0] ?? null,
          tableIds: afterLinkTableIds,
          paymentStatus:
            reservationAfterLink?.paymentStatus ?? reservation?.paymentStatus ?? null,
          amountDue,
          paid,
          remainingAmount,
          linkAmount: requestedAmount,
          paymentDeadlineAt:
            reservationAfterLink?.paymentDeadlineAt ??
            reservation?.paymentDeadlineAt ??
            null,
          paymentDeadlineTz:
            reservationAfterLink?.paymentDeadlineTz ??
            reservation?.paymentDeadlineTz ??
            null,
        },
        square: {
          env: square.squareEnv,
          idempotencyKey: square.idempotencyKey,
          paymentLinkId: paymentLink?.id ?? null,
          version: paymentLink?.version ?? null,
          url: paymentLinkUrl,
          orderId: paymentLink?.order_id ?? null,
          audit: {
            phonePrefillAttempted: Boolean(square?.audit?.phonePrefillAttempted),
            phonePrefillUsed: Boolean(square?.audit?.phonePrefillUsed),
            phonePrefillFallbackUsed: Boolean(square?.audit?.phonePrefillFallbackUsed),
            phonePrefillStatus: String(square?.audit?.phonePrefillStatus ?? "unknown"),
          },
        },
      },
      cors
    );
  }

  const squarePaymentLinkSmsMatch = path.match(/^\/reservations\/([^/]+)\/payment-link\/square\/sms$/);
  if (squarePaymentLinkSmsMatch && method === "POST") {
    requireStaffOrAdmin(event);
    if (typeof sendPaymentLinkSms !== "function") {
      return json(500, { message: "SMS service is not configured" }, cors);
    }
    const reservationId = squarePaymentLinkSmsMatch[1];
    const routeStartedAtMs = Date.now();
    const requestId = String(
      event?.requestContext?.requestId ??
        event?.requestContext?.http?.requestId ??
        ""
    ).trim() || null;
    let routeOutcome = "error";

    console.info("payment_link_sms_route_start", {
      reservationId,
      requestId,
    });

    try {
      const body = getBody(event);
      if (!body) {
        routeOutcome = "bad_request";
        return json(400, { message: "Invalid JSON body" }, cors);
      }

      const eventDate = String(body?.eventDate ?? "").trim();
      const amountInput = body?.amount;
      const note = String(body?.note ?? "").trim();
      const idempotencyKey = String(body?.idempotencyKey ?? "").trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) {
        routeOutcome = "bad_request";
        return json(400, { message: "eventDate must be YYYY-MM-DD" }, cors);
      }

      if (typeof releaseOverdueReservationsForEventDate === "function") {
        await releaseOverdueReservationsForEventDate(eventDate);
      }
      const reservation = await getReservationById(eventDate, reservationId);
      if (String(reservation?.status ?? "").toUpperCase() !== "CONFIRMED") {
        routeOutcome = "bad_request";
        return json(400, { message: "Only confirmed reservations can receive payment links" }, cors);
      }
      if (String(reservation?.paymentStatus ?? "").toUpperCase() === "COURTESY") {
        routeOutcome = "bad_request";
        return json(400, { message: "Cannot create payment links for courtesy reservations" }, cors);
      }

      const amountDue = Number(reservation?.amountDue ?? 0);
      const paid = Number(reservation?.depositAmount ?? 0);
      const remainingAmount = Math.max(0, amountDue - paid);
      if (remainingAmount <= 0) {
        routeOutcome = "bad_request";
        return json(400, { message: "Reservation is already fully paid" }, cors);
      }

      let requestedAmount = remainingAmount;
      if (amountInput !== undefined && amountInput !== null && String(amountInput).trim() !== "") {
        const parsed = Number(amountInput);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          routeOutcome = "bad_request";
          return json(400, { message: "amount must be > 0" }, cors);
        }
        if (parsed > remainingAmount) {
          routeOutcome = "bad_request";
          return json(400, { message: "amount cannot exceed remaining balance" }, cors);
        }
        requestedAmount = parsed;
      }

      const smsReservationTableIds = getReservationTableIds(reservation);
      const square = await createSquarePaymentLink({
        reservationId,
        eventDate,
        tableId: smsReservationTableIds[0] ?? null,
        tableIds: smsReservationTableIds,
        customerName: String(reservation?.customerName ?? "").trim(),
        phone: String(reservation?.phone ?? "").trim(),
        amount: requestedAmount,
        note,
        idempotencyKey: idempotencyKey || undefined,
      });

      const paymentLink = square.paymentLink ?? {};
      const paymentLinkUrl = String(paymentLink?.url ?? "").trim();
      if (!paymentLinkUrl) {
        routeOutcome = "provider_error";
        return json(502, { message: "Square payment link response missing url" }, cors);
      }
      const user = await getUserLabel(event);
      const reservationAfterLink =
        typeof setReservationPaymentLinkWindow === "function"
          ? await setReservationPaymentLinkWindow({
              eventDate,
              reservationId,
              paymentLinkId: String(paymentLink?.id ?? "").trim(),
              paymentLinkUrl,
              actor: user,
            })
          : reservation;
      const afterLinkTableIds = getReservationTableIds(
        reservationAfterLink ?? reservation
      );

      console.info("payment_link_sms_requested", {
        reservationId,
        eventDate,
        tableId: afterLinkTableIds[0] ?? null,
        tableIds: afterLinkTableIds,
        customerName:
          String(
            reservationAfterLink?.customerName ?? reservation?.customerName ?? ""
          ).trim() || null,
        phone:
          String(reservationAfterLink?.phone ?? reservation?.phone ?? "").trim() || null,
        linkAmount: requestedAmount,
        paymentLinkId: String(paymentLink?.id ?? "").trim() || null,
        requestId,
        actor: user,
      });

      let sms;
      try {
        sms = await sendPaymentLinkSms({
          phone: reservationAfterLink?.phone ?? reservation?.phone,
          customerName:
            reservationAfterLink?.customerName ?? reservation?.customerName,
          eventDate,
          tableId: afterLinkTableIds[0] ?? null,
          tableIds: afterLinkTableIds,
          paymentLinkUrl,
        });
      } catch (err) {
        if (typeof appendReservationHistory === "function") {
          await appendReservationHistory({
            eventDate,
            reservationId,
            eventType: "PAYMENT_LINK_SMS_FAILED",
            actor: user,
            source: "staff",
            tableId: afterLinkTableIds[0] ?? null,
            tableIds: afterLinkTableIds,
            customerName:
              reservationAfterLink?.customerName ?? reservation?.customerName,
            details: {
              linkAmount: requestedAmount,
              paymentLinkId: String(paymentLink?.id ?? "").trim() || null,
              to:
                String(
                  reservationAfterLink?.phone ?? reservation?.phone ?? ""
                ).trim() || null,
              errorMessage: String(err?.message ?? "Failed to send SMS"),
            },
          });
        }
        console.warn("payment_link_sms_failed", {
          reservationId,
          eventDate,
          paymentLinkId: String(paymentLink?.id ?? "").trim() || null,
          requestId,
          actor: user,
          message: String(err?.message ?? err ?? ""),
        });
        throw err;
      }

      if (typeof appendReservationHistory === "function") {
        await appendReservationHistory({
          eventDate,
          reservationId,
          eventType: "PAYMENT_LINK_SMS_SENT",
          actor: user,
          source: "staff",
          tableId: afterLinkTableIds[0] ?? null,
          tableIds: afterLinkTableIds,
          customerName:
            reservationAfterLink?.customerName ?? reservation?.customerName,
          details: {
            linkAmount: requestedAmount,
            paymentLinkId: String(paymentLink?.id ?? "").trim() || null,
            to:
              String(
                sms?.to ??
                  reservationAfterLink?.phone ??
                  reservation?.phone ??
                  ""
              ).trim() || null,
            messageId: String(sms?.messageId ?? "").trim() || null,
            provider: String(sms?.provider ?? "").trim() || null,
          },
        });
      }

      console.info("payment_link_sms_sent", {
        reservationId,
        eventDate,
        paymentLinkId: String(paymentLink?.id ?? "").trim() || null,
        smsMessageId: String(sms?.messageId ?? "").trim() || null,
        to: String(sms?.to ?? "").trim() || null,
        requestId,
        actor: user,
      });

      routeOutcome = "success";
      return json(
        200,
        {
          reservation: {
            reservationId,
            eventDate,
            tableId: afterLinkTableIds[0] ?? null,
            tableIds: afterLinkTableIds,
            customerName:
              reservationAfterLink?.customerName ??
              reservation?.customerName ??
              null,
            phone: reservationAfterLink?.phone ?? reservation?.phone ?? null,
            paymentStatus:
              reservationAfterLink?.paymentStatus ??
              reservation?.paymentStatus ??
              null,
            amountDue,
            paid,
            remainingAmount,
            linkAmount: requestedAmount,
            paymentDeadlineAt:
              reservationAfterLink?.paymentDeadlineAt ??
              reservation?.paymentDeadlineAt ??
              null,
            paymentDeadlineTz:
              reservationAfterLink?.paymentDeadlineTz ??
              reservation?.paymentDeadlineTz ??
              null,
          },
          square: {
            env: square.squareEnv,
            idempotencyKey: square.idempotencyKey,
            paymentLinkId: paymentLink?.id ?? null,
            version: paymentLink?.version ?? null,
            url: paymentLinkUrl,
            orderId: paymentLink?.order_id ?? null,
            audit: {
              phonePrefillAttempted: Boolean(square?.audit?.phonePrefillAttempted),
              phonePrefillUsed: Boolean(square?.audit?.phonePrefillUsed),
              phonePrefillFallbackUsed: Boolean(square?.audit?.phonePrefillFallbackUsed),
              phonePrefillStatus: String(square?.audit?.phonePrefillStatus ?? "unknown"),
            },
          },
          sms,
        },
        cors
      );
    } catch (err) {
      console.error("payment_link_sms_route_error", {
        reservationId,
        requestId,
        durationMs: Date.now() - routeStartedAtMs,
        message: String(err?.message ?? err ?? ""),
      });
      throw err;
    } finally {
      console.info("payment_link_sms_route_end", {
        reservationId,
        requestId,
        outcome: routeOutcome,
        durationMs: Date.now() - routeStartedAtMs,
      });
    }
  }

  // ---------------------------------------------------------------------
  // Square Stand handoff routes
  // ---------------------------------------------------------------------
  // Single-iPad flow: Safari triggers the URL scheme; Square POS app on
  // the same device runs the swipe via the Stand reader; redirects back
  // to our callback page; FE POSTs /complete with the transaction id.
  // See services-square-stand-handoff.mjs for the full state machine.

  const standStartMatch = path.match(
    /^\/reservations\/([^/]+)\/payment\/square-stand\/start$/
  );
  if (standStartMatch && method === "POST") {
    requireStaffOrAdmin(event);
    if (typeof startSquareStandHandoff !== "function") {
      return json(500, { message: "Square Stand handoff is not configured" }, cors);
    }
    const reservationId = standStartMatch[1];
    const body = getBody(event);
    if (!body) return json(400, { message: "Invalid JSON body" }, cors);
    const eventDate = String(body?.eventDate ?? "").trim();
    const amount = Number(body?.amount);
    const note = String(body?.note ?? "").trim();
    const returnPath = String(body?.returnPath ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) {
      return json(400, { message: "eventDate must be YYYY-MM-DD" }, cors);
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return json(400, { message: "amount must be > 0" }, cors);
    }
    if (typeof releaseOverdueReservationsForEventDate === "function") {
      await releaseOverdueReservationsForEventDate(eventDate);
    }
    const user = await getUserLabel(event);
    const out = await startSquareStandHandoff({
      reservationId,
      eventDate,
      amount,
      note,
      returnPath,
      callbackUrl: squareStandCallbackUrl,
      actor: user,
    });
    return json(200, out, cors);
  }

  const standCompleteMatch = path.match(
    /^\/reservations\/([^/]+)\/payment\/square-stand\/complete$/
  );
  if (standCompleteMatch && method === "POST") {
    requireStaffOrAdmin(event);
    if (typeof completeSquareStandHandoff !== "function") {
      return json(500, { message: "Square Stand handoff is not configured" }, cors);
    }
    const reservationId = standCompleteMatch[1];
    const body = getBody(event);
    if (!body) return json(400, { message: "Invalid JSON body" }, cors);
    const handoffId = String(body?.handoffId ?? "").trim();
    const transactionId = String(body?.transactionId ?? "").trim();
    if (!handoffId) {
      return json(400, { message: "handoffId is required" }, cors);
    }
    if (!transactionId) {
      return json(400, { message: "transactionId is required" }, cors);
    }
    const user = await getUserLabel(event);
    const out = await completeSquareStandHandoff({
      reservationId,
      handoffId,
      transactionId,
      actor: user,
    });
    return json(200, out, cors);
  }

  const standCancelMatch = path.match(
    /^\/reservations\/([^/]+)\/payment\/square-stand\/cancel$/
  );
  if (standCancelMatch && method === "POST") {
    requireStaffOrAdmin(event);
    if (typeof cancelSquareStandHandoff !== "function") {
      return json(500, { message: "Square Stand handoff is not configured" }, cors);
    }
    const body = getBody(event);
    if (!body) return json(400, { message: "Invalid JSON body" }, cors);
    const handoffId = String(body?.handoffId ?? "").trim();
    const reason = String(body?.reason ?? "").trim();
    if (!handoffId) {
      return json(400, { message: "handoffId is required" }, cors);
    }
    const user = await getUserLabel(event);
    const out = await cancelSquareStandHandoff({
      handoffId,
      reason,
      actor: user,
    });
    return json(200, out, cors);
  }

  // PUT /reservations/{id}/tables -- change the table set on an existing
  // reservation (staff only). Single atomic TransactWrite swaps holds +
  // updates the reservation row + optionally collects the delta payment.
  // See services-reservations-table-change.mjs for the state machine.
  // (PUT for consistency with the cancel/payment routes; the API GW CORS
  // allowlist doesn't include PATCH and adding it would mean a CORS
  // change on shared prod infra.)
  const changeTablesMatch = path.match(/^\/reservations\/([^/]+)\/tables$/);
  if (changeTablesMatch && method === "PUT") {
    requireStaffOrAdmin(event);
    if (typeof changeReservationTables !== "function") {
      return json(500, { message: "Table change is not configured" }, cors);
    }
    const reservationId = changeTablesMatch[1];
    const body = getBody(event);
    if (!body) return json(400, { message: "Invalid JSON body" }, cors);
    const user = await getUserLabel(event);
    const out = await changeReservationTables(
      { ...body, reservationId },
      user
    );
    return json(200, out, cors);
  }

  // PUT /reservations/{id}/payment-deadline — push the deadline (and the
  // active link's advisory expiry, if any) into the future on a CONFIRMED
  // + PENDING|PARTIAL row. Staff use this to backfill existing events
  // when a frequent client needs more time to pay than the original
  // deadline allows. PUT (not PATCH) because the API GW HTTP API CORS
  // allowlist doesn't include PATCH — same constraint as /tables, /cancel.
  const extendDeadlineMatch = path.match(
    /^\/reservations\/([^/]+)\/payment-deadline$/
  );
  if (extendDeadlineMatch && method === "PUT") {
    requireStaffOrAdmin(event);
    if (typeof extendReservationPaymentDeadline !== "function") {
      return json(500, { message: "Deadline extension is not configured" }, cors);
    }
    const reservationId = extendDeadlineMatch[1];
    const body = getBody(event);
    if (!body) return json(400, { message: "Invalid JSON body" }, cors);
    const eventDate = String(body?.eventDate ?? "").trim();
    const paymentDeadlineAt = String(body?.paymentDeadlineAt ?? "").trim();
    const paymentDeadlineTz = String(body?.paymentDeadlineTz ?? "").trim();
    if (!eventDate) {
      return json(400, { message: "eventDate is required" }, cors);
    }
    if (!paymentDeadlineAt) {
      return json(400, { message: "paymentDeadlineAt is required" }, cors);
    }
    const user = await getUserLabel(event);
    const updated = await extendReservationPaymentDeadline({
      eventDate,
      reservationId,
      paymentDeadlineAt,
      paymentDeadlineTz,
      actor: user,
    });
    return json(200, { item: updated }, cors);
  }

  const cancelMatch = path.match(/^\/reservations\/([^/]+)\/cancel$/);
  if (cancelMatch && method === "PUT") {
    requireStaffOrAdmin(event);
    const reservationId = cancelMatch[1];
    const body = getBody(event);
    if (!body) return json(400, { message: "Invalid JSON body" }, cors);
    const eventDate = String(body?.eventDate ?? "").trim();
    // tableId in the body is optional now; cancelReservation derives the
    // hold-release list from reservation.tableIds. Kept here for legacy
    // staff clients that still send it as a sanity check.
    const tableId = String(body?.tableId ?? "").trim();
    const cancelReason = String(body?.cancelReason ?? "").trim();
    const resolutionType = String(body?.resolutionType ?? "CANCEL_NO_REFUND")
      .trim()
      .toUpperCase();
    if (!eventDate) {
      return json(400, { message: "eventDate is required" }, cors);
    }
    if (!cancelReason) {
      return json(400, { message: "cancelReason is required" }, cors);
    }
    const user = await getUserLabel(event);
    await cancelReservation(eventDate, reservationId, tableId || null, user, cancelReason, {
      resolutionType,
    });
    return noContent(204, cors);
  }

  return null;
}
