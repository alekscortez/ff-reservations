export async function handleUsersRoute(ctx) {
  const {
    method,
    path,
    event,
    cors,
    json,
    getBody,
    requireAdmin,
    listUsers,
    createUser,
    updateUserRole,
    updateUserStatus,
    resetUserPassword,
  } = ctx;

  if (method === "GET" && path === "/admin/users") {
    requireAdmin(event);
    const limit = Number(event?.queryStringParameters?.limit ?? 50);
    const nextToken = String(event?.queryStringParameters?.nextToken ?? "").trim();
    const result = await listUsers({
      limit,
      nextToken: nextToken || null,
    });
    return json(
      200,
      {
        items: result.items ?? [],
        nextToken: result.nextToken ?? null,
      },
      cors
    );
  }

  if (method === "POST" && path === "/admin/users") {
    requireAdmin(event);
    const body = getBody(event);
    if (!body) return json(400, { message: "Invalid JSON body" }, cors);
    const item = await createUser(body);
    return json(201, { item }, cors);
  }

  const roleMatch = path.match(/^\/admin\/users\/([^/]+)\/role$/);
  if (roleMatch && method === "PUT") {
    requireAdmin(event);
    const body = getBody(event);
    if (!body) return json(400, { message: "Invalid JSON body" }, cors);
    const username = decodeURIComponent(roleMatch[1]);
    const item = await updateUserRole(username, body?.role);
    return json(200, { item }, cors);
  }

  const statusMatch = path.match(/^\/admin\/users\/([^/]+)\/status$/);
  if (statusMatch && method === "PUT") {
    requireAdmin(event);
    const body = getBody(event);
    if (!body) return json(400, { message: "Invalid JSON body" }, cors);
    const username = decodeURIComponent(statusMatch[1]);
    const item = await updateUserStatus(username, body?.enabled);
    return json(200, { item }, cors);
  }

  const resetPasswordMatch = path.match(/^\/admin\/users\/([^/]+)\/reset-password$/);
  if (resetPasswordMatch && method === "POST") {
    requireAdmin(event);
    const username = decodeURIComponent(resetPasswordMatch[1]);
    const item = await resetUserPassword(username);
    return json(
      200,
      {
        ok: true,
        message: "Password reset requested. User will receive a reset message.",
        item,
      },
      cors
    );
  }

  return null;
}
