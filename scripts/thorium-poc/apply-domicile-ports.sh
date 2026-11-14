#!/usr/bin/env bash
set -euo pipefail

ROOT=""
PATCHES=""
while (($# > 0)); do
  case "$1" in
    --root)
      ROOT="$2"
      shift 2
      ;;
    --patches)
      PATCHES="$2"
      shift 2
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
done
[[ -d "$ROOT" ]] || { echo "Chromium source root is missing: $ROOT" >&2; exit 1; }
[[ -d "$PATCHES" ]] || { echo "Domicile patch directory is missing: $PATCHES" >&2; exit 1; }

shopt -s nullglob
patches=("$PATCHES"/*.patch)
(( ${#patches[@]} > 0 )) || { echo "Domicile port patch series is empty" >&2; exit 1; }
for patch in "${patches[@]}"; do
  git -C "$ROOT" apply "$patch" || {
    echo "Domicile/Thorium overlap needs an explicit port: $(basename "$patch")" >&2
    exit 1
  }
  echo "Applied Domicile $(basename "$patch") after Thorium"
done
