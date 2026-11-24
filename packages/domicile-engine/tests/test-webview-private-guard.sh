#!/usr/bin/env bash
# Tests the verdict of `guard-webview-private.sh`: which readings pass and
# which component a failure blames.
#
# The run sets the cookie on the private side and the control on the ordinary
# side, so each passes on mirrored readings. Runs the verdict block from the
# real guard, so moving it fails here.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
GUARD="$ROOT/packages/domicile-engine/scripts/guard-webview-private.sh"
[ -f "$GUARD" ] || {
  echo "no guard at $GUARD" >&2
  exit 1
}

BLOCK="$(awk '/^FAILURE=""$/,/^fi$/' "$GUARD")"
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

# A passing run of the given mode; each case changes one reading.
readings() { # $1 NEGATIVE, then NAME=value overrides
  NEGATIVE="$1"
  SAW_SHELL=1
  SAW_CRASH=0
  SAW_SET=1
  SAW_NORMAL=1
  SAW_PRIVATE=1
  SAW_WINDOW=1
  SAW_WINDOW_READ=1
  WINDOW_HAS=1
  SAW_CLOSED=1
  SAW_AFTER=1
  AFTER_HAS=0
  SAW_ENDED=1
  if [ "$NEGATIVE" = "1" ]; then
    NORMAL_HAS=1
    PRIVATE_HAS=0
    WINDOW_PRIVATE=0
  else
    NORMAL_HAS=0
    PRIVATE_HAS=1
    WINDOW_PRIVATE=1
  fi
  shift
  for override in "$@"; do
    eval "$override"
  done
}

verdict() { # $1 NEGATIVE, then NAME=value overrides
  (
    readings "$@"
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

blames() { # $1 word, then the args verdict takes
  local word="$1"
  shift
  case "$(
    readings "$@"
    eval "$BLOCK"
    echo "$FAILURE"
  )" in
  *"$word"*) echo yes ;;
  *) echo no ;;
  esac
}

echo "a run that never got as far as measuring anything"
expect "no shell is a failure" "fail" "$(verdict 0 SAW_SHELL=0)"
expect "a crash is a failure" "fail" "$(verdict 0 SAW_CRASH=1)"
expect "a crash names the cross-context attach" "yes" \
  "$(blames "across browser contexts" 0 SAW_CRASH=1)"
expect "no setter is a failure" "fail" "$(verdict 0 SAW_SET=0)"
expect "a missing reader is a failure" "fail" "$(verdict 0 SAW_NORMAL=0)"

echo
echo "the run — the cookie set in a private <webview>"
expect "the private side has it and the ordinary does not: pass" "pass" "$(verdict 0)"
expect "the cookie crossing is a failure" "fail" "$(verdict 0 NORMAL_HAS=1)"
expect "the cookie crossing names CreateAndAttach" "yes" \
  "$(blames "CreateAndAttach" 0 NORMAL_HAS=1)"
expect "the private reader missing it is a failure" "fail" \
  "$(verdict 0 PRIVATE_HAS=0)"
expect "and says nothing was stored" "yes" \
  "$(blames "never stored" 0 PRIVATE_HAS=0)"
expect "a window not listed private is a failure" "fail" \
  "$(verdict 0 WINDOW_PRIVATE=0)"
expect "a window without the cookie is a failure" "fail" \
  "$(verdict 0 WINDOW_HAS=0)"
expect "and names ContextFor" "yes" \
  "$(blames "ContextFor picks the" 0 WINDOW_HAS=0)"
expect "an unlisted window is a failure" "fail" "$(verdict 0 SAW_WINDOW=0)"
expect "no reader after closing is a failure" "fail" "$(verdict 0 SAW_AFTER=0)"
expect "the cookie outliving its pages is a failure" "fail" \
  "$(verdict 0 AFTER_HAS=1)"
expect "and names PrivatePageClosed when nothing ended" "yes" \
  "$(blames "PrivatePageClosed" 0 AFTER_HAS=1 SAW_ENDED=0)"
expect "and names ContextOf when it ended" "yes" \
  "$(blames "BrowserProfileRegistry::ContextOf" 0 AFTER_HAS=1)"

echo
echo "the control — the cookie set in an ordinary <webview>"
expect "the ordinary side has it and the private does not: pass" "pass" "$(verdict 1)"
expect "the private reader having it is a failure" "fail" \
  "$(verdict 1 PRIVATE_HAS=1)"
expect "an ordinary window listed private is a failure" "fail" \
  "$(verdict 1 WINDOW_PRIVATE=1)"
expect "the ordinary reader missing it is a failure" "fail" \
  "$(verdict 1 NORMAL_HAS=0)"

echo
if [ "$FAILED" -eq 0 ]; then
  echo "the private guard's verdict names the right end in every case"
  exit 0
fi
echo "$FAILED case(s) wrong" >&2
exit 1
