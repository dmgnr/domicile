#!/usr/bin/env bash
# Tests `no-pin-roll-open.sh`, the check that keeps Renovate from automerging
# while a Chromium pin roll is open. Nothing else may merge during a roll.
#
# A roll is an open pull request that changes
# `packages/domicile-engine/CHROMIUM_PIN`, among however many other files.
# `gh` is stubbed.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
CHECK="$ROOT/.github/scripts/no-pin-roll-open.sh"
[ -x "$CHECK" ] || { echo "no $CHECK" >&2; exit 1; }

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

# gh answers as the REST API would for the open pull requests in $OPEN_PRS:
# "<number>:<file>,<file> <number>:<file>...".
mkdir -p "$WORK/bin"
cat >"$WORK/bin/gh" <<'GH'
#!/usr/bin/env bash
case "$*" in
  "api --paginate repos/o/r/pulls?state=open&per_page=100 --jq .[].number")
    for pr in $OPEN_PRS; do echo "${pr%%:*}"; done ;;
  "api --paginate repos/o/r/pulls/"*"/files?per_page=100 --jq .[].filename")
    number="${3#repos/o/r/pulls/}"; number="${number%%/*}"
    for pr in $OPEN_PRS; do
      [ "${pr%%:*}" = "$number" ] && printf '%s\n' "${pr#*:}" | tr , '\n'
    done
    true ;;
  *) echo "gh called with: $*" >&2; exit 1 ;;
esac
[ -z "${GH_FAILS:-}" ] || { echo "HTTP 502" >&2; exit 1; }
GH
chmod +x "$WORK/bin/gh"

run() {
  PATH="$WORK/bin:$PATH" GITHUB_REPOSITORY=o/r OPEN_PRS="$1" "$CHECK" "${@:2}" \
    >"$WORK/out" 2>&1
}

echo "No roll open"
run "5:package.json,bun.lock"
expect "it passes" 0 "$?"

echo "A roll open"
run "5:package.json 9:packages/domicile-engine/patches/0001.patch,packages/domicile-engine/CHROMIUM_PIN"
expect "it fails" 1 "$?"
expect "it names the roll" "#9 rolls the Chromium pin; nothing merges until it lands" "$(cat "$WORK/out")"

echo "GitHub failing"
GH_FAILS=1 run "5:package.json"
expect "it fails rather than pass" 1 "$?"

echo "A stray argument"
run "" --bad
expect "it fails as misused" 2 "$?"

[ "$FAILED" -eq 0 ] || { echo "$FAILED failed"; cat "$WORK/out"; exit 1; }
