# FF Reservations — Project Context

Restaurant table reservation system for Famoso Fuego. Staff create reservations on behalf of customers; customers pay online via Square hosted checkout link OR in person at the venue (cash + Cash App QR shown on the staff iPad) and self-check-in via QR codes. Admin manages frequent clients, events, settings, and financials.

> **Branch state (2026-05-18):** Angular 21 SPA in prod. Anonymous public booking live behind `allowAnonymousPublicBooking` flag — customers self-book on `/reserva` (`/map` redirects) → Square checkout → `/r/{id}`. Branded short URLs `famosofuego.com/p/{slug}`. Per-route titles + static OG card. "Find my reservation" modal: phone (active hold) or FF-XXXXXX code. Live-visitor tile on staff dashboard. `/admin/analytics` splits visits/bookings/revenue by source. Layer 2 UTM/fbclid/gclid first-touch. Layer 3 Meta Pixel + CAPI wired but inert until `metaPixelId` + Lambda Meta env set. Admin-editable OG + favicon under "Branding" in `/admin/settings`. Funnel telemetry FE+BE; `bash scripts/smoke_test_prod.sh`. Dashboard overhaul + shared `<take-payment-modal>` [[dashboard_payment_overhaul_2026_05_16]]. **Card on Stand (2026-05-17)**: in-venue card swipe via Square POS URL-scheme handoff on the host-stand iPad [[square_stand_handoff_2026_05_17]]. **Change Tables (2026-05-17)**: staff swap tables via `<change-table-modal>`; atomic `PUT /reservations/{id}/tables`; bundled cash/credit OR deferred Card on Stand for delta; CREDIT/REFUND/LEAVE downgrades; auto pass revoke + reissue + SMS on PAID branch [[change-tables-2026-05-17]]. **Frequent-client payment links (2026-05-18)**: FREQUENT_AUTO mints Square links eagerly at event creation; `/admin/frequent-clients` → Payment links panel (Copy/WhatsApp/Regenerate/Extend deadline/Manage reservation deep-link → `/staff/reservations?date=&open=`); `PUT /reservations/{id}/payment-deadline` for deadline backfill; `<change-table-modal>` exposes all 5 payment methods + auto-regens the link post-swap on frequent rows [[frequent-client-payment-links-2026-05-18]]. **Pass eligibility + cancel-revoke (2026-05-18)**: `isPassEligiblePaymentStatus(ps)` helper centralizes pass gating in BE (`services-reservations-shared.mjs`) + FE (`reservation.model.ts`) — `PAID || COURTESY`. COURTESY reservations auto-issue passes at creation, render `Courtesy` on the pass face, and download via the same `/wallet-pass` endpoint. `cancelReservation` now revokes any active pass on all three resolution paths (soft-fail with `checkin_pass_revoke_on_cancel_failed` warn) so a cancelled customer's Wallet pass scanner-rejects at the door. Modal Pass tab shows Issued/Expires timestamps. [[pass-courtesy-and-cancel-revoke-2026-05-18]] **Google Wallet Phase 1 (2026-05-18)**: dual-wallet event-ticket support landed behind 501 until GCP issuer + service-account secret are provisioned. `services-google-wallet.mjs` (JWT save flow + REST PATCH/addMessage), 3 mirror routes (`POST /reservations/{id}/google-wallet-pass` for staff, `POST /public/reservations/{id}/google-wallet-pass?t={token}` for anon, `POST /me/reservations/{id}/google-wallet-pass` for the paused mobile app). `/r/{id}` shows Android customers an Add-to-Google-Wallet badge instead of the bare check-in link; staff detail-modal Pass tab gains a "Google Wallet link" button that copies the save URL for SMS/WhatsApp. `cancelReservation` PATCHes saved object state→INACTIVE next to Apple revoke; Change Tables PATCHes textModulesData + barcode + sends `addMessage`. Same `isPassEligiblePaymentStatus` gate. Also fixed `routes-me.mjs:654` PAID-only Apple gate to use the helper. [[google-wallet-phase-1-2026-05-18]] Memory chains via `[[...]]`. React + Expo port paused on `react` branch (tag `react-port-snapshot-2026-05-09`); don't introduce React/pnpm/Vite/`apps/` on `main`.

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
| `HlmNativeSelect` | `<hlm-native-select>` w/ projected `<option>`s | Native dropdown w/ Spartan chevron overlay. CVA + `[formControl]`. `(change)` double-fires — type handler `string \| Event` + coerce ([[hlm_native_select_change_double_fire]]). |
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
- **Palette**: `brand` (grayscale), `warm` (orange), `success`/`danger`/`warning` (50–800). Spartan semantic colors → brand via HSL vars in `src/styles.scss`. Customer surfaces moving warm-dark/Fraunces (deferred) [[customer_dark_design_split_2026_05_14]].
- **Specs** at `src/app/shared/ui/<name>/<name>.spec.ts`. Compound-primitive deep-dives: `HlmSidebar` ([[sidebar_shell_spartan_pattern]] + [[safari_display_contents_flex_bug]]), `HlmPagination` ([[client_side_pagination_pattern]]), `HlmTable`+TanStack ([[data_tables_spartan_pattern]] + [[tanstack_proxy_onpush_reactivity]]). **DO NOT run `@spartan-ng/cli ui`** ([[spartan_cli_avoided]]).

## Repo layout

```
src/app/                            # core/ (auth/config/layout/http/guards/payments), features/ (public,staff,admin lazy), shared/ (components, ui/ primitives, models)
                                    # shared/components/: reservation-detail-modal (4-tab Overview/Payment/Pass/Activity), take-payment-modal (cash/credit/Square/Cash App/Stand), cash-app-qr-pad (Web Payments SDK), square-stand-handoff (POS URL-scheme bridge), change-table-modal (atomic table swap + delta payment, 2026-05-17)

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
  services-payment-recording.mjs    # addReservationPayment + Square link state
  services-reservations.mjs         # CRUD, 3 cancellation paths, cron release
  services-holds.mjs                # createHold / releaseHold / listHolds
  services-reservations-holds.mjs   # barrel for index.mjs
  services-square-stand-handoff.mjs # Square POS URL-scheme handoff (Card on Stand)
  services-reservations-table-change.mjs # PUT /reservations/{id}/tables atomic swap + delta payment + pass reissue (2026-05-17)
  services-google-wallet.mjs        # Google Wallet event-ticket JWT save flow + REST PATCH/addMessage (2026-05-18, 501 until provisioned)

# Anonymous public-booking (2026-05-13):
  routes-public-bookings.mjs        # /public/reservations*, /p/{slug}
  services-anon-bookings.mjs        # phone-slot + verifyCustomerToken
  services-turnstile.mjs            # Cloudflare siteverify (fail-closed)
  services-reservation-codes.mjs    # 6-char codes + 16-char slugs

backend/cognito-pre-token-gen/      # groups injection (separate Lambda)
backend/cognito-customer-auth/      # Custom Auth phone-OTP triggers
http/*.http + scripts/              # smoke tests + ops helpers
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
- API Gateway HTTP API has a JWT authorizer per-route. Public routes (no authorizer): `/public/availability`, `/check-in/pass`, `/webhooks/square`.
- Lambda re-checks `requireAdmin(event)` / `requireStaffOrAdmin(event)` per sensitive route (defense in depth — do not rely on API Gateway alone).
- Cognito access tokens DO NOT include `cognito:groups` by default. A **Pre Token Generation v2 Lambda trigger** (`backend/cognito-pre-token-gen/`) injects groups into the access token. If disabled/broken, every authed request silently 403s; the `AuthHealthBanner` (driven by `GET /admin/whoami`) surfaces this.
- Groups: `Admin`, `Staff`. Users without a group fall through to `/unauthorized`.
- **Staff pool `us-east-1_Upsi9Q2Tc` is locked to admin-create-only** (2026-05-13): `AdminCreateUserConfig.AllowAdminCreateUserOnly=true`. Hosted UI's "Sign Up" tab is hidden; `cognito-idp:SignUp` API is rejected for non-admins. New staff/admin users created exclusively via the "Invite User" form (`POST /admin/users` → `AdminCreateUserCommand`). Memory: `cognito_pool_locked_admin_create_only.md`. **Customer pool app client `21n3rd1sp4o9ka4l7tld45f0ka` is on a different flow (custom-auth phone-OTP) and unaffected.**
- **Customer auth** (mobile, separate from staff): Custom Auth phone-OTP via `backend/cognito-customer-auth/`. Public mediator routes `POST /auth/customer/start` + `POST /auth/customer/verify` (in `routes-customer-auth.mjs`) wrap the synthetic-email convention. Customer-only routes under `/me/*` (in `routes-me.mjs`) use `requireCustomerOwnership(event)`.
- **Token TTLs** (staff client, 2026-05-14): access/ID 24h, refresh 30d (bumped from 8h alongside `SessionWatcher` fix). **OIDC state in localStorage** via `DefaultLocalStorageService` in `app.config.ts` — library default sessionStorage silently nukes refresh on restart. See [[feedback_oidc_default_session_storage]].
- `Login` auto-redirects authed users to `/staff/dashboard`; `''` + `'home'` → `/login`. `?reason=session-expired` shows HlmAlert. **`SessionWatcher`** closes the backgrounded-tab logout gap (visibility/focus/pageshow refresh + 4-min heartbeat + reacts to `TokenExpired`/`SilentRenewFailed`); `refreshOnce()` coalesced + debounced; `AuthInterceptor` retries once on 401. Phase 1 shadow `RefreshTokenVault` + `DirectRefreshClient` + `LibraryStorageBridge` route around the library's wipe-on-failure. `ff_authed=1` flag + `authGuard` fires `SessionExpiry.notifyExpired('guard', {skipNavigation: true})`. **Embedded login (Path 3)** rollout starts 2026-05-18 [[phase_3_embedded_login_plan_2026_05_15]]. [[auth_telemetry_cw_query]] · [[auth_phase_0_1_session_2026_05_15]].

## Concurrency / data integrity

- All DDB writes use `ConditionExpression` + `ExpressionAttributeNames`/`Values` (never string-built expressions).
- Hold → reservation upgrade is a single `TransactWriteCommand`. **Multi-table bookings** grow to N hold-upgrade Updates + 1 reservation Put (capped at `MAX_TABLES_PER_RESERVATION = 10` — well under DDB's 100-item TransactWrite limit). Either all N+1 land or none do.
- **Change Tables uses the same atomic-swap shape** — one `TransactWriteCommand` does (per removed table) `Delete` on old `RESERVED` rows + (per added table) `Update` HOLD→RESERVED + 1 reservation `Update` + (for method=credit) 1 credit-row `Update`. Pins `#depositAmount` + `#tablePrice` on the reservation Update so concurrent payments + concurrent swaps both lose. Idempotent replay on `TransactionCanceledException` returns the post-swap reservation if `tableIds` already matches the request. See `services-reservations-table-change.mjs` + [[change-tables-2026-05-17]].
- **`POST /reservations` is idempotent on `holdId`** (audit M3): duplicate request that loses the TransactWrite race triggers a GetItem on the hold; if RESERVED, returns the existing reservation with `idempotentReplay: true`. Route handler skips CRM upsert + auto-SMS on replay.
- **5-second grace window** on hold-to-reservation upgrade: `expiresAt >= :now - 5` so "Confirm" within ~1-2s of expiry still succeeds (same-owner only).
- Webhook idempotency: `addReservationPayment` deduplicates on `providerPaymentId` / `idempotencyKey`.
- **Cash App is in-venue only** (2026-05-16): staff payment modal + `reservations-new` wizard mount `cashAppPay()` via `<cash-app-qr-pad>`. SDK renders a QR, customer scans, `ontokenization` posts `sourceId` to `/reservations/{id}/payments`. No customer-facing link/SMS/`/cashapp/session*`. [[cashapp_in_venue_only_2026_05_16]]
- Reservation history lives in `RES_TABLE` under `SK = HIST#…`. Writes are fire-and-forget; failures emit `reservation_history_write_error` (CW metric filter + alarm at ≥1/5min).
- Cron-based overdue release owned by EventBridge `ff-reservations-overdue-release` (rate 1 min) → dispatches to `runScheduledMaintenance`. Anonymous request paths never trigger release; staff `GET /reservations` and payment routes still do.
- **`createReservation` auto-clamps past *default* `paymentDeadlineAt`**: omitted default that lands <= now is extended to `now + 4h` (typical at 2-5 AM on the active business day before the operating cutoff rolls). Explicit past deadlines still throw 400. The wizard's `setDefaultPaymentDeadline` (FE) mirrors this — it never sends an explicit past-default to the BE because its own future-deadline check would reject first.

## DynamoDB tables

- `ff-events` (events + per-date locks under `(EVENTDATE, DATE#YYYY-MM-DD)`)
- `ff-table-holds` (HOLDS_TABLE — HOLD and RESERVED locks per `(EVENTDATE#YYYY-MM-DD, TABLE#{id})`). Also carries: `(PK="RATE", SK="SMS#…" | "CUSTHOLD#…" | "ANONHOLD#{phoneKey}")` rate-limit rows; `(PK="PRESENCE", SK="SESSION#{sessionId}")` live-visitor presence (90s TTL); `(PK="ANALYTICS", SK="VISIT#…")` daily counters; `(PK="STANDPAY", SK="HANDOFF#{uuid}")` Card-on-Stand handoff rows (15-min TTL).
- `ff-reservations` (RES_TABLE — reservations + history). Three additional partitions ride in this same table:
  - `(PK="EVENTDATE#YYYY-MM-DD", SK="RES#{uuid}")` — the reservation row itself
  - `(PK="EVENTDATE#YYYY-MM-DD", SK="HIST#…")` — append-only history events
  - `(PK="CODE", SK="CODE#XXXXXX")` — 6-char confirmation-code → `{reservationId, eventDate}` lookup (anon flow)
  - `(PK="SLUG", SK="SLUG#xxxxxxxxxxxxxxxx")` — 16-char short-URL slug → `{reservationId, eventDate, customerToken}` lookup (anon flow)
- `ff-frequent-clients`
- `ff-clients` (CRM + reschedule credits)
- `ff-checkin-passes`
- `ff-settings` (single `(APP, CONFIG)` record; overrides env at runtime; some keys env-managed only). Also carries `(APP, BRANDING#{type})` binary-data rows when an admin uploads a custom OG image / favicon (300 KB cap for og-image / og-image-square; 50 KB for favicon SVG).

## Lambda env vars
Tables: `EVENTS_TABLE`,`HOLDS_TABLE`,`RES_TABLE`,`FREQUENT_CLIENTS_TABLE`,`CLIENTS_TABLE`,`CHECKIN_PASSES_TABLE`,`SETTINGS_TABLE`. Cognito: `USER_POOL_ID`. Square: `SQUARE_SECRET_ARN`,`SQUARE_ENV`,`SQUARE_LOCATION_ID`,`SQUARE_API_VERSION`,`SQUARE_WEBHOOK_NOTIFICATION_URL`,`SQUARE_CURRENCY`,`SQUARE_CHECKOUT_REDIRECT_URL`,`SQUARE_LINK_ENABLE_*`,`SQUARE_STAND_CALLBACK_URL` (default `/square-stand-callback` on apex). SMS: `SMS_ENABLED`,`SMS_SENDER_ID`,`SMS_TYPE`,`SMS_MAX_PRICE_USD`. Links: `PAYMENT_LINK_TTL_MINUTES`,`FREQUENT_PAYMENT_LINK_TTL_MINUTES`,`AUTO_SEND_SQUARE_LINK_SMS`. Check-in: `CHECKIN_PASS_BASE_URL`,`CHECKIN_PASS_TTL_DAYS`. Wallet: `WALLET_PASS_TYPE_IDENTIFIER`,`WALLET_TEAM_IDENTIFIER`,`WALLET_PASS_SECRET_ARN`. Google Wallet (optional — both unset = full 501): `GOOGLE_WALLET_ISSUER_ID`, `GOOGLE_WALLET_SERVICE_ACCOUNT_SECRET_ARN`, `GOOGLE_WALLET_ORIGINS` (defaults `https://famosofuego.com`); optional cosmetic overrides `GOOGLE_WALLET_ISSUER_NAME`/`GOOGLE_WALLET_VENUE_NAME`/`GOOGLE_WALLET_VENUE_ADDRESS`/`GOOGLE_WALLET_LOGO_URI`/`GOOGLE_WALLET_HERO_IMAGE_URI` (reuses `WALLET_BACKGROUND_COLOR` for both wallets). Operating: `OPERATING_TZ`,`OPERATING_DAY_CUTOFF_HOUR`,`HOLD_TTL_SECONDS`. Anon: `TURNSTILE_SECRET_ARN`, `PUBLIC_BOOKING_RETURN_BASE_URL`, `PUBLIC_BOOKING_SHORT_URL_BASE` (`https://famosofuego.com` in prod via Amplify rewrite; defaults safely to API host). Meta CAPI (optional — both unset = full no-op): `META_PIXEL_ID`, `META_CAPI_TOKEN_SECRET_ARN`, `META_CAPI_TEST_EVENT_CODE` (routes events to Events Manager "Test Events" tab when set).

## Conventions
Frontend config: `src/app/core/config/app-config.ts` hardcodes `apiBaseUrl: https://api.famosofuego.com` + Cognito authority/hostedUiDomain/clientId/scope (no per-env yet).

- **Money is dollars** (2 decimals); Square API expects minor units (conversion in `services-square-payments.mjs`).
- **Phones stored E.164**. Search via `buildPhoneSearchCandidates`; <4 digits returns empty.
- **CRM dedup is phone-only** (PK=`PHONE#{key}`); same person via two phones = two rows on purpose. [[feedback_crm_dedup_phone_only]]
- **Times**: epoch seconds for `expiresAt`/`issuedAt`; deadlines `YYYY-MM-DDTHH:mm:ss` + IANA tz. Default `America/Chicago`.
- **Venue takes forward bookings** — admin date-range filters MUST NOT cap upper bound at "today" by default. [[financials_reducer_invariants]]
- **Errors**: raise via `httpError(status, message)` from `core-utils.mjs`.
- **Reservation enums**: `paymentStatus` ∈ {PENDING,PARTIAL,PAID,COURTESY,REFUNDED}; `paymentMethod` ∈ {cash,square,cashapp,credit}; `status` ∈ {CONFIRMED,CANCELLED}; `lockType` ∈ {HOLD,RESERVED}; `resolutionType` ∈ {CANCEL_NO_REFUND,RESCHEDULE_CREDIT,REFUND}. REFUND iterates `payments[]` via Square then sets `paymentStatus=REFUNDED`; partial failure throws 502 without cancelling. Pass-eligibility (auto-issue at create, staff manual issue, public `/wallet-pass`, `/p/{slug}?to=pass`) is `PAID || COURTESY` — single source of truth is `isPassEligiblePaymentStatus(ps)` (BE `services-reservations-shared.mjs`; FE `reservation.model.ts`).
- **Multi-table bookings**: row carries `tableIds[]` + `tablePrices[]` plus legacy scalar `tableId`/`tablePrice` (= first / sum). One reservation = one deposit / Square link / SMS / pass listing every table. Cap 10/booking (4 for anon-public). **Every reader prefers `tableIds[]` then falls back to `[tableId]`; every writer stamps both.** Helpers: `getReservationTableIds`/`normalizeIdList`/`formatTablesLabel` (BE) + `TableLabelPipe`/`formatTableLabel{,Lower}` (FE) — only places that branch on length. Mobile customer flow single-table in v1.
- **Customer-facing IDs are short**, internal full. Anon bookings mint 6-char `confirmationCode` (FF-K7M3X2) + 16-char `publicSlug` for `/p/{slug}`; UUID + 64-char customerToken stay internal. Receipts/SMS/share links use short forms; check-in pass URL is `${PUBLIC_BOOKING_SHORT_URL_BASE}/p/{slug}?to=pass` (legacy `/check-in/pass?token=` still works). Generators in `services-reservation-codes.mjs` (alphabet excludes 0/O/1/I/L). See [[anon_public_booking_implementation_2026_05_13]].
- **Signals + OnPush everywhere.** All 16 feature components on OnPush. Bare signals for new code; signal-backed accessors only in reservations-new. Record/Set mutate copy-on-write via `.update`. See [[signals_onpush_migration_status_2026_05_13]].
- **SMS templates prefix `Famoso Fuego: `** via `BRAND_PREFIX` in `services-sms-notifications-pure.mjs` (carrier-required, [[sms_brand_prefix_session_2026_05_14]]). Customer OTP path inlines the brand. Changing prefix requires updating registered Message Samples in EUM.
- **A11y**: `.sr-only` is Tailwind 3 built-in (don't roll your own); filtered-list empty-states get `aria-live="polite"` so AT users hear the count change.

## Known gotchas

- `qrcode` CommonJS warning at build — cosmetic.
- Tests use Vitest + shared OIDC mock at `src/app/testing/oidc-mock.ts`. Use `provideMockOidc()` + `provideRouter([])`; per-test stubs for `isAuthenticated$`/`getIdToken()`. AuthService logout stubs `window.location` via `Object.defineProperty` (jsdom's `Location.replace` non-configurable).
- `CanMatchFn` guards: `TestBed.runInInjectionContext(() => guard(null as any, []))`. HTTP wrappers fake `ApiClient`, not `HttpClient`. `ApiClient` retries GET 5xx + status 0 only.
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
- **`takeUntilDestroyed()` no-arg requires injection context.** In event handlers, inject `DestroyRef` at construction and pass explicitly: `.pipe(takeUntilDestroyed(this.destroyRef))`. ALSO: do NOT pipe it into cleanup XHRs fired from `onClose()`/`ngOnDestroy()` — synchronously cancels the request before it leaves the browser. [[feedback-takeuntildestroyed-cancels-cleanup]]
- **`computed()` doesn't track legacy `@Input` reads** — only signals. Mirror inputs into private signals + sync in `ngOnChanges`, OR migrate to functional `input()`. [[feedback-input-signal-reactivity]]
- **Cognito `logout_uri` requires string-exact LogoutURLs match.** Build via `buildRedirectUrl(APP_CONFIG.cognito.postLogoutPath)`. [[cognito_logout_uri_gotcha]]
- **`angular-auth-oidc-client` wipes refresh token on ANY internal failure** (`resetAuthorizationData`). Then renew throws synchronously — no retry path. Phase 1's `RefreshTokenVault` shadows it. Never call `forceRefreshSession()` directly — use `SessionWatcher.refreshOnce()`. [[phase_1_auth_resilience_plan_2026_05_15]]
- **US SMS silently drops while TFN PENDING; MX works.** Self-resolves on ACTIVE. Don't pin OriginationIdentity for `+52`. [[sms_us_blocked_mx_works_root_cause]]
- **SMS: SNS today, EUM planned post-TFN ACTIVE.** Don't touch during re-review. [[sms_migrate_to_eum_after_approval]]
- **`<hlm-native-select> (change)` double-fires** — Output string + bubbled DOM Event. Type handler `string \| Event` + coerce or payload serializes Event as `[object Object]`. [[hlm_native_select_change_double_fire]]
- **Square POS caches registered-callback-URL list at launch.** After updating in the Square Developer Console, force-quit Square POS on the iPad and reopen. [[square_stand_handoff_2026_05_17]]
- **API GW HTTP API CORS allowlist doesn't include PATCH.** New mutation routes should use PUT — matches existing `/cancel` + `/payment` style and avoids a shared-prod CORS edit.
- **Lambda resource policy is capped at 20KB.** Per-route invoke statements pile up (~57 today). Consolidate stale ones or switch a noisy route family to a wildcard `source-arn` before adding new routes when the policy is near full. [[change-tables-2026-05-17]]

## Wiring outside this repo

**In place:** Cognito Pre Token Gen v2 (`ff-reservations-pretoken`); EventBridge `ff-reservations-overdue-release` (1 min → `runScheduledMaintenance`); API GW JWT authorizer `5ea6tk`; DDB PITR (35d) on reservations/holds/clients/checkin-passes; CloudWatch `ff-res-*` alarms → SNS `ff-res-ops-alerts`; dashboard `ff-saturday-funnel` (JSON in `scripts/cloudwatch-dashboards/`); SQS DLQ `ff-reservations-api-dlq` (14d); log-metric filters in `FFReservations/*` (Funnel/* added 2026-05-14); API GW `DetailedMetricsEnabled=true` + throttle 200/100; SNS SMS delivery logging at 100%. Per-alarm playbook: [[saturday_operational_runbook]]. **Missing (Phase 3+):** WAF v2; EUM Configuration Set; TFN `+18557656160` carrier review [[tfn_registration_submitted_2026_05_13]]; SNS `MonthlySpendLimit`; IaC baseline.

## Where to look first

- **New lambda route** → handler in `lib/routes-*.mjs`, wire into `index.mjs`, `.http` smoke. Plus `apigatewayv2 create-route` + `lambda add-permission` (see Auth).
- **New frontend feature** → standalone under `src/app/features/`, register in `app.routes.ts`. Authed routes render inside `<main hlmSidebarInset>` (no page-level horizontal padding).
- **Shell** (topbar/sidebar/inset) → `position:fixed` topbar (`pt-14` on wrapper, `--header-height: 3.5rem`). [[sidebar_shell_spartan_pattern]] + [[safari_display_contents_flex_bug]] + [[topbar_uses_position_fixed]].
- **`reservations-new.ts`** (staff Hold & Reserve) — OnPush + signal-backed accessors + computeds; multi-table via TableLabelPipe. [[reservations_new_audit_2026_05_13]]
- **Reservation detail modal** → `src/app/shared/components/reservation-detail-modal/`. 4-tab (Overview/Payment/Pass/Activity); prominent Take Payment button above tabs emits `(takePayment)` → parent opens the take-payment modal. Parent owns loading/error + emits ~14 actions.
- **Take Payment modal** → `src/app/shared/components/take-payment-modal/`. Shared by Dashboard + staff Reservations. Owns form + Cash App QR pad; emits `(recordPayment)` / `(requestSquareLink)` / `(cashAppTokenized)` / `(cashAppError)` / `(close)`. Parents own all service calls. [[take_payment_modal_shared_component_pattern]]
- **Change Tables (staff swap)** → `services-reservations-table-change.mjs` + `<change-table-modal>` + `PUT /reservations/{id}/tables`. Two-step modal: pick tables → (Δ>0) cash/credit bundled OR Card on Stand deferred. Single-TransactWrite swap + delta payment. Post-swap: link deactivation, surplus resolution, pass revoke/reissue/SMS. Deferred path chains into `<take-payment-modal>` via `openPayment(..., { defaultMethod })`. Modal owns hold lifecycle. [[change-tables-2026-05-17]]
- **Reservation backend** → see Repo layout 5-module split. Read TransactWrite + ConditionExpression patterns before new writes. Multi-event read: `GET /reservations/recent?maxEvents=3&limit=50` (fans out across upcoming ACTIVE events; suppresses release sweeps).
- **`financials.ts`** → 6 pure reducers, 23 specs lock invariants. Calls `list(date, { suppressRelease: true })` — keep that flag. [[financials_reducer_invariants]]
- **`/admin/settings`** → collapsible sections in 3 tiers (often/occasional/rare); Branding section below the form. OnPush + `FIELD_HINTS`; `joinHm`/`splitHm` bridge HH:MM ↔ hour+minute; HIGH_IMPACT_LABELS bulleted confirm; copy plain-language ([[feedback_admin_copy_plain_language]]).
- **Payments** → `services-square-payments.mjs` + `routes-square-webhooks.mjs`. Staff/customer routes share `autoRefundAfterRecordFailure` (idempotency-keyed). Push notifs fire from `addReservationPayment`. Cash App is **in-venue only** via `<cash-app-qr-pad>` — staff iPad QR, customer scans, no link/SMS/`/cashapp/session*` route. Wizard mid-flow recovery via `pendingCashAppPayment` banner (Resume / Cancel→`CANCEL_NO_REFUND`). [[cashapp_in_venue_only_2026_05_16]]
- **Card on Stand (Square POS handoff)** → `services-square-stand-handoff.mjs` + `<square-stand-handoff>` + `/square-stand-callback` page (in `PUBLIC_PATHS` so the success layout gets the full viewport — no staff topbar/sidebar chrome). **Single-iPad only**: Safari opens `square-commerce-v1://payment/create?data=…`; Square POS swipes on the Stand reader; callback POSTs `/reservations/{id}/payment/square-stand/complete` which resolves order→payment and dispatches `addReservationPayment(method:"square", source:"square-stand")`. Idempotent on `providerPaymentId` (webhook backstop). Handoff rows in `HOLDS_TABLE` under `(PK="STANDPAY")`, 15-min TTL. Tipping + Open Tickets must be OFF in Square POS settings; tenders locked to `CREDIT_CARD`. **Auto-refund** on `/complete` failure (record-failure path) AND captured-vs-handoff cap (tipping over-capture) — Square charges can never be orphaned. **Cross-tab handoff**: when Safari opens the URL scheme in a NEW tab (common iOS behavior), the new tab's callback writes `ff:stand-just-paid` to localStorage + a `storage` event fires on the original wizard tab → `subscribeToJustPaid()` listeners in the wizard/dashboard/reservations flip `squareStandSuccess` + show toast. Design preview: `?preview=done|error|cancelled|declined|missing&amount=40&code=K7M3X2` shortcuts the callback page without burning a real payment. [[square_stand_handoff_2026_05_17]]
- **SMS** → 3 pure builders in `services-sms-notifications-pure.mjs` (all `BRAND_PREFIX`); SNS today, EUM post-TFN [[sms_migrate_to_eum_after_approval]]. Customer OTP separate in `cognito-customer-auth/index.mjs` — touch BOTH. Kill-switch `smsEnabled` (transactional only).
- **Apple Wallet `.pkpass`** → `services-wallet-pass.mjs`; certs in `WALLET_PASS_SECRET_ARN`. `pass.type="generic"`; QR is `ffr-checkin:{64-hex token}` (never the 6-char code); `barcode.altText = FF-{code}`. Pass eligibility = `PAID || COURTESY` via `isPassEligiblePaymentStatus` ([[pass-courtesy-and-cancel-revoke-2026-05-18]]); COURTESY rows render `Courtesy` on the DEPOSIT slot instead of `$0.00`. Installed passes don't auto-refresh; content edits (table change, rename) need revoke + reissue + re-share — Change Tables wires this automatically [[change-tables-2026-05-17]]. **Cancellation auto-revokes any active pass** on all three resolution paths (CANCEL_NO_REFUND / RESCHEDULE_CREDIT / REFUND) + the cron auto-release — without it the scanner (`verifyAndConsumePass`) only checks the pass row's status and would accept a cancelled-but-PAID reservation's QR.
- **Google Wallet (event ticket)** → `services-google-wallet.mjs`; service-account creds in `GOOGLE_WALLET_SERVICE_ACCOUNT_SECRET_ARN`. JWT-only save flow (`https://pay.google.com/gp/v/save/{jwt}`, RS256, `typ:savetowallet`) embeds class + object so Google upserts on first save — no pre-create REST. Class id = `{issuerId}.ff-event-YYYY-MM-DD` (one per event), object id = `{issuerId}.res-{sanitized-reservationId}` (idempotent). QR `barcode.value` is the SAME `ffr-checkin:{token}` primitive as Apple — scanner code unchanged. Eligibility uses the same helper. `cancelReservation` PATCHes state→INACTIVE (soft-fail, cosmetic only — DDB scanner is source-of-truth); Change Tables PATCHes textModulesData + barcode then sends `eventticketobject.addmessage` (NOT class `messages[]` — that's broadcast; addmessage is per-customer). 501 until env vars + GCP issuer + service-account JSON are configured; FE detects 501 once and hides the staff button + falls through to plain check-in URL on `/r`. Demo mode is enough to dev + smoke; Phase 3 publishing access is a manual Google review. [[google-wallet-phase-1-2026-05-18]]
- **Customer self-service (`/me/*`)** → `routes-me.mjs`. Self-cancel ≥24h forces `RESCHEDULE_CREDIT`. Customer payment routes must NOT pass `source: "customer"` — omit, default `square-direct`.
- **Anonymous public booking** (`/public/*`, `/p/{slug}`, `/r/{id}`) → `routes-public-bookings.mjs`. Pre-mint id+token+code+slug. Phone slot `(PK="RATE", SK="ANONHOLD#{phoneKey}")` enforces 1 active unpaid hold/phone; cleared on payment. Flag `allowAnonymousPublicBooking`. Public page `/reserva` (legacy `/map` redirects). Staff lookup by FF-XXXXXX: `GET /reservations/by-code/{code}` (form on /staff/reservations + in-table filter + chip in detail modal). [[anon_public_booking_implementation_2026_05_13]]
- **Marketing analytics** → 4 layers: funnel telemetry (`frontend_funnel_event` → CW) · first-touch attribution (`core/analytics/attribution.ts`, persisted to `reservation.attribution`) · `/admin/analytics` (`services-analytics.mjs`, admin-only) · Meta Pixel + CAPI dedup pair (`services-meta-capi.mjs` Graph v23.0; Purchase from webhook with `event_id = purchase_${reservationId}`). Live-visitor presence: `services-presence.mjs` 90s-TTL rows; `/reserva` 30s heartbeats; dashboard polls `GET /admin/live-visitors` every 5s. [[analytics_dashboards_layers_2_3_2026_05_15]]
- **Admin-editable branding** → `services-branding.mjs` + `routes-branding.mjs`. Binary DDB on `(APP, BRANDING#{type})` in `ff-settings`. Public `GET /branding/{filename}` streams bytes (60s cache + ETag) or 302s to baked-in static. Admin `GET/POST/DELETE /admin/branding[/{type}]`. Amplify rewrite `/branding/<*>` → API GW. WhatsApp caches per-page-URL ~7d. [[admin_editable_branding_2026_05_16]]
- **Saturday-night ops** → `bash scripts/smoke_test_prod.sh` (19 checks). Night-before `bash scripts/saturday_eve_check.sh [date]`. Dashboard `ff-saturday-funnel`. [[saturday_operational_runbook]]
- **CRM clients** → `services-clients.mjs` + `routes-clients.mjs`. `GET /clients/search?phone&q` (staff); `POST /clients/bulk-import` (admin, ≤500/req). `upsertCrmClient` = live-reservation path.
- **Diagnostic queries** → SMS logs: `sns/us-east-1/908027422124/DirectPublishToPhoneNumber{,/Failure}`. Cron: `filter-log-events --filter-pattern "scheduled_maintenance"`. iOS Chrome bug: `/?debug=1` (gated by `localStorage.ff-debug=1`) loads eruda.
