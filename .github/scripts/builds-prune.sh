#!/usr/bin/env bash
# Delete old engine and package builds from a repository's releases.
#
#   GH_TOKEN=... .github/scripts/builds-prune.sh <repository> <days to keep>
#
# Builds are published in the builds repository (`DOMICILE_BUILDS_REPO`,
# default `cprussin/domicile-builds`); see engine-release-publish.sh. Run on it
# with 7 days, and on this repository with 2 to clear the builds published here
# before they moved. Only `engine-*` and `packages-*` releases are touched.
# Keeps:
#
# - in the builds repository, the rolling releases: `packages-latest`,
#   `engine-nightly`, `engine-official-nightly`,
# - pushed `engine-v*` tags,
# - anything published in the last <days to keep> days,
# - every engine an `engine-*.nix` fetches from <repository> on `main`,
#   `stable`, a `release-*` tag or an open pull request's head, so each cut
#   release keeps its engine and no pull request loses one it pinned.
#
# `GH_TOKEN` needs Contents: write on <repository>.
set -euo pipefail

[ "$#" -eq 2 ] || {
  echo "usage: builds-prune.sh <repository> <days to keep>" >&2
  exit 2
}
REPO="$1"
KEEP_DAYS="$2"
: "${GH_TOKEN:?a token with Contents: write on $REPO is required}"
: "${GITHUB_REPOSITORY:?}"
BUILDS_REPO="${DOMICILE_BUILDS_REPO:-cprussin/domicile-builds}"
NOW="${DOMICILE_BUILDS_NOW:-$(date -u +%s)}"
PINS=(packages/domicile-engine/engine-release.nix packages/domicile-engine/engine-official.nix)

# The refs whose pins are kept, then the release tags in <repository> they
# pin. Each `gh` runs in this shell, not a command or process substitution, so
# one that fails stops the prune before it deletes anything.
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
printf '%s\n' main stable >"$work/refs"
gh api --paginate "repos/$GITHUB_REPOSITORY/git/matching-refs/tags/release-" \
  --jq '.[].ref' >>"$work/refs"
gh api --paginate "repos/$GITHUB_REPOSITORY/pulls?state=open&per_page=100" \
  --jq '.[].head.sha' >>"$work/refs"
mapfile -t refs <"$work/refs"
pins="$work/pins"
: >"$pins"
for ref in "${refs[@]}"; do
  for pin in "${PINS[@]}"; do
    gh api -H "Accept: application/vnd.github.raw" \
      "repos/$GITHUB_REPOSITORY/contents/$pin?ref=$ref" >>"$pins"
  done
done
pinned="$(sed -n "s|.*github\.com/$REPO/releases/download/\([^/]*\)/.*|\1|p" "$pins" | sort -u)"
echo "kept for main, stable, release tags and open pull requests:"
printf '  %s\n' $pinned

# Listed in full before anything is deleted, since deleting shifts the pages.
gh api --paginate "repos/$REPO/releases?per_page=100" \
  --jq '.[] | [.id, .tag_name, .created_at, .draft] | @tsv' >"$work/releases"
cutoff=$((NOW - KEEP_DAYS * 86400))
while IFS=$'\t' read -r id tag created draft; do
  case "$tag" in
    (engine-v*) continue ;;
    (packages-latest | engine-nightly | engine-official-nightly)
      [ "$REPO" != "$BUILDS_REPO" ] || continue ;;
    (engine-* | packages-*) ;;
    (*) continue ;;
  esac
  # A here-string, not a pipe: `grep -q` exiting early would SIGPIPE `printf`,
  # and `pipefail` would then call a pinned tag unpinned.
  if grep -qxF "$tag" <<<"$pinned"; then
    continue
  fi
  [ "$(date -u -d "$created" +%s)" -lt "$cutoff" ] || continue
  echo "deleting $tag, published $created"
  # By id: drafts can share a tag name, and have no tag to delete.
  gh api -X DELETE "repos/$REPO/releases/$id"
  [ "$draft" = true ] || gh api -X DELETE "repos/$REPO/git/refs/tags/$tag"
done <"$work/releases"
