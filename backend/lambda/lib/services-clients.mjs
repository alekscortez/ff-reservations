import { randomUUID } from "crypto";
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

export function createClientsService({
  ddb,
  tableNames,
  requiredEnv,
  normalizePhone,
  normalizePhoneE164,
  normalizePhoneCountry,
  detectPhoneCountryFromE164,
  buildPhoneSearchCandidates,
  normalizeNameForSearch,
  nowEpoch,
  httpError,
  addDaysToIsoDate,
  getTablePriceForEvent,
}) {
  const {
    FREQUENT_CLIENTS_TABLE,
    CLIENTS_TABLE,
    HOLDS_TABLE,
    RES_TABLE,
  } = tableNames;

  function normalizePhoneForWrite(rawPhone, countryHint = "US") {
    const normalizedCountry = normalizePhoneCountry(countryHint);
    const phoneE164 = normalizePhoneE164(rawPhone, normalizedCountry);
    const phoneKey = normalizePhone(phoneE164 || rawPhone, normalizedCountry);
    const phoneCountry =
      detectPhoneCountryFromE164(phoneE164) ?? normalizedCountry;
    return { phoneE164, phoneKey, phoneCountry };
  }

  function normalizeTableList(value) {
    if (!value) return [];
    if (Array.isArray(value)) {
      return value.map((v) => String(v).trim()).filter(Boolean);
    }
    if (typeof value === "string") {
      return value
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean);
    }
    return [];
  }

  function normalizeTableSettings(value) {
    if (!Array.isArray(value)) return [];
    return value
      .map((s) => ({
        tableId: String(s?.tableId ?? "").trim(),
        paymentStatus: String(s?.paymentStatus ?? "PENDING").toUpperCase(),
        amountDue: Number(s?.amountDue ?? 0),
        amountPaid: Number(s?.amountPaid ?? 0),
        paymentDeadlineTime: String(s?.paymentDeadlineTime ?? "00:00"),
        paymentDeadlineTz: String(s?.paymentDeadlineTz ?? "America/Chicago"),
      }))
      .filter((s) => s.tableId);
  }

  function buildDefaultTableSetting(tableId, tablePrice) {
    return {
      tableId,
      paymentStatus: "PENDING",
      amountDue: Number(tablePrice ?? 0),
      amountPaid: 0,
      paymentDeadlineTime: "00:00",
      paymentDeadlineTz: "America/Chicago",
    };
  }

  async function listFrequentClients() {
    requiredEnv("FREQUENT_CLIENTS_TABLE", FREQUENT_CLIENTS_TABLE);
    const res = await ddb.send(
      new QueryCommand({
        TableName: FREQUENT_CLIENTS_TABLE,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeValues: {
          ":pk": "CLIENT",
          ":sk": "CLIENT#",
        },
      })
    );
    return (res.Items ?? []).map((x) => {
      const tables = normalizeTableList(x.defaultTableIds ?? x.defaultTableId);
      const tableSettings = normalizeTableSettings(x.tableSettings);
      return {
        ...x,
        defaultTableIds: tables,
        tableSettings,
      };
    });
  }

  async function getFrequentClientById(clientId) {
    requiredEnv("FREQUENT_CLIENTS_TABLE", FREQUENT_CLIENTS_TABLE);
    const res = await ddb.send(
      new GetCommand({
        TableName: FREQUENT_CLIENTS_TABLE,
        Key: { PK: "CLIENT", SK: `CLIENT#${clientId}` },
      })
    );
    if (!res.Item) return null;
    const tables = normalizeTableList(res.Item.defaultTableIds ?? res.Item.defaultTableId);
    const tableSettings = normalizeTableSettings(res.Item.tableSettings);
    return {
      ...res.Item,
      defaultTableIds: tables,
      tableSettings,
    };
  }

  async function createFrequentClient(payload, user) {
    requiredEnv("FREQUENT_CLIENTS_TABLE", FREQUENT_CLIENTS_TABLE);
    requiredEnv("CLIENTS_TABLE", CLIENTS_TABLE);
    const name = String(payload?.name ?? "").trim();
    const phoneRaw = String(payload?.phone ?? "").trim();
    const { phoneE164, phoneKey, phoneCountry } = normalizePhoneForWrite(
      phoneRaw,
      payload?.phoneCountry
    );
    const defaultTableIds = normalizeTableList(payload?.defaultTableIds ?? payload?.defaultTableId);
    const tableSettings = normalizeTableSettings(payload?.tableSettings);
    const notes = String(payload?.notes ?? "").trim();
    if (!name) throw httpError(400, "name is required");
    if (!phoneE164 || !phoneKey) {
      throw httpError(400, "phone must be a valid US or MX number");
    }
    if (!defaultTableIds.length) throw httpError(400, "defaultTableIds is required");

    const clientId = randomUUID();
    const item = {
      PK: "CLIENT",
      SK: `CLIENT#${clientId}`,
      clientId,
      name,
      phone: phoneE164,
      phoneCountry,
      defaultTableIds,
      tableSettings,
      notes,
      status: "ACTIVE",
      createdAt: nowEpoch(),
      createdBy: user,
    };

    await ddb.send(
      new PutCommand({
        TableName: FREQUENT_CLIENTS_TABLE,
        Item: item,
        ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
      })
    );

    await ddb.send(
      new UpdateCommand({
        TableName: CLIENTS_TABLE,
        Key: { PK: "CLIENT", SK: `PHONE#${phoneKey}` },
        UpdateExpression:
          "SET #name = :name, #phone = :phone, #phoneCountry = :phoneCountry, #updatedBy = :by, #lastReservationAt = if_not_exists(#lastReservationAt, :now), #lastEventDate = if_not_exists(#lastEventDate, :eventDate), #lastTableId = if_not_exists(#lastTableId, :tableId)",
        ExpressionAttributeNames: {
          "#name": "name",
          "#phone": "phone",
          "#phoneCountry": "phoneCountry",
          "#updatedBy": "updatedBy",
          "#lastReservationAt": "lastReservationAt",
          "#lastEventDate": "lastEventDate",
          "#lastTableId": "lastTableId",
        },
        ExpressionAttributeValues: {
          ":name": name || "Unknown",
          ":phone": phoneE164,
          ":phoneCountry": phoneCountry,
          ":by": user,
          ":now": nowEpoch(),
          ":eventDate": null,
          ":tableId": defaultTableIds[0] ?? null,
        },
      })
    );

    return item;
  }

  async function updateFrequentClient(clientId, payload) {
    requiredEnv("FREQUENT_CLIENTS_TABLE", FREQUENT_CLIENTS_TABLE);
    requiredEnv("CLIENTS_TABLE", CLIENTS_TABLE);
    const updates = [];
    const names = {};
    const values = {};

    const updatable = ["name", "notes", "status"];
    for (const key of updatable) {
      if (payload?.[key] !== undefined) {
        updates.push(`#${key} = :${key}`);
        names[`#${key}`] = key;
        values[`:${key}`] = payload[key];
      }
    }
    if (payload?.defaultTableIds !== undefined || payload?.defaultTableId !== undefined) {
      const next = normalizeTableList(payload?.defaultTableIds ?? payload?.defaultTableId);
      updates.push("#defaultTableIds = :defaultTableIds");
      names["#defaultTableIds"] = "defaultTableIds";
      values[":defaultTableIds"] = next;
    }
    if (payload?.tableSettings !== undefined) {
      const next = normalizeTableSettings(payload?.tableSettings);
      updates.push("#tableSettings = :tableSettings");
      names["#tableSettings"] = "tableSettings";
      values[":tableSettings"] = next;
    }
    if (payload?.phone !== undefined) {
      const normalized = normalizePhoneForWrite(payload.phone, payload?.phoneCountry);
      if (!normalized.phoneE164 || !normalized.phoneKey) {
        throw httpError(400, "phone must be a valid US or MX number");
      }
      updates.push("#phone = :phone");
      names["#phone"] = "phone";
      values[":phone"] = normalized.phoneE164;
      updates.push("#phoneCountry = :phoneCountry");
      names["#phoneCountry"] = "phoneCountry";
      values[":phoneCountry"] = normalized.phoneCountry;
    }
    updates.push("#updatedAt = :updatedAt");
    names["#updatedAt"] = "updatedAt";
    values[":updatedAt"] = nowEpoch();

    if (!updates.length) throw httpError(400, "No fields to update");

    const res = await ddb.send(
      new UpdateCommand({
        TableName: FREQUENT_CLIENTS_TABLE,
        Key: { PK: "CLIENT", SK: `CLIENT#${clientId}` },
        UpdateExpression: "SET " + updates.join(", "),
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ReturnValues: "ALL_NEW",
      })
    );
    const updated = res.Attributes ?? {};
    const updatedName = String(updated.name ?? "").trim();
    const normalizedUpdated = normalizePhoneForWrite(
      updated.phone ?? payload?.phone,
      updated.phoneCountry ?? payload?.phoneCountry
    );
    if (normalizedUpdated.phoneE164 && normalizedUpdated.phoneKey) {
      await ddb.send(
        new UpdateCommand({
          TableName: CLIENTS_TABLE,
          Key: { PK: "CLIENT", SK: `PHONE#${normalizedUpdated.phoneKey}` },
          UpdateExpression:
            "SET #name = :name, #phone = :phone, #phoneCountry = :phoneCountry, #updatedBy = :by, #lastTableId = if_not_exists(#lastTableId, :tableId)",
          ExpressionAttributeNames: {
            "#name": "name",
            "#phone": "phone",
            "#phoneCountry": "phoneCountry",
            "#updatedBy": "updatedBy",
            "#lastTableId": "lastTableId",
          },
          ExpressionAttributeValues: {
            ":name": updatedName || "Unknown",
            ":phone": normalizedUpdated.phoneE164,
            ":phoneCountry": normalizedUpdated.phoneCountry,
            ":by": "system",
            ":tableId": normalizeTableList(updated.defaultTableIds ?? updated.defaultTableId)[0] ?? null,
          },
        })
      );
    }
    return {
      ...updated,
      defaultTableIds: normalizeTableList(updated.defaultTableIds ?? updated.defaultTableId),
      tableSettings: normalizeTableSettings(updated.tableSettings),
    };
  }

  async function deleteFrequentClient(clientId) {
    requiredEnv("FREQUENT_CLIENTS_TABLE", FREQUENT_CLIENTS_TABLE);
    await ddb.send(
      new DeleteCommand({
        TableName: FREQUENT_CLIENTS_TABLE,
        Key: { PK: "CLIENT", SK: `CLIENT#${clientId}` },
      })
    );
  }

  async function upsertCrmClient(payload, user) {
    requiredEnv("CLIENTS_TABLE", CLIENTS_TABLE);
    const name = String(payload?.customerName ?? "").trim();
    const normalizedPhone = normalizePhoneForWrite(payload?.phone ?? "", payload?.phoneCountry);
    const phone = normalizedPhone.phoneKey;
    const phoneE164 = normalizedPhone.phoneE164;
    const phoneCountry = normalizedPhone.phoneCountry;
    const depositAmount = Number(payload?.depositAmount ?? 0);
    const eventDate = String(payload?.eventDate ?? "").trim();
    // Multi-table input: accept tableIds[] OR legacy tableId. The CRM row
    // records `lastTableId` as the first table (display convenience for
    // the staff form's typeahead) and adds `totalTables` so per-table
    // lifetime metrics survive multi-table bookings. `totalReservations`
    // is unchanged — semantically counts visits, not tables.
    const tableIdsInput = Array.isArray(payload?.tableIds)
      ? payload.tableIds.map((v) => String(v ?? "").trim()).filter(Boolean)
      : [];
    const singleTableId = String(payload?.tableId ?? "").trim();
    const tableIds =
      tableIdsInput.length > 0
        ? tableIdsInput
        : singleTableId
        ? [singleTableId]
        : [];
    const lastTableId = tableIds[0] ?? "";
    const tableCount = Math.max(1, tableIds.length);
    if (!phone || !phoneE164) return;

    await ddb.send(
      new UpdateCommand({
        TableName: CLIENTS_TABLE,
        Key: { PK: "CLIENT", SK: `PHONE#${phone}` },
        UpdateExpression:
          "SET #name = :name, #phone = :phone, #phoneCountry = :phoneCountry, #lastReservationAt = :now, #lastEventDate = :eventDate, #lastTableId = :tableId, #updatedBy = :by ADD #totalSpend :amt, #totalReservations :one, #totalTables :tableCount",
        ExpressionAttributeNames: {
          "#name": "name",
          "#phone": "phone",
          "#phoneCountry": "phoneCountry",
          "#lastReservationAt": "lastReservationAt",
          "#lastEventDate": "lastEventDate",
          "#lastTableId": "lastTableId",
          "#updatedBy": "updatedBy",
          "#totalSpend": "totalSpend",
          "#totalReservations": "totalReservations",
          "#totalTables": "totalTables",
        },
        ExpressionAttributeValues: {
          ":name": name || "Unknown",
          ":phone": phoneE164,
          ":phoneCountry": phoneCountry,
          ":now": nowEpoch(),
          ":eventDate": eventDate,
          ":tableId": lastTableId,
          ":by": user,
          ":amt": depositAmount,
          ":one": 1,
          ":tableCount": tableCount,
        },
      })
    );
  }

  async function bulkImportCrmClients(payload, user) {
    requiredEnv("CLIENTS_TABLE", CLIENTS_TABLE);
    const contacts = Array.isArray(payload?.contacts) ? payload.contacts : null;
    if (!contacts) throw httpError(400, "contacts must be an array");
    const MAX_BATCH = 500;
    if (contacts.length > MAX_BATCH) {
      throw httpError(400, `contacts must contain at most ${MAX_BATCH} entries per request`);
    }
    if (contacts.length === 0) {
      return { imported: 0, skipped: 0, invalid: 0, errors: 0, invalidDetails: [], errorDetails: [] };
    }

    const prepared = contacts.map((c, index) => {
      const name = String(c?.name ?? "").trim();
      const normalized = normalizePhoneForWrite(c?.phone ?? "", c?.phoneCountry);
      const totalReservations = Number.isFinite(Number(c?.totalReservations))
        ? Math.max(0, Math.floor(Number(c.totalReservations)))
        : 0;
      const totalSpend = Number.isFinite(Number(c?.totalSpend))
        ? Math.max(0, Number(c.totalSpend))
        : 0;
      const lastEventDate = String(c?.lastEventDate ?? "").trim();
      let lastReservationAt = null;
      const isoMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(lastEventDate);
      if (isoMatch) {
        const ms = Date.UTC(Number(isoMatch[1]), Number(isoMatch[2]) - 1, Number(isoMatch[3]));
        if (Number.isFinite(ms)) lastReservationAt = Math.floor(ms / 1000);
      }

      if (!name) {
        return { index, valid: false, reason: "name is required", phone: c?.phone ?? null };
      }
      if (!normalized.phoneE164 || !normalized.phoneKey) {
        return {
          index,
          valid: false,
          reason: "phone must be a valid US or MX number",
          phone: c?.phone ?? null,
        };
      }

      return {
        index,
        valid: true,
        item: {
          PK: "CLIENT",
          SK: `PHONE#${normalized.phoneKey}`,
          name,
          phone: normalized.phoneE164,
          phoneCountry: normalized.phoneCountry,
          totalReservations,
          totalSpend,
          lastReservationAt,
          lastEventDate: lastEventDate || null,
          updatedBy: user,
          importedAt: nowEpoch(),
          importedBy: user,
        },
      };
    });

    const summary = {
      imported: 0,
      skipped: 0,
      invalid: 0,
      errors: 0,
      invalidDetails: [],
      errorDetails: [],
    };

    for (const p of prepared) {
      if (!p.valid) {
        summary.invalid += 1;
        summary.invalidDetails.push({ index: p.index, phone: p.phone, reason: p.reason });
      }
    }

    const writable = prepared.filter((p) => p.valid);
    const CONCURRENCY = 10;
    let cursor = 0;

    async function worker() {
      while (cursor < writable.length) {
        const myIndex = cursor++;
        const entry = writable[myIndex];
        try {
          await ddb.send(
            new PutCommand({
              TableName: CLIENTS_TABLE,
              Item: entry.item,
              ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
            })
          );
          summary.imported += 1;
        } catch (err) {
          if (err?.name === "ConditionalCheckFailedException") {
            summary.skipped += 1;
            continue;
          }
          summary.errors += 1;
          summary.errorDetails.push({
            index: entry.index,
            phone: entry.item.phone,
            error: String(err?.message ?? err ?? "unknown"),
          });
        }
      }
    }

    const workers = Array.from({ length: Math.min(CONCURRENCY, writable.length) }, worker);
    await Promise.all(workers);
    return summary;
  }

  async function getDisabledTablesFromFrequent(eventRecord) {
    const disabledClients = new Set(eventRecord?.disabledClients ?? []);
    const releasedFrequentTables = new Set(eventRecord?.frequentReleasedTables ?? []);
    const clients = await listFrequentClients();
    const disabledTables = new Set();
    for (const c of clients) {
      if (c.status && String(c.status).toUpperCase() !== "ACTIVE") continue;
      if (disabledClients.has(c.clientId)) continue;
      const tables =
        (c.tableSettings?.length
          ? c.tableSettings.map((t) => t.tableId)
          : normalizeTableList(c.defaultTableIds ?? c.defaultTableId)) || [];
      for (const t of tables) {
        if (!releasedFrequentTables.has(t)) disabledTables.add(t);
      }
    }
    return disabledTables;
  }

  async function createFrequentReservationsForEvent(eventRecord, user) {
    requiredEnv("HOLDS_TABLE", HOLDS_TABLE);
    requiredEnv("RES_TABLE", RES_TABLE);

    const disabledClients = new Set(eventRecord?.disabledClients ?? []);
    const clients = await listFrequentClients();
    const now = nowEpoch();

    for (const c of clients) {
      if (c.status && String(c.status).toUpperCase() !== "ACTIVE") continue;
      if (disabledClients.has(c.clientId)) continue;

      const tableIds = c.tableSettings?.length
        ? c.tableSettings.map((t) => t.tableId)
        : normalizeTableList(c.defaultTableIds ?? c.defaultTableId);

      for (const tableId of tableIds) {
        const tablePrice = getTablePriceForEvent(eventRecord, tableId);
        if (tablePrice === null) continue;

        const setting =
          c.tableSettings?.find((t) => t.tableId === tableId) ??
          buildDefaultTableSetting(tableId, tablePrice);

        const amountDue =
          setting.paymentStatus === "COURTESY" ? 0 : Number(setting.amountDue ?? tablePrice);
        let amountPaid = Number(setting.amountPaid ?? 0);
        if (setting.paymentStatus === "PAID") amountPaid = amountDue;
        if (setting.paymentStatus === "COURTESY") amountPaid = 0;
        if (setting.paymentStatus === "PENDING") amountPaid = 0;

        let paymentStatus = String(setting.paymentStatus ?? "PENDING").toUpperCase();
        if (!["PENDING", "PARTIAL", "PAID", "COURTESY"].includes(paymentStatus)) {
          paymentStatus = "PENDING";
        }

        let paymentDeadlineAt = null;
        let paymentDeadlineTz = setting.paymentDeadlineTz || "America/Chicago";
        if (paymentStatus === "PENDING" || paymentStatus === "PARTIAL") {
          const time = setting.paymentDeadlineTime || "00:00";
          const deadlineDate = addDaysToIsoDate(eventRecord.eventDate, 1);
          paymentDeadlineAt = `${deadlineDate}T${time}:00`;
        }

        const reservationId = randomUUID();
        const holdKey = { PK: `EVENTDATE#${eventRecord.eventDate}`, SK: `TABLE#${tableId}` };
        const frequentPhone = normalizePhoneE164(c.phone ?? "", c.phoneCountry ?? "US");
        const frequentPhoneCountry =
          detectPhoneCountryFromE164(frequentPhone) ??
          normalizePhoneCountry(c.phoneCountry ?? "US");

        try {
          await ddb.send(
            new TransactWriteCommand({
              TransactItems: [
                {
                  Put: {
                    TableName: HOLDS_TABLE,
                    Item: {
                      ...holdKey,
                      lockType: "RESERVED",
                      reservationId,
                      createdAt: now,
                      createdBy: user,
                      customerName: c.name ?? null,
                      phone: frequentPhone || null,
                      phoneCountry: frequentPhone ? frequentPhoneCountry : null,
                    },
                    ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
                  },
                },
                {
                  Put: {
                    TableName: RES_TABLE,
                    Item: {
                      PK: `EVENTDATE#${eventRecord.eventDate}`,
                      SK: `RES#${reservationId}`,
                      reservationId,
                      eventDate: eventRecord.eventDate,
                      tableId,
                      customerName: c.name ?? "Frequent Client",
                      phone: frequentPhone || null,
                      phoneCountry: frequentPhone ? frequentPhoneCountry : null,
                      depositAmount: amountPaid,
                      amountDue,
                      tablePrice,
                      paymentStatus,
                      paymentDeadlineAt,
                      paymentDeadlineTz:
                        paymentStatus === "PAID" || paymentStatus === "COURTESY"
                          ? null
                          : paymentDeadlineTz,
                      paymentMethod: null,
                      payments: [],
                      reservationSource: "FREQUENT_AUTO",
                      frequentClientId: String(c.clientId ?? "").trim() || null,
                      status: "CONFIRMED",
                      createdAt: now,
                      createdBy: user,
                    },
                    ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
                  },
                },
              ],
            })
          );
        } catch (err) {
          if (
            err?.name === "TransactionCanceledException" ||
            err?.name === "ConditionalCheckFailedException"
          ) {
            continue;
          }
          throw err;
        }
      }
    }
  }

  async function listCrmClients() {
    requiredEnv("CLIENTS_TABLE", CLIENTS_TABLE);
    const res = await ddb.send(
      new QueryCommand({
        TableName: CLIENTS_TABLE,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeValues: {
          ":pk": "CLIENT",
          ":sk": "PHONE#",
        },
      })
    );
    const items = (res.Items ?? []).map((x) => ({
      name: x.name,
      phone: x.phone,
      phoneCountry: x.phoneCountry,
      totalSpend: x.totalSpend,
      totalReservations: x.totalReservations,
      totalTables: x.totalTables ?? null,
      lastReservationAt: x.lastReservationAt,
      lastEventDate: x.lastEventDate,
      lastTableId: x.lastTableId,
      updatedBy: x.updatedBy,
    }));
    items.sort((a, b) => (b.lastReservationAt ?? 0) - (a.lastReservationAt ?? 0));
    return items;
  }

  // Accepts { phone, q }. At least one must produce candidates. phone runs the
  // existing prefix-match query (cheap, indexed). q runs a Scan with a pushed-
  // down BeginsWith filter on PK (so the engine only walks CLIENT rows) +
  // accent-insensitive substring filter on the normalized name in JS. ~1.4k
  // rows ≈ <300ms cold; sub-50ms warm. If both are present, results are
  // de-duped on SK and merged.
  async function searchCrmClients(arg) {
    requiredEnv("CLIENTS_TABLE", CLIENTS_TABLE);

    // Backwards-compatible: callers that pass a string still get phone search.
    const phone = typeof arg === "string" ? arg : (arg?.phone ?? "");
    const q = typeof arg === "string" ? "" : String(arg?.q ?? "").trim();

    const collected = new Map();

    if (phone) {
      const candidates = buildPhoneSearchCandidates(phone);
      if (candidates.length) {
        const responses = await Promise.all(
          candidates.map((candidate) =>
            ddb.send(
              new QueryCommand({
                TableName: CLIENTS_TABLE,
                KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
                ExpressionAttributeValues: {
                  ":pk": "CLIENT",
                  ":sk": `PHONE#${candidate}`,
                },
                Limit: 10,
                ScanIndexForward: false,
              })
            )
          )
        );
        for (const res of responses) {
          for (const item of res.Items ?? []) {
            if (item?.SK) collected.set(String(item.SK), item);
          }
        }
      }
    }

    if (q.length >= 2) {
      const needle = normalizeNameForSearch(q);
      if (needle) {
        // Scan + server-side filter to PHONE# rows only, then JS-filter by
        // normalized substring. Pagination loop in case the table grows past
        // the 1MB scan page (we'll be fine for years at current volume).
        let exclusiveStartKey;
        do {
          const res = await ddb.send(
            new ScanCommand({
              TableName: CLIENTS_TABLE,
              FilterExpression: "PK = :pk AND begins_with(SK, :sk)",
              ExpressionAttributeValues: {
                ":pk": "CLIENT",
                ":sk": "PHONE#",
              },
              ExclusiveStartKey: exclusiveStartKey,
            })
          );
          for (const item of res.Items ?? []) {
            if (!item?.SK) continue;
            const name = normalizeNameForSearch(item.name ?? "");
            if (name && name.includes(needle)) {
              collected.set(String(item.SK), item);
            }
          }
          exclusiveStartKey = res.LastEvaluatedKey;
        } while (exclusiveStartKey);
      }
    }

    const items = [...collected.values()].map((x) => ({
      name: x.name,
      phone: x.phone,
      phoneCountry: x.phoneCountry,
      totalSpend: x.totalSpend,
      totalReservations: x.totalReservations,
      lastReservationAt: x.lastReservationAt,
      lastEventDate: x.lastEventDate,
      lastTableId: x.lastTableId,
      updatedBy: x.updatedBy,
    }));
    items.sort((a, b) => (b.lastReservationAt ?? 0) - (a.lastReservationAt ?? 0));
    return items.slice(0, 10);
  }

  async function updateCrmClient(phoneKey, payload, user) {
    requiredEnv("CLIENTS_TABLE", CLIENTS_TABLE);
    const currentPhone = normalizePhone(phoneKey);
    if (!currentPhone) throw httpError(400, "phone is required");

    const res = await ddb.send(
      new GetCommand({
        TableName: CLIENTS_TABLE,
        Key: { PK: "CLIENT", SK: `PHONE#${currentPhone}` },
      })
    );
    const current = res.Item;
    if (!current) throw httpError(404, "Client not found");

    const nextName =
      payload?.name !== undefined ? String(payload?.name ?? "").trim() : current.name;
    const nextPhoneRaw =
      payload?.phone !== undefined ? String(payload?.phone ?? "").trim() : current.phone;
    const normalized = normalizePhoneForWrite(
      nextPhoneRaw,
      payload?.phoneCountry ?? current?.phoneCountry
    );
    const nextPhone = normalized.phoneKey;
    const nextPhoneE164 = normalized.phoneE164;
    const nextPhoneCountry = normalized.phoneCountry;
    if (!nextName) throw httpError(400, "name is required");
    if (!nextPhone || !nextPhoneE164) {
      throw httpError(400, "phone must be a valid US or MX number");
    }

    if (nextPhone === currentPhone) {
      const upd = await ddb.send(
        new UpdateCommand({
          TableName: CLIENTS_TABLE,
          Key: { PK: "CLIENT", SK: `PHONE#${currentPhone}` },
          UpdateExpression: "SET #name = :name, #phone = :phone, #phoneCountry = :phoneCountry, #updatedBy = :by",
          ExpressionAttributeNames: {
            "#name": "name",
            "#phone": "phone",
            "#phoneCountry": "phoneCountry",
            "#updatedBy": "updatedBy",
          },
          ExpressionAttributeValues: {
            ":name": nextName,
            ":phone": nextPhoneE164,
            ":phoneCountry": nextPhoneCountry,
            ":by": user,
          },
          ReturnValues: "ALL_NEW",
        })
      );
      return upd.Attributes;
    }

    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: CLIENTS_TABLE,
              Item: {
                ...current,
                name: nextName,
                phone: nextPhoneE164,
                phoneCountry: nextPhoneCountry,
                PK: "CLIENT",
                SK: `PHONE#${nextPhone}`,
                updatedBy: user,
              },
              ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
            },
          },
          {
            Delete: {
              TableName: CLIENTS_TABLE,
              Key: { PK: "CLIENT", SK: `PHONE#${currentPhone}` },
            },
          },
        ],
      })
    );

    return {
      ...current,
      name: nextName,
      phone: nextPhoneE164,
      phoneCountry: nextPhoneCountry,
      PK: "CLIENT",
      SK: `PHONE#${nextPhone}`,
      updatedBy: user,
    };
  }

  async function deleteCrmClient(phoneKey) {
    requiredEnv("CLIENTS_TABLE", CLIENTS_TABLE);
    const phone = normalizePhone(phoneKey);
    if (!phone) throw httpError(400, "phone is required");
    await ddb.send(
      new DeleteCommand({
        TableName: CLIENTS_TABLE,
        Key: { PK: "CLIENT", SK: `PHONE#${phone}` },
      })
    );
  }

  async function listRescheduleCreditsByPhone(phoneQuery, countryHint = "US") {
    requiredEnv("CLIENTS_TABLE", CLIENTS_TABLE);
    const normalized = normalizePhoneForWrite(phoneQuery, countryHint);
    if (!normalized.phoneKey) {
      throw httpError(400, "phone must be a valid US or MX number");
    }

    const skPrefix = `CREDIT#PHONE#${normalized.phoneKey}#`;
    const res = await ddb.send(
      new QueryCommand({
        TableName: CLIENTS_TABLE,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeValues: {
          ":pk": "CLIENT",
          ":sk": skPrefix,
        },
      })
    );

    const todayIso = new Date().toISOString().slice(0, 10);
    const items = (res.Items ?? [])
      .filter((item) => String(item?.entityType ?? "").toUpperCase() === "RESCHEDULE_CREDIT")
      .map((item) => {
        const expiresAt = String(item?.expiresAt ?? "").trim();
        const status = String(item?.status ?? "ACTIVE").trim().toUpperCase();
        const isExpired = Boolean(expiresAt) && expiresAt < todayIso;
        return {
          creditId: item?.creditId ?? null,
          status: isExpired && status === "ACTIVE" ? "EXPIRED" : status,
          amountTotal: Number(item?.amountTotal ?? 0),
          amountRemaining: Number(item?.amountRemaining ?? 0),
          expiresAt: expiresAt || null,
          issuedAt: Number(item?.issuedAt ?? 0) || null,
          issuedBy: item?.issuedBy ?? null,
          sourceReservationId: item?.sourceReservationId ?? null,
          sourceEventDate: item?.sourceEventDate ?? null,
          customerName: item?.customerName ?? null,
          phone: item?.phone ?? null,
          phoneCountry: item?.phoneCountry ?? null,
          reason: item?.reason ?? null,
        };
      });

    items.sort((a, b) => {
      const statusWeight = (value) => {
        if (value === "ACTIVE") return 0;
        if (value === "EXPIRED") return 1;
        if (value === "USED") return 2;
        if (value === "REVOKED") return 3;
        return 4;
      };
      const byStatus = statusWeight(a.status) - statusWeight(b.status);
      if (byStatus !== 0) return byStatus;
      return (b.issuedAt ?? 0) - (a.issuedAt ?? 0);
    });

    return items;
  }

  async function isFrequentReservationByPhoneAndTable({
    phone,
    phoneCountry = "US",
    tableId,
  }) {
    const normalizedTableId = String(tableId ?? "").trim();
    const normalizedPhone = normalizePhoneE164(phone, normalizePhoneCountry(phoneCountry));
    if (!normalizedTableId || !normalizedPhone) return false;

    const clients = await listFrequentClients();
    let hasFrequentPhoneMatch = false;
    for (const client of clients) {
      if (String(client?.status ?? "ACTIVE").toUpperCase() !== "ACTIVE") continue;
      const clientPhone = normalizePhoneE164(
        client?.phone,
        normalizePhoneCountry(client?.phoneCountry ?? "US")
      );
      if (!clientPhone || clientPhone !== normalizedPhone) continue;
      hasFrequentPhoneMatch = true;

      const tableIds = client.tableSettings?.length
        ? client.tableSettings.map((t) => String(t?.tableId ?? "").trim()).filter(Boolean)
        : normalizeTableList(client.defaultTableIds ?? client.defaultTableId);
      if (tableIds.includes(normalizedTableId)) {
        return true;
      }
    }
    return hasFrequentPhoneMatch;
  }

  return {
    normalizeTableList,
    normalizeTableSettings,
    getDisabledTablesFromFrequent,
    createFrequentReservationsForEvent,
    listFrequentClients,
    getFrequentClientById,
    createFrequentClient,
    updateFrequentClient,
    deleteFrequentClient,
    upsertCrmClient,
    bulkImportCrmClients,
    listCrmClients,
    searchCrmClients,
    updateCrmClient,
    deleteCrmClient,
    listRescheduleCreditsByPhone,
    isFrequentReservationByPhoneAndTable,
  };
}
