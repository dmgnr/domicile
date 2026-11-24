#!/usr/bin/env bash
# Tests `electron-surface-refresh.sh`, which opens a pull request bringing
# electron-host's Electron surface up to Electron's newest releases.
#
# The pull request carries the regenerated surface, coverage.json measured
# against it, a changeset and a `Release-notes: none` trailer, and lists each
# gap it adds. Nothing new is no pull request, one a previous run left open is
# brought up to date, and GitHub's refusals are printed. It is never set to
# merge itself: each new gap is someone's decision. A release that only
# moves the surface's list of versions adds no API, and is no pull request.
#
# `bun`, `bunx` and `curl` are stubbed; `git` runs against a local remote.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
REFRESH="$ROOT/.github/scripts/electron-surface-refresh.sh"
[ -x "$REFRESH" ] || { echo "no $REFRESH" >&2; exit 1; }

command -v git >/dev/null 2>&1 || { echo "  SKIP: no git"; exit 77; }
command -v jq >/dev/null 2>&1 || { echo "  SKIP: no jq"; exit 77; }

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
contains() {
  local what="$1" needle="$2" hay="$3"
  case "$hay" in
    (*"$needle"*) printf '  ok    %s\n' "$what" ;;
    (*) printf '  FAIL  %s\n    expected to mention: %s\n    said: %s\n' \
          "$what" "$needle" "$hay"; FAILED=$((FAILED + 1)) ;;
  esac
}

SURFACE=packages/electron-host/src/electron/surface.ts
COVERAGE=packages/electron-host/src/__integration__/coverage.json
PRELOAD_COVERAGE=packages/electron-host/src/__integration__/preload-coverage.json
EVENTS=packages/electron-host/src/__integration__/events.json
OLD_EVENTS='{
  "gaps": {
    "App.old": "not fired yet"
  },
  "honest": {}
}'

# A repository whose main covers Electron 45.2.1 with one gap, pushed to a
# bare remote, with a detached checkout as `actions/checkout` leaves it.
setup() {
  rm -rf "$WORK/remote" "$WORK/repo" "$WORK/bin"
  git init -q --bare "$WORK/remote"
  git init -q -b main "$WORK/repo"
  git -C "$WORK/repo" config user.email ci@domicile.invalid
  git -C "$WORK/repo" config user.name "domicile CI"
  git -C "$WORK/repo" config push.negotiate false
  mkdir -p "$WORK/repo/.github/scripts" "$WORK/repo/.changeset" \
    "$WORK/repo/packages/electron-host/src/electron" \
    "$WORK/repo/packages/electron-host/src/__integration__"
  cp "$REFRESH" "$WORK/repo/.github/scripts/"
  printf '// GENERATED\n// 45.2.1.\n' >"$WORK/repo/$SURFACE"
  printf '[\n  "app.old missing"\n]\n' >"$WORK/repo/$COVERAGE"
  printf '[\n  "webFrame.old absent"\n]\n' >"$WORK/repo/$PRELOAD_COVERAGE"
  printf '%s\n' "$OLD_EVENTS" >"$WORK/repo/$EVENTS"
  git -C "$WORK/repo" add -A
  git -C "$WORK/repo" commit -qm main
  git -C "$WORK/repo" remote add origin "$WORK/remote"
  git -C "$WORK/repo" push -q origin main
  git -C "$WORK/repo" checkout -q --detach
  MAIN_TIP="$(git -C "$WORK/repo" rev-parse HEAD)"

  mkdir -p "$WORK/bin"
  : >"$WORK/calls"
  # The generator writes the versions it covered; the coverage test writes
  # the gaps it measured, the host's and the preload's. FAKE_VERSIONS,
  # FAKE_GAPS, FAKE_PRELOAD_GAPS and FAKE_EVENTS say what they find.
  cat >"$WORK/bin/bun" <<'BUN'
#!/usr/bin/env bash
case "$*" in
  ("scripts/electron-surface.ts") printf '// GENERATED\n// %s.\n' "$FAKE_VERSIONS" >src/electron/surface.ts ;;
  ("test coverage")
    printf '%s\n' "$FAKE_GAPS" >src/__integration__/coverage.json
    printf '%s\n' "${FAKE_PRELOAD_GAPS:-[
  \"webFrame.old absent\"
]}" >src/__integration__/preload-coverage.json
    printf '%s\n' "${FAKE_EVENTS:-$OLD_EVENTS}" >src/__integration__/events.json ;;
  (*) echo "unexpected bun $*" >&2; exit 1 ;;
esac
BUN
  printf '#!/usr/bin/env bash\nexit 0\n' >"$WORK/bin/bunx"
  cat >"$WORK/bin/curl" <<'CURL'
#!/usr/bin/env bash
method=GET url="" data="" out=/dev/stdout
while [ $# -gt 0 ]; do
  case "$1" in
    (-X) method="$2"; shift ;;
    (-d) data="$2"; shift ;;
    (-o) out="$2"; shift ;;
    (-H|-w) shift ;;
    (http*) url="$1" ;;
  esac
  shift
done
printf '%s %s %s\n' "$method" "$url" "$data" >>"$FAKE_CALLS"
answer() { printf '%s' "$2" >"$out"; printf '%s' "$1"; }
if [ -n "${FAKE_FORBIDDEN:-}" ]; then
  answer 403 '{"message": "Resource not accessible by integration"}'
elif [ -n "${FAKE_PR_EXISTS:-}" ]; then
  answer 422 '{"message": "A pull request already exists"}'
else
  answer 201 '{"number": 7}'
fi
CURL
  chmod +x "$WORK/bin/bun" "$WORK/bin/bunx" "$WORK/bin/curl"
}

refresh() { # extra env assignments
  local out
  if out="$(cd "$WORK/repo" && env PATH="$WORK/bin:$PATH" FAKE_CALLS="$WORK/calls" OLD_EVENTS="$OLD_EVENTS" \
              DOMICILE_WRITEBACK_TOKEN=token GITHUB_REPOSITORY=owner/repo \
              "$@" bash .github/scripts/electron-surface-refresh.sh 2>&1)"; then
    printf 'ok\n%s\n' "$out"
  else
    printf 'refused\n%s\n' "$out"
  fi
}
status() { printf '%s\n' "$1" | head -1; }
pushed() { git -C "$WORK/remote" rev-parse -q --verify "refs/heads/$1" 2>/dev/null || echo missing; }

NEW_GAPS='[
  "app.new missing",
  "app.old missing"
]'

echo "== a new Electron with a new gap is a pull request listing it =="

setup
out="$(refresh FAKE_VERSIONS="46.0.0, 45.2.1" FAKE_GAPS="$NEW_GAPS")"
expect "the refresh succeeds" ok "$(status "$out")"
tip="$(pushed electron-surface-refresh)"
expect "the branch is one commit on main" "$MAIN_TIP" \
  "$(git -C "$WORK/remote" rev-parse "$tip^" 2>/dev/null || echo "not a child of main")"
expect "with the surface, the list and a changeset" \
  ".changeset/electron-surface-refresh.md $COVERAGE $SURFACE" \
  "$(git -C "$WORK/remote" diff --name-only "$tip^" "$tip" | sort | tr '\n' ' ' | sed 's/ $//')"
message="$(git -C "$WORK/remote" log -1 --format=%B "$tip")"
contains "named for the newest Electron" "Cover Electron 46.0.0" "$message"
expect "with the trailer release-notes-required.sh reads" none \
  "$(git -C "$WORK/remote" log -1 --format='%(trailers:key=Release-notes,valueonly)' "$tip" | head -1)"
contains "the changeset names electron-host" '"@domicile-desktop/electron-host": patch' \
  "$(git -C "$WORK/remote" show "$tip:.changeset/electron-surface-refresh.md")"
calls="$(cat "$WORK/calls")"
contains "a pull request is opened into main" '"base":"main"' "$calls"
contains "listing the gap it adds" 'app.new missing' "$calls"
expect "and never set to merge itself" "" "$(grep graphql "$WORK/calls")"

echo "== a new preload gap is a pull request naming it a preload's =="

setup
out="$(refresh FAKE_VERSIONS="46.0.0, 45.2.1" FAKE_GAPS='[
  "app.old missing"
]' FAKE_PRELOAD_GAPS='[
  "webFrame.new absent",
  "webFrame.old absent"
]')"
expect "the refresh succeeds" ok "$(status "$out")"
tip="$(pushed electron-surface-refresh)"
expect "with the surface, the preload's list and a changeset" \
  ".changeset/electron-surface-refresh.md $PRELOAD_COVERAGE $SURFACE" \
  "$(git -C "$WORK/remote" diff --name-only "$tip^" "$tip" | sort | tr '\n' ' ' | sed 's/ $//')"
contains "listing the gap as the preload's" 'preload `webFrame.new absent`' "$(cat "$WORK/calls")"

echo "== an event the host never fires is a pull request naming it an event =="

setup
out="$(refresh FAKE_VERSIONS="46.0.0, 45.2.1" FAKE_GAPS='[
  "app.old missing"
]' FAKE_EVENTS='{
  "gaps": {
    "App.new": "new in Electron: the host does not fire it yet",
    "App.old": "not fired yet"
  },
  "honest": {}
}')"
expect "the refresh succeeds" ok "$(status "$out")"
tip="$(pushed electron-surface-refresh)"
expect "with the surface, the events list and a changeset" \
  ".changeset/electron-surface-refresh.md $EVENTS $SURFACE" \
  "$(git -C "$WORK/remote" diff --name-only "$tip^" "$tip" | sort | tr '\n' ' ' | sed 's/ $//')"
contains "listing it as an event" 'event `App.new`' "$(cat "$WORK/calls")"

echo "== a pull request a previous run left open is brought up to date =="

setup
out="$(refresh FAKE_VERSIONS="46.0.0, 45.2.1" FAKE_GAPS="$NEW_GAPS" FAKE_PR_EXISTS=1)"
expect "the refresh succeeds" ok "$(status "$out")"
contains "saying so" "is open" "$out"
expect "its branch is pushed" yes "$([ "$(pushed electron-surface-refresh)" != missing ] && echo yes)"

echo "== GitHub's refusal is printed, not swallowed =="

setup
out="$(refresh FAKE_VERSIONS="46.0.0, 45.2.1" FAKE_GAPS="$NEW_GAPS" FAKE_FORBIDDEN=1)"
expect "a pull request GitHub will not open is refused" refused "$(status "$out")"
contains "with its status" 403 "$out"
contains "and its reason" "Resource not accessible by integration" "$out"

echo "== no token of the repository's own is refused before anything is pushed =="

setup
out="$(refresh FAKE_VERSIONS="46.0.0, 45.2.1" FAKE_GAPS="$NEW_GAPS" DOMICILE_WRITEBACK_TOKEN=)"
expect "the refresh is refused" refused "$(status "$out")"
contains "naming the secret" DOMICILE_WRITEBACK_TOKEN "$out"
expect "and pushes nothing" missing "$(pushed electron-surface-refresh)"

echo "== no new Electron is no pull request =="

setup
out="$(refresh FAKE_VERSIONS="45.2.1" FAKE_GAPS='[
  "app.old missing"
]')"
expect "the refresh succeeds" ok "$(status "$out")"
contains "saying there is nothing to land" "nothing to land" "$out"
expect "pushes nothing" missing "$(pushed electron-surface-refresh)"
expect "and opens nothing" "" "$(cat "$WORK/calls")"

echo "== a release that adds no API is no pull request =="

setup
out="$(refresh FAKE_VERSIONS="45.3.4, 45.2.1" FAKE_GAPS='[
  "app.old missing"
]')"
expect "the refresh succeeds" ok "$(status "$out")"
contains "saying there is nothing to land" "nothing to land" "$out"
expect "and pushes nothing" missing "$(pushed electron-surface-refresh)"

[ "$FAILED" -eq 0 ] && echo "all ok"
exit "$FAILED"
