#!/usr/bin/env bash
# Tests the verdict of `guard-notification-site-icon.sh`: which readings pass
# and which end a failure blames.
#
# Runs the verdict block from the real guard, so moving it fails here.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
GUARD="$ROOT/packages/domicile-engine/scripts/guard-notification-site-icon.sh"
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

says() { # $1 MEASURED, $2 what the failure must contain
  (
    MEASURED="$1"
    eval "$BLOCK"
    case "$FAILURE" in
    *"$2"*) echo yes ;;
    *) echo no ;;
    esac
  )
}

echo "the claim — a site with a favicon notifies"
expect "its favicon passes" pass "$(verdict "favicon site")"
expect "the logo fails" fail "$(verdict "favicon logo")"
expect "the logo blames the patch" yes "$(says "favicon logo" "patch 0239")"
expect "no picture fails" fail "$(verdict "favicon bare")"
expect "never notifying fails" fail "$(verdict "favicon silent")"
expect "never notifying blames the harness" yes "$(says "favicon silent" "the harness")"

echo "the control — a site with no favicon notifies"
expect "the logo passes" pass "$(verdict "bare logo")"
expect "a red icon fails" fail "$(verdict "bare site")"
expect "never notifying fails" fail "$(verdict "bare silent")"

echo "anything else"
expect "an unknown reading fails" fail "$(verdict "favicon ")"

if [ "$FAILED" -gt 0 ]; then
  echo "$FAILED failed"
  exit 1
fi
echo "all ok"
