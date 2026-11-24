#!/usr/bin/env bash
# Tests which end the Electron Node guard blames and which results it
# passes.
#
# Runs the verdict block from `guard-electron-node.sh` itself, not a copy,
# like the other guards' tests. Key cases: a page that sees Node through
# context isolation, one that keeps Node's globals without nodeIntegration,
# and a Node page in a renderer not started for it, are failures even when
# everything else worked.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
GUARD="$ROOT/packages/domicile-engine/scripts/guard-electron-node.sh"
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

verdict() { # $1 MEASURED, $2 RENDERERS
  (
    MEASURED="$1"
    RENDERERS="${2:-ok}"
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

says() { # $1 MEASURED, $2 what the sentence must contain, $3 RENDERERS
  case "$(
    MEASURED="$1"
    RENDERERS="${3:-ok}"
    eval "$BLOCK"
    echo "$FAILURE"
  )" in
  *"$2"*) echo yes ;;
  *) echo no ;;
  esac
}

# MEASURED is "<ready> <preloaded> <integrated> <looped> <isolated>
# <stripped> <unnoded>"; RENDERERS is ok, shared or unmarked.
echo "the claim — Node in the pages of windows that aren't sandboxed"
expect "Node where each window asked for it, and only there, is the pass" \
  "pass" "$(verdict "1 1 1 1 1 1 1")"
expect "no hello is a failure" "fail" "$(verdict "0 0 0 0 0 0 0")"
expect "and points at the socket's guard" "yes" \
  "$(says "0 0 0 0 0 0 0" "guard-electron-socket.sh")"
expect "Node pages sharing a renderer is a failure, all else passing" "fail" \
  "$(verdict "1 1 1 1 1 1 1" shared)"
expect "and names the hook that marks it" "yes" \
  "$(says "1 1 1 1 1 1 1" "MainFrameNavigatesInto" shared)"
expect "a renderer never marked for Node is a failure" "fail" \
  "$(verdict "1 1 1 1 1 1 1" unmarked)"
expect "no hello stays the socket's failure, whatever the renderers" "yes" \
  "$(says "0 0 0 0 0 0 0" "guard-electron-socket.sh" shared)"
expect "a preload without Node is a failure" "fail" \
  "$(verdict "1 0 0 0 0 0 1")"
expect "and names where Node starts" "yes" \
  "$(says "1 0 0 0 0 0 1" "ElectronNodeEnvironment")"
expect "an integrated page without require is a failure" "fail" \
  "$(verdict "1 1 0 1 1 1 1")"
expect "and names the page's require" "yes" \
  "$(says "1 1 0 1 1 1 1" "makeRequireFunction")"
expect "a loop that never called back is a failure" "fail" \
  "$(verdict "1 1 1 0 1 1 1")"
expect "and names the loop's turns" "yes" "$(says "1 1 1 0 1 1 1" "RunOnce")"
expect "a page that saw Node through isolation is a failure" "fail" \
  "$(verdict "1 1 1 1 0 1 1")"
expect "and names context isolation" "yes" \
  "$(says "1 1 1 1 0 1 1" "context isolation")"
expect "a page that kept Node's globals is a failure" "fail" \
  "$(verdict "1 1 1 1 1 0 1")"
expect "and names nodeIntegration" "yes" \
  "$(says "1 1 1 1 1 0 1" "without nodeIntegration")"

echo
echo "the control — a sandboxed window"
expect "a sandboxed window with Node is a failure" "fail" \
  "$(verdict "1 1 1 1 1 1 0")"
expect "and says only a window opened with node gets it" "yes" \
  "$(says "1 1 1 1 1 1 0" "only a")"
expect "an empty measurement is a failure" "fail" "$(verdict "")"

[ "$FAILED" -eq 0 ] && echo "all ok"
exit "$FAILED"
