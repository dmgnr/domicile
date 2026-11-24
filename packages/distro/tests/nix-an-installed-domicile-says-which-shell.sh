#!/usr/bin/env bash
# Checks an installed `domicile` reports bad arguments correctly.
#
# Given a path that is not a shell, `domicile` must complain about the shell.
# A binary that cannot find its compositor or engine fails earlier with a
# different error, so this also checks the layout from the outside (see
# `nix-domicile-is-laid-out-to-find-itself.sh`).
#
# Desktops carry their own page, so they must refuse a shell argument.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
. "$ROOT/packages/distro/lib/nix-check.sh"
require_nix
cd "$ROOT"

out="$(nix build --no-link --print-out-paths .#domicile)"

said="$("$out/bin/domicile" /there-is-no-such-shell 2>&1 || true)"
case "$said" in
  (*"no shell at '/there-is-no-such-shell'"*) ;;
  (*)
    echo "domicile: did not get as far as looking at the page:" >&2
    echo "$said" >&2
    exit 1
    ;;
esac

# Capture, then match. Piping into `grep -q` fails under `pipefail`, because
# `domicile` exits non-zero on a usage error.
said="$("$out/bin/domicile" 2>&1 || true)"
case "$said" in
  (*"which shell?"*) ;;
  (*)
    echo "domicile: given no shell, it did not say so. It said:" >&2
    echo "$said" >&2
    exit 1
    ;;
esac

for name in manganese simple; do
  desktop="$(nix build --no-link --print-out-paths ".#$name")"
  # Captured for the same reason: `nope` exits non-zero.
  said="$("$desktop/bin/$name" nope 2>&1 || true)"
  case "$said" in
    (*"too many arguments"*) ;;
    (*)
      echo "$name: took an argument it has nothing to do with. It said:" >&2
      echo "$said" >&2
      exit 1
      ;;
  esac
done
echo "an installed domicile says which shell, and a desktop refuses one"
