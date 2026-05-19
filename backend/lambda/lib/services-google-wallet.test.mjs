// Tests for services-google-wallet.mjs. Strategy: inject a stub
// jsonwebtoken.sign + stub secrets-manager client + stub fetch +
// stub google-auth factory. Covers config gating, JWT shape, save
// URL host, field rendering (TABLE vs TABLES, COURTESY deposit,
// FF-XXXXXX altText), revoke-PATCH semantics, and 404-soft path.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildClassId,
  buildEventTicketClass,
  buildEventTicketObject,
  buildJwtClaims,
  buildObjectId,
  buildSaveUrl,
  createGoogleWalletService,
  formatEventDateLabel,
  sanitizeIdSuffix,
} from "./services-google-wallet.mjs";

function httpError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function makeSecretClient(secretValue) {
  const calls = [];
  return {
    calls,
    send: async (cmd) => {
      calls.push({ name: cmd?.constructor?.name ?? "Unknown", input: cmd?.input });
      if (secretValue === null || secretValue === undefined) return { SecretString: null };
      if (typeof secretValue === "string") return { SecretString: secretValue };
      return { SecretString: JSON.stringify(secretValue) };
    },
  };
}

function baseEnv(overrides = {}) {
  return {
    GOOGLE_WALLET_ISSUER_ID: "3388000000022000000",
    GOOGLE_WALLET_SERVICE_ACCOUNT_SECRET_ARN:
      "arn:aws:secretsmanager:us-east-1:000000000000:secret:ff/google-wallet/sa-AAAAAA",
    GOOGLE_WALLET_ORIGINS: "https://famosofuego.com,https://www.famosofuego.com",
    GOOGLE_WALLET_LOGO_URI: "https://famosofuego.com/branding/og-image-square.png",
    WALLET_BACKGROUND_COLOR: "#0e0b0a",
    ...overrides,
  };
}

const SAMPLE_RESERVATION = {
  reservationId: "11111111-2222-3333-4444-555555555555",
  eventDate: "2026-06-13",
  customerName: "Laura Meza",
  confirmationCode: "K7M3X2",
  tableIds: ["1", "2"],
  paymentStatus: "PAID",
  depositAmount: 40,
  paymentTotal: 40,
};

const SAMPLE_TOKEN = "a".repeat(64);

describe("services-google-wallet — pure helpers", () => {
  it("sanitizeIdSuffix lowercases + replaces disallowed chars", () => {
    assert.equal(sanitizeIdSuffix("UUID-WITH/Slashes"), "uuid-with-slashes");
    assert.equal(sanitizeIdSuffix("Spaces and !chars#"), "spaces-and-chars");
    assert.equal(sanitizeIdSuffix(""), "");
    assert.equal(sanitizeIdSuffix("...-foo-..."), "foo");
  });

  it("buildClassId returns issuer.ff-event-DATE", () => {
    assert.equal(
      buildClassId("3388000000022000000", "2026-06-13"),
      "3388000000022000000.ff-event-2026-06-13"
    );
    assert.equal(buildClassId("", "2026-06-13"), "");
    assert.equal(buildClassId("3388", "not-a-date"), "");
  });

  it("buildObjectId returns issuer.res-{sanitized}", () => {
    assert.equal(
      buildObjectId("3388", "11111111-2222-3333-4444-555555555555"),
      "3388.res-11111111-2222-3333-4444-555555555555"
    );
    assert.equal(buildObjectId("3388", ""), "");
  });

  it("formatEventDateLabel renders a 'Sat, Jun 13' style label", () => {
    const label = formatEventDateLabel("2026-06-13");
    assert.match(label, /Sat/);
    assert.match(label, /Jun/);
    assert.match(label, /13/);
  });

  it("buildEventTicketClass uses string issuerName and embeds branding", () => {
    const cls = buildEventTicketClass({
      classId: "3388.ff-event-2026-06-13",
      issuerName: "Famoso Fuego",
      eventDate: "2026-06-13",
      logoUri: "https://example.com/logo.png",
      heroImageUri: "https://example.com/hero.png",
      venueName: "Famoso Fuego",
      venueAddress: "McAllen, TX",
      hexBackgroundColor: "#0e0b0a",
    });
    assert.equal(cls.id, "3388.ff-event-2026-06-13");
    assert.equal(cls.issuerName, "Famoso Fuego");
    assert.equal(typeof cls.issuerName, "string", "issuerName must be a string, not LocalizedString");
    assert.equal(cls.reviewStatus, "UNDER_REVIEW");
    assert.equal(cls.confirmationCodeLabel, "RESERVATION_NUMBER");
    assert.equal(cls.hexBackgroundColor, "#0e0b0a");
    assert.equal(cls.logo?.sourceUri?.uri, "https://example.com/logo.png");
    assert.equal(cls.heroImage?.sourceUri?.uri, "https://example.com/hero.png");
    assert.equal(cls.venue?.name?.defaultValue?.value, "Famoso Fuego");
    assert.equal(cls.dateTime?.start, "2026-06-13T20:00:00");
  });

  it("buildEventTicketObject renders TABLES + DEPOSIT + altText for a paid 2-table booking", () => {
    const obj = buildEventTicketObject({
      objectId: "3388.res-uuid",
      classId: "3388.ff-event-2026-06-13",
      reservation: SAMPLE_RESERVATION,
      checkInPassToken: SAMPLE_TOKEN,
    });
    assert.equal(obj.id, "3388.res-uuid");
    assert.equal(obj.state, "ACTIVE");
    assert.equal(obj.ticketHolderName, "Laura Meza");
    assert.equal(obj.ticketNumber, "FF-K7M3X2");
    assert.equal(obj.barcode.type, "QR_CODE");
    assert.equal(obj.barcode.value, `ffr-checkin:${SAMPLE_TOKEN}`);
    assert.equal(obj.barcode.alternateText, "FF-K7M3X2");
    assert.equal(obj.reservationInfo?.confirmationCode, "FF-K7M3X2");
    const tables = obj.textModulesData.find((m) => m.id === "tables");
    assert.equal(tables?.header, "TABLES");
    assert.equal(tables?.body, "1, 2");
    const deposit = obj.textModulesData.find((m) => m.id === "deposit");
    assert.equal(deposit?.body, "$40.00");
  });

  it("buildEventTicketObject renders single-table label + Courtesy deposit", () => {
    const obj = buildEventTicketObject({
      objectId: "3388.res-uuid",
      classId: "3388.ff-event-2026-06-13",
      reservation: {
        ...SAMPLE_RESERVATION,
        tableIds: ["7"],
        paymentStatus: "COURTESY",
        depositAmount: 0,
        paymentTotal: 0,
      },
      checkInPassToken: SAMPLE_TOKEN,
    });
    const tables = obj.textModulesData.find((m) => m.id === "tables");
    assert.equal(tables?.header, "TABLE");
    assert.equal(tables?.body, "7");
    const deposit = obj.textModulesData.find((m) => m.id === "deposit");
    assert.equal(deposit?.body, "Courtesy");
  });

  it("buildEventTicketObject falls back to scalar tableId when tableIds[] absent", () => {
    const obj = buildEventTicketObject({
      objectId: "3388.res-uuid",
      classId: "3388.ff-event-2026-06-13",
      reservation: {
        ...SAMPLE_RESERVATION,
        tableIds: undefined,
        tableId: "12",
      },
      checkInPassToken: SAMPLE_TOKEN,
    });
    const tables = obj.textModulesData.find((m) => m.id === "tables");
    assert.equal(tables?.body, "12");
  });

  it("buildEventTicketObject without confirmationCode falls back to reservationId for ticketNumber", () => {
    const obj = buildEventTicketObject({
      objectId: "3388.res-uuid",
      classId: "3388.ff-event-2026-06-13",
      reservation: { ...SAMPLE_RESERVATION, confirmationCode: "" },
      checkInPassToken: SAMPLE_TOKEN,
    });
    assert.equal(obj.ticketNumber, SAMPLE_RESERVATION.reservationId);
    assert.equal(obj.barcode.alternateText, SAMPLE_RESERVATION.reservationId);
    assert.equal(obj.reservationInfo, undefined);
  });

  it("buildJwtClaims sets aud=google, typ=savetowallet, embeds class+object", () => {
    const cls = buildEventTicketClass({
      classId: "3388.ff-event-2026-06-13",
      eventDate: "2026-06-13",
    });
    const obj = buildEventTicketObject({
      objectId: "3388.res-uuid",
      classId: "3388.ff-event-2026-06-13",
      reservation: SAMPLE_RESERVATION,
      checkInPassToken: SAMPLE_TOKEN,
    });
    const claims = buildJwtClaims({
      clientEmail: "ff-wallet@ff.iam.gserviceaccount.com",
      origins: ["https://famosofuego.com"],
      eventTicketClass: cls,
      eventTicketObject: obj,
      iat: 1700000000,
    });
    assert.equal(claims.aud, "google");
    assert.equal(claims.typ, "savetowallet");
    assert.equal(claims.iss, "ff-wallet@ff.iam.gserviceaccount.com");
    assert.equal(claims.iat, 1700000000);
    assert.deepEqual(claims.origins, ["https://famosofuego.com"]);
    assert.equal(claims.payload.eventTicketClasses.length, 1);
    assert.equal(claims.payload.eventTicketObjects.length, 1);
    assert.equal(claims.payload.eventTicketObjects[0].id, "3388.res-uuid");
  });

  it("buildSaveUrl prepends pay.google.com host", () => {
    assert.equal(
      buildSaveUrl("eyJhbGciOiJSUzI1NiJ9.payload.sig"),
      "https://pay.google.com/gp/v/save/eyJhbGciOiJSUzI1NiJ9.payload.sig"
    );
    assert.equal(buildSaveUrl(""), "");
  });
});

describe("services-google-wallet — service factory", () => {
  it("isEnabled is false when issuer or secret missing", () => {
    const svc = createGoogleWalletService({
      secretClient: makeSecretClient(null),
      env: { GOOGLE_WALLET_ISSUER_ID: "", GOOGLE_WALLET_SERVICE_ACCOUNT_SECRET_ARN: "" },
      httpError,
    });
    assert.equal(svc.isEnabled(), false);
  });

  it("isEnabled is true when both configured", () => {
    const svc = createGoogleWalletService({
      secretClient: makeSecretClient({ client_email: "x", private_key: "y" }),
      env: baseEnv(),
      httpError,
    });
    assert.equal(svc.isEnabled(), true);
  });

  it("generateSaveUrlForReservation throws 501 when disabled", async () => {
    const svc = createGoogleWalletService({
      secretClient: makeSecretClient(null),
      env: {},
      httpError,
    });
    await assert.rejects(
      svc.generateSaveUrlForReservation({
        reservation: SAMPLE_RESERVATION,
        checkInPass: { token: SAMPLE_TOKEN },
      }),
      (err) => err.statusCode === 501
    );
  });

  it("generateSaveUrlForReservation throws 412 when token missing", async () => {
    const svc = createGoogleWalletService({
      secretClient: makeSecretClient({
        client_email: "ff@iam.gserviceaccount.com",
        private_key: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n",
      }),
      env: baseEnv(),
      httpError,
      jwtSignImpl: () => "fake.jwt.signature",
    });
    await assert.rejects(
      svc.generateSaveUrlForReservation({
        reservation: SAMPLE_RESERVATION,
        checkInPass: { token: "" },
      }),
      (err) => err.statusCode === 412
    );
  });

  it("generateSaveUrlForReservation builds a valid save URL with the JWT-signed claims", async () => {
    const signed = [];
    const svc = createGoogleWalletService({
      secretClient: makeSecretClient({
        client_email: "ff-wallet@ff.iam.gserviceaccount.com",
        private_key: "-----BEGIN PRIVATE KEY-----\nfakekey\n-----END PRIVATE KEY-----\n",
      }),
      env: baseEnv(),
      httpError,
      jwtSignImpl: (claims, key, options) => {
        signed.push({ claims, key, options });
        return "stub.jwt.value";
      },
    });
    const result = await svc.generateSaveUrlForReservation({
      reservation: SAMPLE_RESERVATION,
      checkInPass: { token: SAMPLE_TOKEN },
    });
    assert.equal(
      result.saveUrl,
      "https://pay.google.com/gp/v/save/stub.jwt.value"
    );
    assert.equal(
      result.classId,
      "3388000000022000000.ff-event-2026-06-13"
    );
    assert.match(result.objectId, /^3388000000022000000\.res-/);
    assert.equal(signed.length, 1);
    assert.equal(signed[0].options?.algorithm, "RS256");
    assert.equal(signed[0].claims.iss, "ff-wallet@ff.iam.gserviceaccount.com");
    assert.equal(signed[0].claims.aud, "google");
    assert.equal(signed[0].claims.typ, "savetowallet");
    // Origins env honored
    assert.deepEqual(signed[0].claims.origins, [
      "https://famosofuego.com",
      "https://www.famosofuego.com",
    ]);
    // COURTESY for the eligibility test sits in the route layer; the
    // service trusts the caller to filter.
  });

  it("generateSaveUrlForReservation accepts COURTESY reservation (eligibility gates live at the route layer)", async () => {
    const svc = createGoogleWalletService({
      secretClient: makeSecretClient({
        client_email: "ff@iam.gserviceaccount.com",
        private_key: "key",
      }),
      env: baseEnv(),
      httpError,
      jwtSignImpl: () => "stub.jwt",
    });
    const result = await svc.generateSaveUrlForReservation({
      reservation: {
        ...SAMPLE_RESERVATION,
        paymentStatus: "COURTESY",
        depositAmount: 0,
        paymentTotal: 0,
      },
      checkInPass: { token: SAMPLE_TOKEN },
    });
    assert.ok(result.saveUrl.startsWith("https://pay.google.com/gp/v/save/"));
  });

  it("revokeObjectForReservation PATCHes object state to INACTIVE", async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      return { status: 200, ok: true };
    };
    const svc = createGoogleWalletService({
      secretClient: makeSecretClient({
        client_email: "ff@iam.gserviceaccount.com",
        private_key: "key",
      }),
      env: baseEnv(),
      httpError,
      fetchImpl,
      googleAuthFactory: async () => ({
        getAccessToken: async () => ({ token: "fake-access-token" }),
      }),
    });
    const result = await svc.revokeObjectForReservation(SAMPLE_RESERVATION.reservationId);
    assert.equal(result.revoked, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.method, "PATCH");
    assert.match(
      calls[0].url,
      /walletobjects\.googleapis\.com\/walletobjects\/v1\/eventTicketObject\//
    );
    assert.equal(
      calls[0].init.headers.Authorization,
      "Bearer fake-access-token"
    );
    assert.deepEqual(JSON.parse(calls[0].init.body), { state: "INACTIVE" });
  });

  it("revokeObjectForReservation treats 404 as soft-success (object never saved)", async () => {
    const fetchImpl = async () => ({ status: 404, ok: false });
    const svc = createGoogleWalletService({
      secretClient: makeSecretClient({
        client_email: "ff@iam.gserviceaccount.com",
        private_key: "key",
      }),
      env: baseEnv(),
      httpError,
      fetchImpl,
      googleAuthFactory: async () => ({
        getAccessToken: async () => ({ token: "fake" }),
      }),
    });
    const result = await svc.revokeObjectForReservation(SAMPLE_RESERVATION.reservationId);
    assert.equal(result.revoked, false);
    assert.equal(result.reason, "not_found");
  });

  it("revokeObjectForReservation returns disabled when not configured", async () => {
    const svc = createGoogleWalletService({
      secretClient: makeSecretClient(null),
      env: {},
      httpError,
    });
    const result = await svc.revokeObjectForReservation(SAMPLE_RESERVATION.reservationId);
    assert.equal(result.revoked, false);
    assert.equal(result.reason, "disabled");
  });

  it("patchObjectForReservation PATCHes textModulesData + barcode after table change", async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      return { status: 200, ok: true };
    };
    const svc = createGoogleWalletService({
      secretClient: makeSecretClient({
        client_email: "ff@iam.gserviceaccount.com",
        private_key: "key",
      }),
      env: baseEnv(),
      httpError,
      fetchImpl,
      googleAuthFactory: async () => ({
        getAccessToken: async () => ({ token: "fake" }),
      }),
    });
    const result = await svc.patchObjectForReservation({
      reservation: { ...SAMPLE_RESERVATION, tableIds: ["3", "4"] },
      checkInPass: { token: SAMPLE_TOKEN },
    });
    assert.equal(result.patched, true);
    assert.equal(calls.length, 1);
    const body = JSON.parse(calls[0].init.body);
    const tables = body.textModulesData.find((m) => m.id === "tables");
    assert.equal(tables.body, "3, 4");
    assert.equal(body.barcode.value, `ffr-checkin:${SAMPLE_TOKEN}`);
  });

  it("notifyObjectForReservation POSTs addMessage with header+body", async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      return { status: 200, ok: true };
    };
    const svc = createGoogleWalletService({
      secretClient: makeSecretClient({
        client_email: "ff@iam.gserviceaccount.com",
        private_key: "key",
      }),
      env: baseEnv(),
      httpError,
      fetchImpl,
      googleAuthFactory: async () => ({
        getAccessToken: async () => ({ token: "fake" }),
      }),
    });
    const result = await svc.notifyObjectForReservation(
      SAMPLE_RESERVATION.reservationId,
      { header: "Table changed", body: "Your table is now 5." }
    );
    assert.equal(result.sent, true);
    assert.match(calls[0].url, /\/addMessage$/);
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.message.header, "Table changed");
    assert.equal(body.message.body, "Your table is now 5.");
  });
});
