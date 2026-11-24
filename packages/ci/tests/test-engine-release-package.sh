#!/usr/bin/env bash
# Asserts that a packaged engine says which build it is and ships only what
# runs.
#
# The checked build runs DCHECKs and the official one does not. The tarball is
# the only thing an integrator has, so it has to say which one it holds. The
# flavor comes from the build's own `args.gn`, and packaging stops when that
# is missing, unrecognized, or disagrees with `DOMICILE_ENGINE_BUILD`, which
# picks the release tag.
#
# What ships: `locales/*.pak` without the build's `*.pak.info`, the spelling
# dictionaries, and every ELF without its symbol table. The build directory keeps both, for the
# measurements in docs/architecture/ENGINE-FORK-MEASUREMENTS.md.
#
# The build directory is faked with empty files and one small ELF, `zstd` with
# `cat`, and Chromium's `llvm-objcopy` with binutils' `objcopy`.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
PACKAGE="$ROOT/.github/scripts/engine-release-package.sh"
[ -x "$PACKAGE" ] || { echo "no $PACKAGE" >&2; exit 1; }

# `check-runner` reads the skip reason from a `SKIP:` line on stdout.
for tool in cc objcopy readelf; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "SKIP: no $tool, which the fake build's ELF needs"
    exit 77
  }
done

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

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

BIN="$WORK/bin"
mkdir -p "$BIN"
printf '#!/bin/sh\nexec cat\n' >"$BIN/zstd"
chmod +x "$BIN/zstd"

CHROMIUM="$WORK/chromium"
OUT="out/Release"
BUILD="$CHROMIUM/$OUT"

# An executable with a symbol table, to stand in for `chrome` and the
# libraries.
printf 'int domicile_symbol(void) { return 0; }\nint main(void) { return domicile_symbol(); }\n' \
  >"$WORK/elf.c"
cc -o "$WORK/elf" "$WORK/elf.c"

fake_build() { # args.gn contents, or empty for none
  rm -rf "$CHROMIUM"
  mkdir -p "$BUILD/locales"
  mkdir -p "$BUILD/dictionaries"
  for file in icudtl.dat resources.pak chrome_100_percent.pak \
              locales/en-US.pak locales/en-US.pak.info \
              dictionaries/en-US-10-1.bdic; do
    : >"$BUILD/$file"
  done
  printf '\0\1\2\3' >"$BUILD/icudtl.dat"
  cp "$WORK/elf" "$BUILD/chrome"
  cp "$WORK/elf" "$BUILD/libdomicile_engine.so"
  local llvm="$CHROMIUM/third_party/llvm-build/Release+Asserts/bin"
  mkdir -p "$llvm"
  printf '#!/bin/sh\nexec objcopy "$@"\n' >"$llvm/llvm-objcopy"
  chmod +x "$llvm/llvm-objcopy"
  if [ -n "$1" ]; then
    printf '%s\n' "$1" >"$BUILD/args.gn"
  fi
}

gn_args() { # is_official_build, dcheck_always_on
  printf '  is_debug = false\n  is_official_build = %s\n  dcheck_always_on = %s\n' "$1" "$2"
}

# Prints the packaged PROVENANCE's build line, or `failed` if packaging failed.
package() { # extra env assignments...
  local stage="$WORK/stage" tarball
  rm -rf "$stage"
  if ( cd "$ROOT" && env "$@" PATH="$BIN:$PATH" GITHUB_OUTPUT= \
         "$PACKAGE" "$CHROMIUM" "$OUT" "$stage" ) >"$WORK/said" 2>"$WORK/errors"; then
    tarball="$(ls "$stage"/*.tar.zst)"
    PATH="$BIN:$PATH" tar --zstd -xOf "$tarball" --wildcards '*/PROVENANCE' |
      sed -n 's/^build: *//p'
  else
    echo failed
  fi
}

echo "== the build says which flavor it is =="

fake_build "$(gn_args false true)"
expect "a checked build says so" \
  "checked (is_official_build = false, dcheck_always_on = true)" \
  "$(package -u DOMICILE_ENGINE_BUILD)"

fake_build "$(gn_args true false)"
expect "an official build says so" \
  "official (is_official_build = true, dcheck_always_on = false)" \
  "$(package DOMICILE_ENGINE_BUILD=official)"

echo
echo "== packaging stops when the flavor is in doubt =="

fake_build ""
expect "a build with no args.gn" failed "$(package -u DOMICILE_ENGINE_BUILD)"

fake_build "$(gn_args true true)"
expect "a build that is neither flavor" failed \
  "$(package DOMICILE_ENGINE_BUILD=official)"

# The publisher tags by DOMICILE_ENGINE_BUILD, so a mismatch would publish a
# checked engine under an official tag.
fake_build "$(gn_args false true)"
expect "a checked build packaged as official" failed \
  "$(package DOMICILE_ENGINE_BUILD=official)"

echo
echo "== the tarball ships only what runs =="

# Unpacks the last packaged tarball into $WORK/unpacked.
unpack() {
  rm -rf "$WORK/unpacked"
  mkdir -p "$WORK/unpacked"
  PATH="$BIN:$PATH" tar --zstd -xf "$(ls "$WORK/stage"/*.tar.zst)" \
    -C "$WORK/unpacked" --strip-components=1
}

# `stripped` when the ELF has no `.symtab`, else `symbols`.
symbols() { # file
  if readelf -S "$1" | grep -q '\.symtab'; then echo symbols; else echo stripped; fi
}

fake_build "$(gn_args true false)"
package DOMICILE_ENGINE_BUILD=official >/dev/null
unpack
expect "packaging emits no diagnostics" "" "$(cat "$WORK/errors")"
expect "provenance names the packaging host" \
  "domicile engine, packaged on $(uname -n)" \
  "$(head -n 1 "$WORK/unpacked/PROVENANCE")"
expect "the locales' paks ship" yes \
  "$([ -f "$WORK/unpacked/locales/en-US.pak" ] && echo yes || echo no)"
expect "the locales' .pak.info stay behind" no \
  "$([ -e "$WORK/unpacked/locales/en-US.pak.info" ] && echo yes || echo no)"
expect "the spelling dictionaries ship" yes \
  "$([ -f "$WORK/unpacked/dictionaries/en-US-10-1.bdic" ] && echo yes || echo no)"
expect "chrome ships stripped" stripped "$(symbols "$WORK/unpacked/chrome")"
expect "a library ships stripped" stripped \
  "$(symbols "$WORK/unpacked/libdomicile_engine.so")"
expect "the build's chrome keeps its symbols" symbols "$(symbols "$BUILD/chrome")"

echo
echo "== packaging stops without what the engine needs =="

fake_build "$(gn_args true false)"
rm -rf "$BUILD/dictionaries"
expect "a build with no spelling dictionaries" failed \
  "$(package DOMICILE_ENGINE_BUILD=official)"

echo
if [ "$FAILED" -eq 0 ]; then
  echo "engine-release-package: all cases passed"
else
  echo "engine-release-package: $FAILED case(s) failed"
fi
exit "$FAILED"
