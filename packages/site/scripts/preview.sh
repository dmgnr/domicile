#!/usr/bin/env bash
# Builds the site from a copy of the repository and serves it on localhost.
# `nix run .#site-preview` sets SITE_SOURCE to the flake's source. Builds are
# kept per source, so a second run of the same commit only serves.
set -euo pipefail

: "${SITE_SOURCE:?the repository to build, as nix run .#site-preview sets it}"

cache="${XDG_CACHE_HOME:-$HOME/.cache}/domicile-site-preview"
build="$cache/$(basename "$SITE_SOURCE")"

if [ ! -d "$build" ]; then
  # Other commits' builds hold a full install each.
  rm -rf "$cache"
  mkdir -p "$cache"
  staging="$build.partial"
  cp -r --no-preserve=mode "$SITE_SOURCE" "$staging"
  (
    cd "$staging"
    bun install --frozen-lockfile --filter @domicile-desktop/site --filter ./
    bun run turbo run build --filter=@domicile-desktop/site^...
    cd packages/site
    bun --bun next build
  )
  mv "$staging" "$build"
fi

cd "$build/packages/site"
exec bun --bun next start --port "${PORT:-3000}"
