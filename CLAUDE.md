# FF Reservations — Project Context

Restaurant table reservation system for Famoso Fuego. Staff create reservations on behalf of customers; customers pay via Square / Cash App link and self-check-in via QR codes. Admin manages frequent clients, events, settings, and financials.

## Stack

- **Frontend:** Angular 21 (standalone components), Tailwind, `angular-auth-oidc-client` v21, ZXing for QR scan, `qrcode` for pass rendering
- **Backend:** AWS Lambda (Node 22 ESM `.mjs`), API Gateway HTTP API, DynamoDB, Cognito Hosted UI, Square API + webhook, SNS SMS, Secrets Manager
- **Hosting:** Amplify for the SPA; custom domain `api.famosofuego.com` for the API

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
- Hold → reservation upgrade is a single `TransactWriteCommand` (`services-reservations-holds.mjs`); retries are safe.
- Webhook idempotency: `addReservationPayment` deduplicates on `providerPaymentId` or `idempotencyKey` in the reservation's `payments[]`.
- Cash App "session" routes are public, gated by a 256-bit hex token (two concatenated UUIDs), compared via `crypto.timingSafeEqual`.
- Reservation history lives in `RES_TABLE` under `SK = HIST#{reservationId}#{epoch}#{eventId}`.
- `releaseOverdueReservationsForEventDate` is owned by an EventBridge cron (Phase 2). The Lambda handler dispatches scheduled invocations to `runScheduledMaintenance`, which calls `releaseOverdueReservationsForAllActiveEvents`. Anonymous request paths (`/public/availability`, `/cashapp/session*`) never trigger release; staff dashboard's `GET /reservations` and the various payment routes still do for short-window freshness.

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
- Reservation `paymentStatus`: `PENDING | PARTIAL | PAID | COURTESY`. `paymentMethod`: `cash | square | cashapp | credit`.
- Reservation `status`: `CONFIRMED | CANCELLED`. Lock `lockType`: `HOLD | RESERVED`.

## Known gotchas

- `qrcode` triggers a CommonJS optimization warning during build — cosmetic, ignore.
- Unit tests use Vitest and currently have stale provider setup for the OIDC `StsConfigLoader` and `ActivatedRoute`. Phase 1 of the remediation is fixing this.
- `backend/lambda/function.zip` is the built artifact; do not hand-edit and never commit.
- `backend/lambda/code_url.txt` may contain a presigned S3 URL from a previous deploy — never commit.
- `app.config.ts:provideAppInitializer` calls `oidc.checkAuth()` before bootstrap; navigation happens after.
- `auth-callback.ts` decides `/staff/dashboard` vs `/unauthorized` based on `cognito:groups` from the **ID token**, while API calls use the **access token**. Keep them in sync.

## Wiring not in this repo (manual AWS console / IaC TODO)

- Cognito Pre Token Generation v2 trigger pointing at `ff-reservations-pre-token-gen`. Without it: 403 cascade. See `backend/cognito-pre-token-gen/README.md`.
- EventBridge schedule (suggested 1/min) targeting `ff-reservations-api` Lambda directly with an empty payload — the handler detects `event.source === 'aws.events'` and runs `runScheduledMaintenance`.
- API Gateway HTTP API per-route JWT authorizer attachment (defense-in-depth — Lambda also checks but should not be the only line).
- DynamoDB PITR + CloudWatch alarms (5xx, lambda errors, DDB throttles, SNS publish failures, webhook signature mismatches).
- AWS WAF v2 + stage throttling on public routes.

## Where to look first

- Adding a new lambda route → register in `backend/lambda/lib/routes-*.mjs`, wire into `index.mjs` router, add a smoke `.http` file.
- Adding a frontend feature → standalone component under `src/app/features/`, add to `src/app/app.routes.ts` with appropriate guards.
- Touching reservation state → start with `services-reservations-holds.mjs` (the 2200-line file). Read existing TransactWrite + ConditionExpression patterns before adding writes.
- Touching payments → `services-square-payments.mjs` for Square API calls; `routes-square-webhooks.mjs` for the webhook receiver.
- Auditing auth → re-read this file's "Auth model" section, then `index.mjs:97-174` for `getGroupsFromEvent` / `requireAdmin` / `requireStaffOrAdmin`.
