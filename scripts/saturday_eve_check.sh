#!/usr/bin/env bash
# Saturday-eve checklist — run the day before a busy night.
#
# Output is a readable report covering:
#   1. Production config sanity for the upcoming event
#      (event exists + prices + section colors + Turnstile + contact phone)
#   2. Current reservation state breakdown (paid/pending/cancelled by section)
#   3. Active anon phone slots (customers who are mid-flow right now)
#   4. Last-24h funnel summary from CloudWatch
#   5. Pending PAID-not-yet customers — the staff-created bookings that
#      need a follow-up call/SMS before they expire
#
# Usage: bash scripts/saturday_eve_check.sh [YYYY-MM-DD]
#   no arg → defaults to next Saturday from today
#
# Exits 0 if everything looks healthy; 1 if any required config is
# missing. Soft-warns (no exit) on operational anomalies.

set -uo pipefail

API_BASE="https://api.famosofuego.com"

# Default event date = next Saturday (or today if today is Saturday)
default_event_date() {
  if date -j > /dev/null 2>&1; then
    # macOS / BSD date
    local today_dow
    today_dow=$(date +%u)  # 1=Mon..7=Sun, Sat=6
    local days_ahead=$(( (6 - today_dow + 7) % 7 ))
    if [ "$days_ahead" = "0" ]; then days_ahead=7; fi
    date -v +${days_ahead}d +%Y-%m-%d
  else
    # GNU date
    date -d "next saturday" +%Y-%m-%d
  fi
}

EVENT_DATE="${1:-$(default_event_date)}"
WARN=0
FAIL=0

ts() { date +%H:%M:%S; }
hr() { printf '\n%s\n' "----------------------------------------"; }
section() { hr; printf '## %s\n' "$1"; hr; }
ok()   { printf '  ✓ %s\n' "$1"; }
warn() { printf '  ! %s\n' "$1"; WARN=$((WARN + 1)); }
fail() { printf '  ✗ %s\n' "$1"; FAIL=$((FAIL + 1)); }

echo "[$(ts)] FF Saturday-eve checklist for event $EVENT_DATE"

# -----------------------------------------------------------------------------
# 1. Production config (public/availability snapshot)
# -----------------------------------------------------------------------------
section "1. Production config — public/availability for $EVENT_DATE"

CFG=$(curl -s --max-time 10 "$API_BASE/public/availability?eventDate=$EVENT_DATE")
if [ -z "$CFG" ] || [ "$(echo "$CFG" | jq -r 'type' 2>/dev/null)" != "object" ]; then
  fail "Could not fetch public/availability — is the API up?"
  echo "[$(ts)] ABORT — fix the API before continuing"
  exit 1
fi

# Event existence + name
EVENT_ID=$(echo "$CFG" | jq -r '.event.eventId // empty')
EVENT_NAME=$(echo "$CFG" | jq -r '.event.eventName // empty')
EVENT_STATUS=$(echo "$CFG" | jq -r '.event.status // empty')
if [ -z "$EVENT_ID" ]; then
  fail "No event configured for $EVENT_DATE"
elif [ "$EVENT_STATUS" != "ACTIVE" ]; then
  warn "Event '$EVENT_NAME' status=$EVENT_STATUS (expected ACTIVE)"
else
  ok "Event '$EVENT_NAME' is ACTIVE"
fi

# Tables + prices
TABLES_TOTAL=$(echo "$CFG" | jq -r '.tables | length')
TABLES_AVAILABLE=$(echo "$CFG" | jq -r '[.tables[] | select(.available)] | length')
PRICES_UNIQUE=$(echo "$CFG" | jq -r '[.tables[].price] | unique | join(", ")')
TABLES_NO_PRICE=$(echo "$CFG" | jq -r '[.tables[] | select(.price == null or .price == 0)] | length')

if [ "$TABLES_TOTAL" -lt 50 ]; then
  warn "Only $TABLES_TOTAL tables configured (expected ~111 for full venue)"
else
  ok "$TABLES_TOTAL tables loaded ($TABLES_AVAILABLE available)"
fi
if [ "$TABLES_NO_PRICE" -gt 0 ]; then
  fail "$TABLES_NO_PRICE tables have null/zero price — anon flow rejects bookings on them"
else
  ok "All tables priced. Tiers: \$$PRICES_UNIQUE"
fi

# Section colors
SECTIONS_WITH_COLORS=$(echo "$CFG" | jq -r '.sectionMapColors | keys | length')
if [ "$SECTIONS_WITH_COLORS" -lt 3 ]; then
  warn "Only $SECTIONS_WITH_COLORS section colors configured"
else
  ok "$SECTIONS_WITH_COLORS section colors set (legend renders)"
fi

# Anon-public booking gates
ANON_ON=$(echo "$CFG" | jq -r '.allowAnonymousPublicBooking // false')
TURNSTILE_KEY=$(echo "$CFG" | jq -r '.turnstileSiteKey // empty')
CONTACT_PHONE=$(echo "$CFG" | jq -r '.customerContactPhoneE164 // empty')

if [ "$ANON_ON" != "true" ]; then
  fail "allowAnonymousPublicBooking is FALSE — customers can't self-book"
else
  ok "Anonymous public booking is ENABLED"
fi
if [ -z "$TURNSTILE_KEY" ]; then
  fail "Turnstile site key is missing — modal will not render the widget"
else
  ok "Turnstile site key configured"
fi
if [ -z "$CONTACT_PHONE" ]; then
  warn "customerContactPhoneE164 is empty — Call/WhatsApp CTAs won't render"
else
  ok "Customer contact phone: $CONTACT_PHONE"
fi

# -----------------------------------------------------------------------------
# 2. Reservation state breakdown
# -----------------------------------------------------------------------------
section "2. Reservation state for $EVENT_DATE"

RES_JSON=$(aws dynamodb query --table-name ff-reservations \
  --key-condition-expression "PK = :p AND begins_with(SK, :s)" \
  --expression-attribute-values "{\":p\":{\"S\":\"EVENTDATE#$EVENT_DATE\"},\":s\":{\"S\":\"RES#\"}}" \
  --output json 2>/dev/null)

if [ -z "$RES_JSON" ]; then
  warn "Could not query DDB ff-reservations (auth issue?)"
else
  echo "$RES_JSON" | jq -r '
    [
      .Items[] | {
        status: .status.S,
        paymentStatus: .paymentStatus.S,
        customerName: .customerName.S,
        phone: .phone.S,
        tableId: (.tableId.S // (.tableIds.L | map(.S) | join(","))),
        amount: (.depositAmount.N // .amountDue.N // "0"),
        deadline: .paymentDeadlineAt.S,
        isAnon: ((.createdBy.S // "") == "anonymous-public")
      }
    ] |
    "  Total: \(length) | Confirmed: \([.[] | select(.status == "CONFIRMED")] | length) | Cancelled: \([.[] | select(.status == "CANCELLED")] | length)\n  Paid: \([.[] | select(.paymentStatus == "PAID")] | length) | Pending: \([.[] | select(.paymentStatus == "PENDING")] | length) | Courtesy: \([.[] | select(.paymentStatus == "COURTESY")] | length)\n  Anonymous-public: \([.[] | select(.isAnon)] | length) | Staff-created: \([.[] | select(.isAnon | not)] | length)"
  '
fi

# -----------------------------------------------------------------------------
# 3. Pending payments needing follow-up (CONFIRMED + PENDING)
# -----------------------------------------------------------------------------
section "3. CONFIRMED but PENDING payment — staff follow-up list"

if [ -n "$RES_JSON" ]; then
  PENDING_LIST=$(echo "$RES_JSON" | jq -r '
    [.Items[] | select(.status.S == "CONFIRMED" and .paymentStatus.S == "PENDING") |
      "  · \(.customerName.S // "—") · \(.phone.S // "—") · table \(.tableId.S // (.tableIds.L | map(.S) | join(","))) · $\(.depositAmount.N // .amountDue.N // "0") · deadline \(.paymentDeadlineAt.S // "?")"
    ] | .[]
  ')
  if [ -z "$PENDING_LIST" ]; then
    ok "No PENDING-payment bookings — all confirmed customers are paid"
  else
    echo "$PENDING_LIST"
    PENDING_COUNT=$(echo "$PENDING_LIST" | wc -l | xargs)
    warn "$PENDING_COUNT customer(s) need a follow-up before Saturday"
  fi
fi

# -----------------------------------------------------------------------------
# 4. Active anon phone slots (customers mid-flow RIGHT NOW)
# -----------------------------------------------------------------------------
section "4. Active anon phone slots (in-flight customers right now)"

SLOT_JSON=$(aws dynamodb query --table-name ff-table-holds \
  --key-condition-expression "PK = :p AND begins_with(SK, :s)" \
  --expression-attribute-values '{":p":{"S":"RATE"},":s":{"S":"ANONHOLD#"}}' \
  --output json 2>/dev/null)

if [ -z "$SLOT_JSON" ]; then
  warn "Could not query ff-table-holds for anon slots"
else
  SLOT_COUNT=$(echo "$SLOT_JSON" | jq -r '.Count')
  if [ "$SLOT_COUNT" = "0" ]; then
    ok "No customers mid-flow right now"
  else
    echo "$SLOT_JSON" | jq -r '
      .Items[] |
      "  · phone +\(.SK.S | gsub("ANONHOLD#"; "")) · res \(.reservationId.S | .[0:8])… · expires \(.expiresAt.N | tonumber | strftime("%H:%M:%S"))"
    '
    warn "$SLOT_COUNT customer(s) mid-flow — DO NOT redeploy Lambda right now"
  fi
fi

# -----------------------------------------------------------------------------
# 5. Last-24h funnel summary (CloudWatch Insights)
# -----------------------------------------------------------------------------
section "5. Last-24h funnel summary (CloudWatch Insights)"

START_EPOCH=$(( $(date +%s) - 86400 ))
END_EPOCH=$(date +%s)

# Heredoc avoids the single-quote escaping nightmare. Two parse rules
# cover both event flavors (backend `step:` + frontend `event:`); stats
# rolls them into one count column keyed by whichever field matched.
QUERY_FILE=$(mktemp)
cat > "$QUERY_FILE" <<'EOF'
fields @message
| filter @message like "_funnel_event"
| parse @message "step: '*'" as bk_step
| parse @message "event: '*'" as fe_event
| stats count() as cnt by coalesce(bk_step, fe_event) as kind
| sort cnt desc
| limit 50
EOF

QUERY_ID=$(aws logs start-query \
  --log-group-name /aws/lambda/ff-reservations-api \
  --start-time "$START_EPOCH" \
  --end-time "$END_EPOCH" \
  --query-string "$(cat $QUERY_FILE)" \
  --query 'queryId' --output text 2>/dev/null)

if [ -z "$QUERY_ID" ] || [ "$QUERY_ID" = "None" ]; then
  warn "Could not start CW Insights query (auth issue?)"
else
  for i in 1 2 3 4 5 6; do
    sleep 4
    STATUS=$(aws logs get-query-results --query-id "$QUERY_ID" --query 'status' --output text 2>/dev/null)
    [ "$STATUS" = "Complete" ] && break
  done
  if [ "$STATUS" = "Complete" ]; then
    RESULTS_JSON=$(aws logs get-query-results --query-id "$QUERY_ID" --query 'results' --output json 2>/dev/null)
    ROW_COUNT=$(echo "$RESULTS_JSON" | jq 'length')
    if [ "$ROW_COUNT" -gt 0 ]; then
      echo "$RESULTS_JSON" | jq -r '
        .[] |
        (map(select(.field == "kind")) | .[0].value // "?") as $k |
        (map(select(.field == "cnt")) | .[0].value // "0") as $c |
        "  · \($k) — \($c)"
      '
    else
      ok "No funnel events in the last 24h yet (expected — Saturday hasn't run)"
    fi
  else
    warn "CW Insights query did not complete (status: $STATUS)"
  fi
fi
rm -f "$QUERY_FILE"

# -----------------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------------
hr
echo "[$(ts)] Summary: $FAIL failures, $WARN warnings"
if [ "$FAIL" -gt 0 ]; then
  echo "[$(ts)] FAIL — fix the items above before opening Saturday"
  exit 1
elif [ "$WARN" -gt 0 ]; then
  echo "[$(ts)] PASS WITH WARNINGS — review above + handle ops items"
  exit 0
else
  echo "[$(ts)] PASS — system ready for $EVENT_DATE"
  exit 0
fi
