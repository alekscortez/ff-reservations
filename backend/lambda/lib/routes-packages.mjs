// Birthday packages — admin CRUD + public browse.
//
// Routes:
//   POST   /packages              (Admin)
//   GET    /packages              (Staff/Admin) — all (active + inactive)
//   GET    /packages/{packageId}  (Staff/Admin)
//   PUT    /packages/{packageId}  (Admin)
//   DELETE /packages/{packageId}  (Admin) — soft-delete (status INACTIVE)
//                                  Hard-deletes if already INACTIVE.
//   GET    /public/packages              (no auth) — ACTIVE only
//   GET    /public/packages/{packageId}  (no auth) — ACTIVE only

export async function handlePackagesRoute(ctx) {
  const {
    method,
    path,
    event,
    cors,
    json,
    noContent,
    getBody,
    requireAdmin,
    requireStaffOrAdmin,
    getUserLabel,
    listPackages,
    getPackageById,
    createPackage,
    updatePackage,
    deletePackage,
  } = ctx;

  if (method === "GET" && path === "/public/packages") {
    const items = await listPackages({ activeOnly: true });
    return json(200, { items }, cors);
  }

  const publicByIdMatch = path.match(/^\/public\/packages\/([^/]+)$/);
  if (publicByIdMatch && method === "GET") {
    const item = await getPackageById(publicByIdMatch[1]);
    if (!item || item.status !== "ACTIVE") {
      return json(404, { message: "Package not found" }, cors);
    }
    return json(200, { item }, cors);
  }

  if (method === "POST" && path === "/packages") {
    requireAdmin(event);
    const body = await getBody(event);
    if (!body) return json(400, { message: "Invalid JSON body" }, cors);
    const user = await getUserLabel(event);
    const item = await createPackage(body, user);
    return json(201, { item }, cors);
  }

  if (method === "GET" && path === "/packages") {
    requireStaffOrAdmin(event);
    const items = await listPackages();
    return json(200, { items }, cors);
  }

  const adminByIdMatch = path.match(/^\/packages\/([^/]+)$/);
  const packageId = adminByIdMatch?.[1];

  if (packageId && method === "GET") {
    requireStaffOrAdmin(event);
    const item = await getPackageById(packageId);
    if (!item) return json(404, { message: "Package not found" }, cors);
    return json(200, { item }, cors);
  }

  if (packageId && method === "PUT") {
    requireAdmin(event);
    const body = await getBody(event);
    if (!body) return json(400, { message: "Invalid JSON body" }, cors);
    const user = await getUserLabel(event);
    const item = await updatePackage(packageId, body, user);
    return json(200, { item }, cors);
  }

  if (packageId && method === "DELETE") {
    requireAdmin(event);
    const user = await getUserLabel(event);
    const result = await deletePackage(packageId, user);
    if (!result) return json(404, { message: "Package not found" }, cors);
    return json(200, result, cors);
  }

  return null;
}
