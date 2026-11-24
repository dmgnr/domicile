#!/usr/bin/env bash
# Tests which end the Electron permissions guard blames and which results it
# passes.
#
# Runs the verdict block from `guard-electron-permissions.sh` itself, not a copy,
# like the other guards' tests. Key case: a page that got what the
# app's handler denied is a failure even when everything else worked.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
GUARD="$ROOT/packages/domicile-engine/scripts/guard-electron-permissions.sh"
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

# MEASURED is "<ready> <asked> <granted> <denied>".
echo "the claim — an app's permission request handler answers its pages"
expect "the handler answering both requests is the pass" "pass" \
  "$(verdict "1 1 1 1")"
expect "no hello is a failure" "fail" "$(verdict "0 0 0 0")"
expect "and points at the socket's guard" "yes" \
  "$(says "0 0 0 0" "guard-electron-socket.sh")"
expect "an app never asked is a failure" "fail" "$(verdict "1 0 0 0")"
expect "and names where the prompt is chosen" "yes" \
  "$(says "1 0 0 0" "MakePrompt")"
expect "a grant the page never got is a failure" "fail" \
  "$(verdict "1 1 0 1")"
expect "and names the accept" "yes" "$(says "1 1 0 1" "Accept")"
expect "a page that got what the app denied is a failure" "fail" \
  "$(verdict "1 1 1 0")"
expect "and names the deny" "yes" "$(says "1 1 1 0" "Deny")"
expect "an empty measurement is a failure" "fail" "$(verdict "")"

[ "$FAILED" -eq 0 ] && echo "all ok"
exit "$FAILED"
