# FF Reservations — Project Context

Restaurant table reservation system for Famoso Fuego. Staff create reservations on behalf of customers; customers pay via Square / Cash App link and self-check-in via QR codes. Admin manages frequent clients, events, settings, and financials.

> **Branch state (2026-05-09):** `main` runs the Angular 21 SPA in production. A React + Expo monorepo port exists on the `react` branch (snapshot tag `react-port-snapshot-2026-05-09`), paused mid-Phase 5. Do not introduce React, pnpm, Vite, or `apps/`/`packages/` changes on `main`.

> **Lambda Square env — PRODUCTION as of 2026-05-11.** `ff-reservations-api` runs against production Square. Real cards / Cash App charges fire. **Open verification item:** production Square webhook subscription must point at `https://api.famosofuego.com/webhooks/square` with `payment.created` + `payment.updated` events; signature key in the production secret. Without that, real payments succeed at Square but reservations don't auto-flip to PAID. Full env IDs + sandbox revert procedure in memory `lambda_square_env_production_cutover.md`.

> **Companion mobile app (sandbox dev loop paused):** Customer-facing iOS/Android app lives in `github.com/alekscortez/ff-customer-mobile` (Expo SDK 54). Resume options tracked in memory `ff_customer_mobile_status.md`.

## Stack

- **Frontend:** Angular 21 (standalone components), Tailwind 3.4, `angular-auth-oidc-client` v21, ZXing for QR scan, `qrcode` for pass rendering, `@ng-icons/lucide`. Spartan-style component library under `src/app/shared/ui/`.
- **Backend:** AWS Lambda (Node 22 ESM `.mjs`), API Gateway HTTP API, DynamoDB, Cognito Hosted UI + Custom Auth phone OTP (customers), Square API + webhook, SNS SMS, Secrets Manager.
- **Hosting:** Amplify for the SPA (npm + `ng build`, artifacts at `dist/ff-reservations/browser/`); custom domain `api.famosofuego.com` for the API. `amplify.yml` pins npm via `corepack prepare npm@11.6.2` — see memory `amplify_corepack_npm_pin.md`.

## UI primitives — read before adding new UI

Eleven Spartan-style primitive families under `src/app/shared/ui/`. Each is a standalone Angular directive/component with `cva` variants + `tailwind-merge` for consumer-class overrides. **Use them instead of hand-rolling Tailwind class strings.**

| Primitive | Selector | Variants / sizes | When to use |
|---|---|---|---|
| `HlmButton` | `button[hlmBtn]`, `a[hlmBtn]` | `default \| outline \| outline-current \| secondary \| ghost \| destructive \| link` × `default \| xs \| sm \| lg \| icon \| icon-xs \| icon-sm \| icon-lg` | All action buttons. `outline-current` inherits parent text color. |
| `HlmBadge` | `[hlmBadge]` | `default \| secondary \| outline \| destructive \| success \| warning \| danger` × `default \| sm \| xs` | Status pills. Use `outline` inside colored cards. |
| `HlmInput` | `input[hlmInput]`, `select[hlmInput]`, `textarea[hlmInput]` | `default \| sm \| lg` | Form text inputs / selects / textareas. NOT checkboxes/radios. |
| `HlmDialog` | `<hlm-dialog>` | sizes: `default \| full-on-mobile \| sheet` + `panelClass` input | All modals. `sheet` for slide-from-edge (topbar quick-actions). |
| `HlmConfirmDialog` | `<hlm-confirm-dialog>` | `[title] [message] [confirmText] [cancelText] [loadingText] [destructive] [loading]` + `(confirm) (cancel)` | Yes/no dialogs. Replaces `window.confirm()` — same shape as Spartan-styled UI. Form-prompts still compose `<hlm-dialog>` directly. |
| `HlmToggle` | `button[hlmToggle]` | `default \| outline \| warning` × `[active]` | Toggle pills. Caller manages `[active]`. |
| `HlmAlert` | `<hlm-alert>` | `info \| success \| warning \| destructive` | Inline tinted alert boxes. Widely used for page-level notice/error banners (`role="alert"` baked in). |
| `HlmAvatar` | `<hlm-avatar>` + `img[hlmAvatarImage]` + `span[hlmAvatarFallback]` | sizes: `sm \| default \| lg` (size-6/8/10). Default `rounded-full`; override to `rounded-lg`. | Photo tile + initials fallback. Image auto-hides until `load`; falls back on `error`. |
| `HlmSidebar` (compound) | `<hlm-sidebar>` + slots + `[hlmSidebarWrapper]` / `[hlmSidebarInset]` / `[hlmSidebarTrigger]` | desktop gap-div + fixed container; mobile fixed `<aside>` (NOT HlmDialog); cookie-persisted; Cmd/Ctrl+B | Staff/admin shell only. Feature routes render *inside* the inset. |
| `HlmPagination` (compound) | `<hlm-numbered-pagination>` wrapper, or low-level pieces | Two-way `[(currentPage)]` + `[(itemsPerPage)]` model signals + `[totalItems]`. Sliding window with ellipses, default `maxSize=7`. Event-only (no RouterLink). | Long client-side lists. See admin Clients page (1,400+ rows, 50/page). |
| `HlmTable` (compound) | `<div hlmTableContainer>` + `<table hlmTable>` + `hlmTHead/TBody/TFoot/Tr/Th/Td/Caption` + `<hlm-table-sort-header>` | Pure CSS classes on plain `<table>` markup; sort-header composes with TanStack `Column<T>` | Lists needing sort / filter / pagination. Pair with `@tanstack/angular-table`. |
| `HlmDropdownMenu` (compound) | `[hlmMenuTriggerFor]` + `[hlmMenu]` in an `<ng-template>` + `button[hlmMenuItem]` (`variant="default \| destructive"`) + `button[hlmMenuCheckbox]` + `<hlm-menu-separator>` + `[hlmMenuLabel]` | Wraps `@angular/cdk/menu`: arrow-key nav, Esc dismiss, focus return. Renders into overlay portal. | Row actions, context menus, multi-select toggles. |

**Convention for TS helpers**: when state-driven styling depends on a function, return a variant *literal* (`'success' | 'danger' | …`), NOT a Tailwind class string. See `reservations.ts:paymentStatusBadgeVariant`.

**Consumer-class merge rule**: extra classes via `class="..."` (directives) or `[class]="..."` (components) merge with variant defaults via tailwind-merge. Conflicting utilities (`rounded-full` vs `rounded-lg`) resolve with the consumer winning. The static `class` attribute is captured on first render — dynamic `[ngClass]` applied AFTER mount races with the directive's effect. Prefer `[active]`-style state inputs or `[class.foo]` bindings over `[ngClass]`.

**Palette**: `brand` (10-shade grayscale), `warm` (orange), `success`/`danger`/`warning` (50/100/200/300/400/500/700/800). Spartan/shadcn semantic colors (`bg-primary`, `text-foreground`, etc.) resolve to the brand palette via HSL CSS variables in `src/styles.scss`.

**Specs** live next to each primitive (`src/app/shared/ui/<name>/<name>.spec.ts`) and lock in variant + tailwind-merge semantics + (for HlmDialog) CDK focus-trap interop.

### Where the deep-dive guidance lives

These four primitive families have substantial composition patterns + gotchas. Don't reinvent them — read the JSDoc in the source file plus the memory file before extending:

- **Shell layout (`HlmSidebar`)** → `src/app/shared/ui/sidebar/hlm-sidebar.ts` JSDoc + memories `sidebar_shell_spartan_pattern.md` (nav-user chip, secondary `mt-auto` slot, mobile slide animation, HlmDialog bypass, brand-chip SVG inversion) and `safari_display_contents_flex_bug.md` (gap-div + flex-grow reflow rationale).
- **Pagination (`HlmPagination`)** → `src/app/shared/ui/pagination/hlm-numbered-pagination.ts` JSDoc + memory `client_side_pagination_pattern.md` (5-step recipe: load-all → signal → toSignal → computed slice → effect-reset; revisit at ~10k rows).
- **Data tables (`HlmTable` + TanStack)** → `src/app/shared/ui/table/hlm-table.ts` JSDoc + memory `data_tables_spartan_pattern.md` (TanStack composition, 6 patterns-that-matter, Spartan-stock card layout, columns-visibility integration) + memory `tanstack_proxy_onpush_reactivity.md`.
- **Dropdown menus (`HlmDropdownMenu`)** → `src/app/shared/ui/dropdown-menu/hlm-menu.ts` JSDoc (CDK wrap, trigger pattern, destructive variant, toggleable items, return-focus semantics).

**DO NOT run `@spartan-ng/cli ui` generators** — they would overwrite hand-rolled primitives, add unused families, and ship Tailwind-4 syntax incompatible with our Tailwind 3. See memory `spartan_cli_avoided.md`.

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
  services-reservations-shared.mjs  # constants, utils, history writes, check-in pass, read-only DDB
  services-payment-recording.mjs    # addReservationPayment + payment-link / Cash App mutators
  services-reservations.mjs         # reservation CRUD, 3 cancellation paths, cron overdue release
  services-holds.mjs                # createHold / releaseHold / listHolds
  services-reservations-holds.mjs   # 67-line BARREL composing the four above (public surface for index.mjs)

backend/cognito-pre-token-gen/      # separate Lambda — Cognito Pre Token Gen v2 trigger
backend/cognito-customer-auth/      # Cognito Custom Auth phone-OTP triggers
http/*.http                         # smoke tests for IDE HTTP runner
scripts/                            # one-off operational helpers (extract → import → backfill → merge)
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
- **Customer auth** (mobile, separate from staff): Custom Auth phone-OTP via `backend/cognito-customer-auth/`. Public mediator routes `POST /auth/customer/start` + `POST /auth/customer/verify` (in `routes-customer-auth.mjs`) wrap the synthetic-email convention. Customer-only routes under `/me/*` (in `routes-me.mjs`) use `requireCustomerOwnership(event)`.
- **Token TTLs** (staff client, set 2026-05-11): access 8h, ID 8h, refresh 30d. Silent renew via refresh token. **OIDC state persisted in localStorage** via `DefaultLocalStorageService` in `app.config.ts` — the library's default (sessionStorage) silently nuked the refresh token on browser restart. See memory `feedback_oidc_default_session_storage.md`.
- `Login` component auto-redirects already-authed users to `/staff/dashboard`; routes `''` and `'home'` both redirect to `/login`.

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
- `ff-table-holds` (HOLDS_TABLE — HOLD and RESERVED locks per `(EVENTDATE#YYYY-MM-DD, TABLE#{id})`)
- `ff-reservations` (RES_TABLE — reservations + history)
- `ff-frequent-clients`
- `ff-clients` (CRM + reschedule credits)
- `ff-checkin-passes`
- `ff-settings` (single `(APP, CONFIG)` record; overrides env at runtime; some keys env-managed only)

## Lambda env vars

Tables: `EVENTS_TABLE`, `HOLDS_TABLE`, `RES_TABLE`, `FREQUENT_CLIENTS_TABLE`, `CLIENTS_TABLE`, `CHECKIN_PASSES_TABLE`, `SETTINGS_TABLE`. Cognito: `USER_POOL_ID`. Square: `SQUARE_SECRET_ARN`, `SQUARE_ENV`, `SQUARE_LOCATION_ID`, `SQUARE_API_VERSION`, `SQUARE_WEBHOOK_NOTIFICATION_URL`, `SQUARE_CURRENCY`, `SQUARE_CHECKOUT_REDIRECT_URL`, `SQUARE_LINK_ENABLE_*`. SMS: `SMS_ENABLED`, `SMS_SENDER_ID`, `SMS_TYPE`, `SMS_MAX_PRICE_USD`. Payment links: `PAYMENT_LINK_TTL_MINUTES`, `FREQUENT_PAYMENT_LINK_TTL_MINUTES`, `AUTO_SEND_SQUARE_LINK_SMS`, `CASH_APP_LINK_BASE_URL`. Check-in: `CHECKIN_PASS_BASE_URL`, `CHECKIN_PASS_TTL_DAYS`. Wallet: `WALLET_PASS_TYPE_IDENTIFIER`, `WALLET_TEAM_IDENTIFIER`, `WALLET_PASS_SECRET_ARN` + optional brand overrides. Operating: `OPERATING_TZ`, `OPERATING_DAY_CUTOFF_HOUR`, `HOLD_TTL_SECONDS`.

## Frontend config

`src/app/core/config/app-config.ts` hardcodes `apiBaseUrl: https://api.famosofuego.com` + Cognito authority / hostedUiDomain / clientId / scope. No per-environment config file yet.

## Conventions

- **Money in app code is dollars** (number, 2 decimals). Square API expects minor units — conversion lives in `services-square-payments.mjs`.
- **Phone numbers stored E.164** (`+1...` or `+52...`). Search uses candidate fan-out (`buildPhoneSearchCandidates`). Inputs <4 digits return empty.
- **CRM dedup is phone-only** by design (PK=`PHONE#{key}`). Same person via two phones = two rows on purpose. Mitigation is the staff form's typeahead, not fuzzy-merge. Ad-hoc cleanup via `scripts/merge_pair.mjs`. See memory `feedback_crm_dedup_phone_only.md`.
- **Times**: epoch seconds for `expiresAt`/`issuedAt`; deadlines as `YYYY-MM-DDTHH:mm:ss` local-iso + IANA tz string. Default tz `America/Chicago`.
- **Venue takes forward bookings** — every reservation is for a future `eventDate`. Date-range filters on admin views (Financials, future reports) MUST NOT cap the upper bound at "today" by default — that filter would always be empty in the typical case. See memory `financials_reducer_invariants.md` for the Financials default-range convention.
- **Errors**: raise via `httpError(status, message)` from `core-utils.mjs`; the router's outer `try/catch` formats the response.
- **Reservation enums**: `paymentStatus` ∈ `{PENDING, PARTIAL, PAID, COURTESY, REFUNDED}`; `paymentMethod` ∈ `{cash, square, cashapp, credit}`; `status` ∈ `{CONFIRMED, CANCELLED}`; `lockType` ∈ `{HOLD, RESERVED}`; cancellation `resolutionType` ∈ `{CANCEL_NO_REFUND, RESCHEDULE_CREDIT, REFUND}`. REFUND iterates `payments[]`, refunds each via Square, then sets `paymentStatus=REFUNDED`. Partial failure throws 502 without cancelling (operator must reconcile).
- **Multi-table bookings**: row carries `tableIds: string[]` + `tablePrices: number[]` plus legacy scalar `tableId`/`tablePrice` (= first / sum). One reservation = one customer = one deposit = one Square link / SMS / check-in pass / Wallet pass listing every table. Cap: 10/booking. **Every reader prefers `tableIds[]` then falls back to `[tableId]`; every writer stamps both.** Shared helpers: `getReservationTableIds`/`normalizeIdList`/`formatTablesLabel` in `services-reservations-shared.mjs`, plus the Angular `TableLabelPipe` / `formatTableLabel{,Lower}` in `src/app/shared/table-label.pipe.ts` — the ONLY places that should branch on length. Mobile customer flow is single-table only in v1.

## Known gotchas

- `qrcode` triggers a CommonJS optimization warning during build — cosmetic, ignore.
- Tests use Vitest with a shared OIDC mock at `src/app/testing/oidc-mock.ts`. If your component injects `OidcSecurityService`, use `provideMockOidc()` + `provideRouter([])`. For per-test control of `isAuthenticated$` / `getIdToken()`, provide your own stub. AuthService logout test stubs `window.location` via `Object.defineProperty` because jsdom's `Location.replace` is non-configurable.
- Functional `CanMatchFn` guards tested via `TestBed.runInInjectionContext(() => guard(null as any, []))`. HTTP wrappers tested by faking `ApiClient`, not `HttpClient`. `ApiClient` itself tested via `HttpTestingController` (retry on GET 5xx + status 0 only).
- `backend/lambda/function.zip` is the built artifact — never commit. `backend/lambda/code_url.txt` may contain a presigned S3 URL — never commit.
- `auth-callback.ts` reads groups from the **ID token**; API calls use the **access token**. Keep them in sync.
- API Gateway routes are explicit (no `$default` proxy). Adding a backend route requires both the handler in `lib/routes-*.mjs` AND `aws apigatewayv2 create-route` with `--target integrations/0bj43cm --authorization-type JWT --authorizer-id 5ea6tk` (or NONE for public).
- **`*ngFor` with template method calls is an anti-pattern** — CD re-invokes them every cycle; iOS Chrome drops the trailing touchend. Memoize + use `trackBy`. See memory `feedback_ngfor_no_template_methods.md`.
- **Lines that start with `=` in `.html` templates** are corrupted bindings (usually `[active]` whose attribute name got stripped). Angular parses them as a string attribute called `""` and silently does nothing — toggle stays dead. Hit twice in 2026-05-12. Grep `find src -name '*.html' -exec grep -l '^=' {} \;` before shipping any HlmToggle-heavy page. Memory: `feedback_stripped_active_bindings.md`.

## Wiring outside this repo

**In place:**
- Cognito Pre Token Gen v2 Lambda `ff-reservations-pretoken` deployed and wired.
- EventBridge `ff-reservations-overdue-release` rule fires `rate(1 minute)` → `runScheduledMaintenance`.
- API Gateway JWT authorizer (`5ea6tk`) attached to every non-public route.
- DynamoDB PITR on `ff-reservations`, `ff-table-holds`, `ff-clients`, `ff-checkin-passes` (35-day window).
- CloudWatch alarms → SNS topic `ff-res-ops-alerts` (subscribers: `aws@redbone.mx`, `dev@alekscortez.com`): lambda duration-p95 ≥10s, errors / throttles / DLQ depth, SMS errors, history-write failures, auto-refund failed, refund orphaned.
- Lambda async-invoke DLQ: SQS `ff-reservations-api-dlq` (14-day retention).
- Log-metric filters extract SMS, history-write, auto-refund, refund-orphaned counts into `FFReservations/*` namespaces.
- API Gateway `$default` stage: `DetailedMetricsEnabled=true` + default-route throttle `200 burst / 100 rate` (sized for ~12 RPS peak with ~8× headroom).
- SNS SMS delivery status logging at 100% sample rate → `sns/us-east-1/.../DirectPublishToPhoneNumber{,/Failure}`.

**Missing (Phase 3+):** AWS WAF v2 web ACL; AWS End User Messaging Configuration Set; toll-free `+18557656160` (PENDING carrier approval); SNS `MonthlySpendLimit` aligned to EUM cap (deferred); IaC baseline.

## Where to look first

- **New lambda route** → register in `backend/lambda/lib/routes-*.mjs`, wire into `index.mjs` router, add a smoke `.http` file. Also `aws apigatewayv2 create-route` per the Auth section.
- **New frontend feature** → standalone component under `src/app/features/`, register in `src/app/app.routes.ts` with the right guards. Authed routes render *inside* `<main hlmSidebarInset>` (full inset width minus `p-3 md:p-4`); don't add page-level horizontal padding.
- **Touching the shell** (topbar / sidebar / inset) → memory `sidebar_shell_spartan_pattern.md` for the gap-div + fixed-container pattern. Real `display: flex` (no `contents`) per memory `safari_display_contents_flex_bug.md`. **Topbar uses `position: fixed`, not sticky** (memory `topbar_uses_position_fixed.md`): wrapper has `pt-14` to reserve space; sidebar's fixed `top: var(--header-height)` keeps it below. If topbar height ever changes from `h-14`, update both `pt-14` on the wrapper AND `--header-height: 3.5rem` inline style.
- **Touching `reservations-new.ts`** (staff Hold & Reserve) → orchestration in main file, pure helpers extracted into 5 siblings under `src/app/features/staff/reservations-new/`: `*-utils.ts`, `*-active-hold.ts`, `*-filters.ts`, `*-credits.ts`, `*-confirm.ts`. Each has co-located `*.spec.ts`. The component's own spec is 12 tests covering removeSelectedTable primary-promotion, isCashReceiptRequired matrix, releaseHold empty-entries cleanup, double-fire guard on confirmReservation, and the credit+cash-remainder addPayment roundtrip. Conventions enforced by the 2026-05-13 audit (memory `reservations_new_audit_2026_05_13.md`):
  - **No method calls in `*ngFor`** — bind to `filteredTablesCache` / `upcomingEventsCache` / `pastEventsCache`, never `filteredTables()` / `upcomingEvents()` / `pastEvents()` (the methods don't exist anymore). Recompute hooks live in `loadTables`, `loadEvents`, `loadRuntimeContext`, `clearEventSelection`, plus valueChanges subs on the five filter FormControls.
  - **trackBy on every `*ngFor`** — see `trackByEventDate`, `trackByTableId`, `trackBySection`, `trackByClientPhone`, `trackByCreditId`, `trackByPaymentMethodOption`.
  - **Every HTTP `.subscribe()` pipes through `takeUntilDestroyed(this.destroyRef)`** — writes on a destroyed component are an anti-pattern and surface as Angular's "modified after checked" dev warnings.
  - **Double-fire guards** — `creatingHold` and `confirmingReservation` instance flags gate their POSTs against rapid double-click; cleared at every exit point (12 branches in `confirmReservation`).
  - **Hold expiry is FE-aware** — when the per-second timer ticks to zero it nulls `holdId`/`holdExpiresAt`/`holdEntries`/`holdCreatedByMe` AND sets `holdExpired = true`. The modal renders `<hlm-alert variant="warning">` with a "Hold expired" notice. `confirmReservation`'s existing `!holdId` check then catches the expired case. Reset `holdExpired = false` whenever a fresh hold is created or modal state is cleared.
  - **Credit + cash-remainder must send receiptNumber** — backend `services-payment-recording.mjs:578` defaults `resolveCashReceiptNumberRequired()` to true. `cashReceiptNumberRequired` instance flag is loaded from `ctx.settings.cashReceiptNumberRequired`; the form has a `receiptNumber` FormControl; `isCashReceiptRequired()` returns true only when credit + remainingMethod === cash; `confirmReservation` validates before submit; the inner `addPayment` cash leg sends the normalized digits-only number.
  - **Square link gets a per-attempt idempotencyKey** (`crypto.randomUUID` with a non-secure-context fallback). Cash App link route mints fresh tokens regardless — no key needed there.
  - **`pastEventsCache` is capped at 50 rows** when no date/name filter is active; filtered results bypass the cap so staff can still search older history.
- **Multi-table booking UX** lives in `reservations-new.ts`. "+ Add another table" appends to a session of per-table holds; cancellation derives release list from `reservation.tableIds`. **Render labels via `TableLabelPipe`** (`{{ reservation | tableLabel }}`) — never template `{{ reservation.tableId }}` directly. **Removing the primary table** (`removeSelectedTable`) promotes `holdEntries[0]` to primary and re-derives all scalar mirrors (selectedTable / selectedTableId / holdId / holdExpiresAt / holdCreatedByMe), then restarts the hold timer; without this, `loadTables` re-resolution would null out `selectedTable` and orphan surviving server-side holds. **`selectTable` refuses to clobber a live hold** — if the staff clicks a different free table while owning a live booking (and not in "+ Add another" mode), the modal reopens with a "Release or click + Add another" error to prevent silently orphaning holds.
- **Reservation detail modal** (Dashboard urgent-payment row click + staff Reservations row click) → shared component at `src/app/shared/components/reservation-detail-modal/`. Parent owns all loading / error / notice state and emits ~14 actions; modal owns the 4-tab UI (overview / links / pass / activity), pure predicates (`canGeneratePaymentLink`, `canManageCheckInPass`, etc.), formatting helpers (`historyEventLabel`, `formatDeadline`, …), and tab signal. Shared types in `src/app/shared/models/reservation-detail.model.ts`. Don't duplicate the template — extend the shared component.
- **Reservation state** → pick the right module per the Repo Layout split (`services-reservations.mjs` CRUD, `services-payment-recording.mjs` payments, `services-holds.mjs` holds, `services-reservations-shared.mjs` utilities, `services-reservations-holds.mjs` barrel). Read existing TransactWrite + ConditionExpression patterns before adding new writes.
- **Touching `financials.ts`** (admin /admin/financials) → all money math lives in 6 pure reducers on the component (`buildRows / buildReceivables / buildEventSummaries / buildOverview / buildMethodTotals / buildPaymentLedger`); 23 spec tests lock the refund + credit + cashapp invariants. Financials calls `reservationsApi.list(date, { suppressRelease: true })` so opening the page does NOT trigger per-event overdue release across the filter range — keep that flag. See memory `financials_reducer_invariants.md`.
- **Payments** → `services-square-payments.mjs` (Square API) + `routes-square-webhooks.mjs` (receiver). The 6 staff/customer payment routes in `routes-reservations-holds.mjs` share the audit-C2 `autoRefundAfterRecordFailure` safety net (idempotency-keyed by Square paymentId). Customer-mobile equivalent in `routes-me.mjs` inlines the same — audit BOTH paths when changing payment behavior.
- **Push notifications** → `services-push-notifications.mjs` (Expo Push dispatcher); `addReservationPayment` fires `sendPushToCustomer` on every recording. Logs `payment_push_dispatched`/`_skipped`.
- **Apple Wallet `.pkpass`** → `services-wallet-pass.mjs` builds via `passkit-generator`. Cert PEMs in Secrets Manager (`WALLET_PASS_SECRET_ARN`). Icons in `backend/lambda/assets/wallet-pass/` — missing files → 501 `WALLET_PASS_NOT_CONFIGURED`.
- **Customer self-service (`/me/*`)** → single file `routes-me.mjs`. Booking → payment (3 paths) → check-in pass → wallet pass. Self-cancel ≥24h forces `RESCHEDULE_CREDIT`. **Customer payment routes must NOT pass `source: "customer"` to `addReservationPayment`** — string isn't in the allowed enum; omit and let it default to `square-direct`.
- **CRM clients** → `services-clients.mjs` + `routes-clients.mjs`. `GET /clients/search?phone=…&q=…` (staff); `POST /clients/bulk-import` (admin, ≤500/req, conditional Put preserves existing). `upsertCrmClient` is the live-reservation path.
- **Auditing auth** → re-read this file's Auth Model section, then `index.mjs:97-174` for `getGroupsFromEvent` / `requireAdmin` / `requireStaffOrAdmin` / `requireCustomerOwnership`.
- **"Did SMS X arrive?"** → query `sns/us-east-1/908027422124/DirectPublishToPhoneNumber{,/Failure}` log groups.
- **"Did the cron sweep run?"** → `aws logs filter-log-events --log-group-name /aws/lambda/ff-reservations-api --filter-pattern "scheduled_maintenance"`.
- **Debugging an iOS-Chrome-only bug** → visit `/?debug=1` on the phone. Loads eruda + injects a top-right panel with touch/pointer/click/viewport counters and OIDC lifecycle events. Gated by `localStorage.ff-debug=1`. Disable with `/?debug=0`.
