#!/usr/bin/env bash
# Tests `renovate-fixup.sh`, which makes a Renovate pull request mergeable.
#
# Renovate edits manifests but cannot finish the job here: bun.lock must come
# from the repository's pinned bun, the SDK's generated files (the engine layer
# among them) bundle dependencies, the flake's node-modules hashes follow
# bun.lock, and CI wants a changeset. The script does those four things,
# commits as domicile CI (an author Renovate ignores, so it keeps rebasing and
# automerging) and pushes. A branch that needs nothing is left alone, and a nix
# failure other than a hash mismatch fails the job.
#
# `bun` and `nix` are stubbed; `git` runs against a local remote.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
FIXUP="$ROOT/.github/scripts/renovate-fixup.sh"
[ -x "$FIXUP" ] || { echo "no $FIXUP" >&2; exit 1; }

command -v git >/dev/null 2>&1 || { echo "  SKIP: no git"; exit 77; }

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

OLD_NM="sha256-oldNodeModules="
OLD_SM="sha256-oldShellModules="
NEW_NM="sha256-newNodeModules="

# main, plus a Renovate branch that bumped a dependency, both on a bare remote,
# checked out on the Renovate branch as `actions/checkout` leaves it.
setup() {
  rm -rf "$WORK/remote" "$WORK/repo" "$WORK/bin"
  git init -q --bare "$WORK/remote"
  git init -q -b main "$WORK/repo"
  git -C "$WORK/repo" config user.email renovate@example.invalid
  git -C "$WORK/repo" config user.name renovate
  mkdir -p "$WORK/repo/.github/scripts" "$WORK/repo/.changeset" \
    "$WORK/repo/packages/chrome-sdk"
  echo layer-4.5.4 >"$WORK/repo/layer.js"
  cp "$FIXUP" "$WORK/repo/.github/scripts/"
  echo '{"catalog":{"zod":"^4.5.4"}}' >"$WORK/repo/package.json"
  echo lock-4.5.4 >"$WORK/repo/bun.lock"
  echo "# changesets" >"$WORK/repo/.changeset/README.md"
  printf '  outputHash = "%s";\n  outputHash = "%s";\n' "$OLD_NM" "$OLD_SM" \
    >"$WORK/repo/flake.nix"
  git -C "$WORK/repo" add -A
  git -C "$WORK/repo" commit -qm main
  git -C "$WORK/repo" remote add origin "$WORK/remote"
  git -C "$WORK/repo" push -q origin main
  git -C "$WORK/repo" checkout -q -b renovate/all
  echo '{"catalog":{"zod":"^4.6.7"}}' >"$WORK/repo/package.json"
  git -C "$WORK/repo" commit -qam "Update zod"
  git -C "$WORK/repo" push -q origin renovate/all

  # bun writes the lockfile its manifests call for.
  mkdir -p "$WORK/bin"
  cat >"$WORK/bin/bun" <<'BUN'
#!/usr/bin/env bash
set -eu
case "$*" in
  "install --lockfile-only")
    sed -n 's/.*"zod":"^\([0-9.]*\)".*/lock-\1/p' package.json >bun.lock ;;
  "install --frozen-lockfile") ;;
  # Run in packages/chrome-sdk; the layer bundles the locked zod.
  "run generate") sed 's/lock/layer/' ../../bun.lock >../../layer.js ;;
  *) echo "bun called with: $*" >&2; exit 1 ;;
esac
BUN
  # nix reports whatever mismatch $NIX_SAYS names for node-modules.
  cat >"$WORK/bin/nix" <<'NIX'
#!/usr/bin/env bash
case "$*" in
  "build --no-link .#node-modules")
    case "${NIX_SAYS:-}" in
      mismatch)
        printf "error: hash mismatch in fixed-output derivation '/nix/store/x-domicile-node-modules-0.0.0.drv':\n         specified: %s\n            got:    %s\n" \
          "$OLD_NM" "$NEW_NM" >&2
        exit 1 ;;
      broken) echo "error: builder failed" >&2; exit 1 ;;
    esac ;;
  "build --no-link .#shell-modules") ;;
  *) echo "nix called with: $*" >&2; exit 1 ;;
esac
NIX
  chmod +x "$WORK/bin/bun" "$WORK/bin/nix"
}

run() {
  (cd "$WORK/repo" &&
    PATH="$WORK/bin:$PATH" OLD_NM="$OLD_NM" NEW_NM="$NEW_NM" \
      .github/scripts/renovate-fixup.sh renovate/all) >"$WORK/out" 2>&1
}

remote_tip() { git -C "$WORK/remote" rev-parse renovate/all; }
remote_file() { git -C "$WORK/remote" show "renovate/all:$1" 2>/dev/null; }

echo "A bump that changes bun.lock and the node-modules hash"
setup
NIX_SAYS=mismatch run
expect "it succeeds" 0 "$?"
expect "bun.lock comes from the pinned bun" lock-4.6.7 "$(remote_file bun.lock)"
expect "the generated files bundle the new version" layer-4.6.7 \
  "$(remote_file layer.js)"
expect "the node-modules hash is refreshed" \
  "$(printf '  outputHash = "%s";\n  outputHash = "%s";' "$NEW_NM" "$OLD_SM")" \
  "$(remote_file flake.nix)"
expect "an empty changeset is added" "$(printf -- '---\n---')" \
  "$(remote_file .changeset/renovate-all.md)"
expect "domicile CI authors the commit" ci@domicile.invalid \
  "$(git -C "$WORK/remote" log -1 --format=%ae renovate/all)"
expect "the commit says it has no release notes" "Release-notes: none" \
  "$(git -C "$WORK/remote" log -1 --format=%b renovate/all | grep Release-notes)"

echo "A second run on the fixed-up branch"
tip="$(remote_tip)"
git -C "$WORK/repo" fetch -q origin
NIX_SAYS= run
expect "it succeeds" 0 "$?"
expect "it pushes nothing" "$tip" "$(remote_tip)"

echo "A branch that already has a changeset"
setup
printf -- '---\n"domicile": patch\n---\n\nUpdate.\n' >"$WORK/repo/.changeset/mine.md"
git -C "$WORK/repo" add -A
git -C "$WORK/repo" commit -qm changeset
git -C "$WORK/repo" push -q origin renovate/all
NIX_SAYS= run
expect "it succeeds" 0 "$?"
expect "no second changeset is added" "" "$(remote_file .changeset/renovate-all.md)"

echo "A nix build that fails for another reason"
setup
tip="$(remote_tip)"
NIX_SAYS=broken run
status=$?
expect "it fails" 1 "$([ "$status" -ne 0 ] && echo 1 || echo 0)"
expect "it pushes nothing" "$tip" "$(remote_tip)"

[ "$FAILED" -eq 0 ] || { echo "$FAILED failed"; cat "$WORK/out"; exit 1; }
