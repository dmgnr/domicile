#!/usr/bin/env bash
# Asserts that a reset and apply leave the old mtime on every file the new
# series does not change, and a new mtime on every file it does.
#
# Ninja rebuilds by mtime. Without this, a one-patch change rebuilds every file
# the series touches and everything that includes them, which takes hours.
#
# Runs the real scripts from a fixture shaped like this repository.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"

command -v git >/dev/null || { echo "  SKIP: no git"; exit 77; }

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

FAKE="$WORK/repo"
ENGINE="$FAKE/packages/domicile-engine"
mkdir -p "$FAKE/.github/scripts" "$ENGINE/scripts" "$ENGINE/patches" \
         "$ENGINE/src/components/domicile"
for script in engine-reset.sh engine-apply.sh engine-keep-mtimes.sh; do
  cp "$ROOT/.github/scripts/$script" "$FAKE/.github/scripts/"
done
cp "$ROOT/packages/domicile-engine/scripts/apply.sh" "$ENGINE/scripts/"
# Electron's Node has its own checkouts and its own test,
# test-engine-node.sh.
printf '#!/bin/sh\n' >"$FAKE/.github/scripts/engine-node.sh"
chmod +x "$FAKE/.github/scripts/engine-node.sh"
echo "// laid down" >"$ENGINE/src/components/domicile/thing.cc"

TREE="$WORK/chromium/src"
mkdir -p "$TREE"
git -C "$TREE" init -q
git -C "$TREE" config user.email upstream@example.invalid
git -C "$TREE" config user.name upstream
echo "a" >"$TREE/a.cc"
echo "b" >"$TREE/b.cc"
git -C "$TREE" add -A
git -C "$TREE" -c commit.gpgsign=false commit -qm "the pin"
PIN="$(git -C "$TREE" rev-parse HEAD)"
echo "$PIN" >"$ENGINE/CHROMIUM_PIN"

# Writes a two-patch series: one patching a.cc, one writing $1 into b.cc. In a
# clone, so the checkout under test is touched only by the scripts.
AUTHOR="$WORK/author"
git clone -q "$TREE" "$AUTHOR"
git -C "$AUTHOR" config user.email upstream@example.invalid
git -C "$AUTHOR" config user.name upstream
write_series() { # b.cc's patched line
  git -C "$AUTHOR" checkout -q "$PIN"
  echo "patched" >>"$AUTHOR/a.cc"
  git -C "$AUTHOR" -c commit.gpgsign=false commit -qam "patch a"
  echo "$1" >>"$AUTHOR/b.cc"
  git -C "$AUTHOR" -c commit.gpgsign=false commit -qam "patch b"
  rm -f "$ENGINE"/patches/*.patch
  git -C "$AUTHOR" format-patch -q -o "$ENGINE/patches" "$PIN..HEAD"
}

run() {
  "$FAKE/.github/scripts/engine-reset.sh" "$TREE" >/dev/null 2>&1 &&
    "$FAKE/.github/scripts/engine-apply.sh" "$TREE" >/dev/null 2>&1
}
mtime() { stat -c %.9Y "$TREE/$1"; }

write_series "first"
run
expect "the first run applies" 0 "$?"

# As a finished build leaves them: everything older than its outputs.
touch -d '1 hour ago' "$TREE/a.cc" "$TREE/b.cc" "$TREE/components/domicile/thing.cc"
a_before="$(mtime a.cc)"
b_before="$(mtime b.cc)"
thing_before="$(mtime components/domicile/thing.cc)"

write_series "second"
run
expect "the second run applies" 0 "$?"
expect "the patch to b.cc is in" "second" "$(tail -1 "$TREE/b.cc")"
expect "a.cc, patched the same, keeps its mtime" "$a_before" "$(mtime a.cc)"
expect "the laid-down file, unchanged, keeps its mtime" \
  "$thing_before" "$(mtime components/domicile/thing.cc)"
expect "b.cc, patched differently, gets a new mtime" newer \
  "$([ "$(mtime b.cc)" != "$b_before" ] && echo newer || echo same)"

[ "$FAILED" -eq 0 ] || { echo "$FAILED failed"; exit 1; }
echo "all ok"
