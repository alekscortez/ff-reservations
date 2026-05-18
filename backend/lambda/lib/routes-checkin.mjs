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

  return null;
}
