#!/usr/bin/env bash
# Adds the flake's packages to Domicile's Nix binary cache,
# https://packages.domicile-desktop.com/nix, the `nix/` prefix of the packages
# bucket on R2.
#
#   .github/scripts/nix-cache-push.sh
#
# Uploads only the paths cache.nixos.org lacks.
# Nars go up before the narinfos that name them, so a client never reads a
# narinfo whose nar is missing.
#
# Needs `nix` and `aws` on PATH, and:
#
# - `NIX_CACHE_SIGNING_KEY`: the cache's secret key, whose public key is the
#   one `flake.nix`'s `nixConfig` trusts;
# - `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`: an R2 token that can write the
#   bucket;
# - `R2_ACCOUNT_ID`, `DOMICILE_R2_BUCKET`: override Domicile's Cloudflare
#   account and the `domicile-packages` bucket.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

: "${NIX_CACHE_SIGNING_KEY:?}" "${R2_ACCESS_KEY_ID:?}" "${R2_SECRET_ACCESS_KEY:?}"
R2_ACCOUNT_ID="${R2_ACCOUNT_ID:-9e3478be0713138076f5a66696ba7817}"
DOMICILE_R2_BUCKET="${DOMICILE_R2_BUCKET:-domicile-packages}"
export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
export AWS_DEFAULT_REGION=auto
BUCKET="s3://$DOMICILE_R2_BUCKET/nix"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

KEY="$WORK/key"
(umask 077 && printf '%s\n' "$NIX_CACHE_SIGNING_KEY" >"$KEY")

# A key clients don't trust would fill the cache with paths they refuse.
trusted="$(sed -n 's/^ *extra-trusted-public-keys = \[ *"\([^"]*\)".*/\1/p' flake.nix)"
signs_as="$(nix key convert-secret-to-public <"$KEY")"
[ "$signs_as" = "$trusted" ] || {
  echo "NIX_CACHE_SIGNING_KEY signs as $signs_as, and flake.nix trusts $trusted" >&2
  exit 1
}

# Each command's output is captured before it is split, so its failure stops
# the script.
names="$(nix eval --raw .#packages.x86_64-linux \
  --apply 'packages: builtins.concatStringsSep "\n" (builtins.attrNames packages)')"
mapfile -t names <<<"$names"
outputs="$(nix build --no-link --print-out-paths "${names[@]/#/.#}")"
mapfile -t outputs <<<"$outputs"

# Every path cache.nixos.org did not sign: built here, added from source
# (`./file`, `builtins.toFile`), or substituted from this cache.
signatures="$(nix path-info --recursive --sigs "${outputs[@]}")"
mapfile -t built < <(awk '{ for (i = 2; i <= NF; i++) if ($i ~ /^cache\.nixos\.org-1:/) next; print $1 }' <<<"$signatures")

# A binary cache takes a path only with its references, so the whole closure
# goes into the local one and only `built` is uploaded.
nix copy --to "file://$WORK/cache?compression=zstd&parallel-compression=true&secret-key=$KEY" "${outputs[@]}"

NARS="$WORK/nars"
INFO="$WORK/info"
mkdir -p "$NARS" "$INFO"
for path in "${built[@]}"; do
  hash="$(basename "$path")"
  hash="${hash%%-*}"
  narinfo="$WORK/cache/$hash.narinfo"
  ln "$narinfo" "$INFO/"
  ln -f "$WORK/cache/$(sed -n 's/^URL: //p' "$narinfo")" "$NARS/"
done
# After cache.nixos.org (40), which serves most of a closure.
printf 'StoreDir: /nix/store\nWantMassQuery: 1\nPriority: 41\n' >"$INFO/nix-cache-info"

sync() { # from, to, flags...
  aws s3 sync "$1" "$2" --endpoint-url "https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com" \
    --only-show-errors "${@:3}"
}
# A nar's name is its hash, so one the same size is the same nar.
sync "$NARS" "$BUCKET/nar" --size-only
sync "$INFO" "$BUCKET"
echo "uploaded ${#built[@]} paths to $BUCKET"
