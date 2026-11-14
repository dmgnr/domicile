#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SCRIPT="$ROOT/scripts/thorium-poc/fetch-child-sources.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "$*" >&2; exit 1; }

mkdir -p "$TMP/source"
git -C "$TMP/source" init -q
git -C "$TMP/source" config user.email fixture@example.invalid
git -C "$TMP/source" config user.name Fixture
git -C "$TMP/source" config uploadpack.allowFilter true
git -C "$TMP/source" config init.defaultBranch main
printf 'first source revision\n' > "$TMP/source/source.txt"
git -C "$TMP/source" add source.txt
git -C "$TMP/source" commit -qm first
printf 'second source revision\n' > "$TMP/source/source.txt"
git -C "$TMP/source" commit -qam second
printf 'pinned source\n' > "$TMP/source/source.txt"
mkdir -p "$TMP/source/nested"
printf 'pinned nested source\n' > "$TMP/source/nested/needed.txt"
printf 'unneeded source\n' > "$TMP/source/unrelated.txt"
git -C "$TMP/source" add nested/needed.txt unrelated.txt
git -C "$TMP/source" commit -qam pinned
PIN="$(git -C "$TMP/source" rev-parse HEAD)"
printf 'third_party/fixture\tfile://%s\t%s\tsource.txt nested/needed.txt\n' "$TMP/source" "$PIN" > "$TMP/children.tsv"
mkdir -p "$TMP/chromium/third_party"
git -C "$TMP/chromium" init -q
git -C "$TMP/chromium" config user.email fixture@example.invalid
git -C "$TMP/chromium" config user.name Fixture

if "$SCRIPT" --root "$TMP/chromium" --manifest "$TMP/children.tsv" >"$TMP/fetch.log" 2>&1; then
  :
else
  fail "pinned child source fetch failed: $(cat "$TMP/fetch.log")"
fi
[[ "$(git -C "$TMP/chromium/third_party/fixture" rev-parse HEAD)" == "$PIN" ]] || fail "child checkout did not match its pinned revision"
[[ "$(git -C "$TMP/chromium/third_party/fixture" rev-parse --is-shallow-repository)" == true ]] || fail "child checkout fetched unbounded history"
if git -C "$TMP/chromium/third_party/fixture" show-ref --verify --quiet refs/remotes/origin/main; then fail "child fetch downloaded the remote default branch"; fi
grep -q 'pinned source' "$TMP/chromium/third_party/fixture/source.txt" || fail "child source contents were not fetched"
grep -q 'pinned nested source' "$TMP/chromium/third_party/fixture/nested/needed.txt" || fail "nested child source contents were not fetched"
[[ ! -e "$TMP/chromium/third_party/fixture/unrelated.txt" ]] || fail "child checkout included unrelated source"

printf 'third_party/fixture\tfile://%s\twrong-revision\tsource.txt\n' "$TMP/source" > "$TMP/wrong.tsv"
mkdir -p "$TMP/chromium-wrong"
git -C "$TMP/chromium-wrong" init -q
if "$SCRIPT" --root "$TMP/chromium-wrong" --manifest "$TMP/wrong.tsv" >"$TMP/wrong.log" 2>&1; then fail "unavailable child revision unexpectedly passed"; fi
grep -q 'child source revision fetch failed' "$TMP/wrong.log" || fail "unavailable revision diagnostic missing"

echo "Thorium child source tests passed"
