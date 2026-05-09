// Cognito Custom Auth Challenge handlers (phone OTP) for the customer
// App Client. Single Lambda function routed by event.triggerSource.
//
// This Lambda is wired to FOUR Cognito trigger slots on the user pool:
//   - PreSignUp                       → autoConfirm phone-only signups
//   - DefineAuthChallenge             → orchestrate the CUSTOM_CHALLENGE
//   - CreateAuthChallenge             → generate + SMS the OTP
//   - VerifyAuthChallengeResponse     → compare OTP vs user input
//
// Auth flow (mobile app):
//   1. SignUp(username=+1XXX..., random password) — PreSignUp auto-confirms.
//      Ignore UsernameExistsException; existing users sign in.
//   2. InitiateAuth(AuthFlow=CUSTOM_AUTH, AuthParameters.USERNAME=+1XXX...).
//      Cognito calls DefineAuthChallenge → CUSTOM_CHALLENGE → CreateAuthChallenge → SMS.
//   3. RespondToAuthChallenge(ChallengeName=CUSTOM_CHALLENGE, ANSWER=123456).
//      Cognito calls VerifyAuthChallengeResponse → DefineAuthChallenge issues tokens.
//
// Up to 3 OTP attempts per session; same OTP reused across retries (no
// new SMS for typos) by stashing it in challengeMetadata.
//
// Deployment lives in this folder's README.md.

import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import { randomInt, timingSafeEqual } from "node:crypto";

const sns = new SNSClient({});

const SMS_SENDER_ID = process.env.SMS_SENDER_ID || "FFuego";
const SMS_TYPE = process.env.SMS_TYPE || "Transactional";
const SMS_MAX_PRICE_USD = process.env.SMS_MAX_PRICE_USD || "0.50";
const CUSTOMER_CLIENT_ID = process.env.CUSTOMER_CLIENT_ID || "";
const MAX_ATTEMPTS = 3;

export const handler = async (event) => {
  switch (event.triggerSource) {
    case "PreSignUp_SignUp":
    case "PreSignUp_AdminCreateUser":
      return preSignUp(event);
    case "DefineAuthChallenge_Authentication":
      return defineAuthChallenge(event);
    case "CreateAuthChallenge_Authentication":
      return createAuthChallenge(event);
    case "VerifyAuthChallengeResponse_Authentication":
      return verifyAuthChallengeResponse(event);
    default:
      return event;
  }
};

function preSignUp(event) {
  // Gate auto-confirm to the customer App Client only. Staff Hosted UI
  // signups (if anyone ever uses them) must keep their normal email-
  // verification path — we don't want a random self-signup on the staff
  // client to land as a confirmed user in the pool.
  if (
    CUSTOMER_CLIENT_ID &&
    event.callerContext?.clientId !== CUSTOMER_CLIENT_ID
  ) {
    return event;
  }
  event.response.autoConfirmUser = true;
  if (event.request.userAttributes?.phone_number) {
    event.response.autoVerifyPhone = true;
  }
  return event;
}

function defineAuthChallenge(event) {
  const session = event.request.session ?? [];

  if (session.length === 0) {
    event.response.issueTokens = false;
    event.response.failAuthentication = false;
    event.response.challengeName = "CUSTOM_CHALLENGE";
    return event;
  }

  const last = session[session.length - 1];

  if (last.challengeName !== "CUSTOM_CHALLENGE") {
    event.response.issueTokens = false;
    event.response.failAuthentication = true;
    return event;
  }

  if (last.challengeResult === true) {
    event.response.issueTokens = true;
    event.response.failAuthentication = false;
    return event;
  }

  if (session.length >= MAX_ATTEMPTS) {
    event.response.issueTokens = false;
    event.response.failAuthentication = true;
    return event;
  }

  event.response.issueTokens = false;
  event.response.failAuthentication = false;
  event.response.challengeName = "CUSTOM_CHALLENGE";
  return event;
}

async function createAuthChallenge(event) {
  let secretLoginCode = readPriorOtpFromSession(event.request.session);

  if (!secretLoginCode) {
    secretLoginCode = generateOtp();
    const phone = event.request.userAttributes?.phone_number;
    if (phone) {
      await sendOtpSms(phone, secretLoginCode);
    }
  }

  event.response.privateChallengeParameters = { answer: secretLoginCode };
  event.response.publicChallengeParameters = {};
  // The OTP is stashed in challengeMetadata so subsequent CreateAuthChallenge
  // calls (retries within the same session) can reuse it without a new SMS.
  // challengeMetadata is NOT exposed to the client — it lives inside the
  // Cognito session and is only readable by the auth-challenge Lambda.
  event.response.challengeMetadata = `CODE-${secretLoginCode}`;
  return event;
}

function verifyAuthChallengeResponse(event) {
  const expected = String(event.request.privateChallengeParameters?.answer ?? "");
  const actual = String(event.request.challengeAnswer ?? "");
  // Constant-time compare. Cognito network round-trip dwarfs any timing
  // signal in practice, but using timingSafeEqual costs nothing and keeps
  // the comparison hygiene-correct for any future reuse of this Lambda.
  if (!expected || expected.length !== actual.length) {
    event.response.answerCorrect = false;
    return event;
  }
  const expectedBuf = Buffer.from(expected, "utf8");
  const actualBuf = Buffer.from(actual, "utf8");
  event.response.answerCorrect =
    expectedBuf.length === actualBuf.length &&
    timingSafeEqual(expectedBuf, actualBuf);
  return event;
}

function readPriorOtpFromSession(session) {
  if (!Array.isArray(session) || session.length === 0) return null;
  const last = session[session.length - 1];
  if (typeof last?.challengeMetadata !== "string") return null;
  const match = last.challengeMetadata.match(/^CODE-(\d{6})$/);
  return match ? match[1] : null;
}

function generateOtp() {
  // CSPRNG: Math.random() is predictable from a leaked output stream.
  return String(randomInt(100_000, 1_000_000));
}

async function sendOtpSms(phone, code) {
  await sns.send(
    new PublishCommand({
      PhoneNumber: phone,
      Message: `Your Famoso Fuego verification code is ${code}.`,
      MessageAttributes: {
        "AWS.SNS.SMS.SenderID": {
          DataType: "String",
          StringValue: SMS_SENDER_ID,
        },
        "AWS.SNS.SMS.SMSType": {
          DataType: "String",
          StringValue: SMS_TYPE,
        },
        "AWS.SNS.SMS.MaxPrice": {
          DataType: "Number",
          StringValue: SMS_MAX_PRICE_USD,
        },
      },
    })
  );
}
