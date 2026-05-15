# FF Reservations — Project Context

Restaurant table reservation system for Famoso Fuego. Staff create reservations on behalf of customers; customers pay via Square / Cash App link and self-check-in via QR codes. Admin manages frequent clients, events, settings, and financials.

> **Branch state (2026-05-14):** `main` runs the Angular 21 SPA in prod with anonymous public-booking live behind `allowAnonymousPublicBooking`. Customers self-book on `/map` → Square checkout → `/r/{id}`; branded short URLs `https://famosofuego.com/p/{slug}` via Amplify rewrite. "Find my reservation" modal supports phone (active hold) or FF-XXXXXX code (any non-CANCELLED). Funnel telemetry FE+BE; smoke test `bash scripts/smoke_test_prod.sh`. Full arc in [[anon_public_booking_implementation_2026_05_13]] + [[public_map_audit_session_2026_05_13_evening]] + [[public_map_tier_a_b_session_2026_05_14]] + [[find_by_code_tier_s_2026_05_14]] + [[saturday_operational_runbook]]. React + Expo port paused on `react` branch (tag `react-port-snapshot-2026-05-09`); do not introduce React/pnpm/Vite/`apps/` on `main`.

> **Lambda Square env — PRODUCTION as of 2026-05-11.** Real cards/Cash App charges fire. Webhook must point at `https://api.famosofuego.com/webhooks/square` with `payment.created`+`payment.updated`. Env IDs + sandbox revert: [[lambda_square_env_production_cutover]]. Companion mobile (Expo SDK 54) lives in `github.com/alekscortez/ff-customer-mobile`, paused [[ff_customer_mobile_status]].

## Stack
**FE**: Angular 21 standalone, Tailwind 3.4, `angular-auth-oidc-client` v21, ZXing, qrcode, `@ng-icons/lucide`, Spartan primitives at `src/app/shared/ui/`. **BE**: AWS Lambda Node 22 ESM, API GW HTTP API, DynamoDB, Cognito Hosted UI + customer phone OTP, Square + webhook, SNS SMS, Secrets Manager. **Hosting**: Amplify SPA (npm + `ng build` → `dist/ff-reservations/browser/`); API at `api.famosofuego.com`; `amplify.yml` pins npm via `corepack prepare npm@11.6.2` ([[amplify_corepack_npm_pin]]).

## UI primitives — read before adding new UI

17 Spartan-style primitive families under `src/app/shared/ui/`. Each is a standalone Angular directive/component with `cva` variants + `tailwind-merge` for consumer-class overrides. **Use them instead of hand-rolling Tailwind class strings.** Read the JSDoc for full input/output contracts and composition examples.

| Primitive | Selector | When to use |
|---|---|---|
| `HlmButton` | `button[hlmBtn]`, `a[hlmBtn]` | All action buttons. `outline-current` inherits parent text color. |
| `HlmBadge` | `[hlmBadge]` | Status pills. Use `outline` variant inside colored cards. |
| `HlmInput` | `input[hlmInput]`, `select[hlmInput]`, `textarea[hlmInput]` | Form text inputs/selects/textareas. NOT checkboxes/radios. Prefer `<hlm-native-select>` for new selects. |
| `HlmNativeSelect` | `<hlm-native-select>` w/ projected `<option>`s | Native dropdown w/ Spartan chevron overlay. CVA + `[formControl]` + user-only `(change)`. |
| `HlmCheckbox` | `<hlm-checkbox>` + `[label]` | Styled checkbox w/ lucideCheck overlay. Use for "feature on/off" + "I agree" — `HlmToggle` for inline chips. |
| `HlmDialog` | `<hlm-dialog>` | All modals. `sheet` panel = slide-from-edge w/ `pb-env(safe-area-inset-*)`. Pair w/ sticky header/footer for long content. |
| `HlmConfirmDialog` | `<hlm-confirm-dialog>` | Yes/no replaces `window.confirm()`. Single-line `[message]` only — for bulleted content compose `<hlm-dialog>` directly. |
| `HlmToggle` | `button[hlmToggle]` | Toggle pills (default/outline/warning × `[active]`). Caller-managed state. |
| `HlmAlert` | `<hlm-alert>` | Inline tinted banners (info/success/warning/destructive); `role="alert"` baked in. |
| `HlmAvatar` | `<hlm-avatar>` + `[hlmAvatarImage]` + `[hlmAvatarFallback]` | Photo tile + initials fallback; image auto-hides until `load`. |
| `HlmSidebar` (compound) | `<hlm-sidebar>` + slots + `[hlmSidebarWrapper]` / `Inset` / `Trigger` | Staff/admin shell only. Feature routes render inside the inset. See [[sidebar_shell_spartan_pattern]]. |
| `HlmPagination` (compound) | `<hlm-numbered-pagination>` | Long client-side lists. Two-way `[(currentPage)]` + `[(itemsPerPage)]`. See [[client_side_pagination_pattern]]. |
| `HlmTable` (compound) | `<table hlmTable>` + Th/Tr/Td + `<hlm-table-sort-header>` | Sort/filter/pagination lists. Pair w/ `@tanstack/angular-table`. See [[data_tables_spartan_pattern]]. |
| `HlmDropdownMenu` (compound) | `[hlmMenuTriggerFor]` + `[hlmMenu]` in `<ng-template>` + `[hlmMenuItem]` | Row actions, context menus. Wraps `@angular/cdk/menu` (arrow nav, Esc, focus return). |
| `HlmPopover` (compound) | `<brn-popover>` + `[brnPopoverTrigger]` + `[hlmPopoverContent]` | Floating panels anchored to a trigger; `z-[210]` over HlmDialog. |
| `HlmCalendar` / `HlmDatePicker` (compound) | `<hlm-calendar>` / `<hlm-date-picker>` / `<hlm-date-range-picker>` | Always-visible month grid, or trigger-button + popover. Range supports open-ended end (set start + dismiss popover). |
| `HlmTimePicker` | `<hlm-time-picker>` | Wraps native `<input type="time">` (OS-native picker on mobile). Value is 24h `HH:MM`. When BE expects hour+minute split, bridge w/ `joinHm`/`splitHm` (see `features/admin/settings/settings.ts`). |

- **TS helpers**: state-driven styling returns variant *literals*, not class strings (e.g. `reservations.ts:paymentStatusBadgeVariant`).
- **Consumer-class merge**: extra `class`/`[class]` merge with variant defaults via tailwind-merge (consumer wins). `[ngClass]` races directive effects — prefer `[active]` inputs or `[class.foo]`.
- **Palette**: `brand` (grayscale), `warm` (orange), `success`/`danger`/`warning` (50–800). Spartan semantic colors → brand via HSL vars in `src/styles.scss`.
- **Design split (2026-05-14)**: customer surfaces will adopt warm-dark/ember/Fraunces from the mobile app; staff/admin stays light Spartan. Deferred past 2026-05-16. [[customer_dark_design_split_2026_05_14]]
- **Specs** at `src/app/shared/ui/<name>/<name>.spec.ts`. Compound-primitive deep-dives: `HlmSidebar` ([[sidebar_shell_spartan_pattern]] + [[safari_display_contents_flex_bug]]), `HlmPagination` ([[client_side_pagination_pattern]]), `HlmTable`+TanStack ([[data_tables_spartan_pattern]] + [[tanstack_proxy_onpush_reactivity]]). **DO NOT run `@spartan-ng/cli ui`** ([[spartan_cli_avoided]]).

## Repo layout

```
src/app/                            # core/ (auth/config/layout/http/guards/payments), features/ (public,staff,admin lazy), shared/ (components, ui/ primitives, models)
                                    # shared/components/reservation-detail-modal/ — 4-tab modal shared by Dashboard + staff Reservations

backend/lambda/
  index.mjs                         # entry, auth helpers, CORS, router, EventBridge dispatch
  lib/routes-*.mjs                  # route handlers per domain
  lib/services-*.mjs                # business logic per domain
  lib/core-utils.mjs                # phone, money, getBody, httpError
  lib/services-rate-limit.mjs       # in-Lambda SMS rate-limit
  lib/services-push-notifications.mjs  # Expo Push
  lib/*.test.mjs                    # node:test specs
  table-template.json / deploy.sh

# Reservations/holds split (2026-05-09):
  services-reservations-shared.mjs  # utils, history, check-in pass, read-only DDB
  services-payment-recording.mjs    # addReservationPayment + link/Cash App
  services-reservations.mjs         # CRUD, 3 cancellation paths, cron release
  services-holds.mjs                # createHold / releaseHold / listHolds
  services-reservations-holds.mjs   # barrel for index.mjs

# Anonymous public-booking (2026-05-13):
  routes-public-bookings.mjs        # /public/reservations*, /p/{slug}
  services-anon-bookings.mjs        # phone-slot + verifyCustomerToken
  services-turnstile.mjs            # Cloudflare siteverify (fail-closed)
  services-reservation-codes.mjs    # 6-char codes + 16-char slugs

backend/cognito-pre-token-gen/      # groups injection (separate Lambda)
backend/cognito-customer-auth/      # Custom Auth phone-OTP triggers
http/*.http                         # smoke tests
scripts/                            # ops helpers
```

## Commands
```bash
CI=true npm run build                    # prod build (qrcode CommonJS warning — cosmetic)
npx tsc -p tsconfig.app.json --noEmit    # typecheck
npm run test -- --watch=false            # Vitest, src/**/*.spec.ts
npm run test:backend                     # node:test, backend/**/*.test.mjs
npm run test:all                         # both
bash backend/lambda/deploy.sh            # deploy lambda
```
`@aws-sdk/*` are root devDeps (Lambda nodejs22.x ships them). Runtime-only deps (`passkit-generator`) live in `backend/lambda/package.json`, bundled by `deploy.sh`.

## Auth model — read this before touching auth

- Cognito Hosted UI + code flow + PKCE via `angular-auth-oidc-client`.
- Frontend sends the **access token** via `Bearer` header (`src/app/core/http/auth.interceptor.ts`).
- API Gateway HTTP API has a JWT authorizer per-route. Public routes (no authorizer): `/public/availability`, `/check-in/pass`, `/cashapp/session*`, `/webhooks/square`, `/pay`.
- Lambda re-checks `requireAdmin(event)` / `requireStaffOrAdmin(event)` per sensitive route (defense in depth — do not rely on API Gateway alone).
- Cognito access tokens DO NOT include `cognito:groups` by default. A **Pre Token Generation v2 Lambda trigger** (`backend/cognito-pre-token-gen/`) injects groups into the access token. If disabled/broken, every authed request silently 403s; the `AuthHealthBanner` (driven by `GET /admin/whoami`) surfaces this.
- Groups: `Admin`, `Staff`. Users without a group fall through to `/unauthorized`.
- **Staff pool `us-east-1_Upsi9Q2Tc` is locked to admin-create-only** (2026-05-13): `AdminCreateUserConfig.AllowAdminCreateUserOnly=true`. Hosted UI's "Sign Up" tab is hidden; `cognito-idp:SignUp` API is rejected for non-admins. New staff/admin users created exclusively via the "Invite User" form (`POST /admin/users` → `AdminCreateUserCommand`). Memory: `cognito_pool_locked_admin_create_only.md`. **Customer pool app client `21n3rd1sp4o9ka4l7tld45f0ka` is on a different flow (custom-auth phone-OTP) and unaffected.**
- **Customer auth** (mobile, separate from staff): Custom Auth phone-OTP via `backend/cognito-customer-auth/`. Public mediator routes `POST /auth/customer/start` + `POST /auth/customer/verify` (in `routes-customer-auth.mjs`) wrap the synthetic-email convention. Customer-only routes under `/me/*` (in `routes-me.mjs`) use `requireCustomerOwnership(event)`.
- **Token TTLs** (staff client, 2026-05-14): access/ID 24h, refresh 30d (bumped from 8h alongside `SessionWatcher` fix). **OIDC state in localStorage** via `DefaultLocalStorageService` in `app.config.ts` — library default sessionStorage silently nukes refresh on restart. See [[feedback_oidc_default_session_storage]].
- `Login` auto-redirects authed users to `/staff/dashboard`; `''` + `'home'` redirect to `/login`. `?reason=session-expired` shows HlmAlert (set by `SessionExpiry.notifyExpired()`).
- **`SessionWatcher`** (`src/app/core/auth/session-watcher.ts`) closes the backgrounded-tab logout gap: visibility/focus/pageshow refresh + 4-min heartbeat + reacts to `TokenExpired`/`SilentRenewFailed`. `refreshOnce(source)` is coalesced+debounced+shareReplay'd; `AuthInterceptor` uses it to retry once on 401. **Phase 1 (2026-05-15)**: `DirectRefreshClient` posts to Cognito `/oauth2/token` (retry on 0/5xx) using `RefreshTokenVault` (shadow `ff_oidc_rt_shadow_v1` outside library namespace); `LibraryStorageBridge` writes back; bootstrap recovery uses same chain. `ff_authed=1` flag + `authGuard` fires `SessionExpiry.notifyExpired('guard', {skipNavigation: true})`. Telemetry events + queries: [[auth_telemetry_cw_query]]. Full arc: [[auth_phase_0_1_session_2026_05_15]].
- **Embedded login (Path 3) locked in** — replaces Hosted UI with in-app `aws-amplify/auth` v6 form. 6 deploys, starts 2026-05-18 after Saturday telemetry review. Plan: [[phase_3_embedded_login_plan_2026_05_15]]; supersedes [[embedded_login_path_3_planned]].

## Concurrency / data integrity

- All DDB writes use `ConditionExpression` + `ExpressionAttributeNames`/`Values` (never string-built expressions).
- Hold → reservation upgrade is a single `TransactWriteCommand`. **Multi-table bookings** grow to N hold-upgrade Updates + 1 reservation Put (capped at `MAX_TABLES_PER_RESERVATION = 10` — well under DDB's 100-item TransactWrite limit). Either all N+1 land or none do.
- **`POST /reservations` is idempotent on `holdId`** (audit M3): duplicate request that loses the TransactWrite race triggers a GetItem on the hold; if RESERVED, returns the existing reservation with `idempotentReplay: true`. Route handler skips CRM upsert + auto-SMS on replay.
- **5-second grace window** on hold-to-reservation upgrade: `expiresAt >= :now - 5` so "Confirm" within ~1-2s of expiry still succeeds (same-owner only).
- Webhook idempotency: `addReservationPayment` deduplicates on `providerPaymentId` / `idempotencyKey`.
- Cash App "session" routes are public, gated by a 256-bit hex token compared via `crypto.timingSafeEqual`.
- Reservation history lives in `RES_TABLE` under `SK = HIST#…`. Writes are fire-and-forget; failures emit `reservation_history_write_error` (CW metric filter + alarm at ≥1/5min).
- Cron-based overdue release owned by EventBridge `ff-reservations-overdue-release` (rate 1 min) → dispatches to `runScheduledMaintenance`. Anonymous request paths never trigger release; staff `GET /reservations` and payment routes still do.
- **`createReservation` auto-clamps past *default* `paymentDeadlineAt`**: omitted default that lands <= now is extended to `now + 4h` (typical at 2-5 AM on the active business day before the operating cutoff rolls). Explicit past deadlines still throw 400.

## DynamoDB tables

- `ff-events` (events + per-date locks under `(EVENTDATE, DATE#YYYY-MM-DD)`)
- `ff-table-holds` (HOLDS_TABLE — HOLD and RESERVED locks per `(EVENTDATE#YYYY-MM-DD, TABLE#{id})`). Also carries `(PK="RATE", SK="SMS#…" | "CUSTHOLD#…" | "ANONHOLD#{phoneKey}")` rows for in-Lambda rate limiting + the "1 active unpaid hold per phone" registry on the anon-booking flow (services-anon-bookings.mjs).
- `ff-reservations` (RES_TABLE — reservations + history). Three additional partitions ride in this same table:
  - `(PK="EVENTDATE#YYYY-MM-DD", SK="RES#{uuid}")` — the reservation row itself
  - `(PK="EVENTDATE#YYYY-MM-DD", SK="HIST#…")` — append-only history events
  - `(PK="CODE", SK="CODE#XXXXXX")` — 6-char confirmation-code → `{reservationId, eventDate}` lookup (anon flow)
  - `(PK="SLUG", SK="SLUG#xxxxxxxxxxxxxxxx")` — 16-char short-URL slug → `{reservationId, eventDate, customerToken}` lookup (anon flow)
- `ff-frequent-clients`
- `ff-clients` (CRM + reschedule credits)
- `ff-checkin-passes`
- `ff-settings` (single `(APP, CONFIG)` record; overrides env at runtime; some keys env-managed only)

## Lambda env vars
Tables: `EVENTS_TABLE`,`HOLDS_TABLE`,`RES_TABLE`,`FREQUENT_CLIENTS_TABLE`,`CLIENTS_TABLE`,`CHECKIN_PASSES_TABLE`,`SETTINGS_TABLE`. Cognito: `USER_POOL_ID`. Square: `SQUARE_SECRET_ARN`,`SQUARE_ENV`,`SQUARE_LOCATION_ID`,`SQUARE_API_VERSION`,`SQUARE_WEBHOOK_NOTIFICATION_URL`,`SQUARE_CURRENCY`,`SQUARE_CHECKOUT_REDIRECT_URL`,`SQUARE_LINK_ENABLE_*`. SMS: `SMS_ENABLED`,`SMS_SENDER_ID`,`SMS_TYPE`,`SMS_MAX_PRICE_USD`. Links: `PAYMENT_LINK_TTL_MINUTES`,`FREQUENT_PAYMENT_LINK_TTL_MINUTES`,`AUTO_SEND_SQUARE_LINK_SMS`,`CASH_APP_LINK_BASE_URL`. Check-in: `CHECKIN_PASS_BASE_URL`,`CHECKIN_PASS_TTL_DAYS`. Wallet: `WALLET_PASS_TYPE_IDENTIFIER`,`WALLET_TEAM_IDENTIFIER`,`WALLET_PASS_SECRET_ARN`. Operating: `OPERATING_TZ`,`OPERATING_DAY_CUTOFF_HOUR`,`HOLD_TTL_SECONDS`. Anon: `TURNSTILE_SECRET_ARN`, `PUBLIC_BOOKING_RETURN_BASE_URL`, `PUBLIC_BOOKING_SHORT_URL_BASE` (`https://famosofuego.com` in prod via Amplify rewrite; defaults safely to API host).

## Conventions
Frontend config: `src/app/core/config/app-config.ts` hardcodes `apiBaseUrl: https://api.famosofuego.com` + Cognito authority/hostedUiDomain/clientId/scope (no per-env yet).


- **Money is dollars** (2 decimals); Square API expects minor units (conversion in `services-square-payments.mjs`).
- **Phones stored E.164**. Search via `buildPhoneSearchCandidates`; <4 digits returns empty.
- **CRM dedup is phone-only** (PK=`PHONE#{key}`); same person via two phones = two rows on purpose. [[feedback_crm_dedup_phone_only]]
- **Times**: epoch seconds for `expiresAt`/`issuedAt`; deadlines `YYYY-MM-DDTHH:mm:ss` + IANA tz. Default `America/Chicago`.
- **Venue takes forward bookings** — admin date-range filters MUST NOT cap upper bound at "today" by default. [[financials_reducer_invariants]]
- **Errors**: raise via `httpError(status, message)` from `core-utils.mjs`.
- **Reservation enums**: `paymentStatus` ∈ {PENDING,PARTIAL,PAID,COURTESY,REFUNDED}; `paymentMethod` ∈ {cash,square,cashapp,credit}; `status` ∈ {CONFIRMED,CANCELLED}; `lockType` ∈ {HOLD,RESERVED}; `resolutionType` ∈ {CANCEL_NO_REFUND,RESCHEDULE_CREDIT,REFUND}. REFUND iterates `payments[]` via Square then sets `paymentStatus=REFUNDED`; partial failure throws 502 without cancelling.
- **Multi-table bookings**: row carries `tableIds[]` + `tablePrices[]` plus legacy scalar `tableId`/`tablePrice` (= first / sum). One reservation = one deposit / Square link / SMS / pass listing every table. Cap 10/booking (4 for anon-public). **Every reader prefers `tableIds[]` then falls back to `[tableId]`; every writer stamps both.** Helpers: `getReservationTableIds`/`normalizeIdList`/`formatTablesLabel` (BE) + `TableLabelPipe`/`formatTableLabel{,Lower}` (FE) — only places that branch on length. Mobile customer flow single-table in v1.
- **Customer-facing IDs are short**, internal full. Anon bookings mint 6-char `confirmationCode` (FF-K7M3X2) + 16-char `publicSlug` for `/p/{slug}`; UUID + 64-char customerToken stay internal. Receipts/SMS/share links use short forms; check-in pass URL is `${PUBLIC_BOOKING_SHORT_URL_BASE}/p/{slug}?to=pass` (legacy `/check-in/pass?token=` still works). Generators in `services-reservation-codes.mjs` (alphabet excludes 0/O/1/I/L). See [[anon_public_booking_implementation_2026_05_13]].
- **Signals + OnPush everywhere.** All 16 feature components on OnPush. Bare signals for new code; signal-backed accessors only in reservations-new. Record/Set mutate copy-on-write via `.update`. See [[signals_onpush_migration_status_2026_05_13]].
- **SMS templates prefix `Famoso Fuego: `** via `BRAND_PREFIX` in `services-sms-notifications-pure.mjs` (carrier-required, [[sms_brand_prefix_session_2026_05_14]]). Customer OTP path inlines the brand. Changing prefix requires updating registered Message Samples in EUM.
- **`.sr-only` = Tailwind 3 built-in.** Don't roll a custom screen-reader-only class.
- **Empty-state rows on filtered lists get `aria-live="polite"`** so AT users hear the count change after a filter mutation.

## Known gotchas

- `qrcode` CommonJS warning at build — cosmetic.
- Tests use Vitest + shared OIDC mock at `src/app/testing/oidc-mock.ts`. Use `provideMockOidc()` + `provideRouter([])`; per-test stubs for `isAuthenticated$`/`getIdToken()`. AuthService logout stubs `window.location` via `Object.defineProperty` (jsdom's `Location.replace` non-configurable).
- `CanMatchFn` guards: `TestBed.runInInjectionContext(() => guard(null as any, []))`. HTTP wrappers fake `ApiClient`, not `HttpClient`. `ApiClient` retries GET 5xx + status 0 only.
- Never commit `backend/lambda/function.zip` or `backend/lambda/code_url.txt`.
- `auth-callback.ts` reads groups from **ID token**; API uses **access token**. Keep in sync.
- API GW routes are explicit (no `$default`). New route = 3 steps: (1) handler in `lib/routes-*.mjs`, (2) `apigatewayv2 create-route` (authorizer `5ea6tk` or NONE), (3) `lambda add-permission` with matching source-arn. **Skip (3) → 500 with no Lambda logs.**
- **`*ngFor` template method calls** re-invoke every CD cycle; iOS Chrome drops touchend. Memoize + `trackBy`. [[feedback_ngfor_no_template_methods]]
- **Lines starting with `=` in `.html`** = corrupted attribute (usually `[active]` stripped to `""`). Silent dead toggle. Grep before shipping HlmToggle pages. [[feedback_stripped_active_bindings]]
- **`@angular/cdk` pinned `21.1.6`** — do NOT bump alone (breaks AOT). [[cdk_21_1_pin_for_dialog_eager_strategy]]
- **`createReservation` accepts caller-supplied `payload.reservationId`** — anon-public pre-mints UUID/customerToken/code/slug so Square `payment_note` lookup matches at webhook time. [[incident_2026_05_13_day_paid_but_cancelled]]
- **Square `payment_note` copy** is customer-facing — use `Booking #FF-<code> • <date>`. Webhook accepts old+new formats.
- **`cancelReservation(eventDate, reservationId, tableId, user, reason, options)` is POSITIONAL.** Object-arg silently 400s. `tableId` can be null (derives from `reservation.tableIds`).
- **`/p/{slug}` Amplify rewrite** (status 200) routes `famosofuego.com/p/*` → `api.famosofuego.com/p/*`. `/p/<*>` MUST precede the `/<*>` SPA fallback in customRules. Legacy api-host URLs still work.
- **`tsc --noEmit` skips Angular template typecheck.** Always `CI=true npm run build` before push. Bare-boolean attrs (`<x destructive>`) pass tsc, fail AOT — use `[destructive]="true"`. [[feedback_tsc_misses_template_typecheck]]
- **`takeUntilDestroyed()` no-arg requires injection context.** In event handlers, inject `DestroyRef` at construction and pass explicitly: `.pipe(takeUntilDestroyed(this.destroyRef))`.
- **`computed()` doesn't track legacy `@Input` reads** — only signals. Migrate to `input()` or use a method. Hit on `<reserve-table-modal>` (stale totalAmount).
- **Cognito `logout_uri` requires string-exact LogoutURLs match.** Build via `buildRedirectUrl(APP_CONFIG.cognito.postLogoutPath)`. [[cognito_logout_uri_gotcha]]
- **`angular-auth-oidc-client` wipes refresh token on ANY internal failure** (`resetAuthorizationData`). Then renew throws synchronously — no retry path. Phase 1's `RefreshTokenVault` shadows it. Never call `forceRefreshSession()` directly — use `SessionWatcher.refreshOnce()`. [[phase_1_auth_resilience_plan_2026_05_15]]
- **US SMS silently drops while TFN PENDING; MX works.** Self-resolves on ACTIVE. Don't pin OriginationIdentity for `+52`. [[sms_us_blocked_mx_works_root_cause]]
- **SMS: SNS today, EUM planned post-TFN ACTIVE.** Don't touch during re-review. [[sms_migrate_to_eum_after_approval]]

## Wiring outside this repo

**In place:** Cognito Pre Token Gen v2 (`ff-reservations-pretoken`); EventBridge `ff-reservations-overdue-release` (1 min → `runScheduledMaintenance`); API GW JWT authorizer `5ea6tk`; DDB PITR (35d) on reservations/holds/clients/checkin-passes; CloudWatch `ff-res-*` alarms → SNS `ff-res-ops-alerts`; dashboard `ff-saturday-funnel` (JSON in `scripts/cloudwatch-dashboards/`); SQS DLQ `ff-reservations-api-dlq` (14d); log-metric filters in `FFReservations/*` (Funnel/* added 2026-05-14); API GW `DetailedMetricsEnabled=true` + throttle 200/100; SNS SMS delivery logging at 100%. Per-alarm playbook: [[saturday_operational_runbook]].

**Missing (Phase 3+):** AWS WAF v2; AWS End User Messaging Configuration Set; toll-free `+18557656160` (carrier review per [[tfn_registration_submitted_2026_05_13]]); SNS `MonthlySpendLimit` aligned to EUM cap; IaC baseline.

## Where to look first

- **New lambda route** → handler in `lib/routes-*.mjs`, wire into `index.mjs`, add `.http` smoke. Plus `apigatewayv2 create-route` + `lambda add-permission` (see Auth).
- **New frontend feature** → standalone component under `src/app/features/`, register in `app.routes.ts`. Authed routes render inside `<main hlmSidebarInset>` (no page-level horizontal padding).
- **Touching the shell** (topbar/sidebar/inset) → [[sidebar_shell_spartan_pattern]] + [[safari_display_contents_flex_bug]] + [[topbar_uses_position_fixed]]. Topbar `position:fixed` (`pt-14` on wrapper, `--header-height: 3.5rem`).
- **`reservations-new.ts`** (staff Hold & Reserve) → main + 5 helpers + 12 specs. OnPush, signal-backed accessors, computeds (not methods). Multi-table via TableLabelPipe. [[reservations_new_audit_2026_05_13]] + [[reservations_new_signals_onpush_2026_05_13]].
- **Reservation detail modal** → `src/app/shared/components/reservation-detail-modal/`. Parent owns loading/error/notice + emits ~14 actions; modal owns 4-tab UI. Don't duplicate the template.
- **Reservation backend** → see Repo layout 5-module split. Read existing TransactWrite + ConditionExpression patterns before new writes.
- **`financials.ts`** → 6 pure reducers; 23 specs lock refund/credit/cashapp invariants. Calls `list(date, { suppressRelease: true })` — keep that flag. [[financials_reducer_invariants]]
- **`/admin/settings`** → 8 collapsible sections; OnPush + `FIELD_HINTS`; `joinHm`/`splitHm` bridge HH:MM ↔ hour+minute; HIGH_IMPACT_LABELS bulleted confirm; `squareEnvLabel()` (`production`/`sandbox` → `Live`/`Test`). Copy must follow [[feedback_admin_copy_plain_language]]; [[settings_admin_friendly_overhaul_2026_05_14]].
- **Payments** → `services-square-payments.mjs` + `routes-square-webhooks.mjs`. 6 staff/customer routes in `routes-reservations-holds.mjs` share `autoRefundAfterRecordFailure` (idempotency-keyed). Customer-mobile equivalent in `routes-me.mjs` — audit BOTH. Push notifs fire from `addReservationPayment` via `services-push-notifications.mjs`.
- **SMS** → 3 pure builders in `services-sms-notifications-pure.mjs` (all `BRAND_PREFIX`); SNS today, EUM post-TFN [[sms_migrate_to_eum_after_approval]]. Customer OTP separate file `cognito-customer-auth/index.mjs` — touch BOTH. Kill-switch `smsEnabled` (transactional only).
- **Apple Wallet `.pkpass`** → `services-wallet-pass.mjs` (passkit-generator); certs in `WALLET_PASS_SECRET_ARN`. `pass.type = "generic"`; QR message is `ffr-checkin:{64-hex token}` (never the 6-char code); `barcode.altText = FF-{code}`. Installed passes don't auto-refresh. [[wallet_pass_logo_placeholder]] + [[wallet_pass_polish_session_2026_05_14]]
- **Customer self-service (`/me/*`)** → `routes-me.mjs`. Self-cancel ≥24h forces `RESCHEDULE_CREDIT`. Customer payment routes must NOT pass `source: "customer"` (not in enum) — omit, default `square-direct`.
- **Anonymous public booking** (`/public/reservations/*`, `/p/{slug}`, `/r/{id}`, `/public/lookup-by-{phone,code}`, `/public/telemetry`) → `routes-public-bookings.mjs`. Pre-mint id+token+code+slug. Phone slot `(PK="RATE", SK="ANONHOLD#{phoneKey}")` enforces 1 active unpaid hold/phone; cleared on payment. Flag `allowAnonymousPublicBooking`. [[anon_public_booking_implementation_2026_05_13]] + [[public_map_audit_session_2026_05_13_evening]] + [[public_map_tier_a_b_session_2026_05_14]] + [[find_by_code_tier_s_2026_05_14]]
- **Staff lookup by FF-XXXXXX** → `GET /reservations/by-code/{code}` in `routes-reservations-holds.mjs`. Frontend mini-form on /staff/reservations + in-table filter both match `confirmationCode`. Chip in detail modal header + dashboard urgent-payment cards.
- **Saturday-night ops** → `bash scripts/smoke_test_prod.sh` (19 checks). Night-before `bash scripts/saturday_eve_check.sh [date]`. Dashboard `ff-saturday-funnel`. [[saturday_operational_runbook]] + [[incident_2026_05_13_day_paid_but_cancelled]]
- **CRM clients** → `services-clients.mjs` + `routes-clients.mjs`. `GET /clients/search?phone&q` (staff); `POST /clients/bulk-import` (admin, ≤500/req). `upsertCrmClient` = live-reservation path.
- **Auditing auth** → Auth Model section above + `index.mjs:97-174` (`getGroupsFromEvent` / `requireAdmin` / `requireStaffOrAdmin` / `requireCustomerOwnership`).
- **Diagnostic queries** → SMS: `sns/us-east-1/908027422124/DirectPublishToPhoneNumber{,/Failure}`. Cron heartbeat: `aws logs filter-log-events ... --filter-pattern "scheduled_maintenance"`.
- **iOS-Chrome-only bug** → `/?debug=1` (gated by `localStorage.ff-debug=1`) loads eruda + counter panel. Disable: `/?debug=0`.
