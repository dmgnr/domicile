#!/usr/bin/env bash
# Tests which end the Electron menu bar guard blames and which results it
# passes.
#
# Runs the verdict block from `guard-electron-menu-bar.sh` itself, not a copy,
# like the other guards' tests. Key cases: a click or a popup choice that
# never reached the app is a failure even when the shell read the menu.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
GUARD="$ROOT/packages/domicile-engine/scripts/guard-electron-menu-bar.sh"
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

# MEASURED is "<ready> <listed> <clicked> <cleared> <popped> <chose>
# <closed>".
echo "the claim — an app's menu bar and popup menus are listed, and choices on them reach the app"
expect "everything heard is the pass" "pass" "$(verdict "1 1 1 1 1 1 1")"
expect "no hello is a failure" "fail" "$(verdict "0 0 0 0 0 0 0")"
expect "and points at the socket's guard" "yes" \
  "$(says "0 0 0 0 0 0 0" "guard-electron-socket.sh")"
expect "a menu the shell never read is a failure" "fail" \
  "$(verdict "1 0 0 0 0 0 0")"
expect "and names SetMenuBar" "yes" \
  "$(says "1 0 0 0 0 0 0" "DeskWindows::SetMenuBar")"
expect "a click that never reached the app is a failure" "fail" \
  "$(verdict "1 1 0 0 0 0 0")"
expect "and names clickBrowserWindowMenu" "yes" \
  "$(says "1 1 0 0 0 0 0" "clickBrowserWindowMenu")"
expect "a menu kept after the app took it away is a failure" "fail" \
  "$(verdict "1 1 1 0 0 0 0")"
expect "and names the relisting" "yes" "$(says "1 1 1 0 0 0 0" "relist")"
expect "a popup the shell never read where it goes is a failure" "fail" \
  "$(verdict "1 1 1 1 0 0 0")"
expect "and names ShowPopupMenu" "yes" \
  "$(says "1 1 1 1 0 0 0" "DeskWindows::ShowPopupMenu")"
expect "a popup choice that never reached the app is a failure" "fail" \
  "$(verdict "1 1 1 1 1 0 0")"
expect "and names answerBrowserWindowPopupMenu" "yes" \
  "$(says "1 1 1 1 1 0 0" "answerBrowserWindowPopupMenu")"
expect "a popup put away that the app never heard close is a failure" "fail" \
  "$(verdict "1 1 1 1 1 1 0")"
expect "and names ClosePopupMenu" "yes" \
  "$(says "1 1 1 1 1 1 0" "ClosePopupMenu")"
expect "the old four-part pass is no longer a pass" "fail" \
  "$(verdict "1 1 1 1")"
expect "an empty measurement is a failure" "fail" "$(verdict "")"

[ "$FAILED" -eq 0 ] && echo "all ok"
exit "$FAILED"
