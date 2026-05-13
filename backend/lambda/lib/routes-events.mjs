export async function handleEventsAndTablesRoute(ctx) {
  const {
    method,
    path,
    event,
    cors,
    TABLE_TEMPLATE,
    json,
    noContent,
    getBody,
    requireAdmin,
    requireStaffOrAdmin,
    getUserLabel,
    listEvents,
    getEventByDate,
    listTableLocks,
    listReservations,
    releaseOverdueReservationsForEventDate,
    getDisabledTablesFromFrequent,
    getEffectiveTables,
    createEvent,
    getEventById,
    updateEvent,
    deleteEvent,
    getAppSettings,
    resolveBusinessDate,
  } = ctx;

  const sanitizePublicTableStatus = (rawStatus) =>
    String(rawStatus ?? "").trim().toUpperCase() === "AVAILABLE"
      ? "AVAILABLE"
      : "UNAVAILABLE";

  // Per audit P2-C4: do NOT trigger overdue-release from this read path.
  // The release is owned by the EventBridge cron (runScheduledMaintenance).
  // Staff dashboard's `GET /reservations` still calls release for short-window
  // freshness; that's the only request-time release left for now.
  const buildTableStateForEvent = async (date) => {
    const eventRecord = await getEventByDate(date);
    if (!eventRecord) return null;
    const locks = await listTableLocks(date);
    const reservations =
      typeof listReservations === "function" ? await listReservations(date) : [];
    const reservationPaymentStatusById = new Map(
      (reservations ?? []).map((r) => [
        String(r.reservationId ?? "").trim(),
        String(r.paymentStatus ?? "").trim().toUpperCase(),
      ])
    );
    const disabledFromFrequent = await getDisabledTablesFromFrequent(eventRecord);
    const lockMap = new Map(locks.map((l) => [l.SK, l]));
    const tables = getEffectiveTables(eventRecord, disabledFromFrequent).map((t) => {
      const lock = lockMap.get(`TABLE#${t.id}`);
      if (!lock) return { ...t, status: t.disabled ? "DISABLED" : "AVAILABLE" };
      if (lock.lockType === "RESERVED") {
        const reservationId = String(lock.reservationId ?? "").trim();
        const paymentStatus = reservationPaymentStatusById.get(reservationId);
        if (paymentStatus === "PENDING" || paymentStatus === "PARTIAL") {
          return { ...t, status: "PENDING_PAYMENT" };
        }
        return { ...t, status: "RESERVED" };
      }
      if (lock.lockType === "HOLD") return { ...t, status: "HOLD" };
      return { ...t, status: t.disabled ? "DISABLED" : "AVAILABLE" };
    });
    return { eventRecord, tables };
  };

  if (method === "GET" && path === "/events") {
    requireStaffOrAdmin(event);
    const items = await listEvents();
    return json(200, { items }, cors);
  }

  if (method === "GET" && path === "/tables/template") {
    requireStaffOrAdmin(event);
    return json(200, { template: TABLE_TEMPLATE }, cors);
  }

  const tablesByDateMatch = path.match(/^\/tables\/for-event\/(\d{4}-\d{2}-\d{2})$/);
  if (tablesByDateMatch && method === "GET") {
    requireStaffOrAdmin(event);
    const date = tablesByDateMatch[1];
    const state = await buildTableStateForEvent(date);
    if (!state) return json(404, { message: "Event not found for date", date }, cors);
    const { eventRecord, tables } = state;
    return json(200, { event: eventRecord, tables }, cors);
  }

  if (method === "GET" && /^\/public\/availability\/?$/.test(path)) {
    const settings = typeof getAppSettings === "function" ? await getAppSettings() : null;
    if (!settings?.showClientFacingMap) {
      return json(404, { message: "Public availability is not enabled" }, cors);
    }

    const requestedDate = String(
      event?.queryStringParameters?.eventDate ??
      event?.queryStringParameters?.date ??
      ""
    ).trim();
    const validRequestedDate = /^\d{4}-\d{2}-\d{2}$/.test(requestedDate)
      ? requestedDate
      : null;

    const businessCtx =
      typeof resolveBusinessDate === "function"
        ? await resolveBusinessDate()
        : { businessDate: null };
    const businessDateRaw = String(businessCtx?.businessDate ?? "").trim();
    const businessDate = /^\d{4}-\d{2}-\d{2}$/.test(businessDateRaw)
      ? businessDateRaw
      : new Date().toISOString().slice(0, 10);
    const activeEvents = (await listEvents())
      .filter(
        (item) =>
          String(item?.status ?? "ACTIVE").toUpperCase() === "ACTIVE" &&
          /^\d{4}-\d{2}-\d{2}$/.test(String(item?.eventDate ?? ""))
      )
      .sort((a, b) =>
        String(a.eventDate ?? "").localeCompare(String(b.eventDate ?? ""))
      );
    const upcomingEvents = activeEvents.filter(
      (item) => String(item.eventDate ?? "") >= businessDate
    );

    const selectedEventDate =
      (validRequestedDate &&
      upcomingEvents.some((item) => String(item.eventDate) === validRequestedDate)
        ? validRequestedDate
        : null) ||
      upcomingEvents[0]?.eventDate ||
      null;

    if (!selectedEventDate) {
      return json(404, { message: "No upcoming active events available" }, cors);
    }

    const state = await buildTableStateForEvent(selectedEventDate);
    if (!state) {
      return json(404, { message: "Event not found for date", eventDate: selectedEventDate }, cors);
    }
    const { eventRecord, tables } = state;
    const publicTables = tables.map((t) => ({
      id: t.id,
      number: t.number,
      section: t.section,
      price: t.price,
      status: sanitizePublicTableStatus(t.status),
      available: t.status === "AVAILABLE",
    }));
    const availableCount = publicTables.filter((t) => t.available).length;
    const unavailableCount = publicTables.length - availableCount;

    return json(
      200,
      {
        event: {
          eventId: eventRecord.eventId,
          eventDate: eventRecord.eventDate,
          eventName: eventRecord.eventName,
          status: eventRecord.status,
        },
        businessDate: businessDate || null,
        asOfEpoch: Math.floor(Date.now() / 1000),
        counts: {
          total: publicTables.length,
          available: availableCount,
          unavailable: unavailableCount,
        },
        refreshSeconds: Number(settings?.tableAvailabilityPollingSeconds) || 10,
        sectionMapColors:
          settings?.sectionMapColors && typeof settings.sectionMapColors === "object"
            ? settings.sectionMapColors
            : undefined,
        customerContactPhoneE164:
          String(settings?.customerContactPhoneE164 ?? "").trim() || undefined,
        // Public anonymous-booking flags. Frontend uses these to decide
        // whether to render the "Tap to reserve" CTA on AVAILABLE tiles
        // and what cap to enforce on multi-table selection. turnstileSiteKey
        // is the public Cloudflare Turnstile site key that the frontend
        // mounts via the Turnstile widget script.
        allowAnonymousPublicBooking: Boolean(
          settings?.allowAnonymousPublicBooking
        ),
        anonymousMaxTablesPerBooking: Number(
          settings?.anonymousMaxTablesPerBooking ?? 4
        ),
        turnstileSiteKey:
          String(settings?.turnstileSiteKey ?? "").trim() || undefined,
        events: upcomingEvents.slice(0, 14).map((item) => ({
          eventDate: item.eventDate,
          eventName: item.eventName,
          status: item.status,
        })),
        tables: publicTables,
      },
      cors
    );
  }

  if (method === "POST" && path === "/events") {
    requireAdmin(event);
    const body = getBody(event);
    if (!body) return json(400, { message: "Invalid JSON body" }, cors);

    const user = await getUserLabel(event);
    const item = await createEvent(body, user);
    return json(201, { item }, cors);
  }

  const byDateMatch = path.match(/^\/events\/by-date\/(\d{4}-\d{2}-\d{2})$/);
  if (byDateMatch && method === "GET") {
    requireStaffOrAdmin(event);
    const date = byDateMatch[1];
    const item = await getEventByDate(date);
    if (!item) return json(404, { message: "Event not found for date", date }, cors);
    return json(200, { item }, cors);
  }

  const eventIdMatch = path.match(/^\/events\/([^/]+)$/);
  const eventId = eventIdMatch?.[1];

  if (eventId && method === "GET") {
    requireStaffOrAdmin(event);
    const item = await getEventById(eventId);
    if (!item) return json(404, { message: "Event not found" }, cors);
    return json(200, { item }, cors);
  }

  if (eventId && method === "PUT") {
    requireAdmin(event);
    const body = getBody(event);
    if (!body) return json(400, { message: "Invalid JSON body" }, cors);

    const user = await getUserLabel(event);
    const item = await updateEvent(eventId, body, user);
    return json(200, { item }, cors);
  }

  if (eventId && method === "DELETE") {
    requireAdmin(event);
    await deleteEvent(eventId);
    return noContent(204, cors);
  }

  return null;
}
