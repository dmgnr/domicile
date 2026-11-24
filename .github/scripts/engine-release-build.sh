#!/usr/bin/env bash
# Build the shippable engine configuration.
#
#   .github/scripts/engine-release-build.sh /build/chromium/src out/Release
#   DOMICILE_ENGINE_BUILD=official .github/scripts/engine-release-build.sh ...
#
# Runs inside Chromium's toolchain shell. Extra arguments are extra targets, so
# engine.yml builds its check binaries in the same build.
#
# Differs from scripts/build.sh, whose component build cannot be moved off the
# machine:
#
#   is_component_build = false  one relocatable `chrome` binary
#   is_official_build = false   by default, to skip PGO and ThinLTO in checks
#   dcheck_always_on = true     by default, so the checks run with DCHECKs
#
# DOMICILE_ENGINE_BUILD=official is the production build: PGO, ThinLTO and no
# DCHECKs. It fetches the PGO profiles first.
#
# The ozone arguments are copied from build.sh, not shared, because the
# shipped build may need platforms the development build does not.
set -u

CHROMIUM="${1:-}"
OUT="${2:-out/Release}"

if [ -z "$CHROMIUM" ]; then
  echo "usage: engine-release-build.sh <path to chromium/src> [out dir] [targets...]" >&2
  exit 1
fi

# Reject unknown values, so a typo does not publish the wrong engine.
case "${DOMICILE_ENGINE_BUILD:-checked}" in
  (checked) OFFICIAL=false; DCHECKS=true ;;
  (official) OFFICIAL=true; DCHECKS=false ;;
  (*)
    echo "DOMICILE_ENGINE_BUILD is '$DOMICILE_ENGINE_BUILD'; the builds are 'checked' and 'official'." >&2
    exit 1
    ;;
esac

HERE="$(cd "$(dirname "$0")" && pwd)"

# `gn` and `autoninja` come from depot_tools; engine-depot-tools.sh picks which.
TOOLS="$("$HERE/engine-depot-tools.sh" "$CHROMIUM")" || exit 127
echo "depot_tools: $TOOLS"
export PATH="$TOOLS:$PATH"

cd "$CHROMIUM" || exit 1

# Use a compiler cache if the machine sets one. `cc_wrapper` is part of every
# compile command, so changing it forces a full rebuild. An unusable wrapper is
# therefore an error, not skipped.
#
# The value is a stable path rather than a store path, so upgrading ccache does
# not change the commands. See cprussin/dotfiles chromium-build.nix.
CACHE_ARG=""
WRAPPER="${DOMICILE_CC_WRAPPER:-}"
if [ -n "$WRAPPER" ]; then
  # `command -v` rather than `[ -x ]`, so a bare `ccache` (the form
  # Chromium's cc_wrapper.gni documents) is accepted.
  if ! command -v "$WRAPPER" >/dev/null 2>&1; then
    echo "DOMICILE_CC_WRAPPER names $WRAPPER, which nothing here can run." >&2
    echo "Carrying on without it would be a silent rebuild of the whole of" >&2
    echo "Chromium, so this stops. Unset it to build with no cache." >&2
    exit 1
  fi
  CACHE_ARG="  cc_wrapper = \"$WRAPPER\"
"

  # Share cache hits across the /build/trees/tree-N checkouts. BASEDIR makes
  # ccache hash paths relative to the tree, and NOHASHDIR leaves the working
  # directory out of the hash. Use the physical path, since ccache compares it
  # with getcwd. Exported rather than set in ccache.conf so it works on any
  # machine.
  CCACHE_BASEDIR="$(pwd -P)"
  export CCACHE_BASEDIR
  export CCACHE_NOHASHDIR=1
fi

# Fetch the PGO profiles an official build needs: Chrome's and V8's builtins'
# (`gen/v8/embedded.S` fails without it). These are the commands DEPS runs for
# `checkout_pgo_profiles`; each does nothing if the profile is present.
if [ "$OFFICIAL" = true ]; then
  python3 tools/update_pgo_profiles.py --target=linux update \
    --gs-url-base=chromium-optimization-profiles/pgo_profiles || exit 1
  python3 v8/tools/builtins-pgo/download_profiles.py download \
    --depot-tools "$TOOLS" --check-v8-revision --quiet || exit 1
fi

# Passing --args every time makes `gn gen` reconfigure when this file changes.
#
# Adding drm does not change the default platform. With `ozone_platform` unset,
# //ui/ozone/BUILD.gn's order applies and headless stays first, so drm is used
# only with `--ozone-platform=drm`.
#
# `use_libinput` is needed for touchpads: without it, off ChromeOS, a touchpad
# falls back to `EventConverterEvdevImpl`, which ignores `EV_ABS` events.
gn gen "$OUT" --args="
  is_debug = false
  is_component_build = false
  is_official_build = $OFFICIAL
  dcheck_always_on = $DCHECKS
  symbol_level = 0
  blink_symbol_level = 0
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

# Nothing in `chrome` depends on `domicile_engine`, which the compositor
# dlopens, so it is named explicitly.
exec autoninja -C "$OUT" chrome domicile_engine "${@:3}"
