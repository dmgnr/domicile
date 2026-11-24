#!/usr/bin/env bash
# Tests which end the app module guard blames and which results it passes.
#
# Runs the verdict block from `guard-app-module.sh` itself, not a copy, like
# the other guards' tests. Key case: in the control, a second `main` fails,
# since only the pin keeps an app's address out of other windows.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
GUARD="$ROOT/packages/domicile-engine/scripts/guard-app-module.sh"
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

# MEASURED is "<mode> <answered> <mains> <narrow> <hello> <replied>
# <fetched> <isolated>".
echo "the claim — run_app"
expect "an app that ran and was answered is the pass" "pass" \
  "$(verdict "pinned 1 1 1 1 1 1 1")"
expect "no answer from the engine is a failure" "fail" \
  "$(verdict "pinned 0 0 0 0 0 1 1")"
expect "and blames the command socket" "yes" \
  "$(says "pinned 0 0 0 0 0 1 1" "command socket")"
expect "a main that never ran is a failure" "fail" \
  "$(verdict "pinned 1 0 0 0 0 1 1")"
expect "and blames serving the app" "yes" \
  "$(says "pinned 1 0 0 0 0 1 1" "ServeApp")"
expect "the shell's host handed to an app is a failure" "fail" \
  "$(verdict "pinned 1 1 0 1 1 1 1")"
expect "and says so" "yes" "$(says "pinned 1 1 0 1 1 1 1" "DomicileAppHost")"
expect "no app_hello is a failure" "fail" "$(verdict "pinned 1 1 1 0 0 1 1")"
expect "and blames the binder" "yes" "$(says "pinned 1 1 1 0 0 1 1" "AppChannel binder")"
expect "an unanswered call is a failure" "fail" "$(verdict "pinned 1 1 1 1 0 1 1")"
expect "an app that cannot fetch its own file is a failure" "fail" \
  "$(verdict "pinned 1 1 1 1 1 0 1")"
expect "and names what serves a file to its own origin" "yes" \
  "$(says "pinned 1 1 1 1 1 0 1" "MayReadFiles")"
expect "an app that is not cross-origin isolated is a failure" "fail" \
  "$(verdict "pinned 1 1 1 1 1 1 0")"
expect "and names the check" "yes" \
  "$(says "pinned 1 1 1 1 1 1 0" "IsCrossOriginIsolatedOrigin")"

echo
echo "the control — the app's address in an unpinned window"
expect "one main is the control's pass" "pass" "$(verdict "unpinned 1 1 1 1 1 1 1")"
expect "a second main is a failure" "fail" "$(verdict "unpinned 1 2 1 1 1 1 1")"
expect "and blames the pin" "yes" "$(says "unpinned 1 2 1 1 1 1 1" "MayShowInWebView")"
expect "a refused open_url is a failure" "fail" "$(verdict "unpinned 0 1 1 1 1 1 1")"

[ "$FAILED" -eq 0 ] && echo "all ok"
exit "$FAILED"
