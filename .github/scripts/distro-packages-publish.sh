#!/usr/bin/env bash
# Publish the distribution packages `packages/distro/build.sh` made as the
# `packages-latest` release of the builds repository.
#
#   GH_TOKEN=... .github/scripts/distro-packages-publish.sh <packages>
#
# Runs on the commit stable.yml just promoted. `packages-latest` holds the
# newest commit's packages under names without the version, so
# docs/use/INSTALL.md links each one. Older commits' packages are not kept:
# nobody installs a stable that is not the newest.
#
# The builds repository is `DOMICILE_BUILDS_REPO` (default
# `cprussin/domicile-builds`), not this one, so people watching this one hear
# only of real releases. `GH_TOKEN` needs Contents: write there.
set -euo pipefail

[ "$#" -eq 1 ] || {
  echo "usage: distro-packages-publish.sh <packages>" >&2
  exit 2
}
PACKAGES="$1"
: "${GH_TOKEN:?a token with Contents: write on the builds repository is required}"
: "${GITHUB_REPOSITORY:?}"
BUILDS_REPO="${DOMICILE_BUILDS_REPO:-cprussin/domicile-builds}"

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

# Stable runs the official engine; promote-stable.sh checks the same way.
identity_of() { sed -n 's/^ *identity = "\([0-9a-f]*\)";.*/\1/p' "$1" | head -1; }
checked="$(identity_of packages/domicile-engine/engine-release.nix)"
official="$(identity_of packages/domicile-engine/engine-official.nix)"
[ "$checked" = "$official" ] || {
  echo "this commit runs the checked engine (series ${checked:0:12}), so its packages are not published" >&2
  exit 1
}

head="$(git rev-parse HEAD)"
LATEST=packages-latest
INSTALL="https://github.com/$GITHUB_REPOSITORY/blob/$head/docs/use/INSTALL.md"

# The one package in <packages> matching a glob.
one() { # glob
  local matches=("$PACKAGES"/$1)
  [ "${#matches[@]}" -eq 1 ] && [ -e "${matches[0]}" ] || {
    echo "expected one $1 in $PACKAGES, found: ${matches[*]}" >&2
    exit 1
  }
  echo "${matches[0]}"
}

STABLE="$(mktemp -d)"
trap 'rm -rf "$STABLE"' EXIT
cp "$(one 'domicile_*_amd64.deb')" "$STABLE/domicile_amd64.deb"
cp "$(one 'domicile_*_amd64.noapparmor.deb')" "$STABLE/domicile_amd64.noapparmor.deb"
cp "$(one 'domicile-*-1.fedora.x86_64.rpm')" "$STABLE/domicile-fedora.x86_64.rpm"
cp "$(one 'domicile-*-1.opensuse.x86_64.rpm')" "$STABLE/domicile-opensuse.x86_64.rpm"
cp "$(one 'domicile-*-1-x86_64.pkg.tar.zst')" "$STABLE/domicile-x86_64.pkg.tar.zst"
NAMES=(domicile_amd64.deb domicile_amd64.noapparmor.deb domicile-fedora.x86_64.rpm
  domicile-opensuse.x86_64.rpm domicile-x86_64.pkg.tar.zst)
(cd "$STABLE" && sha256sum "${NAMES[@]}" >SHA256SUMS)
# SHA256SUMS last, so it never lists a package that is not uploaded yet.
ASSETS=("${NAMES[@]/#/$STABLE/}" "$STABLE/SHA256SUMS")

# The commit is in the notes, since the tag is on the builds repository's
# branch: this repository's commits are not there. The next run reads it back.
NOTES="$(cat <<NOTES
The newest Domicile packages, built from \`$head\` with the official engine
(series \`${official:0:12}\`).

Debian 12 and Ubuntu 22.04: \`domicile_amd64.noapparmor.deb\`. Debian 13+ and
Ubuntu 24.04+: \`domicile_amd64.deb\`.

Install and set up: [Install]($INSTALL).
NOTES
)"

if ! gh release view "$LATEST" --repo "$BUILDS_REPO" >/dev/null 2>&1; then
  gh release create "$LATEST" --repo "$BUILDS_REPO" --title "Domicile packages (latest)" \
    --notes "$NOTES" --latest=false "${ASSETS[@]}"
  echo "published $LATEST"
  exit 0
fi

# Only forward: a rerun for an older promotion must not replace a newer one.
mirrored="$(gh release view "$LATEST" --repo "$BUILDS_REPO" --json body --jq .body |
  sed -n 's/.*built from `\([0-9a-f]\{40\}\)`.*/\1/p' | head -1)"
[ -n "$mirrored" ] || {
  echo "$LATEST does not say which commit it was built from" >&2
  exit 1
}
status="$(gh api "repos/$GITHUB_REPOSITORY/compare/$mirrored...$head" --jq .status)"
case "$status" in
  (ahead | identical) ;;
  (behind)
    echo "$head is older than ${mirrored:0:12}, which $LATEST has; leaving it"
    exit 0
    ;;
  (*)
    echo "$head and ${mirrored:0:12}, which $LATEST has, are $status; stable only moves forward" >&2
    exit 1
    ;;
esac

# Same names, so each is replaced in place and the set stays whole.
gh release upload "$LATEST" --repo "$BUILDS_REPO" --clobber "${ASSETS[@]}"
gh release view "$LATEST" --repo "$BUILDS_REPO" --json assets --jq '.assets[].name' |
  while read -r asset; do
    case " ${NAMES[*]} SHA256SUMS " in
      (*" $asset "*) ;;
      (*) gh release delete-asset "$LATEST" "$asset" --repo "$BUILDS_REPO" --yes ;;
    esac
  done
gh release edit "$LATEST" --repo "$BUILDS_REPO" --notes "$NOTES"
echo "moved $LATEST to ${head:0:12}"
