#!/usr/bin/env bash
# Tests `builds-prune.sh`, which deletes old engine and package builds but
# keeps every engine a branch, a release or an open pull request pins.
#
# Runs against a `gh` that answers from files in `$GH` and logs deletes.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
PRUNE="$ROOT/.github/scripts/builds-prune.sh"
[ -x "$PRUNE" ] || { echo "no $PRUNE" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FAILED=0
ok() { printf '  ok    %s\n' "$1"; }
fail() {
  printf '  FAIL  %s\n    %s\n' "$1" "$2"
  FAILED=$((FAILED + 1))
}
deleted() { # what, tag
  grep -qxF "DELETE repos/$REPO/releases/id-$2" "$WORK/log" &&
    grep -qxF "DELETE repos/$REPO/git/refs/tags/$2" "$WORK/log" &&
    ok "$1" || fail "$1" "$2 and its tag were not deleted: $(cat "$WORK/log")"
}
kept() { # what, tag
  grep -q "/id-$2\$\|/tags/$2\$" "$WORK/log" &&
    fail "$1" "$2 was deleted" || ok "$1"
}

# A `gh` answering from files.
#   $GH/releases           `id-<tag>\t<tag>\t<created>\t<draft>` lines of the
#                          pruned repository
#   $GH/release-tags       the `release-*` refs
#   $GH/pulls              open pull requests' head commits
#   $GH/pin-<ref>          both engine-*.nix files at <ref>, `/` as `_`
GH="$WORK/gh"
mkdir -p "$WORK/bin" "$GH"
cat >"$WORK/bin/gh" <<'FAKE'
#!/usr/bin/env bash
url="${!#}"
case "$*" in
  ("api -X DELETE "*) echo "DELETE $4" >>"$GH_LOG" ;;
  (*"/git/matching-refs/tags/release-"*) cat "$GH/release-tags" ;;
  (*"/pulls?state=open"*) cat "$GH/pulls" ;;
  (*"/contents/"*)
    ref="${url##*ref=}"
    ref="${ref//\//_}"
    [ -f "$GH/pin-$ref" ] || { echo "no file at $ref" >&2; exit 1; }
    cat "$GH/pin-$ref"
    ;;
  (*"/releases?"*) cat "$GH/releases" ;;
  (*) echo "unexpected: gh $*" >&2; exit 1 ;;
esac
FAKE
chmod +x "$WORK/bin/gh"

pin() { # ref, release tag it pins in $REPO
  printf '  url = "https://github.com/%s/releases/download/%s/engine.tar.zst";\n' \
    "$REPO" "$2" >"$GH/pin-${1//\//_}"
}

NOW="$(date -u -d 2026-11-20T00:00:00Z +%s)"
prune() { # repository, days
  : >"$WORK/log"
  PATH="$WORK/bin:$PATH" GH="$GH" GH_LOG="$WORK/log" GH_TOKEN=fake \
    GITHUB_REPOSITORY=cprussin/domicile DOMICILE_BUILDS_NOW="$NOW" \
    bash "$PRUNE" "$1" "$2" 2>&1
}

echo "the builds repository keeps a week, the rolling releases and every pin"
REPO=cprussin/domicile-builds
printf '%s\n' refs/tags/release-20261110-000000 >"$GH/release-tags"
printf '%s\n' abc123 >"$GH/pulls"
pin main engine-s-main
pin stable engine-official-s-stable
pin refs/tags/release-20261110-000000 engine-official-s-release
pin abc123 engine-s-pr
{
  for tag in engine-s-main engine-official-s-stable engine-official-s-release \
    engine-s-pr engine-s-old packages-latest engine-nightly engine-official-nightly \
    engine-v1.0.0 domicile@1.0.0; do
    printf 'id-%s\t%s\t2026-11-01T00:00:00Z\tfalse\n' "$tag" "$tag"
  done
  printf 'id-%s\t%s\t2026-11-15T00:00:00Z\tfalse\n' engine-s-recent engine-s-recent
  # Two drafts under one tag name, which has no tag.
  printf 'id-%s\t%s\t2026-10-01T00:00:00Z\ttrue\n' draft-a engine-s-draft draft-b engine-s-draft
} >"$GH/releases"
if out="$(prune "$REPO" 7)"; then ok "the prune succeeds"; else fail "the prune succeeds" "$out"; fi
deleted "an old unpinned engine is deleted" engine-s-old
for tag in engine-s-main engine-official-s-stable engine-official-s-release engine-s-pr; do
  kept "$tag, which a ref pins, is kept" "$tag"
done
for tag in packages-latest engine-nightly engine-official-nightly; do
  kept "the rolling $tag is kept" "$tag"
done
kept "a pushed engine tag is kept" engine-v1.0.0
kept "a release that is not a build is never touched" domicile@1.0.0
kept "a build from this week is kept" engine-s-recent

echo "this repository's old builds all go, but for pins"
REPO=cprussin/domicile
pin main engine-s-main
pin stable engine-official-s-stable
pin refs/tags/release-20261110-000000 engine-official-s-release
pin abc123 engine-s-pr
if out="$(prune "$REPO" 2)"; then ok "the prune succeeds"; else fail "the prune succeeds" "$out"; fi
for tag in engine-s-old engine-s-recent packages-latest engine-nightly engine-official-nightly; do
  deleted "$tag is deleted" "$tag"
done
for tag in engine-s-main engine-official-s-stable engine-official-s-release engine-s-pr; do
  kept "$tag, which a ref pins, is kept" "$tag"
done
kept "a pushed engine tag is kept" engine-v1.0.0
kept "a release that is not a build is never touched" domicile@1.0.0

echo "drafts are deleted one by one, and have no tag to delete"
for id in draft-a draft-b; do
  grep -qxF "DELETE repos/$REPO/releases/id-$id" "$WORK/log" &&
    ok "draft $id is deleted" || fail "draft $id is deleted" "$(cat "$WORK/log")"
done
grep -q "tags/engine-s-draft" "$WORK/log" &&
  fail "no tag is deleted for a draft" "$(cat "$WORK/log")" || ok "no tag is deleted for a draft"

echo "a pin that cannot be read stops the prune before it deletes anything"
rm "$GH/pin-stable"
if out="$(prune "$REPO" 0)"; then
  fail "the prune fails" "it succeeded: $out"
else
  ok "the prune fails"
fi
[ ! -s "$WORK/log" ] && ok "and deletes nothing" || fail "and deletes nothing" "$(cat "$WORK/log")"

echo "open pull requests that cannot be listed stop the prune too"
pin stable engine-official-s-stable
mv "$GH/pulls" "$GH/pulls.gone"
if out="$(prune "$REPO" 0)"; then
  fail "the prune fails" "it succeeded: $out"
else
  ok "the prune fails"
fi
[ ! -s "$WORK/log" ] && ok "and deletes nothing" || fail "and deletes nothing" "$(cat "$WORK/log")"

if [ "$FAILED" -gt 0 ]; then
  echo "$FAILED failed"
  exit 1
fi
echo "all ok"
