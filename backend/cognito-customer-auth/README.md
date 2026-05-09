# Cognito Customer Custom Auth Lambda

Phone-OTP custom-auth flow for the **customer** App Client (mobile app).
Single Lambda routed by `event.triggerSource`; wired into four Cognito
trigger slots on the existing `us-east-1_Upsi9Q2Tc` user pool.

This is the auth foundation for Phase 3 of the migration — see
`/CLAUDE.md` "Auth model" and "Implementation phases".

## Pool constraint discovered during deploy

The user pool was created with `UsernameAttributes: ["email"]` (locked at
creation time — Cognito does not allow editing this). Phone-as-username
SignUp is rejected with `"Username should be an email"`. The pool also
requires `email` and `name` attributes on every user.

**Workaround**: customers are signed up with a deterministic synthetic
email derived from their E.164 phone:

```
phone     = +528991054670
username  = customer-528991054670@customer.famosofuego.local
phone_number attribute = +528991054670
email attribute        = customer-528991054670@customer.famosofuego.local
name attribute         = "Customer +528991054670"  (or whatever the app collects)
```

The synthetic email is never used for delivery — Cognito's customer App
Client doesn't trigger email verification, and the customer flow uses
phone OTP exclusively. Mobile app code that creates customers must
compute this synthetic email deterministically so that re-signing-up an
existing customer hits `UsernameExistsException` and falls through to
sign-in (rather than creating a duplicate user under a different
synthetic alias).

## What's needed end-to-end (deployment checklist)

This folder ships the Lambda source. Deployment also requires:

1. **IAM role** (`ff-reservations-customer-auth-role`) with:
   - `AWSLambdaBasicExecutionRole` (CloudWatch Logs)
   - Inline policy: `sns:Publish` on `*` (or restrict to phone-only via condition keys later)
2. **Lambda function** `ff-reservations-customer-auth` (Node 22, this folder zipped)
3. **Cognito user pool triggers** wired (4 slots)
4. **Second App Client** on the user pool (`ff-reservations-customer`) with:
   - `ExplicitAuthFlows: ALLOW_CUSTOM_AUTH, ALLOW_REFRESH_TOKEN_AUTH`
   - No `ClientSecret`
   - `PreventUserExistenceErrors: ENABLED`
   - `RefreshTokenValidity: 30 days`, access/id token validity 1 hour
5. **SMS sandbox / production capacity** check — SNS or AWS End User Messaging needs origination identity. The toll-free `+18557656160` is registered (status PENDING per CLAUDE.md); production capacity may use shared shortcodes until approval lands.

**Deployed values (post-deploy 2026-05-08):**
- Lambda ARN: `arn:aws:lambda:us-east-1:908027422124:function:ff-reservations-customer-auth`
- IAM role ARN: `arn:aws:iam::908027422124:role/ff-reservations-customer-auth-role`
- Customer App Client ID: `21n3rd1sp4o9ka4l7tld45f0ka`
- Lambda env: `SMS_SENDER_ID=FFuego`, `SMS_TYPE=Transactional`, `SMS_MAX_PRICE_USD=0.50`, `CUSTOMER_CLIENT_ID=21n3rd1sp4o9ka4l7tld45f0ka` (PreSignUp gates on this so staff Hosted UI signups still require email verification)

## Source build

```bash
cd backend/cognito-customer-auth

# Install runtime dep (kept lean — only AWS SDK v3 SNS client)
npm install --omit=dev

# Zip
zip -r function.zip index.mjs node_modules package.json
```

## One-time deploy

Replace `<ACCOUNT_ID>` with the AWS account (`908027422124`).

```bash
# 1. Create the role (one-time)
aws iam create-role \
  --role-name ff-reservations-customer-auth-role \
  --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Principal": { "Service": "lambda.amazonaws.com" },
      "Action": "sts:AssumeRole"
    }]
  }'

aws iam attach-role-policy \
  --role-name ff-reservations-customer-auth-role \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole

aws iam put-role-policy \
  --role-name ff-reservations-customer-auth-role \
  --policy-name sns-publish \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Action": "sns:Publish",
      "Resource": "*"
    }]
  }'

# 2. Create the function
aws lambda create-function \
  --function-name ff-reservations-customer-auth \
  --runtime nodejs22.x \
  --role arn:aws:iam::<ACCOUNT_ID>:role/ff-reservations-customer-auth-role \
  --handler index.handler \
  --zip-file fileb://function.zip \
  --timeout 5 --memory-size 128 \
  --environment "Variables={SMS_SENDER_ID=FFuego,SMS_TYPE=Transactional,SMS_MAX_PRICE_USD=0.50}" \
  --region us-east-1

# 3. Allow Cognito to invoke
aws lambda add-permission \
  --function-name ff-reservations-customer-auth \
  --statement-id cognito-invoke \
  --action lambda:InvokeFunction \
  --principal cognito-idp.amazonaws.com \
  --source-arn arn:aws:cognito-idp:us-east-1:<ACCOUNT_ID>:userpool/us-east-1_Upsi9Q2Tc \
  --region us-east-1

# 4. Wire all four triggers on the user pool
#    The user pool already has PreTokenGenerationConfig → keep it; we're
#    adding to LambdaConfig, not replacing it. Read current config first
#    to avoid clobbering:
aws cognito-idp describe-user-pool \
  --user-pool-id us-east-1_Upsi9Q2Tc \
  --region us-east-1 \
  --query 'UserPool.LambdaConfig' --output json

# Then merge our 4 triggers in. Example (replace <ACCOUNT_ID> + preserve existing PreTokenGenerationConfig):
aws cognito-idp update-user-pool \
  --user-pool-id us-east-1_Upsi9Q2Tc \
  --lambda-config '{
    "PreTokenGenerationConfig": {
      "LambdaArn": "arn:aws:lambda:us-east-1:<ACCOUNT_ID>:function:ff-reservations-pre-token-gen",
      "LambdaVersion": "V2_0"
    },
    "PreSignUp": "arn:aws:lambda:us-east-1:<ACCOUNT_ID>:function:ff-reservations-customer-auth",
    "DefineAuthChallenge": "arn:aws:lambda:us-east-1:<ACCOUNT_ID>:function:ff-reservations-customer-auth",
    "CreateAuthChallenge": "arn:aws:lambda:us-east-1:<ACCOUNT_ID>:function:ff-reservations-customer-auth",
    "VerifyAuthChallengeResponse": "arn:aws:lambda:us-east-1:<ACCOUNT_ID>:function:ff-reservations-customer-auth"
  }' \
  --region us-east-1
```

## Create the customer App Client

```bash
aws cognito-idp create-user-pool-client \
  --user-pool-id us-east-1_Upsi9Q2Tc \
  --client-name ff-reservations-customer \
  --explicit-auth-flows ALLOW_CUSTOM_AUTH ALLOW_REFRESH_TOKEN_AUTH \
  --prevent-user-existence-errors ENABLED \
  --refresh-token-validity 30 \
  --access-token-validity 60 \
  --id-token-validity 60 \
  --token-validity-units 'AccessToken=minutes,IdToken=minutes,RefreshToken=days' \
  --region us-east-1
```

Capture the returned `ClientId` and put it in `apps/web/.env.local` /
Amplify env / Expo `app.json` extras as `VITE_COGNITO_CUSTOMER_CLIENT_ID` /
`expoConfig.extra.cognito.customerClientId`.

## Testing the flow from CLI (no mobile app needed)

Once deployed and the customer App Client exists, you can drive the
whole flow from `aws-cli`. Replace `+15555550100` with a real E.164
phone you can receive SMS on.

```bash
PHONE=+15555550100
DIGITS=${PHONE#+}
SYNTH_EMAIL=customer-${DIGITS}@customer.famosofuego.local
CLIENT_ID=21n3rd1sp4o9ka4l7tld45f0ka   # customer App Client (this pool)

# 1. Create a user (PreSignUp Lambda autoconfirms + autoVerifyPhone)
aws cognito-idp sign-up \
  --client-id "$CLIENT_ID" \
  --username "$SYNTH_EMAIL" \
  --password "Throwaway$(openssl rand -hex 6)!Q1" \
  --user-attributes \
    Name=phone_number,Value="$PHONE" \
    Name=email,Value="$SYNTH_EMAIL" \
    Name=name,Value="Customer $PHONE" \
  --region us-east-1
# Ignore UsernameExistsException on subsequent runs (existing user just
# proceeds to InitiateAuth below).

# 2. Initiate auth — triggers DefineAuthChallenge → CreateAuthChallenge → SMS
SESSION=$(aws cognito-idp initiate-auth \
  --client-id "$CLIENT_ID" \
  --auth-flow CUSTOM_AUTH \
  --auth-parameters USERNAME="$SYNTH_EMAIL" \
  --region us-east-1 \
  --query Session --output text)

# 3. Respond with the OTP from the SMS
aws cognito-idp respond-to-auth-challenge \
  --client-id "$CLIENT_ID" \
  --challenge-name CUSTOM_CHALLENGE \
  --challenge-responses USERNAME="$SYNTH_EMAIL",ANSWER=275991 \
  --session "$SESSION" \
  --region us-east-1
# Returns AccessToken / IdToken / RefreshToken on success. The access
# token has token_use=access, no cognito:groups, sub=customer's UUID.
```

Cleanup test users:

```bash
aws cognito-idp admin-delete-user \
  --user-pool-id us-east-1_Upsi9Q2Tc \
  --username "$SYNTH_EMAIL" \
  --region us-east-1
```

## Observability

- Successes: `aws logs tail /aws/lambda/ff-reservations-customer-auth --follow --region us-east-1`
- SMS sends: `aws logs tail sns/us-east-1/<ACCOUNT_ID>/DirectPublishToPhoneNumber --follow`
- SMS failures: `aws logs tail sns/us-east-1/<ACCOUNT_ID>/DirectPublishToPhoneNumber/Failure --follow`

## Limits / hardening to-dos

- The OTP is regenerated only when no prior session exists. Within a
  session, the same code is reused for all retries. After 3 failed
  attempts `DefineAuthChallenge` returns `failAuthentication=true`.
- No per-phone rate limit at the Lambda layer. Phase 3 also lands a
  WAF v2 web ACL on API Gateway (rate-based rule for
  `/auth/customer/*`) — this Lambda is not behind API Gateway, so the
  WAF doesn't protect it. Cognito's per-IP throttle (40 req / 5s burst)
  is the only existing guardrail.
- SMS spend cap: SNS-side `MonthlySpendLimit` is currently $20 (see
  CLAUDE.md). Customer auth + payment-link SMS share that pool —
  raising it is a deferred audit item.
