# FF Reservations — Project Context

Restaurant table reservation system for Famoso Fuego. Staff create reservations on behalf of customers; customers pay via Square / Cash App link and self-check-in via QR codes. Admin manages frequent clients, events, settings, and financials.

> **Branch state (2026-05-14):** `main` runs the Angular 21 SPA in prod with anonymous public-booking live behind `allowAnonymousPublicBooking`. Customers self-book on `/map` (rebranded "Famoso Fuego — Reservations") → Square hosted checkout → `/r/{id}` (countdown, self-release, Wallet pass, differentiated CANCELLED). Short URLs are branded `https://famosofuego.com/p/{slug}` via Amplify rewrite → `api.famosofuego.com/p/{slug}`. Staff find by FF-XXXXXX via `/staff/reservations` search + table filter. Customers who lost their /r URL recover via "Find my reservation" (outline button on /map header) — tabbed modal supports **phone** (active hold only) OR **booking code FF-XXXXXX** (any non-CANCELLED state, the path that covers paid customers). Modal sheet has sticky header + footer + safe-area insets so the close X is always reachable on mobile. Pending-hold banner offers Continue + Release (no more silent-Hide trap). Modal recovers from `ACTIVE_HOLD_EXISTS` 429s by surfacing the existing hold + a release CTA. Funnel telemetry on every step (FE + BE) — `frontend_funnel_event` + `public_booking_event` in CloudWatch. Production smoke test: `bash scripts/smoke_test_prod.sh` (19 checks). Full implementation: [[anon_public_booking_implementation_2026_05_13]]; Saturday-readiness arc + per-feature commits: [[public_map_audit_session_2026_05_13_evening]] + [[public_map_tier_a_b_session_2026_05_14]] + [[find_by_code_tier_s_2026_05_14]]; ops runbook: [[saturday_operational_runbook]]. React + Expo port paused on the `react` branch (tag `react-port-snapshot-2026-05-09`). Do not introduce React, pnpm, Vite, or `apps/`/`packages/` changes on `main`.

> **Lambda Square env — PRODUCTION as of 2026-05-11.** `ff-reservations-api` runs against production Square. Real cards / Cash App charges fire. **Open verification item:** production Square webhook subscription must point at `https://api.famosofuego.com/webhooks/square` with `payment.created` + `payment.updated` events; signature key in the production secret. Without that, real payments succeed at Square but reservations don't auto-flip to PAID. Full env IDs + sandbox revert procedure in memory `lambda_square_env_production_cutover.md`.

> **Companion mobile app (sandbox dev loop paused):** Customer-facing iOS/Android app lives in `github.com/alekscortez/ff-customer-mobile` (Expo SDK 54). Resume options tracked in memory `ff_customer_mobile_status.md`.

## Stack

- **Frontend** (Angular 21 standalone, Tailwind 3.4, `angular-auth-oidc-client` v21, ZXing, qrcode, `@ng-icons/lucide`, Spartan primitives at `src/app/shared/ui/`). **Backend** (AWS Lambda Node 22 ESM, API GW HTTP API, DynamoDB, Cognito Hosted UI + customer phone OTP, Square API + webhook, SNS SMS, Secrets Manager). **Hosting** Amplify for SPA (npm + `ng build` → `dist/ff-reservations/browser/`); custom domain `api.famosofuego.com` for API; `amplify.yml` pins npm via `corepack prepare npm@11.6.2` — see [[amplify_corepack_npm_pin]].

## UI primitives — read before adding new UI

Eleven Spartan-style primitive families under `src/app/shared/ui/`. Each is a standalone Angular directive/component with `cva` variants + `tailwind-merge` for consumer-class overrides. **Use them instead of hand-rolling Tailwind class strings.**

| Primitive | Selector | Variants / sizes | When to use |
|---|---|---|---|
| `HlmButton` | `button[hlmBtn]`, `a[hlmBtn]` | `default \| outline \| outline-current \| secondary \| ghost \| destructive \| link` × `default \| xs \| sm \| lg \| icon \| icon-xs \| icon-sm \| icon-lg` | All action buttons. `outline-current` inherits parent text color. |
| `HlmBadge` | `[hlmBadge]` | `default \| secondary \| outline \| destructive \| success \| warning \| danger` × `default \| sm \| xs` | Status pills. Use `outline` inside colored cards. |
| `HlmInput` | `input[hlmInput]`, `select[hlmInput]`, `textarea[hlmInput]` | `default \| sm \| lg` | Form text inputs / selects / textareas. NOT checkboxes/radios. Prefer `<hlm-native-select>` over `<select hlmInput>` for new code — same native picker UI but with the Spartan chevron overlay. |
| `HlmNativeSelect` | `<hlm-native-select>` with projected `<option>` children | `default \| sm` | Wraps `<select>` with `appearance-none`, Spartan chevron icon overlay, CVA. Uses platform native dropdown (familiar on mobile, free a11y) — for a custom-rendered dropdown, see follow-up `brn-select`-based work. Two-way `[(value)]` + `(change)` (user-only) + standard `[formControl]` / `formControlName`. |
| `HlmDialog` | `<hlm-dialog>` | sizes + `panelClass` + optional `ariaLabel` / `ariaLabelledBy` inputs | All modals. `sheet` = slide-from-edge with `max-h-[100dvh]` + `pt-/pb-env(safe-area-inset-*)` so panel never overflows the viewport on mobile (close button stays reachable). Pair with `sticky top-0 z-10 bg-white` on header + `sticky bottom-0` on footer for long content. `ariaLabel` for static titles; `ariaLabelledBy` + heading `id` for dynamic ones. |
| `HlmConfirmDialog` | `<hlm-confirm-dialog>` | `[title] [message] [confirmText] [cancelText] [loadingText] [destructive] [loading]` + `(confirm) (cancel)` | Yes/no dialogs; replaces `window.confirm()`. `title` auto-wires to HlmDialog's `aria-label`. Form-prompts compose `<hlm-dialog>` directly. |
| `HlmToggle` | `button[hlmToggle]` | `default \| outline \| warning` × `[active]` | Toggle pills. Caller manages `[active]`. |
| `HlmAlert` | `<hlm-alert>` | `info \| success \| warning \| destructive` | Inline tinted alert boxes. Widely used for page-level notice/error banners (`role="alert"` baked in). |
| `HlmAvatar` | `<hlm-avatar>` + `img[hlmAvatarImage]` + `span[hlmAvatarFallback]` | sizes: `sm \| default \| lg` (size-6/8/10). Default `rounded-full`; override to `rounded-lg`. | Photo tile + initials fallback. Image auto-hides until `load`; falls back on `error`. |
| `HlmSidebar` (compound) | `<hlm-sidebar>` + slots + `[hlmSidebarWrapper]` / `[hlmSidebarInset]` / `[hlmSidebarTrigger]` | desktop gap-div + fixed container; mobile fixed `<aside>` (NOT HlmDialog); cookie-persisted; Cmd/Ctrl+B | Staff/admin shell only. Feature routes render *inside* the inset. |
| `HlmPagination` (compound) | `<hlm-numbered-pagination>` wrapper, or low-level pieces | Two-way `[(currentPage)]` + `[(itemsPerPage)]` model signals + `[totalItems]`. Sliding window with ellipses, default `maxSize=7`. Event-only (no RouterLink). | Long client-side lists. See admin Clients page (1,400+ rows, 50/page). |
| `HlmTable` (compound) | `<div hlmTableContainer>` + `<table hlmTable>` + `hlmTHead/TBody/TFoot/Tr/Th/Td/Caption` + `<hlm-table-sort-header>` | Pure CSS classes on plain `<table>` markup; sort-header composes with TanStack `Column<T>` | Lists needing sort / filter / pagination. Pair with `@tanstack/angular-table`. |
| `HlmDropdownMenu` (compound) | `[hlmMenuTriggerFor]` + `[hlmMenu]` in an `<ng-template>` + `button[hlmMenuItem]` (`variant="default \| destructive"`) + `button[hlmMenuCheckbox]` + `<hlm-menu-separator>` + `[hlmMenuLabel]` | Wraps `@angular/cdk/menu`: arrow-key nav, Esc dismiss, focus return. Renders into overlay portal. | Row actions, context menus, multi-select toggles. |
| `HlmPopover` (compound) | `<brn-popover>` + `button[brnPopoverTrigger]` + `<ng-template brnPopoverContent>` + `[hlmPopoverContent]` directive on the rendered panel | Wraps `@spartan-ng/brain/popover` (CDK overlay) with `role="dialog"` + `z-[210]` (above HlmDialog z-[200]) + brand-styled card chrome. Auto-closes on outside click / Escape; restores focus. | Floating panels anchored to a trigger — date pickers, mini-forms, inline help. |
| `HlmCalendar` (compound) | `<hlm-calendar>` (single) and `<hlm-calendar-range>` (range) + `[hlmCalendarCellButton]` directive on the cell button. Forwards brain inputs via `hostDirectives`: `min`, `max`, `disabled`, `dateDisabled`, `weekStartsOn`, `defaultFocusedDate` + (single) `[(date)]` or (range) `[(startDate)] [(endDate)]`. | Headless brain handles arithmetic + selection cycle + arrow/Home/End keyboard nav + a11y; we own visual chrome and per-cell state classes (selected / start / end / between / today / outside / disabled). Provides `BrnNativeDateAdapter` + default i18n at component scope. | Always-visible month grid, or composed into HlmDatePicker. |
| `HlmDatePicker` (compound) | `<hlm-date-picker>` (single `[(date)]`) and `<hlm-date-range-picker>` (range `[(startDate)] [(endDate)]`). Common inputs: `placeholder`, `format(date)`, `min`, `max`, `dateDisabled`, `weekStartsOn`, `disabled`. Range adds `openEndedLabel` + a Reset button in the popover footer. | Triggers an outline button showing the formatted label (`Pick a date` / `Apr 13, 2026 – Open-ended` / `Apr 13, 2026 – May 20, 2026`); opens HlmPopover with the calendar inside; range follows the brain click cycle (1st click = start, 2nd = end, 3rd = reset). | Filter ranges (admin Financials), single-date pickers. **Open-ended end is intentional** — set start, dismiss the popover, label becomes `start – {openEndedLabel}`. |

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
- **`SessionWatcher`** (`src/app/core/auth/session-watcher.ts`) closes the "backgrounded-tab logout" gap: refreshes the OIDC session on `visibilitychange` / `focus` / `pageshow` after ≥60s hidden, runs a 4-min visibility heartbeat that refreshes when access-token has <2 min left, and reacts to `TokenExpired` / `SilentRenewFailed`. Exposes `refreshOnce(source)` — coalesced + 30s-debounced + shareReplay'd — that `AuthInterceptor` uses to retry once on 401 (refresh + re-attach Bearer + replay; second 401 surfaces the original error and calls `SessionExpiry.notifyExpired('interceptor')` *only if* the request had an initial access token). Bootstrap `checkAuth()` retries once on transient errors (status 0 / 5xx) before resolving. Renew telemetry: `auth_renew_started/succeeded/failed`, `auth_bootstrap_check`, `auth_session_expired_redirect` — readouts in `auth_telemetry_cw_query.md`.
- **Embedded login (Path 3) is planned** — replace Hosted UI redirect with an in-app SRP form, no hop. Not started; full implementation plan + edge cases captured in memory `embedded_login_path_3_planned.md`. Do not begin without explicit go-ahead. Note: `aws@redbone.mx` is currently in `PASSWORD_RESET_REQUIRED` status — that flow needs to work before any cutover.

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
- **`.sr-only` = Tailwind 3 built-in.** Don't roll a custom screen-reader-only class.
- **Empty-state rows on filtered lists get `aria-live="polite"`** so AT users hear the count change after a filter mutation.

## Known gotchas

- `qrcode` triggers a CommonJS optimization warning during build — cosmetic, ignore.
- Tests use Vitest with a shared OIDC mock at `src/app/testing/oidc-mock.ts`. If your component injects `OidcSecurityService`, use `provideMockOidc()` + `provideRouter([])`. For per-test control of `isAuthenticated$` / `getIdToken()`, provide your own stub. AuthService logout test stubs `window.location` via `Object.defineProperty` because jsdom's `Location.replace` is non-configurable.
- Functional `CanMatchFn` guards tested via `TestBed.runInInjectionContext(() => guard(null as any, []))`. HTTP wrappers tested by faking `ApiClient`, not `HttpClient`. `ApiClient` itself tested via `HttpTestingController` (retry on GET 5xx + status 0 only).
- `backend/lambda/function.zip` is the built artifact — never commit. `backend/lambda/code_url.txt` may contain a presigned S3 URL — never commit.
- `auth-callback.ts` reads groups from the **ID token**; API calls use the **access token**. Keep them in sync.
- API Gateway routes are explicit (no `$default` proxy). Adding a backend route is THREE steps: (1) handler in `lib/routes-*.mjs`, (2) `aws apigatewayv2 create-route --target integrations/0bj43cm --authorization-type JWT --authorizer-id 5ea6tk` (or NONE for public), (3) `aws lambda add-permission --function-name ff-reservations-api --statement-id apigw-<route>-$(date +%s) --action lambda:InvokeFunction --principal apigateway.amazonaws.com --source-arn "arn:aws:execute-api:us-east-1:908027422124:oxk1adhl3a/*/*/<path/with/{params}>"`. **Skip (3) and API GW returns 500 with no Lambda logs** — silent failure mode. Hit twice on the public-bookings + by-code rollouts.
- **`*ngFor` with template method calls is an anti-pattern** — CD re-invokes them every cycle; iOS Chrome drops the trailing touchend. Memoize + use `trackBy`. See memory `feedback_ngfor_no_template_methods.md`.
- **Lines that start with `=` in `.html` templates** are corrupted bindings (usually `[active]` whose attribute name got stripped). Angular parses them as a string attribute called `""` and silently does nothing — toggle stays dead. Hit twice in 2026-05-12. Grep `find src -name '*.html' -exec grep -l '^=' {} \;` before shipping any HlmToggle-heavy page. Memory: `feedback_stripped_active_bindings.md`.
- **`@angular/cdk` is pinned to exact `21.1.6`** — do NOT bump. CDK 21.2 uses `ChangeDetectionStrategy.Eager` which only `@angular/core@21.2+` can resolve. Brain primitives' `popover` / `dialog` import `@angular/cdk/dialog` — bumping CDK alone breaks the AOT build with `Unsupported change detection strategy`. To upgrade, bump every `@angular/*` package to a matching 21.2 minor together. Memory: `cdk_21_1_pin_for_dialog_eager_strategy.md`.
- **`createReservation` accepts a caller-supplied `payload.reservationId`** — anon-public pre-mints UUID + customerToken + confirmationCode + publicSlug upfront so the Square `payment_note` lookup matches at webhook time. Skipping this caused a real customer's payment to be silently dropped (`reservation_update_ignored`) — see [[incident_2026_05_13_day_paid_but_cancelled]] + [[anon_public_booking_implementation_2026_05_13]].
- **Customer-facing copy in Square `payment_note`** (visible on receipts + Cash App): use `Booking #FF-<code> • <date>` framing, not operator-internal labels. Webhook handler accepts both old + new note formats — see [[anon_public_booking_implementation_2026_05_13]].
- **`cancelReservation(eventDate, reservationId, tableId, user, reason, options)` is POSITIONAL.** Object-arg form silently 400s. tableId can be `null` (function derives release list from `reservation.tableIds`). Test mocks must mirror the real signature.
- **`/p/{slug}` is served by Lambda but customers hit `https://famosofuego.com/p/{slug}`.** Amplify rewrite rule (status 200, server-side proxy) routes to `api.famosofuego.com/p/{slug}`. Order matters: `/p/<*>` must precede the `/<*>` SPA fallback in `aws amplify get-app --app-id d1gxn3rvy5gfn4 --query 'app.customRules'`. Legacy `api.famosofuego.com/p/{slug}` URLs in old customer inboxes still work — both hit the same handler.
- **`tsc --noEmit` doesn't run Angular template typecheck.** Bare boolean attributes (`<hlm-confirm-dialog destructive ...>`) pass tsc but fail at Amplify's `ng build` (~4 min cycle wasted). Always run `CI=true npm run build` before pushing. Bare-boolean fix: `[destructive]="true"`. See [[feedback_tsc_misses_template_typecheck]].
- **`takeUntilDestroyed()` without an arg requires injection context.** Calling it inside an event handler (e.g. `submit()`) throws synchronously; the HTTP error never propagates and the button stays in "Submitting…". For event-handler use, inject `DestroyRef` at construction and pass it explicitly: `.pipe(takeUntilDestroyed(this.destroyRef))`.
- **`computed()` doesn't track legacy `@Input` reads** — only signals. Computeds reading `this.someInput` memoize on first render and never refresh when the parent updates the binding. Migrate to `input()` (Angular 17+ signal-input API) or convert the computed to a plain method. Hit on `<reserve-table-modal>` (totalAmount memoized stale, showed wrong totals).

## Wiring outside this repo

**In place:** Cognito Pre Token Gen v2 (`ff-reservations-pretoken`); EventBridge `ff-reservations-overdue-release` (rate 1 min → `runScheduledMaintenance`); API GW JWT authorizer `5ea6tk` on every non-public route; DDB PITR on `ff-reservations`, `ff-table-holds`, `ff-clients`, `ff-checkin-passes` (35-day); CloudWatch alarm family `ff-res-*` → SNS `ff-res-ops-alerts` (Lambda errors/throttles/duration-p95/DLQ, SMS errors, history-write failures, auto-refund failed, refund orphaned, `ff-res-update-ignored-5m` for Day-shape orphan early-warning, plus 2026-05-14 additions `ff-res-active-hold-spike-5m` + `ff-res-turnstile-failed-5m` derived from the new funnel telemetry); CloudWatch dashboard `ff-saturday-funnel` (source-of-truth JSON in `scripts/cloudwatch-dashboards/`); SQS DLQ `ff-reservations-api-dlq` (14-day); log-metric filters in `FFReservations/*` namespaces (Funnel/* added 2026-05-14); API GW `$default` stage `DetailedMetricsEnabled=true` + throttle `200 burst / 100 rate`; SNS SMS delivery logging at 100% → `sns/us-east-1/.../DirectPublishToPhoneNumber{,/Failure}`. Per-alarm playbook: [[saturday_operational_runbook]].

**Missing (Phase 3+):** AWS WAF v2; AWS End User Messaging Configuration Set; toll-free `+18557656160` (carrier review per [[tfn_registration_submitted_2026_05_13]]); SNS `MonthlySpendLimit` aligned to EUM cap; IaC baseline.

## Where to look first

- **New lambda route** → register in `backend/lambda/lib/routes-*.mjs`, wire into `index.mjs` router, add a smoke `.http` file. Also `aws apigatewayv2 create-route` per the Auth section.
- **New frontend feature** → standalone component under `src/app/features/`, register in `src/app/app.routes.ts` with the right guards. Authed routes render *inside* `<main hlmSidebarInset>` (full inset width minus `p-3 md:p-4`); don't add page-level horizontal padding.
- **Touching the shell** (topbar / sidebar / inset) → see [[sidebar_shell_spartan_pattern]] (gap-div + fixed-container) and [[safari_display_contents_flex_bug]] (use real flex, not `display:contents`). **Topbar is `position:fixed`, not sticky** ([[topbar_uses_position_fixed]]): wrapper has `pt-14`; sidebar's fixed `top: var(--header-height)` mirrors. If topbar height changes from `h-14`, update BOTH `pt-14` and `--header-height: 3.5rem`.
- **Touching `reservations-new.ts`** (staff Hold & Reserve) → main file orchestrates; pure helpers in 5 siblings (`*-utils.ts`, `*-active-hold.ts`, `*-filters.ts`, `*-credits.ts`, `*-confirm.ts`). 12 specs lock invariants. **OnPush + signal-backed accessors** — write/read `this.holdId` (getter wraps signal); caches are `computed()`, invocation form in template; **don't add recompute methods or valueChanges subs** (computeds auto-recompute). Full conventions + every gotcha (double-fire guards, hold expiry banner, credit+cash receipt, idempotencyKey rules, pastEventsCache cap): [[reservations_new_audit_2026_05_13]] + [[reservations_new_signals_onpush_2026_05_13]].
- **Multi-table booking UX** lives in `reservations-new.ts`. **Render labels via `TableLabelPipe`** — never `{{ reservation.tableId }}` directly. `removeSelectedTable` promotes `holdEntries[0]` to primary + re-derives scalar mirrors + restarts hold timer (else `loadTables` orphans server-side holds). `selectTable` refuses to clobber a live hold (modal reopens with "Release or click + Add another" error). Full conventions: see [[reservations_new_audit_2026_05_13]].
- **Reservation detail modal** → shared at `src/app/shared/components/reservation-detail-modal/`. Parent owns loading/error/notice state + emits ~14 actions; modal owns 4-tab UI + predicates + formatters. Shared types in `src/app/shared/models/reservation-detail.model.ts`. Don't duplicate the template.
- **Reservation backend** → see Repo layout for the 5-module split. Read existing TransactWrite + ConditionExpression patterns before new writes.
- **`financials.ts`** (admin) → 6 pure reducers (`buildRows / buildReceivables / buildEventSummaries / buildOverview / buildMethodTotals / buildPaymentLedger`); 23 spec tests lock refund + credit + cashapp invariants. Calls `list(date, { suppressRelease: true })` to skip per-event overdue release on read — keep that flag. See [[financials_reducer_invariants]].
- **Payments** → `services-square-payments.mjs` + `routes-square-webhooks.mjs`. 6 staff/customer payment routes in `routes-reservations-holds.mjs` share the `autoRefundAfterRecordFailure` safety net (idempotency-keyed by Square paymentId). Customer-mobile equivalent in `routes-me.mjs` — audit BOTH when changing payment behavior. Push notifications fire from `addReservationPayment` via `services-push-notifications.mjs` (Expo).
- **Apple Wallet `.pkpass`** → `services-wallet-pass.mjs` builds via `passkit-generator`. Cert PEMs in Secrets Manager (`WALLET_PASS_SECRET_ARN`). Icons + logos in `backend/lambda/assets/wallet-pass/` (logos = white FF monogram from `src/assets/FF_monogram.svg` rendered via `rsvg-convert` at 50/100/150h, transparent bg) — missing files → 501 `WALLET_PASS_NOT_CONFIGURED`. **`pass.type = "generic"`** (flat top, no half-circle notch — `eventTicket` would notch the header next to "Famoso Fuego" wordmark). **QR `message` is `ffr-checkin:{64-hex token}`** (256-bit entropy, security primitive — never swap for the 6-char code). **`barcode.altText` is `FF-{confirmationCode}` when present, falls back to reservationId UUID** for legacy staff-created bookings. Already-installed passes don't auto-refresh — chrome/altText changes only show on newly-issued passes. Memo: [[wallet_pass_logo_placeholder]] (kept under historical name; now contains the regenerate recipe).
- **Customer self-service (`/me/*`)** → single file `routes-me.mjs`. Booking → payment (3 paths) → check-in pass → wallet pass. Self-cancel ≥24h forces `RESCHEDULE_CREDIT`. **Customer payment routes must NOT pass `source: "customer"` to `addReservationPayment`** — string isn't in the allowed enum; omit and let it default to `square-direct`.
- **Anonymous public booking (`/public/reservations/*`, `/p/{slug}`, `/r/{id}`, `/public/lookup-by-phone`, `/public/lookup-by-code`, `/public/telemetry`)** → entry: `routes-public-bookings.mjs`. Flow: `/map` (rebranded "Famoso Fuego — Reservations"; Turnstile + country picker + inline errors + "Find my reservation" outline button) → POST creates hold + reservation + Square link → checkout → 302 via `/p/{slug}` → `/r/{id}` polling (countdown + self-release on PENDING; Wallet pass + branded CTAs on PAID; differentiated copy on CANCELLED). **Pre-mint reservationId + customerToken + confirmationCode + publicSlug upfront** — `createReservation` accepts all four. Phone slot at `(PK="RATE", SK="ANONHOLD#{phoneKey}")` enforces 1 active unpaid hold per phone; same slot powers `/public/lookup-by-phone` (active-hold lookup, **unpaid only** by design — the slot is cleared on payment). For paid recovery use `/public/lookup-by-code` (Turnstile + FF-XXXXXX → `lookupReservationByConfirmationCode` → shortUrl); resolves PAID + PENDING + everything except CANCELLED. The Find modal exposes both as Phone/Booking-code tabs. Modal handles 429 `ACTIVE_HOLD_EXISTS` by reading `existingReservationId/EventDate/ExpiresAt` from the response + offering self-release when localStorage carries the matching token; pending-hold banner on /map repurposes its second button to Release (no more silent dismiss). Behind `allowAnonymousPublicBooking` settings flag (defaults false). Full impl + every per-feature commit: [[anon_public_booking_implementation_2026_05_13]] + [[public_map_audit_session_2026_05_13_evening]] + [[public_map_tier_a_b_session_2026_05_14]] + [[find_by_code_tier_s_2026_05_14]].
- **Staff lookup by FF-XXXXXX code** → `GET /reservations/by-code/{code}` (staff-auth) in `routes-reservations-holds.mjs`. Strips a "FF-" prefix and uppercases before resolving via `lookupReservationByConfirmationCode`. Frontend mini-form on /staff/reservations switches `filterDate` to the reservation's eventDate and opens the existing detail modal. The same in-table filter input now also matches `confirmationCode` (instant filter on the loaded event, complements the cross-date search). FF-XXXXXX chip is rendered in the detail modal header + dashboard urgent-payment cards so staff can verify the code matches. Hidden when `reservation.confirmationCode` is null (staff-created bookings never have one). New API GW route `pu1v4pc` registered 2026-05-13.
- **Saturday-night ops** → start with `bash scripts/smoke_test_prod.sh` (19 checks, ~10s, exits non-zero on fail) — covers public endpoints, auth gates, alarm states, Lambda + Amplify health, cron heartbeat, telemetry + both lookup-by-{phone,code} routes. The night before, run `bash scripts/saturday_eve_check.sh [YYYY-MM-DD]` (defaults to next Saturday) — 5 sections including config sanity, reservation-state breakdown, CONFIRMED-but-PENDING-payment follow-up list, active anon phone slots, and last-24h funnel summary. Single-pane dashboard: `ff-saturday-funnel` in CloudWatch (`https://us-east-1.console.aws.amazon.com/cloudwatch/home?region=us-east-1#dashboards:name=ff-saturday-funnel`) — 9 widgets covering both funnel halves + Lambda health + recent payments. For alarm-by-alarm playbook + customer-issue flowchart + lookup commands, read the runbook memory `[[saturday_operational_runbook]]`. Day-shape orphan recovery is in `[[incident_2026_05_13_day_paid_but_cancelled]]`. Funnel readout: `filter @message like "_funnel_event" | stats count() by step, event` against `/aws/lambda/ff-reservations-api`.
- **CRM clients** → `services-clients.mjs` + `routes-clients.mjs`. `GET /clients/search?phone=…&q=…` (staff); `POST /clients/bulk-import` (admin, ≤500/req, conditional Put). `upsertCrmClient` is the live-reservation path.
- **Auditing auth** → Auth Model section above + `index.mjs:97-174` for `getGroupsFromEvent` / `requireAdmin` / `requireStaffOrAdmin` / `requireCustomerOwnership`.
- **Diagnostic queries** → SMS delivery: `sns/us-east-1/908027422124/DirectPublishToPhoneNumber{,/Failure}` log groups. Cron heartbeat: `aws logs filter-log-events --log-group-name /aws/lambda/ff-reservations-api --filter-pattern "scheduled_maintenance"`. Production health: `bash scripts/smoke_test_prod.sh`.
- **Debugging an iOS-Chrome-only bug** → visit `/?debug=1` (gated by `localStorage.ff-debug=1`). Loads eruda + injects a counter panel for touch/pointer/click/viewport + OIDC lifecycle events. Disable: `/?debug=0`.
