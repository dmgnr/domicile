#!/usr/bin/env bash
# Tests which end the Electron protocol guard blames and which results it
# passes.
#
# Runs the verdict block from `guard-electron-protocol.sh` itself, not a copy,
# like the other guards' tests. Key cases: an https request that went to the
# network although the app handles https, and a file: window in a session
# that does not handle file:, are failures even when everything else worked.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
GUARD="$ROOT/packages/domicile-engine/scripts/guard-electron-protocol.sh"
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

# MEASURED is "<ready> <served> <streamed> <intercepted> <echoed> <refused>".
echo "the claim — an app serves its page's requests"
expect "a page the app served whole, streamed and in place of the network is the pass" \
  "pass" "$(verdict "1 1 1 1 1 1")"
expect "no hello is a failure" "fail" "$(verdict "0 0 0 0 0 0")"
expect "and points at the socket's guard" "yes" \
  "$(says "0 0 0 0 0 0" "guard-electron-socket.sh")"
expect "a file: window that never loaded is a failure" "fail" \
  "$(verdict "1 0 0 0 0 1")"
expect "and names the guest's scheme check" "yes" \
  "$(says "1 0 0 0 0 1" "MayGuestLoadUnsafeScheme")"
expect "a streamed body that never ran is a failure" "fail" \
  "$(verdict "1 1 0 1 1 1")"
expect "and names the subresource loaders" "yes" \
  "$(says "1 1 0 1 1 1" "AddElectronSubresourceLoaderFactories")"
expect "an https request that went to the network is a failure" "fail" \
  "$(verdict "1 1 1 0 1 1")"
expect "and names the proxy" "yes" \
  "$(says "1 1 1 0 1 1" "ProxyElectronNetworkLoads")"
expect "a POST whose body never reached the app is a failure" "fail" \
  "$(verdict "1 1 1 1 0 1")"
expect "and names where the body is read" "yes" \
  "$(says "1 1 1 1 0 1" "ReadBody")"

echo
echo "the control — a session that does not handle file:"
expect "a file: window in such a session is a failure" "fail" \
  "$(verdict "1 1 1 1 1 0")"
expect "and names the check" "yes" "$(says "1 1 1 1 1 0" "ElectronApp::Opens")"
expect "an empty measurement is a failure" "fail" "$(verdict "")"

[ "$FAILED" -eq 0 ] && echo "all ok"
exit "$FAILED"
