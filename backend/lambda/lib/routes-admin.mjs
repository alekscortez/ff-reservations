export async function handleAdminRoute(ctx) {
  const {
    method,
    path,
    event,
    cors,
    json,
    getGroupsFromEvent,
  } = ctx;

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
      cors
    );
  }

  return null;
}
