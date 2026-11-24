#!/usr/bin/env bash
# Asserts a published engine stays fetchable after the next one is published.
#
# The release run deletes and recreates `engine-nightly`, so a pin to its asset
# breaks on every new build. The publisher also creates a release per series
# that is never deleted; this checks it stays in place.
#
# Runs against a fake GitHub that records every request, since a test against
# the real API would publish.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
PUBLISH="$ROOT/.github/scripts/engine-release-publish.sh"
[ -f "$PUBLISH" ] || { echo "no $PUBLISH" >&2; exit 1; }

# `check-runner` reads the skip reason from a `SKIP:` line on stdout. Printed any
# other way, `DOMICILE_CHECK_STRICT=1` reports an empty `FAILED ()`.
command -v jq >/dev/null 2>&1 || {
  echo "SKIP: no jq, which both the publisher and the fake GitHub here parse with"
  exit 77
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

BIN="$WORK/bin"
mkdir -p "$BIN"

# The packaging step's output: a tarball and its digest. The publisher uploads
# them without reading them.
STAGE="$WORK/stage"
TARBALL="domicile-engine-deadbee-linux-x64.tar.zst"
mkdir -p "$STAGE"
echo "not really a tarball" > "$STAGE/$TARBALL"
echo "not really a digest" > "$STAGE/$TARBALL.sha256"

cat > "$BIN/curl" <<'FAKE'
#!/usr/bin/env bash
# Fake GitHub API. Appends each call to `$STATE/calls` as `<METHOD> <url>`; a
# release exists iff `$STATE/rel-<tag>` does. Mimics curl: `-o <file> -w
# '%{http_code}'` writes the body and prints the status, and `-f` exits 22 on
# >= 400.
set -u
state="$FAKE_STATE"
method=GET; url=""; data=""; upload=""; out=""; code_out=0; fail_flag=0
prev=""
for arg in "$@"; do
  case "$prev" in
    -X) method="$arg" ;;
    -d) data="$arg" ;;
    -o) out="$arg" ;;
    -w) code_out=1 ;;
  esac
  case "$arg" in
    http*) url="$arg" ;;
    -f) fail_flag=1 ;;
    @-) [ "$prev" = "-d" ] && data="$(cat)" ;;
    @*) [ "$prev" = "--data-binary" ] && upload="${arg#@}" ;;
  esac
  prev="$arg"
done
echo "$method $url" >> "$state/calls"

if [ -n "$upload" ]; then
  # `.../releases/<id>/assets?name=<file>`
  id="${url#*/releases/}"; id="${id%%/assets*}"
  name="${url##*name=}"
  # GitHub can drop an upload: it records the asset in state `starter`,
  # answers 500, and then rejects the next POST for that name with 422
  # `already_exists`, so a plain retry fails. `$STATE/fail-uploads` is how many
  # of the next uploads behave this way.
  left="$(cat "$state/fail-uploads" 2>/dev/null || echo 0)"
  if [ "$left" -gt 0 ]; then
    echo "$((left - 1))" > "$state/fail-uploads"
    echo "$id $name starter" >> "$state/assets"
    exit 22
  fi
  echo "$id $name uploaded" >> "$state/assets"
  exit 0
fi

status=200
respond() {
  case "$method" in
    GET)
      case "$url" in
        # The release's assets, with ids the DELETE below can parse back into
        # release and name.
        (*/assets)
          id="${url#*/releases/}"; id="${id%%/assets}"
          awk -v id="$id" '$1 == id { print $2, $3 }' "$state/assets" |
            jq -R -s -c --arg id "$id" \
              'split("\n") | map(select(length > 0)) | map(split(" ")) |
               map({id: ($id + "!" + .[0]), name: .[0], state: .[1]})'
          ;;
        (*)
          tag="${url##*/}"
          if [ -f "$state/rel-$tag" ]; then
            cat "$state/rel-$tag"
          else
            status=404; echo '{"message":"Not Found"}'
          fi
          ;;
      esac
      ;;
    POST)
      tag="$(printf '%s' "$data" | jq -r .tag_name)"
      # A tag that already has a release is 422, as on GitHub.
      if [ -f "$state/rel-$tag" ]; then
        status=422; echo '{"message":"Validation Failed","errors":[{"code":"already_exists"}]}'
        return
      fi
      printf '%s' "$data" > "$state/created-$tag.json"
      jq -n --arg tag "$tag" \
        '{id: ("id-" + $tag), html_url: ("https://example.invalid/" + $tag)}' \
        > "$state/rel-$tag"
      cat "$state/rel-$tag"
      ;;
    DELETE)
      case "$url" in
        (*/releases/assets/*)
          asset="${url##*/releases/assets/}"
          echo "${asset#*!}" >> "$state/deleted-assets"
          awk -v rel="${asset%%!*}" -v name="${asset#*!}" \
            '!($1 == rel && $2 == name)' "$state/assets" > "$state/left"
          mv "$state/left" "$state/assets"
          ;;
        # By id, which the fake derives from the tag.
        (*)
          id="${url##*/}"
          echo "${id#id-}" >> "$state/deleted"
          rm -f "$state/rel-${id#id-}"
          # Deleting a release deletes its assets.
          awk -v rel="$id" '$1 != rel' "$state/assets" > "$state/left"
          mv "$state/left" "$state/assets"
          ;;
      esac
      ;;
  esac
}

# Injected failures. `$STATE/fail-<METHOD>` holds one answer per line for the
# next calls of that method: `500`, `403rl` (secondary rate limit), `500+` (the
# call succeeds but answers 500), or `000` (no connection: prints 000, exits
# 28).
answer=""
if [ -s "$state/fail-$method" ]; then
  answer="$(head -1 "$state/fail-$method")"
  sed -i 1d "$state/fail-$method"
fi
case "$answer" in
  (500) status=500; echo '{"message":"Server Error"}' > "$state/body" ;;
  (403rl) status=403
    echo '{"message":"You have exceeded a secondary rate limit."}' > "$state/body" ;;
  (500+) respond > "$state/body"; status=500 ;;
  (000) status=000; : > "$state/body" ;;
  ("") respond > "$state/body" ;;
esac

if [ -n "$out" ]; then
  cp "$state/body" "$out"
  [ "$code_out" = 0 ] || printf '%s' "$status"
  if [ "$status" = 000 ]; then
    echo "curl: (28) Connection timed out after 300002 milliseconds" >&2
    exit 28
  fi
elif [ "$fail_flag" = 1 ] && [ "$status" -ge 400 ]; then
  exit 22
else
  cat "$state/body"
fi
FAKE
chmod +x "$BIN/curl"

# Skip the publisher's backoff between retries.
cat > "$BIN/sleep" <<'NAP'
#!/usr/bin/env bash
exit 0
NAP
chmod +x "$BIN/sleep"

# The immutable tag is named after the series identity: a hash of the pin,
# `patches/` and `src/`. Commits that do not change the fork publish to the
# same tag and need no repin.
#
# Read from `engine-series-stamp.sh` instead of computed here, so there is one
# definition of "the same series".
IDENTITY="$(cd "$ROOT" && .github/scripts/engine-series-stamp.sh identity)"
PINNABLE="engine-s${IDENTITY:0:12}"

FAILED=0
fail() { echo "  FAIL: $*" >&2; FAILED=1; }

# Runs the publisher against a fake. `$1` is the state directory, which a
# caller can pre-seed with existing releases.
publish() {
  local state="$1"; shift
  mkdir -p "$state"
  # Create the ledgers only if missing, to keep a caller's pre-seeded state.
  for ledger in calls assets deleted deleted-assets; do
    [ -f "$state/$ledger" ] || : > "$state/$ledger"
  done
  # `env`, not a bare prefix: assignments that come from `"$@"` expansion are
  # parsed as a command name, not as assignments.
  ( cd "$ROOT" && env PATH="$BIN:$PATH" FAKE_STATE="$state" \
      DOMICILE_BUILDS_TOKEN=fake GITHUB_REPOSITORY=cprussin/domicile \
      GITHUB_SHA=0123456789abcdef0123456789abcdef01234567 \
      "$@" bash "$PUBLISH" "$STAGE" "$TARBALL" ) > "$state/out" 2>&1
}

echo "a nightly publishes a release that is never replaced"
state="$WORK/nightly"
publish "$state" || { cat "$state/out" >&2; fail "publisher exited nonzero"; }

[ -f "$state/created-engine-nightly.json" ] ||
  fail "no engine-nightly was created"
[ -f "$state/created-$PINNABLE.json" ] ||
  fail "no $PINNABLE was created; a pin would point at the rolling tag"

# Both assets on both releases. An empty immutable release would 404.
for release in engine-nightly "$PINNABLE"; do
  count="$(grep -c "^id-$release " "$state/assets" || true)"
  [ "$count" = "2" ] ||
    fail "$release got $count assets, wanted the tarball and its digest"
done

# The rolling release names the immutable one holding the same build.
body="$(jq -r .body "$state/created-engine-nightly.json")"
case "$body" in
  (*"immutable release: \`$PINNABLE\`"*) ;;
  (*) fail "engine-nightly's body does not name $PINNABLE" ;;
esac

# And states the full series identity, not the 12-character prefix in the tag.
# `update-engine-release.sh` writes it into `engine-release.nix`, where it is
# compared against the current series.
case "$body" in
  (*"series identity: \`$IDENTITY\`"*) ;;
  (*) fail "engine-nightly's body does not state the series identity" ;;
esac

echo "builds go to the builds repository, so this one's watchers are not notified"
grep -v -q '/repos/cprussin/domicile-builds/' "$state/calls" &&
  fail "a call went somewhere other than the builds repository: $(grep -v '/repos/cprussin/domicile-builds/' "$state/calls" | head -1)"
# This repository's commits are not in the builds repository.
jq -e 'has("target_commitish")' "$state/created-engine-nightly.json" >/dev/null &&
  fail "the release targets a commit the builds repository does not have"
case "$body" in
  (*"domicile commit: \`0123456789abcdef0123456789abcdef01234567\`"*) ;;
  (*) fail "engine-nightly's body does not name the commit it was built from" ;;
esac

echo "without the builds token the publisher fails before calling GitHub"
notoken="$WORK/notoken"
publish "$notoken" DOMICILE_BUILDS_TOKEN= &&
  fail "the publisher exited 0 without DOMICILE_BUILDS_TOKEN"
[ -s "$notoken/calls" ] && fail "the publisher called GitHub without a token"

echo "publishing again leaves an already published commit alone"
# Something may already be pinned to the immutable release. A re-run for the
# same commit must not delete or recreate it.
again="$WORK/again"
mkdir -p "$again"
cp "$state/rel-engine-nightly" "$state/rel-$PINNABLE" "$again/" 2>/dev/null
printf '%s\n%s\n' "id-$PINNABLE $TARBALL uploaded" \
                   "id-$PINNABLE $TARBALL.sha256 uploaded" > "$again/assets"
publish "$again" || { cat "$again/out" >&2; fail "publisher exited nonzero"; }
grep -qx "$PINNABLE" "$again/deleted" &&
  fail "$PINNABLE was deleted; a pin to it would have broken"
[ -f "$again/created-$PINNABLE.json" ] &&
  fail "$PINNABLE was recreated rather than left alone"
grep -q "^id-$PINNABLE " "$again/deleted-assets" 2>/dev/null &&
  fail "an asset was taken off $PINNABLE; a pin to it would have broken"
grep -qx "engine-nightly" "$again/deleted" ||
  fail "engine-nightly was not replaced; it must always mean the newest build"

echo "a release whose upload died is finished, not skipped"
# An upload can hang after the release is created. A release counts as
# published when its assets are uploaded, not when it exists, so the publisher
# finishes it.
half="$WORK/half"
mkdir -p "$half"
cp "$state/rel-engine-nightly" "$state/rel-$PINNABLE" "$half/" 2>/dev/null
# The digest uploaded; the tarball upload did not finish.
printf '%s\n%s\n' "id-$PINNABLE $TARBALL starter" \
                   "id-$PINNABLE $TARBALL.sha256 uploaded" > "$half/assets"
publish "$half" || { cat "$half/out" >&2; fail "publisher exited nonzero"; }

[ -f "$half/created-$PINNABLE.json" ] &&
  fail "$PINNABLE was recreated rather than finished"
grep -q "^id-$PINNABLE $TARBALL uploaded$" "$half/assets" ||
  fail "$PINNABLE never got its tarball"
grep -qx "$TARBALL" "$half/deleted-assets" ||
  fail "the half-uploaded tarball was counted as present and left in place"
grep -qx "$TARBALL.sha256" "$half/deleted-assets" &&
  fail "the digest was already there and should not have been touched"

echo "a pushed tag is published once, under the name that was pushed"
# An `engine-v*` tag is already immutable, so no second copy is published.
tagged="$WORK/tagged"
publish "$tagged" GITHUB_REF_TYPE=tag GITHUB_REF_NAME=engine-v1.2.3 ||
  { cat "$tagged/out" >&2; fail "publisher exited nonzero"; }
[ -f "$tagged/created-engine-v1.2.3.json" ] ||
  fail "the pushed tag was not published"
[ -f "$tagged/created-$PINNABLE.json" ] &&
  fail "a pushed tag was copied to $PINNABLE"
case "$(jq -r .body "$tagged/created-engine-v1.2.3.json")" in
  (*"immutable release"*) fail "a pushed tag points at an immutable release that is itself" ;;
esac
# A pushed tag's release must not be deleted: others may point at it.
grep -q . "$tagged/deleted" 2>/dev/null &&
  fail "a pushed tag's release was deleted: $(cat "$tagged/deleted")"

echo "the official build publishes beside the checked one, not over it"
# Both builds share a series, so they need separate names or each replaces the
# other.
official="$WORK/official"
publish "$official" DOMICILE_ENGINE_BUILD=official ||
  { cat "$official/out" >&2; fail "publisher exited nonzero"; }
for release in engine-official-nightly "engine-official-s${IDENTITY:0:12}"; do
  [ -f "$official/created-$release.json" ] ||
    fail "the official build did not publish $release"
done
for release in engine-nightly "$PINNABLE"; do
  [ -f "$official/created-$release.json" ] &&
    fail "the official build published over the checked build's $release"
  grep -qx "$release" "$official/deleted" 2>/dev/null &&
    fail "the official build deleted the checked build's $release"
done

echo "an upload GitHub drops is tried again"
# A dropped upload is retried, since otherwise a whole engine build is lost to
# one 500.
dropped="$WORK/dropped"
mkdir -p "$dropped"
echo 1 > "$dropped/fail-uploads"
publish "$dropped" || { cat "$dropped/out" >&2; fail "publisher exited nonzero"; }

for release in engine-nightly "$PINNABLE"; do
  count="$(grep -c "^id-$release " "$dropped/assets" || true)"
  [ "$count" = "2" ] ||
    fail "$release got $count assets after a dropped upload, wanted 2"
done

# The dropped asset is deleted before retrying. GitHub keeps it, and each POST
# for that name is 422 `already_exists` until it is gone.
grep -qx "$TARBALL" "$dropped/deleted-assets" ||
  fail "the dropped upload's asset was left on the release"

echo "a 500, a secondary rate limit or no answer at all from the API is tried again"
# A single 500 or timeout on create must not lose a finished build.
flaky="$WORK/flaky"
mkdir -p "$flaky"
printf '%s\n' 500 403rl 000 > "$flaky/fail-POST"
publish "$flaky" || { cat "$flaky/out" >&2; fail "publisher exited nonzero"; }
for release in engine-nightly "$PINNABLE"; do
  count="$(grep -c "^id-$release .* uploaded$" "$flaky/assets" || true)"
  [ "$count" = "2" ] ||
    fail "$release got $count assets after a flaky create, wanted 2"
done

echo "a release a 500 created anyway is used, not made twice"
# The POST can succeed and still answer 500. The retry then gets 422
# `already_exists` and uses the existing release.
landed="$WORK/landed"
mkdir -p "$landed"
echo 500+ > "$landed/fail-POST"
publish "$landed" || { cat "$landed/out" >&2; fail "publisher exited nonzero"; }
for release in engine-nightly "$PINNABLE"; do
  count="$(grep -c "^id-$release .* uploaded$" "$landed/assets" || true)"
  [ "$count" = "2" ] ||
    fail "$release got $count assets after a create that landed behind a 500, wanted 2"
done

echo "an API that keeps failing fails the run, after a bounded number of tries"
down="$WORK/down"
mkdir -p "$down"
printf '500\n%.0s' $(seq 20) > "$down/fail-POST"
if publish "$down"; then
  fail "the publisher exited 0 with GitHub answering 500 to every create"
fi
posts="$(grep -c '^POST https://api.github.com/.*/releases$' "$down/calls" || true)"
[ "$posts" = "5" ] ||
  fail "the create was tried $posts times, wanted 5"
grep -q 'uploads.github.com' "$down/calls" &&
  fail "an asset was uploaded with no release to put it on"
grep -q '500' "$down/out" ||
  fail "the failure does not say GitHub answered 500: $(cat "$down/out")"

[ "$FAILED" = "0" ] || exit 1
echo "engine-release-publish: a published engine stays fetchable"
