# Lambda (ff-reservations-api)

Source for the `ff-reservations-api` Lambda — the single backend behind every API Gateway route in this app, plus the EventBridge cron for overdue-reservation cleanup.

## Files

- `index.mjs` — Lambda handler: HTTP router + EventBridge dispatch + auth helpers + CORS allowlist
- `lib/routes-*.mjs` — Per-domain route handlers
- `lib/services-*.mjs` — Per-domain business logic (DDB writes, Square API calls, SMS, etc.)
- `lib/core-utils.mjs` — Phone normalization, currency helpers (`toMinorUnits` / `toMajorUnits` / `roundToCents`), `getBody`, `httpError`, `json` response helpers
- `lib/services-rate-limit.mjs` — In-Lambda SMS rate-limit backstop for `/auth/customer/start` (Cloudflare WAF is the primary defense)
- `lib/*.test.mjs` — Pure-function specs for the modules below; run with `npm run test:backend` from the repo root (uses Node 22 built-in `node:test`)
- `table-template.json` — Static venue floor plan (table IDs, sections, prices)
- `deploy.sh` — `aws lambda update-function-code` wrapper

### Reservations/holds module split

The old `services-reservations-holds.mjs` (~2.6k lines) was split on 2026-05-09 into four focused modules + a 67-line barrel:

| Module | What it owns |
|---|---|
| `services-reservations-shared.mjs` | Constants (`AUTO_RELEASE_REASON`, `DEFAULT_DEADLINE_TZ`, etc.), pure utilities (`clampNumber`, `roundMoney`, time math), settings resolvers, `appendReservationHistory`, `tryEnsureCheckInPass`, `trySendCheckInPassSms`, read-only DDB queries (`queryReservationsForEventDate`, `getReservationById`), domain predicates (`isOverdueReservation`, `isFrequentAutoReservation`) |
| `services-payment-recording.mjs` | `addReservationPayment` (full state machine including credit-redemption TransactWrite + `depositAmount` CAS for audit C3), `setReservationPaymentLinkWindow`, `markReservationPaymentLinkInactive` |
| `services-reservations.mjs` | `createReservation` (hold→reserved TransactWrite + idempotent replay), `cancelReservation` (3 resolution paths: `CANCEL_NO_REFUND`, `RESCHEDULE_CREDIT`, `REFUND`), `releaseOverdueReservationsForEventDate` / `*ForAllActiveEvents` (cron sweep with concurrency cap 5), reschedule credit helpers (`assertRescheduleCreditAllowed`, `buildRescheduleCreditItem`, `markFrequentTableReleasedForEvent`), reservation reads |
| `services-holds.mjs` | Hold lifecycle: `createHold` / `releaseHold` / `listHolds` / `listTableLocks` |
| `services-reservations-holds.mjs` | **Barrel.** Composes the four above and exposes the same 16-method public surface that `index.mjs` has always seen. Edit this file ONLY when you're changing the public API contract. |
| `services-square-stand-handoff.mjs` | Card on Stand state machine. `startHandoff` writes a 15-min TTL row to `HOLDS_TABLE` under `(PK="STANDPAY", SK="HANDOFF#{uuid}")`; `completeHandoff` resolves the Square POS `transaction_id` → Order → Payment and dispatches `addReservationPayment` with `method: "square"` source `"square-stand"` (idempotent on `providerPaymentId`); `cancelHandoff` marks `PENDING → CANCELLED`. Composed in `index.mjs` separately from the barrel (it depends on `getOrderById` from `services-square-payments.mjs` + `addReservationPayment` + `getReservationById`). |

Composition order in the barrel: `shared` → `paymentRecording` → `reservations` (uses `paymentRecording.markReservationPaymentLinkInactive`) → `holds` (uses `reservations.releaseOverdueReservationsForEventDate`).

## Deploy

```bash
./deploy.sh
```

Zips `index.mjs` + `table-template.json` + `lib/` into `function.zip`, calls `aws lambda update-function-code` against `ff-reservations-api` in `us-east-1`, waits for the update to finish, then re-applies `timeout=15s memory=256MB`.

Override defaults via env:

```bash
FUNCTION_NAME=ff-reservations-api AWS_REGION=us-east-1 \
  TIMEOUT_SECONDS=15 MEMORY_SIZE_MB=256 \
  ./deploy.sh
```

`function.zip` is generated locally and gitignored.

## Adding a new route

API Gateway uses **explicit per-route definitions** — no `$default` proxy. Adding a route is three steps:

1. Implement the handler in the relevant `lib/routes-*.mjs`, wire it through `index.mjs`'s router.
2. Register the route in API Gateway. Pick the authorizer that matches the audience:
   ```bash
   # Staff/admin routes — JWT authorizer 5ea6tk (audience = staff App Client)
   aws apigatewayv2 create-route --api-id oxk1adhl3a \
     --route-key "GET /your/new/route" \
     --target "integrations/0bj43cm" \
     --authorization-type JWT --authorizer-id 5ea6tk \
     --region us-east-1

   # Customer /me/* routes — JWT authorizer lngm05 (audience = customer App Client)
   aws apigatewayv2 create-route --api-id oxk1adhl3a \
     --route-key "GET /me/your-thing" \
     --target "integrations/0bj43cm" \
     --authorization-type JWT --authorizer-id lngm05 \
     --region us-east-1

   # Public routes — no authorizer
   aws apigatewayv2 create-route --api-id oxk1adhl3a \
     --route-key "POST /public/your-thing" \
     --target "integrations/0bj43cm" \
     --authorization-type NONE \
     --region us-east-1
   ```
3. Add a Lambda invoke permission scoped to the route's source-arn. The function's resource policy enumerates routes per-statement; without this step the route returns `500 Internal Server Error` from API Gateway:
   ```bash
   aws lambda add-permission \
     --function-name ff-reservations-api \
     --statement-id apigw-your-thing \
     --action lambda:InvokeFunction \
     --principal apigateway.amazonaws.com \
     --source-arn "arn:aws:execute-api:us-east-1:908027422124:oxk1adhl3a/*/*/your/new/route" \
     --region us-east-1
   ```

## Operational dependencies (not in this folder)

- **Cognito Pre Token Generation v2 Lambda** (`backend/cognito-pre-token-gen/`) injects `cognito:groups` into the access token for staff/admin users. Without it, every authenticated staff request returns 403.
- **Cognito custom-auth Lambda** (`backend/cognito-customer-auth/`) is wired to four user-pool triggers (PreSignUp / DefineAuthChallenge / CreateAuthChallenge / VerifyAuthChallengeResponse) and powers the customer App Client phone-OTP flow. The `/auth/customer/{start,verify}` routes in this lambda call `cognito-idp:SignUp / InitiateAuth / RespondToAuthChallenge` (granted via inline policy `customer-auth-cognito-public-api`); the `DELETE /me` route calls `cognito-idp:AdminDeleteUser` (inline policy `me-routes-cognito-admin`).
- **`ff-reservations.byCustomerSub` GSI** (sparse: `customerCognitoSub HASH, eventDate RANGE`, projection ALL) is read by `GET /me/reservations`. Only items with `customerCognitoSub` set appear, so legacy reservations and history rows are naturally excluded.
- **EventBridge rule `ff-reservations-overdue-release`** fires `rate(1 minute)` and invokes this lambda with `event.source = "aws.events"`. The handler dispatches to `runScheduledMaintenance` → `releaseOverdueReservationsForAllActiveEvents`. Disabling the rule means overdue reservations only get cleaned up when a staff member loads `/reservations` or hits a payment route for that event.
- **Square secret** stored in Secrets Manager at `ff/square/production-QaNJNJ` — JSON with `SQUARE_ACCESS_TOKEN` and `SQUARE_WEBHOOK_SIGNATURE_KEY`. Lambda role needs `secretsmanager:GetSecretValue` on this ARN.
- **Dead-letter queue `ff-reservations-api-dlq`** (SQS, 14-day retention) catches failed async invocations (mostly the EventBridge cron) via `DeadLetterConfig`. Lambda role's inline `DeadLetterQueueAccess` policy grants `sqs:SendMessage` on the queue ARN only. Alarm `ff-res-lambda-dlq-depth` fires on ≥1 visible message in 5min. Inspect with `aws sqs receive-message --queue-url https://sqs.us-east-1.amazonaws.com/908027422124/ff-reservations-api-dlq --max-number-of-messages 10 --region us-east-1`.
- **API Gateway stage throttle** on the `$default` stage: 200 burst / 100 RPS default-route. Per-route overrides via `aws apigatewayv2 update-route --route-settings`.
- **Cloudflare proxy + WAF rate-limit** on `api.famosofuego.com` (Free plan). Custom rule `auth-customer-otp-bombing`: any IP >5 requests / 10s on `/auth/customer/*` → Block 10s. Free-tier rate-limit counters are per-edge, so effective threshold = 5/10s × N edges (≈2 for Houston-area users). AWS WAF v2 isn't available on HTTP APIs (v2), which is why we route through Cloudflare instead. Lambda sees Cloudflare's IP in `event.requestContext.http.sourceIp`; real client IP arrives in the `cf-connecting-ip` header.
- **In-Lambda SMS rate-limit** (`services-rate-limit.mjs`, audit P-H1) — belt-and-suspenders backstop if the Cloudflare WAF is bypassed (e.g. direct API Gateway URL hit). Stored in `HOLDS_TABLE` under `PK="RATE", SK="SMS#{phoneE164}"` with a 10-min sliding window and cap of 5 starts per phone. Rows carry a `ttl` attribute so they auto-garbage-collect once DynamoDB TTL is enabled on the table; until then orphans get overwritten on the next attempt for the same phone.

## Verifying a deploy

```bash
aws lambda get-function-configuration --function-name ff-reservations-api \
  --region us-east-1 \
  --query '{State:State,LastUpdate:LastUpdateStatus,Modified:LastModified,Sha:CodeSha256}' \
  --output json
```

Then watch the cron land via:

```bash
aws logs tail /aws/lambda/ff-reservations-api --follow --filter-pattern "scheduled_maintenance" --region us-east-1
```

(Should see one entry per minute.)

## See also

- `/CLAUDE.md` — full architecture, conventions, auth model, env vars.
- `/backend/cognito-pre-token-gen/README.md` — Pre Token Gen Lambda deploy steps.
- `/backend/cognito-customer-auth/README.md` — customer custom-auth Lambda deploy steps + the synthetic-email pool constraint.
