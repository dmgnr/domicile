#!/usr/bin/env bash
# Asserts the extension-menu guard's verdict: which answers pass, and which
# end each failure blames.
#
# Runs the verdict block from `guard-extension-menu.sh` itself, as
# `test-extension-tray-guard.sh` does. Key cases: a control that saw no fixture
# must still have heard the list, since "not installed" and "no list" look the
# same; and a control whose switch was not refused proves nothing about the
# claim's refusals.
#
# Also checks what the guard cannot check at runtime: its id is the tray
# fixture's, and the fixture asks for no file access, so the config's file
# access is the only reason to refuse it.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SCRIPTS="$ROOT/packages/domicile-engine/scripts"
GUARD="$SCRIPTS/guard-extension-menu.sh"
FIXTURE="$SCRIPTS/guard-extension-tray-extension"
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

# Prints pass or fail, not the message, which may be reworded.
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

# Whether the failure message contains `$2`; the end it blames matters.
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

# MEASURED is "menu <sent> <heard> <row> <private> <locked> <kept> <off>
# <on>" or "control <sent> <heard> <row> <refused>", each 1 or 0:
expect "every step done passes" "pass" "$(verdict "menu 1 1 1 1 1 1 1 1")"
expect "no list sent blames the stand-in's connection" "yes" \
  "$(says "menu 0 0 0 0 0 0 0 0" "never sent")"
expect "no list heard blames the binding" "yes" \
  "$(says "menu 1 0 0 0 0 0 0 0" "did not bind")"
expect "a wrong row is a failure" "fail" "$(verdict "menu 1 1 0 0 0 0 0 0")"
expect "a setting the config owns, set, blames SetByConfig" "yes" \
  "$(says "menu 1 1 1 1 0 0 0 0" "SetByConfig")"
expect "the config's extension uninstalled blames UninstallFrom" "yes" \
  "$(says "menu 1 1 1 1 1 0 0 0" "UninstallFrom")"
expect "a switch off that kept the action is a failure" "fail" \
  "$(verdict "menu 1 1 1 1 1 1 0 0")"
expect "not switched back on is a failure" "fail" \
  "$(verdict "menu 1 1 1 1 1 1 1 0")"
expect "the sharp control passes" "pass" "$(verdict "control 1 1 0 1")"
expect "a control with the fixture installed fails" "fail" \
  "$(verdict "control 1 1 1 1")"
expect "a control whose switch was not refused fails" "fail" \
  "$(verdict "control 1 1 0 0")"
expect "a control that heard no list fails" "fail" "$(verdict "control 1 0 0 0")"
expect "an unknown leg fails" "fail" "$(verdict "")"

ID="$(sed -n 's/^readonly ID="\(.*\)"$/\1/p' "$GUARD")"
TRAY_ID="$(sed -n 's/^readonly ID="\(.*\)"$/\1/p' "$SCRIPTS/guard-extension-tray.sh")"
expect "the guard's id is the tray fixture's" "$TRAY_ID" "$ID"
expect "and asks for no file or host access, so only the config owns its file access" \
  "no" "$(grep -qE 'file://|host_permissions|<all_urls>' "$FIXTURE/manifest.json" && echo yes || echo no)"

echo
if [ "$FAILED" -eq 0 ]; then
  echo "the extension-menu guard's verdict names the right end in every case"
  exit 0
fi
echo "$FAILED case(s) wrong" >&2
exit 1
