# FF Reservations

Nightclub reservations platform with role-aware staff/admin web app, serverless API, payment links, SMS notifications, check-in passes, and public live table map.

## Stack
- Frontend: Angular 21 + Tailwind (`/src`)
- Backend: AWS Lambda Node.js 22 (ESM) (`/backend/lambda`)
- API: API Gateway HTTP API (`$default` stage)
- Data: DynamoDB
- Auth: Cognito Hosted UI + JWT authorizer
- Hosting: Amplify (web)
- Payments: Square (payment links + webhook handling)
- Messaging: Amazon SNS (SMS)
- Scanner: ZXing for QR check-in flow

## Current AWS context
- API base URL: `https://oxk1adhl3a.execute-api.us-east-1.amazonaws.com`
- Cognito user pool: `us-east-1_Upsi9Q2Tc`
- Cognito app client: `1kdkvis45qo915plp7lvj03u16`
- Amplify URL: `https://main.d1gxn3rvy5gfn4.amplifyapp.com`

## Core flows implemented
- Event management with one active event per date lock.
- Table hold lifecycle (short hold), reservation creation, cancellation, payment updates.
- Staff payment collection with `cash`, `square`, and reschedule credit usage.
- Square payment links + webhook reconciliation.
- SMS send for payment links and check-in communications.
- Check-in pass issue/reissue + one-time QR validation.
- Public live map route at `/map?eventDate=YYYY-MM-DD` (also `/availability` alias).

## Important business rules
- One active event per calendar day.
- No double booking for the same event/table.
- Atomic `HOLD -> RESERVED` protection.
- Pending/partial payments require deadline behavior.
- Reschedule credits supported with expiration and application tracking.
- Check-in pass is one-time use.

## Repository layout
- `/src` Angular app
- `/backend/lambda` Lambda handler and service modules
- `/http` HTTP client requests for smoke/debug testing
- `/src/assets/maps/FF_Reservations_Map.normalized.svg` live table map asset

## Local development

### Prerequisites
- Node.js 20+ (frontend)
- npm 11+
- AWS CLI configured for deployment/testing

### Frontend
```bash
npm install
npm start
```
App runs at `http://localhost:4200`.

Config lives in:
- `/src/app/core/config/app-config.ts`

If you need a different API/Cognito setup (dev/staging/prod), update that config file before build/deploy.

### Lambda (manual deploy script)
From `/backend/lambda`:
```bash
./deploy.sh
```

Defaults used by script:
- `FUNCTION_NAME=ff-reservations-api`
- `AWS_REGION=us-east-1`
- `TIMEOUT_SECONDS=15`
- `MEMORY_SIZE_MB=256`

Override example:
```bash
FUNCTION_NAME=ff-reservations-api AWS_REGION=us-east-1 ./deploy.sh
```

## Lambda environment variables
Main expected keys:
- `EVENTS_TABLE`
- `HOLDS_TABLE`
- `RES_TABLE`
- `FREQUENT_CLIENTS_TABLE`
- `CLIENTS_TABLE`
- `CHECKIN_PASSES_TABLE`
- `SETTINGS_TABLE`
- `USER_POOL_ID`
- `SQUARE_SECRET_ARN`
- `SQUARE_ENV`
- `SQUARE_LOCATION_ID`
- `SQUARE_API_VERSION`
- `SQUARE_WEBHOOK_NOTIFICATION_URL`
- `SMS_ENABLED`
- `SMS_SENDER_ID`
- `SMS_TYPE`
- `SMS_MAX_PRICE_USD`
- `AUTO_SEND_SQUARE_LINK_SMS`
- `PAYMENT_LINK_TTL_MINUTES`
- `CHECKIN_PASS_BASE_URL`
- `CHECKIN_PASS_TTL_DAYS`
- `SQUARE_CURRENCY`

## Required IAM highlights (Lambda role)
- DynamoDB read/write/query/update/txn on all project tables + indexes.
- `cognito-idp:AdminGetUser` on user pool.
- `secretsmanager:GetSecretValue` on Square secret ARN.
- `sns:Publish` for SMS sends.

## HTTP smoke/debug requests
Use files in `/http`:
- `events.http`
- `tables.http`
- `holds.http`
- `reservations.http`
- `clients.http`
- `frequent-clients.http`
- `check-in.http`
- `square-smoke.http`
- `square-webhook.http`
- `smoke-debug.http`
- `public-availability.http`

Environment variables for `.http` runs should be kept local (not committed), for example:
- `/http-client/http-client.private.env.json`

## Security notes
- Do not commit live access tokens, webhook secrets, or private keys.
- Keep Square credentials in Secrets Manager and reference by ARN.
- Keep Cognito callback/logout URLs aligned with active environment.
- Rotate any token accidentally saved in local HTTP files.

## Common troubleshooting
- `401 Unauthorized` in `.http`: refresh access token.
- `403` admin route: verify `cognito:groups` claim and JWT authorizer.
- `redirect_mismatch`: callback URL mismatch in Cognito app client settings.
- CORS issues on mobile/ngrok: add origin to API Gateway CORS allowlist.
- Square webhook not updating reservation: verify webhook signature key, route, and Lambda logs.
- SMS not delivered: verify SNS sandbox/production status and spend limits.

## Build and test
```bash
npm run build
npm run test
npx tsc -p tsconfig.app.json --noEmit
```

## Notes for contributors
- Keep commits scoped (frontend UX vs backend behavior vs infra).
- Avoid mixing unrelated refactors in functional bugfix commits.
- For UI changes, verify both mobile and desktop behavior.
