#!/usr/bin/env bash
# engine-reset.sh leaves a clean tree when the pin drops the `.gitignore` entry
# for a file an older pin's hooks wrote, as Chromium 160 did with
# buildtools/reclient_cfgs/reproxy.cfg and build/util/MINIBRANCH, and keeps
# those files under a pin that still ignores them.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

git_() { git -c user.name=t -c user.email=t@t -c init.defaultBranch=main "$@"; }

# A checkout in $1 whose old pin ignores reproxy.cfg and MINIBRANCH and whose
# new pin does not, with the old hooks' files in place. Prints both pins.
make_chromium() {
  local chromium="$1"
  git_ init -q "$chromium"
  mkdir -p "$chromium/buildtools/reclient_cfgs" "$chromium/build/util"
  printf 'reproxy.cfg\n' > "$chromium/buildtools/reclient_cfgs/.gitignore"
  printf 'MINIBRANCH\n' > "$chromium/build/util/.gitignore"
  git_ -C "$chromium" add -A
  git_ -C "$chromium" commit -qm old
  local old new
  old="$(git -C "$chromium" rev-parse HEAD)"
  printf '/python/\n' > "$chromium/buildtools/reclient_cfgs/.gitignore"
  printf 'LASTCHANGE\n' > "$chromium/build/util/.gitignore"
  git_ -C "$chromium" commit -qam new
  new="$(git -C "$chromium" rev-parse HEAD)"
  git_ -C "$chromium" reset -q --hard "$old"
  printf 'instance=x\n' > "$chromium/buildtools/reclient_cfgs/reproxy.cfg"
  printf 'main\n' > "$chromium/build/util/MINIBRANCH"
  printf '%s %s\n' "$old" "$new"
}

# Runs a copy of engine-reset.sh, pinned to $2, on the checkout in $1.
reset_to() {
  local chromium="$1" pin="$2" root="$work/root-$3"
  mkdir -p "$root/.github/scripts" "$root/packages/domicile-engine/src"
  cp "$REPO/.github/scripts/engine-reset.sh" \
    "$REPO/.github/scripts/engine-keep-mtimes.sh" "$root/.github/scripts/"
  printf '%s\n' "$pin" > "$root/packages/domicile-engine/CHROMIUM_PIN"
  if ! "$root/.github/scripts/engine-reset.sh" "$chromium" > "$work/out" 2>&1; then
    cat "$work/out" >&2
    echo "FAIL ($3): engine-reset.sh refused the tree" >&2
    exit 1
  fi
}

chromium="$work/chromium/src"
mkdir -p "$chromium"
read -r old new < <(make_chromium "$chromium")

reset_to "$chromium" "$old" same-pin
for kept in buildtools/reclient_cfgs/reproxy.cfg build/util/MINIBRANCH; do
  [ -f "$chromium/$kept" ] ||
    { echo "FAIL: removed $kept under a pin that still ignores it" >&2; exit 1; }
done

reset_to "$chromium" "$new" new-pin
dirty="$(git -C "$chromium" status --porcelain --untracked-files=all)"
[ -z "$dirty" ] || { printf 'FAIL: tree still dirty:\n%s\n' "$dirty" >&2; exit 1; }

echo "ok: an older pin's hook output the pin no longer ignores is removed"
