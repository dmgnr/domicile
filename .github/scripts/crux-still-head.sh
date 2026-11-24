#!/usr/bin/env bash
# Whether a run's commit is still worth building: its branch's head on origin,
# or a commit the head only changed outside the engine's inputs.
#
#   crux-still-head.sh <branch> <sha>   0 yes, 1 no (moved on or deleted),
#                                       3 could not ask
#
# engine.yml asks this while a run waits for the compile slot. The wait can
# outlast a cold repin, and a run for a replaced commit holds a `crux` runner
# for a result nobody reads. engine-cancel-stale.yml asks it before canceling a
# started run.
#
# A head that differs from <sha> only outside engine.yml's `paths:` (a docs
# media retake the bot pushes, a shell change) builds the same engine, so the
# run for <sha> is still wanted: canceling it would throw away hours of a cold
# compile to start the same compile again. The head's own run still runs its
# checks after this one, in a tree that then carries the series.
#
# Not named `engine-*.sh`; see crux-stale-runs.sh.
set -u

[ $# -eq 2 ] || { echo "usage: $(basename "$0") <branch> <sha>" >&2; exit 2; }
branch="$1"
sha="$2"

# engine.yml's `paths:` as git pathspecs, the same list engine-proof.sh's
# `version-only` uses. packages/ci/tests/test-crux-still-head.sh checks that it
# matches engine.yml.
ENGINE_PATHS=(packages/domicile-engine .github/workflows/engine.yml
              ':(glob).github/scripts/engine-*.sh' packages/check-runner/src/report.sh
              ':(exclude,glob)**/*.md'
              ':(exclude)packages/domicile-engine/engine-release.nix'
              ':(exclude)packages/domicile-engine/engine-official.nix'
              ':(exclude)packages/domicile-engine/CHROMIUM_VERSION'
              ':(exclude)packages/domicile-engine/tests'
              ':(exclude)packages/domicile-engine/scripts/update-engine-release.sh')

line="$(git ls-remote --exit-code origin "refs/heads/$branch" 2>&1)"
case $? in
  0) ;;
  2) echo "$branch no longer exists on origin"; exit 1 ;;
  *) echo "could not ask origin where $branch points: $line"; exit 3 ;;
esac

head="${line%%[[:space:]]*}"
if [ "$head" = "$sha" ]; then
  echo "$sha is still $branch's head"
  exit 0
fi

# Compares the two trees, so it holds for a force-push too. Depth 1 is enough:
# no history is read, and the checkout this runs in is shallow anyway.
have() { git cat-file -e "$1^{commit}" 2>/dev/null; }
if ! { have "$sha" && have "$head"; } &&
   ! out="$(git fetch -q --no-tags --depth=1 origin "$sha" "$head" 2>&1)"; then
  echo "could not fetch $sha and $head to compare them: $out"
  exit 3
fi
if ! files="$(git diff --name-only "$sha" "$head" -- "${ENGINE_PATHS[@]}" 2>&1)"; then
  echo "could not compare $sha with $head: $files"
  exit 3
fi
if [ -z "$files" ]; then
  echo "$branch has moved on from $sha to $head, but only outside the engine's paths"
  exit 0
fi
echo "$branch has moved on from $sha to $head, which changes $(printf '%s\n' "$files" | head -1)"
exit 1
