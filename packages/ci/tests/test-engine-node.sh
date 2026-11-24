#!/usr/bin/env bash
# Asserts `engine-node.sh` puts Electron's Node at
# `third_party/electron_node` in the checkout, as Electron's DEPS does, with
# Electron's patches applied in their order, and Electron's V8 and BoringSSL
# patches over the pin's.
#
# - **At the pin, patched.** The commit `node/NODE_PIN` names, then every
#   patch `node/patches/node/.patches` lists.
# - **V8 and BoringSSL go on the commits the pin records.**
# - **The Chromium tree stays clean.** `apply.sh` refuses a dirty tree, and
#   Node is a checkout of its own.
# - **Warm runs do nothing.** A stamp in Node's own `.git` names what is
#   there.
# - **A changed patch starts again from the pin**, never on top of the old
#   series.
# - **A patch that doesn't apply fails the run** and leaves no stamp.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
NODE_SH="$ROOT/.github/scripts/engine-node.sh"
[ -x "$NODE_SH" ] || { echo "no $NODE_SH" >&2; exit 1; }
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
gitq() { git -c user.email=t@example.invalid -c user.name=t "$@"; }

# Node upstream: a tagged release, then a later commit the pin is not at.
UPSTREAM="$WORK/node"
mkdir -p "$UPSTREAM"
gitq -C "$UPSTREAM" init -q
printf 'v26\n' >"$UPSTREAM/version"
gitq -C "$UPSTREAM" add -A && gitq -C "$UPSTREAM" commit -qm release
pinned="$(git -C "$UPSTREAM" rev-parse HEAD)"
printf 'later\n' >"$UPSTREAM/version"
gitq -C "$UPSTREAM" commit -qam later

# Electron's patches: two, made against the pin.
SCRATCH="$WORK/scratch"
git clone -q "$UPSTREAM" "$SCRATCH"
git -C "$SCRATCH" checkout -q "$pinned"
printf 'gn\n' >"$SCRATCH/BUILD.gn"
gitq -C "$SCRATCH" add -A && gitq -C "$SCRATCH" commit -qm "build: add GN build files"
printf 'v26 embedded\n' >"$SCRATCH/version"
gitq -C "$SCRATCH" commit -qam "embed"

FAKE="$WORK/repo"
P="$FAKE/packages/domicile-engine/node/patches"
mkdir -p "$FAKE/.github/scripts" "$P/node" "$P/v8" "$P/boringssl"
cp "$NODE_SH" "$FAKE/.github/scripts/"
write_patches() {
  rm -f "$P/node/"*
  git -C "$SCRATCH" format-patch -q -o "$P/node" "$pinned..HEAD"
  (cd "$P/node" && ls ./*.patch | sed 's|^\./||' >.patches)
}
write_patches
cat >"$FAKE/packages/domicile-engine/node/NODE_PIN" <<PIN
# Electron's Node, as its DEPS names it.
url file://$UPSTREAM
commit $pinned
PIN

# A dep the pin records as a gitlink, with one patch of Electron's.
# dep <series> <path>
TREE="$WORK/chromium/src"
mkdir -p "$TREE/third_party"
gitq -C "$TREE" init -q
printf 'chromium\n' >"$TREE/DEPS"
dep() {
  local repo="$TREE/$2"
  mkdir -p "$repo"
  gitq -C "$repo" init -q
  printf '%s\n' "$1" >"$repo/file"
  gitq -C "$repo" add -A && gitq -C "$repo" commit -qm "$1"
  git -C "$TREE" update-index --add --cacheinfo "160000,$(git -C "$repo" rev-parse HEAD),$2"
  printf '[submodule "%s"]\n\tpath = %s\n\turl = https://example.invalid/%s\n' "$2" "$2" "$1" >>"$TREE/.gitmodules"
  gitq -C "$repo" checkout -q -b electron
  printf '%s patched\n' "$1" >"$repo/file"
  gitq -C "$repo" commit -qam "$1 for Node"
  git -C "$repo" format-patch -q -o "$P/$1" HEAD~1
  (cd "$P/$1" && ls ./*.patch | sed 's|^\./||' >.patches)
  gitq -C "$repo" checkout -q --detach HEAD~1
}
dep v8 v8
dep boringssl third_party/boringssl/src
gitq -C "$TREE" add DEPS .gitmodules && gitq -C "$TREE" commit -qm pin

out="$("$FAKE/.github/scripts/engine-node.sh" "$TREE" 2>&1)"
expect "the first run succeeds" 0 $?
NODE="$TREE/third_party/electron_node"
expect "Node is at the pin with Electron's patches" "v26 embedded" "$(cat "$NODE/version" 2>/dev/null)"
expect "every patch is applied" 2 "$(git -C "$NODE" rev-list --count "$pinned..HEAD" 2>/dev/null)"
expect "V8 carries Electron's patch" "v8 patched" "$(cat "$TREE/v8/file")"
expect "BoringSSL carries Electron's patch" "boringssl patched" "$(cat "$TREE/third_party/boringssl/src/file")"
expect "the Chromium tree stays clean" "" "$(git -C "$TREE" status --porcelain)"

out="$("$FAKE/.github/scripts/engine-node.sh" "$TREE" 2>&1)"
case "$out" in
  (*" with "*) printf '  FAIL  a warm run does nothing\n    said: %s\n' "$out"; FAILED=$((FAILED + 1)) ;;
  (*"already"*) printf '  ok    a warm run does nothing\n' ;;
  (*) printf '  FAIL  a warm run does nothing\n    said: %s\n' "$out"; FAILED=$((FAILED + 1)) ;;
esac

# Drop the second patch: the series starts again from the pin.
git -C "$SCRATCH" reset -q --hard HEAD~1
write_patches
"$FAKE/.github/scripts/engine-node.sh" "$TREE" >/dev/null 2>&1
expect "a changed series starts again from the pin" "v26" "$(cat "$NODE/version")"
expect "with only its own patches" 1 "$(git -C "$NODE" rev-list --count "$pinned..HEAD")"

# A sync that moved V8 back to the pin's commit: its patch goes on again.
git -C "$TREE/v8" checkout -q --detach "$(git -C "$TREE" rev-parse HEAD:v8)"
"$FAKE/.github/scripts/engine-node.sh" "$TREE" >/dev/null 2>&1
expect "a V8 moved back to the pin is patched again" "v8 patched" "$(cat "$TREE/v8/file")"

# A patch against something else.
printf 'From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001\nFrom: t <t@example.invalid>\nSubject: [PATCH] broken\n\n---\n version | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n\ndiff --git a/version b/version\n--- a/version\n+++ b/version\n@@ -1 +1 @@\n-nothing like this\n+broken\n' \
  >"$P/node/zz-broken.patch"
echo zz-broken.patch >>"$P/node/.patches"
"$FAKE/.github/scripts/engine-node.sh" "$TREE" >/dev/null 2>&1
expect "a patch that doesn't apply fails the run" 1 $?
out="$("$FAKE/.github/scripts/engine-node.sh" "$TREE" 2>&1)"
case "$out" in
  (*"electron_node already"*) printf '  FAIL  a failed run leaves no stamp\n'; FAILED=$((FAILED + 1)) ;;
  (*) printf '  ok    a failed run leaves no stamp\n' ;;
esac

[ "$FAILED" -eq 0 ]
