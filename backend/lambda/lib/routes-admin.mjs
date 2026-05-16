export async function handleAdminRoute(ctx) {
  const {
    method,
    path,
    event,
    cors,
    json,
    getGroupsFromEvent,
    requireStaffOrAdmin,
    requireAdmin,
    listPresence,
    getAnalyticsSummary,
  } = ctx;

  // Live-visitor count for the staff dashboard "Live now" tile. Reads
  // the PK="PRESENCE" rows that the telemetry handler writes; DDB TTL
  // (90s) handles staleness.
  if (method === "GET" && /^\/admin\/live-visitors\/?$/.test(path)) {
    if (typeof requireStaffOrAdmin === "function") {
      requireStaffOrAdmin(event);
    }
    if (typeof listPresence !== "function") {
      return json(501, { message: "Live-visitors service unavailable" }, cors);
    }
    const snapshot = await listPresence();
    return json(
      200,
      snapshot,
      { ...cors, "cache-control": "no-store", pragma: "no-cache" }
    );
  }

  // Marketing analytics summary for /admin/analytics (Layer 2). Returns
  // per-source visits + bookings + revenue + conversion for the
  // requested date window. Admin-only — financials data is sensitive.
  if (method === "GET" && /^\/admin\/analytics\/?$/.test(path)) {
    if (typeof requireAdmin === "function") {
      requireAdmin(event);
    }
    if (typeof getAnalyticsSummary !== "function") {
      return json(501, { message: "Analytics service unavailable" }, cors);
    }
    const q = event?.queryStringParameters ?? {};
    const today = new Date().toISOString().slice(0, 10);
    // Default: last 7 days inclusive of today.
    const defaultStart = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const startDate = /^\d{4}-\d{2}-\d{2}$/.test(String(q.startDate ?? ""))
      ? String(q.startDate)
      : defaultStart;
    const endDate = /^\d{4}-\d{2}-\d{2}$/.test(String(q.endDate ?? ""))
      ? String(q.endDate)
      : today;
    const summary = await getAnalyticsSummary({ startDate, endDate });
    return json(
      200,
      summary,
      { ...cors, "cache-control": "no-store", pragma: "no-cache" }
    );
  }

  if (method === "GET" && /^\/admin\/whoami\/?$/.test(path)) {
    const claims = event?.requestContext?.authorizer?.jwt?.claims ?? {};
    const sub = String(claims.sub ?? "").trim();
    const username = String(
      claims["cognito:username"] ?? claims.username ?? sub ?? ""
    ).trim();
    if (!sub && !username) {
      return json(401, { message: "Authentication required" }, cors);
    }
    const groups = getGroupsFromEvent(event);
    const role = groups.includes("Admin")
      ? "Admin"
      : groups.includes("Staff")
        ? "Staff"
        : "User";
    const hasGroups = groups.length > 0;
    const tokenUse = String(claims.token_use ?? "").trim().toLowerCase();
    return json(
      200,
      {
        sub: sub || null,
        username: username || null,
        email: String(claims.email ?? "").trim() || null,
        name: String(claims["custom:name"] ?? claims.name ?? "").trim() || null,
        groups,
        role,
        hasGroups,
        tokenUse: tokenUse || null,
        groupsClaimSource: hasGroups
          ? claims["cognito:groups"] !== undefined
            ? "cognito:groups"
            : claims["custom:groups"] !== undefined
              ? "custom:groups"
              : "unknown"
          : null,
        diagnostic: {
          // True when the access token was minted but the Pre Token Generation
          // Lambda did not inject groups. Frontend uses this to show a banner.
          missingGroupsLikelyPreTokenGen:
            tokenUse === "access" && !hasGroups,
        },
      },
      // Identity payload — keep intermediaries from caching it.
      { ...cors, "cache-control": "no-store", pragma: "no-cache" }
    );
  }

  return null;
}
