#!/usr/bin/env bash
# The engine keeps one spare renderer warm for the next page, not two.
#
#   nix develop .#full --command \
#     ./packages/domicile-engine/scripts/guard-one-spare-renderer.sh /build/chromium/src
#
# Headless and software-composited. It counts the engine's processes, so it
# needs no pixels and no client.
#
# Why: Chromium's field trial testing config turns on `MultipleSpareRPHs`
# with `count` 2. Each spare is an idle renderer of ~35 MiB that a desk at
# rest holds for nothing. Upstream's default is 1. Patch 0242 makes the
# testing config's study ask for 1.
#
# The engine starts more renderers than the shell's and the spares, so this
# compares two launches: the engine as built, and the same engine told to keep
# one spare with --enable-features. Each counts its renderers SETTLE_SECONDS
# after the shell loads. Asserted:
#
#   the shell page ran    in both launches, or nothing was set up
#   one spare             the engine as built keeps as many renderers as the
#                         one told to keep one spare
#
# Control: NEGATIVE=1 compares 2 spares with 1, and must see one renderer
# more, so a count that matches in the claim is the build's doing.
set -u

SCRIPTS="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=packages/domicile-engine/scripts/lib-annotate.sh
. "$SCRIPTS/lib-annotate.sh"
# shellcheck source=packages/domicile-engine/scripts/lib-last-words.sh
. "$SCRIPTS/lib-last-words.sh"
# shellcheck source=packages/domicile-engine/scripts/lib-profile.sh
. "$SCRIPTS/lib-profile.sh"
# shellcheck source=packages/domicile-engine/scripts/lib-broker.sh
. "$SCRIPTS/lib-broker.sh"

CHROMIUM="${1:-}"
if [ -z "$CHROMIUM" ]; then
  annotate "guard-one-spare-renderer: no path to chromium/src was given"
  exit 1
fi

# NEGATIVE=1 asks for two spares. See the header.
NEGATIVE="${NEGATIVE:-0}"
MODE="claim"
ASKED=""
if [ "$NEGATIVE" = "1" ]; then
  MODE="control"
  ASKED="--enable-features=MultipleSpareRPHs:count/2"
fi
ONE_SPARE="--enable-features=MultipleSpareRPHs:count/1"

OUT="${OUT:-out/Domicile}"
WHICH=""
[ "$NEGATIVE" = "1" ] && WHICH="-negative"
BROKER="${BROKER:-/tmp/domicile-one-spare-renderer$WHICH-broker}"
PROFILE="${PROFILE:-/tmp/domicile-one-spare-renderer$WHICH-profile}"
ENGINE_LOG="${ENGINE_LOG:-/tmp/domicile-one-spare-renderer$WHICH-engine.log}"
FOR_SECONDS="${FOR_SECONDS:-60}"
# Spares start once the shell's page has loaded and the browser is idle.
SETTLE_SECONDS="${SETTLE_SECONDS:-10}"

STARTED=()
cleanup() {
  if [ ${#STARTED[@]} -gt 0 ]; then
    kill "${STARTED[@]}" 2>/dev/null
  fi
  remove_profile "$PROFILE"
}
trap cleanup EXIT

[ -x "$CHROMIUM/$OUT/chrome" ] || {
  annotate "guard-one-spare-renderer: no engine at $CHROMIUM/$OUT/chrome; build it with ./packages/domicile-engine/scripts/build.sh"
  exit 1
}

saw() { # $1 pattern
  grep -qF -- "$1" "$ENGINE_LOG" && echo 1 || echo 0
}

# Every process under the browser, its children's children too. Read from
# /proc, which needs no tool beside bash.
descendants() { # $1 pid
  local stat pid rest parent
  for stat in /proc/[0-9]*/stat; do
    read -r pid rest <"$stat" 2>/dev/null || continue
    # The name in parentheses can hold spaces; the parent follows its ")".
    rest="${rest##*) }"
    parent="${rest#* }"
    parent="${parent%% *}"
    if [ "$parent" = "$1" ]; then
      echo "$pid"
      descendants "$pid"
    fi
  done
}

# Launches the engine with switch $1 (or none), and prints whether the shell
# ran and how many renderers it holds once settled.
renderers_with() { # $1 switch or ""
  local browser pid count=0
  fresh_broker
  rm -rf "$PROFILE"; mkdir -p "$PROFILE"
  rm -f "$ENGINE_LOG"
  # shellcheck disable=SC2086 # $1 is one switch or none.
  "$CHROMIUM/$OUT/chrome" \
    --ozone-platform=headless \
    --disable-gpu \
    --window-size=1024,768 \
    --app="domicile://shell/" \
    --domicile-shell-root="$SCRIPTS" \
    --domicile-shell-module="guard-one-spare-renderer.js" \
    --no-sandbox --password-store=basic --no-first-run --disable-component-update \
    --user-data-dir="$PROFILE" \
    --enable-logging=stderr --log-level=0 \
    $1 \
    --domicile-broker-socket="$BROKER" >"$ENGINE_LOG" 2>&1 &
  browser=$!
  STARTED+=("$browser")
  for _ in $(seq 1 $((FOR_SECONDS * 4))); do
    grep -qF "GUARD shell-loaded" "$ENGINE_LOG" 2>/dev/null && break
    sleep 0.25
  done
  sleep "$SETTLE_SECONDS"
  for pid in $(descendants "$browser"); do
    tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null | grep -qF -- "--type=renderer" &&
      count=$((count + 1))
  done
  echo "$(saw "GUARD shell-loaded") $count"
  kill "$browser" 2>/dev/null
  wait "$browser" 2>/dev/null
}

read -r RAN RENDERERS < <(renderers_with "$ASKED")
read -r REFERENCE_RAN REFERENCE < <(renderers_with "$ONE_SPARE")

MEASURED="$MODE $((RAN & REFERENCE_RAN)) $RENDERERS $REFERENCE"
echo
echo "measured: $MEASURED"
echo "  (mode shell-ran renderers renderers-with-one-spare)"

# Which end to blame. `packages/domicile-engine/tests/test-one-spare-renderer-guard.sh`
# runs this block directly. MEASURED is
# "<mode> <shell-ran> <renderers> <renderers-with-one-spare>".
FAILURE=""
PASSED=""
read -r _ _ GOT ONE <<<"$MEASURED"
case "$MEASURED" in
"claim 0 "* | "control 0 "*)
  FAILURE="the shell page never ran in one of the launches, so nothing here \
was set up: the module did not load, or it threw, and the engine log has its \
console"
  ;;
"claim 1 "*)
  if [ "$GOT" -eq "$ONE" ]; then
    PASSED="an idle desk keeps one spare renderer ($GOT renderers, as with \
one spare asked for)"
  else
    FAILURE="AN IDLE DESK KEPT $((GOT - ONE)) MORE RENDERER(S) THAN WITH ONE \
SPARE ($GOT, not $ONE): each idle spare holds ~35 MiB. The field trial testing \
config asks for 2 through MultipleSpareRPHs; patch 0242 makes that \
study ask for 1"
  fi
  ;;
"control 1 "*)
  if [ "$GOT" -eq "$((ONE + 1))" ]; then
    PASSED="the control is sharp: asked for 2 spares the engine kept one \
renderer more than with 1, so a matching count in the claim is the build's \
doing"
  else
    FAILURE="the control asked for 2 spares and the engine kept $GOT \
renderers against $ONE with 1, so the count says nothing about spares"
  fi
  ;;
*)
  FAILURE="there is no measurement here this guard can place ($MEASURED)"
  ;;
esac

if [ -n "$PASSED" ]; then
  echo "PASS: $PASSED"
  exit 0
fi

annotate_from "guard-one-spare-renderer: $FAILURE" "$ENGINE_LOG"
echo "the engine's last words:" >&2
last_words "$ENGINE_LOG" >&2
exit 1
