#!/usr/bin/env bash
# Tests the verdict of `guard-webview-chrome-sheets.sh`: which readings pass and
# which component a failure blames.
#
# The checks are ordered: an absent API only means something once the probe
# has seen the APIs around it. Key cases:
#
#   - A page that has PaymentRequest blames payment_request_enabled.
#   - Picture-in-picture still on blames OverrideWebPreferences.
#   - A probe that sees no navigator.credentials passes nothing.
#
# Runs the verdict block from the real guard, so moving it fails here.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
GUARD="$ROOT/packages/domicile-engine/scripts/guard-webview-chrome-sheets.sh"
[ -f "$GUARD" ] || {
  echo "no guard at $GUARD" >&2
  exit 1
}

# From `FAILURE=""` to the column-zero `fi` that ends the decision.
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

# Runs the block with every reading at its passing value; each case overrides
# one. Prints "pass", "fail" or "neither", then the failure on the next line.
judge() { # NAME=value overrides
  (
    SAW_SHELL=1
    SAW_REPORT=1
    SAW_APIS=1
    SAW_NO_PAYMENT=1
    SAW_NO_PIP=1
    for override in "$@"; do
      eval "$override"
    done
    eval "$BLOCK"
    if [ -n "$PASSED" ]; then
      echo "pass"
    elif [ -n "$FAILURE" ]; then
      echo "fail"
    else
      echo "neither"
    fi
    echo "$FAILURE"
  )
}

verdict() { judge "$@" | head -1; }

blames() { # $1 word, then the args judge takes
  local word="$1"
  shift
  case "$(judge "$@" | tail -n +2)" in
  *"$word"*) echo yes ;;
  *) echo no ;;
  esac
}

echo "a run that never got as far as measuring anything"
expect "a shell that never ran blames the harness" "yes" \
  "$(blames "harness" SAW_SHELL=0)"
expect "a page that never reported names the guest" "yes" \
  "$(blames "the guest" SAW_REPORT=0)"
expect "a probe that sees no APIs passes nothing" "fail" \
  "$(verdict SAW_APIS=0 SAW_NO_PAYMENT=1)"
expect "a probe that sees no APIs blames the probe" "yes" \
  "$(blames "probe" SAW_APIS=0)"

echo
echo "the claim"
expect "every API off is the pass" "pass" "$(verdict)"
expect "PaymentRequest left blames payment_request_enabled" "yes" \
  "$(blames "payment_request_enabled" SAW_NO_PAYMENT=0)"
expect "picture-in-picture left blames OverrideWebPreferences" "yes" \
  "$(blames "OverrideWebPreferences" SAW_NO_PIP=0)"

echo
if [ "$FAILED" -eq 0 ]; then
  echo "the Chrome sheets guard's verdict names the right end in every case"
  exit 0
fi
echo "$FAILED case(s) wrong" >&2
exit 1
