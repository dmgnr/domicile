#!/usr/bin/env bash
# Tests which results `guard-webview-reshown-tiles.sh` passes.
#
# Runs the guard's own verdict block, not a copy. Key cases:
#
#   - The claim passes on a few rasters and fails on a viewport's worth,
#     naming patch 0252.
#   - A page whose viewport went to 0x0 fails in either mode, naming patch
#     0265. A trace with no viewport sizes for the page fails: it could not
#     have seen one.
#   - The control passes only on many, so the claim's few are the build's
#     doing.
#   - A shell that never ran, a page never attached, hidden or shown again,
#     or a trace that missed the reshow fails.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
GUARD="$ROOT/packages/domicile-engine/scripts/guard-webview-reshown-tiles.sh"
[ -f "$GUARD" ] || {
  echo "no guard at $GUARD" >&2
  exit 1
}

BLOCK="$(awk '/^FAILURE=""$/,/^fi$/' "$GUARD")"
[ -n "$BLOCK" ] || {
  echo "no verdict block in $GUARD — its markers moved. Fix this test with it." >&2
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

verdict() { # $1 MEASURED
  (
    MEASURED="$1"
    MAX_RASTERS=2
    eval "$BLOCK"
    if [ -n "$PASSED" ]; then
      echo "pass"
    elif [ -n "$FAILURE" ]; then
      echo "fail"
    else
      echo "neither"
    fi
  )
}

says() { # $1 MEASURED, $2 what the sentence must contain
  case "$(
    MEASURED="$1"
    MAX_RASTERS=2
    eval "$BLOCK"
    echo "$FAILURE"
  )" in
  *"$2"*) echo yes ;;
  *) echo no ;;
  esac
}

# MEASURED is "<mode> <shell> <attached> <hidden> <shown-again> <traced>
# <rasters> <sizes> <emptied>".
echo "the claim — the engine as built"
expect "no rasters is the pass" "pass" "$(verdict "claim 1 1 1 1 1 0 3 0")"
expect "the limit itself passes" "pass" "$(verdict "claim 1 1 1 1 1 2 3 0")"
expect "a viewport's worth is a failure" "fail" \
  "$(verdict "claim 1 1 1 1 1 24 3 0")"
expect "and names the patch" "yes" \
  "$(says "claim 1 1 1 1 1 24 3 0" "patch 0252")"
expect "a viewport emptied while hidden is a failure" "fail" \
  "$(verdict "claim 1 1 1 1 1 0 5 2")"
expect "and names the patch" "yes" \
  "$(says "claim 1 1 1 1 1 0 5 2" "patch 0265")"
expect "no viewport sizes in the trace is a failure" "fail" \
  "$(verdict "claim 1 1 1 1 1 0 0 0")"
expect "a trace that missed the reshow is a failure" "fail" \
  "$(verdict "claim 1 1 1 1 0 none none none")"
expect "and says to trace longer" "yes" \
  "$(says "claim 1 1 1 1 0 none none none" "TRACE_SECONDS")"
expect "an unreadable trace is a failure" "fail" \
  "$(verdict "claim 1 1 1 1 1 none none none")"
expect "a page never shown again is a failure" "fail" \
  "$(verdict "claim 1 1 1 0 1 0 3 0")"
expect "a page never hidden is a failure" "fail" \
  "$(verdict "claim 1 1 0 1 1 0 3 0")"
expect "and points at the hiding guard" "yes" \
  "$(says "claim 1 1 0 1 1 0 3 0" "guard-webview-hidden")"
expect "a page never attached is a failure" "fail" \
  "$(verdict "claim 1 0 0 0 0 none none none")"
expect "a shell that never ran is a failure" "fail" \
  "$(verdict "claim 0 0 0 0 0 none none none")"

echo
echo "the control — a new scale"
expect "many rasters is the control's pass" "pass" \
  "$(verdict "control 1 1 1 1 1 24 3 0")"
expect "a few is the control's failure" "fail" \
  "$(verdict "control 1 1 1 1 1 1 3 0")"
expect "and says the claim then means nothing" "yes" \
  "$(says "control 1 1 1 1 1 1 3 0" "says nothing")"
expect "a viewport emptied while hidden is its failure too" "fail" \
  "$(verdict "control 1 1 1 1 1 24 5 2")"

echo
if [ "$FAILED" -eq 0 ]; then
  echo "the webview reshown tiles guard blames the right end"
  exit 0
fi
echo "$FAILED case(s) wrong" >&2
exit 1
