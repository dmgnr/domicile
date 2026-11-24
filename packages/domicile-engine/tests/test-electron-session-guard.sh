#!/usr/bin/env bash
# Tests which end the Electron session guard blames and which results it
# passes.
#
# Runs the verdict block from `guard-electron-session.sh` itself, not a copy,
# like the other guards' tests. Key case: a page that kept what
# clearStorageData should have cleared is a failure even when everything
# else worked.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
GUARD="$ROOT/packages/domicile-engine/scripts/guard-electron-session.sh"
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

# MEASURED is "<ready> <agent> <cookie> <got> <cleared>".
echo "the claim — an app's session calls reach its page's storage and loads"
expect "every call doing its part is the pass" "pass" "$(verdict "1 1 1 1 1")"
expect "no hello is a failure" "fail" "$(verdict "0 0 0 0 0")"
expect "and points at the socket's guard" "yes" \
  "$(says "0 0 0 0 0" "guard-electron-socket.sh")"
expect "a page that missed the user agent is a failure" "fail" \
  "$(verdict "1 0 1 1 1")"
expect "and names where the agent is applied" "yes" \
  "$(says "1 0 1 1 1" "UseUserAgent")"
expect "a page without the app's cookie is a failure" "fail" \
  "$(verdict "1 1 0 1 1")"
expect "and names the partition lookup" "yes" \
  "$(says "1 1 0 1 1" "StorageOf")"
expect "cookies.get missing a cookie is a failure" "fail" \
  "$(verdict "1 1 1 0 1")"
expect "and names the filter" "yes" \
  "$(says "1 1 1 0 1" "ElectronCookieMatches")"
expect "storage that survived clearStorageData is a failure" "fail" \
  "$(verdict "1 1 1 1 0")"
expect "and names the clear" "yes" \
  "$(says "1 1 1 1 0" "ClearElectronStorage")"
expect "an empty measurement is a failure" "fail" "$(verdict "")"

[ "$FAILED" -eq 0 ] && echo "all ok"
exit "$FAILED"
