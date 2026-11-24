#!/usr/bin/env bash
# Tests which end the Electron window open guard blames and which results it
# passes.
#
# Runs the verdict block from `guard-electron-window-open.sh` itself, not a
# copy, like the other guards' tests. Key cases: an app not asked, a denied
# link that opened anyway, and a denied popup left open are each a failure.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
GUARD="$ROOT/packages/domicile-engine/scripts/guard-electron-window-open.sh"
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

# MEASURED is "<link-asked> <link-alone> <popup-asked> <popup-opened>
# <denied-closed>".
echo "the claim — the app decides on its page's new windows"
expect "everything in its place is the pass" "pass" "$(verdict "1 1 1 1 1")"
expect "an app not asked is a failure" "fail" "$(verdict "0 0 1 1 1")"
expect "and names the patch" "yes" "$(says "0 0 1 1 1" "0239")"
expect "a denied link that opened is a failure" "fail" "$(verdict "1 0 1 1 1")"
expect "a popup not asked about is a failure" "fail" "$(verdict "1 1 0 0 0")"
expect "and names AddNewContents" "yes" \
  "$(says "1 1 0 0 0" "AddNewContents")"
expect "an allowed popup not opened is a failure" "fail" \
  "$(verdict "1 1 1 0 1")"
expect "and names Adopt" "yes" "$(says "1 1 1 0 1" "ElectronDesk::Adopt")"

echo
echo "the control — a denied popup closes"
expect "one left open is a failure" "fail" "$(verdict "1 1 1 1 0")"
expect "an empty measurement is a failure" "fail" "$(verdict "")"

[ "$FAILED" -eq 0 ] && echo "all ok"
exit "$FAILED"
