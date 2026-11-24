#!/usr/bin/env bash
# Whether a shell window is black, not white, until its shell draws.
#
# See patch 0266. Until the shell's first frame, a window shows Chrome's
# new-tab background: white in a light theme, gray in a dark one. On a tty
# that flashed white between the boot screen and the shell (#2467). The
# engine has no new-tab page, so the color is black.
#
# Reads the series rather than a build, so it runs on every push.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
PATCHES="$ROOT/packages/domicile-engine/patches"
[ -d "$PATCHES" ] || { echo "no patch series at $PATCHES" >&2; exit 1; }

added_to() {
  awk -v want="$1" '
    FNR == 1 { in_file = 0 }
    /^diff --git a\// { in_file = (index($0, want) > 0); next }
    !in_file { next }
    /^(\+\+\+|---) / { next }
    /^\+/ { print substr($0, 2) }
  ' "$PATCHES"/*.patch
}

mixer="$(added_to chrome/browser/ui/color/chrome_color_mixer.cc)"

if ! grep -qF -- 'mixer[kColorWebContentsBackground] = {SK_ColorBLACK};' <<<"$mixer"; then
  echo "FAIL: no patch makes a window's background before its first frame black"
  exit 1
fi
echo "ok: a shell window is black until its shell draws"
