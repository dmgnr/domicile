#!/usr/bin/env bash
# Tests `nix-cache-push.sh`, which adds the flake's packages to the Nix binary
# cache on R2: only the paths cache.nixos.org lacks, nars before the narinfos
# that name them, signed with the key `flake.nix` tells clients to trust.
#
# Stand-ins for `nix` and `aws` record what they are asked to do. The `nix`
# one serves two packages: `a` built here, `b` substituted.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
PUSH="$ROOT/.github/scripts/nix-cache-push.sh"
[ -x "$PUSH" ] || { echo "no $PUSH" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FAILED=0
expect() {
  local what="$1" want="$2" got="$3"
  if [ "$got" = "$want" ]; then
    printf '  ok    %s\n' "$what"
  else
    printf '  FAIL  %s\n    wanted: %s\n    got:    %s\n' "$what" "$want" "$got"
    FAILED=$((FAILED + 1))
  fi
}

# A checkout holding the script and a flake that trusts `cache-1:public`.
mkdir -p "$WORK/checkout/.github/scripts" "$WORK/bin"
cp "$PUSH" "$WORK/checkout/.github/scripts/"
cat >"$WORK/checkout/flake.nix" <<'FLAKE'
{
  nixConfig = {
    extra-substituters = [ "https://example.com/nix" ];
    extra-trusted-public-keys = [ "cache-1:public" ];
  };
}
FLAKE

cat >"$WORK/bin/nix" <<'STAND_IN'
#!/usr/bin/env bash
case "$1 $2" in
  ("key convert-secret-to-public")
    case "$(cat)" in
      (cache-1:secret) echo cache-1:public ;;
      (*) echo other-1:public ;;
    esac ;;
  ("eval --raw") printf 'a\nb' ;;
  ("build --no-link")
    echo "nix $*" >>"$LOG"
    [ -z "${BUILD_FAILS:-}" ] || exit 1
    echo /nix/store/aaaa-a
    echo /nix/store/bbbb-b ;;
  ("path-info --recursive")
    printf '/nix/store/aaaa-a\tultimate\n'
    printf '/nix/store/dddd-dep\tultimate cache-1:sig\n'
    printf '/nix/store/bbbb-b\tcache.nixos.org-1:sig\n'
    printf '/nix/store/eeee-source\tca:fixed:r:sha256:x\n'
    printf '/nix/store/cccc-glibc\tcache.nixos.org-1:sig\n' ;;
  ("copy --to")
    echo "nix copy --to file://<dir>?<options> ${*:4}" >>"$LOG"
    case "$3" in (*"secret-key=$KEYFILE_PATTERN"*) ;; (*) echo "nix copy without the key: $3" >>"$LOG" ;; esac
    dir="${3#file://}"
    dir="${dir%%\?*}"
    mkdir -p "$dir/nar"
    for hash in aaaa bbbb cccc dddd eeee; do
      printf 'StorePath: /nix/store/%s\nURL: nar/%s-file.nar.zst\n' "$hash" "$hash" >"$dir/$hash.narinfo"
      echo "nar $hash" >"$dir/nar/$hash-file.nar.zst"
    done
    echo "StoreDir: /nix/store" >"$dir/nix-cache-info" ;;
  (*) echo "unexpected nix $*" >&2; exit 1 ;;
esac
STAND_IN
cat >"$WORK/bin/aws" <<'STAND_IN'
#!/usr/bin/env bash
# The local side of a sync, listed, then the call.
for arg in "$@"; do
  case "$arg" in
    (/*)
      (cd "$arg" && find . -type f | sort | sed 's|^\./|  |') >>"$LOG"
      [ ! -f "$arg/nix-cache-info" ] || sed 's/^/    /' "$arg/nix-cache-info" >>"$LOG" ;;
  esac
done
echo "aws $* id=$AWS_ACCESS_KEY_ID region=$AWS_DEFAULT_REGION" | sed "s|$WORK_DIR[^ ]*|<dir>|g" >>"$LOG"
STAND_IN
chmod +x "$WORK/bin/nix" "$WORK/bin/aws"

run() { # environment...
  : >"$WORK/log"
  (cd "$WORK/checkout" && env PATH="$WORK/bin:$PATH" LOG="$WORK/log" TMPDIR="$WORK/tmp" \
    WORK_DIR="$WORK/tmp" KEYFILE_PATTERN="$WORK/tmp/" \
    R2_ACCOUNT_ID=acct R2_ACCESS_KEY_ID=id R2_SECRET_ACCESS_KEY=secret \
    DOMICILE_R2_BUCKET=bucket NIX_CACHE_SIGNING_KEY=cache-1:secret "$@" \
    bash .github/scripts/nix-cache-push.sh 2>&1)
}
mkdir -p "$WORK/tmp"
SYNC="--endpoint-url https://acct.r2.cloudflarestorage.com --only-show-errors"
CREDENTIALS="id=id region=auto"

echo "== a push =="
if out="$(run)"; then
  expect "builds every package, then uploads the nars cache.nixos.org lacks, then their narinfos and the cache info ranked after cache.nixos.org" \
    "nix build --no-link --print-out-paths .#a .#b
nix copy --to file://<dir>?<options> /nix/store/aaaa-a /nix/store/bbbb-b
  aaaa-file.nar.zst
  dddd-file.nar.zst
  eeee-file.nar.zst
aws s3 sync <dir> s3://bucket/nix/nar $SYNC --size-only $CREDENTIALS
  aaaa.narinfo
  dddd.narinfo
  eeee.narinfo
  nix-cache-info
    StoreDir: /nix/store
    WantMassQuery: 1
    Priority: 41
aws s3 sync <dir> s3://bucket/nix $SYNC $CREDENTIALS" \
    "$(cat "$WORK/log")"
else
  printf '  FAIL  the push succeeds\n    %s\n' "$out"
  FAILED=$((FAILED + 1))
fi

echo "== a failed build =="
if out="$(run BUILD_FAILS=1)"; then
  printf '  FAIL  fails\n    it succeeded\n'
  FAILED=$((FAILED + 1))
else
  expect "uploads nothing" "nix build --no-link --print-out-paths .#a .#b" "$(cat "$WORK/log")"
fi

echo "== a key flake.nix does not trust =="
if out="$(run NIX_CACHE_SIGNING_KEY=other-1:secret)"; then
  printf '  FAIL  is refused\n    it succeeded\n'
  FAILED=$((FAILED + 1))
else
  expect "is refused before anything is built" "" "$(cat "$WORK/log")"
fi

echo "== no signing key =="
if out="$(run NIX_CACHE_SIGNING_KEY=)"; then
  printf '  FAIL  is refused\n    it succeeded\n'
  FAILED=$((FAILED + 1))
else
  expect "is refused before anything runs" "" "$(cat "$WORK/log")"
fi

[ "$FAILED" -eq 0 ]
