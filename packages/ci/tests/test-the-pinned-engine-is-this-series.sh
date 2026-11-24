#!/usr/bin/env bash
# Checks that the engine this checkout pins was built from the series this
# checkout carries.
#
# `packages/domicile-engine/` holds the fork: a Chromium revision, a patch
# series and the files it copies in. `engine-release.nix` names one published
# tarball and records the series it was built from. A fork change without a
# release ships a different engine than the repository describes.
# `pinned-engine.yml` catches only mismatches that break the C ABI (#411).
#
# Both sides are local, so this is a string comparison that runs in seconds
# without a Chromium tree.
#
# On a pull request that changes the fork, a mismatch is expected until
# `engine.yml` publishes the engine and writes `engine-release.nix` back to the
# branch. It still fails: until the write-back lands, the branch describes an
# engine nobody built, and merging it then leaves main pinned to the old series
# (#2425 merged that way and stranded the next stable release). Red until the
# write-back is what keeps such a pull request from looking mergeable.
#
# `turbo-test.yml` sets `DOMICILE_PR_HEAD_SHA` and `DOMICILE_PR_BASE_SHA`, and
# with them the failure says whether a write-back is still coming:
#
#   - the pin is still the base's, so the write-back will move it; and
#   - `engine.yml` has an unfinished run for that head.
#
# When both hold, it says to wait; otherwise it says why nothing will fix the
# pin. The write-back push triggers the turbo-test run that passes.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
STAMP="$ROOT/.github/scripts/engine-series-stamp.sh"
RELEASE="$ROOT/packages/domicile-engine/engine-release.nix"

[ -x "$STAMP" ] || { echo "no $STAMP" >&2; exit 1; }
[ -f "$RELEASE" ] || { echo "no $RELEASE" >&2; exit 1; }

# The series in hand: the pin, every patch and every laid-down file, hashed by
# content. Taken from the stamp script so there is one implementation.
want="$("$STAMP" identity)"

# The series the pinned release was built from, as `update-engine-release.sh`
# wrote it. Parsed, not evaluated, because `nix` is not on every machine that
# runs `turbo test`.
identity_in() {
  sed -n 's/^[[:space:]]*identity[[:space:]]*=[[:space:]]*"\([0-9a-f]*\)".*/\1/p' | head -1
}
got="$(identity_in <"$RELEASE")"

if [ -z "$got" ]; then
  # A file without an identity is outdated, and regenerating it fixes it. Say
  # so, so the reader does not go looking for a broken engine.
  {
    echo "  FAIL  $RELEASE records no series identity"
    echo "        It is generated, and the generator writes that field now:"
    echo "          packages/domicile-engine/scripts/update-engine-release.sh"
  } >&2
  exit 1
fi

# Prints why a pull request's mismatch is not a pending write-back, or nothing
# if it is one. An API failure is a reason, not a skip.
not_pending() { # the pin's identity
  local base runs
  base="$(api application/vnd.github.raw+json \
    "contents/packages/domicile-engine/engine-release.nix?ref=${DOMICILE_PR_BASE_SHA:?}")" ||
    { echo "GitHub would not give the base's engine-release.nix"; return; }
  runs="$(api application/vnd.github+json \
    "actions/workflows/engine.yml/runs?head_sha=$DOMICILE_PR_HEAD_SHA&event=pull_request")" ||
    { echo "GitHub would not say what engine.yml is doing"; return; }
  base="$(identity_in <<<"$base")"
  runs="$(jq -r '.workflow_runs[].status' <<<"$runs")"
  if [ "$1" != "$base" ]; then
    echo "the pin is not the base's ($base), so no write-back explains it"
  elif [ -z "$runs" ]; then
    echo "engine.yml has no run for $DOMICILE_PR_HEAD_SHA, so nothing will write back"
  elif ! grep -qvx completed <<<"$runs"; then
    echo "engine.yml's run for $DOMICILE_PR_HEAD_SHA finished without writing back"
  fi
}

api() { # accept, path under the repository
  curl -sS -f \
    -H "Authorization: Bearer ${GITHUB_TOKEN:?a token is needed to ask about the write-back}" \
    -H "Accept: $1" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "https://api.github.com/repos/${GITHUB_REPOSITORY:?}/$2"
}

why=""
pending=""
if [ "$got" != "$want" ] && [ -n "${DOMICILE_PR_HEAD_SHA:-}" ]; then
  why="$(not_pending "$got")"
  [ -n "$why" ] || pending=1
fi

if [ -n "$pending" ]; then
  {
    echo "  FAIL  not mergeable yet: the pinned engine is not this series"
    echo "        this checkout: $want"
    echo "        the pin:       $got"
    echo
    echo "        engine.yml's run for $DOMICILE_PR_HEAD_SHA has not finished."
    echo "        It publishes this series and writes engine-release.nix back"
    echo "        to the branch; that push reruns this check, and it passes."
    echo "        Merging before then leaves main pinned to the old engine."
  } >&2
  exit 1
fi

if [ "$got" != "$want" ]; then
  {
    echo "  FAIL  the pinned engine was built from a different series than this checkout carries"
    echo "        this checkout: $want"
    echo "        the pin:       $got"
    [ -z "$why" ] || echo "        not a write-back still coming: $why"
    echo
    echo "        Either packages/domicile-engine changed without a release, or"
    echo "        engine-release.nix was not moved onto the one that was"
    echo "        published. On a pull request that moves the fork this is"
    echo "        expected until the engine job on crux publishes the engine"
    echo "        and writes this file back to the branch; that push is what"
    echo "        turns it green, and it is why the repin is not a second pull"
    echo "        request."
    echo
    echo "        By hand, once a release for this series exists:"
    echo "          packages/domicile-engine/scripts/update-engine-release.sh"
  } >&2
  exit 1
fi

echo "  ok    the pinned engine is this checkout's series ($want)"
