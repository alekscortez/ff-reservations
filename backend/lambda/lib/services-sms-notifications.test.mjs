// Settings-first / env-fallback precedence for the SMS kill switch.
// The 3 sendXxxSms functions all gate on resolveSmsEnabled(), so testing
// the gate via any one entry point is sufficient.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createSmsNotificationsService } from "./services-sms-notifications.mjs";

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function fakeSns({ publishImpl } = {}) {
  return {
    send: async (cmd) =>
      typeof publishImpl === "function"
        ? publishImpl(cmd)
        : { MessageId: "msg_test", $metadata: { httpStatusCode: 200 } },
  };
}

const validInput = () => ({
  phone: "+19561018136",
  customerName: "Test",
  eventDate: "2026-05-12",
  tableId: "A1",
  paymentLinkUrl: "https://example.com/pay/abc",
  ttlMinutes: 10,
});

describe("resolveSmsEnabled precedence", () => {
  it("settings.smsEnabled=false blocks publish even when env says true", async () => {
    const svc = createSmsNotificationsService({
      snsClient: fakeSns(),
      env: { SMS_ENABLED: "true" },
      httpError,
      nowEpoch: () => 1700000000,
      getAppSettings: async () => ({ smsEnabled: false }),
    });
    await assert.rejects(
      () => svc.sendPaymentLinkSms(validInput()),
      (err) => err.status === 503 && /disabled/i.test(err.message)
    );
  });

  it("settings.smsEnabled=true allows publish even when env says false", async () => {
    let published = false;
    const svc = createSmsNotificationsService({
      snsClient: fakeSns({
        publishImpl: async () => {
          published = true;
          return { MessageId: "msg_xyz" };
        },
      }),
      env: { SMS_ENABLED: "false" },
      httpError,
      nowEpoch: () => 1700000000,
      getAppSettings: async () => ({ smsEnabled: true }),
    });
    const out = await svc.sendPaymentLinkSms(validInput());
    assert.equal(published, true);
    assert.equal(out.sent, true);
    assert.equal(out.messageId, "msg_xyz");
  });

  it("falls back to env when getAppSettings is omitted", async () => {
    const svc = createSmsNotificationsService({
      snsClient: fakeSns(),
      env: { SMS_ENABLED: "false" },
      httpError,
      nowEpoch: () => 1700000000,
      // no getAppSettings
    });
    await assert.rejects(
      () => svc.sendPaymentLinkSms(validInput()),
      (err) => err.status === 503
    );
  });

  it("falls back to env when getAppSettings throws (resilient to DDB failures)", async () => {
    const svc = createSmsNotificationsService({
      snsClient: fakeSns(),
      env: { SMS_ENABLED: "false" },
      httpError,
      nowEpoch: () => 1700000000,
      getAppSettings: async () => {
        throw new Error("settings table down");
      },
    });
    await assert.rejects(
      () => svc.sendPaymentLinkSms(validInput()),
      (err) => err.status === 503
    );
  });

  it("falls back to env when settings.smsEnabled is non-boolean (null/missing)", async () => {
    // Settings returned but smsEnabled key is missing — env wins.
    const svc = createSmsNotificationsService({
      snsClient: fakeSns(),
      env: { SMS_ENABLED: "false" },
      httpError,
      nowEpoch: () => 1700000000,
      getAppSettings: async () => ({ operatingTz: "America/Chicago" }),
    });
    await assert.rejects(
      () => svc.sendPaymentLinkSms(validInput()),
      (err) => err.status === 503
    );
  });

  it("env default is true when both SMS_ENABLED and settings are absent", async () => {
    let published = false;
    const svc = createSmsNotificationsService({
      snsClient: fakeSns({
        publishImpl: async () => {
          published = true;
          return { MessageId: "msg_default" };
        },
      }),
      env: {},
      httpError,
      nowEpoch: () => 1700000000,
    });
    const out = await svc.sendPaymentLinkSms(validInput());
    assert.equal(published, true);
    assert.equal(out.sent, true);
  });
});
