#!/usr/bin/env bash
set -euo pipefail

ROOT=""
SERIES=""
OVERRIDES=""
while (($# > 0)); do
  case "$1" in
    --root)
      ROOT="$2"
      shift 2
      ;;
    --series)
      SERIES="$2"
      shift 2
      ;;
    --overrides)
      OVERRIDES="$2"
      shift 2
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
done
[[ -d "$ROOT" ]] || { echo "Chromium source root is missing: $ROOT" >&2; exit 1; }
[[ -d "$SERIES" ]] || { echo "Domicile patch series is missing: $SERIES" >&2; exit 1; }
[[ -d "$OVERRIDES" ]] || { echo "Domicile override directory is missing: $OVERRIDES" >&2; exit 1; }

shopt -s nullglob
patches=("$SERIES"/*.patch)
(( ${#patches[@]} > 0 )) || { echo "Domicile patch series is empty" >&2; exit 1; }
for patch in "${patches[@]}"; do
  override="$OVERRIDES/$(basename "$patch")"
  if [[ -f "$override" ]]; then
    patch="$override"
  fi
  git -C "$ROOT" apply "$patch" || {
    echo "Domicile/Thorium overlap needs an explicit port: $(basename "$patch")" >&2
    exit 1
  }
  echo "Applied Domicile $(basename "$patch") after Thorium"
done
