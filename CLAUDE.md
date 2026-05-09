# FF Reservations — Project Context

Restaurant table reservation system for Famoso Fuego. Staff create reservations on behalf of customers; customers pay via Square / Cash App link and self-check-in via QR codes. Admin manages frequent clients, events, settings, and financials.

## Stack

- **Web app:** Vite + React 19 + TypeScript + Tailwind 3 + shadcn/ui + react-router-dom + react-oidc-context + react-hook-form + Zod + @tanstack/react-query + react-i18next (EN + ES)
- **Mobile app (customer-facing, v1):** Expo + React Native + expo-router + NativeWind + react-native-reusables + expo-auth-session (phone OTP custom challenge) + expo-secure-store + react-i18next
- **Mobile app (staff, v2):** deferred until customer app is stable
- **Backend:** AWS Lambda (Node 22 ESM `.mjs`), API Gateway HTTP API, DynamoDB, Cognito Hosted UI (staff) + Custom Auth phone OTP (customers), Square API + webhook + In-App Payments SDK, SNS SMS, Secrets Manager
- **Hosting:** Amplify for the web SPA; EAS Build for mobile; custom domain `api.famosofuego.com` for the API

## Repo layout

```
apps/
  web/                            # Vite + React staff/admin app (replaces former Angular SPA)
    src/
      lib/{api-client,config,utils}.ts
      i18n/{index,locales/{en,es}.json}
      App.tsx, main.tsx
    public/{favicon.ico, assets/, maps/}
  mobile/                         # Expo + RN customer app
    app/                          # expo-router file-based routes
    src/{i18n,styles}
packages/
  core/                           # shared types + phone normalization
    src/{phone.ts, models/{reservation,event,table,client,frequent-client}.ts}
  config/                         # FfRuntimeConfig type + assertConfig + buildCognitoLogoutUrl
backend/lambda/
  index.mjs                       # entry, auth helpers, CORS, router, EventBridge dispatch
  lib/routes-*.mjs                # route handlers per domain
  lib/services-*.mjs              # business logic per domain
  lib/core-utils.mjs              # phone normalization (server-side mirror of @ff/core), json/error helpers
  table-template.json             # static venue floor plan
  deploy.sh                       # `aws lambda update-function-code` wrapper
backend/cognito-pre-token-gen/    # Cognito Pre Token Gen v2 trigger — injects cognito:groups into access tokens
backend/cognito-customer-auth/    # Cognito custom-auth (PreSignUp / Define / Create / Verify) for the customer App Client phone-OTP flow
http/*.http                       # smoke tests for IDE HTTP runner
pnpm-workspace.yaml               # apps/* and packages/* are workspace members
tsconfig.base.json                # shared TS compiler options; each package extends
```

Backend (`backend/`) is NOT a workspace member — it has no package.json and is deployed independently via `deploy.sh`. Stays at the repo root.

## Commands

```bash
pnpm install                              # install all workspace deps (run once)
pnpm dev                                  # web app (Vite) on http://localhost:4200
pnpm dev:mobile                           # Expo dev server for mobile
pnpm typecheck                            # tsc --noEmit across all workspaces
pnpm build                                # build packages then web app
pnpm test                                 # vitest across all workspaces
bash backend/lambda/deploy.sh             # deploy lambda (uses default AWS profile)
```

Run `npx shadcn@latest add button` (etc.) inside `apps/web/` to add shadcn components — `components.json` is preconfigured.

## Auth model — read this before touching auth

**Two parallel authentication tiers on the same Cognito User Pool, distinguished by App Client:**

- **Staff / admin** (web app):
  - Cognito Hosted UI + code flow + PKCE via `react-oidc-context` (built on `oidc-client-ts`).
  - Web sends the **access token** via `Authorization: Bearer` header (configured in `apps/web/src/lib/api-client.ts`).
  - Cognito groups: `Admin`, `Staff`. Users without a group fall through to `/unauthorized`.

- **Customers** (backend ready Phase 3 / mobile consumes Phase 6):
  - Phone OTP via Cognito CUSTOM_AUTH. The backend mediates so mobile only ever sends/receives plain phone + OTP: `POST /auth/customer/start { phoneE164, name? }` returns `{ session }`; `POST /auth/customer/verify { phoneE164, otp, session }` returns `{ accessToken, idToken, refreshToken, expiresIn }`. SMS delivered through existing SNS infrastructure (custom-auth Lambda is `ff-reservations-customer-auth`, source under `backend/cognito-customer-auth/`).
  - Customer App Client `21n3rd1sp4o9ka4l7tld45f0ka` uses `ALLOW_CUSTOM_AUTH`; tokens minted contain no `cognito:groups`.
  - **Pool quirk**: `UsernameAttributes: ["email"]` is locked at pool creation, so customers are signed up with a deterministic synthetic email `customer-{e164-no-plus}@customer.famosofuego.local`. The synthetic email is a backend implementation detail — never exposed to mobile or surfaced via `/me/profile`. Mobile that bypasses the mediator routes and computes the synthetic email itself MUST use the exact same formula or it'll create duplicate accounts.
  - Refresh tokens stored in `expo-secure-store` (Keychain on iOS, Keystore on Android) — never `AsyncStorage`.

**Shared backend invariants:**

- API Gateway HTTP API has a JWT authorizer attached **per route**, with the audience matching the route's intended caller. Staff/admin routes use authorizer `5ea6tk` (audience = staff App Client). Customer `/me/*` routes use authorizer `lngm05` (audience = customer App Client). Public routes (no authorizer): `/public/availability`, `/check-in/pass`, `/cashapp/session*`, `/webhooks/square`, `/pay`, `/auth/customer/start`, `/auth/customer/verify`.
- Lambda re-checks `requireAdmin(event)` / `requireStaffOrAdmin(event)` for staff/admin routes and `requireCustomerOwnership(event, recordOwnerSub)` for `/me/*` routes. Defense-in-depth — do not rely on API Gateway alone.
- Cognito access tokens do NOT include `cognito:groups` by default. **A Pre Token Generation v2 Lambda trigger injects groups into the access token** for staff/admin users. Trigger source lives in `backend/cognito-pre-token-gen/`. If it's disabled or fails, every authenticated staff request silently 403s with "Admin/Staff required" — staff will see a red "Auth misconfigured" banner from `AuthHealthBanner` (driven by `GET /admin/whoami`).
- Customers get tokens with no `cognito:groups`; their authorization is by `cognito:sub` ownership match against the record being read/modified.

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
- `ff-reservations` (RES_TABLE — reservations and history). GSI `byCustomerSub`: `(customerCognitoSub HASH, eventDate RANGE)`, projection ALL — sparse, only items with `customerCognitoSub` set appear (i.e. Phase-3+ customer-driven reservations). Used by `/me/reservations`. Legacy reservations and history (`HIST#`) rows never appear in this index.
- `ff-frequent-clients`
- `ff-clients` (CRM + reschedule credits). On first `/me/profile` touch with a matching phone, `cognitoSub` + `cognitoSubAttachedAt` are written. On `DELETE /me`, `deletedAt` + `deletedSub` are written and `cognitoSub` cleared (soft-delete; rows are never hard-removed so reservation totals stay reconstructible).
- `ff-checkin-passes`
- `ff-settings` (single `(APP, CONFIG)` record)

## Lambda env vars

Tables: `EVENTS_TABLE`, `HOLDS_TABLE`, `RES_TABLE`, `FREQUENT_CLIENTS_TABLE`, `CLIENTS_TABLE`, `CHECKIN_PASSES_TABLE`, `SETTINGS_TABLE`
Cognito: `USER_POOL_ID`, `CUSTOMER_CLIENT_ID` (gates the `/auth/customer/{start,verify}` route handlers — they no-op if unset)
Square: `SQUARE_SECRET_ARN`, `SQUARE_ENV`, `SQUARE_LOCATION_ID`, `SQUARE_API_VERSION`, `SQUARE_WEBHOOK_NOTIFICATION_URL`, `SQUARE_CURRENCY`, `SQUARE_CHECKOUT_REDIRECT_URL`, `SQUARE_LINK_ENABLE_*`
SMS: `SMS_ENABLED`, `SMS_SENDER_ID`, `SMS_TYPE`, `SMS_MAX_PRICE_USD`
Payment links: `PAYMENT_LINK_TTL_MINUTES`, `FREQUENT_PAYMENT_LINK_TTL_MINUTES`, `AUTO_SEND_SQUARE_LINK_SMS`, `CASH_APP_LINK_BASE_URL`
Check-in: `CHECKIN_PASS_BASE_URL`, `CHECKIN_PASS_TTL_DAYS`
Operating: `OPERATING_TZ`, `OPERATING_DAY_CUTOFF_HOUR`, `HOLD_TTL_SECONDS`, plus polling defaults

Settings stored in `ff-settings` override env at runtime; some keys (Square IDs, `squareEnvMode`) are env-managed only.

## Frontend config

Web app reads runtime config from Vite env (`apps/web/.env.local`, prefix `VITE_`):

- `VITE_API_BASE_URL` (default `https://api.famosofuego.com`)
- `VITE_COGNITO_AUTHORITY`, `VITE_COGNITO_HOSTED_UI_DOMAIN`, `VITE_COGNITO_STAFF_CLIENT_ID`, `VITE_COGNITO_CUSTOMER_CLIENT_ID`
- `VITE_COGNITO_SCOPE` (default `openid email profile`), `VITE_COGNITO_REDIRECT_PATH` (`/auth/callback`), `VITE_COGNITO_POST_LOGOUT_PATH` (`/login`)

Defaults match production values, so `pnpm dev` works without an `.env.local`. Override per environment via Amplify console env vars at build time.

Mobile app reads from Expo `app.json` extras + `expo-constants` at runtime (Phase 6 wiring).

## Conventions

- All money in app code is **dollars** (number, 2 decimals). Square API expects minor units — conversion lives in `services-square-payments.mjs:35-41`.
- Phone numbers stored E.164 (`+1...` or `+52...`). Search uses candidate fan-out (`buildPhoneSearchCandidates`).
- Times: epoch seconds for `expiresAt`/`issuedAt`/etc.; deadlines as `YYYY-MM-DDTHH:mm:ss` local-iso plus an IANA tz string (`paymentDeadlineAt`, `paymentDeadlineTz`). Default tz `America/Chicago`.
- Errors raised via `httpError(status, message)` from `core-utils.mjs`; the router's outer `try/catch` formats the response.
- Reservation `paymentStatus`: `PENDING | PARTIAL | PAID | COURTESY | REFUNDED`. `paymentMethod`: `cash | square | cashapp | credit`.
- Reservation `status`: `CONFIRMED | CANCELLED`. Lock `lockType`: `HOLD | RESERVED`.
- Cancellation `resolutionType`: `CANCEL_NO_REFUND | RESCHEDULE_CREDIT | REFUND`. REFUND iterates `payments[]`, refunds each Square/Cash App entry via `POST /v2/refunds`, then sets `paymentStatus=REFUNDED`. Partial failure throws 502 without cancelling (operator must reconcile).

## Known gotchas

- `backend/lambda/function.zip` is the built artifact; do not hand-edit and never commit.
- `backend/lambda/code_url.txt` may contain a presigned S3 URL from a previous deploy — never commit.
- API Gateway routes are explicit (no `$default` proxy). Adding a backend route requires both: (a) implementing the handler in `lib/routes-*.mjs`, (b) `aws apigatewayv2 create-route` with the right authorizer (or `--authorization-type NONE` for public routes).
- Phone normalization is duplicated: server-side in `backend/lambda/lib/core-utils.mjs` and client-side in `packages/core/src/phone.ts`. Keep them behaviorally identical — a divergence will silently corrupt CRM merges.
- React 19 Strict Mode double-mounts effects in dev. Anything that loads external scripts (Square SDK), opens cameras, or registers global listeners must be idempotent on remount.
- `react-oidc-context` redirects to `/auth/callback` after Hosted UI; the route handler reads ID token claims and routes to `/staff/dashboard` or `/unauthorized`. API calls send the **access token**; ID-token-vs-access-token claim drift will manifest as inconsistent group checks. Pre Token Generation v2 keeps both in sync.
- The customer mobile app stores refresh tokens in `expo-secure-store`, NOT `AsyncStorage`. Never relax this — it's the difference between "tokens in plaintext on disk" and "tokens in iOS Keychain / Android Keystore."
- shadcn components are added per-app via `npx shadcn@latest add <component>` inside `apps/web/`. Do not commit unedited shadcn defaults to `apps/web/src/components/ui/` — they're meant to be customized as needed.
- Tests use Vitest at every workspace package (root `pnpm test` runs all). React component tests use `@testing-library/react` + `jsdom`; mock the auth context via a custom `<TestAuthProvider>` rather than the real `react-oidc-context`.

## Wiring outside this repo

**Already in place (confirmed by audit 2026-05-08):**

- Cognito Pre Token Generation v2 Lambda `ff-reservations-pretoken` is deployed and wired (`UserPool.LambdaConfig.PreTokenGenerationConfig.LambdaVersion = V2_0`). The source in `backend/cognito-pre-token-gen/` is a versioned baseline; the live function predates this repo.
- EventBridge `ff-reservations-overdue-release` rule fires `rate(1 minute)` → invokes the lambda → `runScheduledMaintenance` → `releaseOverdueReservationsForAllActiveEvents`.
- Two API Gateway JWT authorizers: `5ea6tk` (staff/admin, audience = staff App Client `1kdkvis45qo915plp7lvj03u16`) on staff/admin routes; `lngm05` (customer, audience = customer App Client `21n3rd1sp4o9ka4l7tld45f0ka`) on `/me/*`. Customer tokens 401 against `/events` etc.; staff tokens 401 against `/me/*` — defense in depth on the audience boundary. Public routes (no authorizer): `/cashapp/session*`, `/public/availability`, `/check-in/pass`, `/webhooks/square`, `/cashapp/session/charge`, `/auth/customer/start`, `/auth/customer/verify`.
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

**Phase 3 customer auth (deployed 2026-05-08):**

- **Custom-auth Lambda** `ff-reservations-customer-auth` on role `ff-reservations-customer-auth-role` (with `sns:Publish` + basic-execution). Single Lambda routed by `event.triggerSource` for four Cognito triggers: `PreSignUp` (gates autoConfirm on `CUSTOMER_CLIENT_ID` env so staff Hosted UI signups still require email verification), `DefineAuthChallenge` (orchestrates `CUSTOM_CHALLENGE`, max 3 attempts/session), `CreateAuthChallenge` (generates 6-digit OTP, SMSes via SNS, stashes the code in `challengeMetadata` so retries don't burn a new SMS), `VerifyAuthChallengeResponse`. Source under `backend/cognito-customer-auth/`. Lambda env: `SMS_SENDER_ID`, `SMS_TYPE`, `SMS_MAX_PRICE_USD`, `CUSTOMER_CLIENT_ID`.
- **Customer App Client** `21n3rd1sp4o9ka4l7tld45f0ka` on the same user pool: `ExplicitAuthFlows = [ALLOW_CUSTOM_AUTH, ALLOW_REFRESH_TOKEN_AUTH]`, `PreventUserExistenceErrors = ENABLED`, refresh 30 days, access/id token 60 minutes, no client secret.
- **User-pool LambdaConfig** wires PreSignUp / Define / Create / Verify to the custom-auth Lambda **alongside** the existing PreTokenGen V2 trigger (which keeps the staff group claim flowing). The merge preserved both `PreTokenGeneration` (legacy field) and `PreTokenGenerationConfig` (V2_0).
- **`/auth/customer/{start,verify}`** public mediator routes (`--authorization-type NONE`) on API Gateway HTTP API `oxk1adhl3a`. `routes-customer-auth.mjs` does best-effort SignUp + InitiateAuth on `start` and RespondToAuthChallenge on `verify`. The synthetic email is computed server-side from the phone — mobile never sees it. On wrong OTP `verify` returns 401 with the new session for retry; on expired session 401 with restart message. Lambda role inline policy `customer-auth-cognito-public-api` grants `cognito-idp:SignUp / InitiateAuth / RespondToAuthChallenge` on the user pool ARN.
- **Customer-only JWT authorizer** `lngm05` (audience = customer App Client) attached to `/me/*`. Staff authorizer `5ea6tk` (audience = staff App Client) attached to staff routes. Two authorizers, hard audience boundary — customer tokens cannot reach `/events`, staff tokens cannot reach `/me/*`. Lambda layer adds `requireCustomerOwnership(event)` (defense-in-depth sub presence check) on `/me/*`.
- **`GET /me/profile`** returns `{ sub, phone, phoneVerified, name, crm }`. CRM block is best-effort: GetItem on `ff-clients` `(PK=CLIENT, SK=PHONE#{e164})`, returns `{ totalReservations, totalSpend, lastReservationAt, lastEventDate, lastTableId }` or null. First-touch merge: when an `ff-clients` record exists for the customer's phone but lacks `cognitoSub`, the route attaches it via a ConditionExpression so concurrent merges are idempotent. Synthetic email is intentionally not surfaced.
- **`GET /me/reservations`** Queries the `ff-reservations.byCustomerSub` GSI (`ScanIndexForward=false` for newest-first, Limit 100). Returns a curated subset of `ReservationItem` (table, dates, amounts, status, paymentLinkUrl, packageSnapshot, checkedInAt). `paymentLinkId / paymentLinkProvider / payments[]` and history rows are intentionally not exposed.
- **`DELETE /me`** soft-deletes the `ff-clients` record (sets `deletedAt` + `deletedSub`, clears `cognitoSub` — preserves audit history) then `AdminDeleteUser` the Cognito user. Idempotent — repeat call returns `{ deleted: true, alreadyGone: true }`. Inline policy `me-routes-cognito-admin` grants `cognito-idp:AdminDeleteUser` on the user pool. **Stale-token gotcha**: post-delete the access token still passes the JWT authorizer (signature valid until expiry) but `/me/*` calls 500 since the underlying user is gone — mobile must clear local state on DELETE success.
- **Lambda invoke permissions** are scoped per-route: `apigw-customer-start`, `apigw-customer-verify`, `apigw-me-profile`, `apigw-me-reservations`, `apigw-me-delete` (each with source-arn restricted to its specific route path).

**Still missing (Phase 3+ work):**

- AWS WAF v2 web ACL with a rate-based rule scoped to `/auth/customer/*` (limit OTP-bombing). Stage-level throttling is in place; WAF would add L7 attack signatures and per-IP rate limiting.
- AWS End User Messaging Configuration Set with event destinations (richer SMS event data than the SNS-side logs above).
- Toll-free `+18557656160` is registered but `Status: PENDING` carrier approval. Once approved, SNS will auto-pick it as origination identity (resource policy already correct). Until then, SNS uses shared shortcodes.
- SNS-side `MonthlySpendLimit` is $20; AWS End User Messaging cap is $50 (the max AWS authorized). Aligning these is a deferred audit item.
- IaC baseline (CDK/SAM/Terraform) for everything above.

## Where to look first

- Adding a new lambda route → register in `backend/lambda/lib/routes-*.mjs`, wire into `index.mjs` router, add a smoke `.http` file. **API Gateway routes are explicit — also `aws apigatewayv2 create-route` with `--target integrations/0bj43cm`. Authorizer choice depends on the route**: `--authorization-type JWT --authorizer-id 5ea6tk` for staff/admin routes, `--authorization-type JWT --authorizer-id lngm05` for customer routes (`/me/*`), `--authorization-type NONE` for public routes. **Don't forget the lambda invoke permission**: each new route needs an `aws lambda add-permission` with a `--source-arn` scoped to its specific path (the resource policy enumerates routes per-statement; a generic add-permission won't cover new routes).
- Adding a web feature → page component under `apps/web/src/features/<area>/<page>.tsx`, register in `apps/web/src/App.tsx` `<Routes>` with appropriate guard wrapper. Use shadcn components from `@/components/ui/*` (add via `npx shadcn add ...`). Translation keys go in `apps/web/src/i18n/locales/{en,es}.json`.
- Adding a mobile screen → file-based route under `apps/mobile/app/`. Use NativeWind utility classes. Translation keys go in `apps/mobile/src/i18n/locales/{en,es}.json`.
- Adding a shared model or helper → drop it in `packages/core/src/` and re-export from `packages/core/src/index.ts`. Both apps consume `@ff/core` via workspace alias.
- Touching reservation state → start with `services-reservations-holds.mjs` (the ~2400-line file). Read existing TransactWrite + ConditionExpression patterns before adding writes.
- Touching payments → `services-square-payments.mjs` for Square API calls; `routes-square-webhooks.mjs` for the webhook receiver. The mobile In-App SDK will tokenize on device and POST `source_id` to a future `POST /me/reservations` route — that endpoint isn't built yet (only `GET /me/reservations` exists today).
- Touching customer auth → start with `backend/cognito-customer-auth/` for the Cognito triggers, then `backend/lambda/lib/routes-customer-auth.mjs` for the public mediators. The synthetic-email mapping (`customer-{e164}@customer.famosofuego.local`) is computed by `syntheticEmailFromPhone` in `routes-customer-auth.mjs` — never duplicate it elsewhere; the mediator is the single source of truth.
- Touching `/me/*` → `routes-me.mjs` (handlers) + `services-me.mjs` (CRM merge / soft-delete / GSI query). `requireCustomerOwnership` lives in `index.mjs` and is the second-layer sub check after the customer authorizer.
- Auditing auth → re-read this file's "Auth model" section, then `index.mjs` for `getGroupsFromEvent` / `requireAdmin` / `requireStaffOrAdmin` / `requireCustomerOwnership`.
- "Did SMS X arrive?" → query `sns/us-east-1/908027422124/DirectPublishToPhoneNumber` (success) or `.../Failure` (failure). Logs include `messageId`, `destination`, `providerResponse`, `dwellTimeMs`, `status`.
- "Did the cron sweep run?" → `aws logs filter-log-events --log-group-name /aws/lambda/ff-reservations-api --filter-pattern "scheduled_maintenance"`.

## Implementation phases (from 2026-05-08 audit + interview)

1. **Phase 1 (DONE)**: monorepo scaffold, Angular tree deleted, `apps/web` (Vite+React+shadcn-ready), `apps/mobile` (Expo+NativeWind), `packages/core`, `packages/config`, root `pnpm-workspace.yaml`.
2. **Phase 2**: web auth shell with `react-oidc-context`, port `AuthHealthBanner`, typed `apiFetch` wrapper.
3. **Phase 3 (substantially done 2026-05-08)**: customer App Client + custom OTP Lambda + user-pool triggers + `/auth/customer/{start,verify}` mediators + `GET /me/profile` (with first-touch CRM merge by phone) + `GET /me/reservations` (sparse `byCustomerSub` GSI on `ff-reservations`) + `DELETE /me` (soft-delete CRM + AdminDeleteUser, idempotent). **Pending**: WAF v2 rate-based rule on `/auth/customer/*`.
4. **Phase 4**: backend birthday packages — `ff-packages` table, admin CRUD, public browse, reservation `packageId` + `packageSnapshot`.
5. **Phase 5**: web feature port, smallest first, `staff/reservations-new` last.
6. **Phase 6**: customer mobile app — browse → HOLD → Square In-App SDK checkout → confirm → my reservations → check-in pass → account delete.
7. **Phase 7**: TestFlight + App Store / Play Store submission for the customer app. Staff mobile is v2.
