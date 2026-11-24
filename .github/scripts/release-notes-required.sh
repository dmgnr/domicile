#!/usr/bin/env bash
# Fails when this branch neither adds to the release notes nor says it needs
# none.
#
#   .github/scripts/release-notes-required.sh <base>
#
# <base> is the branch it merges into. A branch passes when it changes
# docs/RELEASE-NOTES.md or docs/use/RELEASE-NOTES.md, or when one of its
# commits carries the trailer `Release-notes: none`.
set -euo pipefail

[ "$#" -eq 1 ] || {
  echo "usage: release-notes-required.sh <base>" >&2
  exit 2
}

if ! git diff --quiet "$1...HEAD" -- docs/RELEASE-NOTES.md docs/use/RELEASE-NOTES.md; then
  echo "the release notes have this change"
  exit 0
fi

# Read whole: `grep -q` stops at the first match, and the pipe failing
# under `pipefail` once git log can't write the rest would fail the check.
if git log --format='%(trailers:key=Release-notes,valueonly)' "$1..HEAD" | grep -x none >/dev/null; then
  echo "a commit says this change needs no release notes"
  exit 0
fi

cat >&2 <<'MSG'
This change has no release notes. Either:

- add it under the `_Unreleased_` entry of docs/RELEASE-NOTES.md (Domicile,
  for shell and app authors) or docs/use/RELEASE-NOTES.md (manganese, for its
  users), or
- add the trailer `Release-notes: none` to one of its commits, when nobody
  would miss it in the notes. Git reads trailers only from the message's
  last paragraph, so put it beside `Co-Authored-By` and the like, with no
  blank line between.

See docs/contributing/RELEASING.md#release-notes.
MSG
exit 1
