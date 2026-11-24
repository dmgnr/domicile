#!/usr/bin/env bash
# Tests the verdict of `guard-desk-state.sh`, which judges the page's latest
# reading of the desk's state attributes.
#
# The page logs a reading each time one changes, and the first can come
# before the compositor stand-in has said everything. Judging that one fails a
# run whose attributes arrive late but right.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
VERDICT="$ROOT/packages/domicile-engine/scripts/guard-desk-state-verdict.py"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

PARTIAL='{"altKey":null,"clipboard":null,"ctrlKey":null,"idle":true,"locked":false,"shellOptions":null,"shiftKey":null,"theme":"light","tray":null,"windowsTheme":"dark"}'
COMPLETE='{"altKey":true,"clipboard":[{"current":true,"id":7,"image":false,"preview":"hello","thumbnail":""},{"current":false,"id":8,"image":true,"preview":"Image, 3 × 2","thumbnail":"data:image/png;base64,iVBORw0KGgo="}],"ctrlKey":false,"idle":true,"locked":false,"shellOptions":"{\"gaps\":4}","shiftKey":true,"theme":"light","tray":[{"bus":":1.42","id":"nm","itemIsMenu":false,"menu":"/MenuBar","title":"Network"},{"bus":"org.kde.StatusNotifierItem-7-1","id":"sync","itemIsMenu":true,"menu":"","title":"Sync"}],"windowsTheme":"dark"}'

FAILED=0
expect() { # what, want, got
  if [ "$3" = "$2" ]; then
    printf '  ok    %s\n' "$1"
  else
    printf '  FAIL  %s\n    wanted: %s\n    got:    %s\n' "$1" "$2" "$3"
    FAILED=$((FAILED + 1))
  fi
}
names() { # what, output, attribute...
  local what="$1" got="$2"
  shift 2
  for wrong in "$@"; do
    if [[ "$got" == *"$wrong"* ]]; then
      printf '  ok    %s names %s\n' "$what" "$wrong"
    else
      printf '  FAIL  %s does not name %s\n    got: %s\n' "$what" "$wrong" "$got"
      FAILED=$((FAILED + 1))
    fi
  done
}

# An engine log holding these readings, one console line each.
log() { # name, reading...
  local file="$WORK/$1"
  shift
  : >"$file"
  for reading in "$@"; do
    printf '[1:1:1013/000000.000000:INFO:CONSOLE:30] "GUARD state %s", source: domicile://shell/guard-desk-state.js (30)\n' \
      "$reading" >>"$file"
  done
  echo "$file"
}

expect "a reading that says what the compositor said passes" \
  "" "$(python3 "$VERDICT" "$(log complete "$COMPLETE")" 2>&1)"

expect "the latest reading is judged, not the first" \
  "" "$(python3 "$VERDICT" "$(log late "$PARTIAL" "$COMPLETE")" 2>&1)"

names "a reading missing the last messages" \
  "$(python3 "$VERDICT" "$(log partial "$PARTIAL")")" \
  "altKey is null, wanted true" "clipboard is null" "tray is null" \
  "shiftKey is null, wanted true" "shellOptions is null"

names "a log with no reading" \
  "$(python3 "$VERDICT" "$(log none)")" \
  "the page never read the state"

if [ "$FAILED" -gt 0 ]; then
  echo "$FAILED failed"
  exit 1
fi
echo "all ok"
