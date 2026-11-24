#!/usr/bin/env bash
# Tests `site-sync.sh`, which puts `site`, the branch Vercel deploys, at
# `release` plus the main commits picked onto it since, only ever moving it
# forward.
#
# Uses real `git` against a local remote.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SYNC="$ROOT/.github/scripts/site-sync.sh"
[ -x "$SYNC" ] || { echo "no $SYNC" >&2; exit 1; }

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
contains() {
  local what="$1" needle="$2" hay="$3"
  case "$hay" in
    (*"$needle"*) printf '  ok    %s\n' "$what" ;;
    (*) printf '  FAIL  %s\n    expected to mention: %s\n    said: %s\n' \
          "$what" "$needle" "$hay"; FAILED=$((FAILED + 1)) ;;
  esac
}

REPO="$WORK/repo"
git init -q --bare "$WORK/remote"
# As the `site` ruleset does: no force pushes.
git -C "$WORK/remote" config receive.denyNonFastForwards true
git init -q -b main "$REPO"
git -C "$REPO" config user.email ci@domicile.invalid
git -C "$REPO" config user.name "domicile CI"
git -C "$REPO" config push.negotiate false
git -C "$REPO" remote add origin "$WORK/remote"
mkdir -p "$REPO/.github/scripts"
cp "$SYNC" "$REPO/.github/scripts/"
git -C "$REPO" add -A
git -C "$REPO" commit -qm base
git -C "$REPO" push -q origin main main:release

# Pushes a commit on main that writes `file`, and prints it.
land() { # file
  git -C "$REPO" checkout -q main
  echo "$1" >"$REPO/$1"
  git -C "$REPO" add -A
  git -C "$REPO" commit -qm "$1"
  git -C "$REPO" push -q origin main
  git -C "$REPO" rev-parse HEAD
}
release_to() { git -C "$REPO" push -q origin "$1:refs/heads/release"; }
# Each sync a minute after the last, as real runs are, so a pick made again
# is a new commit rather than the same one.
echo 0 >"$WORK/minutes"
sync() { # commit...
  local out minutes
  minutes=$(($(cat "$WORK/minutes") + 1))
  echo "$minutes" >"$WORK/minutes"
  git -C "$REPO" checkout -q --detach main
  if out="$(cd "$REPO" && GIT_COMMITTER_DATE="@$((1700000000 + minutes * 60)) +0000" \
    bash .github/scripts/site-sync.sh "$@" 2>&1)"; then
    printf 'ok\n%s\n' "$out"
  else
    printf 'refused\n%s\n' "$out"
  fi
}
status() { printf '%s\n' "$1" | head -1; }
site() { git -C "$WORK/remote" rev-parse -q --verify refs/heads/site || echo missing; }
release() { git -C "$WORK/remote" rev-parse refs/heads/release; }
# The files on site, which is what it deploys.
files() { git -C "$WORK/remote" ls-tree --name-only site | grep -v '^\.github$' | tr '\n' ' '; }

echo "== the first sync makes site at release =="
out="$(sync)"
expect "the sync succeeds" ok "$(status "$out")"
expect "and site is release" "$(release)" "$(site)"

echo "== a main commit is picked onto site =="
a="$(land a)"
out="$(sync "$a")"
expect "the sync succeeds" ok "$(status "$out")"
expect "and site has it" "a " "$(files)"
expect "on top of release" "$(release)" "$(git -C "$WORK/remote" rev-parse site~1)"

echo "== a later pick keeps the earlier one =="
b="$(land b)"
out="$(sync "$b")"
expect "the sync succeeds" ok "$(status "$out")"
expect "and site has both" "a b " "$(files)"

echo "== picking a commit again changes nothing =="
before="$(site)"
out="$(sync "$a")"
expect "the sync succeeds" ok "$(status "$out")"
expect "and site stays" "$before" "$(site)"

echo "== a release with the first pick carries only the second =="
release_to "$a"
before="$(site)"
out="$(sync)"
expect "the sync succeeds" ok "$(status "$out")"
expect "and site has both" "a b " "$(files)"
expect "moving forward from where it was" "$before" "$(git -C "$WORK/remote" rev-parse site^1)"
expect "with release under the second pick" "$a" "$(git -C "$WORK/remote" rev-parse site^2~1)"

echo "== a release with every pick leaves site holding release =="
c="$(land c)"
release_to "$c"
out="$(sync)"
expect "the sync succeeds" ok "$(status "$out")"
expect "and site holds release" "$(git -C "$WORK/remote" rev-parse "$c^{tree}")" \
  "$(git -C "$WORK/remote" rev-parse "site^{tree}")"

echo "== a commit not on main is refused =="
git -C "$REPO" checkout -q --orphan elsewhere
git -C "$REPO" commit -qm elsewhere --allow-empty
foreign="$(git -C "$REPO" rev-parse HEAD)"
before="$(site)"
out="$(sync "$foreign")"
expect "the sync is refused" refused "$(status "$out")"
contains "saying why" "not on main" "$out"
expect "and site is untouched" "$before" "$(site)"

echo "== a commit on site that is no pick is refused, not dropped =="
git -C "$REPO" checkout -q --detach "$(site)"
git -C "$REPO" commit -qm "by hand" --allow-empty
git -C "$REPO" push -q origin HEAD:site
before="$(site)"
out="$(sync)"
expect "the sync is refused" refused "$(status "$out")"
contains "saying why" "not picked from main" "$out"
expect "and site is untouched" "$before" "$(site)"

if [ "$FAILED" -gt 0 ]; then
  echo "$FAILED failed"
  exit 1
fi
echo "all ok"
