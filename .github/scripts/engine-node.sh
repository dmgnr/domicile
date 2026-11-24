#!/usr/bin/env bash
# Put Electron's Node into the Chromium checkout, where Electron's DEPS puts
# it, with Electron's patches over it and over the deps Node builds against.
#
#   .github/scripts/engine-node.sh <path to chromium/src>
#
# Runs after `apply.sh`. Each is a checkout of its own, patched by `git am` in
# the order its `.patches` gives:
#
#   third_party/electron_node    at the commit `node/NODE_PIN` names, with
#                                `node/patches/node`. Electron's
#                                `build_add_gn_build_files.patch` gives it the
#                                GN files the engine's build reads.
#   v8                           at the pin's commit, with `node/patches/v8`:
#                                the builtins and snapshot fixes Node's
#                                promise hooks and startup snapshot need.
#   third_party/boringssl/src    at the pin's commit, with
#                                `node/patches/boringssl`: the digests and
#                                ciphers Node's crypto offers.
#
# See "Phase 2" in docs/architecture/ELECTRON-APPS.md.
#
# The Chromium checkout must not see any of this: `apply.sh` refuses a dirty
# tree, and the series stamp counts only the series' own files. So Node's
# directory goes in `.git/info/exclude`, and git status ignores V8's and
# BoringSSL's commits (`submodule.<path>.ignore`). Their base is always the
# commit the pin records, so a sync that moved them, or a repin, is caught
# here.
#
# A stamp in each checkout's own `.git` names what it carries, so a warm run
# does nothing and keeps the mtimes ninja reads. Anything else starts that
# checkout again from its base.
set -euo pipefail

CHROMIUM="${1:-}"
[ -n "$CHROMIUM" ] || {
  echo "usage: engine-node.sh <path to chromium/src>" >&2
  exit 2
}

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NODE_DIR="$ROOT/packages/domicile-engine/node"

field() { grep -v '^#' "$NODE_DIR/NODE_PIN" | sed -n "s/^$1 //p" | tr -d '[:space:]'; }

# patch <series> <path in the checkout> <base commit> [<url to fetch it from>]
patch_checkout() {
  local series="$NODE_DIR/patches/$1" path="$2" base="$3" url="${4:-}"
  local repo="$CHROMIUM/$path" identity stamp patch count=0
  [ -f "$series/.patches" ] || {
    echo "::error::$series/.patches, the order Electron applies these patches in, is missing" >&2
    exit 1
  }
  identity="$({
    printf 'base %s\n' "$base"
    while IFS= read -r patch; do
      [ -n "$patch" ] || continue
      printf '%s ' "$patch"
      sha256sum <"$series/$patch" | cut -d' ' -f1
    done <"$series/.patches"
  } | sha256sum | cut -d' ' -f1)"

  if [ -z "$url" ] && [ ! -e "$repo/.git" ]; then
    echo "::error::$path is not checked out, so its patches have nothing to go on; run engine-sync.sh first" >&2
    exit 1
  fi
  [ -e "$repo/.git" ] || {
    rm -rf "$repo"
    git init -q "$repo"
  }
  stamp="$(git -C "$repo" rev-parse --absolute-git-dir)/domicile-node-stamp"
  if [ -f "$stamp" ] &&
    [ "$(sed -n 1p "$stamp")" = "$identity" ] &&
    [ "$(sed -n 2p "$stamp")" = "$(git -C "$repo" rev-parse HEAD 2>/dev/null)" ] &&
    [ -z "$(git -C "$repo" status --porcelain)" ]; then
    echo "$path already carries $1's patches over $base"
    return 0
  fi

  rm -f "$stamp"
  git -C "$repo" config user.name "domicile CI"
  git -C "$repo" config user.email "ci@domicile.invalid"
  git -C "$repo" am --abort >/dev/null 2>&1 || true
  if ! git -C "$repo" cat-file -e "$base^{commit}" 2>/dev/null; then
    [ -n "$url" ] || {
      echo "::error::$path does not have $base, the commit the pin records; run engine-sync.sh first" >&2
      exit 1
    }
    git -C "$repo" fetch -q --depth 1 "$url" "$base"
  fi
  git -C "$repo" checkout -q --force --detach "$base"
  git -C "$repo" clean -qfdx

  while IFS= read -r patch; do
    [ -n "$patch" ] || continue
    # `--keep-cr`: some of Node's files have CRLF line ends the patches keep.
    git -C "$repo" am -q --keep-cr --3way "$series/$patch" || {
      git -C "$repo" am --abort >/dev/null 2>&1 || true
      echo "::error::Electron's $1 patch $patch does not apply over $base" >&2
      exit 1
    }
    count=$((count + 1))
  done <"$series/.patches"

  printf '%s\n%s\n' "$identity" "$(git -C "$repo" rev-parse HEAD)" >"$stamp"
  echo "$path: $base with $count of Electron's patches"
}

url="$(field url)"
commit="$(field commit)"
[ -n "$url" ] && [ -n "$commit" ] || {
  echo "::error::$NODE_DIR/NODE_PIN must name a url and a commit" >&2
  exit 1
}

exclude="$(git -C "$CHROMIUM" rev-parse --absolute-git-dir)/info/exclude"
mkdir -p "$(dirname "$exclude")"
grep -Fxq /third_party/electron_node/ "$exclude" 2>/dev/null ||
  echo /third_party/electron_node/ >>"$exclude"

for dep in v8:v8 boringssl:third_party/boringssl/src; do
  series="${dep%%:*}" path="${dep#*:}"
  base="$(git -C "$CHROMIUM" rev-parse "HEAD:$path" 2>/dev/null)" || {
    echo "::error::the pin records no $path, which Electron's $series patches go on" >&2
    exit 1
  }
  git -C "$CHROMIUM" config "submodule.$path.ignore" all
  patch_checkout "$series" "$path" "$base"
done
patch_checkout node third_party/electron_node "$commit" "$url"
