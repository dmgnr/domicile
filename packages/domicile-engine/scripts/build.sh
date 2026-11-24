#!/usr/bin/env bash
# Configure and build the engine.
#
#   ./scripts/build.sh /build/chromium/src
#
# A release component build with no symbols, for fast builds. Ozone platforms:
#
#   wayland   nested in an existing session (developers, CI)
#   headless  no display; `crux` needs it to run the engine at all
#   drm       a bare tty; see docs/architecture/A-DESKTOP-ON-A-TTY.md
#
# The DRM platform needs patches 0012 (relaxes its ChromeOS-only assert), 0013
# (`DrmScreen`) and 0016 (modeset driver).
set -u

CHROMIUM="${1:-}"
OUT="${OUT:-out/Domicile}"

if [ -z "$CHROMIUM" ]; then
  echo "usage: build.sh <path to chromium/src>" >&2
  exit 1
fi

cd "$CHROMIUM" || exit 1

# Optional compiler cache. `gn` bakes `cc_wrapper` into every compile command,
# so adding or dropping it rebuilds everything. A wrapper that cannot run is
# refused before `gn gen` rewrites the output directory.
#
# Use a stable path, not a store path, so bumping ccache does not change every
# command. See cprussin/dotfiles chromium-build.nix.
CACHE_ARG=""
WRAPPER="${DOMICILE_CC_WRAPPER:-}"
if [ -n "$WRAPPER" ]; then
  # `command -v` accepts a bare name like `ccache`, the form Chromium's
  # cc_wrapper.gni documents. It also accepts shell builtins; a builtin such as
  # `:` fails the build at the first link, which is still loud.
  if ! command -v "$WRAPPER" >/dev/null 2>&1; then
    echo "DOMICILE_CC_WRAPPER names $WRAPPER, which nothing here can run." >&2
    echo "Carrying on without it would be a silent rebuild of the whole of" >&2
    echo "Chromium, so this stops. Unset it to build with no cache." >&2
    exit 1
  fi
  CACHE_ARG="  cc_wrapper = \"$WRAPPER\"
"

  # Share one cache across trees. crux builds in /build/trees/tree-N/src with
  # N picked per run, so hashing absolute paths misses in every other tree.
  # BASEDIR makes paths relative to the tree (physical, as ccache compares it
  # with getcwd), and NOHASHDIR keeps the working directory out of the hash.
  CCACHE_BASEDIR="$(pwd -P)"
  export CCACHE_BASEDIR
  export CCACHE_NOHASHDIR=1
fi

# Run `gn gen` every time. It skips the work when the arguments are unchanged,
# and `crux` keeps warm trees, so gating it would keep stale arguments.
#
# `ozone_platform` is unset, so the default platform stays the first in
# `//ui/ozone/BUILD.gn`'s order: headless. DRM is used only when asked for with
# `--ozone-platform=drm`.
#
# `use_libinput`: without it, a touchpad off ChromeOS falls through to
# `EventConverterEvdevImpl`, which ignores `EV_ABS`, so the pointer cannot move.
# Patch 0027 passes it the device that logind opened.
gn gen "$OUT" --args="
  is_debug = false
  symbol_level = 0
  is_component_build = true
  use_ozone = true
  ozone_auto_platforms = false
  ozone_platform_wayland = true
  ozone_platform_headless = true
  ozone_platform_drm = true
  use_libinput = true
  import(\"//build/args/domicile_codecs.gn\")
  import(\"//build/args/domicile_trim.gn\")
  import(\"//build/args/domicile_node.gn\")
$CACHE_ARG" || exit 1

# guard-css-and-resize.sh needs `domicile_css_parity`,
# guard-webview-framing.sh needs `domicile_color_probe`,
# guard-display-capture.sh needs `domicile_capture_probe`, and
# guard-headless-desk.sh needs `domicile_desk_probe`, and
# guard-engine-node.sh needs Electron's Node.
exec autoninja -C "$OUT" chrome domicile_solid_color_submitter \
  domicile_css_parity domicile_color_probe domicile_capture_probe \
  domicile_desk_probe third_party/electron_node:node
