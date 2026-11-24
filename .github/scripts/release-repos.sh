#!/usr/bin/env bash
# Adds a release's distribution packages to the repositories published on R2.
#
#   .github/scripts/release-repos.sh <packages> <repo>
#
# Downloads the bucket into <repo>, runs `packages/distro/repo.sh`, and uploads it: the
# packages first, then the indexes that name them, deleting what `repo.sh`
# pruned. A client never reads an index naming a package not yet uploaded.
# `DOMICILE_RELEASE_DRY_RUN=1` shows the upload instead.
#
# Needs `aws` and `packages/distro/repo-tools` on PATH, and:
#
# - `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`: an R2 token that can read and
#   write the bucket;
# - `R2_ACCOUNT_ID`, `DOMICILE_R2_BUCKET`: override Domicile's Cloudflare
#   account and the `domicile-packages` bucket;
# - `DOMICILE_SIGNING_KEY`: for `packages/distro/repo.sh`.
set -euo pipefail

[ "$#" -eq 2 ] || {
  echo "usage: release-repos.sh <packages> <repo>" >&2
  exit 2
}
PACKAGES="$1"
REPO="$2"

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

: "${R2_ACCESS_KEY_ID:?}" "${R2_SECRET_ACCESS_KEY:?}" "${DOMICILE_SIGNING_KEY:?}"
R2_ACCOUNT_ID="${R2_ACCOUNT_ID:-9e3478be0713138076f5a66696ba7817}"
DOMICILE_R2_BUCKET="${DOMICILE_R2_BUCKET:-domicile-packages}"
export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
export AWS_DEFAULT_REGION=auto
BUCKET="s3://$DOMICILE_R2_BUCKET"

# `nix/` holds the Nix cache (`nix-cache-push.sh`): too big to bring down, and
# not this script's to delete.
sync() { # from, to, flags...
  aws s3 sync "$1" "$2" --endpoint-url "https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com" \
    --exclude 'nix/*' "${@:3}"
}

mkdir -p "$REPO"
sync "$BUCKET" "$REPO" --only-show-errors
"$ROOT/packages/distro/repo.sh" "$PACKAGES" "$REPO"

if [ "${DOMICILE_RELEASE_DRY_RUN:-}" = 1 ]; then
  echo "dry run: the upload would be"
  sync "$REPO" "$BUCKET" --delete --dryrun
  exit 0
fi
sync "$REPO" "$BUCKET" --only-show-errors --exclude '*' --include '*.deb' \
  --include '*.rpm' --include '*.pkg.tar.zst' --include '*.pkg.tar.zst.sig'
sync "$REPO" "$BUCKET" --only-show-errors --delete
