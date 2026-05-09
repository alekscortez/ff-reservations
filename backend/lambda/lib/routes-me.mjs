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
  } = ctx;

  if (method === "GET" && path === "/me/profile") {
    const sub = requireCustomerOwnership(event);
    const profile = await getProfile(sub);
    return json(200, profile, cors);
  }

  return null;
}
