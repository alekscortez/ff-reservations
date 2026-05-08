# FF Reservations — Full App + Infra Audit Handoff (for Claude Code)

## 1) Objective
Perform a **full audit** of this project:
- Angular app (UX, architecture, security, reliability)
- Lambda/API backend (correctness, data integrity, authz, payments, SMS)
- AWS infrastructure configuration (API Gateway, Cognito, DynamoDB, Lambda, IAM, Secrets, SNS, domains/CORS)
- Operational readiness for production (monitoring, rollback, env separation, test coverage)

Return findings with severity, exact file/line references, infra impacts, and phased remediation plan.

---

## 2) Important Clarification
- This repository is **not Next.js**.
- Frontend is **Angular**.
- If your checklist includes Next.js-specific checks, mark them as **not applicable** and continue with Angular equivalents.

---

## 3) Repository + Runtime Context
- Repo root: `/Users/alekscortez/WebstormProjects/ff-reservations`
- Frontend: `/Users/alekscortez/WebstormProjects/ff-reservations/src`
- Backend Lambda: `/Users/alekscortez/WebstormProjects/ff-reservations/backend/lambda`
- HTTP smoke files: `/Users/alekscortez/WebstormProjects/ff-reservations/http`

### Current stack
- Angular 21 + Tailwind
- Lambda Node.js 22 (ESM)
- API Gateway HTTP API
- DynamoDB
- Cognito Hosted UI + JWT authz
- Amplify hosting
- Square payments (links + webhook)
- SNS SMS
- ZXing for scanner flow

### Current frontend config
- `/Users/alekscortez/WebstormProjects/ff-reservations/src/app/core/config/app-config.ts`
  - API base URL currently set to `https://api.famosofuego.com`
  - Cognito authority/client/domain configured there

### Current known AWS footprint
- API Gateway HTTP API ID: `oxk1adhl3a` (historical invoke still exists)
- Custom API domain: `api.famosofuego.com`
- Cognito user pool ID: `us-east-1_Upsi9Q2Tc`
- Cognito app client ID: `1kdkvis45qo915plp7lvj03u16`
- Lambda function: `ff-reservations-api`
- DynamoDB tables used:
  - `ff-events`
  - `ff-table-holds`
  - `ff-reservations`
  - `ff-frequent-clients`
  - `ff-clients`
  - `ff-checkin-passes`
  - `ff-settings`

---

## 4) Key Functional Areas to Audit

### 4.1 Auth + Authorization
Audit:
- Cognito code flow/PKCE wiring
- JWT authorizer assumptions
- Group parsing and role enforcement consistency (`Admin`, `Staff`)
- Route protection parity frontend vs backend
- Sensitive routes accidentally staff-accessible

Primary files:
- `/Users/alekscortez/WebstormProjects/ff-reservations/src/app/core/auth/auth.service.ts`
- `/Users/alekscortez/WebstormProjects/ff-reservations/src/app/core/guards/*.ts`
- `/Users/alekscortez/WebstormProjects/ff-reservations/backend/lambda/index.mjs`
- `/Users/alekscortez/WebstormProjects/ff-reservations/backend/lambda/lib/routes-*.mjs`

### 4.2 Reservations/Holds/Concurrency
Audit:
- Hold lifecycle correctness under refresh/network interruption
- Atomicity of HOLD -> RESERVED
- Cancellation/release semantics for normal vs frequent reservations
- Deadline handling precedence (default deadline vs link TTL)

Primary files:
- `/Users/alekscortez/WebstormProjects/ff-reservations/backend/lambda/lib/services-reservations-holds.mjs`
- `/Users/alekscortez/WebstormProjects/ff-reservations/backend/lambda/lib/routes-reservations-holds.mjs`

### 4.3 Payments (Square + Cash App via Square)
Audit:
- Payment link creation, expiration and deactivation behavior
- Webhook reconciliation/idempotency
- Method mapping (`square`, `cash`, `cashapp`, `credit`)
- History/audit event naming consistency
- Edge cases: partial + overdue + repeat webhook delivery

Primary files:
- `/Users/alekscortez/WebstormProjects/ff-reservations/backend/lambda/lib/services-square-payments.mjs`
- `/Users/alekscortez/WebstormProjects/ff-reservations/backend/lambda/lib/routes-square-webhooks.mjs`
- `/Users/alekscortez/WebstormProjects/ff-reservations/backend/lambda/lib/routes-reservations-holds.mjs`
- `/Users/alekscortez/WebstormProjects/ff-reservations/src/app/features/staff/reservations/reservations.*`
- `/Users/alekscortez/WebstormProjects/ff-reservations/src/app/features/staff/reservations-new/reservations-new.*`
- `/Users/alekscortez/WebstormProjects/ff-reservations/src/app/features/public/pay/pay.*`

### 4.4 SMS Delivery + Compliance
Audit:
- SNS publish options and failure handling
- Country/origination constraints (US + MX)
- Message template consistency per channel
- Retry or compensation strategy for failed critical SMS (payment/pass)

Primary files:
- `/Users/alekscortez/WebstormProjects/ff-reservations/backend/lambda/lib/services-sms-notifications.mjs`
- `/Users/alekscortez/WebstormProjects/ff-reservations/backend/lambda/lib/services-reservations-holds.mjs`

### 4.5 Check-in Pass and Scanner Flow
Audit:
- Token hashing, replay prevention, one-time consumption
- Reissue/revoke behavior and race safety
- Public pass page data exposure and UX clarity

Primary files:
- `/Users/alekscortez/WebstormProjects/ff-reservations/backend/lambda/lib/services-checkin-passes.mjs`
- `/Users/alekscortez/WebstormProjects/ff-reservations/backend/lambda/lib/routes-checkin.mjs`
- `/Users/alekscortez/WebstormProjects/ff-reservations/src/app/features/public/check-in-pass/*`
- `/Users/alekscortez/WebstormProjects/ff-reservations/src/app/features/staff/check-in/*`

### 4.6 Settings-driven Runtime Behavior
Audit:
- Which settings are env-managed vs DB-managed
- Safe defaults and override precedence
- Backward compatibility and validation

Primary file:
- `/Users/alekscortez/WebstormProjects/ff-reservations/backend/lambda/lib/services-settings.mjs`

### 4.7 Public Availability Map
Audit:
- Data leak risk (only intended public data)
- Performance on mobile
- Status color consistency and accessibility

Primary files:
- `/Users/alekscortez/WebstormProjects/ff-reservations/src/app/features/public/availability/*`
- `/Users/alekscortez/WebstormProjects/ff-reservations/src/app/shared/components/table-map/*`
- `/Users/alekscortez/WebstormProjects/ff-reservations/backend/lambda/lib/routes-events.mjs`

### 4.8 Infra + Security Posture
Audit:
- IAM least privilege (especially SNS/Secrets/Cognito admin APIs)
- CORS allowlist correctness (`https://famosofuego.com` vs trailing slash mistakes)
- Secret management and rotation policy
- Domain migration readiness (`famosofuego.com`, `app.famosofuego.com`, `api.famosofuego.com`)

---

## 5) Baseline Local Results (already observed)

### Build
- `CI=true npm run build` succeeds.
- One warning observed:
  - CommonJS optimization warning for `qrcode` used in check-in pass page.

### Typecheck
- `npx tsc -p tsconfig.app.json --noEmit` succeeds.

### Tests
- `npm run test -- --watch=false` currently has multiple failures.
- Frequent failure themes:
  - missing auth test providers (`StsConfigLoader`)
  - stale API mocks (e.g., `eventsApi.getCurrentContext is not a function`)
  - missing route dependencies in testbed (`ActivatedRoute`)

This is likely a reliability gap in unit test setup, not necessarily runtime breakage, but should be audited and fixed.

---

## 6) Known Risks / Smells to Confirm
Please verify and expand:
1. `function.zip` is present under source tree:
   - `/Users/alekscortez/WebstormProjects/ff-reservations/backend/lambda/function.zip`
   - likely should stay untracked/ignored.
2. Environment-specific values are hard-coded in app config file (not per build target).
3. No clear infra-as-code source of truth (manual console drift risk).
4. Legacy endpoint naming vs canonical naming could still exist in some clients/docs.
5. SMS deliverability is strongly dependent on origination identity setup and country rules.

---

## 7) Commands to Run (Audit Pass)
From repo root:

```bash
pwd
git status --short

# frontend sanity
CI=true npm run build
npx tsc -p tsconfig.app.json --noEmit
npm run test -- --watch=false

# quick route inventory
rg -n "path ===|path.match|method ===" backend/lambda/lib/routes-*.mjs backend/lambda/index.mjs -S

# settings/env usage
rg -n "process\.env|SQUARE_|SMS_|CHECKIN_|SETTINGS_TABLE|CASH_APP" backend/lambda/index.mjs backend/lambda/lib -S

# TODO/fixme hotspots
rg -n "TODO|FIXME|HACK|XXX" src backend/lambda -S
```

If AWS CLI credentials are available, also validate live infra:

```bash
aws sts get-caller-identity
aws lambda get-function-configuration --function-name ff-reservations-api --region us-east-1
aws apigatewayv2 get-apis --region us-east-1
aws apigatewayv2 get-routes --api-id oxk1adhl3a --region us-east-1
aws apigatewayv2 get-domain-names --region us-east-1
aws dynamodb describe-table --table-name ff-reservations --region us-east-1
```

---

## 8) Required Deliverables from Claude
Return in this exact structure:

1. **Executive Summary**
- overall risk rating (Low/Medium/High)
- top 5 production blockers

2. **Findings (by severity)**
- Critical
- High
- Medium
- Low

For each finding:
- title
- why it matters
- evidence (file path + line or infra setting)
- minimal fix
- longer-term fix

3. **Infra Gap Report**
- auth
- API Gateway
- Lambda
- DynamoDB
- IAM
- Secrets
- SNS messaging
- Domain/DNS/TLS
- Observability/alerts

4. **Data Integrity & Concurrency Review**
- holds/reservations race scenarios
- webhook idempotency scenarios
- cancellation/release scenarios

5. **Security Review**
- authz bypass possibilities
- injection/input validation
- sensitive data exposure in public routes

6. **Performance & Cost Review**
- top likely AWS cost drivers
- polling behavior impact
- suggestions to reduce cost without reducing reliability

7. **Testing Plan**
- list missing tests
- fix failing tests priority order
- add regression tests for payment/SMS/check-in flows

8. **90-Day Remediation Plan**
- Phase 1 (1-2 weeks)
- Phase 2 (2-4 weeks)
- Phase 3 (4-12 weeks)
- include owner role suggestions (backend/frontend/devops)

---

## 9) Context Notes for Reviewer
- This app is actively evolving; compatibility tradeoffs may exist.
- Prioritize **reliability and correctness** over stylistic refactors.
- Focus hard on:
  - payment correctness
  - reservation consistency
  - SMS compliance/deliverability
  - check-in pass anti-replay
  - safe admin capabilities

