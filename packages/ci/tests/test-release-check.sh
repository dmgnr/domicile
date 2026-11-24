#!/usr/bin/env bash
# Tests `release-check.sh`, which says whether `stable` has something to
# release: a commit `release` lacks. Changesets not yet versioned wait for the
# next release. Each release needs its dated release notes.
#
# Uses real `git` against a local remote.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
CHECK="$ROOT/.github/scripts/release-check.sh"
[ -x "$CHECK" ] || { echo "no $CHECK" >&2; exit 1; }

command -v git >/dev/null 2>&1 || { echo "  SKIP: no git"; exit 77; }

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
contains() {
  local what="$1" needle="$2" hay="$3"
  case "$hay" in
    (*"$needle"*) printf '  ok    %s\n' "$what" ;;
    (*) printf '  FAIL  %s\n    expected to mention: %s\n    said: %s\n' \
          "$what" "$needle" "$hay"; FAILED=$((FAILED + 1)) ;;
  esac
}

# A repository with a bare remote, `domicile` at <version>.
setup() { # version
  rm -rf "$WORK/remote" "$WORK/repo"
  git init -q --bare "$WORK/remote"
  git init -q -b main "$WORK/repo"
  git -C "$WORK/repo" config user.email ci@domicile.invalid
  git -C "$WORK/repo" config user.name "domicile CI"
  git -C "$WORK/repo" config push.negotiate false
  git -C "$WORK/repo" remote add origin "$WORK/remote"
  mkdir -p "$WORK/repo/.github/scripts" "$WORK/repo/packages/domicile" \
    "$WORK/repo/packages/shell-manganese" "$WORK/repo/docs/use" "$WORK/repo/.changeset"
  cp "$CHECK" "$WORK/repo/.github/scripts/"
  echo "# Changesets" >"$WORK/repo/.changeset/README.md"
  version "$1" >/dev/null
}

# Commits `domicile` and manganese at <version>, with dated notes for it, and
# pushes it to stable.
version() { # version
  printf '{"name": "domicile", "version": "%s"}\n' "$1" >"$WORK/repo/packages/domicile/package.json"
  printf '{"name": "@domicile-desktop/manganese", "version": "%s"}\n' "$1" \
    >"$WORK/repo/packages/shell-manganese/package.json"
  notes docs/RELEASE-NOTES.md "$1" "_November 3, 2026_"
  notes docs/use/RELEASE-NOTES.md "$1" "_November 3, 2026_"
  commit "domicile $1"
}
notes() { # file version dateline
  printf '# Release notes\n\n## %s\n\n%s\n\n- A change.\n' "$2" "$3" >"$WORK/repo/$1"
}
commit() { # message
  git -C "$WORK/repo" add -A
  git -C "$WORK/repo" commit -qm "$1" --allow-empty
  git -C "$WORK/repo" push -q origin HEAD:main HEAD:stable
  git -C "$WORK/repo" rev-parse HEAD
}

# `$WORK/output` is the step's `GITHUB_OUTPUT`, fresh for each run.
check() {
  local out
  : >"$WORK/output"
  if out="$(cd "$WORK/repo" && GITHUB_OUTPUT="$WORK/output" \
      bash .github/scripts/release-check.sh 2>&1)"; then
    printf 'ok\n%s\n' "$out"
  else
    printf 'refused\n%s\n' "$out"
  fi
}
status() { printf '%s\n' "$1" | head -1; }
releasable() { sed -n 's/^commit=//p' "$WORK/output"; }

echo "== the first release =="
setup 1.0.0
tip="$(git -C "$WORK/repo" rev-parse HEAD)"
out="$(check)"
expect "is allowed" ok "$(status "$out")"
expect "and names stable's commit" "$tip" "$(releasable)"

echo "== a stable that release already has =="
git -C "$WORK/repo" push -q origin HEAD:release
out="$(check)"
expect "is allowed" ok "$(status "$out")"
contains "and says there is nothing to release" "nothing to release" "$out"
expect "and names no commit" "" "$(releasable)"

echo "== a stable ahead of release =="
tip="$(version 1.0.1)"
out="$(check)"
expect "is allowed" ok "$(status "$out")"
expect "and names stable's commit" "$tip" "$(releasable)"

echo "== a stable with a changeset not yet versioned =="
echo '---' >"$WORK/repo/.changeset/a-change.md"
tip="$(commit "a change")"
out="$(check)"
expect "is allowed" ok "$(status "$out")"
expect "and names stable's commit" "$tip" "$(releasable)"
contains "saying the changeset waits" "a-change.md" "$out"

echo "== a domicile that was never versioned =="
setup 0.0.0
out="$(check)"
expect "is refused" refused "$(status "$out")"
contains "saying why" "0.0.0" "$out"

echo "== a release that is not stable's =="
setup 1.0.0
git -C "$WORK/repo" checkout -q --orphan elsewhere
git -C "$WORK/repo" commit -qm elsewhere --allow-empty
git -C "$WORK/repo" push -q origin elsewhere:release
git -C "$WORK/repo" checkout -q main
out="$(check)"
expect "is refused" refused "$(status "$out")"
contains "saying why" "not an ancestor" "$out"

echo "== Domicile's notes without the release's entry =="
setup 1.0.0
notes docs/RELEASE-NOTES.md 0.9.0 "_November 3, 2026_"
commit "older notes" >/dev/null
out="$(check)"
expect "is refused" refused "$(status "$out")"
contains "naming the file" "docs/RELEASE-NOTES.md" "$out"

echo "== manganese's notes without the release's entry =="
setup 1.0.0
notes docs/use/RELEASE-NOTES.md 0.9.0 "_November 3, 2026_"
commit "older notes" >/dev/null
out="$(check)"
expect "is refused" refused "$(status "$out")"
contains "naming the file" "docs/use/RELEASE-NOTES.md" "$out"

echo "== notes whose entry is undated =="
setup 1.0.0
notes docs/RELEASE-NOTES.md 1.0.0 "_Unreleased_"
commit "undated notes" >/dev/null
out="$(check)"
expect "is refused" refused "$(status "$out")"
contains "saying why" "Unreleased" "$out"

[ "$FAILED" -eq 0 ]
