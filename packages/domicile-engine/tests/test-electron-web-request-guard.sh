#!/usr/bin/env bash
# Tests which end the Electron webRequest guard blames and which results it
# passes.
#
# Runs the verdict block from `guard-electron-web-request.sh` itself, not a copy,
# like the other guards' tests. Key case: a request the app canceled that
# loaded anyway is a failure even when everything else worked.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
GUARD="$ROOT/packages/domicile-engine/scripts/guard-electron-web-request.sh"
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

# MEASURED is "<ready> <canceled> <redirected> <sent> <received> <told>".
echo "the claim — an app's webRequest listeners see and change its page's requests"
expect "every listener doing its part is the pass" "pass" \
  "$(verdict "1 1 1 1 1 1")"
expect "no hello is a failure" "fail" "$(verdict "0 0 0 0 0 0")"
expect "and points at the socket's guard" "yes" \
  "$(says "0 0 0 0 0 0" "guard-electron-socket.sh")"
expect "a canceled request that loaded is a failure" "fail" \
  "$(verdict "1 0 1 1 1 1")"
expect "and names where the cancel is kept" "yes" \
  "$(says "1 0 1 1 1 1" "ERR_BLOCKED_BY_CLIENT")"
expect "listeners that changed nothing are a failure" "fail" \
  "$(verdict "1 0 0 0 0 0")"
expect "and names the factory in front of the network" "yes" \
  "$(says "1 0 0 0 0 0" "ProxyElectronNetworkLoads")"
expect "a redirect that never reached the page is a failure" "fail" \
  "$(verdict "1 1 0 1 1 1")"
expect "and names the redirect" "yes" \
  "$(says "1 1 0 1 1 1" "RedirectFromTheApp")"
expect "a header the server never saw is a failure" "fail" \
  "$(verdict "1 1 1 0 1 1")"
expect "and names onBeforeSendHeaders' step" "yes" \
  "$(says "1 1 1 0 1 1" "AfterBeforeSendHeaders")"
expect "a header the page never read is a failure" "fail" \
  "$(verdict "1 1 1 1 0 1")"
expect "and names onHeadersReceived's step" "yes" \
  "$(says "1 1 1 1 0 1" "AfterHeadersReceived")"
expect "events the app never heard are a failure" "fail" \
  "$(verdict "1 1 1 1 1 0")"
expect "and names where they are told" "yes" \
  "$(says "1 1 1 1 1 0" "ResourceTypeOf")"
expect "an empty measurement is a failure" "fail" "$(verdict "")"

[ "$FAILED" -eq 0 ] && echo "all ok"
exit "$FAILED"
