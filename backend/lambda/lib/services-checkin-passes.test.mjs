// Settings-first / env-fallback precedence for the check-in-pass TTL and
// base URL resolvers. Covers the public surface (issuePassForReservation,
// getActivePassForReservation) so we catch any missed await.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createCheckInPassesService } from "./services-checkin-passes.mjs";

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function fakeDdb({ transactImpl, queryImpl, getImpl } = {}) {
  return {
    send: async (cmd) => {
      const name = cmd?.constructor?.name ?? "";
      if (name === "TransactWriteCommand") {
        return typeof transactImpl === "function" ? transactImpl(cmd) : {};
      }
      if (name === "QueryCommand") {
        return typeof queryImpl === "function" ? queryImpl(cmd) : { Items: [] };
      }
      if (name === "GetCommand") {
        return typeof getImpl === "function" ? getImpl(cmd) : { Item: null };
      }
      if (name === "PutCommand") {
        return {};
      }
      throw new Error(`fakeDdb: unexpected command ${name}`);
    },
  };
}

const buildPaidReservation = () => ({
  reservationId: "res_1",
  eventDate: "2026-05-12",
  tableId: "A1",
  customerName: "Test",
  phone: "+19561018136",
  status: "CONFIRMED",
  paymentStatus: "PAID",
});

function fixedUUIDFactory(values) {
  let i = 0;
  return () => {
    const v = values[i % values.length];
    i += 1;
    return v;
  };
}

const baseDeps = {
  ddb: fakeDdb(),
  tableNames: {
    CHECKIN_PASSES_TABLE: "ff-checkin-passes",
    RES_TABLE: "ff-reservations",
  },
  env: {},
  requiredEnv: (_name, value) => value,
  httpError,
  nowEpoch: () => 1700000000,
  randomUUID: fixedUUIDFactory([
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
    "33333333-3333-4333-8333-333333333333",
  ]),
  addDaysToIsoDate: (date, days) => {
    const ms = Date.parse(`${date}T00:00:00Z`) + days * 86400 * 1000;
    return new Date(ms).toISOString().slice(0, 10);
  },
};

describe("resolvePassBaseUrl precedence (via issuePassForReservation)", () => {
  it("settings.checkInPassBaseUrl wins over env.CHECKIN_PASS_BASE_URL", async () => {
    const svc = createCheckInPassesService({
      ...baseDeps,
      env: { CHECKIN_PASS_BASE_URL: "https://env.example.com/check-in/pass" },
      getAppSettings: async () => ({
        checkInPassBaseUrl: "https://settings.example.com/check-in/pass",
      }),
    });
    const out = await svc.issuePassForReservation({
      reservation: buildPaidReservation(),
      issuedBy: "system:test",
    });
    assert.match(out.pass.url, /^https:\/\/settings\.example\.com\/check-in\/pass\?token=[a-f0-9]+$/);
  });

  it("falls back to env when settings.checkInPassBaseUrl is empty", async () => {
    const svc = createCheckInPassesService({
      ...baseDeps,
      env: { CHECKIN_PASS_BASE_URL: "https://env.example.com/check-in/pass" },
      getAppSettings: async () => ({ checkInPassBaseUrl: "" }),
    });
    const out = await svc.issuePassForReservation({
      reservation: buildPaidReservation(),
      issuedBy: "system:test",
    });
    assert.match(out.pass.url, /^https:\/\/env\.example\.com\/check-in\/pass\?token=[a-f0-9]+$/);
  });

  it("falls back to env when getAppSettings throws", async () => {
    const svc = createCheckInPassesService({
      ...baseDeps,
      env: { CHECKIN_PASS_BASE_URL: "https://env.example.com/check-in/pass" },
      getAppSettings: async () => {
        throw new Error("settings down");
      },
    });
    const out = await svc.issuePassForReservation({
      reservation: buildPaidReservation(),
      issuedBy: "system:test",
    });
    assert.match(out.pass.url, /^https:\/\/env\.example\.com\/check-in\/pass\?token=[a-f0-9]+$/);
  });
});

describe("slug-based pass URL (publicSlug overrides token URL)", () => {
  it("uses /p/{slug}?to=pass when reservation supplies publicSlug", async () => {
    const svc = createCheckInPassesService({
      ...baseDeps,
      env: {
        CHECKIN_PASS_BASE_URL: "https://env.example.com/check-in/pass",
        PUBLIC_BOOKING_SHORT_URL_BASE: "https://api.famosofuego.com",
      },
    });
    const out = await svc.issuePassForReservation({
      reservation: {
        ...buildPaidReservation(),
        publicSlug: "eQ2KB9ams2exeu2H",
        confirmationCode: "2AZCQ7",
      },
      issuedBy: "system:test",
    });
    // pass.url is the customer-facing share URL — short and slug-rooted
    // when slug is on the reservation. The long token URL stays in
    // pass.qrPayload (ffr-checkin:{token}) for staff QR scanning.
    assert.equal(
      out.pass.url,
      "https://api.famosofuego.com/p/eQ2KB9ams2exeu2H?to=pass"
    );
    assert.match(out.pass.qrPayload, /^ffr-checkin:[a-f0-9]+$/);
  });

  it("falls back to token URL when reservation has no publicSlug", async () => {
    const svc = createCheckInPassesService({
      ...baseDeps,
      env: {
        CHECKIN_PASS_BASE_URL: "https://env.example.com/check-in/pass",
        PUBLIC_BOOKING_SHORT_URL_BASE: "https://api.famosofuego.com",
      },
    });
    const out = await svc.issuePassForReservation({
      reservation: buildPaidReservation(), // no publicSlug
      issuedBy: "system:test",
    });
    assert.match(
      out.pass.url,
      /^https:\/\/env\.example\.com\/check-in\/pass\?token=[a-f0-9]+$/
    );
  });

  it("env default for short-URL base is api.famosofuego.com", async () => {
    const svc = createCheckInPassesService({
      ...baseDeps,
      env: { CHECKIN_PASS_BASE_URL: "https://env.example.com/check-in/pass" },
      // PUBLIC_BOOKING_SHORT_URL_BASE deliberately unset
    });
    const out = await svc.issuePassForReservation({
      reservation: {
        ...buildPaidReservation(),
        publicSlug: "abc1234567890XYZ",
      },
      issuedBy: "system:test",
    });
    assert.equal(
      out.pass.url,
      "https://api.famosofuego.com/p/abc1234567890XYZ?to=pass"
    );
  });
});

describe("resolvePassTtlDays precedence", () => {
  // baseDate 2026-05-12; addDays of {1..30} yields predictable expiry epochs.
  // Pass expiry is computed as Date.parse(`${date+ttl}T12:00:00Z`)/1000.
  const baseEventDate = "2026-05-12";
  const expiryEpochForDays = (ttlDays) => {
    const expiryDate = new Date(
      Date.parse(`${baseEventDate}T00:00:00Z`) + ttlDays * 86400 * 1000
    )
      .toISOString()
      .slice(0, 10);
    return Math.floor(Date.parse(`${expiryDate}T12:00:00Z`) / 1000);
  };

  it("settings.checkInPassTtlDays=7 wins over env CHECKIN_PASS_TTL_DAYS=2", async () => {
    const svc = createCheckInPassesService({
      ...baseDeps,
      env: { CHECKIN_PASS_TTL_DAYS: "2" },
      getAppSettings: async () => ({ checkInPassTtlDays: 7 }),
    });
    const out = await svc.issuePassForReservation({
      reservation: buildPaidReservation(),
      issuedBy: "system:test",
    });
    assert.equal(out.pass.expiresAt, expiryEpochForDays(7));
  });

  it("clamps settings.checkInPassTtlDays to [1, 30]", async () => {
    const high = createCheckInPassesService({
      ...baseDeps,
      env: {},
      getAppSettings: async () => ({ checkInPassTtlDays: 999 }),
    });
    const outHigh = await high.issuePassForReservation({
      reservation: buildPaidReservation(),
      issuedBy: "system:test",
    });
    assert.equal(outHigh.pass.expiresAt, expiryEpochForDays(30));

    const low = createCheckInPassesService({
      ...baseDeps,
      env: {},
      getAppSettings: async () => ({ checkInPassTtlDays: 0 }),
    });
    const outLow = await low.issuePassForReservation({
      reservation: buildPaidReservation(),
      issuedBy: "system:test",
    });
    // 0 isn't > 0 → falls through to env (also missing) → default 2 days.
    assert.equal(outLow.pass.expiresAt, expiryEpochForDays(2));
  });

  it("falls back to env when settings.checkInPassTtlDays is missing", async () => {
    const svc = createCheckInPassesService({
      ...baseDeps,
      env: { CHECKIN_PASS_TTL_DAYS: "5" },
      getAppSettings: async () => ({}),
    });
    const out = await svc.issuePassForReservation({
      reservation: buildPaidReservation(),
      issuedBy: "system:test",
    });
    assert.equal(out.pass.expiresAt, expiryEpochForDays(5));
  });

  it("falls back to default 2 days when both settings and env are absent", async () => {
    const svc = createCheckInPassesService({
      ...baseDeps,
      env: {},
      // no getAppSettings
    });
    const out = await svc.issuePassForReservation({
      reservation: buildPaidReservation(),
      issuedBy: "system:test",
    });
    assert.equal(out.pass.expiresAt, expiryEpochForDays(2));
  });
});
