#!/usr/bin/env bash
# Installs each distribution package in its distribution's container and checks
# the result with `packages/distro/lib/distro-installed.sh`.
#
#   DOMICILE_DISTRO_PACKAGES=<dir> packages/distro/tests/distro-packages-install.sh
#   DOMICILE_DISTRO_REPO=<dir> packages/distro/tests/distro-packages-install.sh
#
# <dir> holds `packages/distro/build.sh`'s output, or the repositories `packages/distro/repo.sh`
# made from it, which each package manager installs from, checking the
# signatures. `DOMICILE_DISTROS` picks
# distributions, space separated: debian debian-12 ubuntu ubuntu-22.04 fedora
# opensuse arch (the default is all). Recommended packages are not installed, so the install
# proves the hard dependencies are enough. No GPU is needed: nothing draws.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
INSTALLED="$ROOT/packages/distro/lib/distro-installed.sh"
[ -f "$INSTALLED" ] || { echo "no $INSTALLED" >&2; exit 1; }

PACKAGES="${DOMICILE_DISTRO_PACKAGES:-}"
REPO="${DOMICILE_DISTRO_REPO:-}"
if [ -z "$PACKAGES$REPO" ]; then
  echo "  SKIP: DOMICILE_DISTRO_PACKAGES and DOMICILE_DISTRO_REPO are unset; make packages with packages/distro/build.sh"
  exit 77
fi
if ! docker info >/dev/null 2>&1; then
  echo "  SKIP: no docker daemon to run the distributions' containers"
  exit 77
fi
[ -n "$PACKAGES" ] || PACKAGES="$(mktemp -d)"
PACKAGES="$(cd "$PACKAGES" && pwd)"
[ -n "$REPO" ] || REPO="$(mktemp -d)"
REPO="$(cd "$REPO" && pwd)"

# Each distribution's image, its package, and how it installs a local package
# (`$1`) without recommended ones.
image_of() {
  case "$1" in
    (debian) echo debian:trixie ;;
    (debian-12) echo debian:bookworm ;;
    (ubuntu) echo ubuntu:24.04 ;;
    (ubuntu-22.04) echo ubuntu:22.04 ;;
    (fedora) echo fedora:44 ;;
    (opensuse) echo opensuse/tumbleweed:latest ;;
    (arch) echo archlinux:latest ;;
    (*) return 1 ;;
  esac
}
package_of() {
  case "$1" in
    (debian | ubuntu) echo '*_amd64.deb' ;;
    (debian-12 | ubuntu-22.04) echo '*.noapparmor.deb' ;;
    (fedora) echo '*.fedora.x86_64.rpm' ;;
    (opensuse) echo '*.opensuse.x86_64.rpm' ;;
    (arch) echo '*.pkg.tar.zst' ;;
  esac
}
# Refreshes openSUSE's repositories, retrying for up to 20 minutes.
# download.opensuse.org redirects to mirrors that lag a Tumbleweed snapshot, so
# a refresh can fail on metadata a mirror lacks. A refresh that never succeeds
# fails the install.
ZYPPER_REFRESH='for try in $(seq 20); do
    zypper --non-interactive refresh && break
    [ "$try" -lt 20 ] || exit 1
    echo "zypper refresh failed (try $try of 20); retrying in 60s"
    sleep 60
  done'
# How each installs `domicile` from the signed repositories at `/repo`. These
# are the steps a user takes, with `/repo` as the address.
install_from_repo_of() {
  case "$1" in
    (debian | ubuntu) apt_from_repo current ;;
    (debian-12 | ubuntu-22.04) apt_from_repo legacy ;;
    (fedora)
      echo 'rpm --import /repo/domicile.asc &&
        printf "[domicile]\nname=Domicile\nbaseurl=file:///repo/rpm/fedora\ngpgcheck=1\nrepo_gpgcheck=1\ngpgkey=file:///repo/domicile.asc\n" >/etc/yum.repos.d/domicile.repo &&
        dnf install -y --setopt=install_weak_deps=False domicile' ;;
    (opensuse)
      echo 'rpm --import /repo/domicile.asc &&
        zypper --non-interactive addrepo --gpgcheck file:///repo/rpm/opensuse domicile &&
        '"$ZYPPER_REFRESH"' &&
        zypper --non-interactive --no-refresh install --no-recommends domicile' ;;
    (arch)
      echo 'pacman-key --init && pacman-key --add /repo/domicile.asc &&
        pacman-key --lsign-key "$(gpg --show-keys --with-colons /repo/domicile.asc | awk -F: "/^fpr/ {print \$10; exit}")" &&
        printf "[domicile]\nServer = file:///repo/arch/\$arch\n" >>/etc/pacman.conf &&
        pacman -Syu --noconfirm domicile' ;;
  esac
}
apt_from_repo() { # suite
  echo 'echo "deb [signed-by=/repo/domicile.asc] file:/repo/apt '"$1"' main" >/etc/apt/sources.list.d/domicile.list &&
    apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends domicile'
}
install_of() {
  case "$1" in
    (debian | debian-12 | ubuntu | ubuntu-22.04)
      echo 'apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$1"' ;;
    (fedora) echo 'dnf install -y --nogpgcheck --setopt=install_weak_deps=False "$1"' ;;
    (opensuse) echo "$ZYPPER_REFRESH"' && zypper --non-interactive --no-refresh install --no-recommends --allow-unsigned-rpm "$1"' ;;
    (arch) echo 'pacman -Syu --noconfirm && pacman -U --noconfirm "$1"' ;;
  esac
}

FAILED=0
for distro in ${DOMICILE_DISTROS:-debian debian-12 ubuntu ubuntu-22.04 fedora opensuse arch}; do
  image="$(image_of "$distro")" || {
    echo "no distribution named $distro" >&2
    exit 1
  }
  if [ -n "${DOMICILE_DISTRO_REPO:-}" ]; then
    install="$(install_from_repo_of "$distro")"
    package=/repo
  else
    install="$(install_of "$distro")"
    set -- $(cd "$PACKAGES" && ls $(package_of "$distro") 2>/dev/null)
    if [ "$#" -ne 1 ]; then
      echo "FAIL: $distro: wanted one $(package_of "$distro") in $PACKAGES, found $#"
      FAILED=$((FAILED + 1))
      continue
    fi
    package="/packages/$1"
  fi
  echo "== $distro ($image): $package =="
  # One `sh -c`, so the install and the checks share the container.
  if timeout -k 30 1800 docker run --rm \
      -v "$PACKAGES:/packages:ro" \
      -v "$REPO:/repo:ro" \
      -v "$INSTALLED:/distro-installed.sh:ro" \
      "$image" sh -c "$install && sh /distro-installed.sh" \
      sh "$package" 2>&1 | sed "s/^PASS: /PASS: $distro: /"; then
    echo "$distro: ok"
  else
    echo "FAIL: $distro: the install or a check failed"
    FAILED=$((FAILED + 1))
  fi
done

[ "$FAILED" -eq 0 ]
