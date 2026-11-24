#!/usr/bin/env bash
# Package a runnable engine from a build directory.
#
#   .github/scripts/engine-release-package.sh /build/chromium/src out/Release /build/engine-release
#
# Writes <stage>/<name>.tar.zst and its .sha256, and sets `tarball` on
# $GITHUB_OUTPUT when there is one.
#
# A missing runtime file fails late on the user's machine, not at startup. So
# REQUIRED files stop the release if absent, and OPTIONAL files, which depend
# on build arguments, are copied when present. The workflow then runs the
# pixel guard against the unpacked tarball.
set -euo pipefail

CHROMIUM="${1:-}"
OUT="${2:-out/Release}"
STAGE="${3:-/build/engine-release}"

if [ -z "$CHROMIUM" ]; then
  echo "usage: engine-release-package.sh <chromium/src> [out dir] [stage dir]" >&2
  exit 1
fi

BUILD="$CHROMIUM/$OUT"
[ -d "$BUILD" ] || { echo "no build directory at $BUILD" >&2; exit 1; }

# The flavor, from the args the build used (see engine-release-build.sh). It
# must match DOMICILE_ENGINE_BUILD, which picks the release tag.
[ -f "$BUILD/args.gn" ] || {
  echo "::error::no $BUILD/args.gn, so the build's flavor is unknown" >&2
  exit 1
}
gn_arg() { sed -n "s/^ *$1 *= *\(true\|false\) *\$/\1/p" "$BUILD/args.gn"; }
OFFICIAL="$(gn_arg is_official_build)"
DCHECKS="$(gn_arg dcheck_always_on)"
case "$OFFICIAL/$DCHECKS" in
  (false/true) FLAVOR=checked ;;
  (true/false) FLAVOR=official ;;
  (*)
    echo "::error::$BUILD/args.gn has is_official_build '$OFFICIAL' and dcheck_always_on '$DCHECKS'; neither the checked nor the official build" >&2
    exit 1
    ;;
esac
if [ "$FLAVOR" != "${DOMICILE_ENGINE_BUILD:-checked}" ]; then
  echo "::error::$BUILD is the $FLAVOR build, but DOMICILE_ENGINE_BUILD is '${DOMICILE_ENGINE_BUILD:-checked}'" >&2
  exit 1
fi

# The engine cannot start or draw text without these.
REQUIRED=(
  chrome
  icudtl.dat
  resources.pak
  chrome_100_percent.pak
  libdomicile_engine.so
)

# Depend on build arguments; the browser degrades without them.
#
#   chrome_200_percent.pak    HiDPI art
#   v8_context_snapshot.bin   one of these two, depending on the v8 arguments
#   snapshot_blob.bin
#   chrome_crashpad_handler   crash reports
#   libEGL/libGLESv2          ANGLE
#   libvulkan/libvk_swiftshader/vk_swiftshader_icd.json  software rendering
OPTIONAL=(
  chrome_200_percent.pak
  v8_context_snapshot.bin
  snapshot_blob.bin
  chrome_crashpad_handler
  libEGL.so
  libGLESv2.so
  libvulkan.so.1
  libvk_swiftshader.so
  vk_swiftshader_icd.json
)

REV="$(git rev-parse --short HEAD)"
PIN="$(grep -v '^#' "$(dirname "$0")/../../packages/domicile-engine/CHROMIUM_PIN" | tr -d '[:space:]')"

# Named after the series, like the release tag (see engine-release-publish.sh),
# using the same twelve characters. engine-series-stamp.sh computes it so the
# tag, filename and rebuild check always agree.
IDENTITY="$("$(dirname "$0")/engine-series-stamp.sh" identity)"
NAME="domicile-engine-s${IDENTITY:0:12}-linux-x64"

rm -rf "$STAGE/$NAME"
mkdir -p "$STAGE/$NAME"

missing=()
for file in "${REQUIRED[@]}"; do
  if [ -e "$BUILD/$file" ]; then
    cp -a "$BUILD/$file" "$STAGE/$NAME/"
  else
    missing+=("$file")
  fi
done
if [ ${#missing[@]} -gt 0 ]; then
  echo "::error::the build produced no ${missing[*]}; this is not a runnable engine" >&2
  exit 1
fi

for file in "${OPTIONAL[@]}"; do
  [ -e "$BUILD/$file" ] && cp -a "$BUILD/$file" "$STAGE/$NAME/"
done

# Required: without locales the browser shows no text. A directory, so not in
# REQUIRED. Only the `.pak`s: the build's `.pak.info` beside them are build
# metadata (70.9 MB).
[ -d "$BUILD/locales" ] || {
  echo "::error::the build produced no locales/; the browser would start with no text" >&2
  exit 1
}
mkdir "$STAGE/$NAME/locales"
cp -a "$BUILD"/locales/*.pak "$STAGE/$NAME/locales/"

# Required: the Hunspell dictionaries the engine checks spelling with, which it
# never downloads (patch 0246). The build's `domicile_dictionaries` target
# copies them.
ls "$BUILD"/dictionaries/*.bdic >/dev/null 2>&1 || {
  echo "::error::the build produced no dictionaries/*.bdic; the engine would check no spelling" >&2
  exit 1
}
mkdir "$STAGE/$NAME/dictionaries"
cp -a "$BUILD"/dictionaries/*.bdic "$STAGE/$NAME/dictionaries/"

# Strip every ELF: `chrome`'s symbol table alone is 248.5 MB. The dynamic
# symbols that `dlsym` reads stay. The build directory keeps its symbols, for
# the measurements in docs/architecture/ENGINE-FORK-MEASUREMENTS.md.
OBJCOPY="$CHROMIUM/third_party/llvm-build/Release+Asserts/bin/llvm-objcopy"
[ -x "$OBJCOPY" ] || {
  echo "::error::no $OBJCOPY to strip the engine with" >&2
  exit 1
}
for file in "$STAGE/$NAME"/*; do
  if [ -f "$file" ] && [ "$(od -An -tx1 -N4 "$file")" = ' 7f 45 4c 46' ]; then
    "$OBJCOPY" --strip-all "$file"
  fi
done

# Record provenance inside the tarball.
cat > "$STAGE/$NAME/PROVENANCE" <<PROV
domicile engine, packaged on $(uname -n)
series identity: $IDENTITY
domicile commit: $(git rev-parse HEAD)
chromium pin:    $PIN
built:           $(date -u +%Y-%m-%dT%H:%M:%SZ)
build:           $FLAVOR (is_official_build = $OFFICIAL, dcheck_always_on = $DCHECKS)
gn args:         see .github/scripts/engine-release-build.sh at the commit above

libdomicile_engine.so is dlopened by domicile-compositor by name, so this
directory has to be on its LD_LIBRARY_PATH.
PROV

cd "$STAGE"
# zstd compresses this mostly binary payload better than gzip.
tar --zstd -cf "$NAME.tar.zst" "$NAME"
sha256sum "$NAME.tar.zst" > "$NAME.tar.zst.sha256"
rm -rf "$STAGE/$NAME"

echo "packaged $NAME.tar.zst ($(du -h "$NAME.tar.zst" | cut -f1))"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "tarball=$NAME.tar.zst" >> "$GITHUB_OUTPUT"
fi
