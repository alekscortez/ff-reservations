# scripts/

One-off operational helpers for the CRM. **Not** part of the build/CI system —
all of these are for ad-hoc data work against the production `ff-clients` table.

> **Status (2026-05-12):** the legacy spreadsheet import already ran; production
> CRM has 1,414 contacts, of which 1,407 carry `importedBy: "Legacy"`. You only
> need to re-run the import flow if the source workbook gets updated. The other
> helpers (merge_pair, run_rename_imported_by, run_backfill_skipped) stay
> useful for ongoing CRM hygiene.

## Files

| script | purpose |
|---|---|
| `extract_contacts_from_xlsx.py` | Parse the legacy `src/assets/reservations.xlsx` (90+ event sheets), dedupe by E.164 phone, emit JSON+CSV under `out/`. |
| `run_import_local.mjs` | Bulk-import via local IAM credentials — calls `bulkImportCrmClients` directly with `@aws-sdk/lib-dynamodb`. **Preferred** (no token needed, faster). |
| `import_contacts_to_crm.mjs` | Same import but via the deployed `POST /clients/bulk-import` endpoint. Needs an admin Bearer token. Use this if local IAM isn't available. |
| `merge_pair.mjs` | Idempotent merge of one duplicate phone-pair (typo-transposed digits, etc.). Folds totals additively, takes MAX of `lastReservationAt`/`lastEventDate`, deletes the orphan. |
| `run_rename_imported_by.mjs` | Bulk relabel of the `importedBy`/`updatedBy` columns across all 1,407 imported rows. Used to swap the verbose date string for `"Legacy"`. |
| `run_backfill_skipped.mjs` | For rows the import skipped (already existed in CRM): smart classify per row — if sheet aggregates differ from current, additively backfill; if exactly equal, only stamp `importedBy: "Legacy"` (avoids double-counting transition-period reservations). |
| `out/` | Outputs (gitignored — contains customer PII). |

## Original import flow (already done — kept for reference)

```
reservations.xlsx
   │  (1) extract_contacts_from_xlsx.py
   ▼
out/contacts_dedup.json   (gitignored — PII)
   │  (2) run_import_local.mjs        ← preferred
   │      OR import_contacts_to_crm.mjs (token-based)
   ▼
ff-clients DynamoDB table
```

### Step 1 — Extract + dedupe (local, no AWS)

```bash
python3 scripts/extract_contacts_from_xlsx.py
```

Reads `src/assets/reservations.xlsx` (gitignored — keep local) and writes:

- `out/contacts_dedup.json` — one record per unique normalized E.164 phone
- `out/contacts_dedup.csv` — same, for spreadsheet review
- `out/contacts_raw.json` — every row before dedupe (forensic archive)
- `out/contacts_dropped.json` — rows skipped with reason (no phone, unparseable phone, placeholder name)
- `out/contacts_summary.json` — top-level counts

Idempotent — re-run any time the workbook is updated.

### Step 2 — Bulk insert into `ff-clients`

**Option A (preferred): local IAM, no API hop**

```bash
FF_DRY_RUN=1 node scripts/run_import_local.mjs   # dry-run
node scripts/run_import_local.mjs                # apply
```

Uses your local AWS credentials directly via `@aws-sdk/lib-dynamodb`. Faster, no
token needed. Calls the same `bulkImportCrmClients` service code that the lambda
runs, so behavior is identical.

**Option B: through the deployed API**

```bash
FF_DRY_RUN=1 node scripts/import_contacts_to_crm.mjs   # dry-run
FF_ADMIN_TOKEN="eyJ…" node scripts/import_contacts_to_crm.mjs   # apply
```

Get the admin Cognito token: log in as admin → dev tools → Network → copy the
value after `Bearer ` from any authed request. Slower (HTTP roundtrips) but
useful when IAM access isn't available.

**Either path is safe to re-run.** The lambda uses
`ConditionExpression: attribute_not_exists(PK) AND attribute_not_exists(SK)`,
so existing rows are preserved and counted as `skipped`.

## What gets imported

Per the design discussion, only the per-customer aggregates — **not** individual
historical reservations (which would pollute the reservations table and skew
dashboards):

| Field               | Source                                       |
|---------------------|----------------------------------------------|
| `name`              | most-frequent spelling across all rows       |
| `phone`             | E.164 (default `+1`)                         |
| `phoneCountry`      | `US` (956 area code dominates)               |
| `totalReservations` | count of rows for that phone                 |
| `totalSpend`        | sum of `price` for paid statuses             |
| `lastEventDate`     | latest event date                            |
| `lastReservationAt` | epoch seconds at midnight UTC of last event  |
| `importedAt` / `importedBy` | audit fields (`importedBy: "Legacy"`)|

`alternateNames` and per-row reservation history are deliberately dropped —
they live in the gitignored `out/contacts_raw.json` if anyone needs them later.

## Ad-hoc CRM hygiene helpers

### `merge_pair.mjs` — fold an orphan into a canonical row

Use when staff finds two CRM rows that should be one (typo-transposed digits,
shared family phone entered with different surnames, etc.). Picks the canonical
(higher-totalReservations) row to keep:

```bash
node scripts/merge_pair.mjs +19564147489 +19564147498           # dry-run
node scripts/merge_pair.mjs +19564147489 +19564147498 --apply   # write
```

Adds `orphan.totalReservations + orphan.totalSpend` to the canonical, takes the
later `lastEventDate` / `lastReservationAt`, then deletes the orphan. Idempotent
(re-run after success is a no-op — the orphan won't exist anymore).

### `run_rename_imported_by.mjs` — bulk relabel

Originally used to swap the verbose `"spreadsheet-import-2026-05-11"` label for
`"Legacy"`. Reads `out/contacts_dedup.json` and conditionally updates each row:

```bash
FF_DRY_RUN=1 node scripts/run_rename_imported_by.mjs   # count would-update
node scripts/run_rename_imported_by.mjs                # apply
```

Uses `ConditionExpression: updatedBy = :oldLabel AND importedBy = :oldLabel`
so it leaves alone any row that's been touched in the meantime.

### `run_backfill_skipped.mjs` — populate skipped rows

For the 4 rows that were skipped during the original import (because they
already existed in `ff-clients` from frequent-client sync or admin edits):

```bash
FF_DRY_RUN=1 node scripts/run_backfill_skipped.mjs   # show before/after
node scripts/run_backfill_skipped.mjs                # apply
```

Per-row classification:
- **backfill**: sheet aggregates differ from current → additive `ADD`
- **considered-only**: sheet aggregates exactly match current (transition-period
  double-entry) → only stamp `importedBy: "Legacy"`, no count change

Doesn't touch `name`, `phone`, `lastReservationAt`, `lastTableId`, or `updatedBy`
(preserves real attribution and live state).

## Env knobs (importer scripts)

| var               | default                           | what                                      |
|-------------------|-----------------------------------|-------------------------------------------|
| `FF_ADMIN_TOKEN`  | (required for HTTP path)          | Cognito admin access token                |
| `FF_API_BASE`     | `https://api.famosofuego.com`     | API base URL (HTTP path)                  |
| `FF_INPUT_FILE`   | `scripts/out/contacts_dedup.json` | input JSON                                |
| `FF_CHUNK_SIZE`   | `200` (server cap 500)            | contacts per request                      |
| `FF_DRY_RUN`      | `0`                               | `1` skips writes                          |
| `AWS_REGION`      | `us-east-1`                       | for the local-IAM path                    |
| `AWS_PROFILE`     | (whatever the SDK picks up)       | for the local-IAM path                    |

## API Gateway route registration (one-time)

The bulk-import route is already registered. If you ever need to re-create it:

```bash
aws apigatewayv2 create-route --api-id oxk1adhl3a \
  --route-key "POST /clients/bulk-import" \
  --target "integrations/0bj43cm" \
  --authorization-type JWT --authorizer-id 5ea6tk \
  --region us-east-1
```

(Staff JWT authorizer — admin enforcement is in the handler via `requireAdmin`.)
