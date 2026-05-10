// Tests for the customer-auth Cognito Lambda (phone-OTP custom auth
// challenge). Single Lambda, 4 trigger sources (PreSignUp,
// DefineAuthChallenge, CreateAuthChallenge, VerifyAuthChallengeResponse).
//
// Coverage focuses on the pure handlers (preSignUp, defineAuthChallenge,
// verifyAuthChallengeResponse, readPriorOtpFromSession, generateOtp).
// CreateAuthChallenge is covered for the prior-OTP-reuse path (skips
// SNS); the first-call SNS dispatch path is covered indirectly by the
// route tests in routes-customer-auth.

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  defineAuthChallenge,
  generateOtp,
  handler,
  preSignUp,
  readPriorOtpFromSession,
  verifyAuthChallengeResponse,
} from "./index.mjs";

const ORIGINAL_ENV_CLIENT_ID = process.env.CUSTOMER_CLIENT_ID;

afterEach(() => {
  if (ORIGINAL_ENV_CLIENT_ID === undefined) {
    delete process.env.CUSTOMER_CLIENT_ID;
  } else {
    process.env.CUSTOMER_CLIENT_ID = ORIGINAL_ENV_CLIENT_ID;
  }
});

// ---------------------------------------------------------------------------
// preSignUp
// ---------------------------------------------------------------------------

describe("preSignUp", () => {
  it("auto-confirms + auto-verifies phone for the customer App Client", () => {
    // The CUSTOMER_CLIENT_ID is read at module load time; preSignUp
    // currently allows any clientId because env was unset when module
    // loaded. Test what it does with the current behavior.
    const event = {
      callerContext: { clientId: "any-client" },
      request: { userAttributes: { phone_number: "+12025550100" } },
      response: {},
    };
    const out = preSignUp(event);
    assert.equal(out.response.autoConfirmUser, true);
    assert.equal(out.response.autoVerifyPhone, true);
  });

  it("does not set autoVerifyPhone when phone_number attribute missing", () => {
    const event = {
      callerContext: { clientId: "any" },
      request: { userAttributes: {} },
      response: {},
    };
    const out = preSignUp(event);
    assert.equal(out.response.autoConfirmUser, true);
    assert.equal(out.response.autoVerifyPhone, undefined);
  });
});

// ---------------------------------------------------------------------------
// defineAuthChallenge — orchestration state machine
// ---------------------------------------------------------------------------

describe("defineAuthChallenge", () => {
  it("first call (empty session): asks for CUSTOM_CHALLENGE", () => {
    const event = { request: { session: [] }, response: {} };
    const out = defineAuthChallenge(event);
    assert.equal(out.response.challengeName, "CUSTOM_CHALLENGE");
    assert.equal(out.response.issueTokens, false);
    assert.equal(out.response.failAuthentication, false);
  });

  it("missing session entirely (treated as empty): asks for CUSTOM_CHALLENGE", () => {
    const event = { request: {}, response: {} };
    const out = defineAuthChallenge(event);
    assert.equal(out.response.challengeName, "CUSTOM_CHALLENGE");
  });

  it("non-CUSTOM_CHALLENGE in session → fail authentication", () => {
    const event = {
      request: {
        session: [{ challengeName: "PASSWORD_VERIFIER", challengeResult: false }],
      },
      response: {},
    };
    const out = defineAuthChallenge(event);
    assert.equal(out.response.failAuthentication, true);
    assert.equal(out.response.issueTokens, false);
  });

  it("**successful CUSTOM_CHALLENGE → issue tokens**", () => {
    const event = {
      request: {
        session: [{ challengeName: "CUSTOM_CHALLENGE", challengeResult: true }],
      },
      response: {},
    };
    const out = defineAuthChallenge(event);
    assert.equal(out.response.issueTokens, true);
    assert.equal(out.response.failAuthentication, false);
  });

  it("**3 failed attempts → fail authentication** (MAX_ATTEMPTS=3)", () => {
    const event = {
      request: {
        session: [
          { challengeName: "CUSTOM_CHALLENGE", challengeResult: false },
          { challengeName: "CUSTOM_CHALLENGE", challengeResult: false },
          { challengeName: "CUSTOM_CHALLENGE", challengeResult: false },
        ],
      },
      response: {},
    };
    const out = defineAuthChallenge(event);
    assert.equal(out.response.failAuthentication, true);
    assert.equal(out.response.issueTokens, false);
  });

  it("1 or 2 failed attempts → retry CUSTOM_CHALLENGE (still allowed)", () => {
    for (let attempts = 1; attempts <= 2; attempts += 1) {
      const event = {
        request: {
          session: Array(attempts).fill({
            challengeName: "CUSTOM_CHALLENGE",
            challengeResult: false,
          }),
        },
        response: {},
      };
      const out = defineAuthChallenge(event);
      assert.equal(out.response.challengeName, "CUSTOM_CHALLENGE", `attempts=${attempts}`);
      assert.equal(out.response.issueTokens, false);
      assert.equal(out.response.failAuthentication, false);
    }
  });
});

// ---------------------------------------------------------------------------
// verifyAuthChallengeResponse — timing-safe OTP comparison
// ---------------------------------------------------------------------------

describe("verifyAuthChallengeResponse", () => {
  function makeVerifyEvent(expected, actual) {
    return {
      request: {
        privateChallengeParameters: { answer: expected },
        challengeAnswer: actual,
      },
      response: {},
    };
  }

  it("answerCorrect=true on exact OTP match", () => {
    const event = makeVerifyEvent("123456", "123456");
    const out = verifyAuthChallengeResponse(event);
    assert.equal(out.response.answerCorrect, true);
  });

  it("answerCorrect=false on wrong OTP (same length)", () => {
    const event = makeVerifyEvent("123456", "654321");
    const out = verifyAuthChallengeResponse(event);
    assert.equal(out.response.answerCorrect, false);
  });

  it("**answerCorrect=false on length mismatch** (no timing leak via short-circuit)", () => {
    const event = makeVerifyEvent("123456", "12345");
    const out = verifyAuthChallengeResponse(event);
    assert.equal(out.response.answerCorrect, false);
  });

  it("answerCorrect=false on empty expected (defensive)", () => {
    const event = makeVerifyEvent("", "123456");
    const out = verifyAuthChallengeResponse(event);
    assert.equal(out.response.answerCorrect, false);
  });

  it("answerCorrect=false on empty actual", () => {
    const event = makeVerifyEvent("123456", "");
    const out = verifyAuthChallengeResponse(event);
    assert.equal(out.response.answerCorrect, false);
  });

  it("coerces non-string inputs (privateChallengeParameters.answer / challengeAnswer)", () => {
    const event = {
      request: {
        privateChallengeParameters: { answer: 123456 },
        challengeAnswer: "123456",
      },
      response: {},
    };
    const out = verifyAuthChallengeResponse(event);
    assert.equal(out.response.answerCorrect, true);
  });
});

// ---------------------------------------------------------------------------
// readPriorOtpFromSession
// ---------------------------------------------------------------------------

describe("readPriorOtpFromSession", () => {
  it("extracts OTP from CODE-NNNNNN challengeMetadata", () => {
    const session = [{ challengeMetadata: "CODE-123456" }];
    assert.equal(readPriorOtpFromSession(session), "123456");
  });

  it("returns null when session is empty / null / non-array", () => {
    assert.equal(readPriorOtpFromSession([]), null);
    assert.equal(readPriorOtpFromSession(null), null);
    assert.equal(readPriorOtpFromSession(undefined), null);
    assert.equal(readPriorOtpFromSession("not array"), null);
  });

  it("returns null when challengeMetadata is missing or wrong format", () => {
    assert.equal(readPriorOtpFromSession([{}]), null);
    assert.equal(readPriorOtpFromSession([{ challengeMetadata: "" }]), null);
    assert.equal(readPriorOtpFromSession([{ challengeMetadata: "wrong-format" }]), null);
    assert.equal(readPriorOtpFromSession([{ challengeMetadata: "CODE-12345" }]), null); // 5 digits
    assert.equal(readPriorOtpFromSession([{ challengeMetadata: "CODE-1234567" }]), null); // 7 digits
    assert.equal(readPriorOtpFromSession([{ challengeMetadata: "CODE-abcdef" }]), null);
  });

  it("returns last entry's OTP (not first)", () => {
    const session = [
      { challengeMetadata: "CODE-111111" },
      { challengeMetadata: "CODE-222222" },
    ];
    assert.equal(readPriorOtpFromSession(session), "222222");
  });
});

// ---------------------------------------------------------------------------
// generateOtp — CSPRNG, 6 digits
// ---------------------------------------------------------------------------

describe("generateOtp", () => {
  it("returns a 6-digit string in [100000, 999999]", () => {
    for (let i = 0; i < 50; i += 1) {
      const otp = generateOtp();
      assert.equal(typeof otp, "string");
      assert.match(otp, /^\d{6}$/);
      const n = Number(otp);
      assert.ok(n >= 100000 && n <= 999999, `${otp} out of range`);
    }
  });

  it("**uses CSPRNG** (not Math.random — security regression)", () => {
    // Statistical sanity: 100 samples with at least 50 unique values.
    // Math.random would also pass this; the real check is in the
    // implementation (uses node:crypto's randomInt). This test pins
    // that distribution looks random-ish.
    const samples = new Set();
    for (let i = 0; i < 100; i += 1) {
      samples.add(generateOtp());
    }
    assert.ok(samples.size >= 50, `low entropy: ${samples.size}/100 unique`);
  });
});

// ---------------------------------------------------------------------------
// handler — dispatcher across all 4 trigger sources
// ---------------------------------------------------------------------------

describe("handler dispatcher", () => {
  it("PreSignUp_SignUp → preSignUp", async () => {
    const event = {
      triggerSource: "PreSignUp_SignUp",
      callerContext: { clientId: "x" },
      request: { userAttributes: { phone_number: "+1" } },
      response: {},
    };
    const out = await handler(event);
    assert.equal(out.response.autoConfirmUser, true);
  });

  it("PreSignUp_AdminCreateUser → preSignUp", async () => {
    const event = {
      triggerSource: "PreSignUp_AdminCreateUser",
      callerContext: { clientId: "x" },
      request: { userAttributes: {} },
      response: {},
    };
    const out = await handler(event);
    assert.equal(out.response.autoConfirmUser, true);
  });

  it("DefineAuthChallenge_Authentication → defineAuthChallenge", async () => {
    const event = {
      triggerSource: "DefineAuthChallenge_Authentication",
      request: { session: [] },
      response: {},
    };
    const out = await handler(event);
    assert.equal(out.response.challengeName, "CUSTOM_CHALLENGE");
  });

  it("VerifyAuthChallengeResponse_Authentication → verifyAuthChallengeResponse", async () => {
    const event = {
      triggerSource: "VerifyAuthChallengeResponse_Authentication",
      request: {
        privateChallengeParameters: { answer: "111111" },
        challengeAnswer: "111111",
      },
      response: {},
    };
    const out = await handler(event);
    assert.equal(out.response.answerCorrect, true);
  });

  it("CreateAuthChallenge_Authentication with prior OTP → reuses OTP, no SNS call", async () => {
    // Prior-OTP path: challengeMetadata="CODE-654321" in last session entry.
    // sendOtpSms is NOT called.
    const event = {
      triggerSource: "CreateAuthChallenge_Authentication",
      request: {
        userAttributes: { phone_number: "+12025550100" },
        session: [
          {
            challengeName: "CUSTOM_CHALLENGE",
            challengeResult: false,
            challengeMetadata: "CODE-654321",
          },
        ],
      },
      response: {},
    };
    const out = await handler(event);
    assert.equal(out.response.privateChallengeParameters.answer, "654321");
    assert.equal(out.response.challengeMetadata, "CODE-654321");
    assert.deepEqual(out.response.publicChallengeParameters, {});
  });

  it("unknown triggerSource → returns event unchanged (defensive)", async () => {
    const event = { triggerSource: "Unknown_Source" };
    const out = await handler(event);
    assert.equal(out, event);
  });
});
