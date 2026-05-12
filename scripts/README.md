# scripts/

One-off scripts for the reservations spreadsheet → CRM import. The flow is:

```
reservations.xlsx
   │  (1) extract_contacts_from_xlsx.py
   ▼
scripts/out/contacts_dedup.json   (gitignored — PII)
   │  (2) import_contacts_to_crm.mjs
   ▼
POST /clients/bulk-import         (admin-only lambda route)
   ▼
ff-clients DynamoDB table
```

## 1. Extract + dedupe (local, no AWS)

```bash
python3 scripts/extract_contacts_from_xlsx.py
```

Reads `src/assets/reservations.xlsx` and writes `scripts/out/`:

- `contacts_dedup.json` — one record per unique normalized phone
- `contacts_dedup.csv` — same, for spreadsheet review
- `contacts_raw.json` — every row before dedupe (forensic archive)
- `contacts_dropped.json` — rows skipped with reason
- `contacts_summary.json` — top-level counts

The script is idempotent — re-run any time the workbook is updated.

## 2. Deploy the lambda

The bulk-import endpoint is in `backend/lambda/lib/routes-clients.mjs` +
`services-clients.mjs`. After pulling those changes:

```bash
bash backend/lambda/deploy.sh
```

## 3. Register the API Gateway route (one-time, only if not already registered)

```bash
aws apigatewayv2 create-route --api-id oxk1adhl3a \
  --route-key "POST /clients/bulk-import" \
  --target "integrations/0bj43cm" \
  --authorization-type JWT --authorizer-id 5ea6tk \
  --region us-east-1
```

(Staff JWT authorizer — admin enforcement is in the handler via `requireAdmin`.)

## 4. Run the importer

Get an admin Cognito access token: log in as admin → dev tools → Network tab →
copy the value after `Bearer ` from any authed request's Authorization header.

Dry run first (no API call, just prints what would be sent):

```bash
FF_DRY_RUN=1 node scripts/import_contacts_to_crm.mjs
```

Real run:

```bash
FF_ADMIN_TOKEN="eyJ…" node scripts/import_contacts_to_crm.mjs
```

The importer chunks 200 contacts per request and prints a per-chunk summary.
**Re-running is safe** — the lambda uses `ConditionExpression: attribute_not_exists(PK) AND attribute_not_exists(SK)`,
so any contact that already exists in `ff-clients` is left untouched and counted
as `skipped`. Only brand-new phone numbers get inserted.

## What gets imported

Per the design discussion, only the per-customer aggregates — not individual
historical reservations:

| Field               | Source                                       |
|---------------------|----------------------------------------------|
| `name`              | most-frequent spelling across all rows       |
| `phone`             | E.164 (default `+1`)                         |
| `phoneCountry`      | `US` (956 area code dominates)               |
| `totalReservations` | count of rows for that phone                 |
| `totalSpend`        | sum of `price` for paid statuses             |
| `lastEventDate`     | latest event date                            |
| `lastReservationAt` | epoch seconds at midnight UTC of last event  |
| `importedAt` / `importedBy` | audit fields                         |

`alternateNames` and per-row reservation history are deliberately dropped — they
live in the gitignored `contacts_raw.json` if anyone needs them later.

## Env knobs (importer)

| var               | default                           | what                                      |
|-------------------|-----------------------------------|-------------------------------------------|
| `FF_ADMIN_TOKEN`  | (required)                        | Cognito admin access token                |
| `FF_API_BASE`     | `https://api.famosofuego.com`     | API base URL                              |
| `FF_INPUT_FILE`   | `scripts/out/contacts_dedup.json` | input JSON                                |
| `FF_CHUNK_SIZE`   | `200` (server cap 500)            | contacts per request                      |
| `FF_DRY_RUN`      | `0`                               | `1` skips network calls                   |
