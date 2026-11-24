#!/usr/bin/env bash
# Tests `packages/distro/nfpm-config.sh`, which fills in `packages/distro/nfpm.yaml` for one
# package.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
CONFIG_SH="$ROOT/packages/distro/nfpm-config.sh"
[ -x "$CONFIG_SH" ] || { echo "no $CONFIG_SH" >&2; exit 1; }

FAILED=0
ok() { printf '  ok    %s\n' "$1"; }
fail() {
  printf '  FAIL  %s\n    %s\n' "$1" "$2"
  FAILED=$((FAILED + 1))
}
has() { # what, config, needle
  case "$2" in
    (*"$3"*) ok "$1" ;;
    (*) fail "$1" "no $3 in the config" ;;
  esac
}
lacks() { # what, config, needle
  case "$2" in
    (*"$3"*) fail "$1" "$3 is in the config" ;;
    (*) ok "$1" ;;
  esac
}

config() { # pam, flags...
  "$CONFIG_SH" /stage "$1" 0.20260101.000000 2.34 "${@:2}" 2>&1
}

echo "the values are filled in"
debian="$(config debian)" || fail "nfpm-config.sh succeeds" "$debian"
has "the version" "$debian" 'version: "0.20260101.000000"'
has "the glibc" "$debian" 'libc6 (>= 2.34)'
has "the PAM file" "$debian" '/distro/pam/debian'
lacks "every placeholder" "$debian" '@stage@'

echo "the Debian 13 and Ubuntu 24.04 package lets the engine make namespaces"
has "with the AppArmor profile" "$debian" 'dst: /etc/apparmor.d/domicile-engine'
has "which it loads" "$debian" 'postinstall-deb.sh'
has "and needs AppArmor 4" "$debian" 'apparmor (<< 4.0)'

echo "the package for releases before AppArmor 4 has no profile"
older="$(config debian --without-apparmor)" ||
  fail "nfpm-config.sh --without-apparmor succeeds" "$older"
lacks "no profile" "$older" 'apparmor-engine'
lacks "no profile to load" "$older" 'postinstall-deb.sh'
lacks "no AppArmor version" "$older" 'apparmor (<<'
for kept in 'name: domicile' 'dst: /etc/pam.d/domicile' 'libc6 (>= 2.34)' \
  'compression: zstd' 'summary: '; do
  has "and keeps $kept" "$older" "$kept"
done
has "the group is still made" "$older" '/distro/postinstall.sh'

echo "each RPM distribution gets the recorder's plugins by its own names"
fedora="$(config fedora)" || fail "nfpm-config.sh succeeds for Fedora" "$fedora"
opensuse="$(config opensuse)" || fail "nfpm-config.sh succeeds for openSUSE" "$opensuse"
has "Fedora's pipewire plugin" "$fedora" '- pipewire-gstreamer'
has "Fedora's good plugins" "$fedora" '- gstreamer1-plugins-good'
has "openSUSE's pipewire plugin" "$opensuse" '- gstreamer-plugin-pipewire'
has "openSUSE's good plugins" "$opensuse" '- gstreamer-plugins-good'
opensuse_depends="$(sed -n '/^  rpm:/,/^    recommends:/p' <<<"$opensuse")"
lacks "no Fedora names in openSUSE's dependencies" "$opensuse_depends" 'gstreamer1-'
lacks "every placeholder on openSUSE" "$opensuse" '"@rpm-gstreamer@"'

echo "every format recommends wl-clipboard, which Electron apps' clipboard runs"
has "Debian" "$debian" '- wl-clipboard'
has "Fedora" "$fedora" '- wl-clipboard'
has "openSUSE" "$opensuse" '- wl-clipboard'
has "Arch" "$(cat "$ROOT/packages/distro/arch-optdepends")" 'wl-clipboard:'

echo "every format recommends xdg-utils, which Electron apps ask for link handlers"
has "Debian" "$debian" '- xdg-utils'
has "Fedora" "$fedora" '- xdg-utils'
has "openSUSE" "$opensuse" '- xdg-utils'
has "Arch" "$(cat "$ROOT/packages/distro/arch-optdepends")" 'xdg-utils:'

echo "Arch requires only what the desktop needs"
arch_depends="$(config archlinux | sed -n '/^  archlinux:/,/^[a-z]/p')"
while IFS=: read -r optional _; do
  lacks "$optional is optional" "$arch_depends" "- $optional"$'\n'
done < <(grep -v -e '^#' -e '^$' "$ROOT/packages/distro/arch-optdepends")

if [ "$FAILED" -gt 0 ]; then
  echo "$FAILED failed"
  exit 1
fi
echo "all ok"
