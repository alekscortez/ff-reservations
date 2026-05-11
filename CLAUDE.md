# FF Reservations — Project Context

Restaurant table reservation system for Famoso Fuego. Staff create reservations on behalf of customers; customers pay via Square / Cash App link and self-check-in via QR codes. Admin manages frequent clients, events, settings, and financials.

> **Branch state (2026-05-09):** `main` runs the Angular 21 SPA in production. A React + Expo monorepo port of this app exists on the `react` branch (snapshot tag `react-port-snapshot-2026-05-09`) — paused mid-Phase 5 with known parity gaps documented in `.line-by-line-audit-2026-05-10.md` on that branch. Resume that work on the `react` branch; do not introduce React, pnpm, Vite, or `apps/`/`packages/` changes on `main`.

> **Companion mobile app (2026-05-10):** Customer-facing iOS/Android mobile app lives in a SEPARATE repo at `github.com/alekscortez/ff-customer-mobile` (Expo SDK 54 monorepo, EAS project `@famoso-fuego/ff-customer-mobile`). Backend `/auth/customer/*` and `/me/*` routes power it. Full booking + reschedule + payment + push notification loops verified end-to-end on real device (sandbox). Native Square In-App Payments SDK works (card sheet + Apple Pay UI render natively; Apple Pay sandbox tokens are rejected by Square sandbox, that's a Square limitation). Dev builds run via `npx expo run:ios --device` from `apps/mobile/` — no EAS Build needed for daily dev. See `~/.claude/projects/-Users-alekscortez-WebstormProjects-ff-reservations/memory/ff_customer_mobile_status.md` for the current state of that initiative.

> **Lambda Square env (2026-05-10):** `ff-reservations-api` is currently pointed at **sandbox** Square credentials (`SQUARE_ENV=sandbox`, secret `ff/square/sandbox-iUhiXH`, location `LX8EYYBKF50N9`) because the staff Angular app isn't in active production use yet and the mobile dev loop needs sandbox. Production secret + location (`ff/square/production-QaNJNJ` / `L86CASVC3TQC5`) are intact in Secrets Manager — swap back via `aws lambda update-function-configuration` when staff app launches. See `~/.claude/projects/-Users-alekscortez-WebstormProjects-ff-reservations/memory/lambda_square_env_sandbox_ok.md`. Sandbox webhook subscription `wbhk_2497e91b...` is wired to `/webhooks/square` and receives `payment.created` / `payment.updated` events.

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
  index.mjs                                # entry, auth helpers, CORS, router, EventBridge dispatch
  lib/routes-*.mjs                         # route handlers per domain
  lib/services-*.mjs                       # business logic per domain (see "reservations/holds module split" below)
  lib/core-utils.mjs                       # phone normalization, money helpers, getBody, httpError
  lib/services-rate-limit.mjs              # in-Lambda SMS rate-limit backstop (PR #3 / audit P-H1)
  lib/services-push-notifications.mjs      # Expo Push dispatcher (fire-and-forget),
                                           # reads CLIENTS_TABLE PUSHTOKEN#{sub} rows,
                                           # POSTs to https://exp.host/--/api/v2/push/send,
                                           # cleans up DeviceNotRegistered tokens
  lib/*.test.mjs                           # node:test specs (run via `npm run test:backend`)
  table-template.json                      # static venue floor plan
  deploy.sh                                # `aws lambda update-function-code` wrapper

# Reservations/holds module split (refactored 2026-05-09; was a single ~2.6k-line file)
backend/lambda/lib/
  services-reservations-shared.mjs         # constants, time/money utils, history writes,
                                           # check-in pass orchestration, read-only DDB queries,
                                           # domain predicates (isOverdueReservation, isFrequentAuto)
  services-payment-recording.mjs           # addReservationPayment + payment-link / Cash App
                                           # session state mutators (5 mutators)
  services-reservations.mjs                # reservation CRUD, cancellation (3 resolution paths),
                                           # cron overdue release, reschedule credit helpers
  services-holds.mjs                       # hold lifecycle (createHold/releaseHold/listHolds)
  services-reservations-holds.mjs          # 67-line BARREL — composes the four above and
                                           # exposes the same 16-method public surface that
                                           # index.mjs has always seen
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
npm run test -- --watch=false            # unit tests (Angular / Vitest, src/**/*.spec.ts)
npm run test:backend                     # backend pure-fn tests (node:test, backend/**/*.test.mjs)
npm run test:all                         # both, in sequence
bash backend/lambda/deploy.sh            # deploy lambda (uses default AWS profile)
```

> Backend tests use Node 22's built-in `node:test` runner (no extra runner
> dep). Several `@aws-sdk/*` clients are devDeps at the repo root
> (`lib-dynamodb`, `client-cognito-identity-provider`,
> `client-secrets-manager`, `client-sns`) so test files can resolve
> modules that import them; the production Lambda doesn't bundle them
> because the AWS Lambda nodejs22.x runtime ships @aws-sdk/* v3 modules.
> The `test:backend` glob covers `backend/lambda/lib/`,
> `backend/cognito-pre-token-gen/`, and `backend/cognito-customer-auth/`.

## Auth model — read this before touching auth

- Cognito Hosted UI + code flow + PKCE via `angular-auth-oidc-client`.
- Frontend sends the **access token** (not the ID token) via `Bearer` header (`src/app/core/http/auth.interceptor.ts`).
- API Gateway HTTP API has a JWT authorizer attached **per route**. Public routes (`/public/availability`, `/check-in/pass`, `/cashapp/session*`, `/webhooks/square`, `/pay`) do NOT have the authorizer.
- Lambda re-checks `requireAdmin(event)` / `requireStaffOrAdmin(event)` for sensitive routes (`backend/lambda/index.mjs:162-174`). Defense-in-depth — do not rely on API Gateway alone.
- Cognito access tokens do NOT include `cognito:groups` by default. **A Pre Token Generation v2 Lambda trigger injects groups into the access token.** Trigger source lives in `backend/cognito-pre-token-gen/`. If it's disabled or fails, every authenticated request silently 403s with "Admin/Staff required" — staff will see a red "Auth misconfigured" banner from `AuthHealthBanner` (driven by `GET /admin/whoami`).
- Groups: `Admin`, `Staff` (managed). Users without a group fall through to the `unauthorized` page.
- Frontend role guards live in `src/app/core/guards/` (`auth.guard.ts`, `role.guard.ts`, `admin.guard.ts`).
- **Customer auth** (mobile app, separate from staff): Cognito Custom Auth phone-OTP via `backend/cognito-customer-auth/` triggers. Public mediator routes `POST /auth/customer/start` + `POST /auth/customer/verify` (in `routes-customer-auth.mjs`) wrap the synthetic-email convention so the client only handles plain phone + OTP. Customer-only routes live under `/me/*` (in `routes-me.mjs`) and use `requireCustomerOwnership(event)` (in `index.mjs:262-269`) to extract the Cognito `sub` and re-check resource ownership. Audience is enforced separately at API Gateway via the customer authorizer.

## Concurrency / data integrity

- All DDB writes use `ConditionExpression` and `ExpressionAttributeNames`/`Values` (never string-built expressions).
- Hold → reservation upgrade is a single `TransactWriteCommand` (`services-reservations.mjs:createReservation`).
- **`POST /reservations` is idempotent on `holdId`** (audit M3): a duplicate request that loses the TransactWrite race triggers a GetItem on the hold; if it's already RESERVED with a `reservationId`, the existing reservation is returned with `idempotentReplay: true`. The route handler skips CRM upsert (which uses `ADD :amt :one` and would double-count) and auto-SMS on replay.
- **5-second grace window** on the hold-to-reservation upgrade (audit M7): `expiresAt >= :now - 5` so a "Confirm" click within ~1-2s of expiry still succeeds. Same-owner only — the `holdId` match still has to hold.
- Webhook idempotency: `addReservationPayment` deduplicates on `providerPaymentId` or `idempotencyKey` in the reservation's `payments[]`.
- Cash App "session" routes are public, gated by a 256-bit hex token (two concatenated UUIDs), compared via `crypto.timingSafeEqual`.
- Reservation history lives in `RES_TABLE` under `SK = HIST#{reservationId}#{epoch}#{eventId}`. Writes are fire-and-forget; failures emit `console.error("reservation_history_write_error", ...)` which is mapped to the `ReservationHistoryWriteFailureCount` metric (CW filter `ff-res-history-write-error`) and alarms via `ff-res-history-write-errors-5m` to the `ff-res-ops-alerts` SNS topic (audit M9 closed via observability — DLQ deferred).
- `releaseOverdueReservationsForEventDate` is owned by an EventBridge cron (audit P2-M2). The Lambda handler dispatches scheduled invocations to `runScheduledMaintenance`, which calls `releaseOverdueReservationsForAllActiveEvents`. Anonymous request paths (`/public/availability`, `/cashapp/session*`) never trigger release; staff `GET /reservations` and payment routes still do for short-window freshness.
- **`createReservation` auto-clamps past *default* `paymentDeadlineAt` (PR #42, 2026-05-10).** When the caller omits `paymentDeadlineAt` and the computed default (`event_date + 1 day at defaultPaymentDeadlineHour:Minute`) lands `<= now` — typical at 2-5 AM on the active business day's event because the operating-day cutoff hasn't rolled yet — the backend extends the deadline to `now + 4h` in the same tz instead of throwing 400. Explicit past deadlines from clients still throw (user error the staff form should surface, not silently fix). Cron sweep auto-releases unpaid reservations regardless, so the 4h extension doesn't lock tables longer than necessary. See `services-reservations.mjs:createReservation` + the `usingDefault` branch.

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
Wallet: `WALLET_PASS_TYPE_IDENTIFIER` (`pass.mx.famosofuego.customer`), `WALLET_TEAM_IDENTIFIER` (`ZG8SQTN64T`), `WALLET_PASS_SECRET_ARN` (JSON secret with `wwdr` / `signerCert` / `signerKey` / `signerKeyPassphrase` PEM strings). Optional brand overrides: `WALLET_ORGANIZATION_NAME`, `WALLET_LOGO_TEXT`, `WALLET_BACKGROUND_COLOR`, `WALLET_FOREGROUND_COLOR`, `WALLET_LABEL_COLOR`.
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
- Tests use Vitest with a shared OIDC mock at `src/app/testing/oidc-mock.ts`. **If you add a component that injects `OidcSecurityService`, use `provideMockOidc()` plus `provideRouter([])` in the spec's TestBed providers** — see `src/app/app.spec.ts` for the pattern. For tests that need to drive `isAuthenticated$` / `getIdToken()` / `getAccessToken()` per-test, provide your own `{ provide: OidcSecurityService, useValue: {...} }` instead of `provideMockOidc()` (the shared mock is hard-coded to unauthenticated). See `src/app/core/auth/auth.service.spec.ts` (drives `getIdToken` to a built JWT, stubs `revokeRefreshToken`/`logoffLocal`) for the pattern. AuthService's logout test stubs `window.location` via `Object.defineProperty(window, 'location', { configurable: true, writable: true, value: { ...originalLocation, replace: vi.fn() } })` because jsdom's `Location.replace` is non-configurable.
- Functional `CanMatchFn` guards (`src/app/core/guards/`) are tested by invoking them inside `TestBed.runInInjectionContext(() => guard(null as any, []))` with a stub `OidcSecurityService` (for `authGuard`) or stub `AuthService` (for `roleGuard`/`adminGuard`). See `src/app/core/guards/auth.guard.spec.ts` for the pattern.
- HTTP service wrappers in `src/app/core/http/*.service.ts` are tested by faking `ApiClient` (not `HttpClient`) — capture call args + return controlled `of(...)` observables, then assert on URL pattern (with `encodeURIComponent` on path params), payload contracts, and response unwrapping. See `src/app/core/http/clients.service.spec.ts` for the pattern. `ApiClient` itself is tested via `HttpTestingController` (its retry policy applies to GET only on 5xx + status 0; POST/PUT/DELETE never retry).
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
  - `ff-res-auto-refund-failed-5m` (≥1 AutoRefundFailedCount in 5min) — fires when the post-charge auto-refund safety net itself fails (Square charged, addReservationPayment rejected, refund attempt also failed → manual reconciliation needed)
  - `ff-res-refund-orphaned-5m` (≥1 RefundOrphanedCount in 5min) — fires when REFUND-resolution refunds succeeded at Square but the reservation row update lost a race (reservation may not reflect REFUNDED)
  - `ff-res-lambda-dlq-depth` (≥1 SQS msg visible in `ff-reservations-api-dlq` over 5min)
- Lambda async-invocation DLQ: SQS `ff-reservations-api-dlq` (14-day retention). Wired via `DeadLetterConfig` so EventBridge cron failures (or any other async invoke) that exhaust lambda's retry budget land here instead of being silently dropped. Inspect with `aws sqs receive-message --queue-url https://sqs.us-east-1.amazonaws.com/908027422124/ff-reservations-api-dlq --max-number-of-messages 10 --region us-east-1`.
- Log metric filters extract `PaymentLinkSmsErrorCount` and `PaymentLinkSmsSuccessCount` from `payment_link_sms_route_*` log lines into `FFReservations/SMS` namespace, `ReservationHistoryWriteFailureCount` from `reservation_history_write_error` log lines into `FFReservations/History`, and `AutoRefundFailedCount` / `RefundOrphanedCount` from `auto_refund_failed` / `refund_orphaned` log lines into `FFReservations/Payments`.
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
- Touching `reservations-new.ts` (the staff Hold & Reserve page) → it was originally ~2k lines; pure helpers were extracted into 5 sibling modules (the old monolith is now ~1,683 lines of orchestration + UI):
  - **`reservations-new-utils.ts`** — phone normalization, date/time formatters, hour/minute clamping, `normalizeSectionMapColors`. Template-bound functions (`isThisWeek`, `formatEventDate`) are re-exposed on the component as 1-line aliases.
  - **`reservations-new-active-hold.ts`** — `ActiveHoldSession` interface + `localStorage` persistence (read/write/clear) + pure lookup helpers (`findActiveHoldLock`, `extractTableIdFromHoldLock`). Lets staff resume a hold after navigation/refresh.
  - **`reservations-new-filters.ts`** — table list/map filter state: status enum + section + query, persistence in `localStorage`, pure `applyTableFilters`, label formatters.
  - **`reservations-new-credits.ts`** — reschedule-credit math: total remaining (NaN-tolerant), label formatting, applied/remaining amount math with NaN guards.
  - **`reservations-new-confirm.ts`** — `CreatedReservationContext` interface + payment-method/link-mode mappers + share-message builder + sms/wa.me phone normalizers + async `writeClipboard`. The 230-line orchestration body of `confirmReservation` stays in the component (validation preflight is interleaved with state mutations — extracting it would change visible side-effect order).
  Each sibling has co-located `*.spec.ts` (Vitest, no Angular TestBed). Total: 130 specs covering the helper modules.
- Touching reservation state → pick the right module (the old 2.6k-line monolith was split 2026-05-09):
  - **`services-reservations.mjs`** — reservation CRUD (`createReservation`, `cancelReservation`, `releaseOverdueReservations*`, list / read history) + the 3 cancellation resolution paths
  - **`services-payment-recording.mjs`** — `addReservationPayment` (the credit-redemption TransactWrite + `depositAmount` CAS for audit C3 lives here) + payment-link / Cash App session state mutators
  - **`services-holds.mjs`** — `createHold` / `releaseHold` / `listHolds` (small, ~150 lines)
  - **`services-reservations-shared.mjs`** — anything that's a pure utility, settings resolver, history-write helper, check-in-pass orchestrator, or read-only DDB query
  - **`services-reservations-holds.mjs`** — 67-line barrel; only edit if you're changing the public surface seen by `index.mjs`. Read the existing TransactWrite + ConditionExpression patterns in `services-reservations.mjs` and `services-payment-recording.mjs` before adding new writes.
- Touching payments → `services-square-payments.mjs` for Square API calls; `routes-square-webhooks.mjs` for the webhook receiver. The 6 staff/customer-facing payment routes (POST `/reservations/{id}/payment/square`, `/payment-link/square`, `/payment-link/square/sms`, `/cashapp-link/square`, `/cashapp-link/square/sms`, public `/cashapp/session/charge`) live in `routes-reservations-holds.mjs` and share the audit-C2 `autoRefundAfterRecordFailure` safety net (idempotency-keyed by Square paymentId so retries are safe). All 6 are covered in `routes-reservations-holds.test.mjs`. The customer-mobile equivalent (`POST /me/reservations/{id}/payment/square`) inlines the same safety net in `routes-me.mjs` — when extending payment behavior, audit both paths.
- Push notifications → `services-push-notifications.mjs` for the dispatcher; `addReservationPayment` (services-payment-recording.mjs) fires `sendPushToCustomer` after every payment recording when the reservation carries a `customerCognitoSub`. Logs `payment_push_dispatched` / `payment_push_skipped` per attempt — query CloudWatch with `aws logs filter-log-events --log-group-name /aws/lambda/ff-reservations-api --filter-pattern "payment_push"` to confirm dispatch. `result.sent` is Expo's ticket count (acceptance); for real APN delivery confirmation poll Expo's `/push/getReceipts` with the ticket id. Mobile registration lives in `apps/mobile/src/notifications.ts` (ff-customer-mobile repo), called from `home.tsx` on first authed render. Needs an EAS projectId in `app.json` for `getExpoPushTokenAsync()` to succeed.
- Apple Wallet `.pkpass` → `services-wallet-pass.mjs` builds an `eventTicket` pass via `passkit-generator` (bundled into the Lambda zip from `backend/lambda/node_modules` per `backend/lambda/package.json` + the updated `deploy.sh`; AWS SDK is still runtime-provided). Cert PEMs + WWDR + passphrase live in Secrets Manager (env `WALLET_PASS_SECRET_ARN`), cached after first resolve. Icons/logo PNGs are loaded at cold-start from `backend/lambda/assets/wallet-pass/` (see that dir's README for required sizes) — missing files mean `walletPassService.isEnabled()` stays false and the route returns 501 `WALLET_PASS_NOT_CONFIGURED`. The route in `routes-me.mjs` re-checks ownership + status + PAID, then either reuses the active check-in pass token or calls `checkInPassesService.issuePassForReservation` to mint one (idempotent), then hands the reservation + token to the wallet service and returns `{ filename, contentType, pkpassBase64, byteLength }`. QR payload mirrors the check-in scanner format (`ffr-checkin:{token}`).
- Customer self-service / mobile app surface → `routes-me.mjs` (single file, all `/me/*` routes). Booking flow: `POST /me/holds` (rate-limited via `services-rate-limit.checkAndIncrementCustomerHoldRateLimit` — 5 holds/5min/sub) → `POST /me/reservations` (sets `customerCognitoSub` + `actor="customer:{sub}"`) → one of three payment paths: (a) `POST /me/reservations/{id}/payment/square` — in-app Square SDK with sourceId nonce; native card sheet / Apple Pay button via `react-native-square-in-app-payments`; (b) `POST /me/reservations/{id}/payment-link/square` — Square hosted checkout URL with all methods enabled, opened in expo-web-browser; (c) `POST /me/reservations/{id}/cashapp-link/square` — Square hosted checkout URL with `acceptedPaymentMethods` restricted to `cash_app_pay` only (mobile renders a dedicated green "Pay with Cash App" button). Then `GET /me/reservations/{id}/check-in-pass`. Self-cancel at `PUT /me/reservations/{id}/cancel` enforces ≥24h-before-event and forces `RESCHEDULE_CREDIT`. **Reschedule** at `POST /me/reservations/{id}/reschedule` is a higher-level orchestrator (`rescheduleReservationForCustomer` in `services-reservations.mjs`) that atomically: (a) cancels the original with RESCHEDULE_CREDIT (mints a credit equal to `depositAmount`), (b) creates the new reservation from a hold the mobile already made, (c) auto-applies the credit via `addReservationPayment(method="credit")`. Failure modes are graceful: if step (b) fails, the customer keeps the credit (502 response includes the creditId); if step (c) fails, the new reservation simply remains PENDING and the credit stays ACTIVE for retry. Gated to `paymentStatus in {PAID, PARTIAL}` and ≥24h-before-event. Reservation rows owned by self-service customers carry `customerCognitoSub` (sparse — staff-created reservations omit it, keeping the `byCustomerSub` GSI sparse). History entries from these flows have `source="customer"` because `historySourceFromActor` recognizes the `customer:` actor prefix. **Customer payment routes must NOT pass `source: "customer"` to `addReservationPayment`** — that string isn't in the allowed enum (`manual|square-direct|square-webhook|reschedule-credit`); omit `source` and let the function auto-default to `square-direct` for non-webhook square payments (fixed in PR #45 after the bug only triggered in real-device sandbox testing; route tests stubbed `addReservationPayment` so CI missed it). The `POST /me/reservations/{id}/wallet-pass` route returns an Apple Wallet `.pkpass` as base64 — see the Wallet bullet just below for the full pipeline.
- Auditing auth → re-read this file's "Auth model" section, then `index.mjs:97-174` for `getGroupsFromEvent` / `requireAdmin` / `requireStaffOrAdmin` / `requireCustomerOwnership`.
- "Did SMS X arrive?" → query `sns/us-east-1/908027422124/DirectPublishToPhoneNumber` (success) or `.../Failure` (failure). Logs include `messageId`, `destination`, `providerResponse`, `dwellTimeMs`, `status`.
- "Did the cron sweep run?" → `aws logs filter-log-events --log-group-name /aws/lambda/ff-reservations-api --filter-pattern "scheduled_maintenance"`.
