#!/usr/bin/env bash
# Tests that the Chrome sheets guard's server writes the guard's report line
# only for a report.
#
# The guard waits for that line, then judges. A line the server writes on its
# own, such as its `serving /probe and /report` banner, would end the wait
# before the page reported and fail the guard whenever the page is slow.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
# shellcheck source=packages/domicile-engine/scripts/lib-ports.sh
. "$ROOT/packages/domicile-engine/scripts/lib-ports.sh"
SCRIPTS="$ROOT/packages/domicile-engine/scripts"
SERVER="$SCRIPTS/guard-webview-chrome-sheets-server.py"
GUARD="$SCRIPTS/guard-webview-chrome-sheets.sh"

# The line the guard waits for, as the guard spells it.
REPORT_LINE="$(sed -n 's/^REPORT_LINE="\(.*\)"$/\1/p' "$GUARD")"
[ -n "$REPORT_LINE" ] || {
  echo "no REPORT_LINE= in $GUARD — it moved. Fix this test with it." >&2
  exit 1
}

command -v python3 >/dev/null || {
  echo "SKIP: no python3, which is what serves the Chrome sheets guard's page"
  exit 77
}
command -v curl >/dev/null || {
  echo "SKIP: no curl to report with"
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

reported() { grep -qF -- "$REPORT_LINE" "$LOG" && echo yes || echo no; }

curl -sS -o /dev/null "http://127.0.0.1:$PORT/probe"
expect "a server that has only served the probe has no report" "no" "$(reported)"

curl -sS -o /dev/null "http://127.0.0.1:$PORT/report?payment=undefined&identity=undefined"
expect "a report writes the report line" "yes" "$(reported)"
expect "with what the page found" "yes" \
  "$(grep -F -- "$REPORT_LINE" "$LOG" | grep -qF "payment=undefined identity=undefined" &&
    echo yes || echo no)"

echo
if [ "$FAILED" -eq 0 ]; then
  echo "the Chrome sheets guard's server writes its report line for a report alone"
  exit 0
fi
echo "$FAILED assertion(s) wrong" >&2
exit 1
