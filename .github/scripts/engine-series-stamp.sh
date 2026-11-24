#!/usr/bin/env bash
# Records which patch series the shared Chromium checkout already carries, so
# the next run can skip the reset, apply and rebuild.
#
#   .github/scripts/engine-series-stamp.sh carries  <chromium/src>
#   .github/scripts/engine-series-stamp.sh record   <chromium/src>
#   .github/scripts/engine-series-stamp.sh identity
#
# - `carries` writes `carries=true|false` to $GITHUB_OUTPUT and exits 0. Any
#   doubt answers `false`, which costs only a normal reset and apply.
# - `record` writes the stamp after `apply.sh`.
# - `identity` prints the series hash. `engine-release-publish.sh` tags releases
#   with it.
#
# Resetting and reapplying gives every patched file a new mtime, which forces a
# long rebuild even when nothing changed. That is the cost this avoids.
#
# A false `true` would report a build of other code as the pull request's, so
# the stamp is not trusted alone. `carries` also checks:
#
#   - the series identity (pin, patches, laid-down files and Electron's Node,
#     by content);
#   - HEAD matches the stamped commit, since other workflows and people reset
#     this tree;
#   - the only changes in the checkout are the series' untracked files;
#   - each of those files matches the repository's byte for byte. `git status`
#     cannot see changes to untracked files.
#
# The stamp lives outside `src/` for the reason given in engine-sync.sh.
set -euo pipefail

usage() {
  echo "usage: $(basename "$0") <carries|record> <chromium/src>" >&2
  echo "       $(basename "$0") identity" >&2
  exit 2
}

action="${1:-}"
CHROMIUM="${2:-}"
# `identity` describes this repository's series, not a checkout, so it needs no
# /build.
[ -n "$action" ] || usage
case "$action" in
  (identity) ;;
  (*) [ -n "$CHROMIUM" ] || usage ;;
esac

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PACKAGE="$ROOT/packages/domicile-engine"
SERIES="$PACKAGE/src"
PATCHES="$PACKAGE/patches"
# Electron's Node and its patches, which engine-node.sh puts in.
NODE="$PACKAGE/node"

# Outside `src/`, as in engine-sync.sh. Tests override it because they have no
# /build.
STAMP="${DOMICILE_SERIES_STAMP:-$(dirname "$CHROMIUM")/.domicile-series-stamp}"

# Hash of every input that determines the tree, by content. The reset-then-apply
# rewrites unchanged files, so mtimes are useless. `sort` makes the order
# stable. The pin is included so a repin changes the identity.
series_identity() {
  {
    printf 'pin %s\n' "$(pin)"
    # A `while read` loop instead of `xargs`, which may not be on the runner's
    # PATH.
    for dir in "$PATCHES" "$SERIES" "$NODE"; do
      [ -d "$dir" ] || continue
      (cd "$dir" && find . -type f | LC_ALL=C sort |
        while IFS= read -r entry; do
          [ -n "$entry" ] || continue
          sha256sum "$entry"
        done)
    done
  } | sha256sum | cut -d' ' -f1
}

pin() { grep -v '^#' "$PACKAGE/CHROMIUM_PIN" | tr -d '[:space:]'; }

# Files `apply.sh` copies into the checkout, relative to it. Must match
# engine-reset.sh's `series_files`.
series_files() { (cd "$SERIES" && find . -type f | sed 's|^\./||'); }

# Whether the checkout's only changes are the series' untracked files.
#
# `--untracked-files=all` because the default collapses an untracked directory
# to one line, which would never match the file list.
tree_is_as_applied() {
  local want got
  want="$(series_files | LC_ALL=C sort)"
  got="$(git -C "$CHROMIUM" status --porcelain --untracked-files=all |
           sed -n 's/^?? //p' | LC_ALL=C sort)"
  [ "$want" = "$got" ] || {
    reason="the checkout is not dirty the way a finished apply leaves it"
    return 1
  }
  # The listing above keeps only `??` lines, so check tracked files separately.
  [ -z "$(git -C "$CHROMIUM" status --porcelain --untracked-files=no)" ] || {
    reason="the checkout has modifications to files the series does not own"
    return 1
  }
  return 0
}

# Whether two files hold the same bytes.
#
# Uses `sha256sum` because `cmp` (diffutils) is not on the runner's PATH, and a
# missing command would read as "differs". A `sha256sum` failure exits instead
# of answering. Reads stdin so the output has no filename.
same_bytes() { # $1, $2
  local a b
  [ -f "$1" ] && [ -f "$2" ] || return 1
  a="$(sha256sum <"$1")" || {
    echo "::error::sha256sum failed on $1, so nothing here can be compared" >&2
    exit 1
  }
  b="$(sha256sum <"$2")" || {
    echo "::error::sha256sum failed on $2, so nothing here can be compared" >&2
    exit 1
  }
  [ "$a" = "$b" ]
}

# Whether every laid-down file is present and identical. `git status` cannot
# tell, because these files are untracked.
series_files_are_laid_down() {
  local file
  while IFS= read -r file; do
    [ -n "$file" ] || continue
    same_bytes "$SERIES/$file" "$CHROMIUM/$file" || {
      reason="$file in the checkout is not the one under packages/domicile-engine/src"
      return 1
    }
  done <<EOF
$(series_files)
EOF
  return 0
}

head_now() { git -C "$CHROMIUM" rev-parse HEAD; }

case "$action" in
  carries)
    reason=""
    verdict=false

    if [ ! -f "$PACKAGE/CHROMIUM_PIN" ]; then
      # `engine-reset.sh` reports a missing pin file properly and runs after
      # this, so answer `false` and let it explain. Checked here so grep's own
      # error does not leak onto stderr.
      reason="this checkout has no packages/domicile-engine/CHROMIUM_PIN to read"
    elif [ ! -f "$STAMP" ]; then
      reason="nothing is written down beside this checkout"
    else
      # Two lines: the identity, then the commit. Only `record` writes this
      # file.
      stamped_identity="$(sed -n '1p' "$STAMP")"
      stamped_head="$(sed -n '2p' "$STAMP")"

      if [ "$stamped_identity" != "$(series_identity)" ]; then
        reason="the series moved since this checkout last took it"
      elif [ "$stamped_head" != "$(head_now)" ]; then
        reason="the checkout is at $(head_now), and the series was applied over $stamped_head"
      elif ! tree_is_as_applied; then
        : # reason set
      elif ! series_files_are_laid_down; then
        : # reason set
      else
        verdict=true
      fi
    fi

    if [ "$verdict" = true ]; then
      echo "the checkout already carries this series over $(pin); the reset, the apply and the compile have nothing to do"
    else
      echo "the checkout does not carry this series: $reason"
      echo "Resetting and applying, which is what every run did before this stamp existed."
    fi

    # The workflow's `if:` reads this, so always write it.
    [ -z "${GITHUB_OUTPUT:-}" ] || printf 'carries=%s\n' "$verdict" >>"$GITHUB_OUTPUT"
    ;;

  record)
    # A bad stamp would cause a false `true` on the next run, so check the tree
    # before writing.
    reason=""
    if ! tree_is_as_applied || ! series_files_are_laid_down; then
      # A warning, not a failure: skipping the stamp already protects the next
      # run, and failing would skip the build and its guards for a series that
      # applied fine.
      {
        echo "::warning::not writing down this series: the checkout is not carrying it the way a finished apply leaves it"
        echo "  $reason"
        echo
        echo "This runs after apply.sh, so the checkout should hold the series and"
        echo "nothing else. It does not, which means something wrote into"
        echo "$CHROMIUM between the apply and here."
        echo
        echo "Nothing is written, so the next run will reset and apply, as every"
        echo "run did before this stamp existed. The build continues."
      } >&2
      exit 0
    fi

    # One write, so an interrupted run leaves no partial file.
    printf '%s\n%s\n' "$(series_identity)" "$(head_now)" >"$STAMP"
    echo "wrote down the series this checkout carries, over $(pin)"
    ;;

  identity)
    # Releases are tagged by series rather than by domicile commit, so commits
    # that do not touch the fork share an engine. The tag must use the same
    # hash as the stamp; a second implementation could drift and skip a needed
    # repin (#411).
    series_identity
    ;;

  *) usage ;;
esac
