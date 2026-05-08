import {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { createHash } from "crypto";

const DEFAULT_PASS_TTL_DAYS = 2;

export function createCheckInPassesService({
  ddb,
  tableNames,
  env,
  requiredEnv,
  httpError,
  nowEpoch,
  randomUUID,
  addDaysToIsoDate,
}) {
  const { CHECKIN_PASSES_TABLE, RES_TABLE } = tableNames;

  function requiredTableName() {
    return String(requiredEnv("CHECKIN_PASSES_TABLE", CHECKIN_PASSES_TABLE) ?? "").trim();
  }

  function requiredReservationsTableName() {
    return String(requiredEnv("RES_TABLE", RES_TABLE) ?? "").trim();
  }

  function normalizeTokenInput(value) {
    const raw = String(value ?? "").trim();
    if (!raw) return "";
    if (/^ffr-checkin:/i.test(raw)) {
      return raw.replace(/^ffr-checkin:/i, "").trim();
    }

    if (!raw.includes("://")) {
      const match = raw.match(/(?:^|[?&])token=([^&]+)/i);
      if (match) {
        try {
          return decodeURIComponent(match[1]);
        } catch {
          return match[1];
        }
      }
      return raw;
    }

    try {
      const parsed = new URL(raw);
      const queryToken = String(parsed.searchParams.get("token") ?? "").trim();
      return queryToken || raw;
    } catch {
      return raw;
    }
  }

  function hashToken(token) {
    return createHash("sha256").update(String(token ?? ""), "utf8").digest("hex");
  }

  function generateToken() {
    return `${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "")}`;
  }

  function resolvePassTtlDays() {
    const raw = Number(env.CHECKIN_PASS_TTL_DAYS);
    if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_PASS_TTL_DAYS;
    return Math.max(1, Math.min(30, Math.round(raw)));
  }

  function resolvePassExpiryEpoch(eventDate) {
    const fallback = nowEpoch() + resolvePassTtlDays() * 86400;
    const baseDate = String(eventDate ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(baseDate)) return fallback;

    const expiryDate = addDaysToIsoDate(baseDate, resolvePassTtlDays());
    const ms = Date.parse(`${expiryDate}T12:00:00Z`);
    if (!Number.isFinite(ms)) return fallback;
    return Math.floor(ms / 1000);
  }

  function resolvePassBaseUrl() {
    return String(env.CHECKIN_PASS_BASE_URL ?? "").trim();
  }

  function sanitizeHistoryValue(value) {
    if (value === null) return null;
    const valueType = typeof value;
    if (valueType === "string" || valueType === "number" || valueType === "boolean") {
      return value;
    }
    if (Array.isArray(value)) {
      return value
        .map((item) => sanitizeHistoryValue(item))
        .filter((item) => item !== undefined);
    }
    if (valueType === "object") {
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        const cleaned = sanitizeHistoryValue(v);
        if (cleaned !== undefined) out[k] = cleaned;
      }
      return out;
    }
    return undefined;
  }

  function toHistorySk(reservationId, at, eventId) {
    const ts = String(Number(at ?? 0) || 0).padStart(12, "0");
    return `HIST#${reservationId}#${ts}#${eventId}`;
  }

  async function appendReservationHistory({
    eventDate,
    reservationId,
    eventType,
    actor,
    source = null,
    tableId = null,
    customerName = null,
    details = null,
    at = null,
  }) {
    try {
      const reservationsTableName = requiredReservationsTableName();
      const normalizedEventDate = String(eventDate ?? "").trim();
      const normalizedReservationId = String(reservationId ?? "").trim();
      const normalizedEventType = String(eventType ?? "").trim().toUpperCase();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedEventDate)) return;
      if (!normalizedReservationId || !normalizedEventType) return;
      const eventAt = Number(at ?? 0) || nowEpoch();
      const eventId = randomUUID();
      await ddb.send(
        new PutCommand({
          TableName: reservationsTableName,
          Item: {
            PK: `EVENTDATE#${normalizedEventDate}`,
            SK: toHistorySk(normalizedReservationId, eventAt, eventId),
            entityType: "RESERVATION_HISTORY",
            eventId,
            eventType: normalizedEventType,
            reservationId: normalizedReservationId,
            eventDate: normalizedEventDate,
            tableId: String(tableId ?? "").trim() || null,
            customerName: String(customerName ?? "").trim() || null,
            actor: String(actor ?? "").trim() || "system",
            source: String(source ?? "").trim() || null,
            at: eventAt,
            details: sanitizeHistoryValue(details ?? null),
          },
        })
      );
    } catch (err) {
      console.warn("appendReservationHistory (checkin) failed", {
        reservationId: String(reservationId ?? "").trim() || null,
        eventDate: String(eventDate ?? "").trim() || null,
        eventType: String(eventType ?? "").trim() || null,
        message: String(err?.message ?? err ?? ""),
      });
    }
  }

  function buildPassUrl(token) {
    const baseUrl = resolvePassBaseUrl();
    if (!baseUrl) return null;

    if (baseUrl.includes("{token}")) {
      return baseUrl.replace("{token}", encodeURIComponent(token));
    }

    try {
      const parsed = new URL(baseUrl);
      parsed.searchParams.set("token", token);
      return parsed.toString();
    } catch {
      const joiner = baseUrl.includes("?") ? "&" : "?";
      return `${baseUrl}${joiner}token=${encodeURIComponent(token)}`;
    }
  }

  function toPassResponse(item, includeToken = false) {
    if (!item) return null;
    const token = includeToken ? String(item.token ?? "").trim() : "";
    return {
      passId: String(item.passId ?? "").trim() || null,
      reservationId: String(item.reservationId ?? "").trim() || null,
      eventDate: String(item.eventDate ?? "").trim() || null,
      tableId: String(item.tableId ?? "").trim() || null,
      customerName: String(item.customerName ?? "").trim() || null,
      phone: String(item.phone ?? "").trim() || null,
      status: String(item.status ?? "").trim() || null,
      issuedAt: Number(item.issuedAt ?? 0) || null,
      issuedBy: String(item.issuedBy ?? "").trim() || null,
      expiresAt: Number(item.expiresAt ?? 0) || null,
      usedAt: Number(item.usedAt ?? 0) || null,
      usedBy: String(item.usedBy ?? "").trim() || null,
      revokedAt: Number(item.revokedAt ?? 0) || null,
      revokedBy: String(item.revokedBy ?? "").trim() || null,
      token: token || null,
      url: token ? buildPassUrl(token) : null,
      qrPayload: token ? `ffr-checkin:${token}` : null,
    };
  }

  function isPassActive(item, now = nowEpoch()) {
    if (!item) return false;
    if (String(item.status ?? "").toUpperCase() !== "ISSUED") return false;
    const expiresAt = Number(item.expiresAt ?? 0);
    return Number.isFinite(expiresAt) && expiresAt > now;
  }

  function normalizePassForRead(item, now = nowEpoch()) {
    if (!item) return null;
    const status = String(item.status ?? "").toUpperCase();
    const expiresAt = Number(item.expiresAt ?? 0);
    if (
      status === "ISSUED" &&
      Number.isFinite(expiresAt) &&
      expiresAt > 0 &&
      expiresAt <= now
    ) {
      return {
        ...item,
        status: "EXPIRED",
      };
    }
    return item;
  }

  async function listReservationPasses(reservationId) {
    const tableName = requiredTableName();
    const normalizedReservationId = String(reservationId ?? "").trim();
    if (!normalizedReservationId) return [];

    const out = await ddb.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeValues: {
          ":pk": `RES#${normalizedReservationId}`,
          ":sk": "PASS#",
        },
      })
    );
    return (out.Items ?? []).sort(
      (a, b) => Number(b?.issuedAt ?? 0) - Number(a?.issuedAt ?? 0)
    );
  }

  async function revokePassItem(item, revokedBy) {
    if (!item) return;
    const tableName = requiredTableName();
    const now = nowEpoch();
    const pk = String(item.PK ?? "");
    const sk = String(item.SK ?? "");
    const tokenHash = String(item.tokenHash ?? "").trim();
    if (!pk || !sk || !tokenHash) return;

    try {
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: tableName,
                Key: { PK: pk, SK: sk },
                ConditionExpression: "#status = :issued",
                UpdateExpression:
                  "SET #status = :revoked, #revokedAt = :now, #revokedBy = :by, #updatedAt = :now",
                ExpressionAttributeNames: {
                  "#status": "status",
                  "#revokedAt": "revokedAt",
                  "#revokedBy": "revokedBy",
                  "#updatedAt": "updatedAt",
                },
                ExpressionAttributeValues: {
                  ":issued": "ISSUED",
                  ":revoked": "REVOKED",
                  ":now": now,
                  ":by": revokedBy,
                },
              },
            },
            {
              Update: {
                TableName: tableName,
                Key: { PK: `TOKEN#${tokenHash}`, SK: "LOOKUP" },
                ConditionExpression: "#status = :issued",
                UpdateExpression: "SET #status = :revoked, #updatedAt = :now",
                ExpressionAttributeNames: {
                  "#status": "status",
                  "#updatedAt": "updatedAt",
                },
                ExpressionAttributeValues: {
                  ":issued": "ISSUED",
                  ":revoked": "REVOKED",
                  ":now": now,
                },
              },
            },
          ],
        })
      );
    } catch (err) {
      if (err?.name === "ConditionalCheckFailedException") return;
      throw err;
    }
  }

  async function expirePassItem(item) {
    if (!item) return;
    const tableName = requiredTableName();
    const now = nowEpoch();
    const pk = String(item.PK ?? "");
    const sk = String(item.SK ?? "");
    const tokenHash = String(item.tokenHash ?? "").trim();
    if (!pk || !sk || !tokenHash) return;

    try {
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: tableName,
                Key: { PK: pk, SK: sk },
                ConditionExpression: "#status = :issued",
                UpdateExpression: "SET #status = :expired, #updatedAt = :now",
                ExpressionAttributeNames: {
                  "#status": "status",
                  "#updatedAt": "updatedAt",
                },
                ExpressionAttributeValues: {
                  ":issued": "ISSUED",
                  ":expired": "EXPIRED",
                  ":now": now,
                },
              },
            },
            {
              Update: {
                TableName: tableName,
                Key: { PK: `TOKEN#${tokenHash}`, SK: "LOOKUP" },
                ConditionExpression: "#status = :issued",
                UpdateExpression: "SET #status = :expired, #updatedAt = :now",
                ExpressionAttributeNames: {
                  "#status": "status",
                  "#updatedAt": "updatedAt",
                },
                ExpressionAttributeValues: {
                  ":issued": "ISSUED",
                  ":expired": "EXPIRED",
                  ":now": now,
                },
              },
            },
          ],
        })
      );
    } catch (err) {
      if (err?.name === "ConditionalCheckFailedException") return;
      throw err;
    }
  }

  async function issuePassForReservation({ reservation, issuedBy, reissue = false }) {
    const reservationId = String(reservation?.reservationId ?? "").trim();
    const eventDate = String(reservation?.eventDate ?? "").trim();
    const tableId = String(reservation?.tableId ?? "").trim();
    const status = String(reservation?.status ?? "").toUpperCase();
    const paymentStatus = String(reservation?.paymentStatus ?? "").toUpperCase();
    if (!reservationId || !eventDate || !tableId) {
      throw httpError(400, "reservationId, eventDate, and tableId are required");
    }
    if (status !== "CONFIRMED") {
      throw httpError(400, "Only confirmed reservations can receive a check-in pass");
    }
    if (paymentStatus !== "PAID") {
      throw httpError(400, "Reservation must be paid in full before issuing check-in pass");
    }

    const now = nowEpoch();
    const existing = await listReservationPasses(reservationId);
    const active = existing.find((item) => isPassActive(item, now));
    if (active && !reissue) {
      return {
        issued: false,
        reused: true,
        pass: toPassResponse(active, true),
      };
    }

    const issuer = String(issuedBy ?? "").trim() || "system:checkin-pass";
    if (reissue && active) {
      await revokePassItem(active, issuer);
    }

    const tableName = requiredTableName();
    const passId = randomUUID();
    const expiresAt = resolvePassExpiryEpoch(eventDate);
    let created = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const token = generateToken();
      const tokenHash = hashToken(token);
      const passPk = `RES#${reservationId}`;
      const passSk = `PASS#${passId}`;
      const passItem = {
        PK: passPk,
        SK: passSk,
        entityType: "CHECKIN_PASS",
        passId,
        reservationId,
        eventDate,
        tableId,
        customerName: String(reservation?.customerName ?? "").trim() || null,
        phone: String(reservation?.phone ?? "").trim() || null,
        status: "ISSUED",
        issuedAt: now,
        issuedBy: issuer,
        expiresAt,
        token,
        tokenHash,
        usedAt: null,
        usedBy: null,
        revokedAt: null,
        revokedBy: null,
        updatedAt: now,
      };
      const lookupItem = {
        PK: `TOKEN#${tokenHash}`,
        SK: "LOOKUP",
        entityType: "CHECKIN_TOKEN",
        tokenHash,
        status: "ISSUED",
        reservationId,
        eventDate,
        tableId,
        passId,
        reservationPk: passPk,
        reservationSk: passSk,
        issuedAt: now,
        expiresAt,
        updatedAt: now,
      };

      try {
        await ddb.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Put: {
                  TableName: tableName,
                  Item: passItem,
                  ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
                },
              },
              {
                Put: {
                  TableName: tableName,
                  Item: lookupItem,
                  ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
                },
              },
            ],
          })
        );
        created = passItem;
        break;
      } catch (err) {
        if (err?.name === "ConditionalCheckFailedException") continue;
        throw err;
      }
    }

    if (!created) {
      throw httpError(500, "Failed to create check-in pass");
    }

    await appendReservationHistory({
      eventDate,
      reservationId,
      eventType: reissue ? "CHECKIN_PASS_REISSUED" : "CHECKIN_PASS_ISSUED",
      actor: issuer,
      source: String(issuer).startsWith("system:") ? "system" : "staff",
      tableId,
      customerName: String(reservation?.customerName ?? "").trim() || null,
      at: now,
      details: {
        passId,
        expiresAt,
        reissue: Boolean(reissue),
      },
    });

    return {
      issued: true,
      reused: false,
      pass: toPassResponse(created, true),
    };
  }

  async function getActivePassForReservation(reservationId, { includeToken = true } = {}) {
    const now = nowEpoch();
    const passes = await listReservationPasses(reservationId);
    const active = passes.find((item) => isPassActive(item, now));
    return active ? toPassResponse(active, includeToken) : null;
  }

  async function getLatestPassForReservation(reservationId, { includeToken = false } = {}) {
    const now = nowEpoch();
    const passes = await listReservationPasses(reservationId);
    const latest = normalizePassForRead(passes[0], now);
    if (!latest) return null;
    const latestStatus = String(latest.status ?? "").toUpperCase();
    const allowToken = includeToken && latestStatus === "ISSUED";
    return toPassResponse(latest, allowToken);
  }

  async function getPassPreviewByToken(token) {
    const parsedToken = normalizeTokenInput(token);
    if (!parsedToken) {
      throw httpError(400, "token is required");
    }

    const tableName = requiredTableName();
    const tokenHash = hashToken(parsedToken);
    const lookupOut = await ddb.send(
      new GetCommand({
        TableName: tableName,
        Key: { PK: `TOKEN#${tokenHash}`, SK: "LOOKUP" },
      })
    );
    const lookup = lookupOut.Item;
    if (!lookup) {
      throw httpError(404, "Pass not found");
    }

    const reservationPk = String(lookup.reservationPk ?? "").trim();
    const reservationSk = String(lookup.reservationSk ?? "").trim();
    if (!reservationPk || !reservationSk) {
      throw httpError(404, "Pass not found");
    }

    const passOut = await ddb.send(
      new GetCommand({
        TableName: tableName,
        Key: { PK: reservationPk, SK: reservationSk },
      })
    );
    const passItem = normalizePassForRead(passOut.Item, nowEpoch());
    if (!passItem) {
      throw httpError(404, "Pass not found");
    }

    const pass = toPassResponse(passItem, false);
    return {
      passId: String(pass?.passId ?? "").trim() || null,
      reservationId: String(pass?.reservationId ?? "").trim() || null,
      eventDate: String(pass?.eventDate ?? "").trim() || null,
      tableId: String(pass?.tableId ?? "").trim() || null,
      customerName: String(pass?.customerName ?? "").trim() || null,
      status: String(pass?.status ?? "").trim() || null,
      expiresAt: Number(pass?.expiresAt ?? 0) || null,
    };
  }

  function resultForState(code, message, passItem = null) {
    const pass = toPassResponse(passItem, false);
    return {
      ok: code === "CHECKED_IN",
      code,
      message,
      pass,
      reservation: pass
        ? {
            reservationId: pass.reservationId,
            eventDate: pass.eventDate,
            tableId: pass.tableId,
            customerName: pass.customerName,
          }
        : null,
    };
  }

  async function verifyAndConsumePass({ token, scannerUser, scannerDevice }) {
    const parsedToken = normalizeTokenInput(token);
    if (!parsedToken) {
      return resultForState("INVALID_TOKEN", "Token is required");
    }

    const tableName = requiredTableName();
    const tokenHash = hashToken(parsedToken);
    const lookupOut = await ddb.send(
      new GetCommand({
        TableName: tableName,
        Key: { PK: `TOKEN#${tokenHash}`, SK: "LOOKUP" },
      })
    );
    const lookup = lookupOut.Item;
    if (!lookup) {
      return resultForState("INVALID_TOKEN", "Pass not found");
    }

    const reservationPk = String(lookup.reservationPk ?? "").trim();
    const reservationSk = String(lookup.reservationSk ?? "").trim();
    if (!reservationPk || !reservationSk) {
      return resultForState("INVALID_TOKEN", "Pass lookup is invalid");
    }

    const passOut = await ddb.send(
      new GetCommand({
        TableName: tableName,
        Key: { PK: reservationPk, SK: reservationSk },
      })
    );
    const passItem = passOut.Item;
    if (!passItem) {
      return resultForState("INVALID_TOKEN", "Pass record not found");
    }

    const now = nowEpoch();
    const passStatus = String(passItem.status ?? "").toUpperCase();
    const expiresAt = Number(passItem.expiresAt ?? 0);
    if (Number.isFinite(expiresAt) && expiresAt <= now) {
      if (passStatus === "ISSUED") {
        try {
          await expirePassItem(passItem);
        } catch {
          // Ignore transition race; scanner still receives expired state.
        }
      }
      return resultForState("EXPIRED", "Pass is expired", passItem);
    }
    if (passStatus === "USED") {
      return resultForState("ALREADY_USED", "Pass already used", passItem);
    }
    if (passStatus === "REVOKED") {
      return resultForState("REVOKED", "Pass was revoked", passItem);
    }
    if (passStatus !== "ISSUED") {
      return resultForState("INVALID_TOKEN", "Pass is not valid", passItem);
    }

    const by = String(scannerUser ?? "").trim() || "system:checkin";
    const device = String(scannerDevice ?? "").trim() || null;
    try {
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: tableName,
                Key: { PK: reservationPk, SK: reservationSk },
                ConditionExpression: "#status = :issued",
                UpdateExpression:
                  "SET #status = :used, #usedAt = :now, #usedBy = :by, #usedDevice = :device, #updatedAt = :now",
                ExpressionAttributeNames: {
                  "#status": "status",
                  "#usedAt": "usedAt",
                  "#usedBy": "usedBy",
                  "#usedDevice": "usedDevice",
                  "#updatedAt": "updatedAt",
                },
                ExpressionAttributeValues: {
                  ":issued": "ISSUED",
                  ":used": "USED",
                  ":now": now,
                  ":by": by,
                  ":device": device,
                },
              },
            },
            {
              Update: {
                TableName: tableName,
                Key: { PK: `TOKEN#${tokenHash}`, SK: "LOOKUP" },
                ConditionExpression: "#status = :issued",
                UpdateExpression: "SET #status = :used, #usedAt = :now, #updatedAt = :now",
                ExpressionAttributeNames: {
                  "#status": "status",
                  "#usedAt": "usedAt",
                  "#updatedAt": "updatedAt",
                },
                ExpressionAttributeValues: {
                  ":issued": "ISSUED",
                  ":used": "USED",
                  ":now": now,
                },
              },
            },
          ],
        })
      );
    } catch (err) {
      if (err?.name !== "ConditionalCheckFailedException") throw err;
      const refreshed = await ddb.send(
        new GetCommand({
          TableName: tableName,
          Key: { PK: reservationPk, SK: reservationSk },
        })
      );
      const latest = refreshed.Item ?? passItem;
      const latestStatus = String(latest.status ?? "").toUpperCase();
      if (latestStatus === "USED") {
        return resultForState("ALREADY_USED", "Pass already used", latest);
      }
      if (latestStatus === "REVOKED") {
        return resultForState("REVOKED", "Pass was revoked", latest);
      }
      return resultForState("INVALID_TOKEN", "Pass is not valid", latest);
    }

    const consumed = {
      ...passItem,
      status: "USED",
      usedAt: now,
      usedBy: by,
      usedDevice: device,
      updatedAt: now,
    };

    try {
      const reservationsTableName = requiredReservationsTableName();
      const reservationEventDate = String(consumed.eventDate ?? lookup.eventDate ?? "").trim();
      const reservationId = String(consumed.reservationId ?? lookup.reservationId ?? "").trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(reservationEventDate) && reservationId) {
        await ddb.send(
          new UpdateCommand({
            TableName: reservationsTableName,
            Key: {
              PK: `EVENTDATE#${reservationEventDate}`,
              SK: `RES#${reservationId}`,
            },
            ConditionExpression: "attribute_exists(PK) AND attribute_exists(SK)",
            UpdateExpression:
              "SET #checkedInAt = :checkedInAt, #checkedInBy = :checkedInBy, #checkedInDevice = :checkedInDevice, #updatedAt = :checkedInAt",
            ExpressionAttributeNames: {
              "#checkedInAt": "checkedInAt",
              "#checkedInBy": "checkedInBy",
              "#checkedInDevice": "checkedInDevice",
              "#updatedAt": "updatedAt",
            },
            ExpressionAttributeValues: {
              ":checkedInAt": now,
              ":checkedInBy": by,
              ":checkedInDevice": device,
            },
          })
        );
      }
    } catch (err) {
      console.warn("check-in reservation update failed", {
        message: String(err?.message ?? err ?? ""),
      });
    }

    await appendReservationHistory({
      eventDate: String(consumed.eventDate ?? lookup.eventDate ?? "").trim(),
      reservationId: String(consumed.reservationId ?? lookup.reservationId ?? "").trim(),
      eventType: "CHECKED_IN",
      actor: by,
      source: "scanner",
      tableId: String(consumed.tableId ?? lookup.tableId ?? "").trim() || null,
      customerName: String(consumed.customerName ?? "").trim() || null,
      at: now,
      details: {
        passId: String(consumed.passId ?? "").trim() || null,
        usedDevice: device,
      },
    });

    return resultForState("CHECKED_IN", "Check-in successful", consumed);
  }

  return {
    issuePassForReservation,
    getActivePassForReservation,
    getLatestPassForReservation,
    getPassPreviewByToken,
    verifyAndConsumePass,
  };
}
