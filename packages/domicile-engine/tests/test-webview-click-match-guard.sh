#!/usr/bin/env bash
# Which end the click match guard blames, and which runs it calls a pass.
#
# The unit is the verdict block in `guard-webview-click-match.sh`, run out of
# the real script rather than copied, so a rewrite that moves it fails here.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
GUARD="$ROOT/packages/domicile-engine/scripts/guard-webview-click-match.sh"
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

# A positive run in which everything is true; each case changes one reading.
# Prints the verdict, then the failing sentence.
run_block() { # $1 NEGATIVE, then NAME=value overrides
  (
    SAW_SHELL=1
    SAW_BAD_SELECTOR=1
    CLICKED=true
    SAW_PRESS=1
    WANT=true
    NEGATIVE="$1"
    [ "$NEGATIVE" = "1" ] && CLICKED=false && SAW_PRESS=0 && WANT=false
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

verdict() {
  run_block "$@" | head -1
}

blames() { # $1 word, then the args verdict takes
  local word="$1"
  shift
  case "$(run_block "$@" | tail -n +2)" in
  *"$word"*) echo yes ;;
  *) echo no ;;
  esac
}

echo "a run that never got as far as clicking"
expect "a shell that never ran is a failure" "fail" "$(verdict 0 SAW_SHELL=0)"
expect "and blames the harness" "yes" "$(blames "harness" 0 SAW_SHELL=0)"
expect "a bad selector that did not throw is a failure" "fail" \
  "$(verdict 0 SAW_BAD_SELECTOR=0)"
expect "no answer is a failure" "fail" "$(verdict 0 CLICKED=)"
expect "and names ClickMatch" "yes" "$(blames "ClickMatch" 0 CLICKED=)"

echo
echo "the positive run"
expect "a heard press is the pass" "pass" "$(verdict 0)"
expect "no match is a failure" "fail" "$(verdict 0 CLICKED=false)"
expect "and blames ClickMatchScript" "yes" \
  "$(blames "ClickMatchScript" 0 CLICKED=false)"
expect "a press the page never heard is a failure" "fail" \
  "$(verdict 0 SAW_PRESS=0)"
expect "and says the events never reached it" "yes" \
  "$(blames "never reached" 0 SAW_PRESS=0)"

echo
echo "the control run -- a selector the page has none of"
expect "false with no press is the pass" "pass" "$(verdict 1)"
expect "the positive run's true is the control's failure" "fail" \
  "$(verdict 1 CLICKED=true)"
expect "a press with nothing clicked is the control's failure" "fail" \
  "$(verdict 1 SAW_PRESS=1)"

echo
if [ "$FAILED" -eq 0 ]; then
  echo "the click match guard's verdict names the right end in every case"
  exit 0
fi
echo "$FAILED case(s) blamed the wrong end" >&2
exit 1
