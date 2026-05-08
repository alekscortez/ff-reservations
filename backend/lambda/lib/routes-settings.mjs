export async function handleSettingsRoute(ctx) {
  const {
    method,
    path,
    event,
    cors,
    json,
    getBody,
    requireAdmin,
    requireStaffOrAdmin,
    getUserLabel,
    getAppSettings,
    updateAppSettings,
    resolveBusinessDate,
    runtimeSettingsSubset,
    getEventByDate,
    listEvents,
  } = ctx;

  if (method === "GET" && path === "/admin/settings") {
    requireAdmin(event);
    const item = await getAppSettings();
    return json(200, { item }, cors);
  }

  if (method === "PUT" && path === "/admin/settings") {
    requireAdmin(event);
    const body = getBody(event);
    if (!body) return json(400, { message: "Invalid JSON body" }, cors);
    const user = await getUserLabel(event);
    const item = await updateAppSettings(body, user);
    return json(200, { item }, cors);
  }

  if (method === "GET" && path === "/events/context/current") {
    requireStaffOrAdmin(event);

    const settings = await getAppSettings();
    const {
      businessDate,
      operatingTz,
      cutoffHour,
    } = await resolveBusinessDate();

    let currentEvent = null;
    try {
      currentEvent = await getEventByDate(businessDate);
    } catch {
      currentEvent = null;
    }

    let nextEvent = null;
    if (!currentEvent) {
      const events = await listEvents();
      nextEvent =
        [...(events ?? [])]
          .filter((item) => {
            const status = String(item?.status ?? "").toUpperCase();
            return status === "ACTIVE";
          })
          .filter((item) => String(item?.eventDate ?? "").trim() >= businessDate)
          .sort((a, b) =>
            String(a?.eventDate ?? "").localeCompare(String(b?.eventDate ?? ""))
          )[0] ?? null;
    }

    return json(
      200,
      {
        businessDate,
        event: currentEvent ?? null,
        nextEvent: nextEvent ?? null,
        settings: runtimeSettingsSubset(settings),
        operatingTz,
        operatingDayCutoffHour: cutoffHour,
      },
      cors
    );
  }

  return null;
}
