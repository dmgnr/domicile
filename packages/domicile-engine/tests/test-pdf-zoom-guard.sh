#!/usr/bin/env bash
# Tests which results `guard-pdf-zoom.sh` passes.
#
# Runs the guard's own verdict block, not a copy. Key cases:
#
#   - The viewer at 2 with its page at the default zoom passes.
#   - The viewer at 2 with its page zoomed too fails: zoomed twice.
#   - A viewer that never reached 2 fails.
#   - Any refused chrome.tabs call fails, whatever was measured.
#   - A viewer that never started, or a <webview> that never attached, fails.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
GUARD="$ROOT/packages/domicile-engine/scripts/guard-pdf-zoom.sh"
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

verdict() { # $1 REFUSED, $2 MEASURED
  (
    # shellcheck disable=SC2034 # read by the eval below
    REFUSED="$1" MEASURED="$2" REFUSAL="not supported on a Domicile desk"
    eval "$BLOCK"
    case "$FAILURE" in
    "") echo pass ;;
    *"zooms twice"*) echo "fail: twice" ;;
    *"never zoomed"*) echo "fail: viewer" ;;
    *refused*) echo "fail: refused" ;;
    *never*) echo "fail: never" ;;
    *) echo "fail: $FAILURE" ;;
    esac
  )
}

expect "a viewer zoomed alone passes" "pass" "$(verdict 0 'ratio=1.00 viewer=2.00')"
expect "a page zoomed with the viewer fails" "fail: twice" "$(verdict 0 'ratio=2.00 viewer=2.00')"
expect "a viewer that never zoomed fails" "fail: viewer" "$(verdict 0 'ratio=1.00 viewer=1.33')"
expect "a refused call fails" "fail: refused" "$(verdict 4 'ratio=1.00 viewer=2.00')"
expect "a refused call fails before the viewer starts" "fail: refused" "$(verdict 1 'viewer=absent')"
expect "a viewer that never started fails" "fail: never" "$(verdict 0 'viewer=absent')"
expect "a webview that never attached fails" "fail: never" "$(verdict 0 '')"
expect "an engine with no port fails" "fail: never" "$(verdict 0 'no-port')"

[ "$FAILED" -eq 0 ] || exit 1
