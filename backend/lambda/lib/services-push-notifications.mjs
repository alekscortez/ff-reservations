// Push notification dispatcher (Expo Push). Owns the read side of the
// CLIENTS_TABLE PUSHTOKEN#{sub} rows (registerPushToken in services-me
// owns the write side) and the HTTPS POST to Expo's push API.
//
// Design choices
// - Fire-and-forget. Callers shouldn't block on push delivery; rejections
//   inside this module never throw to the caller. We log + clean up
//   stale tokens, then move on.
// - Per-sub fan-out. One customer may have N tokens (multiple devices
//   or stale tokens that haven't TTL-expired yet). We send to all of
//   them and only the latest is meaningful — Expo dedups on the device.
// - Token cleanup. Expo's response includes per-ticket statuses; the
//   "DeviceNotRegistered" error means the user uninstalled or revoked
//   permission. Delete those tokens so we stop dispatching to a dead
//   address.
// - Sandbox-friendly. The Expo Push HTTP API works the same in dev and
//   prod; no API key required for the basic endpoint. Higher-volume
//   senders should add the Authorization header with an EXPO_ACCESS_TOKEN
//   but our volume is tiny, so we skip it for v1.

import { DeleteCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";

const EXPO_PUSH_ENDPOINT = "https://exp.host/--/api/v2/push/send";
const EXPO_TICKET_TIMEOUT_MS = 8000;

export function createPushNotificationsService({
  ddb,
  CLIENTS_TABLE,
  fetchImpl,
  expoAccessToken,
}) {
  const httpFetch = fetchImpl ?? globalThis.fetch;

  async function listTokensForSub(sub) {
    if (!CLIENTS_TABLE) return [];
    const subStr = String(sub ?? "").trim();
    if (!subStr) return [];
    try {
      const res = await ddb.send(
        new QueryCommand({
          TableName: CLIENTS_TABLE,
          KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
          ExpressionAttributeValues: {
            ":pk": `PUSHTOKEN#${subStr}`,
            ":sk": "TOKEN#",
          },
          Limit: 20,
        })
      );
      return (res.Items ?? [])
        .map((row) => ({
          token: String(row?.token ?? "").trim(),
          tokenHash: String(row?.SK ?? "").replace(/^TOKEN#/, ""),
          platform: String(row?.platform ?? "").trim() || null,
        }))
        .filter((t) => Boolean(t.token));
    } catch (err) {
      console.warn("push_list_tokens_failed", {
        sub: subStr,
        message: String(err?.message ?? err ?? ""),
      });
      return [];
    }
  }

  async function deleteToken(sub, tokenHash) {
    if (!CLIENTS_TABLE) return;
    const subStr = String(sub ?? "").trim();
    const hashStr = String(tokenHash ?? "").trim();
    if (!subStr || !hashStr) return;
    try {
      await ddb.send(
        new DeleteCommand({
          TableName: CLIENTS_TABLE,
          Key: {
            PK: `PUSHTOKEN#${subStr}`,
            SK: `TOKEN#${hashStr}`,
          },
        })
      );
    } catch (err) {
      console.warn("push_delete_token_failed", {
        sub: subStr,
        tokenHash: hashStr,
        message: String(err?.message ?? err ?? ""),
      });
    }
  }

  // Sends a single push to all known devices for `sub`. Returns a small
  // audit object; never throws.
  async function sendPushToCustomer(sub, message) {
    const subStr = String(sub ?? "").trim();
    if (!subStr) return { ok: false, reason: "no-sub" };
    if (!message || typeof message !== "object") {
      return { ok: false, reason: "no-message" };
    }
    const title = String(message?.title ?? "").trim();
    const body = String(message?.body ?? "").trim();
    if (!title && !body) return { ok: false, reason: "empty-content" };

    const tokens = await listTokensForSub(subStr);
    if (tokens.length === 0) return { ok: true, sent: 0, reason: "no-tokens" };

    const payload = tokens.map((t) => ({
      to: t.token,
      title: title || undefined,
      body: body || undefined,
      data: message?.data ?? undefined,
      sound: message?.sound ?? null,
      // Default channelId for Android; iOS ignores. Matches the
      // "default" channel the mobile app sets up at boot.
      channelId: message?.channelId ?? "default",
      ttl: Number.isFinite(message?.ttl) ? Number(message.ttl) : undefined,
      priority: message?.priority ?? "high",
    }));

    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json",
      "Accept-Encoding": "gzip, deflate",
    };
    if (expoAccessToken) {
      headers.Authorization = `Bearer ${expoAccessToken}`;
    }

    const controller =
      typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller
      ? setTimeout(() => controller.abort(), EXPO_TICKET_TIMEOUT_MS)
      : null;

    let response;
    let text = "";
    try {
      response = await httpFetch(EXPO_PUSH_ENDPOINT, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: controller?.signal,
      });
      text = await response.text();
    } catch (err) {
      console.warn("push_send_network_failed", {
        sub: subStr,
        message: String(err?.message ?? err ?? ""),
      });
      return { ok: false, sent: 0, reason: "network-failed" };
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (!response.ok) {
      console.warn("push_send_http_error", {
        sub: subStr,
        status: response.status,
        bodyPreview: text.slice(0, 200),
      });
      return { ok: false, sent: 0, reason: `http-${response.status}` };
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      console.warn("push_send_bad_json", {
        sub: subStr,
        bodyPreview: text.slice(0, 200),
      });
      return { ok: false, sent: 0, reason: "bad-json" };
    }

    const tickets = Array.isArray(parsed?.data) ? parsed.data : [];
    let okCount = 0;
    let staleCount = 0;
    for (let i = 0; i < tickets.length; i += 1) {
      const ticket = tickets[i];
      const tokenAtIndex = tokens[i];
      if (!ticket) continue;
      if (ticket.status === "ok") {
        okCount += 1;
        continue;
      }
      // Common error path: DeviceNotRegistered means the OS-level push
      // entitlement was revoked or the app uninstalled. Drop the token
      // so we stop sending to a dead address.
      const code = String(ticket?.details?.error ?? "");
      const errMsg = String(ticket?.message ?? "");
      if (code === "DeviceNotRegistered" && tokenAtIndex?.tokenHash) {
        await deleteToken(subStr, tokenAtIndex.tokenHash);
        staleCount += 1;
        continue;
      }
      console.warn("push_send_ticket_error", {
        sub: subStr,
        code,
        message: errMsg.slice(0, 200),
      });
    }
    return { ok: true, sent: okCount, stale: staleCount };
  }

  return {
    listTokensForSub,
    deleteToken,
    sendPushToCustomer,
  };
}
