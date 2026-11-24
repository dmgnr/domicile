#!/usr/bin/env bash
# Puts `site`, the branch Vercel deploys domicile-desktop.com from, at
# `release` plus the main commits picked onto it.
#
#   .github/scripts/site-sync.sh [<commit>...]
#
# - Each <commit> must be on main. One `release` has already is skipped.
# - The picks on `site` that `release` doesn't have yet are picked again onto
#   it, so a release never takes back a site fix it doesn't carry.
# - A commit on `site` that is no pick is refused, since someone put it there.
#
# Only moves `site` forward, since its ruleset refuses force pushes:
#
# - New picks go on top of `site`.
# - After a release, `release` plus the picks it lacks is merged onto `site`,
#   with that tree.
#
# Picks with `cherry-pick -x`, whose line names the main commit. Pushes with a
# lease, and only when `site` changes.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

git fetch -q origin +refs/heads/main:refs/remotes/origin/main \
  +refs/heads/release:refs/remotes/origin/release
release="$(git rev-parse refs/remotes/origin/release)"

# `--exit-code` answers 2 for no such ref, the first run's case.
status=0
git ls-remote -q --exit-code origin refs/heads/site >/dev/null || status=$?
case "$status" in
  (0) git fetch -q origin +refs/heads/site:refs/remotes/origin/site
      site="$(git rev-parse refs/remotes/origin/site)" ;;
  (2) site="" ;;
  (*) exit "$status" ;;
esac

picked_from() { git log -1 --format=%B "$1" | sed -n 's/^(cherry picked from commit \([0-9a-f]\{40\}\))$/\1/p' | tail -1; }
released() { git merge-base --is-ancestor "$1" "$release"; }
has() { [[ " $1 " == *" $2 "* ]]; }

# The main commits `site` carries and `release` doesn't, oldest first. A
# commit picked again after a release shows up once per pick.
picks=()
if [ -n "$site" ]; then
  while read -r commit; do
    from="$(picked_from "$commit")"
    if [ -z "$from" ]; then
      echo "site has ${commit:0:12}, which was not picked from main; not overwriting it" >&2
      exit 1
    fi
    if ! released "$from" && ! has "${picks[*]}" "$from"; then
      picks+=("$from")
    fi
  done < <(git rev-list --reverse --no-merges "$(git merge-base "$site" "$release")..$site")
fi

new=()
for arg in "$@"; do
  commit="$(git rev-parse --verify "$arg^{commit}")"
  if ! git merge-base --is-ancestor "$commit" refs/remotes/origin/main; then
    echo "${commit:0:12} is not on main" >&2
    exit 1
  fi
  if released "$commit"; then
    echo "release has ${commit:0:12} already"
  elif has "${picks[*]} ${new[*]}" "$commit"; then
    echo "site has ${commit:0:12} already"
  else
    new+=("$commit")
  fi
done

pick() { # commit...
  for commit in "$@"; do
    git cherry-pick -x "$commit" >/dev/null
    echo "picked ${commit:0:12}: $(git log -1 --format=%s "$commit")"
  done
}

if [ -n "$site" ] && git merge-base --is-ancestor "$release" "$site"; then
  if [ "${#new[@]}" -eq 0 ]; then
    echo "site (${site:0:12}) is up to date"
    exit 0
  fi
  git checkout -q --detach "$site"
  pick "${new[@]}"
  head="$(git rev-parse HEAD)"
else
  git checkout -q --detach "$release"
  pick "${picks[@]}" "${new[@]}"
  head="$(git rev-parse HEAD)"
  if [ -n "$site" ]; then
    head="$(git commit-tree "$head^{tree}" -p "$site" -p "$head" \
      -m "Sync site to release ${release:0:12} and ${#picks[@]} + ${#new[@]} pick(s)")"
  fi
fi
git push -q --force-with-lease="refs/heads/site:$site" origin "$head:refs/heads/site"
echo "site is now ${head:0:12}: release ${release:0:12} and $((${#picks[@]} + ${#new[@]})) pick(s)"
