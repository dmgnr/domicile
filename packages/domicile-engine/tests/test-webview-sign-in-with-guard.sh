#!/usr/bin/env bash
# Tests the verdict of `guard-webview-sign-in-with.sh`: which readings pass and
# which component a failure blames.
#
# The checks are ordered: what the shell was asked only means something once
# it was asked, and what its answers did only once it was asked right. Key
# cases:
#
#   - A shell never asked blames FedCM being off or patch 0210.
#   - No token after choosing blames on_selected, and no withdrawal after
#     leaving blames ~IdentityDialog.
#   - A page that never reported passes nothing.
#
# Runs the verdict block from the real guard, so moving it fails here.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
GUARD="$ROOT/packages/domicile-engine/scripts/guard-webview-sign-in-with.sh"
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
    SAW_PAGE=1
    SAW_ASKED=1
    SAW_DETAILS=1
    SAW_TOKEN=1
    SAW_WITHDRAWN=1
    SAW_REJECTED=1
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

echo "a run that never got as far as asking"
expect "a shell that never ran blames the harness" "yes" \
  "$(blames "harness" SAW_SHELL=0)"
expect "a page that never reported names the guest" "yes" \
  "$(blames "the guest" SAW_PAGE=0)"
expect "a page that never reported passes nothing" "fail" \
  "$(verdict SAW_PAGE=0)"
expect "a shell never asked blames patch 0210" "yes" \
  "$(blames "patch 0210" SAW_ASKED=0)"
expect "a shell never asked fails before its answers count" "yes" \
  "$(blames "never asked" SAW_ASKED=0 SAW_TOKEN=0)"

echo
echo "the claim"
expect "every reading right is the pass" "pass" "$(verdict)"
expect "a request missing its details blames ShowAccountsDialog" "yes" \
  "$(blames "ShowAccountsDialog" SAW_DETAILS=0)"
expect "no token blames on_selected" "yes" \
  "$(blames "on_selected" SAW_TOKEN=0)"
expect "no withdrawal blames ~IdentityDialog" "yes" \
  "$(blames "~IdentityDialog" SAW_WITHDRAWN=0)"
expect "no rejection blames the dismiss callback" "yes" \
  "$(blames "dismiss callback" SAW_REJECTED=0)"

echo
if [ "$FAILED" -eq 0 ]; then
  echo "the sign-in guard's verdict names the right end in every case"
  exit 0
fi
echo "$FAILED case(s) wrong" >&2
exit 1
