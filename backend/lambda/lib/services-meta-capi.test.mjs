import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createMetaCapiService } from "./services-meta-capi.mjs";

function makeFakeFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init, calls.length);
  };
  return { fetchImpl, calls };
}

const makeOkResponse = (body = { events_received: 1 }) => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify(body),
});

const fakeSecret = (token = "test-token-123") => ({
  send: async () => ({ SecretString: token }),
});

describe("services-meta-capi", () => {
  describe("isEnabled + graceful no-op", () => {
    it("returns skipped: not_configured when env is empty", async () => {
      const svc = createMetaCapiService({
        env: {},
        secretClient: fakeSecret(),
        nowEpoch: () => 1_700_000_000,
        fetchImpl: () => {
          throw new Error("should not call fetch");
        },
      });
      assert.equal(svc.isEnabled(), false);
      const out = await svc.sendEvent({
        event_name: "ViewContent",
        event_id: "evt-1",
        user_data: {},
      });
      assert.equal(out.skipped, true);
      assert.equal(out.reason, "not_configured");
    });

    it("requires both pixelId AND token secret ARN", async () => {
      const svc1 = createMetaCapiService({
        env: { META_PIXEL_ID: "123" },
        secretClient: fakeSecret(),
        nowEpoch: () => 0,
        fetchImpl: () => {},
      });
      const svc2 = createMetaCapiService({
        env: { META_CAPI_TOKEN_SECRET_ARN: "arn:secret" },
        secretClient: fakeSecret(),
        nowEpoch: () => 0,
        fetchImpl: () => {},
      });
      assert.equal(svc1.isEnabled(), false);
      assert.equal(svc2.isEnabled(), false);
    });
  });

  describe("hashing (Meta spec: SHA-256 lowercase trimmed)", () => {
    let svc;
    beforeEach(() => {
      svc = createMetaCapiService({
        env: {},
        secretClient: fakeSecret(),
        nowEpoch: () => 0,
        fetchImpl: () => {},
      });
    });

    it("hashes emails lowercased + trimmed", () => {
      const a = svc._hashEmail(" Foo@BAR.com  ");
      const b = svc._hashEmail("foo@bar.com");
      assert.equal(a, b);
      // SHA-256 hex is 64 chars
      assert.equal(a.length, 64);
    });

    it("hashes phones as digits-only (Meta drops the +)", () => {
      const a = svc._hashPhone("+1 (956) 555-1234");
      const b = svc._hashPhone("19565551234");
      assert.equal(a, b);
      assert.equal(a.length, 64);
    });

    it("returns null for empty inputs (Meta rejects empty strings)", () => {
      assert.equal(svc._hashEmail(""), null);
      assert.equal(svc._hashEmail(null), null);
      assert.equal(svc._hashPhone(""), null);
      assert.equal(svc._hashPhone("---"), null);
    });

    it("buildUserData omits missing fields and keeps fbc/fbp/ip/ua unhashed", () => {
      const ud = svc._buildUserData({
        email: "x@y.com",
        phone: null,
        fbc: "fb.1.123.ABCD",
        fbp: "fb.1.987.RAND",
        clientIp: "203.0.113.1",
        clientUserAgent: "Mozilla/5.0",
        externalId: "res-uuid-1",
      });
      assert.equal(Array.isArray(ud.em), true);
      assert.equal(ud.em.length, 1);
      assert.equal(ud.em[0].length, 64);
      assert.equal(ud.ph, undefined);
      assert.equal(ud.fbc, "fb.1.123.ABCD");
      assert.equal(ud.fbp, "fb.1.987.RAND");
      assert.equal(ud.client_ip_address, "203.0.113.1");
      assert.equal(ud.client_user_agent, "Mozilla/5.0");
      // external_id is hashed per Meta spec
      assert.equal(ud.external_id[0].length, 64);
    });
  });

  describe("sendEvent — wire format", () => {
    let fetchHarness;
    let svc;
    beforeEach(() => {
      fetchHarness = makeFakeFetch(() => makeOkResponse());
      svc = createMetaCapiService({
        env: {
          META_PIXEL_ID: "111222333444",
          META_CAPI_TOKEN_SECRET_ARN: "arn:secret",
        },
        secretClient: fakeSecret(),
        nowEpoch: () => 1_700_000_000,
        fetchImpl: fetchHarness.fetchImpl,
      });
    });

    it("hits the correct Graph API URL pinned to v23.0", async () => {
      await svc.sendEvent({
        event_name: "ViewContent",
        event_id: "evt-1",
        user_data: {},
      });
      assert.equal(fetchHarness.calls.length, 1);
      const url = fetchHarness.calls[0].url;
      assert.match(url, /graph\.facebook\.com\/v23\.0\/111222333444\/events/);
      assert.match(url, /access_token=test-token-123/);
    });

    it("includes test_event_code when env sets it", async () => {
      const svc2 = createMetaCapiService({
        env: {
          META_PIXEL_ID: "111",
          META_CAPI_TOKEN_SECRET_ARN: "arn",
          META_CAPI_TEST_EVENT_CODE: "TEST12345",
        },
        secretClient: fakeSecret(),
        nowEpoch: () => 1_700_000_000,
        fetchImpl: fetchHarness.fetchImpl,
      });
      await svc2.sendEvent({
        event_name: "ViewContent",
        event_id: "evt-1",
        user_data: {},
      });
      const body = JSON.parse(fetchHarness.calls[0].init.body);
      assert.equal(body.test_event_code, "TEST12345");
    });

    it("defaults action_source to 'website'", async () => {
      await svc.sendEvent({
        event_name: "ViewContent",
        event_id: "evt-1",
        user_data: {},
      });
      const body = JSON.parse(fetchHarness.calls[0].init.body);
      assert.equal(body.data[0].action_source, "website");
    });

    it("rejects missing event_name and event_id (Meta requires both)", async () => {
      await assert.rejects(() =>
        svc.sendEvent({ event_name: "", event_id: "x", user_data: {} })
      );
      await assert.rejects(() =>
        svc.sendEvent({ event_name: "ViewContent", event_id: "", user_data: {} })
      );
    });

    it("does NOT retry on 4xx (caller bug — invalid pixel/token)", async () => {
      let calls = 0;
      const svcBad = createMetaCapiService({
        env: { META_PIXEL_ID: "111", META_CAPI_TOKEN_SECRET_ARN: "arn" },
        secretClient: fakeSecret(),
        nowEpoch: () => 0,
        fetchImpl: async () => {
          calls++;
          return {
            ok: false,
            status: 400,
            text: async () => JSON.stringify({ error: { message: "bad pixel" } }),
          };
        },
      });
      await assert.rejects(() =>
        svcBad.sendEvent({ event_name: "X", event_id: "y", user_data: {} })
      );
      assert.equal(calls, 1);
    });

    it("retries on 5xx up to 3 total attempts", async () => {
      let calls = 0;
      const svc5xx = createMetaCapiService({
        env: { META_PIXEL_ID: "111", META_CAPI_TOKEN_SECRET_ARN: "arn" },
        secretClient: fakeSecret(),
        nowEpoch: () => 0,
        fetchImpl: async () => {
          calls++;
          return {
            ok: false,
            status: 503,
            text: async () => "service unavailable",
          };
        },
      });
      await assert.rejects(() =>
        svc5xx.sendEvent({ event_name: "X", event_id: "y", user_data: {} })
      );
      assert.equal(calls, 3);
    });
  });

  describe("trackPurchase — required fields", () => {
    let fetchHarness;
    let svc;
    beforeEach(() => {
      fetchHarness = makeFakeFetch(() => makeOkResponse());
      svc = createMetaCapiService({
        env: {
          META_PIXEL_ID: "111",
          META_CAPI_TOKEN_SECRET_ARN: "arn",
        },
        secretClient: fakeSecret(),
        nowEpoch: () => 1_700_000_000,
        fetchImpl: fetchHarness.fetchImpl,
      });
    });

    it("ships value + currency in custom_data", async () => {
      await svc.trackPurchase({
        eventId: "evt-purchase-1",
        userData: { email: "x@y.com", phone: "+19565551234" },
        value: 50,
        currency: "USD",
        orderId: "res-uuid-1",
      });
      const body = JSON.parse(fetchHarness.calls[0].init.body);
      assert.equal(body.data[0].event_name, "Purchase");
      assert.equal(body.data[0].custom_data.value, 50);
      assert.equal(body.data[0].custom_data.currency, "USD");
      assert.equal(body.data[0].custom_data.order_id, "res-uuid-1");
      assert.equal(body.data[0].user_data.em[0].length, 64);
      assert.equal(body.data[0].user_data.ph[0].length, 64);
    });
  });
});
