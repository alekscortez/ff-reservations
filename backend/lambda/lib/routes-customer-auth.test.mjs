// Tests for routes-customer-auth.mjs (the customer phone-OTP flow).
// This is the only public-facing customer-auth path — pinning the
// Cognito orchestration + the synthetic-email convention prevents
// regressions that could break customer sign-in or expose the internal
// email scheme.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  generateThrowawayPassword,
  handleCustomerAuthRoute,
  isSixDigitOtp,
  isValidE164,
  syntheticEmailFromPhone,
} from "./routes-customer-auth.mjs";

const CUSTOMER_CLIENT_ID = "client-customer-test";
const PHONE = "+12025550100";
const SYNTH_EMAIL = "customer-12025550100@customer.famosofuego.local";
const SESSION_TOKEN = "session-cognito-xyz";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("syntheticEmailFromPhone", () => {
  it("strips + and non-digits, builds customer-{digits}@customer.famosofuego.local", () => {
    assert.equal(syntheticEmailFromPhone("+12025550100"), SYNTH_EMAIL);
    assert.equal(
      syntheticEmailFromPhone("+528991054670"),
      "customer-528991054670@customer.famosofuego.local"
    );
  });
  it("handles already-stripped digits", () => {
    assert.equal(syntheticEmailFromPhone("12025550100"), SYNTH_EMAIL);
  });
  it("handles formatted input by stripping non-digits", () => {
    assert.equal(syntheticEmailFromPhone("+1 (202) 555-0100"), SYNTH_EMAIL);
  });
  it("returns customer-@customer.famosofuego.local for empty input (no fallback)", () => {
    assert.equal(
      syntheticEmailFromPhone(""),
      "customer-@customer.famosofuego.local"
    );
    assert.equal(
      syntheticEmailFromPhone(null),
      "customer-@customer.famosofuego.local"
    );
  });
});

describe("isValidE164", () => {
  it("accepts +1 US, +52 MX (7-15 digits total)", () => {
    assert.equal(isValidE164("+12025550100"), true);
    assert.equal(isValidE164("+528991054670"), true);
    assert.equal(isValidE164("+1234567"), true);  // 7 digits — minimum
    assert.equal(isValidE164("+123456"), false);  // 6 digits — too short
  });
  it("rejects +0... (country code can't start with 0)", () => {
    assert.equal(isValidE164("+0123456789"), false);
  });
  it("rejects no-+ / non-string / empty", () => {
    assert.equal(isValidE164("12025550100"), false);
    assert.equal(isValidE164(""), false);
    assert.equal(isValidE164(null), false);
    assert.equal(isValidE164(12025550100), false);
  });
  it("rejects too-long (16+ digits after +)", () => {
    assert.equal(isValidE164("+1" + "1".repeat(15)), false);
  });
});

describe("isSixDigitOtp", () => {
  it("accepts exactly 6 ASCII digits", () => {
    assert.equal(isSixDigitOtp("000000"), true);
    assert.equal(isSixDigitOtp("123456"), true);
    assert.equal(isSixDigitOtp("999999"), true);
  });
  it("rejects wrong length", () => {
    assert.equal(isSixDigitOtp("12345"), false);
    assert.equal(isSixDigitOtp("1234567"), false);
    assert.equal(isSixDigitOtp(""), false);
  });
  it("rejects non-string input or non-digit chars", () => {
    assert.equal(isSixDigitOtp(123456), false);
    assert.equal(isSixDigitOtp("12345a"), false);
    assert.equal(isSixDigitOtp("12 456"), false);
    assert.equal(isSixDigitOtp(null), false);
  });
});

describe("generateThrowawayPassword", () => {
  it("satisfies Cognito default policy (≥8 chars, mixed case, digit, symbol)", () => {
    for (let i = 0; i < 20; i += 1) {
      const pw = generateThrowawayPassword();
      assert.ok(pw.length >= 8, `pw ${pw} too short`);
      assert.match(pw, /[a-z]/, "lowercase");
      assert.match(pw, /[A-Z]/, "uppercase");
      assert.match(pw, /\d/, "digit");
      assert.match(pw, /[^A-Za-z0-9]/, "symbol");
    }
  });
  it("is deterministic-shape but unique per call", () => {
    const a = generateThrowawayPassword();
    const b = generateThrowawayPassword();
    assert.notEqual(a, b);
  });
});

// ---------------------------------------------------------------------------
// Fake Cognito + ctx builder
// ---------------------------------------------------------------------------

function makeCommand(name) {
  return class {
    constructor(input) {
      this.input = input;
    }
    static get commandName() {
      return name;
    }
  };
}

function makeFakeCognito({ responses = {}, throwOnCommand } = {}) {
  const calls = [];
  return {
    calls,
    send: async (cmd) => {
      const name = cmd?.constructor?.commandName ?? cmd?.constructor?.name ?? "Unknown";
      calls.push({ name, input: cmd?.input });
      if (throwOnCommand?.[name]) throw throwOnCommand[name];
      const handler = responses[name];
      if (typeof handler === "function") return handler(cmd?.input);
      return handler ?? {};
    },
  };
}

function makeCtx(overrides = {}) {
  const calls = {
    json: [],
    getBody: [],
    rateLimit: [],
  };
  const cognito = overrides.cognito ?? makeFakeCognito();
  return {
    calls,
    cognito,
    ctx: {
      method: overrides.method ?? "POST",
      path: overrides.path ?? "/auth/customer/start",
      event: overrides.event ?? {},
      cors: { "Access-Control-Allow-Origin": "*" },
      json: (status, body, hdrs) => {
        calls.json.push({ status, body, hdrs });
        return { statusCode: status, body, headers: hdrs };
      },
      getBody:
        overrides.getBody ??
        (async (event) => {
          calls.getBody.push(event);
          return overrides.body !== undefined ? overrides.body : null;
        }),
      customerClientId:
        overrides.customerClientId === null
          ? null
          : (overrides.customerClientId ?? CUSTOMER_CLIENT_ID),
      checkAndIncrementSmsRateLimit:
        overrides.checkAndIncrementSmsRateLimit ??
        (async (phone) => {
          calls.rateLimit.push(phone);
          if (overrides.rateLimitThrows) throw overrides.rateLimitThrows;
        }),
      cognito,
    },
  };
}

// We need a Cognito error class set that matches the module's
// `instanceof X` checks. Using the actual SDK classes (devDep'd in PR #26).
async function loadCognitoErrors() {
  const sdk = await import("@aws-sdk/client-cognito-identity-provider");
  return {
    UsernameExistsException: sdk.UsernameExistsException,
    InvalidPasswordException: sdk.InvalidPasswordException,
    InvalidParameterException: sdk.InvalidParameterException,
    NotAuthorizedException: sdk.NotAuthorizedException,
    UserNotFoundException: sdk.UserNotFoundException,
  };
}

function makeCognitoError(ErrorClass, message) {
  // Cognito SDK error classes have a specific constructor signature
  return new ErrorClass({ message, $metadata: {} });
}

// ---------------------------------------------------------------------------
// Path mismatch + customerClientId guard
// ---------------------------------------------------------------------------

describe("handleCustomerAuthRoute — path mismatch", () => {
  it("returns null when customerClientId is missing (router falls through)", async () => {
    const { ctx } = makeCtx({ customerClientId: null });
    assert.equal(await handleCustomerAuthRoute(ctx), null);
  });

  it("returns null on unrelated path", async () => {
    const { ctx } = makeCtx({ method: "POST", path: "/something" });
    assert.equal(await handleCustomerAuthRoute(ctx), null);
  });

  it("returns null on GET (no GET handlers)", async () => {
    const { ctx } = makeCtx({ method: "GET", path: "/auth/customer/start" });
    assert.equal(await handleCustomerAuthRoute(ctx), null);
  });
});

// ---------------------------------------------------------------------------
// POST /auth/customer/start
// ---------------------------------------------------------------------------

describe("POST /auth/customer/start — validation + rate limit", () => {
  it("400 when phoneE164 is missing or malformed", async () => {
    for (const phone of [undefined, "", "no-plus", "+0123", "+12345"]) {
      const { ctx } = makeCtx({
        path: "/auth/customer/start",
        body: { phoneE164: phone },
      });
      const res = await handleCustomerAuthRoute(ctx);
      assert.equal(res.statusCode, 400);
      assert.match(res.body.message, /E\.164/);
    }
  });

  it("propagates rate-limit errors (e.g. 429) before any Cognito call", async () => {
    const tooMany = Object.assign(new Error("rate limited"), { statusCode: 429 });
    const { ctx, cognito } = makeCtx({
      path: "/auth/customer/start",
      body: { phoneE164: PHONE },
      rateLimitThrows: tooMany,
    });
    await assert.rejects(
      () => handleCustomerAuthRoute(ctx),
      (err) => err?.statusCode === 429
    );
    // No Cognito calls happened
    assert.equal(cognito.calls.length, 0);
  });

  it("calls rate-limit with the phone before SignUp", async () => {
    const { ctx, calls, cognito } = makeCtx({
      path: "/auth/customer/start",
      body: { phoneE164: PHONE },
      cognito: makeFakeCognito({
        responses: {
          SignUpCommand: () => ({}),
          InitiateAuthCommand: () => ({ Session: SESSION_TOKEN, ChallengeName: "CUSTOM_CHALLENGE" }),
        },
      }),
    });
    await handleCustomerAuthRoute(ctx);
    assert.deepEqual(calls.rateLimit, [PHONE]);
    // Order: rate-limit first, then SignUp, then InitiateAuth
    assert.equal(cognito.calls[0].name, "SignUpCommand");
    assert.equal(cognito.calls[1].name, "InitiateAuthCommand");
  });

  it("works when checkAndIncrementSmsRateLimit is not provided (graceful fallback)", async () => {
    const { ctx } = makeCtx({
      path: "/auth/customer/start",
      body: { phoneE164: PHONE },
      checkAndIncrementSmsRateLimit: null, // explicitly absent
      cognito: makeFakeCognito({
        responses: {
          SignUpCommand: () => ({}),
          InitiateAuthCommand: () => ({ Session: SESSION_TOKEN, ChallengeName: "CUSTOM_CHALLENGE" }),
        },
      }),
    });
    const res = await handleCustomerAuthRoute(ctx);
    assert.equal(res.statusCode, 200);
  });
});

describe("POST /auth/customer/start — happy path", () => {
  it("SignUp + InitiateAuth → returns session + challengeName", async () => {
    const { ctx, cognito } = makeCtx({
      path: "/auth/customer/start",
      body: { phoneE164: PHONE, name: "Alice" },
      cognito: makeFakeCognito({
        responses: {
          SignUpCommand: () => ({}),
          InitiateAuthCommand: () => ({
            Session: SESSION_TOKEN,
            ChallengeName: "CUSTOM_CHALLENGE",
          }),
        },
      }),
    });
    const res = await handleCustomerAuthRoute(ctx);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.session, SESSION_TOKEN);
    assert.equal(res.body.challengeName, "CUSTOM_CHALLENGE");

    // SignUp was called with the synthetic email + phone attributes
    const signup = cognito.calls.find((c) => c.name === "SignUpCommand");
    assert.equal(signup.input.ClientId, CUSTOMER_CLIENT_ID);
    assert.equal(signup.input.Username, SYNTH_EMAIL);
    const phoneAttr = signup.input.UserAttributes.find((a) => a.Name === "phone_number");
    assert.equal(phoneAttr.Value, PHONE);
    const emailAttr = signup.input.UserAttributes.find((a) => a.Name === "email");
    assert.equal(emailAttr.Value, SYNTH_EMAIL);
    const nameAttr = signup.input.UserAttributes.find((a) => a.Name === "name");
    assert.equal(nameAttr.Value, "Alice");
    // Password satisfies Cognito policy
    assert.match(signup.input.Password, /[A-Z]/);
    assert.match(signup.input.Password, /[a-z]/);
    assert.match(signup.input.Password, /\d/);

    // InitiateAuth uses the synthetic email + CUSTOM_AUTH flow
    const init = cognito.calls.find((c) => c.name === "InitiateAuthCommand");
    assert.equal(init.input.ClientId, CUSTOMER_CLIENT_ID);
    assert.equal(init.input.AuthFlow, "CUSTOM_AUTH");
    assert.equal(init.input.AuthParameters.USERNAME, SYNTH_EMAIL);
  });

  it("falls back name to 'Customer {phone}' when not provided", async () => {
    const { ctx, cognito } = makeCtx({
      path: "/auth/customer/start",
      body: { phoneE164: PHONE },
      cognito: makeFakeCognito({
        responses: {
          SignUpCommand: () => ({}),
          InitiateAuthCommand: () => ({ Session: SESSION_TOKEN }),
        },
      }),
    });
    await handleCustomerAuthRoute(ctx);
    const signup = cognito.calls.find((c) => c.name === "SignUpCommand");
    const nameAttr = signup.input.UserAttributes.find((a) => a.Name === "name");
    assert.equal(nameAttr.Value, `Customer ${PHONE}`);
  });

  it("UsernameExistsException → falls through to InitiateAuth (existing user re-auth)", async () => {
    const { UsernameExistsException } = await loadCognitoErrors();
    const exists = makeCognitoError(UsernameExistsException, "exists");
    const { ctx, cognito } = makeCtx({
      path: "/auth/customer/start",
      body: { phoneE164: PHONE },
      cognito: makeFakeCognito({
        throwOnCommand: { SignUpCommand: exists },
        responses: {
          InitiateAuthCommand: () => ({
            Session: SESSION_TOKEN,
            ChallengeName: "CUSTOM_CHALLENGE",
          }),
        },
      }),
    });
    const res = await handleCustomerAuthRoute(ctx);
    assert.equal(res.statusCode, 200);
    // SignUp was attempted (and failed), then InitiateAuth happened
    assert.equal(cognito.calls[0].name, "SignUpCommand");
    assert.equal(cognito.calls[1].name, "InitiateAuthCommand");
  });

  it("InvalidPasswordException → 500 (server-controlled invariant violation)", async () => {
    const { InvalidPasswordException } = await loadCognitoErrors();
    const bad = makeCognitoError(InvalidPasswordException, "weak");
    const { ctx, cognito } = makeCtx({
      path: "/auth/customer/start",
      body: { phoneE164: PHONE },
      cognito: makeFakeCognito({ throwOnCommand: { SignUpCommand: bad } }),
    });
    const res = await handleCustomerAuthRoute(ctx);
    assert.equal(res.statusCode, 500);
    assert.match(res.body.message, /Sign-up failed/);
    // InitiateAuth NOT called
    assert.equal(
      cognito.calls.filter((c) => c.name === "InitiateAuthCommand").length,
      0
    );
  });

  it("InvalidParameterException on SignUp → 500", async () => {
    const { InvalidParameterException } = await loadCognitoErrors();
    const bad = makeCognitoError(InvalidParameterException, "bad input");
    const { ctx } = makeCtx({
      path: "/auth/customer/start",
      body: { phoneE164: PHONE },
      cognito: makeFakeCognito({ throwOnCommand: { SignUpCommand: bad } }),
    });
    const res = await handleCustomerAuthRoute(ctx);
    assert.equal(res.statusCode, 500);
  });

  it("Unknown SignUp errors are propagated", async () => {
    const otherErr = Object.assign(new Error("Throttling"), { name: "ThrottlingException" });
    const { ctx } = makeCtx({
      path: "/auth/customer/start",
      body: { phoneE164: PHONE },
      cognito: makeFakeCognito({ throwOnCommand: { SignUpCommand: otherErr } }),
    });
    await assert.rejects(
      () => handleCustomerAuthRoute(ctx),
      (err) => err?.name === "ThrottlingException"
    );
  });

  it("InitiateAuth UserNotFoundException → 500 (Cognito misconfigured)", async () => {
    const { UserNotFoundException } = await loadCognitoErrors();
    const notFound = makeCognitoError(UserNotFoundException, "no user");
    const { ctx } = makeCtx({
      path: "/auth/customer/start",
      body: { phoneE164: PHONE },
      cognito: makeFakeCognito({
        responses: { SignUpCommand: () => ({}) },
        throwOnCommand: { InitiateAuthCommand: notFound },
      }),
    });
    const res = await handleCustomerAuthRoute(ctx);
    assert.equal(res.statusCode, 500);
    assert.match(res.body.message, /Sign-in failed/);
  });
});

// ---------------------------------------------------------------------------
// POST /auth/customer/verify
// ---------------------------------------------------------------------------

describe("POST /auth/customer/verify — validation", () => {
  it("400 on bad phone", async () => {
    const { ctx } = makeCtx({
      path: "/auth/customer/verify",
      body: { phoneE164: "no-plus", otp: "123456", session: "s" },
    });
    const res = await handleCustomerAuthRoute(ctx);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /E\.164/);
  });

  it("400 on bad otp (5 digits, 7 digits, non-digit)", async () => {
    for (const otp of ["12345", "1234567", "12345a", ""]) {
      const { ctx } = makeCtx({
        path: "/auth/customer/verify",
        body: { phoneE164: PHONE, otp, session: "s" },
      });
      const res = await handleCustomerAuthRoute(ctx);
      assert.equal(res.statusCode, 400);
      assert.match(res.body.message, /6 digits/);
    }
  });

  it("400 on missing session", async () => {
    const { ctx } = makeCtx({
      path: "/auth/customer/verify",
      body: { phoneE164: PHONE, otp: "123456", session: "" },
    });
    const res = await handleCustomerAuthRoute(ctx);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /session required/);
  });
});

describe("POST /auth/customer/verify — happy path", () => {
  it("returns tokens + no-store cache headers when AuthenticationResult is present", async () => {
    const { ctx, cognito } = makeCtx({
      path: "/auth/customer/verify",
      body: { phoneE164: PHONE, otp: "123456", session: SESSION_TOKEN },
      cognito: makeFakeCognito({
        responses: {
          RespondToAuthChallengeCommand: () => ({
            AuthenticationResult: {
              AccessToken: "acc-tok",
              IdToken: "id-tok",
              RefreshToken: "rt-tok",
              ExpiresIn: 3600,
              TokenType: "Bearer",
            },
          }),
        },
      }),
    });
    const res = await handleCustomerAuthRoute(ctx);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.accessToken, "acc-tok");
    assert.equal(res.body.idToken, "id-tok");
    assert.equal(res.body.refreshToken, "rt-tok");
    assert.equal(res.body.expiresIn, 3600);
    assert.equal(res.body.tokenType, "Bearer");
    // CRITICAL: no-store cache headers (tokens must never be cached)
    assert.equal(res.headers["cache-control"], "no-store");
    assert.equal(res.headers.pragma, "no-cache");

    // RespondToAuthChallenge was called with synthetic-email USERNAME + OTP ANSWER + session
    const respond = cognito.calls.find((c) => c.name === "RespondToAuthChallengeCommand");
    assert.equal(respond.input.ClientId, CUSTOMER_CLIENT_ID);
    assert.equal(respond.input.ChallengeName, "CUSTOM_CHALLENGE");
    assert.equal(respond.input.ChallengeResponses.USERNAME, SYNTH_EMAIL);
    assert.equal(respond.input.ChallengeResponses.ANSWER, "123456");
    assert.equal(respond.input.Session, SESSION_TOKEN);
  });

  it("defaults TokenType to 'Bearer' when not in AuthenticationResult", async () => {
    const { ctx } = makeCtx({
      path: "/auth/customer/verify",
      body: { phoneE164: PHONE, otp: "123456", session: SESSION_TOKEN },
      cognito: makeFakeCognito({
        responses: {
          RespondToAuthChallengeCommand: () => ({
            AuthenticationResult: {
              AccessToken: "a",
              IdToken: "i",
              RefreshToken: "r",
              ExpiresIn: 3600,
              // TokenType absent
            },
          }),
        },
      }),
    });
    const res = await handleCustomerAuthRoute(ctx);
    assert.equal(res.body.tokenType, "Bearer");
  });

  it("wrong OTP (no AuthenticationResult) → 401 with new session for retry", async () => {
    const { ctx } = makeCtx({
      path: "/auth/customer/verify",
      body: { phoneE164: PHONE, otp: "999999", session: SESSION_TOKEN },
      cognito: makeFakeCognito({
        responses: {
          RespondToAuthChallengeCommand: () => ({
            // No AuthenticationResult — Cognito returns a fresh session for retry
            Session: "session-retry-tok",
            ChallengeName: "CUSTOM_CHALLENGE",
          }),
        },
      }),
    });
    const res = await handleCustomerAuthRoute(ctx);
    assert.equal(res.statusCode, 401);
    assert.match(res.body.message, /Invalid code/);
    assert.equal(res.body.session, "session-retry-tok");
    assert.equal(res.body.challengeName, "CUSTOM_CHALLENGE");
  });

  it("NotAuthorizedException → 401 'Verification failed. Restart sign-in.'", async () => {
    const { NotAuthorizedException } = await loadCognitoErrors();
    const denied = makeCognitoError(NotAuthorizedException, "expired");
    const { ctx } = makeCtx({
      path: "/auth/customer/verify",
      body: { phoneE164: PHONE, otp: "123456", session: SESSION_TOKEN },
      cognito: makeFakeCognito({
        throwOnCommand: { RespondToAuthChallengeCommand: denied },
      }),
    });
    const res = await handleCustomerAuthRoute(ctx);
    assert.equal(res.statusCode, 401);
    assert.match(res.body.message, /Restart sign-in/);
  });

  it("UserNotFoundException → 401 (treated like NotAuthorized for privacy)", async () => {
    const { UserNotFoundException } = await loadCognitoErrors();
    const notFound = makeCognitoError(UserNotFoundException, "no user");
    const { ctx } = makeCtx({
      path: "/auth/customer/verify",
      body: { phoneE164: PHONE, otp: "123456", session: SESSION_TOKEN },
      cognito: makeFakeCognito({
        throwOnCommand: { RespondToAuthChallengeCommand: notFound },
      }),
    });
    const res = await handleCustomerAuthRoute(ctx);
    assert.equal(res.statusCode, 401);
    // Same generic message as NotAuthorized — doesn't leak that the
    // user doesn't exist
    assert.match(res.body.message, /Restart sign-in/);
  });

  it("Unknown errors propagated", async () => {
    const otherErr = Object.assign(new Error("Throttling"), { name: "ThrottlingException" });
    const { ctx } = makeCtx({
      path: "/auth/customer/verify",
      body: { phoneE164: PHONE, otp: "123456", session: SESSION_TOKEN },
      cognito: makeFakeCognito({
        throwOnCommand: { RespondToAuthChallengeCommand: otherErr },
      }),
    });
    await assert.rejects(
      () => handleCustomerAuthRoute(ctx),
      (err) => err?.name === "ThrottlingException"
    );
  });
});
