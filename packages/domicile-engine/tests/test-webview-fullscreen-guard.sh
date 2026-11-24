#!/usr/bin/env bash
# Tests the verdict of `guard-webview-fullscreen.sh`: which readings pass and
# which component a failure blames.
#
# The checks are ordered: a page that never went fullscreen only means
# something once a press reached it. Key cases:
#
#   - The shell hearing fullscreen while the page's own document never entered
#     it fails: the renderer waits on the browser's visual properties.
#   - Escape that does not leave fails: a page could keep the user in.
#   - `exitPageFullscreen()` that does not leave fails: a shell could not take
#     the page out with its window.
#   - A fault reported after the page left each time fails: a false alarm.
#   - In the control, any fullscreen report fails: the press was on the part of
#     the page that asks for nothing.
#
# Runs the verdict block from the real guard, so moving it fails here.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
GUARD="$ROOT/packages/domicile-engine/scripts/guard-webview-fullscreen.sh"
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

# Runs the block with every reading at its passing value; each case overrides
# one. Prints "pass", "fail" or "neither", then the failure on the next line.
judge() { # $1 NEGATIVE, then NAME=value overrides
  (
    SAW_SHELL=1
    SAW_CHROME=1
    SAW_PAGE=1
    SAW_PRESS=1
    SAW_REFUSED=0
    SAW_ENTERED=1
    SAW_PAGE_ENTERED=1
    SAW_ESCAPED=1
    SAW_PAGE_LEFT=1
    SAW_REENTERED=1
    SAW_EXITED=1
    SAW_ANY=1
    SAW_FAULT=0
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

verdict() { judge "$@" | head -1; }

blames() { # $1 word, then the args judge takes
  local word="$1"
  shift
  case "$(judge "$@" | tail -n +2)" in
  *"$word"*) echo yes ;;
  *) echo no ;;
  esac
}

# The control presses the plain half, so it hears no fullscreen.
control() {
  verdict 1 SAW_ENTERED=0 SAW_PAGE_ENTERED=0 SAW_ESCAPED=0 SAW_PAGE_LEFT=0 \
    SAW_REENTERED=0 SAW_EXITED=0 SAW_ANY=0 "$@"
}

echo "a run that never got as far as measuring anything"
expect "a shell that never ran is a failure" "fail" "$(verdict 0 SAW_SHELL=0)"
expect "a shell that never ran is a failure in the control" "fail" \
  "$(control SAW_SHELL=0)"
expect "a shell that never ran blames the harness" "yes" \
  "$(blames "harness" 0 SAW_SHELL=0)"
expect "no press in the shell's document blames the harness" "yes" \
  "$(blames "harness" 0 SAW_CHROME=0)"
expect "an empty window names the guest" "yes" \
  "$(blames "the guest" 0 SAW_PAGE=0)"
expect "no press in the page is a failure" "fail" "$(verdict 0 SAW_PRESS=0)"
expect "no press in the page is the control's failure too" "fail" \
  "$(control SAW_PRESS=0)"

echo
echo "the positive run — the button, Escape, the button, exitPageFullscreen"
expect "entering and leaving twice is the pass" "pass" "$(verdict 0)"
expect "a refused request is a failure" "fail" "$(verdict 0 SAW_REFUSED=1)"
expect "a refused request names content's refusal" "yes" \
  "$(blames "refused" 0 SAW_REFUSED=1)"
expect "no report blames EnterFullscreenModeForTab" "yes" \
  "$(blames "EnterFullscreenModeForTab" 0 SAW_ENTERED=0)"
expect "a page that never entered blames the visual properties" "yes" \
  "$(blames "visual properties" 0 SAW_PAGE_ENTERED=0)"
expect "Escape that does not leave blames PreHandleKeyboardEvent" "yes" \
  "$(blames "PreHandleKeyboardEvent" 0 SAW_ESCAPED=0)"
expect "a page still fullscreen after Escape is a failure" "fail" \
  "$(verdict 0 SAW_PAGE_LEFT=0)"
expect "no second entry is a failure" "fail" "$(verdict 0 SAW_REENTERED=0)"
expect "no exit from the shell blames exitPageFullscreen" "yes" \
  "$(blames "exitPageFullscreen" 0 SAW_EXITED=0)"
expect "a fault after a clean exit is a failure" "fail" \
  "$(verdict 0 SAW_FAULT=1)"
expect "a fault after a clean exit blames CheckLeftFullscreen" "yes" \
  "$(blames "CheckLeftFullscreen" 0 SAW_FAULT=1)"

echo
echo "the control run — a press on the half that asks for nothing"
expect "hearing nothing is the pass" "pass" "$(control)"
expect "any fullscreen report is the control's failure" "fail" \
  "$(control SAW_ANY=1)"

echo
if [ "$FAILED" -eq 0 ]; then
  echo "the fullscreen guard's verdict names the right end in every case"
  exit 0
fi
echo "$FAILED case(s) wrong" >&2
exit 1
