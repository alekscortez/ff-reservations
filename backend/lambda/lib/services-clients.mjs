import { randomUUID } from "crypto";
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
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
    const tableId = String(payload?.tableId ?? "").trim();
    if (!phone || !phoneE164) return;

    await ddb.send(
      new UpdateCommand({
        TableName: CLIENTS_TABLE,
        Key: { PK: "CLIENT", SK: `PHONE#${phone}` },
        UpdateExpression:
          "SET #name = :name, #phone = :phone, #phoneCountry = :phoneCountry, #lastReservationAt = :now, #lastEventDate = :eventDate, #lastTableId = :tableId, #updatedBy = :by ADD #totalSpend :amt, #totalReservations :one",
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
        },
        ExpressionAttributeValues: {
          ":name": name || "Unknown",
          ":phone": phoneE164,
          ":phoneCountry": phoneCountry,
          ":now": nowEpoch(),
          ":eventDate": eventDate,
          ":tableId": tableId,
          ":by": user,
          ":amt": depositAmount,
          ":one": 1,
        },
      })
    );
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
      lastReservationAt: x.lastReservationAt,
      lastEventDate: x.lastEventDate,
      lastTableId: x.lastTableId,
      updatedBy: x.updatedBy,
    }));
    items.sort((a, b) => (b.lastReservationAt ?? 0) - (a.lastReservationAt ?? 0));
    return items;
  }

  async function searchCrmClients(phoneQuery) {
    requiredEnv("CLIENTS_TABLE", CLIENTS_TABLE);
    const candidates = buildPhoneSearchCandidates(phoneQuery);
    if (!candidates.length) return [];

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
    const byKey = new Map();
    for (const res of responses) {
      for (const item of res.Items ?? []) {
        if (item?.SK) byKey.set(String(item.SK), item);
      }
    }

    const items = [...byKey.values()].map((x) => ({
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
    return items;
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
    listCrmClients,
    searchCrmClients,
    updateCrmClient,
    deleteCrmClient,
    listRescheduleCreditsByPhone,
    isFrequentReservationByPhoneAndTable,
  };
}
