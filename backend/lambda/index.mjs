import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
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


const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const EVENTS_TABLE = process.env.EVENTS_TABLE;
const HOLDS_TABLE = process.env.HOLDS_TABLE;
const RES_TABLE = process.env.RES_TABLE;
const FREQUENT_CLIENTS_TABLE = process.env.FREQUENT_CLIENTS_TABLE;
const CLIENTS_TABLE = process.env.CLIENTS_TABLE;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TABLE_TEMPLATE_PATH = path.join(__dirname, "table-template.json");
const TABLE_TEMPLATE = JSON.parse(fs.readFileSync(TABLE_TEMPLATE_PATH, "utf8"));

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
    return groups.split(",").map((g) => g.trim()).filter(Boolean);
  }
  return [];
}

function getUserLabel(event) {
  const claims = event?.requestContext?.authorizer?.jwt?.claims ?? {};
  return (
    claims.name ||
    claims.email ||
    claims["cognito:username"] ||
    claims.username ||
    claims.sub ||
    "unknown"
  );
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

async function getDisabledTablesFromFrequent(eventRecord) {
  // disabledClients = opt-out list (clients NOT coming for this event).
  const disabledClients = new Set(eventRecord?.disabledClients ?? []);
  const clients = await listFrequentClients();
  const disabledTables = new Set();
  for (const c of clients) {
    if (c.status && String(c.status).toUpperCase() !== "ACTIVE") continue;
    if (disabledClients.has(c.clientId)) continue;
    if (c.defaultTableId) disabledTables.add(c.defaultTableId);
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
  return res.Items ?? [];
}

async function createFrequentClient(payload, user) {
  requiredEnv("FREQUENT_CLIENTS_TABLE", FREQUENT_CLIENTS_TABLE);
  const name = String(payload?.name ?? "").trim();
  const phoneRaw = String(payload?.phone ?? "").trim();
  const phone = normalizePhone(phoneRaw);
  const defaultTableId = String(payload?.defaultTableId ?? "").trim();
  const notes = String(payload?.notes ?? "").trim();
  if (!name) throw httpError(400, "name is required");
  if (!phone) throw httpError(400, "phone is required");
  if (!defaultTableId) throw httpError(400, "defaultTableId is required");

  const clientId = randomUUID();
  const item = {
    PK: "CLIENT",
    SK: `CLIENT#${clientId}`,
    clientId,
    name,
    phone,
    defaultTableId,
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

  return item;
}

async function updateFrequentClient(clientId, payload) {
  requiredEnv("FREQUENT_CLIENTS_TABLE", FREQUENT_CLIENTS_TABLE);
  const updates = [];
  const names = {};
  const values = {};

  const updatable = ["name", "defaultTableId", "notes", "status"];
  for (const key of updatable) {
    if (payload?.[key] !== undefined) {
      updates.push(`#${key} = :${key}`);
      names[`#${key}`] = key;
      values[`:${key}`] = payload[key];
    }
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
  return res.Attributes;
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

async function createEvent(payload) {
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

async function updateEvent(eventId, payload) {
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

    return await getEventById(eventId);
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
  const paymentMethod = String(payload?.paymentMethod ?? "").trim();
  const depositAmount = Number(payload?.depositAmount ?? 0);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) {
    throw httpError(400, "eventDate must be YYYY-MM-DD");
  }
  if (!tableId) throw httpError(400, "tableId is required");
  if (!holdId) throw httpError(400, "holdId is required");
  if (!customerName) throw httpError(400, "customerName is required");
  if (!phone) throw httpError(400, "phone is required");
  if (!["cash", "cashapp", "square"].includes(paymentMethod)) {
    throw httpError(400, "paymentMethod must be cash | cashapp | square");
  }
  if (!Number.isFinite(depositAmount) || depositAmount < 0) {
    throw httpError(400, "depositAmount must be >= 0");
  }

  const eventRecord = await getEventByDate(eventDate);
  if (!eventRecord) throw httpError(404, "Event not found for date");
  if (!isAdmin && depositAmount < (eventRecord.minDeposit ?? 0)) {
    throw httpError(400, "depositAmount is below minimum for this event");
  }

  const now = nowEpoch();
  const reservationId = randomUUID();

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
              depositAmount,
              paymentMethod,
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

      const item = await createEvent(body);
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

      const item = await updateEvent(eventId, body);
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
      const user = getUserLabel(event);
      const item = await createFrequentClient(body, user);
      return json(201, { item }, cors);
    }

    const frequentMatch = path.match(/^\/frequent-clients\/([^/]+)$/);
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

    // ----- /holds -----
    if (method === "POST" && path === "/holds") {
      const body = getBody(event);
      if (!body) return json(400, { message: "Invalid JSON body" }, cors);
      const user = getUserLabel(event);
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
      const user = getUserLabel(event);
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
      const user = getUserLabel(event);
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
