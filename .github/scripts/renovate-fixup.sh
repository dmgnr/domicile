#!/usr/bin/env bash
# Finishes a Renovate pull request so its checks can pass and Renovate can
# automerge it.
#
#   .github/scripts/renovate-fixup.sh <branch>
#
# Run from a checkout of <branch>. Renovate edits the manifests; this:
#
#   - writes bun.lock with the bun on PATH, which renovate-fixup.yml installs
#     from `packageManager`. Renovate's own bun writes a different lockfile.
#   - regenerates the SDK's generated files, the engine layer among them,
#     which bundle dependencies such as zod.
#   - refreshes the flake's `node-modules` and `shell-modules` hashes, which
#     follow bun.lock.
#   - adds an empty changeset when the branch has none.
#
# It commits as domicile CI, which renovate.json lists in `gitIgnoredAuthors`,
# so Renovate still rebases and automerges the branch. It pushes with
# DOMICILE_WRITEBACK_TOKEN when set, because a GITHUB_TOKEN push starts no
# checks. A branch that needs nothing is left alone.
set -euo pipefail

[ "$#" -eq 1 ] || {
  echo "usage: renovate-fixup.sh <branch>" >&2
  exit 2
}
BRANCH="$1"

bun install --lockfile-only
bun install --frozen-lockfile
(cd packages/chrome-sdk && bun run generate)

# Swaps each stale hash nix reports for the one it got. Any other nix failure
# fails the job.
for attr in node-modules shell-modules; do
  if log="$(nix build --no-link ".#$attr" 2>&1)"; then
    continue
  fi
  specified="$(printf '%s\n' "$log" | sed -n 's/^ *specified: *\(sha256-[^ ]*\)$/\1/p')"
  got="$(printf '%s\n' "$log" | sed -n 's/^ *got: *\(sha256-[^ ]*\)$/\1/p')"
  if [ -z "$specified" ] || [ -z "$got" ]; then
    printf '%s\n' "$log" >&2
    echo "nix build .#$attr failed for a reason other than a stale hash" >&2
    exit 1
  fi
  sed -i "s|$specified|$got|" flake.nix
done

# `renovate/all` gets `.changeset/renovate-all.md`.
if git diff --quiet origin/main...HEAD -- .changeset/ &&
  [ -z "$(git status --porcelain -- .changeset/)" ]; then
  printf -- '---\n---\n' >".changeset/renovate-${BRANCH##*/}.md"
fi

if [ -z "$(git status --porcelain)" ]; then
  echo "$BRANCH needs no fixing up"
  exit 0
fi

export GIT_AUTHOR_NAME="domicile CI"
export GIT_AUTHOR_EMAIL="ci@domicile.invalid"
export GIT_COMMITTER_NAME="domicile CI"
export GIT_COMMITTER_EMAIL="ci@domicile.invalid"
git add -A
git commit -q -m "Fix up the dependency updates" -m "Release-notes: none"

if [ -n "${DOMICILE_WRITEBACK_TOKEN:-}" ]; then
  # The empty value clears the checkout's header before this one is added.
  auth="$(printf 'x-access-token:%s' "$DOMICILE_WRITEBACK_TOKEN" | base64 | tr -d '\n')"
  git -c http.https://github.com/.extraheader= \
    -c "http.https://github.com/.extraheader=AUTHORIZATION: basic $auth" \
    push -q origin "HEAD:refs/heads/$BRANCH"
else
  git push -q origin "HEAD:refs/heads/$BRANCH"
fi
echo "fixed up $BRANCH"
