#!/usr/bin/env bash
# Reset the shared Chromium checkout to the pin, fetching it if needed, so
# `apply.sh` can apply the series. Shared by all three engine workflows.
#
#   .github/scripts/engine-reset.sh /build/chromium/src
#
# `engine-sync.sh` runs next and brings the DEPS to the pin.
#
# `git am` will not apply a patch twice, so the tree must return to the pin
# each run. The series' `src/` files are untracked, so `reset --hard` leaves
# them and they are removed by name. Not `git clean`, which would also delete
# untracked files from gclient's hooks and force a long rebuild.
#
# DEPS are submodules, which `reset --hard` does not restore. When only they
# are out of step, this defers to engine-sync.sh instead of failing.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CHROMIUM="${1:-}"
[ -n "$CHROMIUM" ] || { echo "usage: $(basename "$0") <chromium checkout>" >&2; exit 2; }

# Check the checkout exists first, so a missing one is not misreported as a
# failed fetch below.
[ -d "$CHROMIUM" ] || {
  echo "::error::$CHROMIUM does not exist, so there is no checkout to reset" >&2
  echo "This is the tree engine-tree-pool.sh handed this run, plus /src. A" >&2
  echo "pool slot the unit made and never filled is how it has been empty" >&2
  echo "before." >&2
  exit 1
}
git -C "$CHROMIUM" rev-parse --git-dir >/dev/null 2>&1 || {
  echo "::error::$CHROMIUM is not a git checkout" >&2
  echo "The directory is there and holds no repository, so nothing here can put" >&2
  echo "it on a pin. A slot left part-way through a first sync looks like this." >&2
  exit 1
}

SERIES="$ROOT/packages/domicile-engine/src"
pin="$(grep -v '^#' "$ROOT/packages/domicile-engine/CHROMIUM_PIN" | tr -d '[:space:]')"

# A canceled run can leave index.lock behind. This job holds the tree lock, so
# any index.lock is stale.
index_lock="$(git -C "$CHROMIUM" rev-parse --absolute-git-dir)/index.lock"
if [ -e "$index_lock" ]; then
  echo "removed a stale $index_lock; this job holds the tree lock"
  rm -f "$index_lock"
fi

# Clear a series a previous run left half-applied. Fails when there is
# nothing to abort.
git -C "$CHROMIUM" am --abort 2>/dev/null || true
# The abort does not always remove rebase-apply, and `git am` refuses to run
# while it exists. Stale for the same reason as index.lock.
rebase_apply="$(git -C "$CHROMIUM" rev-parse --absolute-git-dir)/rebase-apply"
if [ -e "$rebase_apply" ]; then
  echo "removed a stale $rebase_apply; this job holds the tree lock"
  rm -rf "$rebase_apply"
fi

# Fetch the pin if the checkout lacks it, so a repin needs no manual work on
# the build host.
git -C "$CHROMIUM" cat-file -e "$pin^{commit}" 2>/dev/null || {
  echo "the checkout does not have $pin; fetching it"
  # Fetch just the revision first, which is much cheaper than every ref. It
  # needs `uploadpack.allowReachableSHA1InWant` on the server, so fall back to
  # a full fetch.
  if ! git -C "$CHROMIUM" fetch --quiet origin "$pin" 2>/dev/null; then
    echo "origin would not serve that one revision; fetching everything"
    git -C "$CHROMIUM" fetch origin
  fi
}

# Still missing means the pin is wrong. Name the file instead of failing
# inside `git reset`.
git -C "$CHROMIUM" cat-file -e "$pin^{commit}" 2>/dev/null || {
  echo "::error::$pin is not a revision $CHROMIUM's origin has" >&2
  echo "It came from packages/domicile-engine/CHROMIUM_PIN, and a fetch did not find it." >&2
  echo "Either it is mistyped, or it is a commit that was never pushed upstream." >&2
  exit 1
}

# Remove the previous run's series files as well as this one's, since another
# branch may have added files this branch lacks. Each run records its file list
# in a manifest beside the checkout. Files on neither list are left alone.
MANIFEST="${DOMICILE_SERIES_MANIFEST:-$(dirname "$CHROMIUM")/.domicile-series-files}"
series_files() { (cd "$SERIES" && find . -type f | sed 's|^\./||'); }

# Drop absolute paths and `..` from the manifest, since its paths are
# removed.
laid_down() {
  {
    grep -Ev '^/|(^|/)\.\.(/|$)' "$MANIFEST" 2>/dev/null || true
    series_files
  } | sort -u
}

# The reset and apply rewrite every file the old and new series touch. Note
# their mtimes so engine-apply.sh can give them back to the files that come
# back unchanged; otherwise ninja rebuilds everything that includes them. The
# patched files are only known when HEAD is a series over this pin; after a
# repin most of the tree changes anyway.
{
  if git -C "$CHROMIUM" merge-base --is-ancestor "$pin" HEAD 2>/dev/null; then
    git -C "$CHROMIUM" diff --name-only --no-renames "$pin" HEAD
  fi
  laid_down
} | "$ROOT/.github/scripts/engine-keep-mtimes.sh" save "$CHROMIUM"

git -C "$CHROMIUM" reset --hard "$pin"

# Deps a Node-in-the-engine branch patched (v8 and BoringSSL): engine-node.sh
# commits Electron's patches over the pin's revision and sets
# `submodule.<path>.ignore all`, which hides them from every status check
# below. A branch without Node must build them as the pin has them, or V8
# links against BoringSSL that names functions it doesn't build. A branch with
# Node leaves them to engine-node.sh, which keeps them patched between runs.
if [ ! -e "$ROOT/packages/domicile-engine/node/NODE_PIN" ]; then
  { git -C "$CHROMIUM" config --get-regexp '^submodule\..*\.ignore$' 2>/dev/null || true; } |
    while read -r key _; do
      path="${key#submodule.}" path="${path%.ignore}"
      git -C "$CHROMIUM" config --unset "$key"
      repo="$CHROMIUM/$path"
      [ -e "$repo/.git" ] || continue
      base="$(git -C "$CHROMIUM" rev-parse "$pin:$path" 2>/dev/null)" || continue
      stamp="$(git -C "$repo" rev-parse --absolute-git-dir)/domicile-node-stamp"
      [ -e "$stamp" ] || [ "$(git -C "$repo" rev-parse HEAD)" != "$base" ] || continue
      echo "putting $path back on $base; a branch with Node patched it"
      git -C "$repo" am --abort >/dev/null 2>&1 || true
      git -C "$repo" checkout -q --force --detach "$base"
      git -C "$repo" clean -qfd
      rm -f "$stamp"
    done
fi

# Deps the pin folds into its own tree: a dep's checkout, with its own `.git`,
# where the pin tracks a directory. `reset --hard` writes the pin's files over
# it and leaves the rest of the checkout behind, and no sync removes it because
# the pin tracks the directory. Chromium did this to
# third_party/wayland-protocols/kde. Found from the untracked files rather than
# the old HEAD, so a rerun after a reset that already moved HEAD finds it too.
folded="$(git -C "$CHROMIUM" status --porcelain --untracked-files=all |
  sed -n 's/^?? //p' |
  while IFS= read -r path; do
    dir="$(dirname "$path")"
    while [ "$dir" != . ]; do
      if [ -e "$CHROMIUM/$dir/.git" ] &&
        [ "$(git -C "$CHROMIUM" cat-file -t "$pin:$dir" 2>/dev/null)" = tree ]; then
        printf '%s\n' "$dir"
        break
      fi
      dir="$(dirname "$dir")"
    done
  done | sort -u)"

if [ -n "$folded" ]; then
  echo "deps $pin tracks as files; replacing their old checkouts:"
  printf '%s\n' "$folded" |
    while IFS= read -r dep; do
      echo "  $dep"
      rm -rf "${CHROMIUM:?}/$dep"
      git -C "$CHROMIUM" checkout --quiet "$pin" -- "$dep"
    done
fi

# Files an older pin's gclient hooks wrote under a `.gitignore` entry a newer
# pin dropped, with the hook that wrote them gone too. Nothing regenerates or
# reads them, but after the reset they show as untracked. Removed only while
# untracked and not ignored, so a pin that still ignores one keeps it.
#
# - buildtools/reclient_cfgs/reproxy.cfg: configure_reclient_cfgs.py stopped
#   writing it, and its ignore went, by Chromium 160.
# - build/util/MINIBRANCH: the `minibranch` hook and its ignore went by
#   Chromium 160.0.8174.
for stale in buildtools/reclient_cfgs/reproxy.cfg build/util/MINIBRANCH; do
  [ -f "$CHROMIUM/$stale" ] || continue
  git -C "$CHROMIUM" ls-files --error-unmatch -- "$stale" >/dev/null 2>&1 && continue
  git -C "$CHROMIUM" check-ignore -q -- "$stale" && continue
  echo "removing $stale, an older pin's hook output this pin no longer ignores"
  rm -f "${CHROMIUM:?}/$stale"
done

laid_down |
  while IFS= read -r file; do
    [ -n "$file" ] || continue
    rm -f "$CHROMIUM/$file"
  done

# Written before `apply.sh`, so the next run can clean up after a run that
# dies mid-series.
series_files | sort > "$MANIFEST"

# `git am` needs an identity, and the runner has no ~/.gitconfig. Set it in
# the checkout's .git/config rather than GIT_* variables, which may not survive
# Chromium's FHS sandbox.
git -C "$CHROMIUM" config user.name "domicile CI"
git -C "$CHROMIUM" config user.email "ci@domicile.invalid"

# `--untracked-files=all` lists files inside untracked directories, which the
# diagnostic below needs.
dirty="$(git -C "$CHROMIUM" status --porcelain --untracked-files=all)"
[ -n "$dirty" ] || exit 0

# DEPS are submodules, and `reset --hard` does not move a submodule's working
# tree. After another branch repins, they show as ` M third_party/angle`.
# engine-sync.sh runs next and fixes them, so defer when only DEPS are out of
# step. `apply.sh` checks the tree again after the sync. Any other dirt still
# fails here, where the diagnostic below can explain it.
#
# Classify by comparing three `git status` views. `grep -Fxv` computes the
# difference because the runner has no diffutils.
#
#   dirty  everything
#   atpin  ignores changes inside a dep; keeps deps whose checked-out
#          revision differs from the recorded one
#   files  ordinary files only
atpin="$(git -C "$CHROMIUM" status --porcelain --untracked-files=all \
  --ignore-submodules=dirty)"
files="$(git -C "$CHROMIUM" status --porcelain --untracked-files=all \
  --ignore-submodules=all)"
deps="$(printf '%s\n' "$atpin" | grep -Fxv -f <(printf '%s\n' "$files") || true)"

# Deps from a newer pin that this pin does not name. `git status -uall` shows
# a nested repository as a directory ending in `/`, which distinguishes it from
# untracked files. The sync's `--delete_unversioned_trees` removes these, but
# not loose files.
clones="$(printf '%s\n' "$files" | grep -E '^\?\? .*/$' || true)"
contamination="$(printf '%s\n' "$files" | grep -Ev '^\?\? .*/$' || true)"

# The stamp engine-sync.sh reads to skip the sync. Must match that script's
# expression exactly.
STAMP="${DOMICILE_SYNCED_PIN:-$(dirname "$CHROMIUM")/.domicile-synced-pin}"

if [ -n "$deps" ] && [ -z "$contamination" ]; then
  echo "the DEPS under $CHROMIUM are not at $pin, so engine-sync.sh has work to do:"
  # `sed -n 1,20p` rather than `head -20`: under `pipefail`, `head` closing
  # the pipe early exits 141.
  printf '%s\n' "$deps" | sed -n '1,20p' | sed 's/^/  /'
  more="$(printf '%s\n' "$deps" | sed -n '21,$p' | wc -l | tr -d ' ')"
  [ "$more" -eq 0 ] ||
    echo "  ... and $more more ($(printf '%s\n' "$deps" | wc -l | tr -d ' ') in all)"
  echo
  echo "Each is a gitlink — a submodule DEPS names — and not a file anybody"
  echo "edited. \`git reset --hard\` does not touch a submodule's working tree, so"
  echo "this step cannot move them and a \`gclient sync\` at the pin is what does."
  echo "This is what a repin looks like from a branch that has not taken it yet."

  if [ -n "$clones" ]; then
    echo
    echo "And deps this pin does not name, which that sync removes with"
    echo "\`--delete_unversioned_trees\`. Each is a git repository of its own,"
    echo "which is why it is listed as a directory and not file by file:"
    printf '%s\n' "$clones" | sed -n '1,20p' | sed 's/^/  /'
    more="$(printf '%s\n' "$clones" | sed -n '21,$p' | wc -l | tr -d ' ')"
    [ "$more" -eq 0 ] || echo "  ... and $more more"
  fi

  # Clear the stamp so the sync cannot skip, even if it names this pin. Only
  # for a real revision mismatch: `atpin` ignores files inside a dep, which
  # the sync would not remove anyway.
  rm -f "$STAMP"
  echo
  echo "Cleared $STAMP so the sync cannot take its fast path."
  echo "apply.sh checks this tree again afterward and still refuses a dirty one."
  exit 0
fi

# Explain the cause: `reset --hard` keeps untracked files, so work left in the
# shared checkout fails every later run.
untracked="$(printf '%s\n' "$dirty" | sed -n 's/^?? //p')"
tracked="$(printf '%s\n' "$dirty" | sed -n '/^?? /!p')"

{
  echo "::error::$CHROMIUM is still dirty after the reset, so apply.sh will refuse it"
  echo
  echo "This step reset the tree to $pin and removed every file the series"
  echo "lays down, by name, out of $SERIES."
  echo "What is listed below survived both, which means it is not the series'"
  echo "and not upstream's: it is work somebody left in the shared checkout."
  echo

  if [ -n "$untracked" ]; then
    echo "Untracked — new files. \`git reset --hard\` does not touch these, which"
    echo "is why they survive every reset and fail every run after the first:"
    # `sed -n 1,20p` rather than `head -20`: under `pipefail`, `head` closing
    # the pipe early exits 141.
    printf '%s\n' "$untracked" | sed -n '1,20p' | sed 's/^/  /'
    left="$(printf '%s\n' "$untracked" | sed -n '21,$p' | wc -l | tr -d ' ')"
    [ "$left" -eq 0 ] || echo "  ... and $left more"
    echo
    echo "Each belongs at the mirrored path under packages/domicile-engine/src/:"
    printf '%s\n' "$untracked" | sed -n '1,5p' |
      sed "s|^|  packages/domicile-engine/src/|"
    echo
    echo "Committed there, it is reset-proof — and this step then removes it"
    echo "from the checkout by name, every run, for free."
    echo
    # A file from another branch's earlier run looks the same as uncommitted
    # work, so warn before anyone deletes it.
    echo "One of these is not like the other, so check before removing anything:"
    echo "a path that also exists under packages/domicile-engine/src/ on some"
    echo "other branch is a previous run's, already committed there, and safe to"
    echo "remove from the checkout. Anything else is the only copy of somebody's"
    echo "work and removing it destroys it."
    echo
    echo "This step keeps a manifest of what it lays down ($MANIFEST) so that a"
    echo "previous run's files are removed by name on the next run. A tree from"
    echo "before that manifest existed has to be cleared once by hand."
  fi

  if [ -n "$tracked" ]; then
    echo "Tracked and modified. A path here is one of two things. If it is a"
    echo "dep — a submodule DEPS names — it is either out of step with the pin,"
    echo "which is engine-sync.sh's and would have been deferred to it had the"
    echo "rest of this tree been clean, or dirty in its own working tree, which"
    echo "no sync of ours removes. Otherwise it is an ordinary file, and"
    echo "\`reset --hard\` does restore one of those — so it was written after"
    echo "the reset ran, which most likely means a build or a \`git am\` is in"
    echo "this tree right now:"
    printf '%s\n' "$tracked" | sed -n '1,20p' | sed 's/^/  /'
  fi

  echo
  echo "DO NOT clear this with \`git clean -fdx\`. It is somebody's uncommitted"
  echo "work, and the rest of what it would delete is a four-hour Chromium"
  echo "build's worth of files gclient's hooks put there."
  echo
  echo "The fix is at the other end: commit the files into"
  echo "packages/domicile-engine/src/ and remove them from $CHROMIUM."
  echo "Then re-run this job."
} >&2
exit 1
