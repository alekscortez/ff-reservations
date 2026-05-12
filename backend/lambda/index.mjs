import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  CognitoIdentityProviderClient,
  AdminGetUserCommand,
  AdminCreateUserCommand,
  AdminAddUserToGroupCommand,
  AdminRemoveUserFromGroupCommand,
  AdminEnableUserCommand,
  AdminDisableUserCommand,
  AdminResetUserPasswordCommand,
  AdminListGroupsForUserCommand,
  ListUsersCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import {
  SNSClient,
} from "@aws-sdk/client-sns";
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
  normalizeNameForSearch,
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
import { handleCheckInRoute } from "./lib/routes-checkin.mjs";
import { handleSettingsRoute } from "./lib/routes-settings.mjs";
import { handleUsersRoute } from "./lib/routes-users.mjs";
import { handleAdminRoute } from "./lib/routes-admin.mjs";
import { handleCustomerAuthRoute } from "./lib/routes-customer-auth.mjs";
import { handleMeRoute } from "./lib/routes-me.mjs";
import { createMeService } from "./lib/services-me.mjs";
import { handlePackagesRoute } from "./lib/routes-packages.mjs";
import { createPackagesService } from "./lib/services-packages.mjs";
import { createClientsService } from "./lib/services-clients.mjs";
import { createReservationsHoldsService } from "./lib/services-reservations-holds.mjs";
import { createPushNotificationsService } from "./lib/services-push-notifications.mjs";
import { createWalletPassService } from "./lib/services-wallet-pass.mjs";
import { createEventsService } from "./lib/services-events.mjs";
import { createSquarePaymentsService } from "./lib/services-square-payments.mjs";
import { createCheckInPassesService } from "./lib/services-checkin-passes.mjs";
import { createSmsNotificationsService } from "./lib/services-sms-notifications.mjs";
import { createSettingsService } from "./lib/services-settings.mjs";
import { createUsersService } from "./lib/services-users.mjs";
import { createRateLimitService } from "./lib/services-rate-limit.mjs";


const EVENTS_TABLE = process.env.EVENTS_TABLE;
const HOLDS_TABLE = process.env.HOLDS_TABLE;
const RES_TABLE = process.env.RES_TABLE;
const FREQUENT_CLIENTS_TABLE = process.env.FREQUENT_CLIENTS_TABLE;
const CLIENTS_TABLE = process.env.CLIENTS_TABLE;
const USER_POOL_ID = process.env.USER_POOL_ID;
const CUSTOMER_CLIENT_ID = process.env.CUSTOMER_CLIENT_ID;
const SQUARE_SECRET_ARN = process.env.SQUARE_SECRET_ARN;
const SQUARE_ENV = process.env.SQUARE_ENV;
const SQUARE_LOCATION_ID = process.env.SQUARE_LOCATION_ID;
const SQUARE_API_VERSION = process.env.SQUARE_API_VERSION;
const SQUARE_WEBHOOK_NOTIFICATION_URL = process.env.SQUARE_WEBHOOK_NOTIFICATION_URL;
const SMS_ENABLED = process.env.SMS_ENABLED;
const SMS_SENDER_ID = process.env.SMS_SENDER_ID;
const SMS_TYPE = process.env.SMS_TYPE;
const SMS_MAX_PRICE_USD = process.env.SMS_MAX_PRICE_USD;
const AUTO_SEND_SQUARE_LINK_SMS = process.env.AUTO_SEND_SQUARE_LINK_SMS;
const PAYMENT_LINK_TTL_MINUTES = process.env.PAYMENT_LINK_TTL_MINUTES;
const FREQUENT_PAYMENT_LINK_TTL_MINUTES = process.env.FREQUENT_PAYMENT_LINK_TTL_MINUTES;
const CHECKIN_PASSES_TABLE = process.env.CHECKIN_PASSES_TABLE;
const CHECKIN_PASS_BASE_URL = process.env.CHECKIN_PASS_BASE_URL;
const CHECKIN_PASS_TTL_DAYS = process.env.CHECKIN_PASS_TTL_DAYS;
const CASH_APP_LINK_BASE_URL = process.env.CASH_APP_LINK_BASE_URL;
const SETTINGS_TABLE = process.env.SETTINGS_TABLE;
const PACKAGES_TABLE = process.env.PACKAGES_TABLE;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TABLE_TEMPLATE_PATH = path.join(__dirname, "table-template.json");
const TABLE_TEMPLATE = JSON.parse(fs.readFileSync(TABLE_TEMPLATE_PATH, "utf8"));

// Apple Wallet pass icons loaded at cold start. Missing files mean the
// wallet feature stays disabled (createWalletPassService.isEnabled()
// returns false) and /me/reservations/{id}/wallet-pass returns 501.
const WALLET_PASS_ASSETS_DIR = path.join(__dirname, "assets", "wallet-pass");
function loadWalletPassAsset(filename) {
  const p = path.join(WALLET_PASS_ASSETS_DIR, filename);
  try {
    return fs.readFileSync(p);
  } catch {
    return null;
  }
}
const WALLET_PASS_ASSETS = {
  iconPng: loadWalletPassAsset("icon.png"),
  icon2xPng: loadWalletPassAsset("icon@2x.png"),
  icon3xPng: loadWalletPassAsset("icon@3x.png"),
  logoPng: loadWalletPassAsset("logo.png"),
  logo2xPng: loadWalletPassAsset("logo@2x.png"),
  logo3xPng: loadWalletPassAsset("logo@3x.png"),
};

// maxAttempts: 2 keeps p95 down on TransactWrite contention (hold->reserve,
// payment recording). SDK default is 3 with exponential backoff, which can
// stack 1-2s of retry latency before the caller sees the failure. Two
// attempts is one retry; the rest of the system handles ConditionalCheck
// failures explicitly anyway.
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ maxAttempts: 2 }));
const cognito = new CognitoIdentityProviderClient({});
const secretsManager = new SecretsManagerClient({});
const sns = new SNSClient({});

// Bounded LRU for the username → display-name cache. Map preserves insertion
// order, so deleting the first key on overflow approximates LRU. Reads bump
// the entry to "newest" by re-inserting. TTL still enforced at read site.
const USER_CACHE_MAX = 256;
const userCache = new Map();
function userCacheGet(key) {
  if (!userCache.has(key)) return undefined;
  const value = userCache.get(key);
  userCache.delete(key);
  userCache.set(key, value);
  return value;
}
function userCacheSet(key, value) {
  if (userCache.has(key)) userCache.delete(key);
  userCache.set(key, value);
  while (userCache.size > USER_CACHE_MAX) {
    const oldest = userCache.keys().next().value;
    if (oldest === undefined) break;
    userCache.delete(oldest);
  }
}

// Cold-start visibility: structured warning for any unset env var that the
// router or one of the services treats as required. Doesn't throw — each
// route still calls requiredEnv() lazily — but surfaces config drift before
// the first request lands.
(function logUnsetCriticalEnv() {
  const expected = [
    "EVENTS_TABLE",
    "HOLDS_TABLE",
    "RES_TABLE",
    "FREQUENT_CLIENTS_TABLE",
    "CLIENTS_TABLE",
    "CHECKIN_PASSES_TABLE",
    "SETTINGS_TABLE",
    "USER_POOL_ID",
    "SQUARE_SECRET_ARN",
    "SQUARE_ENV",
    "SQUARE_LOCATION_ID",
  ];
  const missing = expected.filter((name) => !String(process.env[name] ?? "").trim());
  if (missing.length > 0) {
    console.warn("lambda_cold_start_missing_env", { missing });
  }
})();

const envAutoSendSquareLinkSmsEnabled =
  String(AUTO_SEND_SQUARE_LINK_SMS ?? "false").trim().toLowerCase() === "true";

// ---------- scheduled maintenance (EventBridge) ----------

async function runScheduledMaintenance(event) {
  const startedAtMs = Date.now();
  try {
    const result =
      await reservationsHoldsService.releaseOverdueReservationsForAllActiveEvents();
    console.info("scheduled_maintenance_release_overdue", {
      ...result,
      durationMs: Date.now() - startedAtMs,
      ruleArn: Array.isArray(event?.resources) ? event.resources[0] : null,
    });
    return { ok: true, ...result };
  } catch (err) {
    console.error("scheduled_maintenance_failed", {
      message: String(err?.message ?? err ?? ""),
      durationMs: Date.now() - startedAtMs,
    });
    throw err;
  }
}

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

  const now = Date.now();
  const cached = userCacheGet(username);
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
    userCacheSet(username, { value, ts: now });
    return value;
  } catch {
    userCacheSet(username, { value: null, ts: now });
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

// Returns the authenticated user's Cognito sub, or throws 401 if the
// token is missing/invalid. Called by /me/* routes to identify the
// customer; the route then enforces resource ownership against this
// sub. Defense in depth — API Gateway's customer-only authorizer is
// the first line, this is the second.
function requireCustomerOwnership(event) {
  const claims = event?.requestContext?.authorizer?.jwt?.claims ?? {};
  const sub = String(claims.sub ?? "").trim();
  if (!sub) {
    throw httpError(401, "Customer authentication required");
  }
  return sub;
}

// If you enabled CORS at API Gateway, you *usually* don’t need CORS headers here.
// But having them here helps local testing / direct lambda invoke.
function corsHeaders(event) {
  const origin = event.headers?.origin || event.headers?.Origin;
  // keep strict: only allow your known origins
  const allowed = new Set([
    "http://localhost:4200",
    "https://main.d1gxn3rvy5gfn4.amplifyapp.com",
    "https://famosofuego.com",
    "https://www.famosofuego.com",
    "https://app.famosofuego.com",
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
  normalizeNameForSearch,
  nowEpoch,
  httpError,
  addDaysToIsoDate,
  getTablePriceForEvent,
});

const settingsService = createSettingsService({
  ddb,
  tableNames: {
    SETTINGS_TABLE,
  },
  env: process.env,
  nowEpoch,
  httpError,
});

const rateLimitService = createRateLimitService({
  ddb,
  tableNames: { HOLDS_TABLE },
  nowEpoch,
  httpError,
});

const usersService = createUsersService({
  cognito,
  userPoolId: USER_POOL_ID,
  requiredEnv,
  httpError,
  commands: {
    AdminCreateUserCommand,
    AdminAddUserToGroupCommand,
    AdminRemoveUserFromGroupCommand,
    AdminEnableUserCommand,
    AdminDisableUserCommand,
    AdminResetUserPasswordCommand,
    AdminListGroupsForUserCommand,
    ListUsersCommand,
    AdminGetUserCommand,
  },
});

const meService = createMeService({
  ddb,
  cognito,
  userPoolId: USER_POOL_ID,
  CLIENTS_TABLE,
  RES_TABLE,
  httpError,
  nowEpoch,
  listRescheduleCreditsByPhone: clientsService.listRescheduleCreditsByPhone,
});

const eventsService = createEventsService({
  ddb,
  tableNames: { EVENTS_TABLE },
  nowEpoch,
  httpError,
  randomUUID,
  createFrequentReservationsForEvent: clientsService.createFrequentReservationsForEvent,
});

const packagesService = createPackagesService({
  ddb,
  tableNames: { PACKAGES_TABLE },
  nowEpoch,
  httpError,
  randomUUID,
});

const checkInPassesService = createCheckInPassesService({
  ddb,
  tableNames: {
    CHECKIN_PASSES_TABLE,
    RES_TABLE,
  },
  env: {
    CHECKIN_PASS_BASE_URL,
    CHECKIN_PASS_TTL_DAYS,
  },
  requiredEnv,
  httpError,
  nowEpoch,
  randomUUID,
  addDaysToIsoDate,
  getAppSettings: settingsService.getAppSettings,
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

const smsNotificationsService = createSmsNotificationsService({
  snsClient: sns,
  env: {
    SMS_ENABLED,
    SMS_SENDER_ID,
    SMS_TYPE,
    SMS_MAX_PRICE_USD,
  },
  httpError,
  nowEpoch,
  getAppSettings: settingsService.getAppSettings,
});

const pushNotificationsService = createPushNotificationsService({
  ddb,
  CLIENTS_TABLE,
  expoAccessToken: process.env.EXPO_ACCESS_TOKEN ?? null,
});

const walletPassService = createWalletPassService({
  secretClient: secretsManager,
  env: {
    WALLET_PASS_TYPE_IDENTIFIER: process.env.WALLET_PASS_TYPE_IDENTIFIER,
    WALLET_TEAM_IDENTIFIER: process.env.WALLET_TEAM_IDENTIFIER,
    WALLET_PASS_SECRET_ARN: process.env.WALLET_PASS_SECRET_ARN,
    WALLET_ORGANIZATION_NAME: process.env.WALLET_ORGANIZATION_NAME,
    WALLET_LOGO_TEXT: process.env.WALLET_LOGO_TEXT,
    WALLET_BACKGROUND_COLOR: process.env.WALLET_BACKGROUND_COLOR,
    WALLET_FOREGROUND_COLOR: process.env.WALLET_FOREGROUND_COLOR,
    WALLET_LABEL_COLOR: process.env.WALLET_LABEL_COLOR,
  },
  httpError,
  assets: WALLET_PASS_ASSETS,
});

const reservationsHoldsService = createReservationsHoldsService({
  ddb,
  tableNames: {
    EVENTS_TABLE,
    HOLDS_TABLE,
    RES_TABLE,
    CLIENTS_TABLE,
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
  listEvents: eventsService.listEvents,
  getDisabledTablesFromFrequent: clientsService.getDisabledTablesFromFrequent,
  getTablePriceForEvent,
  ensureCheckInPassForReservation: checkInPassesService.issuePassForReservation,
  deactivateSquarePaymentLink: squarePaymentsService.deactivatePaymentLink,
  refundSquarePayment: squarePaymentsService.refundPayment,
  sendPaymentLinkExpiredSms: smsNotificationsService.sendPaymentLinkExpiredSms,
  sendCheckInPassSms: smsNotificationsService.sendCheckInPassSms,
  paymentLinkTtlMinutes: PAYMENT_LINK_TTL_MINUTES,
  frequentPaymentLinkTtlMinutes: FREQUENT_PAYMENT_LINK_TTL_MINUTES,
  isFrequentReservationByPhoneAndTable: clientsService.isFrequentReservationByPhoneAndTable,
  getAppSettings: settingsService.getAppSettings,
  pushNotifications: pushNotificationsService,
});

// ---------- router ----------
export const handler = async (event) => {
  // EventBridge scheduled invocations: not HTTP. Run cron sweeps and return.
  if (event?.source === "aws.events" || event?.["detail-type"] === "Scheduled Event") {
    return await runScheduledMaintenance(event);
  }

  const method = event.requestContext?.http?.method || "GET";
  const path = event.requestContext?.http?.path || event.rawPath || "/";
  const cors = corsHeaders(event);

  // Handle OPTIONS (preflight) safely
  if (method === "OPTIONS") {
    return noContent(204, {
      ...cors,
      "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
      "access-control-allow-headers": "authorization,content-type,idempotency-key",
      "access-control-max-age": "600",
    });
  }

  try {
    // sanity check
    if (!EVENTS_TABLE) {
      return json(500, { message: "Missing env var EVENTS_TABLE" }, cors);
    }

    const customerAuthResponse = await handleCustomerAuthRoute({
      method,
      path,
      event,
      cors,
      json,
      getBody,
      customerClientId: CUSTOMER_CLIENT_ID,
      checkAndIncrementSmsRateLimit:
        rateLimitService.checkAndIncrementSmsRateLimit,
    });
    if (customerAuthResponse) return customerAuthResponse;

    const meRouteResponse = await handleMeRoute({
      method,
      path,
      event,
      cors,
      json,
      noContent,
      httpError,
      getBody,
      requireCustomerOwnership,
      // identity
      getProfile: meService.getProfile,
      deleteAccount: meService.deleteAccount,
      listReservations: meService.listReservations,
      // reservations + holds
      getReservationById: reservationsHoldsService.getReservationById,
      createHold: reservationsHoldsService.createHold,
      createReservation: reservationsHoldsService.createReservation,
      cancelReservation: reservationsHoldsService.cancelReservation,
      rescheduleReservationForCustomer:
        reservationsHoldsService.rescheduleReservationForCustomer,
      // pass
      getActivePassForReservation: checkInPassesService.getActivePassForReservation,
      issuePassForReservation: checkInPassesService.issuePassForReservation,
      generateWalletPass: walletPassService.generatePkpassForReservation,
      walletPassEnabled: walletPassService.isEnabled,
      // payments
      createSquarePayment: squarePaymentsService.createPayment,
      createSquarePaymentLink: squarePaymentsService.createPaymentLink,
      setReservationPaymentLinkWindow:
        reservationsHoldsService.setReservationPaymentLinkWindow,
      addReservationPayment: reservationsHoldsService.addReservationPayment,
      refundSquarePayment: squarePaymentsService.refundPayment,
      appendReservationHistory: reservationsHoldsService.appendReservationHistory,
      // credits + push tokens
      listCreditsForCustomer: meService.listCreditsForCustomer,
      registerPushToken: meService.registerPushToken,
      unregisterPushToken: meService.unregisterPushToken,
      // rate limit
      checkAndIncrementCustomerHoldRateLimit:
        rateLimitService.checkAndIncrementCustomerHoldRateLimit,
    });
    if (meRouteResponse) return meRouteResponse;

    const adminRouteResponse = await handleAdminRoute({
      method,
      path,
      event,
      cors,
      json,
      getGroupsFromEvent,
    });
    if (adminRouteResponse) return adminRouteResponse;

    const settingsRouteResponse = await handleSettingsRoute({
      method,
      path,
      event,
      cors,
      json,
      getBody,
      requireAdmin,
      requireStaffOrAdmin,
      getUserLabel,
      getAppSettings: settingsService.getAppSettings,
      updateAppSettings: settingsService.updateAppSettings,
      resolveBusinessDate: settingsService.resolveBusinessDate,
      runtimeSettingsSubset: settingsService.runtimeSettingsSubset,
      getEventByDate: eventsService.getEventByDate,
      listEvents: eventsService.listEvents,
    });
    if (settingsRouteResponse) return settingsRouteResponse;

    const usersRouteResponse = await handleUsersRoute({
      method,
      path,
      event,
      cors,
      json,
      getBody,
      requireAdmin,
      listUsers: usersService.listUsers,
      createUser: usersService.createUser,
      updateUserRole: usersService.updateUserRole,
      updateUserStatus: usersService.updateUserStatus,
      resetUserPassword: usersService.resetUserPassword,
    });
    if (usersRouteResponse) return usersRouteResponse;

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
      requireStaffOrAdmin,
      getUserLabel,
      listEvents: eventsService.listEvents,
      getEventByDate: eventsService.getEventByDate,
      listTableLocks: reservationsHoldsService.listTableLocks,
      listReservations: reservationsHoldsService.listReservations,
      releaseOverdueReservationsForEventDate:
        reservationsHoldsService.releaseOverdueReservationsForEventDate,
      getDisabledTablesFromFrequent: clientsService.getDisabledTablesFromFrequent,
      getEffectiveTables,
      createEvent: eventsService.createEvent,
      getEventById: eventsService.getEventById,
      updateEvent: eventsService.updateEvent,
      deleteEvent: eventsService.deleteEvent,
      getAppSettings: settingsService.getAppSettings,
      resolveBusinessDate: settingsService.resolveBusinessDate,
    });
    if (eventsRouteResponse) return eventsRouteResponse;

    const packagesRouteResponse = await handlePackagesRoute({
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
      listPackages: packagesService.listPackages,
      getPackageById: packagesService.getPackageById,
      createPackage: packagesService.createPackage,
      updatePackage: packagesService.updatePackage,
      deletePackage: packagesService.deletePackage,
    });
    if (packagesRouteResponse) return packagesRouteResponse;

    const clientsRouteResponse = await handleClientsRoute({
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
      listFrequentClients: clientsService.listFrequentClients,
      createFrequentClient: clientsService.createFrequentClient,
      getFrequentClientById: clientsService.getFrequentClientById,
      updateFrequentClient: clientsService.updateFrequentClient,
      deleteFrequentClient: clientsService.deleteFrequentClient,
      listCrmClients: clientsService.listCrmClients,
      updateCrmClient: clientsService.updateCrmClient,
      deleteCrmClient: clientsService.deleteCrmClient,
      searchCrmClients: clientsService.searchCrmClients,
      listRescheduleCreditsByPhone: clientsService.listRescheduleCreditsByPhone,
      bulkImportCrmClients: clientsService.bulkImportCrmClients,
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
      httpError,
      getBody,
      getUserLabel,
      getGroupsFromEvent,
      autoSendSquareLinkSmsEnabled: Boolean(
        (await settingsService.getAppSettings())?.autoSendSquareLinkSms ??
          envAutoSendSquareLinkSmsEnabled
      ),
      requireStaffOrAdmin,
      createHold: reservationsHoldsService.createHold,
      listHolds: reservationsHoldsService.listHolds,
      releaseHold: reservationsHoldsService.releaseHold,
      createReservation: reservationsHoldsService.createReservation,
      upsertCrmClient: clientsService.upsertCrmClient,
      listReservations: reservationsHoldsService.listReservations,
      listReservationHistory: reservationsHoldsService.listReservationHistory,
      getReservationById: reservationsHoldsService.getReservationById,
      releaseOverdueReservationsForEventDate:
        reservationsHoldsService.releaseOverdueReservationsForEventDate,
      addReservationPayment: reservationsHoldsService.addReservationPayment,
      setReservationPaymentLinkWindow:
        reservationsHoldsService.setReservationPaymentLinkWindow,
      setReservationCashAppLinkSession:
        reservationsHoldsService.setReservationCashAppLinkSession,
      markReservationCashAppLinkSessionUsed:
        reservationsHoldsService.markReservationCashAppLinkSessionUsed,
      appendReservationHistory: reservationsHoldsService.appendReservationHistory,
      createSquarePayment: squarePaymentsService.createPayment,
      createSquarePaymentLink: squarePaymentsService.createPaymentLink,
      refundSquarePayment: squarePaymentsService.refundPayment,
      sendPaymentLinkSms: smsNotificationsService.sendPaymentLinkSms,
      cancelReservation: reservationsHoldsService.cancelReservation,
      getRuntimeSettingsSubset: async () =>
        settingsService.runtimeSettingsSubset(await settingsService.getAppSettings()),
      getEventByDate: eventsService.getEventByDate,
      cashAppLinkBaseUrl: CASH_APP_LINK_BASE_URL,
      checkInPassBaseUrl: CHECKIN_PASS_BASE_URL,
    });
    if (reservationsAndHoldsResponse) return reservationsAndHoldsResponse;

    const checkInRouteResponse = await handleCheckInRoute({
      method,
      path,
      event,
      cors,
      json,
      getBody,
      getUserLabel,
      requireStaffOrAdmin,
      getReservationById: reservationsHoldsService.getReservationById,
      issueCheckInPassForReservation: checkInPassesService.issuePassForReservation,
      getActiveCheckInPassForReservation:
        checkInPassesService.getActivePassForReservation,
      getLatestCheckInPassForReservation:
        checkInPassesService.getLatestPassForReservation,
      getPassPreviewByToken: checkInPassesService.getPassPreviewByToken,
      verifyAndConsumeCheckInPass: checkInPassesService.verifyAndConsumePass,
    });
    if (checkInRouteResponse) return checkInRouteResponse;

    return json(404, { message: "Route not found", method, path }, cors);
  } catch (err) {
    const requestId = String(
      event?.requestContext?.requestId ??
        event?.requestContext?.http?.requestId ??
        ""
    ).trim() || null;
    const intentional = Number(err?.statusCode) > 0;
    console.error("router_error", {
      requestId,
      method,
      path,
      intentional,
      name: err?.name ?? null,
      message: String(err?.message ?? err ?? ""),
      stack: intentional ? null : err?.stack ?? null,
    });
    if (intentional) {
      return json(Number(err.statusCode), { message: String(err.message ?? "Error") }, cors);
    }
    // Unknown error: don't echo internals to the client.
    return json(
      500,
      {
        message: "Internal error",
        requestId,
      },
      cors
    );
  }
};
