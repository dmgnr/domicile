#!/usr/bin/env bash
# engine-reset.sh puts back the deps a Node-in-the-engine branch patches (v8
# and BoringSSL) when it runs for a branch without Node: their checkouts carry
# Electron's commits over the pin's and `submodule.<path>.ignore all` hides
# that from git status, so without this a release links V8 against BoringSSL
# headers that name RIPEMD160 it doesn't build. A branch with Node leaves them
# to engine-node.sh, which keeps them patched between runs.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

git_() { git -c user.name=t -c user.email=t@t -c init.defaultBranch=main "$@"; }

# A Chromium checkout in $1 whose pin names dep/ as a gitlink, with the dep
# checked out the way engine-node.sh leaves it: a patch committed over the
# pin's revision, the stamp beside it, and the gitlink ignored. Prints the pin
# and the dep's pinned revision.
make_chromium() {
  local chromium="$1" dep="$1/third_party/dep"
  mkdir -p "$dep"
  git_ init -q "$dep"
  printf 'pinned\n' > "$dep/digest.cc"
  git_ -C "$dep" add -A
  git_ -C "$dep" commit -qm pinned
  local dep_rev
  dep_rev="$(git -C "$dep" rev-parse HEAD)"

  git_ init -q "$chromium"
  printf 'top\n' > "$chromium/README"
  git_ -C "$chromium" add README
  git_ -C "$chromium" update-index --add --cacheinfo "160000,$dep_rev,third_party/dep"
  git_ -C "$chromium" commit -qm pin

  printf 'ripemd160\n' > "$dep/digest.cc"
  git_ -C "$dep" commit -qam "expose ripemd160"
  printf 'node\n' > "$(git -C "$dep" rev-parse --absolute-git-dir)/domicile-node-stamp"
  git -C "$chromium" config submodule.third_party/dep.ignore all
  printf '%s %s\n' "$(git -C "$chromium" rev-parse HEAD)" "$dep_rev"
}

# Runs a copy of engine-reset.sh pinned to $2 on $1; $3 names the case and $4
# is "node" for a branch that builds Node.
run_reset() {
  local chromium="$1" pin="$2" root="$work/root-$3"
  mkdir -p "$root/.github/scripts" "$root/packages/domicile-engine/src"
  cp "$REPO/.github/scripts/engine-reset.sh" \
    "$REPO/.github/scripts/engine-keep-mtimes.sh" "$root/.github/scripts/"
  printf '%s\n' "$pin" > "$root/packages/domicile-engine/CHROMIUM_PIN"
  if [ "${4:-}" = node ]; then
    mkdir -p "$root/packages/domicile-engine/node"
    printf 'url x\ncommit y\n' > "$root/packages/domicile-engine/node/NODE_PIN"
  fi
  if ! "$root/.github/scripts/engine-reset.sh" "$chromium" > "$work/out" 2>&1; then
    cat "$work/out" >&2
    echo "FAIL ($3): engine-reset.sh refused the tree" >&2
    exit 1
  fi
}

main="$work/main/src"
mkdir -p "$main"
read -r pin dep_rev < <(make_chromium "$main")
run_reset "$main" "$pin" main
dep="$main/third_party/dep"
[ "$(git -C "$dep" rev-parse HEAD)" = "$dep_rev" ] ||
  { echo "FAIL (main): the dep still carries Node's patch" >&2; exit 1; }
[ "$(cat "$dep/digest.cc")" = pinned ] ||
  { echo "FAIL (main): the dep's files are not the pin's" >&2; exit 1; }
[ ! -e "$(git -C "$dep" rev-parse --absolute-git-dir)/domicile-node-stamp" ] ||
  { echo "FAIL (main): the dep's Node stamp survived" >&2; exit 1; }
! git -C "$main" config --get submodule.third_party/dep.ignore >/dev/null ||
  { echo "FAIL (main): the dep is still hidden from git status" >&2; exit 1; }
dirty="$(git -C "$main" status --porcelain --untracked-files=all)"
[ -z "$dirty" ] || { printf 'FAIL (main): tree still dirty:\n%s\n' "$dirty" >&2; exit 1; }

node="$work/node/src"
mkdir -p "$node"
read -r pin dep_rev < <(make_chromium "$node")
patched="$(git -C "$node/third_party/dep" rev-parse HEAD)"
run_reset "$node" "$pin" node node
[ "$(git -C "$node/third_party/dep" rev-parse HEAD)" = "$patched" ] ||
  { echo "FAIL (node): a branch with Node lost its patched dep" >&2; exit 1; }

echo "ok: deps a Node branch patched go back to the pin on a branch without Node"
