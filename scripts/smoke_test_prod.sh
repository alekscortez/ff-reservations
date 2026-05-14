#!/usr/bin/env bash
# Production smoke test for ff-reservations.
#
# Run before a busy night (or any time you want to confirm the live
# system is healthy). Hits public endpoints, asserts response shapes,
# and checks CloudWatch alarm states.
#
# Exits non-zero if any check fails. Designed to take ~10s.
#
# Usage: bash scripts/smoke_test_prod.sh
#
# No arguments. Requires aws CLI configured + curl + jq.

set -uo pipefail

API_BASE="https://api.famosofuego.com"
WEB_BASE="https://famosofuego.com"
AMPLIFY_APP_ID="d1gxn3rvy5gfn4"

PASS=0
FAIL=0
WARN=0
RESULTS=()

ts() { date +%H:%M:%S; }

check() {
  local name="$1"
  local cmd="$2"
  local expected="$3"
  local actual
  actual=$(eval "$cmd" 2>&1)
  if [ "$actual" = "$expected" ]; then
    PASS=$((PASS + 1))
    RESULTS+=("✓ $name")
  else
    FAIL=$((FAIL + 1))
    RESULTS+=("✗ $name (expected '$expected', got '$actual')")
  fi
}

warn_check() {
  local name="$1"
  local cmd="$2"
  local expected="$3"
  local actual
  actual=$(eval "$cmd" 2>&1)
  if [ "$actual" = "$expected" ]; then
    PASS=$((PASS + 1))
    RESULTS+=("✓ $name")
  else
    WARN=$((WARN + 1))
    RESULTS+=("! $name (expected '$expected', got '$actual')")
  fi
}

echo "[$(ts)] FF Reservations production smoke test"
echo "[$(ts)] Testing $API_BASE + $WEB_BASE"
echo ""

# -----------------------------------------------------------------------------
# 1. Public availability (anonymous customer hitting /map)
# -----------------------------------------------------------------------------
TODAY_PLUS_3=$(date -v +3d +%Y-%m-%d 2>/dev/null || date -d "+3 days" +%Y-%m-%d)
AVAIL_BODY=$(curl -s --max-time 10 "$API_BASE/public/availability?eventDate=$TODAY_PLUS_3")

check "public/availability returns 200 (HTTP)" \
  "curl -s -o /dev/null -w '%{http_code}' --max-time 10 '$API_BASE/public/availability?eventDate=$TODAY_PLUS_3'" \
  "200"

check "public/availability response has 'tables' field" \
  "echo '$AVAIL_BODY' | jq -r 'has(\"tables\")'" \
  "true"

check "public/availability response has anon-public booking flag" \
  "echo '$AVAIL_BODY' | jq -r 'has(\"allowAnonymousPublicBooking\")'" \
  "true"

check "public/availability response has Turnstile site key field" \
  "echo '$AVAIL_BODY' | jq -r 'has(\"turnstileSiteKey\")'" \
  "true"

check "public/availability response has customer contact phone field" \
  "echo '$AVAIL_BODY' | jq -r 'has(\"customerContactPhoneE164\")'" \
  "true"

# -----------------------------------------------------------------------------
# 2. Public reservation by token (auth gate)
# -----------------------------------------------------------------------------
check "public/reservations/{id} 401 without token" \
  "curl -s -o /dev/null -w '%{http_code}' --max-time 10 '$API_BASE/public/reservations/abc?eventDate=2026-05-16'" \
  "401"

# -----------------------------------------------------------------------------
# 3. Slug short-URL proxy (branded URL → /r redirect)
# -----------------------------------------------------------------------------
# 404 is expected for an invalid slug — proves the route exists and reaches
# our handler (not just bouncing off CloudFront).
check "famosofuego.com/p/{slug} reaches the handler (404 on invalid)" \
  "curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X GET '$WEB_BASE/p/INVALIDSLUG12345'" \
  "404"

check "api.famosofuego.com/p/{slug} reaches the handler (404 on invalid)" \
  "curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X GET '$API_BASE/p/INVALIDSLUG12345'" \
  "404"

# -----------------------------------------------------------------------------
# 4. Staff routes (auth gates)
# -----------------------------------------------------------------------------
check "staff /reservations/by-code 401 without auth" \
  "curl -s -o /dev/null -w '%{http_code}' --max-time 10 '$API_BASE/reservations/by-code/INVALID'" \
  "401"

check "staff /reservations 401 without auth" \
  "curl -s -o /dev/null -w '%{http_code}' --max-time 10 '$API_BASE/reservations?eventDate=2026-05-16'" \
  "401"

# -----------------------------------------------------------------------------
# 5. Square webhook receiver (public, no auth)
# -----------------------------------------------------------------------------
# Should 403 for an unsigned POST. Proves the route is alive and signature
# verification is enforced. (401 means JWT failure, 403 means our signature
# check rejected the body — the latter is what we want here.)
check "webhooks/square rejects unsigned POST (403)" \
  "curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X POST -H 'Content-Type: application/json' -d '{}' '$API_BASE/webhooks/square'" \
  "403"

# -----------------------------------------------------------------------------
# 6. CloudWatch alarms — all should be in OK state
# -----------------------------------------------------------------------------
ALARM_STATES=$(aws cloudwatch describe-alarms --alarm-name-prefix ff- \
  --query 'MetricAlarms[].StateValue' --output text 2>/dev/null)
ALARM_NOT_OK=$(echo "$ALARM_STATES" | tr '\t' '\n' | grep -v '^OK$' | wc -l | xargs)

if [ "$ALARM_NOT_OK" = "0" ]; then
  PASS=$((PASS + 1))
  RESULTS+=("✓ All ff-* CloudWatch alarms in OK state")
else
  FAIL=$((FAIL + 1))
  NOT_OK_DETAIL=$(aws cloudwatch describe-alarms --alarm-name-prefix ff- \
    --query 'MetricAlarms[?StateValue!=`OK`].[AlarmName,StateValue]' --output text 2>/dev/null | tr '\t' ' ')
  RESULTS+=("✗ $ALARM_NOT_OK CloudWatch alarms not OK: $NOT_OK_DETAIL")
fi

# -----------------------------------------------------------------------------
# 7. Lambda last-update health
# -----------------------------------------------------------------------------
LAMBDA_STATUS=$(aws lambda get-function-configuration \
  --function-name ff-reservations-api \
  --query 'LastUpdateStatus' --output text 2>/dev/null)
check "Lambda LastUpdateStatus is Successful" "echo '$LAMBDA_STATUS'" "Successful"

# -----------------------------------------------------------------------------
# 8. Most recent Amplify build succeeded
# -----------------------------------------------------------------------------
AMPLIFY_LAST=$(aws amplify list-jobs --app-id "$AMPLIFY_APP_ID" --branch-name main \
  --max-results 1 --query 'jobSummaries[0].status' --output text 2>/dev/null)
check "Latest Amplify build succeeded" "echo '$AMPLIFY_LAST'" "SUCCEED"

# -----------------------------------------------------------------------------
# 9. Cron sweep ran in the last 5 min (proves EventBridge → Lambda still alive)
# -----------------------------------------------------------------------------
# `aws logs filter-log-events` paginates. `--query 'events | length(@)'`
# evaluates per page, so we get one count per page (e.g. "5\n0\n0").
# Sum them up before comparing.
FIVE_MIN_AGO=$(($(date +%s) * 1000 - 300000))
CRON_HITS=$(aws logs filter-log-events --log-group-name /aws/lambda/ff-reservations-api \
  --filter-pattern "scheduled_maintenance" \
  --start-time "$FIVE_MIN_AGO" \
  --query 'events | length(@)' --output text 2>/dev/null \
  | awk '{ s += $1 } END { print s+0 }')
if [ "$CRON_HITS" -gt 0 ]; then
  PASS=$((PASS + 1))
  RESULTS+=("✓ Cron sweep ran ${CRON_HITS}x in last 5 min")
else
  WARN=$((WARN + 1))
  RESULTS+=("! No scheduled_maintenance log events in last 5 min — check EventBridge rule")
fi

# -----------------------------------------------------------------------------
# Report
# -----------------------------------------------------------------------------
echo ""
echo "[$(ts)] Results:"
for r in "${RESULTS[@]}"; do echo "  $r"; done
echo ""
echo "[$(ts)] Summary: $PASS passed, $FAIL failed, $WARN warnings"

if [ "$FAIL" -gt 0 ]; then
  echo "[$(ts)] FAIL — investigate before serving customers"
  exit 1
elif [ "$WARN" -gt 0 ]; then
  echo "[$(ts)] PASS WITH WARNINGS — system functional but verify warnings"
  exit 0
else
  echo "[$(ts)] PASS — system healthy"
  exit 0
fi
