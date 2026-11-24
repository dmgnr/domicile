#!/usr/bin/env bash
# Checks a page can drag text, an image or a link on the desk.
#
# Ozone DRM and headless windows have no `WmDragHandler`, and upstream's
# `DesktopDragDropClientOzone` answers every drag there with kNone before it
# starts. The series gives such a window the desk's own handler
# (`DeskDragHandler`), and finds a drop's target on any monitor of the desk.
#
# Reads the patches, not a Chromium tree, so it runs in the shell group.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
PATCHES="$ROOT/packages/domicile-engine/patches"
[ -d "$PATCHES" ] || { echo "no patch series at $PATCHES" >&2; exit 1; }

failed=0

# Prints the lines the series adds to files matching $2.
added_in() {
  awk -v want="$2" '
    /^diff --git a\// { in_file = ($0 ~ want) }
    !in_file { next }
    /^\+\+\+ / { next }
    /^\+/ { print substr($0, 2) }
  ' "$1"/*.patch
}

check() {
  local name="$1" added="$2" pattern="$3" why="$4"
  # shellcheck disable=SC2254
  case "$added" in
    ($pattern) echo "  ok    $name" ;;
    (*)
      echo "  FAIL  $name"
      echo "    $why"
      failed=$((failed + 1)) ;;
  esac
}

check 'a window with no drag handler gets the desk'"'"'s' \
  "$(added_in "$PATCHES" 'desktop_window_tree_host_platform[.]cc$')" \
  '*if (!drag_handler)*DeskDragHandler*' \
  'CreateDragDropClient never makes a DeskDragHandler, so every drag on a tty ends before it starts.'

check 'a drop on another monitor finds the desk page' \
  "$(added_in "$PATCHES" 'desktop_drag_drop_client_ozone[.]cc$')" \
  '*DeskWindowAt*' \
  'the drop target is still the root window'"'"'s alone, so a drop off the host monitor lands nowhere.'

check 'views links the desk drag' \
  "$(added_in "$PATCHES" 'ui/views/BUILD[.]gn$')" \
  '*desktop_aura/domicile:desk_drag*' \
  'ui/views/BUILD.gn never depends on //ui/views/widget/desktop_aura/domicile:desk_drag.'

[ "$failed" -eq 0 ] || { echo "$failed failed"; exit 1; }
echo "all ok"
