// Customer self-service routes. All require a customer access token
// (enforced by API Gateway via the customer-only authorizer + by
// requireCustomerOwnership at the Lambda layer for defense in depth).

export async function handleMeRoute(ctx) {
  const {
    method,
    path,
    event,
    cors,
    json,
    requireCustomerOwnership,
    getProfile,
    deleteAccount,
  } = ctx;

  if (method === "GET" && path === "/me/profile") {
    const sub = requireCustomerOwnership(event);
    const profile = await getProfile(sub);
    return json(200, profile, cors);
  }

  if (method === "GET" && path === "/me/reservations") {
    const sub = requireCustomerOwnership(event);
    const items = await ctx.listReservations(sub);
    return json(200, { items }, cors);
  }

  if (method === "DELETE" && path === "/me") {
    const sub = requireCustomerOwnership(event);
    const result = await deleteAccount(sub);
    return json(200, result, cors);
  }

  return null;
}
