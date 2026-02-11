import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  CognitoIdentityProviderClient,
  AdminGetUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  GetCommand,
  UpdateCommand,
  DeleteCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";


const EVENTS_TABLE = process.env.EVENTS_TABLE;
const HOLDS_TABLE = process.env.HOLDS_TABLE;
const RES_TABLE = process.env.RES_TABLE;
const FREQUENT_CLIENTS_TABLE = process.env.FREQUENT_CLIENTS_TABLE;
const CLIENTS_TABLE = process.env.CLIENTS_TABLE;
const USER_POOL_ID = process.env.USER_POOL_ID;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TABLE_TEMPLATE_PATH = path.join(__dirname, "table-template.json");
const TABLE_TEMPLATE = JSON.parse(fs.readFileSync(TABLE_TEMPLATE_PATH, "utf8"));

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const cognito = new CognitoIdentityProviderClient({});
const userCache = new Map();

// ---------- helpers ----------
function json(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  };
}

function noContent(statusCode = 204, extraHeaders = {}) {
  return {
    statusCode,
    headers: { ...extraHeaders },
    body: "",
  };
}

function getBody(event) {
  if (!event.body) return null;
  try {
    return event.isBase64Encoded
      ? JSON.parse(Buffer.from(event.body, "base64").toString("utf8"))
      : JSON.parse(event.body);
  } catch {
    return null;
  }
}

function httpError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function getGroupsFromEvent(event) {
  const claims = event?.requestContext?.authorizer?.jwt?.claims;
  const groups =
    claims?.["custom:groups"] ??
    claims?.["cognito:groups"];
  if (Array.isArray(groups)) return groups;
  if (typeof groups === "string") {
    try {
      const parsed = JSON.parse(groups);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // fall through
    }
    if (groups.startsWith("[") && groups.endsWith("]")) {
      const trimmed = groups.slice(1, -1).trim();
      if (!trimmed) return [];
      return trimmed
        .split(",")
        .map((g) => g.replace(/^['"]|['"]$/g, "").trim())
        .filter(Boolean);
    }
    return groups.split(",").map((g) => g.trim()).filter(Boolean);
  }
  return [];
}

async function getUserLabel(event) {
  const claims = event?.requestContext?.authorizer?.jwt?.claims ?? {};
  const fromClaims = claims["custom:name"] || claims.name || claims.email;
  if (fromClaims) return fromClaims;

  const username =
    claims["cognito:username"] || claims.username || claims.sub || "unknown";
  const fetched = await fetchUserNameFromCognito(username);
  return fetched || username || "unknown";
}

async function fetchUserNameFromCognito(username) {
  if (!USER_POOL_ID || !username) return null;

  const cached = userCache.get(username);
  const now = Date.now();
  if (cached && now - cached.ts < 5 * 60 * 1000) {
    return cached.value;
  }

  try {
    const res = await cognito.send(
      new AdminGetUserCommand({
        UserPoolId: USER_POOL_ID,
        Username: username,
      })
    );
    const attrs = res.UserAttributes ?? [];
    const nameAttr = attrs.find((a) => a.Name === "name");
    const emailAttr = attrs.find((a) => a.Name === "email");
    const value = nameAttr?.Value || emailAttr?.Value || null;
    userCache.set(username, { value, ts: now });
    return value;
  } catch {
    userCache.set(username, { value: null, ts: now });
    return null;
  }
}

function requireAdmin(event) {
  const groups = getGroupsFromEvent(event);
  if (!groups.includes("Admin")) {
    throw httpError(403, "Admin privileges required");
  }
}

// If you enabled CORS at API Gateway, you *usually* don’t need CORS headers here.
// But having them here helps local testing / direct lambda invoke.
function corsHeaders(event) {
  const origin = event.headers?.origin || event.headers?.Origin;
  // keep strict: only allow your known origins
  const allowed = new Set([
    "http://localhost:4200",
    "https://main.d1gxn3rvy5gfn4.amplifyapp.com",
  ]);
  return allowed.has(origin)
    ? { "access-control-allow-origin": origin, "vary": "Origin" }
    : {};
}

function nowEpoch() {
  return Math.floor(Date.now() / 1000);
}

function normalizePhone(phone) {
  return String(phone ?? "").replace(/\D/g, "");
}

function requiredEnv(name, value) {
  if (!value) throw httpError(500, `Missing env var ${name}`);
}

function getEffectiveTables(eventRecord, extraDisabled = new Set()) {
  const sectionPricing = eventRecord?.sectionPricing ?? {};
  const tablePricing = eventRecord?.tablePricing ?? {};
  const disabled = new Set(eventRecord?.disabledTables ?? []);
  for (const id of extraDisabled) disabled.add(id);

  return TABLE_TEMPLATE.tables.map((t) => {
    const sectionPrice =
      sectionPricing[t.section] ?? TABLE_TEMPLATE.sections?.[t.section] ?? t.price;
    const finalPrice = tablePricing[t.id] ?? sectionPrice ?? t.price;
    return {
      id: t.id,
      number: t.number,
      section: t.section,
      price: finalPrice,
      disabled: disabled.has(t.id),
    };
  });
}

function getTablePriceForEvent(eventRecord, tableId) {
  if (!eventRecord || !tableId) return null;
  const tables = getEffectiveTables(eventRecord);
  const match = tables.find((t) => t.id === tableId);
  return match?.price ?? null;
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
        paymentDeadlineAt = `${eventRecord.eventDate}T${time}:00`;
      }

      const reservationId = randomUUID();
      const holdKey = { PK: `EVENTDATE#${eventRecord.eventDate}`, SK: `TABLE#${tableId}` };

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
                    phone: c.phone ?? null,
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
                    phone: c.phone ?? null,
                    depositAmount: amountPaid,
                    amountDue,
                    tablePrice,
                    paymentStatus,
                    paymentDeadlineAt,
                    paymentDeadlineTz: paymentStatus === "PAID" || paymentStatus === "COURTESY" ? null : paymentDeadlineTz,
                    paymentMethod: null,
                    payments: [],
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
        if (err?.name === "TransactionCanceledException" || err?.name === "ConditionalCheckFailedException") {
          continue;
        }
        throw err;
      }
    }
  }
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

async function getDisabledTablesFromFrequent(eventRecord) {
  // disabledClients = opt-out list (clients NOT coming for this event).
  const disabledClients = new Set(eventRecord?.disabledClients ?? []);
  const clients = await listFrequentClients();
  const disabledTables = new Set();
  for (const c of clients) {
    if (c.status && String(c.status).toUpperCase() !== "ACTIVE") continue;
    if (disabledClients.has(c.clientId)) continue;
    const tables =
      (c.tableSettings?.length
        ? c.tableSettings.map((t) => t.tableId)
        : normalizeTableList(c.defaultTableIds ?? c.defaultTableId)) || [];
    for (const t of tables) disabledTables.add(t);
  }
  return disabledTables;
}

async function listTableLocks(eventDate) {
  requiredEnv("HOLDS_TABLE", HOLDS_TABLE);
  const pk = `EVENTDATE#${eventDate}`;
  const res = await ddb.send(
    new QueryCommand({
      TableName: HOLDS_TABLE,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
      ExpressionAttributeValues: {
        ":pk": pk,
        ":sk": "TABLE#",
      },
    })
  );
  return res.Items ?? [];
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
  const phone = normalizePhone(phoneRaw);
  const defaultTableIds = normalizeTableList(payload?.defaultTableIds ?? payload?.defaultTableId);
  const tableSettings = normalizeTableSettings(payload?.tableSettings);
  const notes = String(payload?.notes ?? "").trim();
  if (!name) throw httpError(400, "name is required");
  if (!phone) throw httpError(400, "phone is required");
  if (!defaultTableIds.length) throw httpError(400, "defaultTableIds is required");

  const clientId = randomUUID();
  const item = {
    PK: "CLIENT",
    SK: `CLIENT#${clientId}`,
    clientId,
    name,
    phone,
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
      Key: { PK: "CLIENT", SK: `PHONE#${phone}` },
      UpdateExpression:
        "SET #name = :name, #phone = :phone, #updatedBy = :by, #lastReservationAt = if_not_exists(#lastReservationAt, :now), #lastEventDate = if_not_exists(#lastEventDate, :eventDate), #lastTableId = if_not_exists(#lastTableId, :tableId)",
      ExpressionAttributeNames: {
        "#name": "name",
        "#phone": "phone",
        "#updatedBy": "updatedBy",
        "#lastReservationAt": "lastReservationAt",
        "#lastEventDate": "lastEventDate",
        "#lastTableId": "lastTableId",
      },
      ExpressionAttributeValues: {
        ":name": name || "Unknown",
        ":phone": phone,
        ":by": user,
        ":now": nowEpoch(),
        ":eventDate": null,
        ":tableId": (defaultTableIds[0] ?? null),
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
    updates.push("#phone = :phone");
    names["#phone"] = "phone";
    values[":phone"] = normalizePhone(payload.phone);
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
  const updatedPhone = normalizePhone(updated.phone ?? payload?.phone);
  if (updatedPhone) {
    await ddb.send(
      new UpdateCommand({
        TableName: CLIENTS_TABLE,
        Key: { PK: "CLIENT", SK: `PHONE#${updatedPhone}` },
        UpdateExpression:
          "SET #name = :name, #phone = :phone, #updatedBy = :by, #lastTableId = if_not_exists(#lastTableId, :tableId)",
        ExpressionAttributeNames: {
          "#name": "name",
          "#phone": "phone",
          "#updatedBy": "updatedBy",
          "#lastTableId": "lastTableId",
        },
        ExpressionAttributeValues: {
          ":name": updatedName || "Unknown",
          ":phone": updatedPhone,
          ":by": "system",
          ":tableId": (normalizeTableList(updated.defaultTableIds ?? updated.defaultTableId)[0] ?? null),
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
  const phone = normalizePhone(payload?.phone ?? "");
  const depositAmount = Number(payload?.depositAmount ?? 0);
  const eventDate = String(payload?.eventDate ?? "").trim();
  const tableId = String(payload?.tableId ?? "").trim();
  if (!phone) return;

  await ddb.send(
    new UpdateCommand({
      TableName: CLIENTS_TABLE,
      Key: { PK: "CLIENT", SK: `PHONE#${phone}` },
      UpdateExpression:
        "SET #name = :name, #phone = :phone, #lastReservationAt = :now, #lastEventDate = :eventDate, #lastTableId = :tableId, #updatedBy = :by ADD #totalSpend :amt, #totalReservations :one",
      ExpressionAttributeNames: {
        "#name": "name",
        "#phone": "phone",
        "#lastReservationAt": "lastReservationAt",
        "#lastEventDate": "lastEventDate",
        "#lastTableId": "lastTableId",
        "#updatedBy": "updatedBy",
        "#totalSpend": "totalSpend",
        "#totalReservations": "totalReservations",
      },
      ExpressionAttributeValues: {
        ":name": name || "Unknown",
        ":phone": phone,
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

// ---------- data access ----------
async function listEvents() {
  // Your current design uses PK="EVENT" and SK="EVENT#<something>"
  // Query is much better than Scan.
  const res = await ddb.send(
    new QueryCommand({
      TableName: EVENTS_TABLE,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
      ExpressionAttributeValues: {
        ":pk": "EVENT",
        ":sk": "EVENT#",
      },
    })
  );

  const items = (res.Items ?? []).map((x) => ({
    eventId: x.eventId,
    eventName: x.eventName,
    eventDate: x.eventDate,
    status: x.status,
    minDeposit: x.minDeposit,
    tablePricing: x.tablePricing ?? {},
    sectionPricing: x.sectionPricing ?? {},
    disabledTables: x.disabledTables ?? [],
    disabledClients: x.disabledClients ?? [],
    createdAt: x.createdAt,
    createdBy: x.createdBy,
  }));

  // optional: sort by eventDate
  items.sort((a, b) => (a.eventDate || "").localeCompare(b.eventDate || ""));
  return items;
}

async function createEvent(payload, user) {
  const eventName = String(payload?.eventName ?? "").trim();
  const eventDate = String(payload?.eventDate ?? "").trim(); // "YYYY-MM-DD"
  const minDeposit = Number(payload?.minDeposit ?? 0);

  if (!eventName) throw httpError(400, "eventName is required");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) throw httpError(400, "eventDate must be YYYY-MM-DD");
  if (!Number.isFinite(minDeposit) || minDeposit < 0) throw httpError(400, "minDeposit must be >= 0");

  const eventId = `${Date.now()}-${randomUUID()}`;

  const eventItem = {
    PK: "EVENT",
    SK: `EVENT#${eventId}`,
    eventId,
    eventName,
    eventDate,
    status: "ACTIVE",
    minDeposit,
    tablePricing: payload?.tablePricing ?? {},
    sectionPricing: payload?.sectionPricing ?? {},
    disabledTables: payload?.disabledTables ?? [],
    disabledClients: payload?.disabledClients ?? [],
    createdAt: nowEpoch(),
    createdBy: "system",
  };

  // 🔒 Date lock item (enforces uniqueness per date)
  const lockItem = {
    PK: "EVENTDATE",
    SK: `DATE#${eventDate}`,
    eventDate,
    eventId,          // points to the event
    createdAt: nowEpoch(),
  };

  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          // 1) Create lock if it doesn't exist
          {
            Put: {
              TableName: EVENTS_TABLE,
              Item: lockItem,
              ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
            },
          },
          // 2) Create the event
          {
            Put: {
              TableName: EVENTS_TABLE,
              Item: eventItem,
              ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
            },
          },
        ],
      })
    );
  } catch (err) {
    // Duplicate date lock -> transaction canceled
    if (err?.name === "TransactionCanceledException") {
      throw httpError(409, `An event already exists for ${eventDate}`);
    }
    throw err;
  }

  await createFrequentReservationsForEvent(eventItem, user ?? "system");
  return eventItem;
}

async function getEventById(eventId) {
  const res = await ddb.send(
    new GetCommand({
      TableName: EVENTS_TABLE,
      Key: { PK: "EVENT", SK: `EVENT#${eventId}` },
    })
  );
  return res.Item ?? null;
}

async function getEventByDate(eventDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) {
    throw httpError(400, "eventDate must be YYYY-MM-DD");
  }

  // 1) lock lookup
  const lockRes = await ddb.send(
    new GetCommand({
      TableName: EVENTS_TABLE,
      Key: { PK: "EVENTDATE", SK: `DATE#${eventDate}` },
    })
  );

  const lock = lockRes.Item;
  if (!lock?.eventId) return null;

  // 2) fetch the actual event
  return await getEventById(lock.eventId);
}

async function updateEvent(eventId, payload, user) {
  const current = await getEventById(eventId);
  if (!current) throw httpError(404, "Event not found");

  const nextStatus = payload?.status ?? current.status;

  // Build update expression (same idea you already have)
  const updates = [];
  const names = {};
  const values = {};

  const updatable = [
    "eventName",
    "eventDate",
    "status",
    "minDeposit",
    "tablePricing",
    "sectionPricing",
    "disabledTables",
    "disabledClients",
  ];
  for (const key of updatable) {
    if (payload?.[key] !== undefined) {
      updates.push(`#${key} = :${key}`);
      names[`#${key}`] = key;
      values[`:${key}`] = payload[key];
    }
  }
  // Always track updatedAt
  updates.push("#updatedAt = :updatedAt");
  names["#updatedAt"] = "updatedAt";
  values[":updatedAt"] = Date.now();

  if (updates.length === 0) throw httpError(400, "No fields to update");

  // CASE A: status -> INACTIVE (release lock)
  if (current.status !== "INACTIVE" && nextStatus === "INACTIVE") {
    const lockKey = { PK: "EVENTDATE", SK: `DATE#${current.eventDate}` };

    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: EVENTS_TABLE,
              Key: { PK: "EVENT", SK: `EVENT#${eventId}` },
              UpdateExpression: "SET " + updates.join(", "),
              ExpressionAttributeNames: names,
              ExpressionAttributeValues: values,
            },
          },
          {
            Delete: {
              TableName: EVENTS_TABLE,
              Key: lockKey,
              // Only delete the lock if it belongs to THIS event
              ConditionExpression: "eventId = :eid",
              ExpressionAttributeValues: { ":eid": eventId },
            },
          },
        ],
      })
    );

    // Fetch updated event (simple + consistent for your API response)
    return await getEventById(eventId);
  }

  // CASE B: status -> ACTIVE (acquire lock)
  if (current.status === "INACTIVE" && nextStatus === "ACTIVE") {
    const lockItem = {
      PK: "EVENTDATE",
      SK: `DATE#${current.eventDate}`,
      eventDate: current.eventDate,
      eventId,
      createdAt: nowEpoch(),
    };

    try {
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: EVENTS_TABLE,
                Item: lockItem,
                ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
              },
            },
            {
              Update: {
                TableName: EVENTS_TABLE,
                Key: { PK: "EVENT", SK: `EVENT#${eventId}` },
                UpdateExpression: "SET " + updates.join(", "),
                ExpressionAttributeNames: names,
                ExpressionAttributeValues: values,
              },
            },
          ],
        })
      );
    } catch (err) {
      if (err?.name === "TransactionCanceledException") {
        throw httpError(409, `An event already exists for ${current.eventDate}`);
      }
      throw err;
    }

    const updated = await getEventById(eventId);
    if (updated) {
      await createFrequentReservationsForEvent(updated, user ?? "system");
    }
    return updated;
  }

  // CASE C: eventDate change while ACTIVE (optional but recommended)
  // For now, block it to avoid lock inconsistencies:
  if (payload?.eventDate && payload.eventDate !== current.eventDate && current.status === "ACTIVE") {
    throw httpError(400, "Changing eventDate for an ACTIVE event is not allowed yet.");
  }

  // Default: normal update
  const res = await ddb.send(
    new UpdateCommand({
      TableName: EVENTS_TABLE,
      Key: { PK: "EVENT", SK: `EVENT#${eventId}` },
      UpdateExpression: "SET " + updates.join(", "),
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ReturnValues: "ALL_NEW",
    })
  );

  return res.Attributes;
}

async function deleteEvent(eventId) {
  const current = await getEventById(eventId);
  if (!current) return;

  // If this event is ACTIVE, it should have a lock; delete both atomically
  if (current.status === "ACTIVE") {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Delete: {
              TableName: EVENTS_TABLE,
              Key: { PK: "EVENT", SK: `EVENT#${eventId}` },
            },
          },
          {
            Delete: {
              TableName: EVENTS_TABLE,
              Key: { PK: "EVENTDATE", SK: `DATE#${current.eventDate}` },
              ConditionExpression: "eventId = :eid",
              ExpressionAttributeValues: { ":eid": eventId },
            },
          },
        ],
      })
    );
    return;
  }

  // If inactive, just delete the event record
  await ddb.send(
    new DeleteCommand({
      TableName: EVENTS_TABLE,
      Key: { PK: "EVENT", SK: `EVENT#${eventId}` },
    })
  );
}

async function createHold(payload, user) {
  requiredEnv("HOLDS_TABLE", HOLDS_TABLE);
  const eventDate = String(payload?.eventDate ?? "").trim();
  const tableId = String(payload?.tableId ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) {
    throw httpError(400, "eventDate must be YYYY-MM-DD");
  }
  if (!tableId) throw httpError(400, "tableId is required");
  const eventRecord = await getEventByDate(eventDate);
  if (!eventRecord) throw httpError(404, "Event not found for date");
  const disabledFromFrequent = await getDisabledTablesFromFrequent(eventRecord);
  if (disabledFromFrequent.has(tableId) || (eventRecord.disabledTables ?? []).includes(tableId)) {
    throw httpError(409, "Table is disabled for this event");
  }

  const holdId = randomUUID();
  const now = nowEpoch();
  const expiresAt = now + 300; // 5 minutes
  const item = {
    PK: `EVENTDATE#${eventDate}`,
    SK: `TABLE#${tableId}`,
    lockType: "HOLD",
    holdId,
    expiresAt,
    createdAt: now,
    createdBy: user,
    customerName: payload?.customerName ?? null,
    phone: payload?.phone ?? null,
  };

  try {
    await ddb.send(
      new PutCommand({
        TableName: HOLDS_TABLE,
        Item: item,
        ConditionExpression:
          "attribute_not_exists(PK) AND attribute_not_exists(SK) OR (lockType = :hold AND expiresAt < :now)",
        ExpressionAttributeValues: {
          ":hold": "HOLD",
          ":now": now,
        },
      })
    );
  } catch (err) {
    if (err?.name === "ConditionalCheckFailedException") {
      throw httpError(409, "Table is already held or reserved");
    }
    throw err;
  }

  return item;
}

async function releaseHold(eventDate, tableId) {
  requiredEnv("HOLDS_TABLE", HOLDS_TABLE);
  await ddb.send(
    new DeleteCommand({
      TableName: HOLDS_TABLE,
      Key: { PK: `EVENTDATE#${eventDate}`, SK: `TABLE#${tableId}` },
      ConditionExpression: "lockType = :hold",
      ExpressionAttributeValues: { ":hold": "HOLD" },
    })
  );
}

async function listHolds(eventDate) {
  return await listTableLocks(eventDate);
}

async function listReservations(eventDate) {
  requiredEnv("RES_TABLE", RES_TABLE);
  const res = await ddb.send(
    new QueryCommand({
      TableName: RES_TABLE,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
      ExpressionAttributeValues: {
        ":pk": `EVENTDATE#${eventDate}`,
        ":sk": "RES#",
      },
    })
  );
  return res.Items ?? [];
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
  const phone = normalizePhone(phoneQuery);
  if (!phone) return [];

  const res = await ddb.send(
    new QueryCommand({
      TableName: CLIENTS_TABLE,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
      ExpressionAttributeValues: {
        ":pk": "CLIENT",
        ":sk": `PHONE#${phone}`,
      },
      Limit: 10,
      ScanIndexForward: false,
    })
  );

  const items = (res.Items ?? []).map((x) => ({
    name: x.name,
    phone: x.phone,
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

  const nextName = payload?.name !== undefined ? String(payload?.name ?? "").trim() : current.name;
  const nextPhoneRaw =
    payload?.phone !== undefined ? String(payload?.phone ?? "").trim() : current.phone;
  const nextPhone = normalizePhone(nextPhoneRaw);
  if (!nextName) throw httpError(400, "name is required");
  if (!nextPhone) throw httpError(400, "phone is required");

  if (nextPhone === currentPhone) {
    const upd = await ddb.send(
      new UpdateCommand({
        TableName: CLIENTS_TABLE,
        Key: { PK: "CLIENT", SK: `PHONE#${currentPhone}` },
        UpdateExpression: "SET #name = :name, #phone = :phone, #updatedBy = :by",
        ExpressionAttributeNames: {
          "#name": "name",
          "#phone": "phone",
          "#updatedBy": "updatedBy",
        },
        ExpressionAttributeValues: {
          ":name": nextName,
          ":phone": nextPhone,
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
              phone: nextPhone,
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
    phone: nextPhone,
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

async function cancelReservation(eventDate, reservationId, tableId, user, reason) {
  requiredEnv("RES_TABLE", RES_TABLE);
  requiredEnv("HOLDS_TABLE", HOLDS_TABLE);

  const pk = `EVENTDATE#${eventDate}`;
  const sk = `RES#${reservationId}`;
  const cancelReason = String(reason ?? "").trim();
  if (!cancelReason) {
    throw httpError(400, "cancelReason is required");
  }

  // Mark reservation cancelled
  await ddb.send(
    new UpdateCommand({
      TableName: RES_TABLE,
      Key: { PK: pk, SK: sk },
      UpdateExpression:
        "SET #status = :cancelled, #updatedAt = :now, #updatedBy = :by, #cancelReason = :reason, #cancelledAt = :now, #cancelledBy = :by",
      ExpressionAttributeNames: {
        "#status": "status",
        "#updatedAt": "updatedAt",
        "#updatedBy": "updatedBy",
        "#cancelReason": "cancelReason",
        "#cancelledAt": "cancelledAt",
        "#cancelledBy": "cancelledBy",
      },
      ExpressionAttributeValues: {
        ":cancelled": "CANCELLED",
        ":confirmed": "CONFIRMED",
        ":now": nowEpoch(),
        ":by": user,
        ":reason": cancelReason,
      },
      ConditionExpression: "#status = :confirmed",
      ReturnValues: "ALL_NEW",
    })
  );

  // Best-effort: remove lock
  try {
    await ddb.send(
      new DeleteCommand({
        TableName: HOLDS_TABLE,
        Key: { PK: pk, SK: `TABLE#${tableId}` },
        ConditionExpression: "lockType = :reserved AND reservationId = :rid",
        ExpressionAttributeValues: {
          ":reserved": "RESERVED",
          ":rid": reservationId,
        },
      })
    );
  } catch (err) {
    if (err?.name !== "ConditionalCheckFailedException") {
      throw err;
    }
  }
}

async function createReservation(payload, user, isAdmin) {
  requiredEnv("HOLDS_TABLE", HOLDS_TABLE);
  requiredEnv("RES_TABLE", RES_TABLE);

  const eventDate = String(payload?.eventDate ?? "").trim();
  const tableId = String(payload?.tableId ?? "").trim();
  const holdId = String(payload?.holdId ?? "").trim();
  const customerName = String(payload?.customerName ?? "").trim();
  const phone = String(payload?.phone ?? "").trim();
  const paymentMethodInput = String(payload?.paymentMethod ?? "").trim();
  const depositAmount = Number(payload?.depositAmount ?? 0);
  const amountDueInput = payload?.amountDue !== undefined ? Number(payload?.amountDue) : null;
  const paymentStatusInput = payload?.paymentStatus
    ? String(payload?.paymentStatus).toUpperCase()
    : "";
  const paymentDeadlineAt = String(payload?.paymentDeadlineAt ?? "").trim();
  const paymentDeadlineTz = String(payload?.paymentDeadlineTz ?? "America/Chicago").trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) {
    throw httpError(400, "eventDate must be YYYY-MM-DD");
  }
  if (!tableId) throw httpError(400, "tableId is required");
  if (!holdId) throw httpError(400, "holdId is required");
  if (!customerName) throw httpError(400, "customerName is required");
  if (!phone) throw httpError(400, "phone is required");
  if (!Number.isFinite(depositAmount) || depositAmount < 0) {
    throw httpError(400, "depositAmount must be >= 0");
  }

  const eventRecord = await getEventByDate(eventDate);
  if (!eventRecord) throw httpError(404, "Event not found for date");
  if (!isAdmin && depositAmount < (eventRecord.minDeposit ?? 0)) {
    throw httpError(400, "depositAmount is below minimum for this event");
  }
  const tablePrice = getTablePriceForEvent(eventRecord, tableId);
  if (tablePrice === null) throw httpError(400, "Invalid tableId for event");

  const amountDue =
    amountDueInput !== null && Number.isFinite(amountDueInput) ? amountDueInput : tablePrice;
  let paymentStatus = "PENDING";
  if (paymentStatusInput) {
    if (!["PENDING", "PARTIAL", "PAID", "COURTESY"].includes(paymentStatusInput)) {
      throw httpError(400, "paymentStatus must be PENDING | PARTIAL | PAID | COURTESY");
    }
    paymentStatus = paymentStatusInput;
  } else {
    if (depositAmount <= 0) paymentStatus = "PENDING";
    else if (depositAmount >= amountDue) paymentStatus = "PAID";
    else paymentStatus = "PARTIAL";
  }

  let effectiveDeposit = depositAmount;
  let effectiveAmountDue = amountDue;
  if (paymentStatus === "COURTESY") {
    effectiveAmountDue = 0;
    effectiveDeposit = 0;
  } else if (paymentStatus === "PAID") {
    effectiveDeposit = effectiveAmountDue;
  } else if (paymentStatus === "PENDING") {
    effectiveDeposit = 0;
  }

  let effectiveDeadlineAt = paymentDeadlineAt;
  if (paymentStatus === "PENDING" || paymentStatus === "PARTIAL") {
    if (!effectiveDeadlineAt) {
      effectiveDeadlineAt = `${eventDate}T00:00:00`;
    }
  } else {
    effectiveDeadlineAt = "";
  }

  const needsMethod = paymentStatus === "PAID" || paymentStatus === "PARTIAL";
  if (needsMethod && !["cash", "cashapp", "square"].includes(paymentMethodInput)) {
    throw httpError(400, "paymentMethod is required for PAID or PARTIAL reservations");
  }
  const effectivePaymentMethod =
    paymentStatus === "PENDING" || paymentStatus === "COURTESY"
      ? null
      : paymentMethodInput;

  const now = nowEpoch();
  const reservationId = randomUUID();
  const payments =
    effectiveDeposit > 0 && effectivePaymentMethod
      ? [
          {
            paymentId: randomUUID(),
            amount: effectiveDeposit,
            method: effectivePaymentMethod,
            note: "Initial payment",
            createdAt: now,
            createdBy: user,
          },
        ]
      : [];

  const holdKey = { PK: `EVENTDATE#${eventDate}`, SK: `TABLE#${tableId}` };

  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: HOLDS_TABLE,
            Key: holdKey,
            UpdateExpression:
              "SET lockType = :reserved, reservationId = :rid, customerName = :name, phone = :phone, createdAt = :now, createdBy = :by REMOVE expiresAt, holdId",
            ConditionExpression: "lockType = :hold AND holdId = :hid AND expiresAt >= :now",
            ExpressionAttributeValues: {
              ":reserved": "RESERVED",
              ":hold": "HOLD",
              ":hid": holdId,
              ":rid": reservationId,
              ":name": customerName,
              ":phone": phone,
              ":now": now,
              ":by": user,
            },
          },
        },
        {
          Put: {
            TableName: RES_TABLE,
            Item: {
              PK: `EVENTDATE#${eventDate}`,
              SK: `RES#${reservationId}`,
              reservationId,
              eventDate,
              tableId,
              customerName,
              phone,
              depositAmount: effectiveDeposit,
              amountDue: effectiveAmountDue,
              tablePrice,
              paymentStatus,
              paymentDeadlineAt: effectiveDeadlineAt || null,
              paymentDeadlineTz:
                paymentStatus === "PAID" || paymentStatus === "COURTESY"
                  ? null
                  : paymentDeadlineTz,
              paymentMethod: effectivePaymentMethod,
              payments,
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

  return { reservationId };
}

async function addReservationPayment(reservationId, payload, user) {
  requiredEnv("RES_TABLE", RES_TABLE);
  const eventDate = String(payload?.eventDate ?? "").trim();
  const amount = Number(payload?.amount ?? 0);
  const method = String(payload?.method ?? "").trim();
  const note = String(payload?.note ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) {
    throw httpError(400, "eventDate must be YYYY-MM-DD");
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    throw httpError(400, "amount must be > 0");
  }
  if (!["cash", "cashapp", "square"].includes(method)) {
    throw httpError(400, "method must be cash | cashapp | square");
  }

  const key = {
    PK: `EVENTDATE#${eventDate}`,
    SK: `RES#${reservationId}`,
  };
  const current = await ddb.send(
    new GetCommand({
      TableName: RES_TABLE,
      Key: key,
    })
  );
  const item = current.Item;
  if (!item) throw httpError(404, "Reservation not found");
  if (item.status !== "CONFIRMED") {
    throw httpError(400, "Only confirmed reservations can receive payments");
  }
  if (String(item.paymentStatus ?? "").toUpperCase() === "COURTESY") {
    throw httpError(400, "Cannot add payments to courtesy reservations");
  }

  const now = nowEpoch();
  const amountDue = Number(item.amountDue ?? 0);
  const currentPaid = Number(item.depositAmount ?? 0);
  const nextPaid = currentPaid + amount;
  const nextStatus = nextPaid >= amountDue ? "PAID" : "PARTIAL";
  const nextDeadline = nextStatus === "PAID" ? null : (item.paymentDeadlineAt ?? null);
  const nextDeadlineTz = nextStatus === "PAID" ? null : (item.paymentDeadlineTz ?? "America/Chicago");
  const payment = {
    paymentId: randomUUID(),
    amount,
    method,
    note: note || null,
    createdAt: now,
    createdBy: user,
  };

  const res = await ddb.send(
    new UpdateCommand({
      TableName: RES_TABLE,
      Key: key,
      ConditionExpression: "#status = :confirmed",
      UpdateExpression:
        "SET #depositAmount = :paid, #paymentStatus = :paymentStatus, #paymentMethod = :paymentMethod, #paymentDeadlineAt = :deadline, #paymentDeadlineTz = :deadlineTz, #updatedAt = :now, #updatedBy = :by, #payments = list_append(if_not_exists(#payments, :empty), :newPayment)",
      ExpressionAttributeNames: {
        "#status": "status",
        "#depositAmount": "depositAmount",
        "#paymentStatus": "paymentStatus",
        "#paymentMethod": "paymentMethod",
        "#paymentDeadlineAt": "paymentDeadlineAt",
        "#paymentDeadlineTz": "paymentDeadlineTz",
        "#updatedAt": "updatedAt",
        "#updatedBy": "updatedBy",
        "#payments": "payments",
      },
      ExpressionAttributeValues: {
        ":confirmed": "CONFIRMED",
        ":paid": nextPaid,
        ":paymentStatus": nextStatus,
        ":paymentMethod": method,
        ":deadline": nextDeadline,
        ":deadlineTz": nextDeadlineTz,
        ":now": now,
        ":by": user,
        ":empty": [],
        ":newPayment": [payment],
      },
      ReturnValues: "ALL_NEW",
    })
  );

  return res.Attributes;
}

// ---------- router ----------
export const handler = async (event) => {
  const method = event.requestContext?.http?.method || "GET";
  const path = event.requestContext?.http?.path || event.rawPath || "/";
  const cors = corsHeaders(event);

  // Handle OPTIONS (preflight) safely
  if (method === "OPTIONS") {
    return noContent(204, {
      ...cors,
      "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
      "access-control-allow-headers": "authorization,content-type",
    });
  }

  try {
    // sanity check
    if (!EVENTS_TABLE) {
      return json(500, { message: "Missing env var EVENTS_TABLE" }, cors);
    }

    // ----- /events -----
    if (method === "GET" && path === "/events") {
      const items = await listEvents();
      return json(200, { items }, cors);
    }

    // ----- /tables/template -----
    if (method === "GET" && path === "/tables/template") {
      return json(200, { template: TABLE_TEMPLATE }, cors);
    }

    // ----- /tables/for-event/{YYYY-MM-DD} -----
    const tablesByDateMatch = path.match(/^\/tables\/for-event\/(\d{4}-\d{2}-\d{2})$/);
    if (tablesByDateMatch && method === "GET") {
      const date = tablesByDateMatch[1];
      const eventRecord = await getEventByDate(date);
      if (!eventRecord) return json(404, { message: "Event not found for date", date }, cors);
      const locks = await listTableLocks(date);
      const disabledFromFrequent = await getDisabledTablesFromFrequent(eventRecord);
      const lockMap = new Map(locks.map((l) => [l.SK, l]));
      const tables = getEffectiveTables(eventRecord, disabledFromFrequent).map((t) => {
        const lock = lockMap.get(`TABLE#${t.id}`);
        if (!lock) return { ...t, status: t.disabled ? "DISABLED" : "AVAILABLE" };
        if (lock.lockType === "RESERVED") return { ...t, status: "RESERVED" };
        if (lock.lockType === "HOLD") return { ...t, status: "HOLD" };
        return { ...t, status: t.disabled ? "DISABLED" : "AVAILABLE" };
      });
      return json(200, { event: eventRecord, tables }, cors);
    }

    if (method === "POST" && path === "/events") {
      requireAdmin(event);
      const body = getBody(event);
      if (!body) return json(400, { message: "Invalid JSON body" }, cors);

      const user = await getUserLabel(event);
      const item = await createEvent(body, user);
      return json(201, { item }, cors);
    }

    // GET /events/by-date/{YYYY-MM-DD}
    const byDateMatch = path.match(/^\/events\/by-date\/(\d{4}-\d{2}-\d{2})$/);
    if (byDateMatch && method === "GET") {
      const date = byDateMatch[1];
      const item = await getEventByDate(date);
      if (!item) return json(404, { message: "Event not found for date", date }, cors);
      return json(200, { item }, cors);
    }

    // ----- /events/{eventId} -----
    const eventIdMatch = path.match(/^\/events\/([^/]+)$/);
    const eventId = eventIdMatch?.[1];

    if (eventId && method === "GET") {
      const item = await getEventById(eventId);
      if (!item) return json(404, { message: "Event not found" }, cors);
      return json(200, { item }, cors);
    }

    if (eventId && method === "PUT") {
      requireAdmin(event);
      const body = getBody(event);
      if (!body) return json(400, { message: "Invalid JSON body" }, cors);

      const user = await getUserLabel(event);
      const item = await updateEvent(eventId, body, user);
      return json(200, { item }, cors);
    }

    if (eventId && method === "DELETE") {
      requireAdmin(event);
      await deleteEvent(eventId);
      return noContent(204, cors);
    }

    // ----- /frequent-clients -----
    if (method === "GET" && path === "/frequent-clients") {
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

    const frequentMatch = path.match(/^\/frequent-clients\/([^/]+)$/);
    if (frequentMatch && method === "GET") {
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

    // ----- /clients -----
    if (method === "GET" && path === "/clients") {
      requireAdmin(event);
      const items = await listCrmClients();
      return json(200, { items }, cors);
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

    // ----- /clients/search -----
    if (method === "GET" && path === "/clients/search") {
      const phone = event.queryStringParameters?.phone;
      if (!phone) return json(400, { message: "phone is required" }, cors);
      const items = await searchCrmClients(phone);
      return json(200, { items }, cors);
    }

    // ----- /holds -----
    if (method === "POST" && path === "/holds") {
      const body = getBody(event);
      if (!body) return json(400, { message: "Invalid JSON body" }, cors);
      const user = await getUserLabel(event);
      const item = await createHold(body, user);
      return json(201, { item }, cors);
    }

    if (method === "GET" && path === "/holds") {
      const eventDate = event.queryStringParameters?.eventDate;
      if (!eventDate) return json(400, { message: "eventDate is required" }, cors);
      const items = await listHolds(eventDate);
      return json(200, { items }, cors);
    }

    const holdMatch = path.match(/^\/holds\/(\d{4}-\d{2}-\d{2})\/([^/]+)$/);
    if (holdMatch && method === "DELETE") {
      const eventDate = holdMatch[1];
      const tableId = holdMatch[2];
      await releaseHold(eventDate, tableId);
      return noContent(204, cors);
    }

    // ----- /reservations -----
    if (method === "POST" && path === "/reservations") {
      const body = getBody(event);
      if (!body) return json(400, { message: "Invalid JSON body" }, cors);
      const user = await getUserLabel(event);
      const groups = getGroupsFromEvent(event);
      const isAdmin = groups.includes("Admin");
      const item = await createReservation(body, user, isAdmin);
      await upsertCrmClient(body, user);
      return json(201, { item }, cors);
    }

    if (method === "GET" && path === "/reservations") {
      const eventDate = event.queryStringParameters?.eventDate;
      if (!eventDate) return json(400, { message: "eventDate is required" }, cors);
      const items = await listReservations(eventDate);
      return json(200, { items }, cors);
    }

    const paymentMatch = path.match(/^\/reservations\/([^/]+)\/payment$/);
    if (paymentMatch && method === "PUT") {
      const reservationId = paymentMatch[1];
      const body = getBody(event);
      if (!body) return json(400, { message: "Invalid JSON body" }, cors);
      const user = await getUserLabel(event);
      const item = await addReservationPayment(reservationId, body, user);
      return json(200, { item }, cors);
    }

    const cancelMatch = path.match(/^\/reservations\/([^/]+)\/cancel$/);
    if (cancelMatch && method === "PUT") {
      const reservationId = cancelMatch[1];
      const body = getBody(event);
      if (!body) return json(400, { message: "Invalid JSON body" }, cors);
      const eventDate = String(body?.eventDate ?? "").trim();
      const tableId = String(body?.tableId ?? "").trim();
      const cancelReason = String(body?.cancelReason ?? "").trim();
      if (!eventDate || !tableId) {
        return json(400, { message: "eventDate and tableId are required" }, cors);
      }
      if (!cancelReason) {
        return json(400, { message: "cancelReason is required" }, cors);
      }
      const user = await getUserLabel(event);
      await cancelReservation(eventDate, reservationId, tableId, user, cancelReason);
      return noContent(204, cors);
    }

    return json(404, { message: "Route not found", method, path }, cors);
  } catch (err) {
    console.error("ERROR", err);
    const status = Number(err?.statusCode) || 500;
    return json(status, { message: err?.message || "Internal error" }, cors);
  }
};
