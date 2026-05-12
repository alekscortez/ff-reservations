# FF Reservations — Project Context

Restaurant table reservation system for Famoso Fuego. Staff create reservations on behalf of customers; customers pay via Square / Cash App link and self-check-in via QR codes. Admin manages frequent clients, events, settings, and financials.

> **Branch state (2026-05-09):** `main` runs the Angular 21 SPA in production. A React + Expo monorepo port of this app exists on the `react` branch (snapshot tag `react-port-snapshot-2026-05-09`) — paused mid-Phase 5 with known parity gaps documented in `.line-by-line-audit-2026-05-10.md` on that branch. Resume that work on the `react` branch; do not introduce React, pnpm, Vite, or `apps/`/`packages/` changes on `main`.

> **Lambda Square env — PRODUCTION as of 2026-05-11.** `ff-reservations-api` runs against **production Square**: `SQUARE_ENV=production`, secret `ff/square/production-QaNJNJ`, location `L86CASVC3TQC5`, application id `sq0idp-mxhcqqL-R9GKstTIhSUC8g`. Real cards / Cash App charges will fire. Sandbox creds (`ff/square/sandbox-iUhiXH`, location `LX8EYYBKF50N9`) remain intact in Secrets Manager if you need to revert (`/tmp/ff-lambda-env-pre-production-20260511-104201.json` has the pre-cutover snapshot). 375 test rows were wiped from the 6 transactional tables on the same date. **Open verification item:** the production Square webhook subscription must be set up in Square's production dashboard pointing at `https://api.famosofuego.com/webhooks/square` with `payment.created` + `payment.updated` events; signature key must live in the production secret. Without that, real payments succeed at Square but reservations don't auto-flip to PAID. See memory: `lambda_square_env_production_cutover.md`.

> **Companion mobile app (sandbox dev loop paused):** Customer-facing iOS/Android mobile app lives in a SEPARATE repo at `github.com/alekscortez/ff-customer-mobile` (Expo SDK 54). Full booking + reschedule + payment + push + Apple Wallet were verified end-to-end on real device against sandbox before 2026-05-11. The shared Lambda is now on production, so mobile dev against sandbox is paused — resume options (revert temporarily, header-based dual-env switch, or separate sandbox Lambda) are tracked in `ff_customer_mobile_status.md`.

## Stack

- **Frontend:** Angular 21 (standalone components), Tailwind 3.4, `angular-auth-oidc-client` v21, ZXing for QR scan, `qrcode` for pass rendering, `@ng-icons/lucide` for sidebar/topbar iconography. **Spartan-style component library** under `src/app/shared/ui/` — see "UI primitives" section below.
- **Backend:** AWS Lambda (Node 22 ESM `.mjs`), API Gateway HTTP API, DynamoDB, Cognito Hosted UI + Custom Auth phone OTP (customers), Square API + webhook, SNS SMS, Secrets Manager
- **Hosting:** Amplify for the SPA (npm + `ng build`, artifacts at `dist/ff-reservations/browser/`); custom domain `api.famosofuego.com` for the API. `amplify.yml` installs `npm@11.6.2` globally before `npm ci` so the lock-file version matches what wrote it (see memory: `amplify_corepack_npm_pin.md`).

## UI primitives — read before adding new UI

Ten Spartan-style primitive families live under `src/app/shared/ui/`. Use them
instead of hand-rolling new Tailwind class strings. Each is a
standalone Angular directive/component with `cva` variants +
`tailwind-merge` for consumer-class overrides.

| Primitive | Selector | Variants / sizes | When to use |
|---|---|---|---|
| `HlmButton` | `button[hlmBtn]`, `a[hlmBtn]` | `default \| outline \| outline-current \| secondary \| ghost \| destructive \| link` × `default \| xs \| sm \| lg \| icon \| icon-xs \| icon-sm \| icon-lg` | All action buttons. `outline-current` for inline buttons that need to inherit a parent's text color (dashboard urgency cards). |
| `HlmBadge` | `[hlmBadge]` (on `<span>`) | `default \| secondary \| outline \| destructive \| success \| warning \| danger` × `default \| sm \| xs` | Status pills. Use `outline` for badges inside colored cards (border-current inheritance). |
| `HlmInput` | `input[hlmInput]`, `select[hlmInput]`, `textarea[hlmInput]` | sizes: `default \| sm \| lg` | All form text inputs + selects + textareas. NOT checkboxes/radios (HlmInput selectors don't match `<input type="checkbox">`). |
| `HlmDialog` | `<hlm-dialog>` (component) | sizes: `default \| full-on-mobile \| sheet` + `panelClass` override input | All modals. `default` for centered, `full-on-mobile` for long forms (frequent-clients create), `sheet` for slide-from-edge (topbar quick-actions, z-[300] above page modals). |
| `HlmToggle` | `button[hlmToggle]` | `default \| outline \| warning` × `[active]` boolean | Toggle pills (filter chips, section/table selectors). Caller manages `[active]` state. |
| `HlmAlert` | `<hlm-alert>` (component) | `info \| success \| warning \| destructive` | Inline tinted alert boxes (rounded-lg border bg-*-50 text-*-700). For just colored text (no border/bg), keep `<p class="text-danger-700">` hand-rolled. |
| `HlmSidebar` (compound family — see "Shell layout" below) | `<hlm-sidebar>` + slot directives + `[hlmSidebarWrapper]` / `[hlmSidebarInset]` / `[hlmSidebarTrigger]` | desktop gap-div + fixed container; mobile slide-over via own fixed `<aside>` + backdrop (NOT HlmDialog); cookie-persisted open state; Cmd/Ctrl+B shortcut | The staff/admin shell only. Don't pull these into feature pages — feature routes render *inside* the inset. |
| `HlmPagination` (compound family — see "Pagination" below) | `<hlm-numbered-pagination>` high-level wrapper, or compose from `nav[hlmPagination]` + `ul[hlmPaginationContent]` + `li[hlmPaginationItem]` + `button[hlmPaginationLink]` + `<hlm-pagination-previous>` / `<hlm-pagination-next>` / `<hlm-pagination-ellipsis>` | Two-way `[(currentPage)]` + `[(itemsPerPage)]` model signals + `[totalItems]` input. Sliding window with ellipses (default `maxSize=7`). Event-only — no RouterLink integration | Any long client-side list that doesn't fit on one screen. Currently used by the admin Clients page (1,400+ rows, 50 per page). |
| `HlmTable` (compound family — see "Data tables" below) | `<div hlmTableContainer>` + `<table hlmTable>` + `<thead hlmTHead>` + `<tbody hlmTBody>` + `<tfoot hlmTFoot>` + `<tr hlmTr>` + `<th hlmTh>` + `<td hlmTd>` + `<caption hlmCaption>`, plus `<hlm-table-sort-header [column] label>` for sortable headers | Pure CSS class application matching the existing hand-rolled table markup; sort-header composes with TanStack `Column<T>` | Long lists that need sort / filter / pagination. Pair with `@tanstack/angular-table`'s `createAngularTable` for state. Currently used by the admin Clients page. |
| `HlmDropdownMenu` (compound family — see "Dropdown menus" below) | `[hlmMenuTriggerFor]` on the launcher button + `[hlmMenu]` on a `<div>` inside an `<ng-template>` + `button[hlmMenuItem]` (with `variant="default \| destructive"`) + `button[hlmMenuCheckbox]` (with `[checked]` + `(triggered)`) + `<hlm-menu-separator>` + `[hlmMenuLabel]` | Wraps `@angular/cdk/menu` — full keyboard nav (arrows, Esc, Home/End), focus management, outside-click dismiss, return-focus to trigger. Renders into an overlay portal | Row action menus (Edit/Delete/etc.), context menus, multi-select toggles. Currently used by the admin Clients page row "⋯" button and its "Columns" visibility dropdown. |

**Convention for TS helpers**: when a template's state-driven styling
depends on a function, that function returns a `BadgeVariants['variant']`
literal (e.g. `'success' | 'danger' | 'secondary'`) — NOT a Tailwind
class string. See `reservations.ts:paymentStatusBadgeVariant` and
`dashboard.ts:checkInStateBadgeVariant` for the pattern.

**Consumer-class merge rule**: any extra Tailwind classes passed via
`class="..."` (on directives) or `[class]="..."` (on components) merge
with the variant's defaults via tailwind-merge. Conflicting Tailwind
utilities (e.g. `rounded-full` vs `rounded-lg`, `max-w-md` vs
`max-w-2xl`) resolve with the consumer's class winning. The static
`class` attribute is captured on first render — dynamic `[ngClass]`
applied AFTER mount races with the directive's effect and may produce
unpredictable results. Prefer `[active]`-style state inputs or
`[class.foo]` bindings over `[ngClass]`.

**Palette**: `brand` (10-shade grayscale), `warm` (orange, formerly
named `accent`), `success`/`danger`/`warning` (each with 50/100/200/
300/400/500/700/800 — extended in Phase 6d after discovering several
shades were referenced but never defined). The shadcn semantic colors
(`bg-primary`, `text-foreground`, `border-input`, etc.) resolve to the
brand palette via HSL CSS variables in `src/styles.scss`.

Specs live next to each primitive (`src/app/shared/ui/<name>/<name>.spec.ts`)
and lock in variant behavior + tailwind-merge semantics + (for HlmDialog)
CDK focus-trap interop.

### Shell layout — `HlmSidebar` family

The authed staff/admin shell uses the Spartan **sidebar-sticky-header**
block pattern. DOM structure (only renders when authenticated; `App.html`):

```
<div hlmSidebarWrapper class="flex-col" style="--header-height: 3.5rem">
  <app-topbar>                         <!-- sticky h-14 header -->
    <button hlmBtn hlmSidebarTrigger>  <!-- toggles sidebar via service -->
    ...event chip + Quick + + New + Login...
  </app-topbar>
  <div class="flex flex-1">            <!-- row: sidebar + main -->
    <router-outlet/>                   <!-- Shell renders below -->
    <app-shell>                        <!-- display: flex; flex: 1; min-w: 0 -->
      <app-sidebar>                    <!-- display: flex; flex-shrink: 0 -->
        <hlm-sidebar>                  <!-- display: contents -->
          <div sidebar-gap w-64>       <!-- layout-occupying; animates w-64↔w-0 -->
          <aside sidebar-container>    <!-- fixed left:0; animates left:0↔-16rem -->
            <hlm-sidebar-header>       <!-- FF monogram brand chip -->
            <hlm-sidebar-content>      <!-- groups: Staff / Admin links -->
            <hlm-sidebar-footer>       <!-- user chip + logout -->
      <main hlmSidebarInset>           <!-- flex-1; reflows when gap collapses -->
        <div class="flex flex-1 flex-col p-3 md:p-4">
          <app-auth-health-banner/>
          <router-outlet/>             <!-- feature pages render here -->
```

**The key architectural point**: the sidebar's layout reservation is a
**gap div with real width**, not `padding-left` on the inset. When the
gap div animates `w-64 → w-0`, the adjacent `<main hlmSidebarInset>`
(which is `flex-1`) flex-grows into the freed space automatically. The
visual sidebar is a separate fixed-positioned `<aside>` that animates
`left: 0 → left: -16rem` in lockstep (200ms). This works in Safari and
delivers a smooth slide animation. The earlier `transition-[padding-left]`
attempt looked fine in Chrome but left content stuck at the old width in
Safari until forced reflow — see memory `safari_display_contents_flex_bug.md`.

**`HlmSidebarService` (app-wide singleton)** manages state:
- `open` — desktop expanded vs collapsed, persisted via `ff-sidebar-state`
  cookie (1-year max-age, SameSite=Lax)
- `openMobile` — mobile sheet visibility, ephemeral
- `isMobile` — matchMedia `(max-width: 767px)`; auto-updates on resize
- `toggle()` mutates whichever surface matches the viewport
- Auto-installs Cmd/Ctrl+B keyboard shortcut on first render

**Mobile sidebar does NOT route through `HlmDialog`.** It renders as
its own fixed-positioned `<aside class="fixed inset-y-0 left-0 z-[300]
w-64 rounded-r-2xl bg-sidebar shadow-2xl">` plus a sibling
`fixed inset-0 z-[290] bg-black/50` backdrop. Reason: HlmDialog's
`sheet` size variant uses `flex items-end justify-center` for centered
bottom-sheet alignment, and `left-0` / `top-0` panelClass overrides
don't apply to flex children — the sidebar ended up centered with a
gap on the left. Bypassing the dialog wrapper and positioning directly
is the simplest fix. The body overflow lock + cdkTrapFocus +
keydown.escape that HlmDialog normally provides are re-implemented
inline in `HlmSidebar` (effect-driven lock, A11yModule directives on
the aside).

`<hlm-sidebar>` and `<app-shell>` use `display: flex` (not
`display: contents`) because **Safari has long-standing bugs where
descendants under a contents-displayed element don't reliably pick up
flex sizing from the grandparent**. The contents-display pattern works
in Chrome but breaks Safari reflow on toggle. Use real flex items
throughout the shell chain.

**Brand chip uses `src/assets/FF_monogram.svg`** rendered through an
`<img class="invert">` — the SVG ships with black fill and `invert`
flips it to white on the dark `bg-sidebar-primary` tile. If you ever
need to tweak the chip color theme, change the `--sidebar-primary` HSL
in `styles.scss`, not the SVG.

**DO NOT run `@spartan-ng/cli ui` generators.** They would (a) overwrite
our hand-rolled `HlmButton` + `HlmInput` with Spartan's CSS-class-driven
convention (`.spartan-button-variant-default` instead of inline Tailwind
utilities), (b) add 5 unused primitive families (icon, separator, skeleton,
tooltip, sheet), (c) ship source written for Tailwind 4 (e.g.
`top-(--header-height)` arbitrary-value-with-var syntax that doesn't
work in Tailwind 3). Build new primitives in the same hand-rolled cva +
tailwind-merge style instead. See memory `spartan_cli_avoided.md`.

### Pagination — `HlmPagination` family

Compound primitive under `src/app/shared/ui/pagination/`. Adapted from
Spartan's `@spartan-ng/helm/pagination` source, simplified to event-only
(no RouterLink integration) since none of our paginated pages sync to
URL query params.

```
<hlm-numbered-pagination
  [(currentPage)]="currentPage"
  [(itemsPerPage)]="pageSize"
  [totalItems]="filtered().length"
  [iconOnlyEdges]="true"
  ariaLabel="Clients pagination" />
```

`currentPage` + `itemsPerPage` are `model()` signals — pass a
`WritableSignal<number>` and Angular's two-way binding hooks both
ways automatically. Page-array math (sliding window of N pages
around current, with `...` on either side) lives in
`createPageArray` + `outOfBoundCorrection` and is exported for unit
tests. Default `maxSize=7`, so a 28-page list renders as
`< 1 … 13 14 15 … 28 >` and the active page is always centered when
possible.

**Currently used by the admin Clients page** (`src/app/features/admin/clients/`)
to render 1,400+ CRM rows 50 per page. The pattern there is the
recommended one for any long client-side list:

1. Load all rows once (cheap — `GET /clients` is a single Query, ~280 KB).
2. Store in a signal: `items = signal<CrmClient[]>([])`.
3. Bind the search input via `toSignal(formControl.valueChanges)` so
   the filtered slice is a `computed()` — NOT a `*ngFor`-called
   method (see memory `feedback_ngfor_no_template_methods.md`).
4. `paginated = computed(() => filtered().slice(start, end))` — also
   a signal, not a method.
5. `effect(() => { this.query(); this.currentPage.set(1); })` to
   reset to page 1 when the search query changes.

Server-side pagination wasn't worth it for the current scale: the
DDB Query returns the whole set in one round-trip, sorted by
`lastReservationAt` desc; client-side filter is instant; the only
real pain was rendering 1,400+ DOM nodes + the template-method
anti-pattern recomputing the filter every CD cycle. If the table
ever crosses ~10k rows we'd revisit (add `LastEvaluatedKey` cursoring
to `listCrmClients` + a `Limit` query param to `GET /clients`).

Low-level pieces are exported too if a caller needs a custom layout
(`HlmPagination`, `HlmPaginationContent`, `HlmPaginationItem`,
`HlmPaginationLink`, `HlmPaginationPrevious`, `HlmPaginationNext`,
`HlmPaginationEllipsis`) — see the high-level wrapper's template for
how they compose.

### Data tables — `HlmTable` family + TanStack

Sort / filter / paginate is delegated to `@tanstack/angular-table`
(runtime dep, ~60 kB raw / ~14 kB gzipped per consumer chunk). The
`HlmTable` directives are **visual only** — pure CSS class application
on plain `<table>` markup to match the project's typography + spacing.
Compose them with TanStack's `createAngularTable` for state.

```typescript
// component
columns: ColumnDef<Row>[] = [
  { id: 'name',  accessorKey: 'name',  sortingFn: 'alphanumeric' },
  { id: 'spend', accessorFn: r => r.spend, sortingFn: 'basic' },
  // ...
  { id: 'actions', enableSorting: false },
];
table = createAngularTable<Row>(() => ({
  data: this.items(),
  columns: this.columns,
  state: {
    sorting: this.sorting(),
    globalFilter: this.query(),
    pagination: this.pagination(),
  },
  onSortingChange: u => this.sorting.set(typeof u === 'function' ? u(this.sorting()) : u),
  onPaginationChange: u => this.pagination.set(typeof u === 'function' ? u(this.pagination()) : u),
  globalFilterFn: (row, _id, q: string) => /* custom name OR phone match */,
  getCoreRowModel: getCoreRowModel(),
  getSortedRowModel: getSortedRowModel(),
  getFilteredRowModel: getFilteredRowModel(),
  getPaginationRowModel: getPaginationRowModel(),
}));
currentRows = computed(() => this.table.getRowModel().rows.map(r => r.original));
totalFiltered = computed(() => this.table.getFilteredRowModel().rows.length);
```

```html
<div hlmTableContainer>
  <table hlmTable>
    <thead hlmTHead>
      <tr hlmTr>
        <th hlmTh>
          <hlm-table-sort-header [column]="column('name')!" label="Name" />
        </th>
        <!-- ... -->
        <th hlmTh>Actions</th>
      </tr>
    </thead>
    <tbody hlmTBody>
      @for (c of currentRows(); track trackByPhone($index, c)) {
        <tr hlmTr>
          <td hlmTd>{{ c.name }}</td>
          <!-- declarative cells; no flexRender needed for simple cases -->
        </tr>
      }
    </tbody>
  </table>
</div>

<hlm-numbered-pagination
  [currentPage]="currentPage()"
  (currentPageChange)="onPageChange($event)"
  [itemsPerPage]="pageSize()"
  (itemsPerPageChange)="onPageSizeChange($event)"
  [totalItems]="totalFiltered()" />
```

**Patterns that matter:**

1. **TanStack's table proxy is itself a Signal** — `createAngularTable`
   returns `Table<T> & Signal<Table<T>>`. The options fn re-runs when
   any signal it reads changes; row models stay in sync.

2. **We don't use `FlexRenderDirective` for cells** — declarative
   `<td>{{ ... }}</td>` cells stay readable and play nicely with the
   inline edit-row pattern below. `flexRender` becomes useful when you
   need dynamic column visibility, header components with their own
   inputs, or runtime-defined cell renderers (none of which we
   currently have).

3. **`HlmTableSortHeader` uses default change detection (not OnPush)**.
   `column.getIsSorted()` is a TanStack proxy method that doesn't
   propagate signal reads across an Angular OnPush boundary. Default CD
   re-evaluates the template's `iconName()` / `ariaLabel()` /
   `sortedAttr()` methods on each event tick, which is fine for a
   single button. The alternative would be Spartan-style
   `injectFlexRenderContext` (only valid inside a flexRender body) or
   passing the sorting signal as an explicit input — both messier.

4. **Inline edit rows** — when a row is "being edited", render a
   `<tr><td colspan="N">...edit form...</td></tr>` instead of the
   normal data row. `*ngFor` over `currentRows()` lets you branch on
   `editingPhone() === c.phone` and emit either shape. This wouldn't
   compose cleanly with `flexRender`, which is another reason we keep
   cells declarative.

5. **Pagination integration** — bind our `<hlm-numbered-pagination>`
   to TanStack's `pagination.pageIndex` (0-based) via a 1-based mirror
   computed: `currentPage = computed(() => pagination().pageIndex + 1)`.
   `(currentPageChange)` handler writes back to the pagination signal.

6. **Reset to page 0 on search change** — `effect(() => { query();
   pagination.update(s => ({...s, pageIndex: 0})); })`.

The admin Clients page is the reference (`features/admin/clients/`).
When the same pattern is rolled out to Reservations list / Financials,
the per-page chunk grows by ~14 kB gzipped (TanStack vendored once,
shared across lazy chunks at runtime).

**Spartan-stock card layout**: the table is *the* visual block — not
wrapped in another card. Toolbar is bare (no "SEARCH" label / no
container card) and sits above the table-card. Page outline:

```
<section class="flex flex-col gap-4">
  <header>...title + subtitle...</header>

  <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
    <input hlmInput class="w-full sm:w-80" placeholder="Filter ..." />
    <button hlmBtn variant="outline" [hlmMenuTriggerFor]="columnsMenu">Columns ⌄</button>
  </div>

  <div class="overflow-hidden rounded-md border border-brand-200 bg-white">
    <div hlmTableContainer>
      <table hlmTable>...
```

Two wrappers around `<table>`: the outer with `overflow-hidden rounded-md border` clips the row dividers against the rounded corners, and the inner `[hlmTableContainer]` provides `overflow-x-auto` so wide tables can scroll horizontally on small viewports. Combining the two into one element forces a vertical scrollbar on the round-corner clip — split them.

The toolbar uses a **bare input** (no label, descriptive placeholder
like "Filter clients by name or phone…"). Drops the visual weight at
the top so the table is the focal point — Spartan-stock convention.
Don't wrap the input in a `<label>SEARCH</label>` block (that's the
older FF convention used on non-data-table pages).

### Dropdown menus — `HlmDropdownMenu` family

Wraps `@angular/cdk/menu` (CdkMenuTrigger, CdkMenu, CdkMenuItem) with
our styling convention. Use for row action menus (Edit / Delete / etc.)
and any "more actions" UX where multiple actions need to fit in a small
space.

```html
<button hlmBtn variant="ghost" size="icon-sm" [hlmMenuTriggerFor]="rowMenu"
  [attr.aria-label]="'Actions for ' + name">
  <ng-icon name="lucideEllipsis" size="16" />
</button>
<ng-template #rowMenu>
  <div hlmMenu>
    <button hlmMenuItem (click)="edit()">Edit</button>
    <button hlmMenuItem (click)="addToFrequent()">Add to frequent</button>
    <hlm-menu-separator />
    <button hlmMenuItem variant="destructive" (click)="delete()">Delete</button>
  </div>
</ng-template>
```

**Trigger** uses `[hlmMenuTriggerFor]="ngTemplateRef"` — pass the
template ref, NOT the menu div directly. CDK instantiates the template
into an overlay portal at the trigger's position when opened.

**Menu items** are plain `<button>`s with `[hlmMenuItem]`. CDK handles
keyboard activation (Enter / Space), arrow-key navigation between
items, Esc to dismiss, and returning focus to the trigger after close.
Click handlers fire normally; the menu auto-closes after a click on
any item.

**Destructive variant** uses `variant="destructive"` and renders the
item in danger-red. Use for irreversible / dangerous actions (Delete,
Cancel reservation, Refund). Pair with a separator above it.

**Why CDK Menu and not HlmDialog**: a menu is a transient floating
list anchored to a trigger; a dialog is a focused task with backdrop +
modal semantics. They have opposite intent. CDK's menu module is
~14 kB gzipped per lazy chunk that uses it — meaningful but worth it
for keyboard a11y + screen-reader semantics that would be painful to
hand-roll.

**Toggleable items** use `<button hlmMenuCheckbox [checked]="..."
(triggered)="...">Label</button>` — wraps `CdkMenuItemCheckbox`,
renders a leading checkmark indicator only when `checked` is true,
and keeps the menu open after click so multiple toggles work without
reopening. Used by the Clients page "Columns" dropdown to drive
TanStack's `columnVisibility` state.

```html
<button hlmBtn variant="outline" [hlmMenuTriggerFor]="columnsMenu">
  Columns <ng-icon name="lucideChevronDown" size="14" />
</button>
<ng-template #columnsMenu>
  <div hlmMenu>
    <button hlmMenuCheckbox
      [checked]="isColumnVisible('name')"
      (triggered)="toggleColumnVisibility('name')">Name</button>
    <!-- ... -->
  </div>
</ng-template>
```

In the component, mirror the TanStack visibility state as a signal
and feed it back through `state.columnVisibility` +
`onColumnVisibilityChange` so the toggle is the source of truth:

```ts
columnVisibility = signal<VisibilityState>({});
isColumnVisible(id: string) { return this.columnVisibility()[id] !== false; }
toggleColumnVisibility(id: string) {
  this.columnVisibility.update(s => ({ ...s, [id]: !this.isColumnVisible(id) }));
}
```

In the template, wrap each hidable `<th>` and `<td>` in
`*ngIf="isColumnVisible('xxx')"`, and bind the edit-row `colspan` to
`visibleColumnCount()` (computed: visible hidable columns + 1 for the
always-on actions column).

**Skipping for now (additive later)**: `HlmMenuRadio` (single-select
submenu options) and submenu support (`[hlmMenuTriggerFor]` nested
inside a menu item). Both are provided by `@angular/cdk/menu`
already; just need styled wrappers when a real use case lands.

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

scripts/                          # one-off operational helpers (NOT the build system)
  README.md                       # extract → import → backfill → merge flow
  extract_contacts_from_xlsx.py   # parse legacy reservations.xlsx → dedup contacts
  run_import_local.mjs            # bulk-import via local IAM (skips lambda+APIGW)
  import_contacts_to_crm.mjs      # same import via deployed POST /clients/bulk-import
  merge_pair.mjs                  # idempotent merge of a duplicate phone-pair (typo dupes)
  run_rename_imported_by.mjs      # bulk relabel of importedBy/updatedBy columns
  run_backfill_skipped.mjs        # smart classify+backfill for rows skipped during import
  out/                            # gitignored — contains customer PII (phone+name)
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

> Backend tests use Node 22's built-in `node:test` runner. `@aws-sdk/*` clients are devDeps at the repo root (so tests can resolve them); the Lambda nodejs22.x runtime ships those SDK modules so they're not bundled. `test:backend` covers `backend/lambda/lib/`, `backend/cognito-pre-token-gen/`, and `backend/cognito-customer-auth/`. Runtime-only deps (e.g. `passkit-generator`) live in `backend/lambda/package.json` and get bundled by `deploy.sh`.

## Auth model — read this before touching auth

- Cognito Hosted UI + code flow + PKCE via `angular-auth-oidc-client`.
- Frontend sends the **access token** (not the ID token) via `Bearer` header (`src/app/core/http/auth.interceptor.ts`).
- API Gateway HTTP API has a JWT authorizer attached **per route**. Public routes (`/public/availability`, `/check-in/pass`, `/cashapp/session*`, `/webhooks/square`, `/pay`) do NOT have the authorizer.
- Lambda re-checks `requireAdmin(event)` / `requireStaffOrAdmin(event)` for sensitive routes (`backend/lambda/index.mjs:162-174`). Defense-in-depth — do not rely on API Gateway alone.
- Cognito access tokens do NOT include `cognito:groups` by default. **A Pre Token Generation v2 Lambda trigger injects groups into the access token.** Trigger source lives in `backend/cognito-pre-token-gen/`. If it's disabled or fails, every authenticated request silently 403s with "Admin/Staff required" — staff will see a red "Auth misconfigured" banner from `AuthHealthBanner` (driven by `GET /admin/whoami`).
- Groups: `Admin`, `Staff` (managed). Users without a group fall through to the `unauthorized` page.
- Frontend role guards live in `src/app/core/guards/` (`auth.guard.ts`, `role.guard.ts`, `admin.guard.ts`).
- **Customer auth** (mobile app, separate from staff): Cognito Custom Auth phone-OTP via `backend/cognito-customer-auth/` triggers. Public mediator routes `POST /auth/customer/start` + `POST /auth/customer/verify` (in `routes-customer-auth.mjs`) wrap the synthetic-email convention so the client only handles plain phone + OTP. Customer-only routes live under `/me/*` (in `routes-me.mjs`) and use `requireCustomerOwnership(event)` (in `index.mjs:262-269`) to extract the Cognito `sub` and re-check resource ownership. Audience is enforced separately at API Gateway via the customer authorizer.
- **Token TTLs** (staff client `1kdkvis45qo915plp7lvj03u16`, set 2026-05-11): access 8h, ID 8h, refresh 30d. Silent renew via refresh token is enabled in `auth.config.ts`. **OIDC state is persisted in localStorage** via `{ provide: AbstractSecurityStorage, useClass: DefaultLocalStorageService }` in `app.config.ts` — the library's default is sessionStorage, which silently nuked the refresh token on every browser restart and made the 30-day TTL meaningless. Customer client (`21n3rd1sp4o9ka4l7tld45f0ka`) unchanged at Cognito defaults.
- **`Login` component auto-redirects already-authenticated users** to `/staff/dashboard`. Routes `''` and `'home'` both redirect to `/login`, and `/login` has no guard — without this, an authenticated user opening the app at the root URL would land on the login screen with the topbar showing. `roleGuard` on `/staff` handles the "authed but no Staff/Admin group" case, so Login doesn't need to replicate that dispatch. `App.html` uses `*ngIf="isAuthenticated$ | async"` (async pipe over a manual boolean) to avoid a bootstrap race that briefly showed the topbar over the login screen.

## Concurrency / data integrity

- All DDB writes use `ConditionExpression` and `ExpressionAttributeNames`/`Values` (never string-built expressions).
- Hold → reservation upgrade is a single `TransactWriteCommand` (`services-reservations.mjs:createReservation`). For **multi-table bookings** (PR `8503d4c`, 2026-05-11) the transaction grows to **N hold-upgrade Updates + 1 reservation Put**, where N is `tableIds.length`. Capped at `MAX_TABLES_PER_RESERVATION = 10` (well under DDB's 100-item TransactWrite limit) — input validation rejects more. Either all N+1 land or none do.
- **`POST /reservations` is idempotent on `holdId`** (audit M3): a duplicate request that loses the TransactWrite race triggers a GetItem on the hold; if it's already RESERVED with a `reservationId`, the existing reservation is returned with `idempotentReplay: true`. The route handler skips CRM upsert (which uses `ADD :amt :one` and would double-count) and auto-SMS on replay. For multi-table replay the lookup reads the *first* hold (`holdIds[0]`) — the original call promoted all N atomically, so finding any one RESERVED proves the whole booking landed.
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

`src/app/core/config/app-config.ts` hardcodes `apiBaseUrl: https://api.famosofuego.com` and the Cognito authority / hostedUiDomain / clientId / scope. No per-environment config file yet.

## Conventions

- All money in app code is **dollars** (number, 2 decimals). Square API expects minor units — conversion lives in `services-square-payments.mjs:35-41`.
- Phone numbers stored E.164 (`+1...` or `+52...`). Search uses candidate fan-out (`buildPhoneSearchCandidates`) — for any 4-9 digit prefix it tries the bare digits, `1{digits}`, and `52{digits}` against `begins_with(SK, "PHONE#…")`. Inputs <4 digits return empty (avoids overly broad scans).
- **CRM dedup is phone-only.** PK=`PHONE#{key}`. The same person who used two different phone numbers in real life appears as two CRM rows by design — staff can't always tell whether a phone belongs to the booker, the person paying, a family member, or a household. The mitigation is the staff form's typeahead (search by phone OR name), not fuzzy-merge. Ad-hoc duplicate cleanup uses `scripts/merge_pair.mjs <canonical> <orphan> --apply` — folds totals additively, takes MAX of `lastReservationAt`/`lastEventDate`, deletes the orphan.
- Times: epoch seconds for `expiresAt`/`issuedAt`/etc.; deadlines as `YYYY-MM-DDTHH:mm:ss` local-iso plus an IANA tz string (`paymentDeadlineAt`, `paymentDeadlineTz`). Default tz `America/Chicago`.
- Errors raised via `httpError(status, message)` from `core-utils.mjs`; the router's outer `try/catch` formats the response.
- Reservation `paymentStatus`: `PENDING | PARTIAL | PAID | COURTESY | REFUNDED`. `paymentMethod`: `cash | square | cashapp | credit`.
- Reservation `status`: `CONFIRMED | CANCELLED`. Lock `lockType`: `HOLD | RESERVED`.
- Cancellation `resolutionType`: `CANCEL_NO_REFUND | RESCHEDULE_CREDIT | REFUND`. REFUND iterates `payments[]`, refunds each Square/Cash App entry via `POST /v2/refunds`, then sets `paymentStatus=REFUNDED`. Partial failure throws 502 without cancelling (operator must reconcile).
- **Multi-table bookings** (commits `8503d4c` + `f0488a4`, 2026-05-11/12). A reservation row carries `tableIds: string[]` plus `tablePrices: number[]` alongside the legacy scalar `tableId` (= `tableIds[0]`) and `tablePrice` (= sum of `tablePrices`). One reservation = one customer = one deposit = one Square link / Cash App link / SMS / check-in pass / Apple Wallet pass listing every table. Cap: 10 tables per booking. **Back-compat: every reader prefers `tableIds[]` then falls back to `[tableId]`**; every writer stamps both. The shared helpers — `getReservationTableIds(reservation)` + `normalizeIdList(input)` + `formatTablesLabel(ids)` in `services-reservations-shared.mjs`, plus the Angular `TableLabelPipe` / `formatTableLabel{,Lower}` in `src/app/shared/table-label.pipe.ts` — are the only places that should branch on length; everything else just consumes the result. Cancellation derives the hold-release list from `reservation.tableIds` and loops the deletes; the `tableId` arg in `cancelReservation(eventDate, reservationId, tableId, ...)` is now a legacy fallback (used only when the row has no `tableIds`). CRM `upsertCrmClient` adds `totalTables: +N` next to `totalReservations: +1` so per-booking (visit) and per-table lifetime metrics both survive multi-table. The mobile customer flow (`routes-me.mjs` + the ff-customer-mobile repo) is **single-table only** in v1.

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
- Adding a frontend feature → standalone component under `src/app/features/`, add to `src/app/app.routes.ts` with appropriate guards. Authed staff/admin routes render *inside* `<main hlmSidebarInset>` — your feature gets the full inset width minus `p-3 md:p-4` padding. Don't add your own page-level horizontal padding unless you need to override; the shell already does it.
- Touching the shell (topbar / sidebar / `<main hlmSidebarInset>`) → see "Shell layout" subsection above for the gap-div + fixed-container pattern. The chain is `<app-root>` → wrapper → topbar + (row → shell → sidebar + main). Each level uses real `display: flex` (no `display: contents`) because Safari mishandles the contents pattern in flex grandparent chains.
- Touching `reservations-new.ts` (the staff Hold & Reserve page) → it was originally ~2k lines; pure helpers were extracted into 5 sibling modules (the orchestration + UI lives in the main file):
  - **`reservations-new-utils.ts`** — phone normalization, date/time formatters, hour/minute clamping, `normalizeSectionMapColors`. Template-bound functions (`isThisWeek`, `formatEventDate`) are re-exposed on the component as 1-line aliases.
  - **`reservations-new-active-hold.ts`** — `ActiveHoldSession` interface + `localStorage` persistence (read/write/clear) + pure lookup helpers (`findActiveHoldLock`, `findActiveHoldLocks`, `extractTableIdFromHoldLock`). Lets staff resume a multi-table hold after navigation/refresh. The persisted shape carries `tableIds?: string[]` + `holds?: ActiveHoldEntry[]` alongside the scalar `tableId`/`holdId` primary; legacy single-table sessions written before multi-table still read fine (the loader synthesizes the array from the scalar).
  - **`reservations-new-filters.ts`** — table list/map filter state: status enum + section + query, persistence in `localStorage`, pure `applyTableFilters`, label formatters.
  - **`reservations-new-credits.ts`** — reschedule-credit math: total remaining (NaN-tolerant), label formatting, applied/remaining amount math with NaN guards.
  - **`reservations-new-confirm.ts`** — `CreatedReservationContext` interface (now carries `tableIds: string[]`) + payment-method/link-mode mappers + share-message builder + `formatTablesLabel`/`formatTableLabelLower` helpers + sms/wa.me phone normalizers + async `writeClipboard`. `buildShareMessage` renders `tables A1, A2` vs `table A1` based on tableIds length.
  Each sibling has co-located `*.spec.ts` (Vitest, no Angular TestBed).
- **Multi-table booking UX** lives in `reservations-new.ts`. Single click on a free table behaves as today (replaces selection). After holding the first table, the modal exposes a **"+ Add another table"** button that closes the modal, shows a banner over the floor plan, and on the next AVAILABLE-table click appends the new table to the booking + creates a per-table hold. The selected-tables list in the modal shows each booked table with an × to release that specific hold (cannot remove the last remaining table — use "Close" / release-all). `confirmReservation` POSTs `tableIds[]` + `holdIds[]` (and the legacy scalars for back-compat). The hold-countdown timer is keyed off the primary hold; expiring it expires the whole booking. `addAnotherTablePending` is a one-shot consumed on click; `cancelAddAnotherTable()` clears it.
- **Rendering "Table X" labels** → always use the shared `TableLabelPipe` (`{{ reservation | tableLabel }}`) or `formatTableLabel`/`formatTableLabelLower` in TS — in `src/app/shared/table-label.pipe.ts`. Renders "Table A04" for single-table and "Tables A04, A05" for multi. Surfaces using it today: Dashboard (Urgent Payments, Recent Activity, detail + payment modals), reservations list (rows + detail + payment), financials (receivables + ledger + expandable rows), check-in verify banner, the staff Hold & Reserve modal + share message. **Never template `{{ reservation.tableId }}` directly** — that loses multi-table data.
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
- Touching CRM clients (`ff-clients`) → `services-clients.mjs` + `routes-clients.mjs`. Routes:
  - `GET /clients/search?phone=…&q=…` (staff/admin) — `phone` runs the indexed prefix `Query` via `buildPhoneSearchCandidates`; `q` runs a `Scan` with `PK + begins_with(SK, "PHONE#")` filter pushdown then a JS substring match on `normalizeNameForSearch(name)` (case + accent insensitive). At least one of phone/q is required (400 otherwise). Results dedupe on SK, sort by `lastReservationAt` desc, cap at 10.
  - `POST /clients/bulk-import` (admin only) — accepts `{ contacts: [{phone, phoneCountry?, name, totalReservations?, totalSpend?, lastEventDate?}] }` ≤ 500 per request. Conditional `PutItem` (`attribute_not_exists(PK) AND attribute_not_exists(SK)`) — existing rows are preserved untouched and counted as `skipped`. Concurrency 10. Used during the 2026-05-12 legacy spreadsheet backfill (1,407 rows under `importedBy: "Legacy"`).
  - The staff Hold & Reserve form (`reservations-new.ts:264-380`) wires both fields: `phone.valueChanges` → `searchByPhone(digits)` when ≥4 digits; `customerName.valueChanges` → `searchByName(q)` when name ≥2 chars **and** the phone field is empty (avoids racing the two searches). Both populate the same `clientMatches` dropdown UI in `reservations-new.html:641-659`. On exact phone match, name+phone autofill.
  - `upsertCrmClient` is still the live-reservation path (`ADD totalSpend totalReservations`); ad-hoc dupe merges go through `scripts/merge_pair.mjs`.
- Auditing auth → re-read this file's "Auth model" section, then `index.mjs:97-174` for `getGroupsFromEvent` / `requireAdmin` / `requireStaffOrAdmin` / `requireCustomerOwnership`.
- "Did SMS X arrive?" → query `sns/us-east-1/908027422124/DirectPublishToPhoneNumber` (success) or `.../Failure` (failure). Logs include `messageId`, `destination`, `providerResponse`, `dwellTimeMs`, `status`.
- "Did the cron sweep run?" → `aws logs filter-log-events --log-group-name /aws/lambda/ff-reservations-api --filter-pattern "scheduled_maintenance"`.
- **Debugging an iOS-Chrome-only bug** → visit `/?debug=1` on the phone. Loads eruda from CDN + injects a top-right fixed panel with live event counters (touch/pointer/click + viewport) and OIDC lifecycle events on console. Gated by `localStorage.ff-debug=1`; never loads for real users. Disable with `/?debug=0`. Code: `src/main.ts` (panel) + `src/app/app.ts` (OIDC).
- **`*ngFor` with template method calls is an anti-pattern** — see `topbar.ts:quickActions()` for the memoized + `trackBy` pattern. CD re-invokes the method every cycle, identity-tracking destroys/recreates DOM mid-touch, iOS Chrome drops the trailing touchend. Memory: `feedback_ngfor_no_template_methods.md`.
