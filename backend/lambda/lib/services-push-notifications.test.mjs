// Tests for services-push-notifications.mjs (Expo Push dispatcher).
//
// Strategy: stub ddb + globalThis.fetch via injected fetchImpl. We
// exercise the per-sub fan-out, the DeviceNotRegistered token cleanup,
// the network-failure swallow, and the empty-tokens no-op.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createPushNotificationsService } from "./services-push-notifications.mjs";

function makeFakeDdb(items = []) {
  const calls = [];
  return {
    calls,
    send: async (cmd) => {
      const name = cmd?.constructor?.name ?? "Unknown";
      calls.push({ name, input: cmd?.input });
      if (name === "QueryCommand") {
        return { Items: items };
      }
      if (name === "DeleteCommand") {
        return {};
      }
      return {};
    },
  };
}

function makeFetchStub({ status = 200, body = '{"data":[]}', throwErr = null } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (throwErr) throw throwErr;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
    };
  };
  return { calls, fetchImpl };
}

describe("createPushNotificationsService", () => {
  it("listTokensForSub returns empty when CLIENTS_TABLE is undefined", async () => {
    const svc = createPushNotificationsService({
      ddb: makeFakeDdb([]),
      CLIENTS_TABLE: undefined,
    });
    const out = await svc.listTokensForSub("sub-1");
    assert.deepEqual(out, []);
  });

  it("listTokensForSub returns empty when sub is blank", async () => {
    const svc = createPushNotificationsService({
      ddb: makeFakeDdb([]),
      CLIENTS_TABLE: "ff-clients",
    });
    const out = await svc.listTokensForSub("   ");
    assert.deepEqual(out, []);
  });

  it("listTokensForSub queries CLIENTS_TABLE with PK = PUSHTOKEN#sub", async () => {
    const ddb = makeFakeDdb([
      { token: "ExponentPushToken[A]", SK: "TOKEN#abc", platform: "ios" },
      { token: "ExponentPushToken[B]", SK: "TOKEN#def", platform: "ios" },
    ]);
    const svc = createPushNotificationsService({
      ddb,
      CLIENTS_TABLE: "ff-clients",
    });
    const out = await svc.listTokensForSub("sub-1");
    assert.equal(out.length, 2);
    assert.equal(out[0].token, "ExponentPushToken[A]");
    assert.equal(out[0].tokenHash, "abc");
    const queryCall = ddb.calls[0];
    assert.equal(queryCall.name, "QueryCommand");
    assert.equal(queryCall.input.ExpressionAttributeValues[":pk"], "PUSHTOKEN#sub-1");
    assert.equal(queryCall.input.ExpressionAttributeValues[":sk"], "TOKEN#");
  });

  it("listTokensForSub filters out rows with empty token", async () => {
    const ddb = makeFakeDdb([
      { token: "ExponentPushToken[A]", SK: "TOKEN#abc", platform: "ios" },
      { token: "", SK: "TOKEN#def", platform: "ios" },
      { token: "   ", SK: "TOKEN#ghi", platform: "ios" },
    ]);
    const svc = createPushNotificationsService({
      ddb,
      CLIENTS_TABLE: "ff-clients",
    });
    const out = await svc.listTokensForSub("sub-1");
    assert.equal(out.length, 1);
  });

  it("sendPushToCustomer no-ops when sub is blank", async () => {
    const svc = createPushNotificationsService({
      ddb: makeFakeDdb([]),
      CLIENTS_TABLE: "ff-clients",
    });
    const out = await svc.sendPushToCustomer("", { title: "x", body: "y" });
    assert.equal(out.ok, false);
    assert.equal(out.reason, "no-sub");
  });

  it("sendPushToCustomer no-ops when message is empty", async () => {
    const svc = createPushNotificationsService({
      ddb: makeFakeDdb([]),
      CLIENTS_TABLE: "ff-clients",
    });
    const out = await svc.sendPushToCustomer("sub-1", { title: "", body: "" });
    assert.equal(out.ok, false);
    assert.equal(out.reason, "empty-content");
  });

  it("sendPushToCustomer returns no-tokens when no devices registered", async () => {
    const ddb = makeFakeDdb([]);
    const { fetchImpl, calls } = makeFetchStub();
    const svc = createPushNotificationsService({
      ddb,
      CLIENTS_TABLE: "ff-clients",
      fetchImpl,
    });
    const out = await svc.sendPushToCustomer("sub-1", { title: "Hi", body: "Test" });
    assert.equal(out.ok, true);
    assert.equal(out.sent, 0);
    assert.equal(out.reason, "no-tokens");
    assert.equal(calls.length, 0, "fetch must not be called when no tokens");
  });

  it("sendPushToCustomer posts to Expo with one entry per token + correct shape", async () => {
    const ddb = makeFakeDdb([
      { token: "ExponentPushToken[A]", SK: "TOKEN#abc", platform: "ios" },
      { token: "ExponentPushToken[B]", SK: "TOKEN#def", platform: "android" },
    ]);
    const { fetchImpl, calls } = makeFetchStub({
      status: 200,
      body: JSON.stringify({ data: [{ status: "ok" }, { status: "ok" }] }),
    });
    const svc = createPushNotificationsService({
      ddb,
      CLIENTS_TABLE: "ff-clients",
      fetchImpl,
    });
    const out = await svc.sendPushToCustomer("sub-1", {
      title: "You're in",
      body: "Reservation confirmed.",
      data: { type: "payment_recorded" },
    });
    assert.equal(out.ok, true);
    assert.equal(out.sent, 2);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://exp.host/--/api/v2/push/send");
    const body = JSON.parse(calls[0].init.body);
    assert.equal(Array.isArray(body), true);
    assert.equal(body.length, 2);
    assert.equal(body[0].to, "ExponentPushToken[A]");
    assert.equal(body[0].title, "You're in");
    assert.equal(body[0].body, "Reservation confirmed.");
    assert.equal(body[0].priority, "high");
    assert.equal(body[0].channelId, "default");
    assert.deepEqual(body[0].data, { type: "payment_recorded" });
  });

  it("sendPushToCustomer attaches Authorization when expoAccessToken is set", async () => {
    const ddb = makeFakeDdb([
      { token: "ExponentPushToken[A]", SK: "TOKEN#abc", platform: "ios" },
    ]);
    const { fetchImpl, calls } = makeFetchStub({
      body: JSON.stringify({ data: [{ status: "ok" }] }),
    });
    const svc = createPushNotificationsService({
      ddb,
      CLIENTS_TABLE: "ff-clients",
      fetchImpl,
      expoAccessToken: "tok-abc-123",
    });
    await svc.sendPushToCustomer("sub-1", { title: "T", body: "B" });
    assert.equal(calls[0].init.headers.Authorization, "Bearer tok-abc-123");
  });

  it("sendPushToCustomer deletes tokens that return DeviceNotRegistered", async () => {
    const ddb = makeFakeDdb([
      { token: "ExponentPushToken[live]", SK: "TOKEN#live", platform: "ios" },
      { token: "ExponentPushToken[stale]", SK: "TOKEN#stale", platform: "ios" },
    ]);
    const { fetchImpl } = makeFetchStub({
      body: JSON.stringify({
        data: [
          { status: "ok" },
          {
            status: "error",
            message: "ExponentPushToken[stale] is not a registered push notification recipient",
            details: { error: "DeviceNotRegistered" },
          },
        ],
      }),
    });
    const svc = createPushNotificationsService({
      ddb,
      CLIENTS_TABLE: "ff-clients",
      fetchImpl,
    });
    const out = await svc.sendPushToCustomer("sub-1", { title: "T", body: "B" });
    assert.equal(out.ok, true);
    assert.equal(out.sent, 1);
    assert.equal(out.stale, 1);
    const deleteCalls = ddb.calls.filter((c) => c.name === "DeleteCommand");
    assert.equal(deleteCalls.length, 1);
    assert.equal(deleteCalls[0].input.Key.PK, "PUSHTOKEN#sub-1");
    assert.equal(deleteCalls[0].input.Key.SK, "TOKEN#stale");
  });

  it("sendPushToCustomer returns network-failed on fetch throw (never rethrows)", async () => {
    const ddb = makeFakeDdb([
      { token: "ExponentPushToken[A]", SK: "TOKEN#abc", platform: "ios" },
    ]);
    const { fetchImpl } = makeFetchStub({ throwErr: new Error("connection refused") });
    const svc = createPushNotificationsService({
      ddb,
      CLIENTS_TABLE: "ff-clients",
      fetchImpl,
    });
    const out = await svc.sendPushToCustomer("sub-1", { title: "T", body: "B" });
    assert.equal(out.ok, false);
    assert.equal(out.reason, "network-failed");
  });

  it("sendPushToCustomer returns http-NNN on non-2xx response (no throw)", async () => {
    const ddb = makeFakeDdb([
      { token: "ExponentPushToken[A]", SK: "TOKEN#abc", platform: "ios" },
    ]);
    const { fetchImpl } = makeFetchStub({ status: 503, body: "Service unavailable" });
    const svc = createPushNotificationsService({
      ddb,
      CLIENTS_TABLE: "ff-clients",
      fetchImpl,
    });
    const out = await svc.sendPushToCustomer("sub-1", { title: "T", body: "B" });
    assert.equal(out.ok, false);
    assert.equal(out.reason, "http-503");
  });
});
