#!/usr/bin/env bash
# Tests `.github/scripts/release-notes-required.sh`, which fails a branch that
# neither adds to the release notes nor says in a commit that it needs none.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
REQUIRED="$ROOT/.github/scripts/release-notes-required.sh"
[ -x "$REQUIRED" ] || { echo "no $REQUIRED" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FAILED=0
ok() { printf '  ok    %s\n' "$1"; }
fail() {
  printf '  FAIL  %s\n    %s\n' "$1" "$2"
  FAILED=$((FAILED + 1))
}

# Both notes pages and a file on `main`, and a branch `change` off it.
reset() {
  rm -rf "$WORK/repo"
  mkdir -p "$WORK/repo/docs/use"
  cd "$WORK/repo"
  echo "# Release notes" >docs/RELEASE-NOTES.md
  echo "# Release notes" >docs/use/RELEASE-NOTES.md
  echo a >file
  git init -q -b main
  git add -A
  git -c user.name=t -c user.email=t@t commit -qm base
  git checkout -qb change
}

commit() { # message
  git add -A
  git -c user.name=t -c user.email=t@t commit -qm "$1" --allow-empty
}

# Expects the check to pass (0) or fail (1) on the branch.
expect() { # what, want
  status=0
  out="$("$REQUIRED" main 2>&1)" || status=1
  if [ "$status" = "$2" ]; then
    ok "$1"
  else
    fail "$1" "exit $status: $out"
  fi
}

echo "== a change with no notes =="
reset
echo b >file
commit "Change a file"
expect "fails" 1
case "$out" in
  (*"Release-notes: none"*) ok "and says how to opt out" ;;
  (*) fail "and says how to opt out" "$out" ;;
esac

echo "== a change that adds to Domicile's notes =="
reset
echo b >file
echo "- A change." >>docs/RELEASE-NOTES.md
commit "Change a file"
expect "passes" 0

echo "== a change that adds to manganese's notes =="
reset
echo "- A change." >>docs/use/RELEASE-NOTES.md
commit "Change a file"
expect "passes" 0

echo "== a change whose commit needs no notes =="
reset
echo b >file
commit "$(printf 'Change a file\n\nRelease-notes: none\n')"
expect "passes" 0

echo "== a trailer in one of several commits =="
reset
echo b >file
commit "Change a file"
commit "$(printf 'Tidy\n\nRelease-notes: none\n')"
expect "passes" 0

# The older trailer outgrows a pipe's buffer, so a reader that stops at the
# first match leaves `git log` writing into a closed pipe.
echo "== a trailer on the newest commit, with a long one before it =="
reset
echo b >file
commit "$(printf 'Change a file\n\nRelease-notes: %s\n' "$(head -c 100000 /dev/zero | tr '\0' a)")"
commit "$(printf 'Tidy\n\nRelease-notes: none\n')"
expect "passes" 0

echo "== the words in a subject, not a trailer =="
reset
echo b >file
commit "Release-notes: none"
expect "fails" 1

[ "$FAILED" -eq 0 ]
