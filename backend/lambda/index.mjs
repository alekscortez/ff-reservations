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


const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const EVENTS_TABLE = process.env.EVENTS_TABLE;

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
  const nextEventDate = payload?.eventDate ?? current.eventDate;

  // Build update expression (same idea you already have)
  const updates = [];
  const names = {};
  const values = {};

  const updatable = ["eventName", "eventDate", "status", "minDeposit", "tablePricing"];
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

    const res = await ddb.send(
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
    const updated = await getEventById(eventId);
    return updated;
  }

  // CASE B: eventDate change while ACTIVE (optional but recommended)
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

    if (method === "POST" && path === "/events") {
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
      const body = getBody(event);
      if (!body) return json(400, { message: "Invalid JSON body" }, cors);

      const item = await updateEvent(eventId, body);
      return json(200, { item }, cors);
    }

    if (eventId && method === "DELETE") {
      await deleteEvent(eventId);
      return noContent(204, cors);
    }

    return json(404, { message: "Route not found", method, path }, cors);
  } catch (err) {
    console.error("ERROR", err);
    const status = Number(err?.statusCode) || 500;
    return json(status, { message: err?.message || "Internal error" }, cors);
  }
};