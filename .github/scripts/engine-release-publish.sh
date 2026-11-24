#!/usr/bin/env bash
# Publish the engine tarball as a GitHub release in the builds repository.
#
#   DOMICILE_BUILDS_TOKEN=... .github/scripts/engine-release-publish.sh /build/engine-release name.tar.zst
#
# Builds go to `DOMICILE_BUILDS_REPO` (default `cprussin/domicile-builds`), not
# this repository, so people watching this one hear only of real releases.
# `DOMICILE_BUILDS_TOKEN` needs Contents: write there.
#
# curl and jq rather than an action, so no third-party code gets the token.
# See config/machines/crux/domicile-ci.nix in cprussin/dotfiles for the
# runner's PATH.
#
# A tag push publishes that tag. Otherwise this recreates `engine-nightly` so
# it always holds the newest build, and also publishes an immutable release
# named after the series for pins.
#
# DOMICILE_ENGINE_BUILD=official uses the `engine-official-` prefix, because
# the checked and official builds share a series and would otherwise share
# tags.
set -euo pipefail

case "${DOMICILE_ENGINE_BUILD:-checked}" in
  (checked) PREFIX=engine ;;
  (official) PREFIX=engine-official ;;
  (*)
    echo "DOMICILE_ENGINE_BUILD is '$DOMICILE_ENGINE_BUILD'; the builds are 'checked' and 'official'." >&2
    exit 1
    ;;
esac

STAGE="${1:-}"
TARBALL="${2:-}"
: "${DOMICILE_BUILDS_TOKEN:?a token with Contents: write on the builds repository is required}"
: "${GITHUB_SHA:?}"
BUILDS_REPO="${DOMICILE_BUILDS_REPO:-cprussin/domicile-builds}"

if [ -z "$STAGE" ] || [ -z "$TARBALL" ]; then
  echo "usage: engine-release-publish.sh <stage dir> <tarball name>" >&2
  exit 1
fi
[ -f "$STAGE/$TARBALL" ] || { echo "no $STAGE/$TARBALL to publish" >&2; exit 1; }

API="https://api.github.com/repos/$BUILDS_REPO"
UPLOADS="https://uploads.github.com/repos/$BUILDS_REPO"

# Retry API calls on a 5xx, a rate limit or no response, so a transient error
# does not waste a finished build. Other errors fail at once. Five tries with
# backoff from 15s wait at most 3m45s.
API_ATTEMPTS=5

# Like `curl -f`: the body on stdout on a 2xx, exit 22 otherwise.
api() {
  local attempt=1 status url="" arg body
  for arg in "$@"; do
    case "$arg" in (http*) url="$arg" ;; esac
  done
  body="$(mktemp)"
  while :; do
    # `-w` prints 000 when curl reached nothing; curl says why on stderr.
    status="$(curl -sS -o "$body" -w '%{http_code}' \
                -H "Authorization: Bearer $DOMICILE_BUILDS_TOKEN" \
                -H "Accept: application/vnd.github+json" \
                -H "X-GitHub-Api-Version: 2022-11-28" "$@")" || true
    case "$status" in
      (2??) cat "$body"; rm -f "$body"; return 0 ;;
    esac
    if api_retryable "$status" "$body" && [ "$attempt" -lt "$API_ATTEMPTS" ]; then
      echo "  GitHub answered $status to $url; attempt $((attempt + 1)) in $((15 << (attempt - 1)))s" >&2
      sleep $((15 << (attempt - 1)))
      attempt=$((attempt + 1))
    else
      echo "GitHub answered $status to $url (attempt $attempt of $API_ATTEMPTS): $(head -c 300 "$body")" >&2
      rm -f "$body"
      return 22
    fi
  done
}

# A 5xx, a 429, a 000 (no response), or a 403 for a rate limit. A 403 for
# missing permission is not retried.
api_retryable() { # status, body file
  case "$1" in
    (5??|429|000) return 0 ;;
    (403) grep -qi 'rate limit' "$2" ;;
    (*) return 1 ;;
  esac
}

# Every release body states the series. `update-engine-release.sh` copies it
# into `engine-release.nix`, so a checkout can verify its pin without
# downloading the engine.
IDENTITY="$(.github/scripts/engine-series-stamp.sh identity)"

if [ "${GITHUB_REF_TYPE:-}" = "tag" ]; then
  TAG="$GITHUB_REF_NAME"
  PRERELEASE=false
  # A pushed tag is already immutable, so no second release is needed.
  PINNABLE=""
else
  TAG="$PREFIX-nightly"
  PRERELEASE=true
  # The nightly is recreated each run, so pins use a second, immutable
  # release. It is named after the series (a content hash of the pin,
  # `patches/` and `src/`), so commits that do not change the fork need no
  # repin. The identity comes from engine-series-stamp.sh, and the tag uses
  # the same twelve characters as the tarball name.
  PINNABLE="$PREFIX-s${IDENTITY:0:12}"
fi

# Delete any existing release for this tag, so the old assets do not remain
# beside the new ones.
if existing=$(api "$API/releases/tags/$TAG" 2>/dev/null); then
  id=$(echo "$existing" | jq -r .id)
  echo "replacing release $TAG ($id)"
  api -X DELETE "$API/releases/$id" >/dev/null
  # Only move the nightly's tag. A pushed tag belongs to whoever pushed it.
  if [ "$TAG" = "$PREFIX-nightly" ]; then
    api -X DELETE "$API/git/refs/tags/$TAG" >/dev/null 2>&1 || true
  fi
fi

PIN="$(grep -v '^#' packages/domicile-engine/CHROMIUM_PIN | tr -d '[:space:]')"
BODY=$(cat <<BODY
A patched Chromium, built on crux, that \`domicile-compositor\` can use as its
engine without anybody building one.

- series identity: \`$IDENTITY\`
- domicile commit: \`$GITHUB_SHA\`
- chromium pin: \`$PIN\`
- build: \`${DOMICILE_ENGINE_BUILD:-checked}\`
- gn args: \`.github/scripts/engine-release-build.sh\` at that commit${PINNABLE:+
- immutable release: \`$PINNABLE\`}

Unpack it and put the directory on \`LD_LIBRARY_PATH\`:
\`libdomicile_engine.so\` is dlopened by name.

This artifact was asserted before publication by the same pixel guard the
engine workflow runs: a real Wayland client's window drawn on a page, and a
negative control that fails when nothing draws.
BODY
)

# Create the release, or fetch it if creation failed. A create that returned
# 500 may still have succeeded, and its retry then returns 422. No
# `target_commitish`: this repository's commits are not in the builds
# repository, so the tag goes on its default branch and the body names the
# commit.
create_release() { # tag, prerelease
  api -X POST "$API/releases" -d "$(
    jq -n --arg tag "$1" --arg body "$BODY" --argjson pre "$2" \
      '{tag_name: $tag, name: $tag, body: $body, prerelease: $pre}'
  )" || {
    echo "  the create failed; filling $1 if GitHub made it anyway" >&2
    api "$API/releases/tags/$1"
  }
}

echo "creating release $TAG"
release=$(create_release "$TAG" "$PRERELEASE")
id=$(echo "$release" | jq -r .id)

# The tarball and its digest.
ASSETS=("$TARBALL" "$TARBALL.sha256")

# GitHub's upload endpoint sometimes returns 500, and a failed upload wastes
# the whole build, so each asset gets several attempts.
UPLOAD_ATTEMPTS=4

# Not `curl --retry`: a failed upload can leave the asset on the release, and
# later uploads of that name then fail with 422. So each attempt deletes it
# first.
upload_asset() {
  local into="$1" asset="$2" attempt=1
  while :; do
    api "$API/releases/$into/assets" |
      jq -r --arg name "$asset" '.[] | select(.name == $name) | .id' |
      while read -r stale; do
        echo "  dropping what a failed upload left behind ($stale)"
        api -X DELETE "$API/releases/assets/$stale" >/dev/null
      done
    # A time limit, so a stalled socket cannot hang the job. A flat limit
    # rather than `--speed-time`, because no bytes move while GitHub processes
    # the upload.
    if curl -sS -f -X POST \
         --connect-timeout 30 --max-time 600 \
         -H "Authorization: Bearer $DOMICILE_BUILDS_TOKEN" \
         -H "Content-Type: application/octet-stream" \
         --data-binary "@$STAGE/$asset" \
         "$UPLOADS/releases/$into/assets?name=$asset" >/dev/null; then
      return 0
    fi
    [ "$attempt" -lt "$UPLOAD_ATTEMPTS" ] || {
      echo "$asset did not upload in $attempt attempts" >&2
      return 1
    }
    echo "  that upload did not land; attempt $((attempt + 1)) in $((attempt * 15))s"
    sleep $((attempt * 15))
    attempt=$((attempt + 1))
  done
}

upload_assets() {
  local into="$1"
  for asset in "${ASSETS[@]}"; do
    echo "uploading $asset"
    upload_asset "$into" "$asset"
  done
}

# Upload only the assets a release is missing, so a re-run can finish a
# release an earlier run created but did not fill. An interrupted upload leaves
# an asset in state `starter`, so only `uploaded` counts. Uploaded assets are
# never replaced, since something may pin them.
complete_assets() {
  local into="$1" landed
  landed="$(api "$API/releases/$into/assets" |
              jq -r '.[] | select(.state == "uploaded") | .name')"
  for asset in "${ASSETS[@]}"; do
    if printf '%s\n' "$landed" | grep -qxF "$asset"; then
      echo "$asset is already there; left alone"
    else
      echo "uploading $asset"
      upload_asset "$into" "$asset"
    fi
  done
}

upload_assets "$id"
echo "published $(echo "$release" | jq -r .html_url)"

# The immutable release, which pins point at. It is never deleted.
if [ -n "$PINNABLE" ]; then
  if pinned=$(api "$API/releases/tags/$PINNABLE" 2>/dev/null); then
    # Never recreated, since something may pin it. Fill in any assets an
    # earlier run failed to upload.
    echo "$PINNABLE already exists; adding whatever is missing from it"
    complete_assets "$(echo "$pinned" | jq -r .id)"
  else
    echo "creating release $PINNABLE"
    pinnable=$(create_release "$PINNABLE" false)
    upload_assets "$(echo "$pinnable" | jq -r .id)"
    echo "published $(echo "$pinnable" | jq -r .html_url)"
  fi
fi
