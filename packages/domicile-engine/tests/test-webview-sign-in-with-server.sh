#!/usr/bin/env bash
# Tests the sign-in guard's server: that it writes the guard's report line only
# for a report, and that its provider answers as FedCM asks.
#
# The guard waits for that line, then judges. A line the server writes on its
# own, such as its `serving` banner, would end the wait before the page
# reported. A provider that answers wrong fails the guard as if the engine had.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
# shellcheck source=packages/domicile-engine/scripts/lib-ports.sh
. "$ROOT/packages/domicile-engine/scripts/lib-ports.sh"
SCRIPTS="$ROOT/packages/domicile-engine/scripts"
SERVER="$SCRIPTS/guard-webview-sign-in-with-server.py"
GUARD="$SCRIPTS/guard-webview-sign-in-with.sh"

# The line the guard waits for, as the guard spells it.
REPORT_LINE="$(sed -n 's/^REPORT_LINE="\(.*\)"$/\1/p' "$GUARD")"
[ -n "$REPORT_LINE" ] || {
  echo "no REPORT_LINE= in $GUARD — it moved. Fix this test with it." >&2
  exit 1
}

command -v python3 >/dev/null || {
  echo "SKIP: no python3, which is what serves the sign-in guard's site"
  exit 77
}
command -v curl >/dev/null || {
  echo "SKIP: no curl to ask it with"
  exit 77
}

LOG="$(mktemp)"
python3 "$SERVER" --port 0 >"$LOG" 2>&1 &
SERVER_PID=$!
cleanup() {
  kill "$SERVER_PID" 2>/dev/null
  rm -f "$LOG"
}
trap cleanup EXIT

for _ in $(seq 1 60); do
  grep -q "serving" "$LOG" 2>/dev/null && break
  sleep 0.25
done
PORT="$(served_port "$LOG")" || {
  echo "the server never said which port it took. It said:" >&2
  cat "$LOG" >&2
  exit 1
}
SITE="http://127.0.0.1:$PORT"

FAILED=0
expect() {
  local what="$1" want="$2" got="$3"
  if [ "$got" = "$want" ]; then
    printf '  ok    %s\n' "$what"
  else
    printf '  FAIL  %s\n    wanted: %s\n    got:    %s\n' "$what" "$want" "$got"
    FAILED=$((FAILED + 1))
  fi
}

has() { # $1 needle, $2 haystack
  case "$2" in
  *"$1"*) echo yes ;;
  *) echo no ;;
  esac
}

reported() { grep -qF -- "$REPORT_LINE" "$LOG" && echo yes || echo no; }

RP="$(curl -sS -D - "$SITE/rp?phase=1")"
expect "a server that has only served the site has no report" "no" "$(reported)"
expect "the site tells the browser the user is signed in to the provider" "yes" \
  "$(has "Set-Login: logged-in" "$RP")"

curl -sS -o /dev/null "$SITE/report?step=chosen&token=guard-token"
expect "a report writes the report line" "yes" "$(reported)"
expect "with what the page found" "yes" \
  "$(grep -F -- "$REPORT_LINE" "$LOG" | grep -qF "step=chosen token=guard-token" &&
    echo yes || echo no)"

CONFIG="$(curl -sS "$SITE/fedcm.json")"
expect "the provider's config names its accounts" "yes" \
  "$(has '"accounts_endpoint": "/accounts"' "$CONFIG")"
expect "the provider's account is the one the guard looks for" "yes" \
  "$(has '"name": "Guard Tester"' "$(curl -sS "$SITE/accounts")")"

TOKEN="$(curl -sS -D - -H "Origin: $SITE" \
  --data "account_id=guard&client_id=guard" "$SITE/assert")"
expect "the provider issues its token for its account" "yes" \
  "$(has '"token": "guard-token"' "$TOKEN")"
expect "to the site, across CORS" "yes" \
  "$(has "Access-Control-Allow-Origin: $SITE" "$TOKEN")"
expect "and for no other account" "400" \
  "$(curl -sS -o /dev/null -w '%{http_code}' --data "account_id=other" "$SITE/assert")"

echo
if [ "$FAILED" -eq 0 ]; then
  echo "the sign-in guard's server reports and provides as the guard expects"
  exit 0
fi
echo "$FAILED assertion(s) wrong" >&2
exit 1
