// Tests for services-wallet-pass.mjs. Strategy: inject a stub PKPass
// constructor + a stub secrets-manager client + dummy PNG buffers.
// Covers config gating (isEnabled / 501), input validation (400, 412),
// internal failures (500 paths), cert caching, and the happy-path
// fields/options/barcode the wallet generator hands to PKPass.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createWalletPassService } from "./services-wallet-pass.mjs";

function httpError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function makeAssets() {
  return {
    iconPng: Buffer.from("icon", "utf8"),
    icon2xPng: Buffer.from("icon2x", "utf8"),
    logoPng: Buffer.from("logo", "utf8"),
    logo2xPng: Buffer.from("logo2x", "utf8"),
  };
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

function makePkPassStub() {
  const constructed = [];
  class FakePKPass {
    constructor(buffers, certificates, options) {
      constructed.push({ buffers, certificates, options });
      this.type = "";
      this.headerFields = [];
      this.primaryFields = [];
      this.secondaryFields = [];
      this.auxiliaryFields = [];
      this.backFields = [];
      this.barcodes = null;
    }
    setBarcodes(input) {
      this.barcodes = input;
    }
    getAsBuffer() {
      return Buffer.from(
        JSON.stringify({
          type: this.type,
          header: this.headerFields,
          primary: this.primaryFields,
          secondary: this.secondaryFields,
          aux: this.auxiliaryFields,
          back: this.backFields,
          barcodes: this.barcodes,
        }),
        "utf8"
      );
    }
  }
  return { constructed, loader: async () => FakePKPass, FakePKPass };
}

function baseEnv(overrides = {}) {
  return {
    WALLET_PASS_TYPE_IDENTIFIER: "pass.mx.famosofuego.customer",
    WALLET_TEAM_IDENTIFIER: "ZG8SQTN64T",
    WALLET_PASS_SECRET_ARN:
      "arn:aws:secretsmanager:us-east-1:000000000000:secret:ff/wallet/pass-type-id-AAAAAA",
    ...overrides,
  };
}

function validSecret() {
  return {
    wwdr: "-----BEGIN CERTIFICATE-----\nfake-wwdr\n-----END CERTIFICATE-----",
    signerCert: "-----BEGIN CERTIFICATE-----\nfake-signer\n-----END CERTIFICATE-----",
    signerKey: "-----BEGIN ENCRYPTED PRIVATE KEY-----\nfake-key\n-----END ENCRYPTED PRIVATE KEY-----",
    signerKeyPassphrase: "passphrase-xyz",
  };
}

describe("createWalletPassService — isEnabled", () => {
  it("returns false when WALLET_PASS_SECRET_ARN is missing", () => {
    const svc = createWalletPassService({
      secretClient: makeSecretClient(validSecret()),
      env: baseEnv({ WALLET_PASS_SECRET_ARN: "" }),
      httpError,
      assets: makeAssets(),
    });
    assert.equal(svc.isEnabled(), false);
  });

  it("returns false when WALLET_TEAM_IDENTIFIER is missing", () => {
    const svc = createWalletPassService({
      secretClient: makeSecretClient(validSecret()),
      env: baseEnv({ WALLET_TEAM_IDENTIFIER: "" }),
      httpError,
      assets: makeAssets(),
    });
    assert.equal(svc.isEnabled(), false);
  });

  it("returns false when WALLET_PASS_TYPE_IDENTIFIER is missing", () => {
    const svc = createWalletPassService({
      secretClient: makeSecretClient(validSecret()),
      env: baseEnv({ WALLET_PASS_TYPE_IDENTIFIER: "" }),
      httpError,
      assets: makeAssets(),
    });
    assert.equal(svc.isEnabled(), false);
  });

  it("returns true when fully configured", () => {
    const svc = createWalletPassService({
      secretClient: makeSecretClient(validSecret()),
      env: baseEnv(),
      httpError,
      assets: makeAssets(),
    });
    assert.equal(svc.isEnabled(), true);
  });
});

describe("createWalletPassService — generatePkpassForReservation", () => {
  function makeReservation(overrides = {}) {
    return {
      reservationId: "r-123",
      eventDate: "2026-06-01",
      tableId: "T7",
      customerName: "Aleks Cortez",
      depositAmount: 50,
      paymentTotal: 50,
      paymentStatus: "PAID",
      status: "CONFIRMED",
      ...overrides,
    };
  }

  it("throws 501 when service is not enabled", async () => {
    const svc = createWalletPassService({
      secretClient: makeSecretClient(validSecret()),
      env: baseEnv({ WALLET_PASS_SECRET_ARN: "" }),
      httpError,
      assets: makeAssets(),
    });
    await assert.rejects(
      () =>
        svc.generatePkpassForReservation({
          reservation: makeReservation(),
          checkInPass: { token: "tok-xyz" },
        }),
      (err) => err.statusCode === 501
    );
  });

  it("throws 400 when reservation is missing reservationId", async () => {
    const { loader } = makePkPassStub();
    const svc = createWalletPassService({
      secretClient: makeSecretClient(validSecret()),
      env: baseEnv(),
      httpError,
      assets: makeAssets(),
      loadPkPass: loader,
    });
    await assert.rejects(
      () =>
        svc.generatePkpassForReservation({
          reservation: { eventDate: "2026-06-01" },
          checkInPass: { token: "tok-xyz" },
        }),
      (err) => err.statusCode === 400
    );
  });

  it("throws 412 when checkInPass token is missing", async () => {
    const { loader } = makePkPassStub();
    const svc = createWalletPassService({
      secretClient: makeSecretClient(validSecret()),
      env: baseEnv(),
      httpError,
      assets: makeAssets(),
      loadPkPass: loader,
    });
    await assert.rejects(
      () =>
        svc.generatePkpassForReservation({
          reservation: makeReservation(),
          checkInPass: {},
        }),
      (err) => err.statusCode === 412
    );
  });

  it("throws 500 when wallet-pass assets are missing", async () => {
    const { loader } = makePkPassStub();
    const svc = createWalletPassService({
      secretClient: makeSecretClient(validSecret()),
      env: baseEnv(),
      httpError,
      assets: { iconPng: Buffer.from("x") }, // missing logo + icon@2x
      loadPkPass: loader,
    });
    await assert.rejects(
      () =>
        svc.generatePkpassForReservation({
          reservation: makeReservation(),
          checkInPass: { token: "tok-xyz" },
        }),
      (err) => err.statusCode === 500
    );
  });

  it("throws 500 when secret value is empty", async () => {
    const { loader } = makePkPassStub();
    const svc = createWalletPassService({
      secretClient: makeSecretClient(null),
      env: baseEnv(),
      httpError,
      assets: makeAssets(),
      loadPkPass: loader,
    });
    await assert.rejects(
      () =>
        svc.generatePkpassForReservation({
          reservation: makeReservation(),
          checkInPass: { token: "tok-xyz" },
        }),
      (err) => err.statusCode === 500
    );
  });

  it("throws 500 when secret JSON is missing required cert fields", async () => {
    const { loader } = makePkPassStub();
    const svc = createWalletPassService({
      secretClient: makeSecretClient({ wwdr: "...", signerCert: "" }),
      env: baseEnv(),
      httpError,
      assets: makeAssets(),
      loadPkPass: loader,
    });
    await assert.rejects(
      () =>
        svc.generatePkpassForReservation({
          reservation: makeReservation(),
          checkInPass: { token: "tok-xyz" },
        }),
      (err) => err.statusCode === 500
    );
  });

  it("throws 500 when secret string is not valid JSON", async () => {
    const { loader } = makePkPassStub();
    const svc = createWalletPassService({
      secretClient: makeSecretClient("not-json"),
      env: baseEnv(),
      httpError,
      assets: makeAssets(),
      loadPkPass: loader,
    });
    await assert.rejects(
      () =>
        svc.generatePkpassForReservation({
          reservation: makeReservation(),
          checkInPass: { token: "tok-xyz" },
        }),
      (err) => err.statusCode === 500
    );
  });

  it("happy path: returns base64 + filename + contentType + byteLength", async () => {
    const { loader, constructed } = makePkPassStub();
    const svc = createWalletPassService({
      secretClient: makeSecretClient(validSecret()),
      env: baseEnv(),
      httpError,
      assets: makeAssets(),
      loadPkPass: loader,
    });
    const result = await svc.generatePkpassForReservation({
      reservation: makeReservation(),
      checkInPass: { token: "tok-xyz" },
    });
    assert.equal(result.filename, "ff-r-123.pkpass");
    assert.equal(result.contentType, "application/vnd.apple.pkpass");
    assert.ok(result.byteLength > 0);
    assert.equal(typeof result.pkpassBase64, "string");
    assert.ok(result.pkpassBase64.length > 0);
    // PKPass was constructed once with the expected required options
    assert.equal(constructed.length, 1);
    const opts = constructed[0].options;
    assert.equal(opts.passTypeIdentifier, "pass.mx.famosofuego.customer");
    assert.equal(opts.teamIdentifier, "ZG8SQTN64T");
    assert.equal(opts.serialNumber, "r-123");
    assert.equal(opts.organizationName, "Famoso Fuego");
    assert.equal(opts.formatVersion, 1);
    assert.ok(opts.description.includes("Famoso Fuego Reservation"));
  });

  it("happy path: passes icon + logo buffers to PKPass", async () => {
    const { loader, constructed } = makePkPassStub();
    const assets = makeAssets();
    const svc = createWalletPassService({
      secretClient: makeSecretClient(validSecret()),
      env: baseEnv(),
      httpError,
      assets,
      loadPkPass: loader,
    });
    await svc.generatePkpassForReservation({
      reservation: makeReservation(),
      checkInPass: { token: "tok-xyz" },
    });
    const buffers = constructed[0].buffers;
    assert.deepEqual(buffers["icon.png"], assets.iconPng);
    assert.deepEqual(buffers["icon@2x.png"], assets.icon2xPng);
    assert.deepEqual(buffers["logo.png"], assets.logoPng);
    assert.deepEqual(buffers["logo@2x.png"], assets.logo2xPng);
  });

  it("happy path: passes certificates from secret to PKPass", async () => {
    const { loader, constructed } = makePkPassStub();
    const secret = validSecret();
    const svc = createWalletPassService({
      secretClient: makeSecretClient(secret),
      env: baseEnv(),
      httpError,
      assets: makeAssets(),
      loadPkPass: loader,
    });
    await svc.generatePkpassForReservation({
      reservation: makeReservation(),
      checkInPass: { token: "tok-xyz" },
    });
    const certs = constructed[0].certificates;
    assert.equal(certs.wwdr, secret.wwdr);
    assert.equal(certs.signerCert, secret.signerCert);
    assert.equal(certs.signerKey, secret.signerKey);
    assert.equal(certs.signerKeyPassphrase, secret.signerKeyPassphrase);
  });

  it("happy path: pass type is generic with header/primary/secondary fields", async () => {
    const { loader, FakePKPass } = makePkPassStub();
    // Spy by re-wrapping the FakePKPass to keep track of the constructed instance
    let instance = null;
    const wrappedLoader = async () => {
      return class extends FakePKPass {
        constructor(b, c, o) {
          super(b, c, o);
          instance = this;
        }
      };
    };
    const svc = createWalletPassService({
      secretClient: makeSecretClient(validSecret()),
      env: baseEnv(),
      httpError,
      assets: makeAssets(),
      loadPkPass: wrappedLoader,
    });
    await svc.generatePkpassForReservation({
      reservation: makeReservation(),
      checkInPass: { token: "tok-xyz" },
    });
    assert.ok(instance, "PKPass should have been constructed");
    assert.equal(instance.type, "generic");
    // GUEST primary contains customer name
    assert.equal(instance.primaryFields.length, 1);
    assert.equal(instance.primaryFields[0].key, "guest");
    assert.equal(instance.primaryFields[0].value, "Aleks Cortez");
    // Header has DATE
    assert.equal(instance.headerFields[0].key, "eventDate");
    // Secondary has TABLE + DEPOSIT
    const secondaryKeys = instance.secondaryFields.map((f) => f.key);
    assert.deepEqual(secondaryKeys, ["table", "deposit"]);
    // Back has venue + arrival instructions + reservationId + terms.
    // Arrival is the load-bearing one — it tells the customer what to
    // do at the door (matches the /r PAID page so wording is the same
    // on both surfaces).
    const backKeys = instance.backFields.map((f) => f.key);
    assert.ok(backKeys.includes("reservationId"));
    assert.ok(backKeys.includes("terms"));
    assert.ok(backKeys.includes("arrival"));
    const arrival = instance.backFields.find((f) => f.key === "arrival");
    assert.equal(arrival?.label, "When you arrive");
    assert.match(arrival?.value, /Head straight to your table/);
  });

  it("happy path: barcode is QR ffr-checkin:{token}", async () => {
    const { FakePKPass } = makePkPassStub();
    let instance = null;
    const wrappedLoader = async () =>
      class extends FakePKPass {
        constructor(b, c, o) {
          super(b, c, o);
          instance = this;
        }
      };
    const svc = createWalletPassService({
      secretClient: makeSecretClient(validSecret()),
      env: baseEnv(),
      httpError,
      assets: makeAssets(),
      loadPkPass: wrappedLoader,
    });
    await svc.generatePkpassForReservation({
      reservation: makeReservation(),
      checkInPass: { token: "tok-abc-123" },
    });
    assert.deepEqual(instance.barcodes, {
      message: "ffr-checkin:tok-abc-123",
      format: "PKBarcodeFormatQR",
      messageEncoding: "iso-8859-1",
      altText: "r-123",
    });
  });

  it("altText: prefers FF-{confirmationCode} when present", async () => {
    const { FakePKPass } = makePkPassStub();
    let instance = null;
    const wrappedLoader = async () =>
      class extends FakePKPass {
        constructor(b, c, o) {
          super(b, c, o);
          instance = this;
        }
      };
    const svc = createWalletPassService({
      secretClient: makeSecretClient(validSecret()),
      env: baseEnv(),
      httpError,
      assets: makeAssets(),
      loadPkPass: wrappedLoader,
    });
    await svc.generatePkpassForReservation({
      reservation: makeReservation({ confirmationCode: "K7M3X2" }),
      checkInPass: { token: "tok-abc-123" },
    });
    assert.equal(instance.barcodes.altText, "FF-K7M3X2");
    assert.equal(instance.barcodes.message, "ffr-checkin:tok-abc-123");
  });

  it("altText: falls back to reservationId when confirmationCode is empty/missing", async () => {
    const { FakePKPass } = makePkPassStub();
    let instance = null;
    const wrappedLoader = async () =>
      class extends FakePKPass {
        constructor(b, c, o) {
          super(b, c, o);
          instance = this;
        }
      };
    const svc = createWalletPassService({
      secretClient: makeSecretClient(validSecret()),
      env: baseEnv(),
      httpError,
      assets: makeAssets(),
      loadPkPass: wrappedLoader,
    });
    await svc.generatePkpassForReservation({
      reservation: makeReservation({ confirmationCode: "   " }),
      checkInPass: { token: "tok-abc-123" },
    });
    assert.equal(instance.barcodes.altText, "r-123");
  });

  it("happy path: relevantDate is set for a valid eventDate", async () => {
    const { loader, constructed } = makePkPassStub();
    const svc = createWalletPassService({
      secretClient: makeSecretClient(validSecret()),
      env: baseEnv(),
      httpError,
      assets: makeAssets(),
      loadPkPass: loader,
    });
    await svc.generatePkpassForReservation({
      reservation: makeReservation({ eventDate: "2026-06-01" }),
      checkInPass: { token: "tok-xyz" },
    });
    assert.equal(constructed[0].options.relevantDate, "2026-06-01T20:00:00.000Z");
  });

  it("caches certificates after the first resolve", async () => {
    const { loader } = makePkPassStub();
    const secretClient = makeSecretClient(validSecret());
    const svc = createWalletPassService({
      secretClient,
      env: baseEnv(),
      httpError,
      assets: makeAssets(),
      loadPkPass: loader,
    });
    await svc.generatePkpassForReservation({
      reservation: makeReservation(),
      checkInPass: { token: "tok-xyz" },
    });
    await svc.generatePkpassForReservation({
      reservation: makeReservation({ reservationId: "r-456" }),
      checkInPass: { token: "tok-xyz" },
    });
    // Secret was fetched once
    const getCalls = secretClient.calls.filter((c) =>
      c.name?.includes("GetSecretValue")
    );
    assert.equal(getCalls.length, 1);
  });

  it("env overrides for colors + logoText flow through to the pass options", async () => {
    const { loader, constructed } = makePkPassStub();
    const svc = createWalletPassService({
      secretClient: makeSecretClient(validSecret()),
      env: baseEnv({
        WALLET_BACKGROUND_COLOR: "rgb(1, 2, 3)",
        WALLET_FOREGROUND_COLOR: "rgb(4, 5, 6)",
        WALLET_LABEL_COLOR: "rgb(7, 8, 9)",
        WALLET_LOGO_TEXT: "Custom",
        WALLET_ORGANIZATION_NAME: "Org",
      }),
      httpError,
      assets: makeAssets(),
      loadPkPass: loader,
    });
    await svc.generatePkpassForReservation({
      reservation: makeReservation(),
      checkInPass: { token: "tok-xyz" },
    });
    const opts = constructed[0].options;
    assert.equal(opts.backgroundColor, "rgb(1, 2, 3)");
    assert.equal(opts.foregroundColor, "rgb(4, 5, 6)");
    assert.equal(opts.labelColor, "rgb(7, 8, 9)");
    assert.equal(opts.logoText, "Custom");
    assert.equal(opts.organizationName, "Org");
  });
});
