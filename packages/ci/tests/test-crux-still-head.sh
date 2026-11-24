#!/usr/bin/env bash
# Tests `crux-still-head.sh`: whether a run's commit is still its branch's head.
#
# engine.yml asks this while a run waits for the compile slot, so a replaced
# commit does not hold a `crux` runner for hours.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
STILL_HEAD="$ROOT/.github/scripts/crux-still-head.sh"
[ -x "$STILL_HEAD" ] || { echo "no $STILL_HEAD" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t

FAILED=0
expect() {
  if [ "$3" = "$2" ]; then
    printf '  ok    %s\n' "$1"
  else
    printf '  FAIL  %s\n    wanted: %s\n    got:    %s\n' "$1" "$2" "$3"
    FAILED=$((FAILED + 1))
  fi
}
contains() {
  case "$3" in
    (*"$2"*) printf '  ok    %s\n' "$1" ;;
    (*) printf '  FAIL  %s\n    expected to mention: %s\n    said: %s\n' "$1" "$2" "$3"
        FAILED=$((FAILED + 1)) ;;
  esac
}

git init -q --bare "$WORK/origin.git"
git init -q "$WORK/repo"
cd "$WORK/repo"
git remote add origin "$WORK/origin.git"
git commit -q --allow-empty -m one
first="$(git rev-parse HEAD)"
git push -q origin HEAD:refs/heads/feature 2>/dev/null

still_head() { "$STILL_HEAD" feature "$1" 2>&1; echo "exit=$?"; }

out="$(still_head "$first")"
contains "the branch's own head is still wanted" "exit=0" "$out"

# A docs media retake: the bot's push changes no engine input, so the run for
# the commit before it builds the same engine and is still wanted.
add() { mkdir -p "$(dirname "$1")"; echo "$2" >"$1"; git add "$1"; git commit -q -m "$1"; }
add packages/site/public/media/hero.png retake
retake="$(git rev-parse HEAD)"
git push -q origin HEAD:refs/heads/feature 2>/dev/null
out="$(still_head "$first")"
contains "a head that changed only media is still the same engine" "exit=0" "$out"
contains "and says why" "only outside the engine's paths" "$out"

add packages/domicile-engine/README.md prose
git push -q origin HEAD:refs/heads/feature 2>/dev/null
contains "markdown under the engine is not an input either" "exit=0" "$(still_head "$first")"
add packages/domicile-engine/engine-release.nix writeback
git push -q origin HEAD:refs/heads/feature 2>/dev/null
contains "nor is the write-back of engine-release.nix" "exit=0" "$(still_head "$first")"

add packages/domicile-engine/patches/0001-x.patch patch
second="$(git rev-parse HEAD)"
git push -q origin HEAD:refs/heads/feature 2>/dev/null
out="$(still_head "$first")"
contains "a head that changed a patch is a different engine" "exit=1" "$out"
contains "and it names what replaced it" "$second" "$out"
contains "and the file that differs" "packages/domicile-engine/patches/0001-x.patch" "$out"
contains "the new head is" "exit=0" "$(still_head "$second")"
contains "the commit the patch came after is not" "exit=1" "$(still_head "$retake")"

for path in .github/workflows/engine.yml .github/scripts/engine-build.sh packages/check-runner/src/report.sh; do
  git checkout -q "$retake"
  add "$path" changed
  git push -q -f origin HEAD:refs/heads/feature 2>/dev/null
  contains "a change to $path is a different engine" "exit=1" "$(still_head "$retake")"
done

# A force-push compares trees, not history: an unrelated head with the same
# engine inputs builds the same engine.
git checkout -q --orphan rewritten "$retake"
git commit -q -m rewritten
git push -q -f origin HEAD:refs/heads/feature 2>/dev/null
contains "a rewritten head with the same engine inputs is still the same engine" "exit=0" "$(still_head "$retake")"

# A clone of origin that has neither commit fetches them to compare.
git clone -q --depth=1 "file://$WORK/origin.git" "$WORK/shallow" 2>/dev/null
out="$(cd "$WORK/shallow" && "$STILL_HEAD" feature "$first" 2>&1; echo "exit=$?")"
contains "a shallow checkout fetches what it compares" "exit=0" "$out"
git checkout -q "$second"
git push -q -f origin HEAD:refs/heads/feature 2>/dev/null

git push -q origin :refs/heads/feature 2>/dev/null
out="$(still_head "$second")"
contains "a deleted branch's run is not wanted" "exit=1" "$out"
contains "saying the branch is gone" "no longer exists" "$out"

git remote set-url origin "$WORK/nowhere.git"
out="$(still_head "$second")"
contains "an unreachable origin is an error, not an answer" "exit=3" "$out"

# engine.yml asks this while it waits for the slot, and turns "no" into a
# cancel rather than a failed run.
WORKFLOW="$ROOT/.github/workflows/engine.yml"
step() { awk -v n="      - name: $1" '$0 == n {on=1; print; next} on && /^      - name:/ {exit} on' "$WORKFLOW"; }
slot="$(step "Take the compile slot")"
contains "the slot step asks this while it waits" "crux-still-head.sh" "$slot"
contains "only for a pull request from this repository" "head.repo.full_name == github.repository" "$slot"
cancel="$(step "Cancel this run, its commit was replaced")"
contains "a superseded wait cancels the run" "steps.slot.outputs.superseded == 'true'" "$cancel"
contains "the run cancels itself" 'actions/runs/${{ github.run_id }}/cancel' "$cancel"
grep -A3 '^permissions:' "$WORKFLOW" | grep -q 'actions: write'
expect "which needs actions: write" 0 "$?"

# The pathspecs are engine.yml's `paths:`, written as git pathspecs.
want="$(awk '/^  pull_request:/ {on=1; next} on && /^  [^ ]/ {exit} on && /^      - / {
           v=$0; sub(/^      - /, "", v); gsub(/"/, "", v); print v }' "$WORKFLOW" | sort)"
got="$(sed -n '/^ENGINE_PATHS=(/,/)$/p' "$STILL_HEAD" | grep -oE "'[^']*'|[^ ()']+" |
         grep -v '^ENGINE_PATHS=' | tr -d "'" |
         sed -e 's/^:(exclude,glob)/!/' -e 's/^:(exclude)/!/' -e 's/^:(glob)//' |
         sed -E -e 's|^!\*\*/\*\.md$|!packages/domicile-engine/**/*.md|' \
                -e 's|^(!?packages/domicile-engine/tests)$|\1/**|' \
                -e 's|^packages/domicile-engine$|packages/domicile-engine/**|' | sort)"
expect "its engine paths are engine.yml's" "$want" "$got"

[ "$FAILED" -eq 0 ] || { echo "$FAILED failed"; exit 1; }
echo "all ok"
