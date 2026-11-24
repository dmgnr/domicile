#!/usr/bin/env bash
# Tests which results `guard-webview-scale-animation.sh` passes.
#
# Runs the guard's own verdict block, not a copy. Key cases:
#
#   - The claim passes on a few surfaces and fails on one a frame, naming
#     patch 0233.
#   - The control passes only on many, so the claim's few are the build's
#     doing.
#   - A shell that never ran, a page never shown, a shrink that never ended
#     or a trace that missed it fails.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
GUARD="$ROOT/packages/domicile-engine/scripts/guard-webview-scale-animation.sh"
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
    MAX_SURFACES=10
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
    MAX_SURFACES=10
    eval "$BLOCK"
    echo "$FAILURE"
  )" in
  *"$2"*) echo yes ;;
  *) echo no ;;
  esac
}

# MEASURED is "<mode> <shell> <page> <done> <traced> <surfaces>".
echo "the claim — the engine as built"
expect "a few surfaces is the pass" "pass" "$(verdict "claim 1 1 1 1 4")"
expect "the limit itself passes" "pass" "$(verdict "claim 1 1 1 1 10")"
expect "one a frame is a failure" "fail" "$(verdict "claim 1 1 1 1 63")"
expect "and names the patch" "yes" "$(says "claim 1 1 1 1 63" "patch 0233")"
expect "a trace that missed the shrink is a failure" "fail" \
  "$(verdict "claim 1 1 1 0 none")"
expect "and says to trace longer" "yes" \
  "$(says "claim 1 1 1 0 none" "TRACE_SECONDS")"
expect "an unreadable trace is a failure" "fail" "$(verdict "claim 1 1 1 1 none")"
expect "a shrink that never ended is a failure" "fail" \
  "$(verdict "claim 1 1 0 0 none")"
expect "a page never shown is a failure" "fail" "$(verdict "claim 1 0 0 0 none")"
expect "a shell that never ran is a failure" "fail" \
  "$(verdict "claim 0 0 0 0 none")"

echo
echo "the control — static steps"
expect "many surfaces is the control's pass" "pass" \
  "$(verdict "control 1 1 1 1 48")"
expect "a few is the control's failure" "fail" "$(verdict "control 1 1 1 1 4")"
expect "and says the claim then means nothing" "yes" \
  "$(says "control 1 1 1 1 4" "says nothing")"

echo
if [ "$FAILED" -eq 0 ]; then
  echo "the webview scale animation guard blames the right end"
  exit 0
fi
echo "$FAILED case(s) wrong" >&2
exit 1
