import { isPassEligiblePaymentStatus } from "./services-reservations-shared.mjs";

export async function handleCheckInRoute(ctx) {
  const {
    method,
    path,
    event,
    cors,
    json,
    getBody,
    getUserLabel,
    requireStaffOrAdmin,
    getReservationById,
    issueCheckInPassForReservation,
    getActiveCheckInPassForReservation,
    getLatestCheckInPassForReservation,
    getPassPreviewByToken,
    verifyAndConsumeCheckInPass,
    generateGoogleWalletSaveUrl,
    googleWalletEnabled,
  } = ctx;

  if (method === "GET" && /^\/check-in\/pass\/?$/.test(path)) {
    const token = String(event?.queryStringParameters?.token ?? "").trim();
    if (!token) {
      return json(400, { message: "token is required" }, cors);
    }
    const pass = await getPassPreviewByToken(token);
    return json(200, { pass }, cors);
  }

  if (method === "POST" && (/^\/check-in\/?$/.test(path) || /^\/check-in\/verify\/?$/.test(path))) {
    requireStaffOrAdmin(event);
    const body = getBody(event);
    if (!body) return json(400, { message: "Invalid JSON body" }, cors);
    const token = String(body?.token ?? body?.qr ?? body?.code ?? "").trim();
    const scannerDevice = String(body?.scannerDevice ?? "").trim();
    const user = await getUserLabel(event);
    const result = await verifyAndConsumeCheckInPass({
      token,
      scannerUser: user,
      scannerDevice: scannerDevice || null,
    });
    return json(200, { result }, cors);
  }

  const reservationPassMatch = path.match(/^\/reservations\/([^/]+)\/check-in-pass\/?$/);
  if (reservationPassMatch && method === "POST") {
    requireStaffOrAdmin(event);
    const reservationId = String(reservationPassMatch[1] ?? "").trim();
    const body = getBody(event);
    if (!body) return json(400, { message: "Invalid JSON body" }, cors);
    const eventDate = String(body?.eventDate ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) {
      return json(400, { message: "eventDate must be YYYY-MM-DD" }, cors);
    }

    const reservation = await getReservationById(eventDate, reservationId);
    if (String(reservation?.status ?? "").toUpperCase() !== "CONFIRMED") {
      return json(400, { message: "Only confirmed reservations can receive check-in pass" }, cors);
    }
    if (!isPassEligiblePaymentStatus(reservation?.paymentStatus)) {
      return json(
        400,
        { message: "Reservation must be paid or marked courtesy before check-in pass can be issued" },
        cors
      );
    }

    const user = await getUserLabel(event);
    const reissue = Boolean(body?.reissue);
    const issued = await issueCheckInPassForReservation({
      reservation,
      issuedBy: user,
      reissue,
    });
    return json(200, issued, cors);
  }

  if (reservationPassMatch && method === "GET") {
    requireStaffOrAdmin(event);
    const reservationId = String(reservationPassMatch[1] ?? "").trim();
    const eventDate = String(event.queryStringParameters?.eventDate ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) {
      return json(400, { message: "eventDate is required (YYYY-MM-DD)" }, cors);
    }

    const reservation = await getReservationById(eventDate, reservationId);
    if (String(reservation?.status ?? "").toUpperCase() !== "CONFIRMED") {
      return json(400, { message: "Only confirmed reservations can receive check-in pass" }, cors);
    }
    if (!isPassEligiblePaymentStatus(reservation?.paymentStatus)) {
      return json(
        400,
        { message: "Reservation must be paid or marked courtesy before check-in pass can be issued" },
        cors
      );
    }

    const pass = await getActiveCheckInPassForReservation(reservationId, { includeToken: true });
    const latestPass = await getLatestCheckInPassForReservation(reservationId, {
      includeToken: false,
    });

    return json(
      200,
      {
        issued: false,
        reused: false,
        pass,
        latestPass,
      },
      cors
    );
  }

  // Staff Google Wallet save-URL: same eligibility gates as the Apple
  // pkpass + check-in pass paths; returns the customer-facing
  // pay.google.com link so staff can SMS/WhatsApp/copy it for Android
  // customers. The service is 501 until GCP credentials are set.
  const staffGoogleWalletMatch = path.match(
    /^\/reservations\/([^/]+)\/google-wallet-pass\/?$/
  );
  if (staffGoogleWalletMatch && method === "POST") {
    requireStaffOrAdmin(event);
    const reservationId = String(staffGoogleWalletMatch[1] ?? "").trim();
    const body = getBody(event);
    if (!body) return json(400, { message: "Invalid JSON body" }, cors);
    const eventDate = String(body?.eventDate ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) {
      return json(400, { message: "eventDate must be YYYY-MM-DD" }, cors);
    }

    if (typeof googleWalletEnabled === "function" && !googleWalletEnabled()) {
      return json(
        501,
        {
          message: "Google Wallet is not configured for this environment",
          code: "GOOGLE_WALLET_NOT_CONFIGURED",
        },
        cors
      );
    }

    const reservation = await getReservationById(eventDate, reservationId);
    if (String(reservation?.status ?? "").toUpperCase() !== "CONFIRMED") {
      return json(
        400,
        { message: "Only confirmed reservations can receive check-in pass" },
        cors
      );
    }
    if (!isPassEligiblePaymentStatus(reservation?.paymentStatus)) {
      return json(
        400,
        {
          message:
            "Reservation must be paid or marked courtesy before Google Wallet pass can be issued",
        },
        cors
      );
    }

    // Reuse the active check-in pass token; auto-issue if missing
    // (same idempotent path as the .pkpass route). The token is the
    // security primitive — Google Wallet object state is cosmetic.
    let activePass = null;
    if (typeof getActiveCheckInPassForReservation === "function") {
      activePass = await getActiveCheckInPassForReservation(reservationId, {
        includeToken: true,
      });
    }
    if (!activePass && typeof issueCheckInPassForReservation === "function") {
      const user = await getUserLabel(event);
      const issued = await issueCheckInPassForReservation({
        reservation,
        issuedBy: user,
        reissue: false,
      });
      activePass = issued?.pass ?? null;
    }
    if (!activePass?.token) {
      return json(
        404,
        {
          message: "No check-in pass available yet for this reservation",
          code: "PASS_NOT_READY",
        },
        cors
      );
    }

    if (typeof generateGoogleWalletSaveUrl !== "function") {
      return json(
        501,
        { message: "Google Wallet service unavailable" },
        cors
      );
    }
    const result = await generateGoogleWalletSaveUrl({
      reservation,
      checkInPass: activePass,
    });
    return json(
      200,
      {
        saveUrl: result.saveUrl,
        classId: result.classId,
        objectId: result.objectId,
      },
      cors
    );
  }

  return null;
}
