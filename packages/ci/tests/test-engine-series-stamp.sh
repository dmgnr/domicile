#!/usr/bin/env bash
# Asserts when `engine-series-stamp.sh` reports that the shared checkout
# already carries the series.
#
# `engine.yml` resets /build/chromium/src to the pin and applies `patches/`
# before each build. When the series has not changed, that rewrites every
# patched file and forces a long rebuild. The checkout records the series it
# carries, and a matching run skips the reset, apply and compile.
# `engine-sync.sh` does the same for DEPS.
#
# A false positive builds something other than the pull request and reports it
# green, so every way the tree can differ must answer `false`:
#
# - the patch series changed (a patch edited, added or removed);
# - a file under `src/` changed, or is missing from the checkout;
# - `CHROMIUM_PIN` moved;
# - HEAD moved (a manual build, or another workflow reset the tree);
# - the checkout has a tracked modification, or an untracked file that is not
#   the series'.
#
# A wrong `false` only costs a full build.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
STAMP_SH="$ROOT/.github/scripts/engine-series-stamp.sh"
[ -x "$STAMP_SH" ] || { echo "no $STAMP_SH" >&2; exit 1; }

command -v git >/dev/null || { echo "  SKIP: no git"; exit 77; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FAILED=0
ok() { printf '  ok    %s\n' "$1"; }
fail() {
  printf '  FAIL  %s\n    %s\n' "$1" "$2"
  FAILED=$((FAILED + 1))
}

# A repository like this one: the script at the path whose `../..` is the
# root, and the series it reads relative to itself.
FAKE="$WORK/repo"
mkdir -p "$FAKE/.github/scripts" \
         "$FAKE/packages/domicile-engine/patches" \
         "$FAKE/packages/domicile-engine/src/components/domicile"
cp "$STAMP_SH" "$FAKE/.github/scripts/"

TREE="$WORK/chromium/src"
mkdir -p "$TREE"
git -C "$TREE" init -q
git -C "$TREE" config user.email ci@domicile.invalid
git -C "$TREE" config user.name "domicile CI"
echo "upstream" >"$TREE/upstream.cc"
git -C "$TREE" add -A
git -C "$TREE" commit -qm "upstream"
PIN="$(git -C "$TREE" rev-parse HEAD)"

{ echo "# what the series is against"; echo "$PIN"; } \
  >"$FAKE/packages/domicile-engine/CHROMIUM_PIN"
echo "a patch" >"$FAKE/packages/domicile-engine/patches/0001-first.patch"
echo "laid down" >"$FAKE/packages/domicile-engine/src/components/domicile/thing.cc"

export DOMICILE_SERIES_STAMP="$WORK/.domicile-series-stamp"

# What a successful `apply.sh` leaves: a commit over the pin for the patch,
# and the `src/` files copied in untracked. Built by hand, since the script
# reads only the result.
apply_series() {
  cp "$FAKE/packages/domicile-engine/src/components/domicile/thing.cc" \
     "$TREE/components/domicile/thing.cc" 2>/dev/null || {
    mkdir -p "$TREE/components/domicile"
    cp "$FAKE/packages/domicile-engine/src/components/domicile/thing.cc" \
       "$TREE/components/domicile/thing.cc"
  }
  echo "patched" >>"$TREE/upstream.cc"
  git -C "$TREE" add upstream.cc
  git -C "$TREE" commit -qm "domicile: the series"
}
reset_series() {
  git -C "$TREE" reset -q --hard "$PIN"
  rm -rf "$TREE/components"
}

stamp() { "$FAKE/.github/scripts/engine-series-stamp.sh" "$@" 2>&1; }

# Reads the answer from $GITHUB_OUTPUT, which decides the workflow step's
# `if:`, not from stdout.
carries() {
  local out
  out="$WORK/gh-output"
  : >"$out"
  GITHUB_OUTPUT="$out" "$FAKE/.github/scripts/engine-series-stamp.sh" \
    carries "$TREE" >"$WORK/last-said" 2>&1
  sed -n 's/^carries=//p' "$out" | head -1
}
said() { cat "$WORK/last-said"; }

expect() { # what, want, got
  if [ "$3" = "$2" ]; then ok "$1"; else
    fail "$1" "wanted: $2
    got:    $3"
  fi
}
contains() { # what, needle, haystack
  case "$3" in
    (*"$2"*) ok "$1" ;;
    (*) fail "$1" "expected to mention: $2
    said: $3" ;;
  esac
}

expect_carries() { # what, want
  local got
  got="$(carries)"
  if [ "$got" = "$2" ]; then ok "$1"; else
    fail "$1" "wanted carries=$2, got carries=${got:-<nothing>}
    it said: $(said)"
  fi
}

# --- nothing written down yet ------------------------------------------------

apply_series
expect_carries "a checkout with no stamp beside it is not trusted" false

# --- recorded, and untouched -------------------------------------------------

stamp record "$TREE" >/dev/null
expect_carries "a checkout carrying exactly the recorded series is taken" true

# --- the series moved --------------------------------------------------------

echo "a second patch" >"$FAKE/packages/domicile-engine/patches/0002-second.patch"
expect_carries "a patch added to the series is not what the checkout carries" false
rm "$FAKE/packages/domicile-engine/patches/0002-second.patch"
expect_carries "and removing it again brings it back" true

echo "edited" >>"$FAKE/packages/domicile-engine/patches/0001-first.patch"
expect_carries "a patch edited in place is not what the checkout carries" false
echo "a patch" >"$FAKE/packages/domicile-engine/patches/0001-first.patch"
expect_carries "and putting it back brings it back" true

echo "different" \
  >"$FAKE/packages/domicile-engine/src/components/domicile/thing.cc"
expect_carries "a src/ file edited in the repository is not what the checkout carries" false
echo "laid down" \
  >"$FAKE/packages/domicile-engine/src/components/domicile/thing.cc"
expect_carries "and putting it back brings it back" true

# --- the pin moved -----------------------------------------------------------

{ echo "# what the series is against"; echo "0000000000000000000000000000000000000000"; } \
  >"$FAKE/packages/domicile-engine/CHROMIUM_PIN"
expect_carries "a repin is not what the checkout carries" false
{ echo "# what the series is against"; echo "$PIN"; } \
  >"$FAKE/packages/domicile-engine/CHROMIUM_PIN"
expect_carries "and putting the pin back brings it back" true

# --- the checkout moved ------------------------------------------------------

# The stamp alone cannot see this. `engine-release.yml` and
# `engine-drm-probe.yml` reset the same tree, and people build in it on
# `crux`. The stamp would still name this series, but HEAD would differ.
git -C "$TREE" commit -q --allow-empty -m "somebody else was here"
expect_carries "a checkout whose HEAD moved is not trusted" false
git -C "$TREE" reset -q --hard HEAD~1
expect_carries "and going back to the recorded commit brings it back" true

echo "somebody's work in progress" >"$TREE/upstream.cc"
expect_carries "a tracked file modified in the checkout is not trusted" false
git -C "$TREE" checkout -q -- upstream.cc
expect_carries "and restoring it brings it back" true

echo "left behind" >"$TREE/stray.cc"
expect_carries "an untracked file that is not the series' is not trusted" false
rm "$TREE/stray.cc"
expect_carries "and removing it brings it back" true

# A series file missing from the checkout. It is untracked, so `git status`
# does not report it; only a file-by-file comparison does.
rm "$TREE/components/domicile/thing.cc"
expect_carries "a series file missing from the checkout is not trusted" false
cp "$FAKE/packages/domicile-engine/src/components/domicile/thing.cc" \
   "$TREE/components/domicile/thing.cc"
expect_carries "and putting it back brings it back" true

echo "tampered" >"$TREE/components/domicile/thing.cc"
expect_carries "a series file changed in the checkout is not trusted" false
cp "$FAKE/packages/domicile-engine/src/components/domicile/thing.cc" \
   "$TREE/components/domicile/thing.cc"
expect_carries "and restoring it brings it back" true

# --- a repository this cannot read ------------------------------------------

# A missing `CHROMIUM_PIN` must answer `false`, not fail. `engine-reset.sh`
# runs next and reports the problem with a better diagnostic.
mv "$FAKE/packages/domicile-engine/CHROMIUM_PIN" "$WORK/pin-elsewhere"
expect_carries "a checkout with no CHROMIUM_PIN is not trusted" false
# Read stdout only. On the combined stream, a leaked `grep` "No such file or
# directory" would also pass.
case "$(sed -n '/^the checkout does not carry/p' "$WORK/last-said")" in
  (*CHROMIUM_PIN*) ok "and it says which file it could not read" ;;
  (*) fail "and it says which file it could not read" "it said: $(said)" ;;
esac
mv "$WORK/pin-elsewhere" "$FAKE/packages/domicile-engine/CHROMIUM_PIN"
expect_carries "and putting it back brings it back" true

# --- the tools this is allowed to assume ------------------------------------

# The runner has coreutils but not diffutils, so `cmp` is missing. A missing
# tool exits 127 and a differing file exits 1; treating both as "differs" makes
# a missing tool look like a tampered checkout, and `carries` would answer
# `false` forever.
#
# A stub `cmp` that exits 127 shadows the real one, and the answers must not
# change.
NOCMP="$WORK/no-cmp"
mkdir -p "$NOCMP"
printf '#!/bin/sh\nexit 127\n' >"$NOCMP/cmp"
chmod +x "$NOCMP/cmp"
PATH="$NOCMP:$PATH"

expect_carries "a checkout carrying the series is taken without cmp on PATH" true

echo "different in the checkout" >"$TREE/components/domicile/thing.cc"
expect_carries "and a file that really differs is still caught without cmp" false
cp "$FAKE/packages/domicile-engine/src/components/domicile/thing.cc" \
   "$TREE/components/domicile/thing.cc"
expect_carries "and restoring it brings it back" true

out="$(stamp record "$TREE")" && status=0 || status=$?
expect "recording works without cmp on PATH" 0 "$status"

# --- recording refuses to write down a tree it cannot vouch for --------------

# `record` runs right after the apply step. If the tree is not what the apply
# left, writing the stamp would cause a false positive on the next run.
reset_series
out="$(stamp record "$TREE")" && status=0 || status=$?

# It refuses to write but does not fail the job. Skipping the stamp already
# prevents the false positive; failing would also skip the build and its
# guards.
expect "refusing to record does not fail the run" 0 "$status"
contains "and it says so loudly anyway" "::warning::" "$out"
expect_carries "and nothing it wrote can make the next run skip" false

# The series identity. `engine-release-publish.sh` tags releases with it, so
# commits that do not change the fork share an engine and need no repin. It
# comes from this script so the tag and the stamp cannot disagree on "the same
# series".
out="$(stamp identity)"
expect "the identity is a sha256, and nothing else on the line" ok \
  "$(printf '%s' "$out" | grep -qE '^[0-9a-f]{64}$' && echo ok || echo "said: $out")"

# It depends only on the repository, so a job on `ubuntu-latest` can compute
# it without /build.
expect "it needs no checkout to answer" "$out" "$(stamp identity)"

# Moving the pin or a patch must change the identity.
cp "$FAKE/packages/domicile-engine/CHROMIUM_PIN" "$WORK/pin.bak"
echo "0000000000000000000000000000000000000000" \
  >"$FAKE/packages/domicile-engine/CHROMIUM_PIN"
expect "moving the pin is a different series" ok \
  "$([ "$(stamp identity)" != "$out" ] && echo ok || echo "it did not move")"
cp "$WORK/pin.bak" "$FAKE/packages/domicile-engine/CHROMIUM_PIN"
expect "and putting it back is the same series again" "$out" "$(stamp identity)"

echo "another patch" >"$FAKE/packages/domicile-engine/patches/0002-second.patch"
expect "adding a patch is a different series" ok \
  "$([ "$(stamp identity)" != "$out" ] && echo ok || echo "it did not move")"
rm -f "$FAKE/packages/domicile-engine/patches/0002-second.patch"

# `src/` is copied, not applied, so a change there causes no patch failure. An
# identity that ignored it would publish the old engine under the new series'
# tag.
echo "edited" >>"$FAKE/packages/domicile-engine/src/components/domicile/thing.cc"
expect "editing a laid-down file is a different series" ok \
  "$([ "$(stamp identity)" != "$out" ] && echo ok || echo "it did not move")"

# Electron's Node and its patches go in after the apply, and the build reads
# them like the series.
mkdir -p "$FAKE/packages/domicile-engine/node/patches/node"
echo "a node patch" >"$FAKE/packages/domicile-engine/node/patches/node/a.patch"
expect "changing Electron's Node patches is a different series" ok \
  "$([ "$(stamp identity)" != "$out" ] && echo ok || echo "it did not move")"
rm -rf "$FAKE/packages/domicile-engine/node"

if [ "$FAILED" -gt 0 ]; then
  echo "$FAILED failed"
  exit 1
fi
echo "all ok"
