#!/usr/bin/env bash
# Tests `distro-packages-publish.sh`, which publishes the distribution packages
# of a commit stable.yml promoted as the builds repository's `packages-latest`.
#
# Runs the script in a scratch repository with a `gh` that records its
# arguments and answers from files in `$WORK/gh`.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
PUBLISH="$ROOT/.github/scripts/distro-packages-publish.sh"
[ -x "$PUBLISH" ] || { echo "no $PUBLISH" >&2; exit 1; }

command -v git >/dev/null 2>&1 || { echo "  SKIP: no git"; exit 77; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FAILED=0
ok() { printf '  ok    %s\n' "$1"; }
fail() {
  printf '  FAIL  %s\n    %s\n' "$1" "$2"
  FAILED=$((FAILED + 1))
}
contains() { # what, needle, hay
  case "$3" in
    (*"$2"*) ok "$1" ;;
    (*) fail "$1" "expected: $2  in: $3" ;;
  esac
}
lacks() { # what, needle, hay
  case "$3" in
    (*"$2"*) fail "$1" "unexpected: $2  in: $3" ;;
    (*) ok "$1" ;;
  esac
}
before() { # what, first, second, hay
  local first second
  first="$(printf '%s\n' "$4" | grep -nF -- "$2" | head -1 | cut -d: -f1)"
  second="$(printf '%s\n' "$4" | grep -nF -- "$3" | head -1 | cut -d: -f1)"
  if [ -n "$first" ] && [ -n "$second" ] && [ "$first" -lt "$second" ]; then
    ok "$1"
  else
    fail "$1" "expected $2 before $3 in: $4"
  fi
}

# A `gh` that logs each call, and each SHA256SUMS it is handed.
#   $GH/exists          `release view packages-latest` succeeds
#   $GH/assets          the asset names of packages-latest
#   $GH/body            its notes
#   $GH/compare         the status of the promoted commit against the one it names
GH="$WORK/gh"
mkdir -p "$WORK/bin"
cat >"$WORK/bin/gh" <<'FAKE'
#!/usr/bin/env bash
echo "gh $*" >>"$GH_LOG"
for arg in "$@"; do
  case "$arg" in
    (*/SHA256SUMS) sed 's/^/sums: /' "$arg" >>"$GH_LOG" ;;
  esac
done
case "$1 $2" in
  ("release view")
    [ -e "$GH/exists" ] || exit 1
    case "$*" in
      (*"--json assets"*) cat "$GH/assets" ;;
      (*"--json body"*) cat "$GH/body" ;;
    esac
    ;;
  ("api repos/cprussin/domicile/compare/"*) cat "$GH/compare" ;;
esac
FAKE
chmod +x "$WORK/bin/gh"

# A repository whose pins are of these two series.
REPO="$WORK/repo"
setup() { # checked series, official series
  rm -rf "$REPO" "$GH"
  mkdir -p "$GH"
  git init -q -b main "$REPO"
  git -C "$REPO" config user.email ci@domicile.invalid
  git -C "$REPO" config user.name "domicile CI"
  mkdir -p "$REPO/.github/scripts" "$REPO/packages/domicile-engine"
  cp "$PUBLISH" "$REPO/.github/scripts/"
  printf '{\n  identity = "%s";\n}\n' "$1" >"$REPO/packages/domicile-engine/engine-release.nix"
  printf '{\n  identity = "%s";\n}\n' "$2" >"$REPO/packages/domicile-engine/engine-official.nix"
  git -C "$REPO" add -A
  git -C "$REPO" commit -qm pins
}

# What `packages/distro/build.sh` writes.
PACKAGES="$WORK/packages"
mkdir -p "$PACKAGES"
V=0.20261013.120000
for file in "domicile_${V}_amd64.deb" "domicile_${V}_amd64.noapparmor.deb" \
  "domicile-$V-1.fedora.x86_64.rpm" "domicile-$V-1.opensuse.x86_64.rpm" \
  "domicile-$V-1-x86_64.pkg.tar.zst"; do
  echo "$file" >"$PACKAGES/$file"
done
touch "$PACKAGES/SHA256SUMS"
STABLE="domicile_amd64.deb domicile_amd64.noapparmor.deb domicile-fedora.x86_64.rpm domicile-opensuse.x86_64.rpm domicile-x86_64.pkg.tar.zst"

publish() {
  : >"$WORK/log"
  (cd "$REPO" && PATH="$WORK/bin:$PATH" GH_LOG="$WORK/log" GH="$GH" \
    GITHUB_REPOSITORY=cprussin/domicile GH_TOKEN=fake \
    bash .github/scripts/distro-packages-publish.sh "$PACKAGES" 2>&1)
}

echo "a commit with the official engine is released as packages-latest"
setup aaaa aaaa
head="$(git -C "$REPO" rev-parse HEAD)"
if out="$(publish)"; then ok "the publish succeeds"; else fail "the publish succeeds" "$out"; fi
log="$(cat "$WORK/log")"
contains "in the builds repository, so this one's watchers hear nothing" \
  "gh release create packages-latest --repo cprussin/domicile-builds" "$log"
lacks "and no release per commit" "packages-${head:0:12}" "$log"
lacks "at no commit of this repository, which the builds repository lacks" "--target" "$log"
contains "not marked latest" "--latest=false" "$log"
contains "naming the commit it was built from" "built from \`$head\`" "$log"
contains "naming the package for Debian 12 and Ubuntu 22.04" \
  'Debian 12 and Ubuntu 22.04: `domicile_amd64.noapparmor.deb`' "$log"
for name in $STABLE; do
  contains "with $name" "/$name" "$log"
  contains "summed under that name" "  $name" "$log"
done

echo "a newer commit replaces the assets of packages-latest"
touch "$GH/exists"
old=0123456789abcdef0123456789abcdef01234567
printf 'The newest Domicile packages, built from `%s` with the official engine\n' "$old" >"$GH/body"
echo ahead >"$GH/compare"
printf '%s\n' domicile_amd64.deb domicile_old.deb SHA256SUMS >"$GH/assets"
if out="$(publish)"; then ok "the publish succeeds"; else fail "the publish succeeds" "$out"; fi
log="$(cat "$WORK/log")"
contains "compared with the commit packages-latest names" \
  "gh api repos/cprussin/domicile/compare/$old...$head" "$log"
upload="$(printf '%s\n' "$log" | grep 'release upload packages-latest')"
contains "uploaded over the same names" \
  "gh release upload packages-latest --repo cprussin/domicile-builds --clobber" "$upload"
for name in $STABLE; do
  contains "with $name" "/$name" "$upload"
done
contains "SHA256SUMS last" "/SHA256SUMS" "${upload##* }"
contains "an asset it no longer has is deleted" \
  "gh release delete-asset packages-latest domicile_old.deb --repo cprussin/domicile-builds --yes" "$log"
lacks "and no other" "delete-asset packages-latest domicile_amd64.deb" "$log"
before "after the upload" "release upload packages-latest" "delete-asset" "$log"
edit="$(printf '%s\n' "$log" | sed -n '/release edit packages-latest/,$p')"
contains "the notes name the new commit" "built from \`$head\`" "$edit"

echo "the same commit publishes again"
echo identical >"$GH/compare"
if out="$(publish)"; then ok "the publish succeeds"; else fail "the publish succeeds" "$out"; fi
contains "uploading its assets again" "gh release upload packages-latest" "$(cat "$WORK/log")"

echo "an older commit publishing late leaves packages-latest alone"
echo behind >"$GH/compare"
if out="$(publish)"; then ok "the publish succeeds"; else fail "the publish succeeds" "$out"; fi
log="$(cat "$WORK/log")"
lacks "packages-latest gets no assets" "release upload packages-latest" "$log"
lacks "or notes" "release edit" "$log"
contains "saying why" "older than" "$out"

echo "a commit off packages-latest's history is refused"
echo diverged >"$GH/compare"
if out="$(publish)"; then
  fail "the publish fails" "it succeeded: $out"
else
  contains "the publish fails, saying why" "diverged" "$out"
fi
lacks "packages-latest is untouched" "release upload packages-latest" "$(cat "$WORK/log")"

echo "notes that name no commit fail loudly"
echo "no commit here" >"$GH/body"
if out="$(publish)"; then
  fail "the publish fails" "it succeeded: $out"
else
  contains "the publish fails, saying why" "does not say which commit" "$out"
fi

echo "a commit with the checked engine is not released"
setup bbbb aaaa
if out="$(publish)"; then
  fail "the publish is refused" "it succeeded: $out"
else
  contains "the publish is refused, saying why" "checked engine" "$out"
fi
[ ! -s "$WORK/log" ] && ok "and asks GitHub nothing" || fail "and asks GitHub nothing" "$(cat "$WORK/log")"

if [ "$FAILED" -gt 0 ]; then
  echo "$FAILED failed"
  exit 1
fi
echo "all ok"
