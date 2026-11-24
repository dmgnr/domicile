#!/bin/sh
# Checks an installed Domicile package, inside the distribution's container.
#
# Run by `packages/distro/tests/distro-packages-install.sh` after the install, as root. No
# GPU or display: it checks that every library resolves, that each program
# starts, and that the files a session needs are in place. Prints a `PASS:` or
# `FAIL:` line per check and exits 1 if any failed.
set -u

FAILED=0
pass() { echo "PASS: $1"; }
fail() {
  echo "FAIL: $1"
  [ -z "${2:-}" ] || echo "$2" | sed 's/^/    /'
  FAILED=$((FAILED + 1))
}
check() { # what, command...
  what="$1"
  shift
  if out="$("$@" 2>&1)"; then pass "$what"; else fail "$what" "$out"; fi
}

LOADER=/lib64/ld-linux-x86-64.so.2
LIBEXEC=/usr/libexec/domicile

# Every ELF file Domicile installs that the loader maps: the programs, bun
# and the engine's top level.
for elf in /usr/bin/domicile* "$LIBEXEC/bun" "$LIBEXEC"/engine/chrome \
  "$LIBEXEC"/engine/chrome_crashpad_handler "$LIBEXEC"/engine/*.so*; do
  # The loader fails outright on a missing direct dependency and prints
  # `not found` for a missing indirect one.
  if listed="$("$LOADER" --list "$elf" 2>&1)" &&
    ! echo "$listed" | grep -q 'not found'; then
    pass "every library $elf links resolves"
  else
    fail "every library $elf links resolves" "$listed"
  fi
done

# Domicile's programs bind every symbol they use: a library older than the one
# they were built against can lack one, which `--list` alone does not catch.
for program in /usr/bin/domicile*; do
  # What `ldd -r` runs.
  if listed="$(LD_TRACE_LOADED_OBJECTS=1 LD_WARN=yes LD_BIND_NOW=yes \
    "$LOADER" "$program" 2>&1)" &&
    ! echo "$listed" | grep -q 'undefined symbol'; then
    pass "every symbol $program uses resolves"
  else
    fail "every symbol $program uses resolves" "$listed"
  fi
done

# What the compositor and engine load at run time, by soname.
for library in libEGL.so.1 libgbm.so.1 libwayland-client.so.0 \
  libwayland-egl.so.1 libpam.so.0; do
  if ldconfig -p | grep -q "^[[:space:]]*$library "; then
    pass "$library is on the loader path"
  else
    fail "$library is on the loader path" "ldconfig -p does not list it"
  fi
done

echo '{}' >/tmp/domicile.json
check "domicile runs" /usr/bin/domicile check-config /tmp/domicile.json
check "the engine runs" "$LIBEXEC/engine/chrome" --version
check "bun runs" "$LIBEXEC/bun" --version

# A shell built from an entry, as `domicile` builds a config's shell.
mkdir -p /tmp/desk
cat >/tmp/desk/domicile.tsx <<'EOF'
import { runManganese } from "@domicile-desktop/manganese";
export const Shell = runManganese();
EOF
built="$("$LIBEXEC/builder" --entry /tmp/desk/domicile.tsx --cache /tmp/cache 2>&1)"
root="$(echo "$built" | sed -n 's/.*"root":"\([^"]*\)".*"step":"built".*/\1/p')"
if [ -n "$root" ] && [ -f "$root/shell.js" ]; then
  pass "the builder builds a shell from an entry"
else
  fail "the builder builds a shell from an entry" "$built"
fi

for shell in manganese simple splash; do
  check "the $shell shell is installed" test -f "$LIBEXEC/shells/$shell/shell.js"
done

check "the session runs /usr/bin/domicile" \
  grep -qxF Exec=/usr/bin/domicile /usr/share/wayland-sessions/domicile.desktop
for unit in domicile-session.target domicile-session-shutdown.target domicile-miracast.service; do
  check "$unit is installed" test -f "/usr/lib/systemd/user/$unit"
done
check "the portal backend is installed" \
  test -f /usr/share/xdg-desktop-portal/portals/domicile.portal
check "the portal routing is installed" \
  test -f /usr/share/xdg-desktop-portal/domicile-portals.conf
check "the default-browser file is installed" \
  test -f /usr/share/applications/domicile-mimeapps.list
for entry in history settings screenshot shutdown reboot logout; do
  check "the $entry launcher entry is installed" \
    test -f "/usr/share/applications/domicile-$entry.desktop"
done

check "the domicile group exists" getent group domicile
check "the domicile group may raise its threads" \
  grep -qxF '@domicile - nice -10' /etc/security/limits.d/10-domicile.conf

# Every stack `/etc/pam.d/domicile` includes must exist: `domicile` gives the
# PAM directory explicitly, so a missing one fails every unlock.
if [ -f /etc/pam.d/domicile ]; then
  pass "the domicile PAM service is installed"
  for stack in $(sed -n -e 's/^@include[[:space:]]*//p' \
    -e 's/^[a-z]*[[:space:]]*\(include\|substack\)[[:space:]]*//p' \
    /etc/pam.d/domicile); do
    check "the PAM service's $stack is this distribution's" test -f "/etc/pam.d/$stack"
  done
else
  fail "the domicile PAM service is installed"
fi

# Arch's optional dependencies, which `packages/distro/arch-optdepends.sh` adds.
if command -v pacman >/dev/null; then
  info="$(pacman -Qi domicile)"
  check "UPower is an optional dependency" \
    sh -c 'echo "$1" | sed -n "/^Optional Deps/,/^[A-Z]/p" | grep -q upower' sh "$info"
  check "and not a required one" \
    sh -c '! echo "$1" | grep "^Depends On" | grep -q upower' sh "$info"
fi

[ "$FAILED" -eq 0 ]
