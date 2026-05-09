// Public mediator routes for the customer phone-OTP flow.
//
// Why these exist:
//   The Cognito user pool was created with UsernameAttributes=["email"]
//   (locked at creation), so customers can't sign up with phone-as-
//   username. Internally we use a deterministic synthetic email
//   (customer-{e164}@customer.famosofuego.local) — but exposing that
//   convention to mobile would be brittle. These routes encapsulate it
//   so mobile only ever sends/receives plain phone + OTP.
//
// Flow:
//   POST /auth/customer/start  { phoneE164, name? }
//     → Best-effort SignUp (PreSignUp Lambda autoconfirms)
//     → InitiateAuth CUSTOM_AUTH (custom-auth Lambda SMSes the OTP)
//     → returns { session, challengeName }
//
//   POST /auth/customer/verify { phoneE164, otp, session }
//     → RespondToAuthChallenge with synthetic-email USERNAME
//     → returns { accessToken, idToken, refreshToken, expiresIn, tokenType }
//     → on wrong OTP: 401 with the new session for retry
//
// Both routes are registered with --authorization-type NONE in API
// Gateway (public). Rate limiting is the API Gateway $default stage
// throttle for now; WAF rate-based rule on /auth/customer/* is a
// Phase 3 follow-up.

import {
  CognitoIdentityProviderClient,
  SignUpCommand,
  InitiateAuthCommand,
  RespondToAuthChallengeCommand,
  UsernameExistsException,
  InvalidPasswordException,
  InvalidParameterException,
  NotAuthorizedException,
  UserNotFoundException,
} from "@aws-sdk/client-cognito-identity-provider";
import crypto from "node:crypto";

const cognito = new CognitoIdentityProviderClient({});
const SYNTH_EMAIL_DOMAIN = "customer.famosofuego.local";

// Tokens / identity must never be cached by intermediaries.
const NO_STORE_HEADERS = Object.freeze({
  "cache-control": "no-store",
  pragma: "no-cache",
});

function syntheticEmailFromPhone(phoneE164) {
  const digits = String(phoneE164 || "").replace(/^\+/, "").replace(/\D/g, "");
  return `customer-${digits}@${SYNTH_EMAIL_DOMAIN}`;
}

function isValidE164(phone) {
  return typeof phone === "string" && /^\+[1-9]\d{6,14}$/.test(phone);
}

function isSixDigitOtp(value) {
  return typeof value === "string" && /^\d{6}$/.test(value);
}

function generateThrowawayPassword() {
  // Cognito default policy: ≥8 chars, mixed case, digit, symbol.
  // The password is never used (CUSTOM_AUTH bypasses it) but must satisfy
  // the policy at SignUp time.
  return `Cust${crypto.randomBytes(8).toString("hex")}!1Q`;
}

export async function handleCustomerAuthRoute(ctx) {
  const {
    method,
    path,
    event,
    cors,
    json,
    getBody,
    customerClientId,
    checkAndIncrementSmsRateLimit,
  } = ctx;
  if (!customerClientId) return null;

  if (method === "POST" && path === "/auth/customer/start") {
    const body = (await getBody(event)) ?? {};
    const phone = String(body.phoneE164 ?? "").trim();
    const placeholderName = `Customer ${phone || "(unknown)"}`;
    const name = String(body.name ?? "").trim() || placeholderName;
    if (!isValidE164(phone)) {
      return json(400, { message: "phoneE164 required, E.164 format" }, cors);
    }

    // Per-phone SMS rate-limit (audit P-H1). Cloudflare WAF rate-limits
    // /auth/customer/* at the edge; this catches the case where the API
    // Gateway URL is hit directly. Throws 429 when the cap is exceeded;
    // the router's outer try/catch shapes it into the response.
    if (typeof checkAndIncrementSmsRateLimit === "function") {
      await checkAndIncrementSmsRateLimit(phone);
    }

    const username = syntheticEmailFromPhone(phone);

    try {
      await cognito.send(
        new SignUpCommand({
          ClientId: customerClientId,
          Username: username,
          Password: generateThrowawayPassword(),
          UserAttributes: [
            { Name: "phone_number", Value: phone },
            { Name: "email", Value: username },
            { Name: "name", Value: name },
          ],
        })
      );
    } catch (err) {
      if (err instanceof UsernameExistsException) {
        // Existing user → fall through to InitiateAuth
      } else if (
        err instanceof InvalidPasswordException ||
        err instanceof InvalidParameterException
      ) {
        // Should not happen — the throwaway password and inputs are
        // server-controlled. Surface as a 500 for ops to investigate.
        console.error("customer_auth_signup_invariant_violation", {
          name: err.name,
          message: err.message,
        });
        return json(500, { message: "Sign-up failed" }, cors);
      } else {
        throw err;
      }
    }

    let initRes;
    try {
      initRes = await cognito.send(
        new InitiateAuthCommand({
          ClientId: customerClientId,
          AuthFlow: "CUSTOM_AUTH",
          AuthParameters: { USERNAME: username },
        })
      );
    } catch (err) {
      // PreventUserExistenceErrors=ENABLED on the customer client should
      // mask UserNotFound; if we still see it, something's misconfigured.
      if (err instanceof UserNotFoundException) {
        console.error("customer_auth_initiate_user_not_found", { username });
        return json(500, { message: "Sign-in failed" }, cors);
      }
      throw err;
    }

    return json(
      200,
      {
        session: initRes.Session ?? null,
        challengeName: initRes.ChallengeName ?? null,
      },
      cors
    );
  }

  if (method === "POST" && path === "/auth/customer/verify") {
    const body = (await getBody(event)) ?? {};
    const phone = String(body.phoneE164 ?? "").trim();
    const otp = String(body.otp ?? "").trim();
    const session = String(body.session ?? "").trim();
    if (!isValidE164(phone)) {
      return json(400, { message: "phoneE164 required, E.164 format" }, cors);
    }
    if (!isSixDigitOtp(otp)) {
      return json(400, { message: "otp must be 6 digits" }, cors);
    }
    if (!session) {
      return json(400, { message: "session required" }, cors);
    }

    const username = syntheticEmailFromPhone(phone);

    let res;
    try {
      res = await cognito.send(
        new RespondToAuthChallengeCommand({
          ClientId: customerClientId,
          ChallengeName: "CUSTOM_CHALLENGE",
          ChallengeResponses: { USERNAME: username, ANSWER: otp },
          Session: session,
        })
      );
    } catch (err) {
      if (
        err instanceof NotAuthorizedException ||
        err instanceof UserNotFoundException
      ) {
        // Session expired, too many attempts, or account disabled.
        return json(
          401,
          { message: "Verification failed. Restart sign-in." },
          cors
        );
      }
      throw err;
    }

    if (!res.AuthenticationResult) {
      // Wrong OTP → Cognito returns a fresh session for retry. Surface
      // it so the client can prompt for a new code without restarting.
      return json(
        401,
        {
          message: "Invalid code",
          session: res.Session ?? null,
          challengeName: res.ChallengeName ?? null,
        },
        cors
      );
    }

    const auth = res.AuthenticationResult;
    return json(
      200,
      {
        accessToken: auth.AccessToken,
        idToken: auth.IdToken,
        refreshToken: auth.RefreshToken,
        expiresIn: auth.ExpiresIn,
        tokenType: auth.TokenType ?? "Bearer",
      },
      { ...cors, ...NO_STORE_HEADERS }
    );
  }

  return null;
}
