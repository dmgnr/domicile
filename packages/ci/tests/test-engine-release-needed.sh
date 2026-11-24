#!/usr/bin/env bash
# Asserts what the engine job decides a pull request still owes for a release.
#
# Three states:
#
#   - `engine-release.nix` already names this series: nothing to do. This is
#     most pull requests.
#   - A release for this series is already published (a re-run, or a
#     force-push or rebase that kept the series): regenerate the file and push
#     it. No build.
#   - Nothing is published: build, publish, regenerate, push.
#
# Both errors are costly: a needless build takes four hours, and skipping a
# needed one ships an engine the repository does not describe (#411).
#
# The GitHub API is faked; the decision is under test.
#
# Rewrites the checkout's engine-release.nix while it runs.
# check-runner: alone
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
NEEDED="$ROOT/.github/scripts/engine-release-needed.sh"
[ -x "$NEEDED" ] || { echo "no $NEEDED" >&2; exit 1; }

command -v jq >/dev/null 2>&1 || {
  echo "SKIP: no jq, which this script reads the API with"
  exit 77
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FAILED=0
expect() {
  local what="$1" want="$2" got="$3"
  if [ "$got" = "$want" ]; then
    printf '  ok    %s\n' "$what"
  else
    printf '  FAIL  %s\n    wanted: %s\n    got:    %s\n' "$what" "$want" "$got"
    FAILED=$((FAILED + 1))
  fi
}

BIN="$WORK/bin"
mkdir -p "$BIN"
# Fake GitHub API: a release exists iff `$FAKE_STATE` names it. Exits 22 for a
# missing release, as the real `curl -f` does.
cat > "$BIN/curl" <<'FAKE'
#!/usr/bin/env bash
url="${!#}"
echo "$url" >>"$FAKE_STATE.calls"
tag="${url##*/}"
if [ "$tag" = "$(cat "$FAKE_STATE" 2>/dev/null)" ]; then
  printf '{"tag_name":"%s"}\n' "$tag"
  exit 0
fi
exit 22
FAKE
chmod +x "$BIN/curl"

IDENTITY="$(cd "$ROOT" && .github/scripts/engine-series-stamp.sh identity)"
TAG="engine-s${IDENTITY:0:12}"

# Runs against the real checkout, since "this series" is computed from it.
# Restores `engine-release.nix` after each case.
RELEASE="$ROOT/packages/domicile-engine/engine-release.nix"
cp "$RELEASE" "$WORK/engine-release.nix.orig"
restore() { cp "$WORK/engine-release.nix.orig" "$RELEASE"; }
trap 'restore; rm -rf "$WORK"' EXIT

pins() { # identity to write into the generated file
  sed -i "s/^  identity = \".*\";/  identity = \"$1\";/" "$RELEASE"
}

needed() { # published tag the fake API holds, or empty for none
  local out
  out="$WORK/gh-output"
  : >"$out"
  printf '%s' "$1" >"$WORK/published"
  ( cd "$ROOT" && env PATH="$BIN:$PATH" FAKE_STATE="$WORK/published" \
      GITHUB_OUTPUT="$out" GITHUB_TOKEN=fake \
      GITHUB_REPOSITORY=cprussin/domicile \
      "$NEEDED" ) >"$WORK/said" 2>&1
  cat "$out"
}
key() { sed -n "s/^$2=//p" <<<"$1" | head -1; }

echo "== the fork did not move =="

restore
pins "$IDENTITY"
out="$(needed "$TAG")"
expect "nothing to build" false "$(key "$out" build)"
expect "and nothing to write" false "$(key "$out" write)"

# The file already names this series, so the script must not query the API.
# A wrong answer would rebuild Chromium for a pull request that does not change
# the fork.
out="$(needed "")"
expect "even when the API cannot find the release, there is nothing to do" \
  false "$(key "$out" build)"

echo
echo "== the fork moved and nothing is published =="

restore
pins "0000000000000000000000000000000000000000000000000000000000000000"
out="$(needed "")"
expect "the release has to be built" true "$(key "$out" build)"
expect "and written back" true "$(key "$out" write)"
expect "under the tag this series names" "$TAG" "$(key "$out" tag)"
expect "and the identity is stated in full" "$IDENTITY" "$(key "$out" identity)"
expect "the builds repository is asked, not this one" \
  "https://api.github.com/repos/cprussin/domicile-builds/releases/tags/$TAG" \
  "$(tail -1 "$WORK/published.calls")"

echo
echo "== the fork moved and this series is already published =="

# A rebuild would take four hours and produce a different tarball, since
# Chromium builds are not reproducible, and the published hash is already in
# use.
restore
pins "0000000000000000000000000000000000000000000000000000000000000000"
out="$(needed "$TAG")"
expect "there is nothing to build" false "$(key "$out" build)"
expect "but the file still has to be written back" true "$(key "$out" write)"

echo
if [ "$FAILED" -eq 0 ]; then
  echo "engine-release-needed: all cases passed"
else
  echo "engine-release-needed: $FAILED case(s) failed"
fi
exit "$FAILED"
