#!/usr/bin/env bash
# Tests which end the Electron preload guard blames and which results it
# passes.
#
# Runs the verdict block from `guard-electron-preload.sh` itself, not a copy,
# like the other guards' tests. Key cases: a page that sees into the
# preload's world, and a window without a preload that gets one, are failures
# even when everything else worked.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
GUARD="$ROOT/packages/domicile-engine/scripts/guard-electron-preload.sh"
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

# MEASURED is "<ready> <preloaded> <isolated> <invoked> <synced> <delivered>
# <ported> <unpreloaded> <shaped>".
echo "the claim — a preload and its IPC"
expect "a preload that ran first, stayed apart and carried IPC both ways is the pass" \
  "pass" "$(verdict "1 1 1 1 1 1 1 1 1")"
expect "no hello is a failure" "fail" "$(verdict "0 0 0 0 0 0 0 0 0")"
expect "and points at the socket's guard" "yes" \
  "$(says "0 0 0 0 0 0 0 0 0" "guard-electron-socket.sh")"
expect "a page that never heard of its preload is a failure" "fail" \
  "$(verdict "1 0 0 0 0 0 0 1 1")"
expect "and names where the preload runs" "yes" \
  "$(says "1 0 0 0 0 0 0 1 1" "RunAtDocumentStart")"
expect "a page that saw into the preload's world is a failure" "fail" \
  "$(verdict "1 1 0 1 1 1 1 1 1")"
expect "and names the isolated world" "yes" \
  "$(says "1 1 0 1 1 1 1 1 1" "isolated world")"
expect "an invoke that never came back is a failure" "fail" \
  "$(verdict "1 1 1 0 1 1 1 1 1")"
expect "and names where answers go" "yes" "$(says "1 1 1 0 1 1 1 1 1" "Answered")"
expect "a sendSync that never returned is a failure" "fail" \
  "$(verdict "1 1 1 1 0 1 1 1 1")"
expect "and names the sync call" "yes" "$(says "1 1 1 1 0 1 1 1 1" "SendSync")"
expect "an app's send that never arrived is a failure" "fail" \
  "$(verdict "1 1 1 1 1 0 1 1 1")"
expect "and names delivery" "yes" "$(says "1 1 1 1 1 0 1 1 1" "Deliver")"
expect "a port that carried nothing is a failure" "fail" \
  "$(verdict "1 1 1 1 1 1 0 1 1")"
expect "and names the relay" "yes" "$(says "1 1 1 1 1 1 0 1 1" "relay")"

echo
echo "the control — a window without a preload"
expect "a window without a preload that got one is a failure" "fail" \
  "$(verdict "1 1 1 1 1 1 1 0 1")"
expect "and says only the app's own window gets it" "yes" \
  "$(says "1 1 1 1 1 1 1 0 1" "only for its own window")"
echo
echo "the rest of Electron's preload"
expect "a preload without Electron's webFrame or arguments is a failure" "fail" \
  "$(verdict "1 1 1 1 1 1 1 1 0")"
expect "and names webFrame" "yes" "$(says "1 1 1 1 1 1 1 1 0" "webFrame")"
expect "and names the window's arguments" "yes" \
  "$(says "1 1 1 1 1 1 1 1 0" "\"arguments\"")"
expect "the old eight measurements no longer pass" "fail" \
  "$(verdict "1 1 1 1 1 1 1 1")"
expect "an empty measurement is a failure" "fail" "$(verdict "")"

[ "$FAILED" -eq 0 ] && echo "all ok"
exit "$FAILED"
