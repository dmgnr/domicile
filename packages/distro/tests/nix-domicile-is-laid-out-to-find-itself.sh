#!/usr/bin/env bash
# Checks the `domicile` derivation places its parts where `domicile` looks.
#
# `domicile` finds the compositor and engine from `current_exe` and
# `../libexec`. If `bin/domicile` is a symlink into another derivation,
# `current_exe` resolves to a path with no `libexec`, and the desktop fails at
# run time despite a green build. See
# `/docs/architecture/THE-DOMICILE-BINARY.md`.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
. "$ROOT/packages/distro/lib/nix-check.sh"
require_nix
cd "$ROOT"

out="$(nix build --no-link --print-out-paths .#domicile)"

[ -x "$out/bin/domicile" ] || {
  echo "no bin/domicile in $out" >&2
  exit 1
}
[ ! -L "$out/bin/domicile" ] || {
  echo "bin/domicile is a symlink, so \`current_exe\` will resolve it into a" >&2
  echo "  derivation with no libexec beside it and the desktop will refuse to" >&2
  echo "  start. Copy it." >&2
  exit 1
}
[ -x "$out/bin/domicile-compositor" ] || {
  echo "no bin/domicile-compositor beside the binary" >&2
  exit 1
}
[ -x "$out/libexec/domicile/engine/chrome" ] || {
  echo "libexec/domicile/engine holds no chrome" >&2
  exit 1
}
# Its three lines, joined with `|`.
version="$("$out/bin/domicile" --version | tr '\n' '|')"
grep -qE '^domicile [^|]+\|commit +[0-9a-f]{40}(-dirty)?\|engine +s[0-9a-f]{12}, [^|]+\|$' <<<"$version" || {
  echo "domicile --version does not name the version, commit and engine: $version" >&2
  exit 1
}
[ -x "$out/libexec/domicile/electron-host" ] &&
  [ -f "$(sed -n 's/^exec [^ ]* \([^ ]*\) .*/\1/p' "$out/libexec/domicile/electron-host")" ] || {
  echo "libexec/domicile/electron-host is missing or runs no main.ts, so" >&2
  echo "  domicile open --electron has nothing to run apps with" >&2
  exit 1
}
for program in domicile-history domicile-settings domicile-app-host; do
  [ -x "$out/bin/$program" ] && [ ! -L "$out/bin/$program" ] || {
    echo "bin/$program is missing or a symlink, so it cannot find the" >&2
    echo "  \`domicile\` beside it" >&2
    exit 1
  }
done
[ -f "$out/share/man/man1/domicile.1" ] && [ -f "$out/share/man/man1/domicile-list-windows.1" ] || {
  echo "share/man/man1 lacks domicile.1 or domicile-list-windows.1, so" >&2
  echo "  man domicile finds nothing" >&2
  exit 1
}
for module in settings history; do
  [ -f "$out/libexec/domicile/app-modules/$module/$module.js" ] || {
    echo "libexec/domicile/app-modules/$module holds no $module.js, so" >&2
    echo "  domicile-$module has nothing to run" >&2
    exit 1
  }
done

# Each launcher entry's program, icon and preview, which a launcher finds by
# path.
for entry in history settings screenshot shutdown reboot logout; do
  file="$out/share/applications/domicile-$entry.desktop"
  [ -f "$file" ] || {
    echo "no launcher entry domicile-$entry.desktop" >&2
    exit 1
  }
  for key in Exec Icon X-Domicile-Preview; do
    path="$(sed -n "s/^$key=\([^ ]*\).*/\1/p" "$file")"
    [ -e "$path" ] || {
      echo "domicile-$entry.desktop: $key names $path, which does not exist" >&2
      exit 1
    }
  done
done
echo "domicile is laid out to find the rest of itself"
