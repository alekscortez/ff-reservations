# FF Reservations

Nightclub reservations platform with role-aware staff/admin web app, serverless API, payment links, SMS notifications, check-in passes, and public live table map.

## Stack
- Web app: Vite 8 + React 19.2 + TypeScript 5.9 + Tailwind 4 (CSS-first `@theme`, no config file) + shadcn/ui + react-oidc-context + Zod 4 + react-i18next 17 (EN+ES) (`apps/web`)
- Mobile app (customer-facing, in development): Expo SDK 55 + React Native 0.83 + expo-router + NativeWind 4 (Tailwind 3 LTS — NativeWind v5 / Tailwind 4 still pre-release) + react-native-reusables (`apps/mobile`)
- Shared library: typed models + phone normalization + design tokens (`packages/core`); runtime config helpers (`packages/config`)
- Backend: AWS Lambda Node.js 22 (ESM) (`backend/lambda` for the API; `backend/cognito-pre-token-gen` and `backend/cognito-customer-auth` for the user-pool triggers)
- API: API Gateway HTTP API (`$default` stage)
- Data: DynamoDB
- Auth: Cognito Hosted UI for staff/admin; Cognito Custom Auth phone OTP for customers (deployed — mobile consumes `/auth/customer/{start,verify}` + `/me/*`)
- Hosting: Amplify (web); EAS Build (mobile)
- Payments: Square payment links (web) + Square In-App Payments SDK (mobile, planned)
- Messaging: Amazon SNS (SMS)

## Current AWS context
- API base URL: `https://api.famosofuego.com` (custom domain mapped to API Gateway HTTP API `oxk1adhl3a`)
- Cognito user pool: `us-east-1_Upsi9Q2Tc`
- App clients: staff/admin `1kdkvis45qo915plp7lvj03u16` (Hosted UI + code/PKCE), customer `21n3rd1sp4o9ka4l7tld45f0ka` (`ALLOW_CUSTOM_AUTH`, no client secret).
- API Gateway authorizers: `5ea6tk` (staff audience) on staff/admin routes; `lngm05` (customer audience) on `/me/*`. Customer tokens 401 against staff routes; staff tokens 401 against `/me/*`.
- Amplify URL: `https://main.d1gxn3rvy5gfn4.amplifyapp.com`
- Pre Token Generation v2 Lambda `ff-reservations-pretoken` is wired on the user pool — required for `cognito:groups` to land in the access token (source under `backend/cognito-pre-token-gen/`).
- Customer custom-auth Lambda `ff-reservations-customer-auth` handles four user-pool triggers (PreSignUp / DefineAuthChallenge / CreateAuthChallenge / VerifyAuthChallengeResponse) for the customer App Client phone-OTP flow. Source under `backend/cognito-customer-auth/`.
- EventBridge rule `ff-reservations-overdue-release` fires `rate(1 minute)` and triggers `runScheduledMaintenance` in the lambda.
- Lambda async-invocation DLQ: SQS `ff-reservations-api-dlq` (14-day retention). Failed scheduled invocations land here; `ff-res-lambda-dlq-depth` alarm pages on ≥1 visible message in 5min.
- API Gateway `$default` stage throttle: 200 burst / 100 RPS (default-route, no per-route overrides). WAF v2 rate-based rule on `/auth/customer/*` is still pending.
- CloudWatch alarms publish to SNS `ff-res-ops-alerts` (subscribers: `aws@redbone.mx`, `dev@alekscortez.com`): lambda duration p95 / errors / throttles / SMS-route errors / reservation-history write failures / lambda DLQ depth.

For deeper architecture, conventions, and known gotchas see [CLAUDE.md](./CLAUDE.md).

## Core flows implemented
- Event management with one active event per date lock.
- Table hold lifecycle (short hold), reservation creation, cancellation, payment updates.
- `POST /reservations` is idempotent on `holdId` (safe to retry on network failure).
- Staff payment collection with `cash`, `square`, `cashapp`, and reschedule credit usage.
- Square payment links + webhook reconciliation.
- Cash App self-service payment via short-lived public link (256-bit token).
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
- `apps/web/` — Vite + React staff/admin web app
- `apps/mobile/` — Expo + React Native customer mobile app
- `packages/core/` — shared types, models, phone normalization, design tokens (consumed by both web `@theme` and mobile Tailwind config)
- `packages/config/` — runtime config helpers
- `backend/lambda/` — Lambda handler and service modules (deployed independently)
- `backend/cognito-pre-token-gen/` — Cognito Pre Token Generation v2 trigger (injects `cognito:groups` into access tokens)
- `backend/cognito-customer-auth/` — Cognito custom-auth Lambda for the customer App Client phone-OTP flow (4 trigger handlers in one function, routed by `event.triggerSource`)
- `http/` — HTTP client requests for smoke/debug testing
- `apps/web/public/maps/FF_Reservations_Map.normalized.svg` — live table map asset

## Local development

### Prerequisites
- Node.js 22+ (root `package.json` engines pin)
- pnpm 11+ via Corepack (`corepack enable`); root `package.json` declares `packageManager: pnpm@11.0.9`
- AWS CLI configured for deployment/testing
- Xcode + iOS Simulator (for mobile development on macOS)
- Android Studio + Android Emulator (for mobile development)

### Install
```bash
pnpm install
```

### Web (Vite)
```bash
pnpm dev
```
Runs at `http://localhost:4200`. Optionally copy `apps/web/.env.example` to `apps/web/.env.local` to override the defaults.

### Mobile (Expo)
```bash
pnpm dev:mobile
```
Press `i` for iOS simulator, `a` for Android emulator, or scan the QR with Expo Go.

### Typecheck and tests
```bash
pnpm typecheck
pnpm test
```

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
- `CUSTOMER_CLIENT_ID` (gates `/auth/customer/{start,verify}`; routes no-op if unset)
- `SQUARE_SECRET_ARN`
- `SQUARE_ENV`
- `SQUARE_LOCATION_ID`
- `SQUARE_API_VERSION`
- `SQUARE_WEBHOOK_NOTIFICATION_URL`
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
- DynamoDB read/write/query/update/txn on all project tables + indexes (including the new `ff-reservations.byCustomerSub` GSI used by `/me/reservations`).
- Cognito on user pool: `AdminGetUser` (existing) + `AdminCreateUser` / `AdminAddUserToGroup` / `AdminEnableUser` / `AdminDisableUser` / `AdminListGroupsForUser` / `AdminResetUserPassword` / `ListUsers` (existing). Phase 3 added inline policies `customer-auth-cognito-public-api` (`SignUp` / `InitiateAuth` / `RespondToAuthChallenge` for `/auth/customer/*`) and `me-routes-cognito-admin` (`AdminDeleteUser` for `DELETE /me`).
- `secretsmanager:GetSecretValue` on Square secret ARN.
- `sns:Publish` for SMS sends.

The customer custom-auth Lambda runs on its own role `ff-reservations-customer-auth-role` (basic execution + `sns:Publish`).

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
- `admin.http` (`/admin/whoami` for the staff `AuthHealthBanner`)
- `customer-auth.http` (`POST /auth/customer/{start,verify}` mediator routes — public, no auth)
- `me.http` (`GET /me/profile`, `GET /me/reservations`, `DELETE /me` — customer access token via `customerAccessToken` env var)

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

## Build and test
```bash
pnpm build       # builds packages/* then apps/web
pnpm test        # vitest across all workspaces
pnpm typecheck   # tsc --noEmit across all workspaces
```

## Notes for contributors
- Keep commits scoped (frontend UX vs backend behavior vs infra).
- Avoid mixing unrelated refactors in functional bugfix commits.
- For UI changes, verify both mobile and desktop behavior.
