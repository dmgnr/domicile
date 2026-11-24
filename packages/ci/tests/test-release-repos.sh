#!/usr/bin/env bash
# Tests `release-repos.sh`, which brings the published repositories down from
# R2, adds a release with `packages/distro/repo.sh` and puts them back: the packages
# before the indexes that name them, and deletions last. The Nix cache under
# `nix/` is neither downloaded nor deleted.
#
# Stand-ins for `aws` and `packages/distro/repo.sh` record what they are asked to do.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
RELEASE_REPOS="$ROOT/.github/scripts/release-repos.sh"
[ -x "$RELEASE_REPOS" ] || { echo "no $RELEASE_REPOS" >&2; exit 1; }

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

# A checkout holding the script and a stand-in `packages/distro/repo.sh`.
mkdir -p "$WORK/checkout/.github/scripts" "$WORK/checkout/packages/distro" "$WORK/bin" "$WORK/packages"
cp "$RELEASE_REPOS" "$WORK/checkout/.github/scripts/"
cat >"$WORK/checkout/packages/distro/repo.sh" <<'STAND_IN'
#!/usr/bin/env bash
echo "repo.sh $* key=${DOMICILE_SIGNING_KEY:0:4}" >>"$LOG"
STAND_IN
cat >"$WORK/bin/aws" <<'STAND_IN'
#!/usr/bin/env bash
echo "aws $* id=$AWS_ACCESS_KEY_ID region=$AWS_DEFAULT_REGION" >>"$LOG"
STAND_IN
chmod +x "$WORK/checkout/packages/distro/repo.sh" "$WORK/bin/aws"

run() { # environment...
  : >"$WORK/log"
  (cd "$WORK/checkout" && env PATH="$WORK/bin:$PATH" LOG="$WORK/log" \
    R2_ACCOUNT_ID=acct R2_ACCESS_KEY_ID=id R2_SECRET_ACCESS_KEY=secret \
    DOMICILE_R2_BUCKET=bucket DOMICILE_SIGNING_KEY=real-key "$@" \
    bash .github/scripts/release-repos.sh "$WORK/packages" "$WORK/repo" 2>&1)
}
ENDPOINT="--endpoint-url https://acct.r2.cloudflarestorage.com"
CREDENTIALS="id=id region=auto"

echo "== a release =="
if out="$(run)"; then
  expect "downloads, adds, uploads the packages, then the rest" \
    "aws s3 sync s3://bucket $WORK/repo $ENDPOINT --exclude nix/* --only-show-errors $CREDENTIALS
repo.sh $WORK/packages $WORK/repo key=real
aws s3 sync $WORK/repo s3://bucket $ENDPOINT --exclude nix/* --only-show-errors --exclude * --include *.deb --include *.rpm --include *.pkg.tar.zst --include *.pkg.tar.zst.sig $CREDENTIALS
aws s3 sync $WORK/repo s3://bucket $ENDPOINT --exclude nix/* --only-show-errors --delete $CREDENTIALS" \
    "$(cat "$WORK/log")"
else
  printf '  FAIL  the release succeeds\n    %s\n' "$out"
  FAILED=$((FAILED + 1))
fi

echo "== a dry run =="
if out="$(run DOMICILE_RELEASE_DRY_RUN=1)"; then
  expect "downloads and adds, and only shows the upload" \
    "aws s3 sync s3://bucket $WORK/repo $ENDPOINT --exclude nix/* --only-show-errors $CREDENTIALS
repo.sh $WORK/packages $WORK/repo key=real
aws s3 sync $WORK/repo s3://bucket $ENDPOINT --exclude nix/* --delete --dryrun $CREDENTIALS" \
    "$(cat "$WORK/log")"
else
  printf '  FAIL  the dry run succeeds\n    %s\n' "$out"
  FAILED=$((FAILED + 1))
fi

echo "== a release without the R2 credentials =="
if out="$(run R2_SECRET_ACCESS_KEY=)"; then
  printf '  FAIL  is refused\n    it succeeded\n'
  FAILED=$((FAILED + 1))
else
  expect "is refused before anything runs" "" "$(cat "$WORK/log")"
fi

echo "== a release with neither account nor bucket set =="
if out="$(run R2_ACCOUNT_ID= DOMICILE_R2_BUCKET=)"; then
  expect "uses Domicile's account and bucket" \
    "aws s3 sync s3://domicile-packages $WORK/repo --endpoint-url https://9e3478be0713138076f5a66696ba7817.r2.cloudflarestorage.com --exclude nix/* --only-show-errors $CREDENTIALS" \
    "$(head -1 "$WORK/log")"
else
  printf '  FAIL  the release succeeds\n    %s\n' "$out"
  FAILED=$((FAILED + 1))
fi

[ "$FAILED" -eq 0 ]
