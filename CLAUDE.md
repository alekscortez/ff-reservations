# FF Reservations — Project Context

Restaurant table reservation system for Famoso Fuego. Staff create reservations on behalf of customers; customers pay via Square / Cash App link and self-check-in via QR codes. Admin manages frequent clients, events, settings, and financials.

> **Branch state (2026-05-09):** `main` runs the Angular 21 SPA in production. A React + Expo monorepo port of this app exists on the `react` branch (snapshot tag `react-port-snapshot-2026-05-09`) — paused mid-Phase 5 with known parity gaps documented in `.line-by-line-audit-2026-05-10.md` on that branch. Resume that work on the `react` branch; do not introduce React, pnpm, Vite, or `apps/`/`packages/` changes on `main`.

## Stack

- **Frontend:** Angular 21 (standalone components), Tailwind, `angular-auth-oidc-client` v21, ZXing for QR scan, `qrcode` for pass rendering
- **Backend:** AWS Lambda (Node 22 ESM `.mjs`), API Gateway HTTP API, DynamoDB, Cognito Hosted UI + Custom Auth phone OTP (customers), Square API + webhook, SNS SMS, Secrets Manager
- **Hosting:** Amplify for the SPA (npm + `ng build`, artifacts at `dist/ff-reservations/browser/`); custom domain `api.famosofuego.com` for the API

## Repo layout

```
src/app/
  core/         # auth, config, layout, http, guards, payments
  features/     # public/, staff/, admin/ route groups (lazy-loaded)
  shared/       # components (table-map, page-header, confirm-dialog), models
backend/lambda/
  index.mjs                       # entry, auth helpers, CORS, router, EventBridge dispatch
  lib/routes-*.mjs                # route handlers per domain
  lib/services-*.mjs              # business logic per domain
  lib/core-utils.mjs              # phone normalization, json/error helpers
  table-template.json             # static venue floor plan
  deploy.sh                       # `aws lambda update-function-code` wrapper
backend/cognito-pre-token-gen/    # separate Lambda — Cognito Pre Token Gen v2 trigger
  index.mjs                       # injects cognito:groups into access tokens
  README.md                       # one-time deploy commands
http/*.http                       # smoke tests for IDE HTTP runner
```

Note: `backend/` was historically gitignored; only `index.mjs` was tracked. Phase 1 of the audit remediation un-gitignored it. Verify `git ls-files backend/` is non-trivial before assuming code is in version control.

## Commands

```bash
CI=true npm run build                    # prod build (warns on qrcode CommonJS — known)
npx tsc -p tsconfig.app.json --noEmit    # typecheck
npm run test -- --watch=false            # unit tests (vitest)
bash backend/lambda/deploy.sh            # deploy lambda (uses default AWS profile)
```

## Auth model — read this before touching auth

- Cognito Hosted UI + code flow + PKCE via `angular-auth-oidc-client`.
- Frontend sends the **access token** (not the ID token) via `Bearer` header (`src/app/core/http/auth.interceptor.ts`).
- API Gateway HTTP API has a JWT authorizer attached **per route**. Public routes (`/public/availability`, `/check-in/pass`, `/cashapp/session*`, `/webhooks/square`, `/pay`) do NOT have the authorizer.
- Lambda re-checks `requireAdmin(event)` / `requireStaffOrAdmin(event)` for sensitive routes (`backend/lambda/index.mjs:162-174`). Defense-in-depth — do not rely on API Gateway alone.
- Cognito access tokens do NOT include `cognito:groups` by default. **A Pre Token Generation v2 Lambda trigger injects groups into the access token.** Trigger source lives in `backend/cognito-pre-token-gen/`. If it's disabled or fails, every authenticated request silently 403s with "Admin/Staff required" — staff will see a red "Auth misconfigured" banner from `AuthHealthBanner` (driven by `GET /admin/whoami`).
- Groups: `Admin`, `Staff` (managed). Users without a group fall through to the `unauthorized` page.
- Frontend role guards live in `src/app/core/guards/` (`auth.guard.ts`, `role.guard.ts`, `admin.guard.ts`).

## Concurrency / data integrity

- All DDB writes use `ConditionExpression` and `ExpressionAttributeNames`/`Values` (never string-built expressions).
- Hold → reservation upgrade is a single `TransactWriteCommand` (`services-reservations-holds.mjs`).
- **`POST /reservations` is idempotent on `holdId`** (audit M3): a duplicate request that loses the TransactWrite race triggers a GetItem on the hold; if it's already RESERVED with a `reservationId`, the existing reservation is returned with `idempotentReplay: true`. The route handler skips CRM upsert (which uses `ADD :amt :one` and would double-count) and auto-SMS on replay.
- **5-second grace window** on the hold-to-reservation upgrade (audit M7): `expiresAt >= :now - 5` so a "Confirm" click within ~1-2s of expiry still succeeds. Same-owner only — the `holdId` match still has to hold.
- Webhook idempotency: `addReservationPayment` deduplicates on `providerPaymentId` or `idempotencyKey` in the reservation's `payments[]`.
- Cash App "session" routes are public, gated by a 256-bit hex token (two concatenated UUIDs), compared via `crypto.timingSafeEqual`.
- Reservation history lives in `RES_TABLE` under `SK = HIST#{reservationId}#{epoch}#{eventId}`. Writes are fire-and-forget; failures emit `console.error("reservation_history_write_error", ...)` which is mapped to the `ReservationHistoryWriteFailureCount` metric (CW filter `ff-res-history-write-error`) and alarms via `ff-res-history-write-errors-5m` to the `ff-res-ops-alerts` SNS topic (audit M9 closed via observability — DLQ deferred).
- `releaseOverdueReservationsForEventDate` is owned by an EventBridge cron (audit P2-M2). The Lambda handler dispatches scheduled invocations to `runScheduledMaintenance`, which calls `releaseOverdueReservationsForAllActiveEvents`. Anonymous request paths (`/public/availability`, `/cashapp/session*`) never trigger release; staff `GET /reservations` and payment routes still do for short-window freshness.

## DynamoDB tables

- `ff-events` (events + per-date locks under `(EVENTDATE, DATE#YYYY-MM-DD)`)
- `ff-table-holds` (HOLDS_TABLE — both HOLD and RESERVED locks per `(EVENTDATE#YYYY-MM-DD, TABLE#{id})`)
- `ff-reservations` (RES_TABLE — reservations and history)
- `ff-frequent-clients`
- `ff-clients` (CRM + reschedule credits)
- `ff-checkin-passes`
- `ff-settings` (single `(APP, CONFIG)` record)

## Lambda env vars

Tables: `EVENTS_TABLE`, `HOLDS_TABLE`, `RES_TABLE`, `FREQUENT_CLIENTS_TABLE`, `CLIENTS_TABLE`, `CHECKIN_PASSES_TABLE`, `SETTINGS_TABLE`
Cognito: `USER_POOL_ID`
Square: `SQUARE_SECRET_ARN`, `SQUARE_ENV`, `SQUARE_LOCATION_ID`, `SQUARE_API_VERSION`, `SQUARE_WEBHOOK_NOTIFICATION_URL`, `SQUARE_CURRENCY`, `SQUARE_CHECKOUT_REDIRECT_URL`, `SQUARE_LINK_ENABLE_*`
SMS: `SMS_ENABLED`, `SMS_SENDER_ID`, `SMS_TYPE`, `SMS_MAX_PRICE_USD`
Payment links: `PAYMENT_LINK_TTL_MINUTES`, `FREQUENT_PAYMENT_LINK_TTL_MINUTES`, `AUTO_SEND_SQUARE_LINK_SMS`, `CASH_APP_LINK_BASE_URL`
Check-in: `CHECKIN_PASS_BASE_URL`, `CHECKIN_PASS_TTL_DAYS`
Operating: `OPERATING_TZ`, `OPERATING_DAY_CUTOFF_HOUR`, `HOLD_TTL_SECONDS`, plus polling defaults

Settings stored in `ff-settings` override env at runtime; some keys (Square IDs, `squareEnvMode`) are env-managed only.

## Frontend config

`src/app/core/config/app-config.ts` hardcodes:

- `apiBaseUrl: https://api.famosofuego.com`
- Cognito authority, hostedUiDomain, clientId, scope `openid email profile`

There is no per-environment config file yet.

## Conventions

- All money in app code is **dollars** (number, 2 decimals). Square API expects minor units — conversion lives in `services-square-payments.mjs:35-41`.
- Phone numbers stored E.164 (`+1...` or `+52...`). Search uses candidate fan-out (`buildPhoneSearchCandidates`).
- Times: epoch seconds for `expiresAt`/`issuedAt`/etc.; deadlines as `YYYY-MM-DDTHH:mm:ss` local-iso plus an IANA tz string (`paymentDeadlineAt`, `paymentDeadlineTz`). Default tz `America/Chicago`.
- Errors raised via `httpError(status, message)` from `core-utils.mjs`; the router's outer `try/catch` formats the response.
- Reservation `paymentStatus`: `PENDING | PARTIAL | PAID | COURTESY | REFUNDED`. `paymentMethod`: `cash | square | cashapp | credit`.
- Reservation `status`: `CONFIRMED | CANCELLED`. Lock `lockType`: `HOLD | RESERVED`.
- Cancellation `resolutionType`: `CANCEL_NO_REFUND | RESCHEDULE_CREDIT | REFUND`. REFUND iterates `payments[]`, refunds each Square/Cash App entry via `POST /v2/refunds`, then sets `paymentStatus=REFUNDED`. Partial failure throws 502 without cancelling (operator must reconcile).

## Known gotchas

- `qrcode` triggers a CommonJS optimization warning during build — cosmetic, ignore.
- Tests use Vitest with a shared OIDC mock at `src/app/testing/oidc-mock.ts`. **If you add a component that injects `OidcSecurityService`, use `provideMockOidc()` plus `provideRouter([])` in the spec's TestBed providers** — see `src/app/app.spec.ts` for the pattern.
- `backend/lambda/function.zip` is the built artifact; do not hand-edit and never commit.
- `backend/lambda/code_url.txt` may contain a presigned S3 URL from a previous deploy — never commit.
- `app.config.ts:provideAppInitializer` calls `oidc.checkAuth()` before bootstrap; navigation happens after.
- `auth-callback.ts` decides `/staff/dashboard` vs `/unauthorized` based on `cognito:groups` from the **ID token**, while API calls use the **access token**. Keep them in sync.
- API Gateway routes are explicit (no `$default` proxy). Adding a backend route requires both: (a) implementing the handler in `lib/routes-*.mjs`, (b) `aws apigatewayv2 create-route` with the right authorizer.

## Wiring outside this repo

**Already in place (confirmed by audit 2026-05-08):**

- Cognito Pre Token Generation v2 Lambda `ff-reservations-pretoken` is deployed and wired (`UserPool.LambdaConfig.PreTokenGenerationConfig.LambdaVersion = V2_0`). The source in `backend/cognito-pre-token-gen/` is a versioned baseline; the live function predates this repo.
- EventBridge `ff-reservations-overdue-release` rule fires `rate(1 minute)` → invokes the lambda → `runScheduledMaintenance` → `releaseOverdueReservationsForAllActiveEvents`.
- API Gateway JWT authorizer (`5ea6tk`) is attached to every non-public route. Public routes: `/cashapp/session*`, `/public/availability`, `/check-in/pass`, `/webhooks/square`, `/cashapp/session/charge`.
- DynamoDB PITR enabled on `ff-reservations`, `ff-table-holds`, `ff-clients`, `ff-checkin-passes` (35-day window). Other tables (`ff-events`, `ff-frequent-clients`, `ff-settings`) are deliberately not PITR-protected.
- CloudWatch alarms publish to SNS topic `ff-res-ops-alerts` (subscribers: `aws@redbone.mx`, `dev@alekscortez.com`):
  - `ff-res-lambda-duration-p95-high` (≥10s)
  - `ff-res-lambda-errors-5m` (≥1)
  - `ff-res-lambda-throttles-5m` (≥1)
  - `ff-res-sms-errors-5m` (≥3 PaymentLinkSmsErrorCount in 5min)
  - `ff-res-history-write-errors-5m` (≥1 ReservationHistoryWriteFailureCount in 5min)
  - `ff-res-lambda-dlq-depth` (≥1 SQS msg visible in `ff-reservations-api-dlq` over 5min)
- Lambda async-invocation DLQ: SQS `ff-reservations-api-dlq` (14-day retention). Wired via `DeadLetterConfig` so EventBridge cron failures (or any other async invoke) that exhaust lambda's retry budget land here instead of being silently dropped. Inspect with `aws sqs receive-message --queue-url https://sqs.us-east-1.amazonaws.com/908027422124/ff-reservations-api-dlq --max-number-of-messages 10 --region us-east-1`.
- Log metric filters extract `PaymentLinkSmsErrorCount` and `PaymentLinkSmsSuccessCount` from `payment_link_sms_route_*` log lines into `FFReservations/SMS` namespace, and `ReservationHistoryWriteFailureCount` from `reservation_history_write_error` log lines into `FFReservations/History`.
- API Gateway `$default` stage has `DetailedMetricsEnabled=true` (per-route 4xx/5xx/latency in `AWS/ApiGateway`) and default-route throttle `ThrottlingBurstLimit=200, ThrottlingRateLimit=100` (sized for ~12 RPS realistic peak with ~8x headroom — DoS / runaway-cost guardrail). No per-route overrides; if a single route ever needs a different limit, use `aws apigatewayv2 update-route` with `--route-settings`.
- SNS SMS delivery status logging enabled at 100% sample rate. Successes go to `sns/us-east-1/908027422124/DirectPublishToPhoneNumber`; failures to `sns/us-east-1/908027422124/DirectPublishToPhoneNumber/Failure`. Both 30-day retention.

**Still missing (Phase 3+ work):**

- AWS WAF v2 web ACL (managed rule sets, IP allow/deny lists). Stage-level throttling is in place; WAF would add L7 attack signatures and per-IP rate limiting.
- AWS End User Messaging Configuration Set with event destinations (richer SMS event data than the SNS-side logs above).
- Toll-free `+18557656160` is registered but `Status: PENDING` carrier approval. Once approved, SNS will auto-pick it as origination identity (resource policy already correct). Until then, SNS uses shared shortcodes.
- SNS-side `MonthlySpendLimit` is $20; AWS End User Messaging cap is $50 (the max AWS authorized). Aligning these is a deferred audit item.
- IaC baseline (CDK/SAM/Terraform) for everything above.

## Where to look first

- Adding a new lambda route → register in `backend/lambda/lib/routes-*.mjs`, wire into `index.mjs` router, add a smoke `.http` file. **API Gateway routes are explicit — also `aws apigatewayv2 create-route` with `--target integrations/0bj43cm --authorization-type JWT --authorizer-id 5ea6tk` (or NONE for public routes).**
- Adding a frontend feature → standalone component under `src/app/features/`, add to `src/app/app.routes.ts` with appropriate guards.
- Touching reservation state → start with `services-reservations-holds.mjs` (the ~2400-line file). Read existing TransactWrite + ConditionExpression patterns before adding writes.
- Touching payments → `services-square-payments.mjs` for Square API calls; `routes-square-webhooks.mjs` for the webhook receiver.
- Auditing auth → re-read this file's "Auth model" section, then `index.mjs:97-174` for `getGroupsFromEvent` / `requireAdmin` / `requireStaffOrAdmin`.
- "Did SMS X arrive?" → query `sns/us-east-1/908027422124/DirectPublishToPhoneNumber` (success) or `.../Failure` (failure). Logs include `messageId`, `destination`, `providerResponse`, `dwellTimeMs`, `status`.
- "Did the cron sweep run?" → `aws logs filter-log-events --log-group-name /aws/lambda/ff-reservations-api --filter-pattern "scheduled_maintenance"`.
