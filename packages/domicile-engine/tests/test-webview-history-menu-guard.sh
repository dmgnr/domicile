#!/usr/bin/env bash
# Tests the verdict of `guard-webview-history-menu.sh`: which readings pass
# and which component a failure blames.
#
# Runs the verdict block from the real guard, so moving it fails here.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
GUARD="$ROOT/packages/domicile-engine/scripts/guard-webview-history-menu.sh"
[ -f "$GUARD" ] || {
  echo "no guard at $GUARD" >&2
  exit 1
}

# From `FAILURE=""` to the column-zero `fi` that ends the decision.
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

# Runs the block on the positive run's passing readings, with each `NAME=value`
# override, and prints `pass`, `fail` or `neither`, then the failure message.
run_block() { # $1 NEGATIVE, then overrides
  (
    SAW_DRIVING=1
    SAW_TWO=1
    SAW_LISTED=1
    SAW_WENT=1
    SAW_STAYED_ON_TWO=0
    SAW_RELISTED=1
    SAW_ASKED=1
    SAW_ADDRESS=1
    SAW_STAYED=1
    NEGATIVE="$1"
    shift
    for override in "$@"; do
      eval "$override"
    done
    eval "$BLOCK"
    if [ -n "$PASSED" ]; then
      echo "pass"
    elif [ -n "$FAILURE" ]; then
      echo "fail"
    else
      echo "neither"
    fi
    echo "$FAILURE"
  )
}

verdict() { run_block "$@" | head -1; }

blames() { # $1 word, then the args run_block takes
  local word="$1"
  shift
  case "$(run_block "$@" | tail -n +2)" in
  *"$word"*) echo yes ;;
  *) echo no ;;
  esac
}

# The control's readings: the view stays on /two and nothing else runs.
CONTROL=(SAW_WENT=0 SAW_STAYED_ON_TWO=1 SAW_RELISTED=0 SAW_ASKED=0
  SAW_ADDRESS=0 SAW_STAYED=0)

echo "a run that never got as far as measuring anything"
expect "a module that never ran is a failure" "fail" \
  "$(verdict 0 SAW_DRIVING=0)"
expect "a module that never ran blames the harness" "yes" \
  "$(blames "harness" 0 SAW_DRIVING=0)"
expect "no second page is a failure in both runs" "fail fail" \
  "$(verdict 0 SAW_TWO=0) $(verdict 1 "${CONTROL[@]}" SAW_TWO=0)"
expect "a wrong list is a failure in both runs" "yes yes" \
  "$(blames "LISTED WRONG" 0 SAW_LISTED=0) $(blames "LISTED WRONG" 1 "${CONTROL[@]}" SAW_LISTED=0)"

echo
echo "the positive run"
expect "everything arriving is the pass" "pass" "$(verdict 0)"
expect "a view that never went blames the call" "yes" \
  "$(blames "DID NOTHING" 0 SAW_WENT=0 SAW_RELISTED=0)"
expect "a stale list after going says so" "yes" \
  "$(blames "DID NOT FOLLOW" 0 SAW_RELISTED=0)"
expect "no window blames the new-window call" "yes" \
  "$(blames "NEVER OPENED" 0 SAW_ASKED=0 SAW_ADDRESS=0)"
expect "a window at the wrong address says so" "yes" \
  "$(blames "WRONG ADDRESS" 0 SAW_ADDRESS=0)"
expect "a view that moved is a failure" "yes" \
  "$(blames "THE VIEW MOVED" 0 SAW_STAYED=0)"

echo
echo "the control"
expect "a view left on /two is the pass" "pass" \
  "$(verdict 1 "${CONTROL[@]}")"
expect "a view that moved for a missing id is a failure" "yes" \
  "$(blames "NO ENTRY HAS" 1 "${CONTROL[@]}" SAW_STAYED_ON_TWO=0)"

echo
if [ "$FAILED" -eq 0 ]; then
  echo "the history menu guard's verdict names the right end in every case"
  exit 0
fi
echo "$FAILED case(s) wrong" >&2
exit 1
