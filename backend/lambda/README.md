# Lambda (ff-reservations-api)

Source for the `ff-reservations-api` Lambda — the single backend behind every API Gateway route in this app, plus the EventBridge cron for overdue-reservation cleanup.

## Files

- `index.mjs` — Lambda handler: HTTP router + EventBridge dispatch + auth helpers + CORS allowlist
- `lib/routes-*.mjs` — Per-domain route handlers
- `lib/services-*.mjs` — Per-domain business logic (DDB writes, Square API calls, SMS, etc.)
- `lib/core-utils.mjs` — Phone normalization, `httpError`, `json` response helpers
- `table-template.json` — Static venue floor plan (table IDs, sections, prices)
- `deploy.sh` — `aws lambda update-function-code` wrapper

## Deploy

```bash
./deploy.sh
```

Zips `index.mjs` + `table-template.json` + `lib/` into `function.zip`, calls `aws lambda update-function-code` against `ff-reservations-api` in `us-east-1`, waits for the update to finish, then re-applies `timeout=15s memory=256MB`.

Override defaults via env:

```bash
FUNCTION_NAME=ff-reservations-api AWS_REGION=us-east-1 \
  TIMEOUT_SECONDS=15 MEMORY_SIZE_MB=256 \
  ./deploy.sh
```

`function.zip` is generated locally and gitignored.

## Adding a new route

API Gateway uses **explicit per-route definitions** — no `$default` proxy. Adding a route is two steps:

1. Implement the handler in the relevant `lib/routes-*.mjs`, wire it through `index.mjs`'s router.
2. Register the route in API Gateway:
   ```bash
   aws apigatewayv2 create-route --api-id oxk1adhl3a \
     --route-key "GET /your/new/route" \
     --target "integrations/0bj43cm" \
     --authorization-type JWT --authorizer-id 5ea6tk \
     --region us-east-1
   ```
   For public routes, omit `--authorization-type` / `--authorizer-id` (defaults to `NONE`).

## Operational dependencies (not in this folder)

- **Cognito Pre Token Generation v2 Lambda** (`backend/cognito-pre-token-gen/`) injects `cognito:groups` into the access token. Without it, every authenticated request returns 403.
- **EventBridge rule `ff-reservations-overdue-release`** fires `rate(1 minute)` and invokes this lambda with `event.source = "aws.events"`. The handler dispatches to `runScheduledMaintenance` → `releaseOverdueReservationsForAllActiveEvents`. Disabling the rule means overdue reservations only get cleaned up when a staff member loads `/reservations` or hits a payment route for that event.
- **Square secret** stored in Secrets Manager at `ff/square/production-QaNJNJ` — JSON with `SQUARE_ACCESS_TOKEN` and `SQUARE_WEBHOOK_SIGNATURE_KEY`. Lambda role needs `secretsmanager:GetSecretValue` on this ARN.

## Verifying a deploy

```bash
aws lambda get-function-configuration --function-name ff-reservations-api \
  --region us-east-1 \
  --query '{State:State,LastUpdate:LastUpdateStatus,Modified:LastModified,Sha:CodeSha256}' \
  --output json
```

Then watch the cron land via:

```bash
aws logs tail /aws/lambda/ff-reservations-api --follow --filter-pattern "scheduled_maintenance" --region us-east-1
```

(Should see one entry per minute.)

## See also

- `/CLAUDE.md` — full architecture, conventions, auth model, env vars.
- `/backend/cognito-pre-token-gen/README.md` — Pre Token Gen Lambda deploy steps.
