#!/usr/bin/env bash
# Which of `crux`'s Chromium trees this run builds in.
#
#   .github/scripts/engine-tree-pool.sh pick <pin> <owner>
#   .github/scripts/engine-tree-pool.sh compiles <pin>
#   .github/scripts/engine-tree-pool.sh use  <pin>
#   .github/scripts/engine-tree-pool.sh list
#
# Moving `CHROMIUM_PIN` forces a rebuild of about four hours, in both
# directions. With several trees, pull requests on different pins each keep a
# tree at their pin, and a run on a pin some tree already carries skips the
# reset, apply and compile. See
# packages/domicile-engine/docs/BUILD-MACHINE.md#tree-pool.
#
# - Each tree is built at its own path (`/build/trees/tree-N`) so two runs can
#   build at once. `gn gen` writes absolute paths, so a tree must keep its path.
#   `/build/chromium` is a symlink for people; CI does not read it.
# - This script only picks a directory. `engine-series-stamp.sh` checks what
#   the tree holds. Stamps are read here only to rank trees and to guess
#   whether a run compiles.
# - The slots belong to the machine: `setup-chromium-trees.service`
#   (cprussin/dotfiles: config/machines/crux/chromium-build.nix) creates them.
#   This script never creates one, since each costs about 97G of disk.
set -u

usage() {
  echo "usage: $(basename "$0") <pick|compiles|use|list> [pin] [owner]" >&2
  exit 2
}

action="${1:-}"
[ -n "$action" ] || usage

# /build on `crux`. Tests override it.
ROOT="${DOMICILE_BUILD_ROOT:-/build}"
TREES="$ROOT/trees"
PATH_TO_TREE="$ROOT/chromium"

# The pin `engine-sync.sh` stamped beside a checkout. Read rather than
# duplicated so the two cannot disagree.
#
# A sync clears the stamp while it runs, so a tree left mid-sync reports no pin
# and ranks as free.
slot_pin() { # slot directory
  cat "$1/.domicile-synced-pin" 2>/dev/null | tr -d '[:space:]'
}

# The series a slot last carried, from `engine-series-stamp.sh record`. Used
# only for ranking: `carries` verifies it after the pick, and a stale value
# costs one ordinary rebuild.
slot_series() { # slot directory
  sed -n '1p' "$1/.domicile-series-stamp" 2>/dev/null
}

# When a slot was last handed out. The tree's own mtimes track builds, not
# picks.
used_file() { printf '%s\n' "$1/.domicile-last-used"; }

slots() { find "$TREES" -mindepth 1 -maxdepth 1 -type d | LC_ALL=C sort; }

# Slots that hold a checkout (`src/`). An empty slot would pass the pick and
# then fail in `engine-reset.sh`, on every run until it is filled.
#
# Filling a slot takes a full `gclient sync` (97G, hours), so a job never does
# it. Two units in cprussin/dotfiles (config/machines/crux/chromium-build.nix)
# own the slots:
#   - `setup-chromium-trees.service` creates them and adopts the existing
#     checkout.
#   - `bootstrap-chromium-tree.service` fills empty ones on a timer.
usable() {
  local slot
  for slot in $(slots); do
    if [ -d "$slot/src" ]; then
      printf '%s\n' "$slot"
    fi
  done
}

# Every usable slot for this pin and series, best first. `use` takes the first
# line; `pick` walks the list when better trees are held by other runs.
#
# Order:
#   1. At the pin, with a stamp naming this series. Skips reset, apply and
#      compile.
#   2. At the pin, least recently used first. Skips only the sync.
#   3. No pin (a sync died mid-run). Taking one evicts nothing.
#   4. The rest, least recently used first.
#
# Free slots come before older ones because taking a populated slot evicts its
# pin, and the next run on that pin pays four hours.
candidates() { # pin series
  local slot at
  for slot in $(usable); do
    [ "$(slot_pin "$slot")" = "$1" ] || continue
    [ "$(slot_series "$slot")" = "$2" ] || continue
    printf '%s\n' "$slot"
  done
  for slot in $(usable); do
    [ "$(slot_pin "$slot")" = "$1" ] || continue
    [ "$(slot_series "$slot")" = "$2" ] && continue
    at="$(stat -c %Y "$(used_file "$slot")" 2>/dev/null || echo 0)"
    printf '%s %s\n' "$at" "$slot"
  done | LC_ALL=C sort -n | cut -d' ' -f2-
  for slot in $(usable); do
    [ "$(slot_pin "$slot")" = "$1" ] && continue
    [ -z "$(slot_pin "$slot")" ] || continue
    printf '%s\n' "$slot"
  done
  # A slot never handed out has no timestamp and sorts oldest.
  for slot in $(usable); do
    [ "$(slot_pin "$slot")" = "$1" ] && continue
    [ -z "$(slot_pin "$slot")" ] && continue
    at="$(stat -c %Y "$(used_file "$slot")" 2>/dev/null || echo 0)"
    printf '%s %s\n' "$at" "$slot"
  done | LC_ALL=C sort -n | cut -d' ' -f2-
}

choose() { # pin series
  candidates "$1" "$2" | head -1
}

# This run's series comes from the same script that writes the stamps, so the
# two match. It is asked once, outside any `$(...)`, so a failure stops the run
# instead of reading as "no tree matches".
STAMP_SH="$(cd "$(dirname "$0")" && pwd)/engine-series-stamp.sh"

# Reuse engine-tree-lock.sh's per-tree lock. A second lock on the same tree
# could disagree and let two runs share it.
#
# Its stderr is discarded while trying candidates: a held tree is normal here.
LOCK_SH="$(cd "$(dirname "$0")" && pwd)/engine-tree-lock.sh"

# Answers whether a tree's out/Release is built from what it carries, via the
# compile slot's `warm`.
SLOT_SH="$(cd "$(dirname "$0")" && pwd)/engine-compile-slot.sh"

# What this series would change in a tree, for `compiles`. Override for tests.
DIFF_SH="${DOMICILE_SERIES_DIFF:-$(cd "$(dirname "$0")" && pwd)/engine-series-diff.sh}"

# Files whose change recompiles much of Chromium: headers, and what generates
# them (mojom, IDL, blink's json5 tables) or configures many targets (gni).
WIDELY_INCLUDED='\.(h|hh|hpp|inc|def|mojom|idl|json5|gni)$'

# Whether compiling this series in <slot> is cold, printing why when it is.
#
# Warm means ccache covers it: the tree is at this pin, its out/Release is built
# from what it carries, and this series changes no widely included file. Such a
# build hits ccache 95-100%; after a widely included header changes it hits
# 1-6% and takes over an hour. A wrong answer affects only queueing.
cold_because() { # slot pin
  local changed wide
  if [ "$(slot_pin "$1")" != "$2" ]; then
    echo "it is at another pin"
  elif [ "$(GITHUB_OUTPUT=/dev/stdout "$SLOT_SH" warm "$1/src")" != "warm=true" ]; then
    echo "its out/Release is not built from what it carries"
  elif ! changed="$("$DIFF_SH" "$1/src")"; then
    echo "what this series changes in it could not be read"
  elif wide="$(printf '%s\n' "$changed" | grep -E "$WIDELY_INCLUDED")"; then
    echo "this series changes $(printf '%s\n' "$wide" | wc -l) widely included file(s), $(printf '%s\n' "$wide" | head -1) first"
  else
    return 1
  fi
}

take_slot() { # slot owner
  "$LOCK_SH" take "$1/src" "$2" >/dev/null 2>&1
}

holder_of() { # slot
  cat "$("$LOCK_SH" path "$1/src")/owner" 2>/dev/null ||
    echo "someone who did not write their name in it"
}

# Clears each tree whose holder's run is over. A runner shut down mid-build
# never runs its drop step, so its tree stays locked until someone clears it.
#
# `DOMICILE_TREE_HOLDER_DONE` is the workflow's check, given HOLDER, as for the
# compile slot (crux-run-finished.sh). Only a definite yes clears a lock: a
# running holder may be mid-build, and a person's lock names no run.
#
# The lock is renamed aside before it is removed, so a run that took the tree
# between the check and the clear keeps its lock.
clear_finished() {
  [ -n "${DOMICILE_TREE_HOLDER_DONE:-}" ] || return 0
  local slot lock held why aside
  for slot in $(usable); do
    lock="$("$LOCK_SH" path "$slot/src")"
    [ -d "$lock" ] || continue
    held="$(holder_of "$slot")"
    why="$(HOLDER="$held" sh -c "$DOMICILE_TREE_HOLDER_DONE" 2>&1)" || continue
    aside="$lock.cleared.$$"
    mv -T "$lock" "$aside" 2>/dev/null || continue
    if [ "$(cat "$aside/owner" 2>/dev/null)" != "$held" ]; then
      mv -T "$aside" "$lock" 2>/dev/null ||
        echo "::error::took ${slot##*/}'s lock from '$(cat "$aside/owner" 2>/dev/null)' while clearing '$held' and could not put it back: $aside" >&2
      continue
    fi
    rm -rf "$aside"
    echo "::warning::cleared ${slot##*/}, which '$held' held, because its run is over: $why" >&2
  done
}

case "$action" in
  pick)
    pin="${2:-}"
    owner="${3:-}"
    [ -n "$pin" ] && [ -n "$owner" ] || usage

    if [ ! -d "$TREES" ] || [ -z "$(slots)" ] || [ -z "$(usable)" ]; then
      # Unlike `use`, `pick` has no existing tree to fall back to.
      {
        echo "::error::no usable Chromium tree to pick from under $TREES"
        echo "setup-chromium-trees.service (cprussin/dotfiles) makes the slots"
        echo "and bootstrap-chromium-tree.service fills them."
      } >&2
      exit 1
    fi

    # A run from a workflow older than per-tree locks holds this one lock and
    # may repoint /build/chromium into any tree, so no tree is free.
    if [ -d "$ROOT/.domicile-tree-lock" ]; then
      {
        echo "::error::'$(cat "$ROOT/.domicile-tree-lock/owner" 2>/dev/null || echo someone)' holds the pre-pool lock at $ROOT/.domicile-tree-lock and may reset any tree"
        echo "Wait for it and re-run. If it is stale: rm -rf $ROOT/.domicile-tree-lock"
      } >&2
      exit 1
    fi

    series="$("$STAMP_SH" identity)" || exit 1
    # `pin` takes only a tree at this pin; `any` takes the best free tree.
    take_best() { # pin|any
      local slot
      for slot in $(candidates "$pin" "$series"); do
        if [ "$1" = pin ] && [ "$(slot_pin "$slot")" != "$pin" ]; then
          continue
        fi
        if take_slot "$slot" "$owner"; then
          touch "$(used_file "$slot")"
          printf '%s\n' "$slot/src"
          return 0
        fi
      done
      return 1
    }
    some_tree_at_pin() {
      local slot
      for slot in $(usable); do
        [ "$(slot_pin "$slot")" = "$pin" ] && return 0
      done
      return 1
    }
    clear_finished
    # A tree at another pin rebuilds from scratch, about four hours. A run on
    # this pin's tree is usually done within the hour, so wait for it. The
    # nightly official build of 2026-11-23 took the other tree a minute before
    # this pin's tree came free, and compiled for 4h50m.
    want=any
    if some_tree_at_pin; then
      want=pin
    fi
    take_best "$want" && exit 0

    # No tree that is worth having is free. Wait for one instead of failing.
    # Waiting for this pin's tree falls back to any free tree when waiting is
    # not possible or takes too long.
    #
    # Only one run waits. A waiting build holds one of crux's two runners, and
    # a tree is dropped only by its run's engine job, which needs a runner too.
    # Two waiters would deadlock. The waiter refreshes `alive` every poll so a
    # canceled one goes stale within WAITER_STALE.
    #
    # The 45-minute wait comes out of the build job's budget, which must also
    # cover the compile slot's wait and a cold repin
    # (packages/ci/tests/test-the-engine-budget-holds-both-builds.sh).
    WAIT="${DOMICILE_TREE_WAIT:-2700}"
    POLL="${DOMICILE_TREE_POLL:-15}"
    WAITER_STALE="${DOMICILE_TREE_WAITER_STALE:-120}"
    WAITER="$ROOT/.domicile-tree-waiter"
    holders() {
      local slot
      for slot in $(usable); do
        echo "  $(basename "$slot"): $(holder_of "$slot")"
      done
      echo
      echo "Wait and re-run -- a Chromium build is up to four hours. If a"
      echo "holder is a run that died, its lock is stale and this clears it:"
      echo
      echo "  rm -rf $("$LOCK_SH" path "$(usable | head -1)/src")"
    }
    fall_back() {
      [ "$want" = pin ] || return 1
      take_best any || return 1
      echo "::warning::$1, so this run took a tree at another pin and rebuilds it" >&2
      return 0
    }
    if [ "$WAIT" -le 0 ]; then
      fall_back "every tree at $pin is held and this run cannot wait" && exit 0
      {
        echo "::error::every Chromium tree under $TREES is held, so this run has nowhere to build"
        holders
      } >&2
      exit 1
    fi
    if ! mkdir "$WAITER" 2>/dev/null; then
      if [ -n "$(find "$WAITER" -newermt "-$WAITER_STALE seconds" 2>/dev/null)" ]; then
        fall_back "every tree at $pin is held and '$(cat "$WAITER/owner" 2>/dev/null)' is already waiting" && exit 0
        {
          echo "::error::every Chromium tree under $TREES is held, and '$(cat "$WAITER/owner" 2>/dev/null)' is already waiting for one"
          echo "A second waiter would hold the runner a holder needs to drop its tree."
          holders
        } >&2
        exit 1
      fi
      echo "::warning::'$(cat "$WAITER/owner" 2>/dev/null)' stopped saying it was waiting for a tree; waiting in its place" >&2
      rm -rf "$WAITER"
      mkdir "$WAITER" || exit 1
    fi
    trap 'rm -rf "$WAITER"' EXIT
    printf '%s\n' "$owner" >"$WAITER/owner"
    touch "$WAITER/alive"
    if [ "$want" = pin ]; then
      echo "every Chromium tree at $pin is held; waiting up to ${WAIT}s for one rather than rebuilding another" >&2
    else
      echo "every Chromium tree under $TREES is held; waiting up to ${WAIT}s for one" >&2
    fi
    waited=0
    asked=0
    cleared_at=0
    while [ "$waited" -lt "$WAIT" ]; do
      sleep "$POLL"
      waited=$((waited + POLL))
      touch "$WAITER/alive"
      # Whether this run is still wanted, as in engine-compile-slot.sh: exit 0
      # yes, 1 no, anything else unknown. A superseded run should not hold the
      # only waiting place. An unknown answer keeps waiting.
      if [ -n "${DOMICILE_TREE_STILL_WANTED:-}" ] &&
         [ $((waited - asked)) -ge "${DOMICILE_TREE_RECHECK:-60}" ]; then
        asked="$waited"
        why="$(sh -c "$DOMICILE_TREE_STILL_WANTED" 2>&1)"
        case $? in
          0) ;;
          1)
            echo "::error::no longer waiting for a tree: $why" >&2
            [ -z "${GITHUB_OUTPUT:-}" ] || echo "superseded=true" >>"$GITHUB_OUTPUT"
            exit 1
            ;;
          *) echo "could not ask whether this run is still wanted, so it carries on: $why" >&2 ;;
        esac
      fi
      if [ $((waited - cleared_at)) -ge "${DOMICILE_TREE_RECHECK:-60}" ]; then
        cleared_at="$waited"
        clear_finished
      fi
      if take_best "$want"; then
        echo "took a tree after ${waited}s" >&2
        exit 0
      fi
    done
    fall_back "every tree at $pin was still held after waiting ${waited}s" && exit 0
    {
      echo "::error::every Chromium tree under $TREES was still held after waiting ${waited}s, so this run has nowhere to build"
      holders
    } >&2
    exit 1
    ;;

  compiles)
    # Predicts whether the tree `pick` would take needs a compile, before the
    # build job takes a runner, so engine.yml can queue compiling runs for the
    # compile slot without holding a runner.
    #
    # - `compile=false` only for a free tree whose stamp names this series and
    #   whose out/Release is warm. Anything else, including a failure, is
    #   `true`. The build job rechecks, so a stale guess is safe.
    # - `cold=true|false` lets engine.yml queue cold compiles separately (see
    #   `cold_because`). With no free tree, the answer is cold.
    #
    # Locks nothing.
    pin="${2:-}"
    [ -n "$pin" ] || usage
    series="$("$STAMP_SH" identity)" || exit 1
    compile=true
    cold=true
    for slot in $(candidates "$pin" "$series"); do
      [ -d "$("$LOCK_SH" path "$slot/src")" ] && continue
      if [ "$(slot_series "$slot")" = "$series" ] &&
         [ "$(GITHUB_OUTPUT=/dev/stdout "$SLOT_SH" warm "$slot/src")" = "warm=true" ]; then
        compile=false
      fi
      if [ "$compile" = false ]; then
        cold=false
        why="it compiles nothing"
      elif why="$(cold_because "$slot" "$pin")"; then
        cold=true
      else
        cold=false
        why="it recompiles only sources this series changes"
      fi
      echo "the pick would take ${slot##*/}: compile=$compile cold=$cold, because $why"
      break
    done
    echo "compile=$compile" >>"${GITHUB_OUTPUT:-/dev/stdout}"
    echo "cold=$cold" >>"${GITHUB_OUTPUT:-/dev/stdout}"
    ;;

  use)
    pin="${2:-}"
    [ -n "$pin" ] || usage

    if [ ! -d "$TREES" ]; then
      # The pool is not deployed on this machine (cprussin/dotfiles), so build
      # in the existing tree.
      echo "no pool at $TREES, so this run builds in $PATH_TO_TREE as it is"
      exit 0
    fi

    if [ -z "$(slots)" ]; then
      # The setup unit ran but did not finish. Treating this as "no pool" would
      # build against whatever pin the symlink last pointed at.
      {
        echo "::error::$TREES exists but holds no slot, so there is nothing to build in"
        echo "setup-chromium-trees.service (cprussin/dotfiles) is what makes them."
        echo "Filling one is bootstrap-chromium-tree.service's, and it has nothing"
        echo "to fill yet."
      } >&2
      exit 1
    fi

    if [ -e "$PATH_TO_TREE" ] && [ ! -L "$PATH_TO_TREE" ]; then
      # The original checkout has not been moved into a slot. That moves 97G
      # and belongs to setup-chromium-trees.service, not to a job.
      {
        echo "::error::$PATH_TO_TREE is a directory, not a symlink into $TREES"
        echo "The pool cannot point a path that is already a tree. Moving that"
        echo "tree into a slot is setup-chromium-trees.service's job"
        echo "(cprussin/dotfiles: config/machines/crux/chromium-build.nix), and"
        echo "it is a move of the only Chromium checkout on this machine."
      } >&2
      exit 1
    fi

    if [ -z "$(usable)" ]; then
      # The slots exist but none is filled. Reported separately because the
      # fix differs from the empty-directory case above.
      {
        echo "::error::no tree under $TREES holds a Chromium checkout, so there is nothing to build in"
        echo "Each slot is an empty directory: there is no src/ under any of them."
        echo "Filling one is a .gclient and a from-scratch gclient sync — 97G and"
        echo "hours — which bootstrap-chromium-tree.service (cprussin/dotfiles:"
        echo "config/machines/crux/chromium-build.nix) does on a timer, and a job"
        echo "does not.  It fires 30 minutes after a boot or a deploy and then"
        echo "daily; journalctl -u bootstrap-chromium-tree says what it last did."
      } >&2
      exit 1
    fi

    series="$("$STAMP_SH" identity)" || exit 1
    slot="$(choose "$pin" "$series")"
    was="$(slot_pin "$slot")"

    # Create a temporary link and rename it over the old one. `ln -sfn` onto a
    # directory symlink is two operations and can leave the path missing.
    ln -s "$slot" "$PATH_TO_TREE.new"
    mv -T "$PATH_TO_TREE.new" "$PATH_TO_TREE"

    # After the swap, so a run that dies in it does not mark the slot used.
    touch "$(used_file "$slot")"

    if [ "$was" = "$pin" ]; then
      echo "$PATH_TO_TREE is ${slot##*/}, already at $pin: the reset, the sync, the apply and the compile have nothing to do"
    elif [ -z "$was" ]; then
      echo "$PATH_TO_TREE is ${slot##*/}, which carries no pin: this run builds $pin into it"
    else
      echo "$PATH_TO_TREE is ${slot##*/}, which was at $was: this run takes it to $pin, which is a rebuild"
    fi
    ;;

  list)
    [ -d "$TREES" ] || { echo "no pool at $TREES"; exit 0; }
    current="$(readlink "$PATH_TO_TREE" 2>/dev/null || true)"
    for slot in $(slots); do
      printf '%s\t%s\t%s\n' \
        "$([ "$slot" = "$current" ] && echo '*' || echo ' ')" \
        "${slot##*/}" \
        "$(slot_pin "$slot" || true)"
    done
    ;;

  *) usage ;;
esac
