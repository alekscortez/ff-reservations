import { createHash, randomUUID, timingSafeEqual } from "crypto";

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
    releaseOverdueReservationsForEventDate,
    addReservationPayment,
    setReservationPaymentLinkWindow,
    setReservationCashAppLinkSession,
    markReservationCashAppLinkSessionUsed,
    appendReservationHistory,
    createSquarePayment,
    createSquarePaymentLink,
    refundSquarePayment,
    sendPaymentLinkSms,
    cancelReservation,
    getRuntimeSettingsSubset,
    getEventByDate,
    cashAppLinkBaseUrl,
    checkInPassBaseUrl,
  } = ctx;

  const DEFAULT_CASH_APP_LINK_TTL_MINUTES = 10;

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

  const clampInt = (value, min, max, fallback) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    const rounded = Math.round(parsed);
    return Math.min(max, Math.max(min, rounded));
  };

  const normalizeToken = (value) => String(value ?? "").trim();

  const hashToken = (value) =>
    createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");

  const hexEqualsConstantTime = (a, b) => {
    if (!a || !b || a.length !== b.length) return false;
    if (!/^[a-f0-9]+$/i.test(a) || !/^[a-f0-9]+$/i.test(b)) return false;
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  };

  const resolveCashAppLinkBaseUrl = () => {
    const explicit = String(cashAppLinkBaseUrl ?? "").trim();
    if (explicit) {
      try {
        const parsed = new URL(explicit);
        const pathname = String(parsed.pathname ?? "").trim();
        if (!pathname || pathname === "/") {
          return `${parsed.origin}/pay`;
        }
        return explicit;
      } catch {
        return explicit;
      }
    }
    const passBase = String(checkInPassBaseUrl ?? "").trim();
    if (passBase) {
      try {
        const parsed = new URL(passBase);
        return `${parsed.origin}/pay`;
      } catch {
        // fall through
      }
    }
    return "";
  };

  const buildCashAppLinkUrl = ({ eventDate, reservationId, token }) => {
    const base = resolveCashAppLinkBaseUrl();
    if (!base) return null;
    try {
      const parsed = new URL(base);
      parsed.searchParams.set("eventDate", eventDate);
      parsed.searchParams.set("reservationId", reservationId);
      parsed.searchParams.set("token", token);
      return parsed.toString();
    } catch {
      const joiner = base.includes("?") ? "&" : "?";
      return `${base}${joiner}eventDate=${encodeURIComponent(
        eventDate
      )}&reservationId=${encodeURIComponent(
        reservationId
      )}&token=${encodeURIComponent(token)}`;
    }
  };

  const resolveCashAppLinkTtlMinutes = async () => {
    const settings =
      typeof getRuntimeSettingsSubset === "function"
        ? await getRuntimeSettingsSubset()
        : null;
    const fromSettings = clampInt(
      settings?.paymentLinkTtlMinutes,
      5,
      240,
      Number.NaN
    );
    if (Number.isFinite(fromSettings)) return fromSettings;
    return DEFAULT_CASH_APP_LINK_TTL_MINUTES;
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

  const loadCashAppLinkSessionContext = async ({
    eventDate,
    reservationId,
    token,
    requireActiveSession = true,
  }) => {
    const normalizedEventDate = String(eventDate ?? "").trim();
    const normalizedReservationId = String(reservationId ?? "").trim();
    const normalizedToken = normalizeToken(token);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedEventDate)) {
      throw httpError(400, "eventDate must be YYYY-MM-DD");
    }
    if (!normalizedReservationId) {
      throw httpError(400, "reservationId is required");
    }
    if (!normalizedToken) {
      throw httpError(400, "token is required");
    }

    // Per audit P2-C4: anonymous customer-facing paths must not fan out
    // releaseOverdueReservationsForEventDate. The EventBridge cron owns it.
    const reservation = await getReservationById(
      normalizedEventDate,
      normalizedReservationId
    );
    const status = String(reservation?.status ?? "").trim().toUpperCase();
    if (status !== "CONFIRMED") {
      throw httpError(409, "This reservation is no longer eligible for payment");
    }
    const paymentStatus = String(reservation?.paymentStatus ?? "")
      .trim()
      .toUpperCase();
    if (paymentStatus === "PAID" || paymentStatus === "COURTESY") {
      throw httpError(409, "This reservation is already settled");
    }
    if (paymentStatus !== "PENDING" && paymentStatus !== "PARTIAL") {
      throw httpError(409, "This reservation is no longer eligible for online payment");
    }

    const amountDue = Number(reservation?.amountDue ?? 0);
    const paid = Number(reservation?.depositAmount ?? 0);
    const remainingAmount = Math.max(0, Number((amountDue - paid).toFixed(2)));
    if (remainingAmount <= 0) {
      throw httpError(409, "This reservation is already settled");
    }

    const tokenHash = hashToken(normalizedToken);
    const sessionTokenHash = String(
      reservation?.cashAppLinkTokenHash ?? ""
    )
      .trim()
      .toLowerCase();
    if (!hexEqualsConstantTime(sessionTokenHash, tokenHash)) {
      throw httpError(403, "Invalid or expired payment link");
    }
    const sessionStatus = String(
      reservation?.cashAppLinkStatus ?? ""
    )
      .trim()
      .toUpperCase();
    if (requireActiveSession && sessionStatus !== "ACTIVE") {
      throw httpError(409, "This payment link is no longer active");
    }
    const expiresAt = Number(
      reservation?.cashAppLinkExpiresAt ?? 0
    );
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isFinite(expiresAt) || expiresAt <= now) {
      throw httpError(410, "This payment link has expired");
    }

    const sessionAmountRaw = Number(
      reservation?.cashAppLinkAmount ?? 0
    );
    const sessionAmount =
      Number.isFinite(sessionAmountRaw) && sessionAmountRaw > 0
        ? sessionAmountRaw
        : remainingAmount;
    const chargeAmount = Math.min(
      remainingAmount,
      Number(sessionAmount.toFixed(2))
    );
    if (!Number.isFinite(chargeAmount) || chargeAmount <= 0) {
      throw httpError(409, "No payable amount remains for this reservation");
    }

    return {
      eventDate: normalizedEventDate,
      reservationId: normalizedReservationId,
      token: normalizedToken,
      tokenHash,
      reservation,
      amountDue,
      paid,
      remainingAmount,
      chargeAmount,
      expiresAt,
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
          const isCashAppRequested =
            paymentMethod === "cashapp" ||
            requestedPaymentMethod === "cashapp" ||
            requestedPaymentMethod === "client";
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
            } else if (isCashAppRequested && typeof setReservationCashAppLinkSession === "function") {
              autoPaymentMethod = "cashapp";
              autoLinkType = "cashapp-link";
              const defaultTtl = await resolveCashAppLinkTtlMinutes();
              const now = Math.floor(Date.now() / 1000);
              const expiresAt = now + defaultTtl * 60;
              const token = `${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "")}`;
              const tokenHash = hashToken(token);

              const reservationAfterLink = await setReservationCashAppLinkSession({
                eventDate,
                reservationId,
                tokenHash,
                amount: remainingAmount,
                expiresAt,
                actor: user,
              });

              const paymentLinkUrl = buildCashAppLinkUrl({ eventDate, reservationId, token });
              if (!paymentLinkUrl) {
                throw new Error(
                  "Cash App link base URL is not configured. Set CASH_APP_LINK_BASE_URL env var."
                );
              }

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
                ttlMinutes: defaultTtl,
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
                    paymentMethod: "cashapp",
                    linkType: "cashapp-link",
                    linkAmount: remainingAmount,
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
                paymentMethod: "cashapp",
                linkType: "cashapp-link",
                linkAmount: remainingAmount,
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

  const cashAppLinkMatch = path.match(/^\/reservations\/([^/]+)\/cashapp-link\/square$/);
  if (cashAppLinkMatch && method === "POST") {
    requireStaffOrAdmin(event);
    const reservationId = String(cashAppLinkMatch[1] ?? "").trim();
    const body = getBody(event);
    if (!body) return json(400, { message: "Invalid JSON body" }, cors);
    const eventDate = String(body?.eventDate ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) {
      return json(400, { message: "eventDate must be YYYY-MM-DD" }, cors);
    }

    if (typeof releaseOverdueReservationsForEventDate === "function") {
      await releaseOverdueReservationsForEventDate(eventDate);
    }
    const reservation = await getReservationById(eventDate, reservationId);
    const status = String(reservation?.status ?? "").trim().toUpperCase();
    if (status !== "CONFIRMED") {
      return json(
        400,
        { message: "Only confirmed reservations can receive Cash App links" },
        cors
      );
    }
    const paymentStatus = String(reservation?.paymentStatus ?? "")
      .trim()
      .toUpperCase();
    if (paymentStatus !== "PENDING" && paymentStatus !== "PARTIAL") {
      return json(
        400,
        {
          message:
            "Only pending or partial reservations can receive Cash App links",
        },
        cors
      );
    }

    const amountDue = Number(reservation?.amountDue ?? 0);
    const paid = Number(reservation?.depositAmount ?? 0);
    const remainingAmount = Math.max(0, Number((amountDue - paid).toFixed(2)));
    if (remainingAmount <= 0) {
      return json(400, { message: "Reservation is already fully paid" }, cors);
    }

    let requestedAmount = remainingAmount;
    const amountInput = body?.amount;
    if (
      amountInput !== undefined &&
      amountInput !== null &&
      String(amountInput).trim() !== ""
    ) {
      const parsed = Number(amountInput);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return json(400, { message: "amount must be > 0" }, cors);
      }
      if (parsed > remainingAmount) {
        return json(400, { message: "amount cannot exceed remaining balance" }, cors);
      }
      requestedAmount = Number(parsed.toFixed(2));
    }

    const requestedTtl = Number(body?.ttlMinutes);
    const defaultTtl = await resolveCashAppLinkTtlMinutes();
    const ttlMinutes = Number.isFinite(requestedTtl)
      ? clampInt(requestedTtl, 5, 240, defaultTtl)
      : defaultTtl;
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + ttlMinutes * 60;

    const token = `${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "")}`;
    const tokenHash = hashToken(token);
    const actor = await getUserLabel(event);
    const updated = await setReservationCashAppLinkSession({
      eventDate,
      reservationId,
      tokenHash,
      amount: requestedAmount,
      expiresAt,
      actor,
    });

    const url = buildCashAppLinkUrl({ eventDate, reservationId, token });
    if (!url) {
      return json(
        500,
        {
          message:
            "Cash App link base URL is not configured. Set CASH_APP_LINK_BASE_URL env var.",
        },
        cors
      );
    }

    const effectiveExpiresAt = Number(updated?.cashAppLinkExpiresAt ?? expiresAt);
    const effectiveTtlMinutes =
      Number.isFinite(effectiveExpiresAt) && effectiveExpiresAt > now
        ? Math.max(1, Math.ceil((effectiveExpiresAt - now) / 60))
        : ttlMinutes;

    const cashAppLinkTableIds = getReservationTableIds(updated ?? reservation);

    return json(
      200,
      {
        reservation: {
          reservationId,
          eventDate,
          tableId: cashAppLinkTableIds[0] ?? null,
          tableIds: cashAppLinkTableIds,
          customerName:
            String(updated?.customerName ?? reservation?.customerName ?? "").trim() || null,
          phone: String(updated?.phone ?? reservation?.phone ?? "").trim() || null,
          paymentStatus:
            String(updated?.paymentStatus ?? reservation?.paymentStatus ?? "").trim() || null,
          amountDue,
          paid,
          remainingAmount,
          linkAmount: requestedAmount,
        },
        cashAppLink: {
          url,
          expiresAt: effectiveExpiresAt,
          ttlMinutes: effectiveTtlMinutes,
        },
      },
      cors
    );
  }

  const cashAppLinkSmsMatch = path.match(/^\/reservations\/([^/]+)\/cashapp-link\/square\/sms$/);
  if (cashAppLinkSmsMatch && method === "POST") {
    requireStaffOrAdmin(event);
    if (typeof sendPaymentLinkSms !== "function") {
      return json(500, { message: "SMS service is not configured" }, cors);
    }
    const reservationId = cashAppLinkSmsMatch[1];
    const body = getBody(event);
    if (!body) return json(400, { message: "Invalid JSON body" }, cors);

    const eventDate = String(body?.eventDate ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) {
      return json(400, { message: "eventDate must be YYYY-MM-DD" }, cors);
    }

    if (typeof releaseOverdueReservationsForEventDate === "function") {
      await releaseOverdueReservationsForEventDate(eventDate);
    }
    const reservation = await getReservationById(eventDate, reservationId);
    const status = String(reservation?.status ?? "").trim().toUpperCase();
    if (status !== "CONFIRMED") {
      return json(
        400,
        { message: "Only confirmed reservations can receive Cash App links" },
        cors
      );
    }
    const paymentStatus = String(reservation?.paymentStatus ?? "")
      .trim()
      .toUpperCase();
    if (paymentStatus !== "PENDING" && paymentStatus !== "PARTIAL") {
      return json(
        400,
        {
          message:
            "Only pending or partial reservations can receive Cash App links",
        },
        cors
      );
    }

    const amountDue = Number(reservation?.amountDue ?? 0);
    const paid = Number(reservation?.depositAmount ?? 0);
    const remainingAmount = Math.max(0, Number((amountDue - paid).toFixed(2)));
    if (remainingAmount <= 0) {
      return json(400, { message: "Reservation is already fully paid" }, cors);
    }

    let requestedAmount = remainingAmount;
    const amountInput = body?.amount;
    if (
      amountInput !== undefined &&
      amountInput !== null &&
      String(amountInput).trim() !== ""
    ) {
      const parsed = Number(amountInput);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return json(400, { message: "amount must be > 0" }, cors);
      }
      if (parsed > remainingAmount) {
        return json(400, { message: "amount cannot exceed remaining balance" }, cors);
      }
      requestedAmount = Number(parsed.toFixed(2));
    }

    const requestedTtl = Number(body?.ttlMinutes);
    const defaultTtl = await resolveCashAppLinkTtlMinutes();
    const ttlMinutes = Number.isFinite(requestedTtl)
      ? clampInt(requestedTtl, 5, 240, defaultTtl)
      : defaultTtl;
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + ttlMinutes * 60;

    const token = `${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "")}`;
    const tokenHash = hashToken(token);
    const actor = await getUserLabel(event);
    const updated = await setReservationCashAppLinkSession({
      eventDate,
      reservationId,
      tokenHash,
      amount: requestedAmount,
      expiresAt,
      actor,
    });

    const url = buildCashAppLinkUrl({ eventDate, reservationId, token });
    if (!url) {
      return json(
        500,
        {
          message:
            "Cash App link base URL is not configured. Set CASH_APP_LINK_BASE_URL env var.",
        },
        cors
      );
    }

    const cashAppSmsTableIds = getReservationTableIds(updated ?? reservation);
    let sms;
    try {
      sms = await sendPaymentLinkSms({
        phone: updated?.phone ?? reservation?.phone,
        customerName: updated?.customerName ?? reservation?.customerName,
        eventDate,
        tableId: cashAppSmsTableIds[0] ?? null,
        tableIds: cashAppSmsTableIds,
        paymentLinkUrl: url,
        ttlMinutes,
      });
    } catch (err) {
      if (typeof appendReservationHistory === "function") {
        await appendReservationHistory({
          eventDate,
          reservationId,
          eventType: "PAYMENT_LINK_SMS_FAILED",
          actor,
          source: "staff",
          tableId: cashAppSmsTableIds[0] ?? null,
          tableIds: cashAppSmsTableIds,
          customerName: updated?.customerName ?? reservation?.customerName,
          details: {
            paymentMethod: "cashapp",
            linkType: "cashapp-link",
            linkAmount: requestedAmount,
            to: String(updated?.phone ?? reservation?.phone ?? "").trim() || null,
            errorMessage: String(err?.message ?? "Failed to send SMS"),
          },
        });
      }
      throw err;
    }

    if (typeof appendReservationHistory === "function") {
      await appendReservationHistory({
        eventDate,
        reservationId,
        eventType: "PAYMENT_LINK_SMS_SENT",
        actor,
        source: "staff",
        tableId: cashAppSmsTableIds[0] ?? null,
        tableIds: cashAppSmsTableIds,
        customerName: updated?.customerName ?? reservation?.customerName,
        details: {
          paymentMethod: "cashapp",
          linkType: "cashapp-link",
          linkAmount: requestedAmount,
          to: String(sms?.to ?? updated?.phone ?? reservation?.phone ?? "").trim() || null,
          messageId: String(sms?.messageId ?? "").trim() || null,
          provider: String(sms?.provider ?? "").trim() || null,
        },
      });
    }

    const effectiveExpiresAt = Number(updated?.cashAppLinkExpiresAt ?? expiresAt);
    const effectiveTtlMinutes =
      Number.isFinite(effectiveExpiresAt) && effectiveExpiresAt > now
        ? Math.max(1, Math.ceil((effectiveExpiresAt - now) / 60))
        : ttlMinutes;

    return json(
      200,
      {
        reservation: {
          reservationId,
          eventDate,
          tableId: cashAppSmsTableIds[0] ?? null,
          tableIds: cashAppSmsTableIds,
          customerName:
            String(updated?.customerName ?? reservation?.customerName ?? "").trim() || null,
          phone: String(updated?.phone ?? reservation?.phone ?? "").trim() || null,
          paymentStatus:
            String(updated?.paymentStatus ?? reservation?.paymentStatus ?? "").trim() || null,
          amountDue,
          paid,
          remainingAmount,
          linkAmount: requestedAmount,
        },
        cashAppLink: {
          url,
          expiresAt: effectiveExpiresAt,
          ttlMinutes: effectiveTtlMinutes,
        },
        sms: {
          sent: true,
          provider: String(sms?.provider ?? "").trim() || null,
          messageId: String(sms?.messageId ?? "").trim() || null,
          to: String(sms?.to ?? "").trim() || null,
          sentAt: Number(sms?.sentAt ?? 0) || null,
        },
      },
      cors
    );
  }

  if (method === "GET" && /^\/cashapp\/session\/?$/.test(path)) {
    const eventDate = String(event?.queryStringParameters?.eventDate ?? "").trim();
    const reservationId = String(
      event?.queryStringParameters?.reservationId ?? ""
    ).trim();
    const token = String(event?.queryStringParameters?.token ?? "").trim();
    const context = await loadCashAppLinkSessionContext({
      eventDate,
      reservationId,
      token,
      requireActiveSession: true,
    });

    const runtimeSquare = await resolvePublicSquareSettings();
    if (!runtimeSquare.enabled) {
      return json(503, { message: "Online payment is not configured" }, cors);
    }
    const eventRecord =
      typeof getEventByDate === "function"
        ? await getEventByDate(context.eventDate)
        : null;

    const sessionTableIds = getReservationTableIds(context.reservation);
    return json(
      200,
      {
        reservation: {
          reservationId: context.reservationId,
          eventDate: context.eventDate,
          eventName: String(eventRecord?.eventName ?? "").trim() || null,
          tableId: sessionTableIds[0] ?? null,
          tableIds: sessionTableIds,
          customerName: String(context.reservation?.customerName ?? "").trim() || null,
          paymentStatus:
            String(context.reservation?.paymentStatus ?? "").trim() || null,
          amountDue: context.amountDue,
          paid: context.paid,
          remainingAmount: context.remainingAmount,
          chargeAmount: context.chargeAmount,
        },
        session: {
          expiresAt: context.expiresAt,
        },
        square: {
          envMode: runtimeSquare.envMode,
          applicationId: runtimeSquare.applicationId,
          locationId: runtimeSquare.locationId,
        },
      },
      cors
    );
  }

  if (method === "POST" && /^\/cashapp\/session\/charge\/?$/.test(path)) {
    const body = getBody(event);
    if (!body) return json(400, { message: "Invalid JSON body" }, cors);
    const eventDate = String(body?.eventDate ?? "").trim();
    const reservationId = String(body?.reservationId ?? "").trim();
    const token = String(body?.token ?? "").trim();
    const sourceId = String(body?.sourceId ?? "").trim();
    const idempotencyKey = String(body?.idempotencyKey ?? "").trim();
    if (!sourceId) {
      return json(400, { message: "sourceId is required" }, cors);
    }

    const context = await loadCashAppLinkSessionContext({
      eventDate,
      reservationId,
      token,
      requireActiveSession: true,
    });

    const square = await createSquarePayment({
      reservationId: context.reservationId,
      eventDate: context.eventDate,
      amount: context.chargeAmount,
      sourceId,
      note: `Cash App link payment for reservation ${context.reservationId} • ${context.eventDate}`,
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
        context.reservationId,
        {
          eventDate: context.eventDate,
          amount: context.chargeAmount,
          method: recordedMethod,
          source: "square-direct",
          note: "Client self-service Cash App link",
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
        "system:cashapp-link"
      );
    } catch (recordErr) {
      // Customer already paid via Cash App link. Auto-refund and surface a
      // clear error to the public pay page.
      const refund = await autoRefundAfterRecordFailure({
        paymentId: squarePaymentId,
        amount: context.chargeAmount,
        eventDate: context.eventDate,
        reservationId: context.reservationId,
        recordError: recordErr,
        actor: "system:cashapp-link",
      });
      const baseMessage =
        String(recordErr?.message ?? "Could not apply payment to reservation");
      const message = refund.refunded
        ? `${baseMessage}. Your charge has been refunded automatically.`
        : `${baseMessage}. Please contact the venue — payment id ${squarePaymentId || "(unknown)"}.`;
      throw httpError(refund.refunded ? 409 : 502, message);
    }

    await markReservationCashAppLinkSessionUsed({
      eventDate: context.eventDate,
      reservationId: context.reservationId,
      tokenHash: context.tokenHash,
      actor: "system:cashapp-link",
    });

    await appendReservationHistory({
      eventDate: context.eventDate,
      reservationId: context.reservationId,
      eventType: "CASH_APP_LINK_COMPLETED",
      actor: "system:cashapp-link",
      source: "client",
      tableId: String(item?.tableId ?? context.reservation?.tableId ?? "").trim() || null,
      customerName:
        String(item?.customerName ?? context.reservation?.customerName ?? "").trim() ||
        null,
      details: {
        amount: context.chargeAmount,
        method: recordedMethod,
        providerPaymentId: square.payment?.id ?? null,
        providerStatus: square.payment?.status ?? null,
      },
      at: Math.floor(Date.now() / 1000),
    });

    const chargeTableIds = getReservationTableIds(item ?? context.reservation);
    return json(
      200,
      {
        ok: true,
        reservation: {
          reservationId: context.reservationId,
          eventDate: context.eventDate,
          tableId: chargeTableIds[0] ?? null,
          tableIds: chargeTableIds,
          customerName:
            String(item?.customerName ?? context.reservation?.customerName ?? "").trim() ||
            null,
          paymentStatus: String(item?.paymentStatus ?? "").trim() || null,
          amountDue: Number(item?.amountDue ?? context.amountDue ?? 0),
          paid: Number(item?.depositAmount ?? 0),
          remainingAmount: Math.max(
            0,
            Number(item?.amountDue ?? context.amountDue ?? 0) -
              Number(item?.depositAmount ?? 0)
          ),
        },
        square: {
          method: recordedMethod,
          paymentId: square.payment?.id ?? null,
          status: square.payment?.status ?? null,
          receiptUrl: square.payment?.receipt_url ?? null,
          orderId: square.payment?.order_id ?? null,
          sourceType: square.payment?.source_type ?? null,
          env: square.squareEnv,
        },
      },
      cors
    );
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
