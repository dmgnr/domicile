#!/usr/bin/env bash
# Checks a shell's console messages keep their severity in the engine's log.
#
# Chromium logs a page's console at INFO unless its origin is a built-in
# component, so a desktop that logs errors alone dropped even a shell's
# `console.error`. A patch makes the `domicile` scheme, the shell and app
# modules, a built-in component. Without it nothing fails: the shell's
# errors are silently missing from the journal.
#
# Reads the patches, not a Chromium tree, so it runs in the shell group.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
PATCHES="$ROOT/packages/domicile-engine/patches"
[ -d "$PATCHES" ] || { echo "no patch series at $PATCHES" >&2; exit 1; }

FAILED=0
ok()   { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n    %s\n' "$1" "$2"; FAILED=$((FAILED + 1)); }

patch="$(grep -l 'IsBuiltinComponent' "$PATCHES"/*.patch 2>/dev/null | head -1)"
if [ -z "$patch" ]; then
  fail "a patch makes the shell a built-in component" \
    "no patch touches ChromeContentBrowserClient::IsBuiltinComponent"
else
  body="$(grep -a -A8 'IsBuiltinComponent(' "$patch")"
  case "$body" in
    (*"+  if (origin.scheme() == domicile::kDomicileScheme) {"*"+    return true;"*)
      ok "the domicile scheme is a built-in component" ;;
    (*)
      fail "the domicile scheme is a built-in component" \
        "$(basename "$patch") does not return true for domicile::kDomicileScheme" ;;
  esac
fi

[ "$FAILED" = 0 ] && echo "all ok"
exit "$FAILED"
