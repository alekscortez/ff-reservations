# FF Reservations

Nightclub reservations platform with role-aware staff/admin web app, serverless API, payment links, SMS notifications, check-in passes, and public live table map.

## Stack
- Frontend: Angular 21 + Tailwind (`/src`)
- Backend: AWS Lambda Node.js 22 (ESM) (`/backend/lambda`)
- API: API Gateway HTTP API (`$default` stage)
- Data: DynamoDB
- Auth: Cognito Hosted UI + JWT authorizer
- Hosting: Amplify (web)
- Payments: Square (payment links + webhook handling)
- Messaging: Amazon SNS (SMS)
- Scanner: ZXing for QR check-in flow

## Current AWS context
- API base URL: `https://api.famosofuego.com` (custom domain mapped to API Gateway HTTP API `oxk1adhl3a`)
- Cognito user pool: `us-east-1_Upsi9Q2Tc`
- Cognito app client: `1kdkvis45qo915plp7lvj03u16`
- Amplify URL: `https://main.d1gxn3rvy5gfn4.amplifyapp.com`
- Pre Token Generation v2 Lambda `ff-reservations-pretoken` is wired on the user pool — required for `cognito:groups` to land in the access token (source under `backend/cognito-pre-token-gen/`).
- EventBridge rule `ff-reservations-overdue-release` fires `rate(1 minute)` and triggers `runScheduledMaintenance` in the lambda.
- Lambda async-invocation DLQ: SQS `ff-reservations-api-dlq` (14-day retention). Failed scheduled invocations land here; `ff-res-lambda-dlq-depth` alarm pages on ≥1 visible message in 5min.
- API Gateway `$default` stage throttle: 200 burst / 100 RPS (default-route, no per-route overrides).
- CloudWatch alarms publish to SNS `ff-res-ops-alerts` (subscribers: `aws@redbone.mx`, `dev@alekscortez.com`): lambda duration p95 / errors / throttles / SMS-route errors / reservation-history write failures / lambda DLQ depth / **post-charge auto-refund failures (`ff-res-auto-refund-failed-5m`)** / **REFUND-resolution refunds-orphaned-from-reservation (`ff-res-refund-orphaned-5m`)**.

For deeper architecture, conventions, and known gotchas see [CLAUDE.md](./CLAUDE.md).

## Core flows implemented
- Event management with one active event per date lock.
- Table hold lifecycle (short hold), reservation creation, cancellation, payment updates.
- `POST /reservations` is idempotent on `holdId` (safe to retry on network failure).
- Staff payment collection with `cash`, `square`, `cashapp`, and reschedule credit usage.
- Square payment links + webhook reconciliation.
- In-venue Cash App via Square Web Payments SDK: staff opens the host-stand iPad, the customer scans the QR with their Cash App, payment posts to Square + the reservation in one shot. No Cash App link is ever sent to the customer.
- **Card on Stand** (in-venue card swipe): Safari on the host-stand iPad hands the charge off to the Square POS app on the same iPad via the Square POS API URL scheme (`square-commerce-v1://payment/create`). Customer's card swipes natively on the Stand reader; Square POS redirects back to `/square-stand-callback` which records the payment automatically. Single-iPad only (URL schemes are device-local). Requires the callback URL registered in the Square Developer Console + Open Tickets + tipping disabled in Square POS settings (POS API has no flags for those).
- Cancellation resolutions: `CANCEL_NO_REFUND`, `RESCHEDULE_CREDIT`, `REFUND` (REFUND issues actual Square refunds for paid Square/Cash App entries).
- SMS for payment links, check-in pass, and expired-link notices (with `Reply STOP to opt out.` per 10DLC compliance).
- Check-in pass issue/reissue + one-time QR validation.
- Public live map route at `/map?eventDate=YYYY-MM-DD` (also `/availability` alias).
- EventBridge cron sweeps overdue reservations every 60 seconds (no manual cleanup needed).

## Important business rules
- One active event per calendar day.
- No double booking for the same event/table.
- Atomic `HOLD -> RESERVED` protection.
- Pending/partial payments require deadline behavior.
- Reschedule credits supported with expiration and application tracking.
- Check-in pass is one-time use.

## Repository layout
- `/src` Angular app. The staff Hold & Reserve page (`src/app/features/staff/reservations-new/`) had its pure helpers extracted into 5 sibling modules on 2026-05-09 — see `CLAUDE.md` "Where to look first" for the per-module breakdown.
- `/backend/lambda` Lambda handler and service modules (the reservations/holds domain was split into 4 focused service modules + a 67-line barrel on 2026-05-09 — see `/backend/lambda/README.md`)
- `/http` HTTP client requests for smoke/debug testing
- `/src/assets/maps/FF_Reservations_Map.normalized.svg` live table map asset

## Local development

### Prerequisites
- Node.js 20+ (frontend)
- npm 11+
- AWS CLI configured for deployment/testing

### Frontend
```bash
npm install
npm start
```
App runs at `http://localhost:4200`.

Config lives in:
- `/src/app/core/config/app-config.ts`

If you need a different API/Cognito setup (dev/staging/prod), update that config file before build/deploy.

### Lambda (manual deploy script)
From `/backend/lambda`:
```bash
./deploy.sh
```

Defaults used by script:
- `FUNCTION_NAME=ff-reservations-api`
- `AWS_REGION=us-east-1`
- `TIMEOUT_SECONDS=15`
- `MEMORY_SIZE_MB=256`

Override example:
```bash
FUNCTION_NAME=ff-reservations-api AWS_REGION=us-east-1 ./deploy.sh
```

## Lambda environment variables
Main expected keys:
- `EVENTS_TABLE`
- `HOLDS_TABLE`
- `RES_TABLE`
- `FREQUENT_CLIENTS_TABLE`
- `CLIENTS_TABLE`
- `CHECKIN_PASSES_TABLE`
- `SETTINGS_TABLE`
- `USER_POOL_ID`
- `SQUARE_SECRET_ARN`
- `SQUARE_ENV`
- `SQUARE_LOCATION_ID`
- `SQUARE_APPLICATION_ID` (the `client_id` sent to Square POS during Card on Stand handoff; also surfaced to the FE for Cash App Web Payments SDK)
- `SQUARE_API_VERSION`
- `SQUARE_WEBHOOK_NOTIFICATION_URL`
- `SQUARE_STAND_CALLBACK_URL` (optional; defaults to `https://famosofuego.com/square-stand-callback` — must match the Web callback URL registered in the Square Developer Console → Point of Sale API)
- `SMS_ENABLED`
- `SMS_SENDER_ID`
- `SMS_TYPE`
- `SMS_MAX_PRICE_USD`
- `AUTO_SEND_SQUARE_LINK_SMS`
- `PAYMENT_LINK_TTL_MINUTES`
- `CHECKIN_PASS_BASE_URL`
- `CHECKIN_PASS_TTL_DAYS`
- `SQUARE_CURRENCY`

## Required IAM highlights (Lambda role)
- DynamoDB read/write/query/update/txn on all project tables + indexes.
- `cognito-idp:AdminGetUser` on user pool.
- `secretsmanager:GetSecretValue` on Square secret ARN.
- `sns:Publish` for SMS sends.

## HTTP smoke/debug requests
Use files in `/http`:
- `events.http`
- `tables.http`
- `holds.http`
- `reservations.http`
- `clients.http`
- `frequent-clients.http`
- `check-in.http`
- `square-smoke.http`
- `square-webhook.http`
- `smoke-debug.http`
- `public-availability.http`

Environment variables for `.http` runs should be kept local (not committed), for example:
- `/http-client/http-client.private.env.json`

## Security notes
- Do not commit live access tokens, webhook secrets, or private keys.
- Keep Square credentials in Secrets Manager and reference by ARN.
- Keep Cognito callback/logout URLs aligned with active environment.
- Rotate any token accidentally saved in local HTTP files.

## Common troubleshooting
- `401 Unauthorized` in `.http`: refresh access token.
- `403 Admin/Staff privileges required` for every authenticated user: the Pre Token Generation Lambda (`ff-reservations-pretoken`) is broken or unwired. The staff app shows a red `AuthHealthBanner` from `GET /admin/whoami` when this happens. See `backend/cognito-pre-token-gen/README.md`.
- `redirect_mismatch`: callback URL mismatch in Cognito app client settings.
- CORS issues on mobile/ngrok: add origin to the allowlist in `backend/lambda/index.mjs` *and* API Gateway CORS.
- Square webhook not updating reservation: verify webhook signature key, route, and Lambda logs.
- SMS not delivered: query CloudWatch log group `sns/us-east-1/908027422124/DirectPublishToPhoneNumber` (success) or `.../Failure` (failure) for the recipient phone — these were enabled at 100% sample rate.
- Cron sweep status: `aws logs filter-log-events --log-group-name /aws/lambda/ff-reservations-api --filter-pattern "scheduled_maintenance" --region us-east-1`.
- Lambda DLQ has messages (`ff-res-lambda-dlq-depth` alarm fired): `aws sqs receive-message --queue-url https://sqs.us-east-1.amazonaws.com/908027422124/ff-reservations-api-dlq --max-number-of-messages 10 --region us-east-1` to inspect the failed async invocation payloads. Investigate before redriving — the same code path is still scheduled to run.
- `429 Too Many Requests` from API Gateway: stage throttle is 200 burst / 100 RPS by default. Bump in `aws apigatewayv2 update-stage --api-id oxk1adhl3a --stage-name '$default' --default-route-settings ...` if a real workload outgrows it.
- Reservation history rows missing in audit log: `ff-res-history-write-errors-5m` alarm + filter-log-events on `"reservation_history_write_error"` will surface the cause (IAM, throttling, schema).
- Card on Stand handoff says "the web callback url does not match the one in your application settings": (1) confirm the URL registered at Square Developer Console → Point of Sale API → Web callback URLs is **byte-identical** to `SQUARE_STAND_CALLBACK_URL` (default `https://famosofuego.com/square-stand-callback`), and (2) **force-quit Square POS on the Stand iPad and reopen** — it caches the registered URL list at launch. After saving in the console, the iPad keeps rejecting against the OLD list until the app restarts.
- Card on Stand handoff prompts "Enter order name" before the tender screen: Square POS → More (☰) → Settings → Checkout → Order Tickets → set to **No ticket name**. The POS API has no flag to skip this — it has to be off seller-side.
- Card on Stand recording rejects with `amount cannot exceed remaining balance`: tipping is on in Square POS, customer added a tip, and the captured amount exceeds the deposit cap. Disable tipping in Square POS settings (`Settings → Checkout → Tips`). Card-present tips for the venue are not modeled in the reservation cap today.

## Build and test
```bash
npm run build                            # prod build
npm run test                             # frontend Vitest (Angular components)
npm run test:backend                     # backend node:test (pure-fn specs in backend/lambda/lib/*.test.mjs)
npm run test:all                         # both, in sequence
npx tsc -p tsconfig.app.json --noEmit    # typecheck
```

`npm run test:backend` uses Node 22's built-in `node:test` runner — no extra runner dep. `@aws-sdk/lib-dynamodb` is a devDep at the repo root so test files can resolve modules that import it; the production Lambda doesn't bundle it because the AWS Lambda nodejs22.x runtime ships `@aws-sdk/*` v3 modules.

## Notes for contributors
- Keep commits scoped (frontend UX vs backend behavior vs infra).
- Avoid mixing unrelated refactors in functional bugfix commits.
- For UI changes, verify both mobile and desktop behavior.
