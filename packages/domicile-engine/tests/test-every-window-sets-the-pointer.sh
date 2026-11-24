#!/usr/bin/env bash
# Checks the pointer on a tty shows the current cursor after monitors come and
# go.
#
# Every window shares one cursor client. Two patches keep the screen current:
#
# - `DrmCursor::SetCursor` takes a cursor from any window. Taken only from the
#   window under the pointer, a cursor set while an unplugged monitor's window
#   was going away never reached the screen.
# - `DesktopNativeCursorManager` sets the cursor again after a window is added
#   or removed, so the window the pointer moves to shows it.
#
# Missing either still compiles. After an undock the pointer then stays
# Chromium's art until the cursor changes, such as over a native window.
#
# Needs no engine build.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
PATCHES="$ROOT/packages/domicile-engine/patches"

fail() {
  echo "  FAIL  $1" >&2
  shift
  for line in "$@"; do echo "        $line" >&2; done
  exit 1
}

# Any patch: later ones edit other parts of drm_cursor.cc.
grep -l "^diff --git a/ui/ozone/platform/drm/host/drm_cursor.cc " \
  "$PATCHES"/*.patch | xargs grep -q '^-.*window_ != window && window != desk_host_' || fail \
  "DrmCursor::SetCursor still takes a cursor only from the window under it" \
  "A cursor set while that window goes away never reaches the screen."

MANAGERS="$(grep -l "^diff --git a/ui/views/widget/desktop_aura/desktop_native_cursor_manager.cc " "$PATCHES"/*.patch)"
[ -n "$MANAGERS" ] || fail "no patch edits desktop_native_cursor_manager.cc"
for host in AddHost RemoveHost; do
  # Any patch: later ones edit other parts of the file.
  for manager in $MANAGERS; do
    awk -v host="$host" '
      $0 ~ "DesktopNativeCursorManager::" host "\\(" { inside = 1 }
      inside && /^[+ ]}/ { exit found ? 0 : 1 }
      inside && /^\+.*RedrawSoon\(\)/ { found = 1 }
      END { if (!inside) exit 1 }
    ' "$manager" && continue 2
  done
  fail \
    "DesktopNativeCursorManager::$host does not set the cursor again" \
    "The window the pointer moves to keeps the cursor it last had."
done

echo "every window sets the pointer, and a window change redraws it"
