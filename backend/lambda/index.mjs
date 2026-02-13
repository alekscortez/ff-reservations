import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  CognitoIdentityProviderClient,
  AdminGetUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import {
  DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  addDaysToIsoDate,
  buildPhoneSearchCandidates,
  detectPhoneCountryFromE164,
  getBody,
  httpError,
  json,
  noContent,
  normalizePhone,
  normalizePhoneCountry,
  normalizePhoneE164,
  nowEpoch,
  requiredEnv,
} from "./lib/core-utils.mjs";
import { handleEventsAndTablesRoute } from "./lib/routes-events.mjs";
import { handleReservationsAndHoldsRoute } from "./lib/routes-reservations-holds.mjs";
import { handleClientsRoute } from "./lib/routes-clients.mjs";
import { handleSquareWebhookRoute } from "./lib/routes-square-webhooks.mjs";
import { createClientsService } from "./lib/services-clients.mjs";
import { createReservationsHoldsService } from "./lib/services-reservations-holds.mjs";
import { createEventsService } from "./lib/services-events.mjs";
import { createSquarePaymentsService } from "./lib/services-square-payments.mjs";


const EVENTS_TABLE = process.env.EVENTS_TABLE;
const HOLDS_TABLE = process.env.HOLDS_TABLE;
const RES_TABLE = process.env.RES_TABLE;
const FREQUENT_CLIENTS_TABLE = process.env.FREQUENT_CLIENTS_TABLE;
const CLIENTS_TABLE = process.env.CLIENTS_TABLE;
const USER_POOL_ID = process.env.USER_POOL_ID;
const SQUARE_SECRET_ARN = process.env.SQUARE_SECRET_ARN;
const SQUARE_ENV = process.env.SQUARE_ENV;
const SQUARE_LOCATION_ID = process.env.SQUARE_LOCATION_ID;
const SQUARE_API_VERSION = process.env.SQUARE_API_VERSION;
const SQUARE_WEBHOOK_NOTIFICATION_URL = process.env.SQUARE_WEBHOOK_NOTIFICATION_URL;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TABLE_TEMPLATE_PATH = path.join(__dirname, "table-template.json");
const TABLE_TEMPLATE = JSON.parse(fs.readFileSync(TABLE_TEMPLATE_PATH, "utf8"));

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const cognito = new CognitoIdentityProviderClient({});
const secretsManager = new SecretsManagerClient({});
const userCache = new Map();

// ---------- helpers ----------

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

function requireStaffOrAdmin(event) {
  const groups = getGroupsFromEvent(event);
  if (!groups.includes("Admin") && !groups.includes("Staff")) {
    throw httpError(403, "Staff or Admin privileges required");
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

const clientsService = createClientsService({
  ddb,
  tableNames: {
    FREQUENT_CLIENTS_TABLE,
    CLIENTS_TABLE,
    HOLDS_TABLE,
    RES_TABLE,
  },
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
});

const eventsService = createEventsService({
  ddb,
  tableNames: { EVENTS_TABLE },
  nowEpoch,
  httpError,
  randomUUID,
  createFrequentReservationsForEvent: clientsService.createFrequentReservationsForEvent,
});

const reservationsHoldsService = createReservationsHoldsService({
  ddb,
  tableNames: {
    HOLDS_TABLE,
    RES_TABLE,
  },
  requiredEnv,
  httpError,
  nowEpoch,
  addDaysToIsoDate,
  randomUUID,
  normalizePhone,
  normalizePhoneE164,
  normalizePhoneCountry,
  detectPhoneCountryFromE164,
  getEventByDate: eventsService.getEventByDate,
  getDisabledTablesFromFrequent: clientsService.getDisabledTablesFromFrequent,
  getTablePriceForEvent,
});

const squarePaymentsService = createSquarePaymentsService({
  secretClient: secretsManager,
  env: {
    SQUARE_SECRET_ARN,
    SQUARE_ENV,
    SQUARE_LOCATION_ID,
    SQUARE_API_VERSION,
    SQUARE_CURRENCY: process.env.SQUARE_CURRENCY,
    SQUARE_WEBHOOK_NOTIFICATION_URL,
  },
  requiredEnv,
  httpError,
  randomUUID,
});

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

    const eventsRouteResponse = await handleEventsAndTablesRoute({
      method,
      path,
      event,
      cors,
      TABLE_TEMPLATE,
      json,
      noContent,
      getBody,
      requireAdmin,
      getUserLabel,
      listEvents: eventsService.listEvents,
      getEventByDate: eventsService.getEventByDate,
      listTableLocks: reservationsHoldsService.listTableLocks,
      releaseOverdueReservationsForEventDate:
        reservationsHoldsService.releaseOverdueReservationsForEventDate,
      getDisabledTablesFromFrequent: clientsService.getDisabledTablesFromFrequent,
      getEffectiveTables,
      createEvent: eventsService.createEvent,
      getEventById: eventsService.getEventById,
      updateEvent: eventsService.updateEvent,
      deleteEvent: eventsService.deleteEvent,
    });
    if (eventsRouteResponse) return eventsRouteResponse;

    const clientsRouteResponse = await handleClientsRoute({
      method,
      path,
      event,
      cors,
      json,
      noContent,
      getBody,
      requireAdmin,
      getUserLabel,
      listFrequentClients: clientsService.listFrequentClients,
      createFrequentClient: clientsService.createFrequentClient,
      getFrequentClientById: clientsService.getFrequentClientById,
      updateFrequentClient: clientsService.updateFrequentClient,
      deleteFrequentClient: clientsService.deleteFrequentClient,
      listCrmClients: clientsService.listCrmClients,
      updateCrmClient: clientsService.updateCrmClient,
      deleteCrmClient: clientsService.deleteCrmClient,
      searchCrmClients: clientsService.searchCrmClients,
    });
    if (clientsRouteResponse) return clientsRouteResponse;

    const squareWebhookRouteResponse = await handleSquareWebhookRoute({
      method,
      path,
      event,
      cors,
      json,
      requireAdmin,
      getSquareWebhookHealthSummary: squarePaymentsService.getWebhookHealthSummary,
      verifySquareWebhookSignature: squarePaymentsService.verifyWebhookSignature,
      processSquareWebhookEvent: squarePaymentsService.processSquareWebhookEvent,
      addReservationPayment: reservationsHoldsService.addReservationPayment,
    });
    if (squareWebhookRouteResponse) return squareWebhookRouteResponse;

    const reservationsAndHoldsResponse = await handleReservationsAndHoldsRoute({
      method,
      path,
      event,
      cors,
      json,
      noContent,
      getBody,
      getUserLabel,
      getGroupsFromEvent,
      requireStaffOrAdmin,
      createHold: reservationsHoldsService.createHold,
      listHolds: reservationsHoldsService.listHolds,
      releaseHold: reservationsHoldsService.releaseHold,
      createReservation: reservationsHoldsService.createReservation,
      upsertCrmClient: clientsService.upsertCrmClient,
      listReservations: reservationsHoldsService.listReservations,
      getReservationById: reservationsHoldsService.getReservationById,
      releaseOverdueReservationsForEventDate:
        reservationsHoldsService.releaseOverdueReservationsForEventDate,
      addReservationPayment: reservationsHoldsService.addReservationPayment,
      createSquarePayment: squarePaymentsService.createPayment,
      createSquarePaymentLink: squarePaymentsService.createPaymentLink,
      cancelReservation: reservationsHoldsService.cancelReservation,
    });
    if (reservationsAndHoldsResponse) return reservationsAndHoldsResponse;

    return json(404, { message: "Route not found", method, path }, cors);
  } catch (err) {
    console.error("ERROR", err);
    const status = Number(err?.statusCode) || 500;
    return json(status, { message: err?.message || "Internal error" }, cors);
  }
};
