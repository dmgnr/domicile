#!/usr/bin/env bash
# Checks `domicile set-log-level` reaches every engine process.
#
# The browser applies the levels in `src/content/browser/domicile/
# domicile_log_levels.cc`. A patch carries them to each child process over
# `mojom::ChildProcess`, and to one started later as its host binds it.
# Without any of these, the renderers and the GPU process keep logging at their
# starting levels and nothing fails.
#
# Reads `src/` and the patches, not a Chromium tree, so it runs in the shell
# group.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
ENGINE="$ROOT/packages/domicile-engine"
PATCHES="$ENGINE/patches"
[ -d "$PATCHES" ] || { echo "no patch series at $PATCHES" >&2; exit 1; }

FAILED=0
ok()   { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n    %s\n' "$1" "$2"; FAILED=$((FAILED + 1)); }

added="$(cat "$PATCHES"/*.patch 2>/dev/null | grep -a '^+' || true)"
in_patches() { case "$added" in (*"$1"*) return 0 ;; (*) return 1 ;; esac }

for f in content/browser/domicile/domicile_log_levels.h \
         content/browser/domicile/domicile_log_levels.cc \
         content/public/browser/domicile_log_levels.h; do
  if [ -f "$ENGINE/src/$f" ]; then
    ok "$f exists"
  else
    fail "$f exists" "no such file under src/"
  fi
done

check() {
  if in_patches "$1"; then
    ok "$2"
  else
    fail "$2" "$3"
  fi
}

check 'SetLogLevels(int32 min_level, string vmodule);' \
  "a child process takes levels over mojom::ChildProcess" \
  "no patch adds SetLogLevels to content/common/child_process.mojom"
check 'logging::SetVmodule(vmodule);' \
  "a child process applies them" \
  "no patch implements SetLogLevels in content/child/child_thread_impl.cc"
check 'BASE_EXPORT void SetVmodule(std::string_view vmodule_switch);' \
  "base can replace the vmodule patterns" \
  "no patch adds logging::SetVmodule to base/logging.h"
check 'SendDomicileLogLevels(*child_process_);' \
  "a child process started later gets the last levels" \
  "no patch calls SendDomicileLogLevels as a host binds its child process"
check '"domicile/domicile_log_levels.cc",' \
  "the levels are in content's build" \
  "no patch adds domicile/domicile_log_levels.cc to content/browser/BUILD.gn"
check '"domicile_log_levels.h",' \
  "the public header is in content's build" \
  "no patch adds domicile_log_levels.h to content/public/browser/BUILD.gn"

if [ "$FAILED" -gt 0 ]; then
  echo "$FAILED failed"
  exit 1
fi
echo "all ok"
