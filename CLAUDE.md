# FF Reservations — Project Context

Restaurant table reservation system for Famoso Fuego. Staff create reservations on behalf of customers; customers pay via Square / Cash App link and self-check-in via QR codes. Admin manages frequent clients, events, settings, and financials.

> **Branch state (2026-05-14):** `main` runs the Angular 21 SPA in prod with anonymous public-booking live behind `allowAnonymousPublicBooking`. Customers self-book on `/map` (rebranded "Famoso Fuego — Reservations") → Square hosted checkout → `/r/{id}` (countdown, self-release, Wallet pass, differentiated CANCELLED). Short URLs are branded `https://famosofuego.com/p/{slug}` via Amplify rewrite → `api.famosofuego.com/p/{slug}`. Staff find by FF-XXXXXX via `/staff/reservations` search + table filter. Customers who lost their /r URL recover via "Find my reservation" (outline button on /map header) — tabbed modal supports **phone** (active hold only) OR **booking code FF-XXXXXX** (any non-CANCELLED state, the path that covers paid customers). Modal sheet has sticky header + footer + safe-area insets so the close X is always reachable on mobile. Pending-hold banner offers Continue + Release (no more silent-Hide trap). Modal recovers from `ACTIVE_HOLD_EXISTS` 429s by surfacing the existing hold + a release CTA. Funnel telemetry on every step (FE + BE) — `frontend_funnel_event` + `public_booking_event` in CloudWatch. Production smoke test: `bash scripts/smoke_test_prod.sh` (19 checks). Full implementation: [[anon_public_booking_implementation_2026_05_13]]; Saturday-readiness arc + per-feature commits: [[public_map_audit_session_2026_05_13_evening]] + [[public_map_tier_a_b_session_2026_05_14]] + [[find_by_code_tier_s_2026_05_14]]; ops runbook: [[saturday_operational_runbook]]. React + Expo port paused on the `react` branch (tag `react-port-snapshot-2026-05-09`). Do not introduce React, pnpm, Vite, or `apps/`/`packages/` changes on `main`.

> **Lambda Square env — PRODUCTION as of 2026-05-11.** `ff-reservations-api` runs against production Square. Real cards / Cash App charges fire. **Open verification item:** production Square webhook subscription must point at `https://api.famosofuego.com/webhooks/square` with `payment.created` + `payment.updated` events; signature key in the production secret. Without that, real payments succeed at Square but reservations don't auto-flip to PAID. Full env IDs + sandbox revert procedure in memory `lambda_square_env_production_cutover.md`.

> **Companion mobile app (sandbox dev loop paused):** Customer-facing iOS/Android app lives in `github.com/alekscortez/ff-customer-mobile` (Expo SDK 54). Resume options tracked in memory `ff_customer_mobile_status.md`.

## Stack

- **Frontend** (Angular 21 standalone, Tailwind 3.4, `angular-auth-oidc-client` v21, ZXing, qrcode, `@ng-icons/lucide`, Spartan primitives at `src/app/shared/ui/`). **Backend** (AWS Lambda Node 22 ESM, API GW HTTP API, DynamoDB, Cognito Hosted UI + customer phone OTP, Square API + webhook, SNS SMS, Secrets Manager). **Hosting** Amplify for SPA (npm + `ng build` → `dist/ff-reservations/browser/`); custom domain `api.famosofuego.com` for API; `amplify.yml` pins npm via `corepack prepare npm@11.6.2` — see [[amplify_corepack_npm_pin]].

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

**Convention for TS helpers**: when state-driven styling depends on a function, return a variant *literal* (`'success' | 'danger' | …`), NOT a Tailwind class string. See `reservations.ts:paymentStatusBadgeVariant`.

**Consumer-class merge rule**: extra classes via `class="..."` (directives) or `[class]="..."` (components) merge with variant defaults via tailwind-merge. Conflicting utilities (`rounded-full` vs `rounded-lg`) resolve with the consumer winning. The static `class` attribute is captured on first render — dynamic `[ngClass]` applied AFTER mount races with the directive's effect. Prefer `[active]`-style state inputs or `[class.foo]` bindings over `[ngClass]`.

**Palette**: `brand` (10-shade grayscale), `warm` (orange), `success`/`danger`/`warning` (50/100/200/300/400/500/700/800). Spartan/shadcn semantic colors (`bg-primary`, `text-foreground`, etc.) resolve to the brand palette via HSL CSS variables in `src/styles.scss`.

**Design system split (2026-05-14):** customer-facing web surfaces (`/map` + `/r/{id}` + `/p/{slug}` + the Find modal + future booking/account pages) are slated to adopt the [[ff_customer_mobile_project]]'s **warm dark + ember-gradient + Fraunces/Geist** language — *not* the light Spartan brand palette above. Staff/admin surfaces stay on the brand palette indefinitely. Implementation deferred until after Saturday 2026-05-16; current customer screens remain on the light theme until then. See [[customer_dark_design_split_2026_05_14]] for tokens + implementation plan + the 6-step theme split mechanism.

**Specs** live next to each primitive (`src/app/shared/ui/<name>/<name>.spec.ts`) and lock in variant + tailwind-merge semantics + (for HlmDialog) CDK focus-trap interop.

### Where the deep-dive guidance lives

Several primitives have substantial composition patterns. Read the JSDoc in the source file + the memory before extending: `HlmSidebar` (memos `sidebar_shell_spartan_pattern.md` + `safari_display_contents_flex_bug.md`), `HlmPagination` (memo `client_side_pagination_pattern.md`), `HlmTable` + TanStack (memos `data_tables_spartan_pattern.md` + `tanstack_proxy_onpush_reactivity.md`), `HlmDropdownMenu` / `HlmPopover` / `HlmCalendar` / `HlmDatePicker` (JSDoc only).

**DO NOT run `@spartan-ng/cli ui` generators** — they overwrite hand-rolled primitives + ship Tailwind-4 syntax. See memory `spartan_cli_avoided.md`.

## Repo layout

```
src/app/
  core/         # auth, config, layout, http, guards, payments
  features/     # public/, staff/, admin/ route groups (lazy-loaded)
  shared/       # components, primitives (src/app/shared/ui/), models
                # shared/components/reservation-detail-modal/ is the
                # 4-tab modal used by both Dashboard + staff Reservations
                # (parent owns loading/error state; modal handles tabs +
                # presentation + emits ~14 actions)

backend/lambda/
  index.mjs                         # entry, auth helpers, CORS, router, EventBridge dispatch
  lib/routes-*.mjs                  # route handlers per domain
  lib/services-*.mjs                # business logic per domain (see reservations split below)
  lib/core-utils.mjs                # phone normalization, money helpers, getBody, httpError
  lib/services-rate-limit.mjs       # in-Lambda SMS rate-limit backstop
  lib/services-push-notifications.mjs  # Expo Push dispatcher
  lib/*.test.mjs                    # node:test specs (npm run test:backend)
  table-template.json               # static venue floor plan
  deploy.sh                         # aws lambda update-function-code wrapper

# Reservations/holds module split (refactored 2026-05-09 from a single ~2.6k-line file)
backend/lambda/lib/
  services-reservations-shared.mjs  # utils, history, check-in pass, read-only DDB
  services-payment-recording.mjs    # addReservationPayment + link/Cash App mutators
  services-reservations.mjs         # CRUD, 3 cancellation paths, cron release
  services-holds.mjs                # createHold / releaseHold / listHolds
  services-reservations-holds.mjs   # barrel — public surface for index.mjs

# Anonymous public-booking module (shipped 2026-05-13)
  routes-public-bookings.mjs        # POST/GET /public/reservations[/{id}/{release,wallet-pass}] + GET /p/{slug}
  services-anon-bookings.mjs        # phone-slot registry + verifyCustomerToken
  services-turnstile.mjs            # Cloudflare siteverify (fail-closed)
  services-reservation-codes.mjs    # 6-char codes + 16-char slugs (alphabet excludes 0/O/1/I/L)

backend/cognito-pre-token-gen/      # Cognito Pre Token Gen v2 trigger (separate Lambda)
backend/cognito-customer-auth/      # Cognito Custom Auth phone-OTP triggers
http/*.http                         # smoke tests for IDE HTTP runner
scripts/                            # ops helpers (extract → import → backfill → merge → smoke_test_prod.sh)
```

## Commands

```bash
CI=true npm run build                    # prod build (warns on qrcode CommonJS — known)
npx tsc -p tsconfig.app.json --noEmit    # typecheck
npm run test -- --watch=false            # unit tests (Vitest, src/**/*.spec.ts)
npm run test:backend                     # backend pure-fn tests (node:test, backend/**/*.test.mjs)
npm run test:all                         # both, in sequence
bash backend/lambda/deploy.sh            # deploy lambda (uses default AWS profile)
```

Backend tests use Node 22's built-in `node:test`. `@aws-sdk/*` are devDeps at the repo root; the Lambda nodejs22.x runtime ships those SDKs so they're not bundled. Runtime-only deps (`passkit-generator`) live in `backend/lambda/package.json` and are bundled by `deploy.sh`.

## Auth model — read this before touching auth

- Cognito Hosted UI + code flow + PKCE via `angular-auth-oidc-client`.
- Frontend sends the **access token** via `Bearer` header (`src/app/core/http/auth.interceptor.ts`).
- API Gateway HTTP API has a JWT authorizer per-route. Public routes (no authorizer): `/public/availability`, `/check-in/pass`, `/cashapp/session*`, `/webhooks/square`, `/pay`.
- Lambda re-checks `requireAdmin(event)` / `requireStaffOrAdmin(event)` per sensitive route (defense in depth — do not rely on API Gateway alone).
- Cognito access tokens DO NOT include `cognito:groups` by default. A **Pre Token Generation v2 Lambda trigger** (`backend/cognito-pre-token-gen/`) injects groups into the access token. If disabled/broken, every authed request silently 403s; the `AuthHealthBanner` (driven by `GET /admin/whoami`) surfaces this.
- Groups: `Admin`, `Staff`. Users without a group fall through to `/unauthorized`.
- **Staff pool `us-east-1_Upsi9Q2Tc` is locked to admin-create-only** (2026-05-13): `AdminCreateUserConfig.AllowAdminCreateUserOnly=true`. Hosted UI's "Sign Up" tab is hidden; `cognito-idp:SignUp` API is rejected for non-admins. New staff/admin users created exclusively via the "Invite User" form (`POST /admin/users` → `AdminCreateUserCommand`). Memory: `cognito_pool_locked_admin_create_only.md`. **Customer pool app client `21n3rd1sp4o9ka4l7tld45f0ka` is on a different flow (custom-auth phone-OTP) and unaffected.**
- **Customer auth** (mobile, separate from staff): Custom Auth phone-OTP via `backend/cognito-customer-auth/`. Public mediator routes `POST /auth/customer/start` + `POST /auth/customer/verify` (in `routes-customer-auth.mjs`) wrap the synthetic-email convention. Customer-only routes under `/me/*` (in `routes-me.mjs`) use `requireCustomerOwnership(event)`.
- **Token TTLs** (staff client, set 2026-05-14): access 24h, ID 24h, refresh 30d. Silent renew via refresh token. Bumped from 8h/8h on 2026-05-14 alongside the `SessionWatcher` fix to give backgrounded mobile/desktop tabs a 3× margin against the silent-renew timer being frozen — see `auth_resilience_session_2026_05_14.md`. **OIDC state persisted in localStorage** via `DefaultLocalStorageService` in `app.config.ts` — the library's default (sessionStorage) silently nuked the refresh token on browser restart. See memory `feedback_oidc_default_session_storage.md`.
- `Login` component auto-redirects already-authed users to `/staff/dashboard`; routes `''` and `'home'` both redirect to `/login`. `?reason=session-expired` query param shows a "you were signed out" HlmAlert above the sign-in button — set by `SessionExpiry.notifyExpired()` when refresh definitively fails.
- **`SessionWatcher`** (`src/app/core/auth/session-watcher.ts`) closes the "backgrounded-tab logout" gap: refreshes on `visibilitychange` / `focus` / `pageshow` after ≥60s hidden, runs a 4-min visibility heartbeat that refreshes when access-token has <2 min left, and reacts to `TokenExpired` / `SilentRenewFailed`. Exposes `refreshOnce(source)` — coalesced + 30s-debounced + shareReplay'd — that `AuthInterceptor` uses to retry once on 401. **Phase 1 (2026-05-15)**: refresh path now calls `DirectRefreshClient` (own POST to Cognito `/oauth2/token` with retry on status 0 / 5xx) reading the refresh token from `RefreshTokenVault` (shadow `ff_oidc_rt_shadow_v1` key the library can't wipe), writes new tokens back into library storage via `LibraryStorageBridge`, then `oidc.checkAuth()` re-syncs `isAuthenticated$`. Bootstrap recovery uses the same chain when `checkAuth` resolves with `isAuthenticated=false` but vault has a fresh token. `ff_authed=1` localStorage flag + `authGuard` fires `SessionExpiry.notifyExpired('guard', {skipNavigation: true})` when previously authed but now not — replaces the silent `/login` redirect. Telemetry: `auth_renew_*`, `auth_bootstrap_check`, `auth_session_expired_redirect`, `auth_cognito_observed/token_error`, `auth_shadow_refresh_*`, `auth_shadow_restored` — readouts in `auth_telemetry_cw_query.md`. Full Phase 0+1 arc: [[auth_phase_0_1_session_2026_05_15]].
- **Embedded login (Path 3) is locked in** — comprehensive plan at [[phase_3_embedded_login_plan_2026_05_15]]. Replaces Hosted UI redirect with an in-app branded form using `aws-amplify/auth` v6 (verified bundle 184 KB / Promise API / typed `nextStep` enum). 6 deploys, ~28–38 hours. Starts Monday 2026-05-18 after Saturday telemetry review. UX-driven (Hosted UI flash is unacceptable to user) — happens regardless of whether Phase 1 silenced the renew failures. Test user `c4a85468-c0f1-7055-0ea3-d7df2dd9694a` is in `RESET_REQUIRED` — forgot-password flow must work end-to-end before Deploy 4 cutover. Supersedes [[embedded_login_path_3_planned]].

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

Tables: `EVENTS_TABLE`, `HOLDS_TABLE`, `RES_TABLE`, `FREQUENT_CLIENTS_TABLE`, `CLIENTS_TABLE`, `CHECKIN_PASSES_TABLE`, `SETTINGS_TABLE`. Cognito: `USER_POOL_ID`. Square: `SQUARE_SECRET_ARN`, `SQUARE_ENV`, `SQUARE_LOCATION_ID`, `SQUARE_API_VERSION`, `SQUARE_WEBHOOK_NOTIFICATION_URL`, `SQUARE_CURRENCY`, `SQUARE_CHECKOUT_REDIRECT_URL`, `SQUARE_LINK_ENABLE_*`. SMS: `SMS_ENABLED`, `SMS_SENDER_ID`, `SMS_TYPE`, `SMS_MAX_PRICE_USD`. Payment links: `PAYMENT_LINK_TTL_MINUTES`, `FREQUENT_PAYMENT_LINK_TTL_MINUTES`, `AUTO_SEND_SQUARE_LINK_SMS`, `CASH_APP_LINK_BASE_URL`. Check-in: `CHECKIN_PASS_BASE_URL`, `CHECKIN_PASS_TTL_DAYS`. Wallet: `WALLET_PASS_TYPE_IDENTIFIER`, `WALLET_TEAM_IDENTIFIER`, `WALLET_PASS_SECRET_ARN` + optional brand overrides. Operating: `OPERATING_TZ`, `OPERATING_DAY_CUTOFF_HOUR`, `HOLD_TTL_SECONDS`. **Anon public-booking:** `TURNSTILE_SECRET_ARN` (Turnstile secret in Secrets Manager; site key is admin-writable), `PUBLIC_BOOKING_RETURN_BASE_URL` (web host for `/r/{id}` SPA URLs), `PUBLIC_BOOKING_SHORT_URL_BASE` (flipped to `https://famosofuego.com` in prod 2026-05-13 — branded `/p/{slug}` URLs via the Amplify rewrite to `api.famosofuego.com`; code default is still the API host so it stays safe if unset). Used for the Square `customerReturnUrl`, response `shortUrl`, `payment_note` recovery line, and slug-based pass URL.

## Frontend config

`src/app/core/config/app-config.ts` hardcodes `apiBaseUrl: https://api.famosofuego.com` + Cognito authority / hostedUiDomain / clientId / scope. No per-env config yet.

## Conventions

- **Money in app code is dollars** (number, 2 decimals). Square API expects minor units — conversion lives in `services-square-payments.mjs`.
- **Phone numbers stored E.164** (`+1...` or `+52...`). Search uses candidate fan-out (`buildPhoneSearchCandidates`). Inputs <4 digits return empty.
- **CRM dedup is phone-only** by design (PK=`PHONE#{key}`). Same person via two phones = two rows on purpose. Mitigation is the staff form's typeahead, not fuzzy-merge. Ad-hoc cleanup via `scripts/merge_pair.mjs`. See memory `feedback_crm_dedup_phone_only.md`.
- **Times**: epoch seconds for `expiresAt`/`issuedAt`; deadlines as `YYYY-MM-DDTHH:mm:ss` local-iso + IANA tz string. Default tz `America/Chicago`.
- **Venue takes forward bookings** — every reservation is for a future `eventDate`. Date-range filters on admin views (Financials, future reports) MUST NOT cap the upper bound at "today" by default — that filter would always be empty in the typical case. See memory `financials_reducer_invariants.md` for the Financials default-range convention.
- **Errors**: raise via `httpError(status, message)` from `core-utils.mjs`; the router's outer `try/catch` formats the response.
- **Reservation enums**: `paymentStatus` ∈ `{PENDING, PARTIAL, PAID, COURTESY, REFUNDED}`; `paymentMethod` ∈ `{cash, square, cashapp, credit}`; `status` ∈ `{CONFIRMED, CANCELLED}`; `lockType` ∈ `{HOLD, RESERVED}`; cancellation `resolutionType` ∈ `{CANCEL_NO_REFUND, RESCHEDULE_CREDIT, REFUND}`. REFUND iterates `payments[]`, refunds each via Square, then sets `paymentStatus=REFUNDED`. Partial failure throws 502 without cancelling (operator must reconcile).
- **Multi-table bookings**: row carries `tableIds: string[]` + `tablePrices: number[]` plus legacy scalar `tableId`/`tablePrice` (= first / sum). One reservation = one customer = one deposit = one Square link / SMS / check-in pass / Wallet pass listing every table. Cap: 10/booking (4/booking for anonymous public). **Every reader prefers `tableIds[]` then falls back to `[tableId]`; every writer stamps both.** Shared helpers: `getReservationTableIds`/`normalizeIdList`/`formatTablesLabel` in `services-reservations-shared.mjs`, plus the Angular `TableLabelPipe` / `formatTableLabel{,Lower}` in `src/app/shared/table-label.pipe.ts` — the ONLY places that should branch on length. Mobile customer flow is single-table only in v1.
- **Customer-facing IDs are short**, internal IDs are full. Anonymous public bookings mint a 6-char `confirmationCode` ("FF-K7M3X2") for human readability + a 16-char `publicSlug` for `/p/{slug}` short URLs. The 36-char UUID + 64-char customerToken stay internal. Receipts, /r page header, and SMS/WhatsApp links all use the short forms; staff search accepts the code too. **Check-in pass URL also uses the slug** when the reservation has one — `pass.url` becomes `${PUBLIC_BOOKING_SHORT_URL_BASE}/p/{slug}?to=pass` instead of the legacy long-token form (`/check-in/pass?token={64-hex}`). Pass record stamps `publicSlug` + `confirmationCode` at issuance so `toPassResponse` builds the slug URL without an extra DDB read. Legacy staff-created reservations (no slug) keep the long token URL — both formats work indefinitely. Generators + alphabets in `services-reservation-codes.mjs` (excludes 0/O/1/I/L). See [[anon_public_booking_implementation_2026_05_13]].
- **Signals + `ChangeDetectionStrategy.OnPush` everywhere.** All 16 feature components are on OnPush as of 2026-05-13. Two patterns: **bare signals** (`readonly foo = signal(...)`, template `{{ foo() }}`) for new code; **signal-backed accessors** (reservations-new only) when a spec needs the property shape. Record/Set state mutates via `.update(c => ({ ...c, [k]: v }))` (copy-on-write). Nullable modal items wrap in `*ngIf="signal() as ref"`. See memory `signals_onpush_migration_status_2026_05_13.md` for recipe + script approach for large files.
- **SMS templates start with `Famoso Fuego: ` brand prefix.** Exported as `BRAND_PREFIX` from `backend/lambda/lib/services-sms-notifications-pure.mjs`; all 3 builders (`buildPaymentLinkMessage`, `buildPaymentLinkExpiredMessage`, `buildCheckInPassMessage`) carry it. Required by AWS carrier review (2026-05-14 TFN rejection flagged Sample 2 for missing sender identification — see [[sms_brand_prefix_session_2026_05_14]]). Changing the prefix means also updating the registered Message Samples in AWS End User Messaging — drift between code + samples risks re-rejection on future re-reviews. Customer OTP path (`backend/cognito-customer-auth/index.mjs`) has the brand inline in the message string instead of using `BRAND_PREFIX`; both forms satisfy the rule.
- **`.sr-only` = Tailwind 3 built-in.** Don't roll a custom screen-reader-only class.
- **Empty-state rows on filtered lists get `aria-live="polite"`** so AT users hear the count change after a filter mutation.

## Known gotchas

- `qrcode` triggers a CommonJS optimization warning during build — cosmetic, ignore.
- Tests use Vitest with a shared OIDC mock at `src/app/testing/oidc-mock.ts`. If your component injects `OidcSecurityService`, use `provideMockOidc()` + `provideRouter([])`. For per-test control of `isAuthenticated$` / `getIdToken()`, provide your own stub. AuthService logout test stubs `window.location` via `Object.defineProperty` because jsdom's `Location.replace` is non-configurable.
- Functional `CanMatchFn` guards tested via `TestBed.runInInjectionContext(() => guard(null as any, []))`. HTTP wrappers tested by faking `ApiClient`, not `HttpClient`. `ApiClient` itself tested via `HttpTestingController` (retry on GET 5xx + status 0 only).
- `backend/lambda/function.zip` is the built artifact — never commit. `backend/lambda/code_url.txt` may contain a presigned S3 URL — never commit.
- `auth-callback.ts` reads groups from the **ID token**; API calls use the **access token**. Keep them in sync.
- API Gateway routes are explicit (no `$default` proxy). Adding a backend route is THREE steps: (1) handler in `lib/routes-*.mjs`, (2) `apigatewayv2 create-route` (JWT authorizer `5ea6tk` or NONE), (3) `lambda add-permission` with `source-arn` matching the route path. **Skip (3) and API GW returns 500 with no Lambda logs** — silent failure mode. Hit twice on public-bookings + by-code rollouts.
- **`*ngFor` with template method calls is an anti-pattern** — CD re-invokes them every cycle; iOS Chrome drops the trailing touchend. Memoize + use `trackBy`. See memory `feedback_ngfor_no_template_methods.md`.
- **Lines that start with `=` in `.html` templates** are corrupted bindings (usually `[active]` whose attribute name got stripped). Angular parses them as a string attribute called `""` and silently does nothing — toggle stays dead. Hit twice in 2026-05-12. Grep `find src -name '*.html' -exec grep -l '^=' {} \;` before shipping any HlmToggle-heavy page. Memory: `feedback_stripped_active_bindings.md`.
- **`@angular/cdk` is pinned to exact `21.1.6`** — do NOT bump alone (breaks AOT). To upgrade, bump every `@angular/*` package to a matching 21.2 minor together. See [[cdk_21_1_pin_for_dialog_eager_strategy]].
- **`createReservation` accepts a caller-supplied `payload.reservationId`** — anon-public pre-mints UUID + customerToken + confirmationCode + publicSlug upfront so the Square `payment_note` lookup matches at webhook time. Skipping this caused a real customer's payment to be silently dropped (`reservation_update_ignored`) — see [[incident_2026_05_13_day_paid_but_cancelled]] + [[anon_public_booking_implementation_2026_05_13]].
- **Customer-facing copy in Square `payment_note`** (visible on receipts + Cash App): use `Booking #FF-<code> • <date>` framing, not operator-internal labels. Webhook handler accepts both old + new note formats — see [[anon_public_booking_implementation_2026_05_13]].
- **`cancelReservation(eventDate, reservationId, tableId, user, reason, options)` is POSITIONAL.** Object-arg form silently 400s. tableId can be `null` (function derives release list from `reservation.tableIds`). Test mocks must mirror the real signature.
- **`/p/{slug}` is served by Lambda but customers hit `https://famosofuego.com/p/{slug}`.** Amplify rewrite rule (status 200, server-side proxy) routes to `api.famosofuego.com/p/{slug}`. Order matters: `/p/<*>` must precede the `/<*>` SPA fallback in `aws amplify get-app --app-id d1gxn3rvy5gfn4 --query 'app.customRules'`. Legacy `api.famosofuego.com/p/{slug}` URLs in old customer inboxes still work — both hit the same handler.
- **`tsc --noEmit` doesn't run Angular template typecheck.** Bare boolean attributes (`<hlm-confirm-dialog destructive ...>`) pass tsc but fail at Amplify's `ng build` (~4 min cycle wasted). Always run `CI=true npm run build` before pushing. Bare-boolean fix: `[destructive]="true"`. See [[feedback_tsc_misses_template_typecheck]].
- **`takeUntilDestroyed()` without an arg requires injection context.** Calling it inside an event handler (e.g. `submit()`) throws synchronously; the HTTP error never propagates and the button stays in "Submitting…". For event-handler use, inject `DestroyRef` at construction and pass it explicitly: `.pipe(takeUntilDestroyed(this.destroyRef))`.
- **`computed()` doesn't track legacy `@Input` reads** — only signals. Computeds reading `this.someInput` memoize on first render and never refresh when the parent updates the binding. Migrate to `input()` (Angular 17+ signal-input API) or convert the computed to a plain method. Hit on `<reserve-table-modal>` (totalAmount memoized stale, showed wrong totals).
- **Cognito Hosted UI `logout_uri` requires a string-exact LogoutURLs match.** Always build via `buildRedirectUrl(APP_CONFIG.cognito.postLogoutPath)` (origin + `/login`). When adding a new host, register `${origin}/login` in LogoutURLs BEFORE shipping. See [[cognito_logout_uri_gotcha]].
- **`angular-auth-oidc-client` wipes refresh token from localStorage on ANY internal failure** (`resetAuthorizationData` at library line 2371). Once wiped, every renew throws `'no refresh token found, please login'` synchronously — no HTTP call, no retry path. Phase 1's `RefreshTokenVault` keeps a shadow copy outside the library's key namespace so `SessionWatcher` + bootstrap can recover. Never call `forceRefreshSession()` directly — use `SessionWatcher.refreshOnce()` which goes through the resilient `DirectRefreshClient` path. See [[phase_1_auth_resilience_plan_2026_05_15]].
- **US-bound SMS silently drops while TFN is PENDING.** MX delivers fine. Self-resolves on TFN ACTIVE. Don't pin OriginationIdentity for `+52` numbers. See [[sms_us_blocked_mx_works_root_cause]].
- **SMS transport: SNS today, EUM `SendTextMessageCommand` planned post-TFN ACTIVE.** Don't touch during carrier re-review. See [[sms_migrate_to_eum_after_approval]].

## Wiring outside this repo

**In place:** Cognito Pre Token Gen v2 (`ff-reservations-pretoken`); EventBridge `ff-reservations-overdue-release` (rate 1 min → `runScheduledMaintenance`); API GW JWT authorizer `5ea6tk` on every non-public route; DDB PITR on `ff-reservations`, `ff-table-holds`, `ff-clients`, `ff-checkin-passes` (35-day); CloudWatch alarm family `ff-res-*` → SNS `ff-res-ops-alerts` (Lambda errors/throttles/duration-p95/DLQ, SMS errors, history-write failures, auto-refund failed, refund orphaned, `ff-res-update-ignored-5m` for Day-shape orphan early-warning, plus 2026-05-14 additions `ff-res-active-hold-spike-5m` + `ff-res-turnstile-failed-5m` derived from the new funnel telemetry); CloudWatch dashboard `ff-saturday-funnel` (source-of-truth JSON in `scripts/cloudwatch-dashboards/`); SQS DLQ `ff-reservations-api-dlq` (14-day); log-metric filters in `FFReservations/*` namespaces (Funnel/* added 2026-05-14); API GW `$default` stage `DetailedMetricsEnabled=true` + throttle `200 burst / 100 rate`; SNS SMS delivery logging at 100% → `sns/us-east-1/.../DirectPublishToPhoneNumber{,/Failure}`. Per-alarm playbook: [[saturday_operational_runbook]].

**Missing (Phase 3+):** AWS WAF v2; AWS End User Messaging Configuration Set; toll-free `+18557656160` (carrier review per [[tfn_registration_submitted_2026_05_13]]); SNS `MonthlySpendLimit` aligned to EUM cap; IaC baseline.

## Where to look first

- **New lambda route** → register in `backend/lambda/lib/routes-*.mjs`, wire into `index.mjs` router, add a smoke `.http` file. Also `aws apigatewayv2 create-route` per the Auth section.
- **New frontend feature** → standalone component under `src/app/features/`, register in `src/app/app.routes.ts` with the right guards. Authed routes render *inside* `<main hlmSidebarInset>` (full inset width minus `p-3 md:p-4`); don't add page-level horizontal padding.
- **Touching the shell** (topbar / sidebar / inset) → see [[sidebar_shell_spartan_pattern]] (gap-div + fixed-container) and [[safari_display_contents_flex_bug]] (use real flex, not `display:contents`). **Topbar is `position:fixed`, not sticky** ([[topbar_uses_position_fixed]]): wrapper has `pt-14`; sidebar's fixed `top: var(--header-height)` mirrors. If topbar height changes from `h-14`, update BOTH `pt-14` and `--header-height: 3.5rem`.
- **Touching `reservations-new.ts`** (staff Hold & Reserve) → main file orchestrates; 5 sibling helper files; 12 specs. OnPush + signal-backed accessors; computeds (not methods). Full conventions + multi-table UX (TableLabelPipe; never `{{ tableId }}` directly): [[reservations_new_audit_2026_05_13]] + [[reservations_new_signals_onpush_2026_05_13]].
- **Reservation detail modal** → shared at `src/app/shared/components/reservation-detail-modal/`. Parent owns loading/error/notice state + emits ~14 actions; modal owns 4-tab UI + predicates + formatters. Shared types in `src/app/shared/models/reservation-detail.model.ts`. Don't duplicate the template.
- **Reservation backend** → see Repo layout for the 5-module split. Read existing TransactWrite + ConditionExpression patterns before new writes.
- **`financials.ts`** (admin) → 6 pure reducers (`buildRows / buildReceivables / buildEventSummaries / buildOverview / buildMethodTotals / buildPaymentLedger`); 23 spec tests lock refund + credit + cashapp invariants. Calls `list(date, { suppressRelease: true })` to skip per-event overdue release on read — keep that flag. See [[financials_reducer_invariants]].
- **`/admin/settings`** → 8 collapsible sections; OnPush form + `FIELD_HINTS` map for unit-aware errors; `joinHm`/`splitHm` bridge UI HH:MM ↔ wire hour+minute; HIGH_IMPACT_LABELS gate flip-on with bulleted confirm; `squareEnvLabel()` translates wire `production/sandbox` → UI `Live/Test`. Admin copy must follow [[feedback_admin_copy_plain_language]]; full session [[settings_admin_friendly_overhaul_2026_05_14]].
- **Payments** → `services-square-payments.mjs` + `routes-square-webhooks.mjs`. 6 staff/customer payment routes in `routes-reservations-holds.mjs` share the `autoRefundAfterRecordFailure` safety net (idempotency-keyed by Square paymentId). Customer-mobile equivalent in `routes-me.mjs` — audit BOTH when changing payment behavior. Push notifications fire from `addReservationPayment` via `services-push-notifications.mjs` (Expo).
- **SMS notifications** → 3 pure builders in `services-sms-notifications-pure.mjs` (all branded via `BRAND_PREFIX`, carrier-required); SNS `PublishCommand` today, EUM-migration planned post-TFN [[sms_migrate_to_eum_after_approval]]. Customer OTP is a separate file `cognito-customer-auth/index.mjs` — when changing SMS behavior, touch BOTH. Kill-switch: `smsEnabled` in `ff-settings` (transactional only, not OTP). Brand-prefix + multi-table specs in `services-sms-notifications-pure.test.mjs`.
- **Apple Wallet `.pkpass`** → `services-wallet-pass.mjs` via `passkit-generator`; certs in Secrets Manager (`WALLET_PASS_SECRET_ARN`); assets in `backend/lambda/assets/wallet-pass/`. **`pass.type = "generic"`** (no notch); QR `message` is `ffr-checkin:{64-hex token}` (security primitive — never the 6-char code); `barcode.altText` is `FF-{confirmationCode}` (or UUID fallback). Already-installed passes don't auto-refresh. Regenerate recipe + tokens: [[wallet_pass_logo_placeholder]] + [[wallet_pass_polish_session_2026_05_14]].
- **Customer self-service (`/me/*`)** → single file `routes-me.mjs`. Booking → payment (3 paths) → check-in pass → wallet pass. Self-cancel ≥24h forces `RESCHEDULE_CREDIT`. **Customer payment routes must NOT pass `source: "customer"` to `addReservationPayment`** — string isn't in the allowed enum; omit and let it default to `square-direct`.
- **Anonymous public booking** (`/public/reservations/*`, `/p/{slug}`, `/r/{id}`, `/public/lookup-by-{phone,code}`, `/public/telemetry`) → entry `routes-public-bookings.mjs`. Pre-mint reservationId + customerToken + confirmationCode + publicSlug upfront (`createReservation` accepts all four). Phone slot at `(PK="RATE", SK="ANONHOLD#{phoneKey}")` enforces 1 active unpaid hold per phone; cleared on payment (so paid recovery uses `/public/lookup-by-code`, not `lookup-by-phone`). Behind `allowAnonymousPublicBooking` flag (default false). Full impl + per-feature commits: [[anon_public_booking_implementation_2026_05_13]] + [[public_map_audit_session_2026_05_13_evening]] + [[public_map_tier_a_b_session_2026_05_14]] + [[find_by_code_tier_s_2026_05_14]].
- **Staff lookup by FF-XXXXXX code** → `GET /reservations/by-code/{code}` (staff-auth) in `routes-reservations-holds.mjs`. Strips a "FF-" prefix and uppercases before resolving via `lookupReservationByConfirmationCode`. Frontend mini-form on /staff/reservations switches `filterDate` to the reservation's eventDate and opens the existing detail modal. The same in-table filter input now also matches `confirmationCode` (instant filter on the loaded event, complements the cross-date search). FF-XXXXXX chip is rendered in the detail modal header + dashboard urgent-payment cards so staff can verify the code matches. Hidden when `reservation.confirmationCode` is null (staff-created bookings never have one). New API GW route `pu1v4pc` registered 2026-05-13.
- **Saturday-night ops** → run `bash scripts/smoke_test_prod.sh` (19 checks, exits non-zero on fail). Night before: `bash scripts/saturday_eve_check.sh [YYYY-MM-DD]`. Dashboard: `ff-saturday-funnel`. Alarm-by-alarm playbook + customer-issue flowchart [[saturday_operational_runbook]]; orphan recovery [[incident_2026_05_13_day_paid_but_cancelled]]; funnel readout query in [[saturday_operational_runbook]].
- **CRM clients** → `services-clients.mjs` + `routes-clients.mjs`. `GET /clients/search?phone=…&q=…` (staff); `POST /clients/bulk-import` (admin, ≤500/req, conditional Put). `upsertCrmClient` is the live-reservation path.
- **Auditing auth** → Auth Model section above + `index.mjs:97-174` for `getGroupsFromEvent` / `requireAdmin` / `requireStaffOrAdmin` / `requireCustomerOwnership`.
- **Diagnostic queries** → SMS delivery: `sns/us-east-1/908027422124/DirectPublishToPhoneNumber{,/Failure}` log groups. Cron heartbeat: `aws logs filter-log-events --log-group-name /aws/lambda/ff-reservations-api --filter-pattern "scheduled_maintenance"`. Production health: `bash scripts/smoke_test_prod.sh`.
- **Debugging an iOS-Chrome-only bug** → visit `/?debug=1` (gated by `localStorage.ff-debug=1`). Loads eruda + injects a counter panel for touch/pointer/click/viewport + OIDC lifecycle events. Disable: `/?debug=0`.
