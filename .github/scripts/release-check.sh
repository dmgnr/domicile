#!/usr/bin/env bash
# Says whether `stable`, checked out, has something to release.
#
#   .github/scripts/release-check.sh
#
# Sets the step output `commit` to stable's commit when `release` lacks it.
# Releases the versions stable holds: a changeset not yet versioned waits for
# the next release. Refuses:
#
# - a `release` that is not an ancestor, since someone put it there;
# - a `domicile` at 0.0.0, which no changeset versioned;
# - release notes with no dated entry for `domicile`'s version
#   (docs/RELEASE-NOTES.md) or manganese's (docs/use/RELEASE-NOTES.md).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

head="$(git rev-parse HEAD)"

# `--exit-code` answers 2 for no such ref, the first release's case; any other
# failure is the job's.
status=0
git ls-remote -q --exit-code origin refs/heads/release >/dev/null || status=$?
case "$status" in
  (0)
    git fetch -q origin +refs/heads/release:refs/remotes/origin/release
    release="$(git rev-parse refs/remotes/origin/release)"
    if git merge-base --is-ancestor "$head" "$release"; then
      echo "release (${release:0:12}) already has ${head:0:12}; nothing to release"
      exit 0
    fi
    git merge-base --is-ancestor "$release" "$head" || {
      echo "release (${release:0:12}) is not an ancestor of ${head:0:12}; not overwriting it" >&2
      exit 1
    }
    ;;
  (2) echo "there is no release yet" ;;
  (*) exit "$status" ;;
esac

pending="$(find .changeset -name '*.md' ! -name README.md | sort)"
[ -z "$pending" ] || {
  echo "changesets not yet versioned, left for the next release:"
  echo "$pending"
}

version="$(jq -r .version packages/domicile/package.json)"
[ "$version" != 0.0.0 ] || {
  echo "domicile is at 0.0.0; no changeset has versioned it" >&2
  exit 1
}

# The line after a release's `## <version>` heading is its date, or
# `_Unreleased_` until the release is cut.
dated_notes() { # file version
  local date
  date="$(awk -v heading="## $2" '
    found && NF { print; exit }
    $0 == heading { found = 1 }
  ' "$1")"
  case "$date" in
    ("") echo "$1 has no \"## $2\" entry; write its release notes" >&2; return 1 ;;
    ("_Unreleased_") echo "$1's $2 entry says _Unreleased_; date it" >&2; return 1 ;;
  esac
}
dated_notes docs/RELEASE-NOTES.md "$version"
dated_notes docs/use/RELEASE-NOTES.md "$(jq -r .version packages/shell-manganese/package.json)"

echo "releasing ${head:0:12}, domicile $version"
echo "commit=$head" >>"${GITHUB_OUTPUT:-/dev/null}"
