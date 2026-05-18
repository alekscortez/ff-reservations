export async function handleClientsRoute(ctx) {
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
    listFrequentClients,
    createFrequentClient,
    getFrequentClientById,
    updateFrequentClient,
    deleteFrequentClient,
    listFrequentClientActiveLinks,
    listCrmClients,
    updateCrmClient,
    deleteCrmClient,
    searchCrmClients,
    listRescheduleCreditsByPhone,
    bulkImportCrmClients,
  } = ctx;

  if (method === "GET" && path === "/frequent-clients") {
    requireStaffOrAdmin(event);
    const items = await listFrequentClients();
    return json(200, { items }, cors);
  }

  if (method === "POST" && path === "/frequent-clients") {
    requireAdmin(event);
    const body = getBody(event);
    if (!body) return json(400, { message: "Invalid JSON body" }, cors);
    const user = await getUserLabel(event);
    const item = await createFrequentClient(body, user);
    return json(201, { item }, cors);
  }

  const frequentActiveLinksMatch = path.match(
    /^\/frequent-clients\/([^/]+)\/active-links$/
  );
  if (frequentActiveLinksMatch && method === "GET") {
    requireStaffOrAdmin(event);
    if (typeof listFrequentClientActiveLinks !== "function") {
      return json(500, { message: "Active-links lookup is not configured" }, cors);
    }
    const clientId = frequentActiveLinksMatch[1];
    const items = await listFrequentClientActiveLinks(clientId);
    return json(200, { items }, cors);
  }

  const frequentMatch = path.match(/^\/frequent-clients\/([^/]+)$/);
  if (frequentMatch && method === "GET") {
    requireStaffOrAdmin(event);
    const clientId = frequentMatch[1];
    const item = await getFrequentClientById(clientId);
    if (!item) return json(404, { message: "Client not found" }, cors);
    return json(200, { item }, cors);
  }

  if (frequentMatch && method === "PUT") {
    requireAdmin(event);
    const clientId = frequentMatch[1];
    const body = getBody(event);
    if (!body) return json(400, { message: "Invalid JSON body" }, cors);
    const item = await updateFrequentClient(clientId, body);
    return json(200, { item }, cors);
  }

  if (frequentMatch && method === "DELETE") {
    requireAdmin(event);
    const clientId = frequentMatch[1];
    await deleteFrequentClient(clientId);
    return noContent(204, cors);
  }

  if (method === "GET" && path === "/clients") {
    requireAdmin(event);
    const items = await listCrmClients();
    return json(200, { items }, cors);
  }

  if (method === "POST" && path === "/clients/bulk-import") {
    requireAdmin(event);
    const body = getBody(event);
    if (!body) return json(400, { message: "Invalid JSON body" }, cors);
    const user = await getUserLabel(event);
    const summary = await bulkImportCrmClients(body, user);
    return json(200, summary, cors);
  }

  const clientMatch = path.match(/^\/clients\/([^/]+)$/);
  if (clientMatch && method === "PUT") {
    requireAdmin(event);
    const phone = clientMatch[1];
    const body = getBody(event);
    if (!body) return json(400, { message: "Invalid JSON body" }, cors);
    const user = await getUserLabel(event);
    const item = await updateCrmClient(phone, body, user);
    return json(200, { item }, cors);
  }

  if (clientMatch && method === "DELETE") {
    requireAdmin(event);
    const phone = clientMatch[1];
    await deleteCrmClient(phone);
    return noContent(204, cors);
  }

  if (method === "GET" && path === "/clients/search") {
    requireStaffOrAdmin(event);
    const phone = String(event.queryStringParameters?.phone ?? "").trim();
    const q = String(event.queryStringParameters?.q ?? "").trim();
    if (!phone && !q) {
      return json(400, { message: "phone or q is required" }, cors);
    }
    const items = await searchCrmClients({ phone, q });
    return json(200, { items }, cors);
  }

  if (method === "GET" && path === "/clients/credits") {
    requireStaffOrAdmin(event);
    const phone = String(event.queryStringParameters?.phone ?? "").trim();
    const phoneCountry = String(event.queryStringParameters?.phoneCountry ?? "US").trim();
    if (!phone) return json(400, { message: "phone is required" }, cors);
    const items = await listRescheduleCreditsByPhone(phone, phoneCountry);
    return json(200, { items }, cors);
  }

  return null;
}
