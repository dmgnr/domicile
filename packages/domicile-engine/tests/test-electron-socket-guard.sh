#!/usr/bin/env bash
# Tests which end the Electron socket guard blames and which results it passes.
#
# Runs the verdict block from `guard-electron-socket.sh` itself, not a copy,
# like the other guards' tests. Key case: a chrome:// page that opens is a
# failure even when everything else worked.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
GUARD="$ROOT/packages/domicile-engine/scripts/guard-electron-socket.sh"
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

# MEASURED is "<ready> <opened> <loaded> <titled> <closed> <chrome-refused>
# <walked> <found>".
echo "the claim — an app's window over the Electron socket"
expect "a window that opened, loaded, took its title and closed is the pass" \
  "pass" "$(verdict "1 1 1 1 1 1 1 1")"
expect "no hello is a failure" "fail" "$(verdict "0 0 0 0 0 0 1 1")"
expect "and blames binding the socket" "yes" \
  "$(says "0 0 0 0 0 0 1 1" "StartElectronSocket")"
expect "a window that did not open is a failure" "fail" \
  "$(verdict "1 0 0 0 0 1 1 1")"
expect "and names where it opens" "yes" \
  "$(says "1 0 0 0 0 1 1 1" "OpenElectron")"
expect "a page that never said it loaded is a failure" "fail" \
  "$(verdict "1 1 0 1 1 1 1 1")"
expect "a title that never arrived is a failure" "fail" \
  "$(verdict "1 1 1 0 1 1 1 1")"
expect "and blames the listing" "yes" "$(says "1 1 1 0 1 1 1 1" "Listed")"
expect "a window that did not close is a failure" "fail" \
  "$(verdict "1 1 1 1 0 1 1 1")"

expect "a history that never arrived or never went back is a failure" "fail" \
  "$(verdict "1 1 1 1 1 1 0 1")"
expect "and names where the state is sent" "yes" \
  "$(says "1 1 1 1 1 1 0 1" "ReportState")"

expect "a find that never answered is a failure" "fail" \
  "$(verdict "1 1 1 1 1 1 1 0")"
expect "and names where the answer is sent" "yes" \
  "$(says "1 1 1 1 1 1 1 0" "DidReceiveFindReply")"

echo
echo "the control — a chrome:// page"
expect "a chrome:// page that opened is a failure" "fail" \
  "$(verdict "1 1 1 1 1 0 1 1")"
expect "and says which schemes open" "yes" \
  "$(says "1 1 1 1 1 0 1 1" "http and https")"
expect "an empty measurement is a failure" "fail" "$(verdict "")"

[ "$FAILED" -eq 0 ] && echo "all ok"
exit "$FAILED"
