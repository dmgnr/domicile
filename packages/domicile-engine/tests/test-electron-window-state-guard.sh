#!/usr/bin/env bash
# Tests which end the Electron window state guard blames and which results it
# passes.
#
# Runs the verdict block from `guard-electron-window-state.sh` itself, not a
# copy, like the other guards' tests. Key case: a state the shell made that
# never reached the app is a failure even when the shell read what it asked.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
GUARD="$ROOT/packages/domicile-engine/scripts/guard-electron-window-state.sh"
[ -f "$GUARD" ] || {
  echo "no guard at $GUARD" >&2
  exit 1
}

BLOCK="$(awk '/^FAILURE=""$/,/^esac$/' "$GUARD")"
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
    eval "$BLOCK"
    echo "$FAILURE"
  )" in
  *"$2"*) echo yes ;;
  *) echo no ;;
  esac
}

# MEASURED is "<ready> <listed> <heard> <once>".
echo "the claim — an app's window state is listed, and the shell's reaches the app once per change"
expect "everything heard is the pass" "pass" "$(verdict "1 1 1 1")"
expect "no hello is a failure" "fail" "$(verdict "0 0 0 0")"
expect "and points at the socket's guard" "yes" \
  "$(says "0 0 0 0" "guard-electron-socket.sh")"
expect "a state the shell never read is a failure" "fail" "$(verdict "1 0 0 0")"
expect "and names SetWindowState" "yes" \
  "$(says "1 0 0 0" "DeskWindows::SetWindowState")"
expect "a state that never reached the app is a failure" "fail" \
  "$(verdict "1 1 0 0")"
expect "and names setBrowserWindowState" "yes" \
  "$(says "1 1 0 0" "setBrowserWindowState")"
expect "a state heard twice is a failure" "fail" "$(verdict "1 1 1 0")"
expect "and names WindowStateChanged" "yes" \
  "$(says "1 1 1 0" "WindowStateChanged")"
expect "an empty measurement is a failure" "fail" "$(verdict "")"

[ "$FAILED" -eq 0 ] && echo "all ok"
exit "$FAILED"
