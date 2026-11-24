#!/usr/bin/env bash
# Asserts which tree in the pool a run builds in.
#
# Switching the Chromium checkout between pins costs a reset, a `gclient sync`,
# an apply and a near-full compile, about four hours. The pool keeps N trees
# behind one path, so a pin built before is a symlink swap.
#
# Wrong answers differ in cost:
#
#   - Picking a tree without this pin when one has it costs one full build.
#   - Claiming a tree carries this pin when it does not lets
#     `engine-series-stamp.sh` skip the build and report green over uncompiled
#     code.
#
# So this script never vouches for a tree's contents. It picks a directory and
# points the path at it; the stamp check then inspects that tree.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
POOL_SH="$ROOT/.github/scripts/engine-tree-pool.sh"
[ -x "$POOL_SH" ] || { echo "no $POOL_SH" >&2; exit 1; }

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

# A build root with `slots` empty trees. Tests pass it in place of /build.
build_root() { # slots
  local root slot
  root="$(mktemp -d "$WORK/build.XXXXXX")"
  mkdir -p "$root/trees"
  for slot in $(seq 0 $(($1 - 1))); do
    mkdir -p "$root/trees/tree-$slot/src"
  done
  printf '%s\n' "$root"
}

# A slot directory with no Chromium checkout in it.
empty_slot() { # root, slot
  rm -rf "$1/trees/tree-$2/src"
}

# The file `engine-sync.sh` writes when a checkout's DEPS reach a pin. The
# pool reads only this file to learn a slot's pin.
carrying() { # root, slot, pin
  printf '%s\n' "$3" >"$1/trees/tree-$2/.domicile-synced-pin"
}

# Backdates a slot's last-used time, so ordering does not depend on two
# `touch`es in the same second.
used_at() { # root, slot, seconds ago
  local when
  when="$(date -d "@$(($(date +%s) - $3))" +%Y%m%d%H%M.%S)"
  touch -t "$when" "$1/trees/tree-$2/.domicile-last-used"
}

use() { # root, pin — output on stdout, status as the first line
  local out
  if out="$(DOMICILE_BUILD_ROOT="$1" "$POOL_SH" use "$2" 2>&1)"; then
    printf 'ok\n%s\n' "$out"
  else
    printf 'refused\n%s\n' "$out"
  fi
}
status() { printf '%s\n' "$1" | head -1; }

# The slot the path points at, as a slot name.
chose() { # root
  local target
  target="$(readlink "$1/chromium" 2>/dev/null || true)"
  printf '%s\n' "${target##*/}"
}

echo "== a pin that has been built before is a swap, not a build =="

root="$(build_root 3)"
carrying "$root" 0 aaaaaaa
carrying "$root" 1 bbbbbbb
carrying "$root" 2 ccccccc
out="$(use "$root" bbbbbbb)"
expect "a slot carrying the pin is taken" ok "$(status "$out")"
expect "and it is the one that carries it" tree-1 "$(chose "$root")"
contains "and it says the build is the one being skipped" "already at bbbbbbb" "$out"

echo
echo "== a pin nobody has built takes the cheapest slot to lose =="

# An empty slot costs nothing to take, so it goes before any populated one,
# however old. Otherwise the first two pins evict each other while a tree sits
# unused.
root="$(build_root 3)"
carrying "$root" 0 aaaaaaa
used_at "$root" 0 99999
carrying "$root" 2 ccccccc
used_at "$root" 2 1
use "$root" ddddddd >/dev/null
expect "an empty slot is taken before a populated one" tree-1 "$(chose "$root")"

# When every slot holds a pin, evict the least recently used. Picking the
# first or newest would discard a tree another open pull request needs next.
root="$(build_root 3)"
carrying "$root" 0 aaaaaaa
used_at "$root" 0 60
carrying "$root" 1 bbbbbbb
used_at "$root" 1 99999
carrying "$root" 2 ccccccc
used_at "$root" 2 30
use "$root" ddddddd >/dev/null
expect "the least recently used slot is the one evicted" tree-1 "$(chose "$root")"

# A run that died mid-sync leaves a tree between two pins, recording no pin.
# It reads as empty: cheapest to take, and never a match.
root="$(build_root 2)"
carrying "$root" 0 aaaaaaa
used_at "$root" 0 99999
use "$root" eeeeeee >/dev/null
expect "a slot that records no pin is free to take" tree-1 "$(chose "$root")"

# A slot with no checkout also records no pin, but it cannot be built in.
# Taking it makes `engine-reset.sh` fail on `cannot change to
# '/build/chromium/src'`, and every later run would pick it again.
root="$(build_root 2)"
carrying "$root" 0 aaaaaaa
used_at "$root" 0 99999
empty_slot "$root" 1
use "$root" eeeeeee >/dev/null
expect "a slot with no checkout in it is not taken, however cheap it looks" \
  tree-0 "$(chose "$root")"

echo
echo "== the swap has to be real, and it has to be seen =="

root="$(build_root 2)"
carrying "$root" 0 aaaaaaa
use "$root" aaaaaaa >/dev/null
expect "the path is a symlink" symlink \
  "$([ -L "$root/chromium" ] && echo symlink || echo "not a symlink")"
expect "and it reaches the slot's checkout" ok \
  "$([ -d "$root/chromium/src" ] && echo ok || echo "no src behind it")"

# Handing out a slot marks it used. Without the mark, eviction could discard
# the tree just filled.
root="$(build_root 2)"
use "$root" aaaaaaa >/dev/null
expect "the slot it hands out is marked used" ok \
  "$([ -f "$root/chromium/.domicile-last-used" ] && echo ok || echo "not marked")"

# Every step of the engine job asks again for the same pin; the answer must not
# change.
root="$(build_root 2)"
carrying "$root" 0 aaaaaaa
use "$root" aaaaaaa >/dev/null
first="$(chose "$root")"
use "$root" aaaaaaa >/dev/null
expect "asking twice for the same pin does not move" "$first" "$(chose "$root")"

echo
echo "== what it refuses to do =="

# A machine not yet migrated has a real /build/chromium directory holding the
# only tree. Replacing it with a symlink is the setup unit's job, not this
# script's, so the script refuses and names the unit.
root="$(mktemp -d "$WORK/unadopted.XXXXXX")"
mkdir -p "$root/trees" "$root/chromium/src"
out="$(use "$root" aaaaaaa)"
expect "a real directory in the path's place is refused" refused "$(status "$out")"
contains "and the refusal says what has to happen to it" \
  "setup-chromium-trees" "$out"
expect "and nothing was moved" ok \
  "$([ -d "$root/chromium/src" ] && [ ! -L "$root/chromium" ] && echo ok || echo moved)"

# A machine with no pool builds in the existing tree, so this repository and
# the one that deploys the pool can land in either order.
root="$(mktemp -d "$WORK/nopool.XXXXXX")"
mkdir -p "$root/chromium/src"
out="$(use "$root" aaaaaaa)"
expect "no pool at all is not an error" ok "$(status "$out")"
contains "and it says why it did nothing" "no pool" "$out"
expect "and the checkout is untouched" ok \
  "$([ -d "$root/chromium/src" ] && echo ok || echo "it moved something")"

# An empty pool directory is a partial deploy, not "no pool". Treating it as
# no pool would leave the path pointing at a tree nobody chose.
root="$(mktemp -d "$WORK/emptypool.XXXXXX")"
mkdir -p "$root/trees"
out="$(use "$root" aaaaaaa)"
expect "a pool directory with no slots in it is refused" refused "$(status "$out")"
contains "and the refusal names the directory that is empty" "$root/trees" "$out"

# Slots with no checkout are also a partial deploy. Filling one takes ~97G and
# hours of `gclient`, which this script does not do, so it refuses.
root="$(build_root 2)"
empty_slot "$root" 0
empty_slot "$root" 1
out="$(use "$root" aaaaaaa)"
expect "a pool whose slots hold no checkout is refused" refused "$(status "$out")"
# bootstrap-chromium-tree.service fills slots; the unit that creates them is
# not the one to check.
contains "and the refusal says which unit fills them" "bootstrap-chromium-tree" "$out"
expect "and the path is not pointed at one of them" ok \
  "$([ ! -e "$root/chromium" ] && echo ok || echo "it points at $(chose "$root")")"

# ===================================================================
# PICK: CHOOSE AND LOCK IN ONE OPERATION
# ===================================================================
#
# `use` points one shared path at a tree, so only one run can use the pool.
# `pick` prints a tree's path after taking its lock, so concurrent runs get
# different trees or a refusal.
#
# Choosing and locking must be atomic. Otherwise two runs both pick tree-0, and
# one overwrites the other's lock or builds in a tree it does not hold.
pick() { # root pin owner
  DOMICILE_BUILD_ROOT="$1" "$POOL_SH" pick "$2" "$3" 2>&1
}
lock_of() { # root slot
  printf '%s\n' "$1/.domicile-tree-lock-$2"
}

root="$(build_root 2)"
out="$(pick "$root" aaaaaaa 'run one')"
expect "pick names a tree's src" ok \
  "$([ "$out" = "$root/trees/tree-0/src" ] && echo ok || echo "said $out")"
expect "and takes that tree's lock" ok \
  "$([ -d "$(lock_of "$root" tree-0)" ] && echo ok || echo "no lock")"

# Only the lock keeps a second run off the first run's tree; the preference
# order alone would send both to the same slot.
out="$(pick "$root" aaaaaaa 'run two')"
expect "a second run gets a different tree" ok \
  "$([ "$out" = "$root/trees/tree-1/src" ] && echo ok || echo "said $out")"

# With every tree held, the pick refuses. Building in a held tree resets it
# under another run's build.
out="$(DOMICILE_TREE_WAIT=0 pick "$root" aaaaaaa 'run three')"
expect "a third run is refused rather than given a held tree" refused \
  "$(case "$out" in (*::error::*) echo refused ;; (*) echo "$out" ;; esac)"
contains "and the refusal says who holds them" "run one" "$out"

echo
echo "== a run that finds every tree held waits for one, and only one run waits =="

# A run that finds every tree held waits, since trees often free up within
# minutes. A waiting build holds one of crux's two runners, and only a run's
# engine job (which needs a runner) drops its tree. Two waiters would deadlock,
# so a second waiter is refused.
LOCK_SH="$ROOT/.github/scripts/engine-tree-lock.sh"
waiting_pick() { # root pin owner -- in the background, into $WORK/<owner>
  DOMICILE_TREE_WAIT=20 DOMICILE_TREE_POLL=1 \
    pick "$1" "$2" "$3" >"$WORK/$3" &
}
root="$(build_root 2)"
pick "$root" aaaaaaa 'holder one' >/dev/null
pick "$root" aaaaaaa 'holder two' >/dev/null
waiting_pick "$root" aaaaaaa waiter
waiter=$!
sleep 2
out="$(DOMICILE_TREE_WAIT=20 DOMICILE_TREE_POLL=1 pick "$root" aaaaaaa 'second waiter')"
expect "a second run is refused while one waits" refused \
  "$(case "$out" in (*::error::*) echo refused ;; (*) echo "$out" ;; esac)"
contains "and the refusal names the run waiting" "waiter" "$out"
DOMICILE_BUILD_ROOT="$root" "$LOCK_SH" drop "$root/trees/tree-1/src" 'holder two' >/dev/null
wait "$waiter"
expect "the waiter gets the tree that was dropped" "$root/trees/tree-1/src" \
  "$(grep "^/" "$WORK/waiter" | tail -1)"
expect "and holds its lock" waiter "$(cat "$(lock_of "$root" tree-1)/owner")"
expect "and is no longer waiting" absent \
  "$([ -e "$root/.domicile-tree-waiter" ] && echo present || echo absent)"

# A canceled waiter cannot announce it stopped. Waiters refresh a heartbeat
# each poll; one with a stale heartbeat is not waiting.
root="$(build_root 1)"
pick "$root" aaaaaaa 'holder' >/dev/null
mkdir "$root/.domicile-tree-waiter"
echo 'canceled run' >"$root/.domicile-tree-waiter/owner"
touch -d '-1 hour' "$root/.domicile-tree-waiter"/* "$root/.domicile-tree-waiter"
out="$(DOMICILE_TREE_WAIT=1 DOMICILE_TREE_POLL=1 pick "$root" aaaaaaa 'next run')"
contains "a waiter that stopped saying it is alive is replaced" \
  "held after waiting 1s" "$out"
contains "and the wait is bounded, naming who held the trees" "holder" "$out"

# A tree carrying the pin is still preferred. The lock picks among candidates;
# it does not replace the ordering.
root="$(build_root 2)"
printf 'bbbbbbb\n' >"$root/trees/tree-1/src/../.domicile-synced-pin"
out="$(pick "$root" bbbbbbb 'warm run')"
expect "the tree carrying the pin wins even though it is not first" ok \
  "$([ "$out" = "$root/trees/tree-1/src" ] && echo ok || echo "said $out")"

# A waiter whose branch has moved past its commit stops waiting and frees the
# waiting place, as compile slot waiters do. A check that cannot answer does
# not count as "no".
root="$(build_root 1)"
pick "$root" aaaaaaa 'holder' >/dev/null
out="$(DOMICILE_TREE_WAIT=20 DOMICILE_TREE_POLL=1 DOMICILE_TREE_RECHECK=0 \
  DOMICILE_TREE_STILL_WANTED='echo "replaced by abc"; exit 1' \
  GITHUB_OUTPUT="$WORK/replaced.out" pick "$root" aaaaaaa 'replaced run')"
contains "a waiter whose commit was replaced stops waiting" "replaced by abc" "$out"
expect "and tells the workflow so" superseded=true "$(cat "$WORK/replaced.out" 2>/dev/null)"
expect "and gives up the waiting place" absent \
  "$([ -e "$root/.domicile-tree-waiter" ] && echo present || echo absent)"
out="$(DOMICILE_TREE_WAIT=2 DOMICILE_TREE_POLL=1 DOMICILE_TREE_RECHECK=0 \
  DOMICILE_TREE_STILL_WANTED='echo "no route"; exit 3' pick "$root" aaaaaaa 'unsure run')"
contains "a check that cannot answer leaves the wait alone" "held after waiting 2s" "$out"

echo
echo "== a run waits for the tree at its pin rather than rebuilding another =="

# A tree at another pin rebuilds from scratch, about four hours, while the run
# holding this pin's tree is usually done within the hour. The nightly official
# build of 2026-11-23 took the other tree a minute before this pin's came free.
root="$(build_root 2)"
carrying "$root" 0 aaaaaaa
carrying "$root" 1 bbbbbbb
DOMICILE_BUILD_ROOT="$root" "$LOCK_SH" take "$root/trees/tree-0/src" 'holder' >/dev/null 2>&1
waiting_pick "$root" aaaaaaa 'pin waiter'
waiter=$!
# Until it waits: the pool takes seconds to start on a busy machine, and a
# drop before then would let it take the tree without waiting.
for _ in $(seq 60); do
  [ -d "$root/.domicile-tree-waiter" ] && break
  sleep 0.5
done
expect "it leaves the free tree at another pin alone while it waits" absent \
  "$([ -d "$(lock_of "$root" tree-1)" ] && echo present || echo absent)"
DOMICILE_BUILD_ROOT="$root" "$LOCK_SH" drop "$root/trees/tree-0/src" 'holder' >/dev/null
wait "$waiter"
expect "and takes the tree at its pin once it is dropped" "$root/trees/tree-0/src" \
  "$(grep "^/" "$WORK/pin waiter" | tail -1)"
contains "saying why it waited" "rather than rebuilding another" "$(cat "$WORK/pin waiter")"

# The wait is bounded: past it, rebuilding beats waiting longer.
root="$(build_root 2)"
carrying "$root" 0 aaaaaaa
carrying "$root" 1 bbbbbbb
DOMICILE_BUILD_ROOT="$root" "$LOCK_SH" take "$root/trees/tree-0/src" 'holder' >/dev/null 2>&1
out="$(DOMICILE_TREE_WAIT=2 DOMICILE_TREE_POLL=1 pick "$root" aaaaaaa 'impatient run')"
expect "a run that waited its limit takes the tree at another pin" "$root/trees/tree-1/src" \
  "$(printf '%s\n' "$out" | grep "^/" | tail -1)"
contains "and warns that it rebuilds it" "took a tree at another pin" "$out"
expect "and gives up the waiting place" absent \
  "$([ -e "$root/.domicile-tree-waiter" ] && echo present || echo absent)"

# Only one run waits (see above). A second run on the same pin rebuilds the
# other tree rather than wait.
root="$(build_root 2)"
carrying "$root" 0 aaaaaaa
carrying "$root" 1 bbbbbbb
DOMICILE_BUILD_ROOT="$root" "$LOCK_SH" take "$root/trees/tree-0/src" 'holder' >/dev/null 2>&1
mkdir "$root/.domicile-tree-waiter"
echo 'first waiter' >"$root/.domicile-tree-waiter/owner"
touch "$root/.domicile-tree-waiter/alive"
out="$(DOMICILE_TREE_WAIT=20 DOMICILE_TREE_POLL=1 pick "$root" aaaaaaa 'second run')"
expect "with a run already waiting, it takes the tree at another pin at once" \
  "$root/trees/tree-1/src" "$(printf '%s\n' "$out" | grep "^/" | tail -1)"
contains "naming the run that waits" "first waiter" "$out"

# With no tree at the pin there is nothing to wait for.
root="$(build_root 2)"
carrying "$root" 0 bbbbbbb
carrying "$root" 1 ccccccc
DOMICILE_BUILD_ROOT="$root" "$LOCK_SH" take "$root/trees/tree-0/src" 'holder' >/dev/null 2>&1
out="$(DOMICILE_TREE_WAIT=20 DOMICILE_TREE_POLL=1 pick "$root" aaaaaaa 'new pin')"
expect "a run on a pin no tree carries takes a free tree at once" \
  "$root/trees/tree-1/src" "$out"

echo
echo "== a tree held by a run that is over is cleared =="

# A runner shut down mid-build never runs its drop step, and the tree stays
# locked. The workflow's check (given HOLDER) says whether the holder's run is
# over, as for the compile slot.
root="$(build_root 1)"
pick "$root" aaaaaaa 'engine-release.yml run 111 attempt 1' >/dev/null
out="$(DOMICILE_TREE_WAIT=0 \
  DOMICILE_TREE_HOLDER_DONE='[ "$HOLDER" = "engine-release.yml run 111 attempt 1" ] && echo "run 111 is completed"' \
  pick "$root" aaaaaaa 'engine.yml run 222 attempt 1')"
expect "a run takes a tree whose holder's run is over" "$root/trees/tree-0/src" \
  "$(grep '^/' <<<"$out" | tail -1)"
contains "saying whose and why" "run 111 is completed" "$out"
expect "and holds its lock" 'engine.yml run 222 attempt 1' \
  "$(cat "$(lock_of "$root" tree-0)/owner")"

# Only on a yes: a running holder may be mid-build. Any other answer leaves the
# holder alone.
for verdict in 'exit 1' 'echo "no route"; exit 3'; do
  root="$(build_root 1)"
  pick "$root" aaaaaaa 'engine.yml run 333 attempt 1' >/dev/null
  out="$(DOMICILE_TREE_WAIT=0 DOMICILE_TREE_HOLDER_DONE="$verdict" \
    pick "$root" aaaaaaa 'engine.yml run 444 attempt 1')"
  expect "a holder not known to be over keeps the tree ($verdict)" refused \
    "$(case "$out" in (*::error::*) echo refused ;; (*) echo "$out" ;; esac)"
  expect "and still holds it ($verdict)" 'engine.yml run 333 attempt 1' \
    "$(cat "$(lock_of "$root" tree-0)/owner")"
done

# A waiter asks too: the holder's run can end while it waits.
root="$(build_root 1)"
pick "$root" aaaaaaa 'engine.yml run 555 attempt 1' >/dev/null
touch "$WORK/run-555-over"
( sleep 2; rm -f "$WORK/run-555-over" ) &
out="$(DOMICILE_TREE_WAIT=20 DOMICILE_TREE_POLL=1 DOMICILE_TREE_RECHECK=0 \
  DOMICILE_TREE_HOLDER_DONE="[ ! -e '$WORK/run-555-over' ] && echo 'run 555 is completed'" \
  pick "$root" aaaaaaa 'engine.yml run 666 attempt 1')"
wait
expect "a waiter takes the tree once the holder's run is over" "$root/trees/tree-0/src" \
  "$(grep '^/' <<<"$out" | tail -1)"

echo
echo "== a tree already carrying this run's series is the one to take =="

# The pick prefers a tree whose stamp names this run's series, since its reset,
# apply and compile are skipped. Matching only the pin would rebuild a series
# another tree already carries.
SERIES_ID="$("$ROOT/.github/scripts/engine-series-stamp.sh" identity)"
stamped() { # root, slot, identity
  printf '%s\n%s\n' "$3" deadbeef >"$1/trees/tree-$2/.domicile-series-stamp"
}

root="$(build_root 2)"
carrying "$root" 0 aaaaaaa
stamped "$root" 0 some-other-series
used_at "$root" 0 99999
carrying "$root" 1 aaaaaaa
stamped "$root" 1 "$SERIES_ID"
used_at "$root" 1 1
out="$(pick "$root" aaaaaaa 'same series')"
expect "the tree carrying this series wins over the least recently used" ok \
  "$([ "$out" = "$root/trees/tree-1/src" ] && echo ok || echo "said $out")"

# A matching series is preferred, but the lock still decides.
root="$(build_root 2)"
carrying "$root" 0 aaaaaaa
carrying "$root" 1 aaaaaaa
stamped "$root" 1 "$SERIES_ID"
DOMICILE_BUILD_ROOT="$root" "$ROOT/.github/scripts/engine-tree-lock.sh" \
  take "$root/trees/tree-1/src" 'holder' >/dev/null 2>&1
out="$(pick "$root" aaaaaaa 'same series, held')"
expect "a held tree carrying this series is skipped" ok \
  "$([ "$out" = "$root/trees/tree-0/src" ] && echo ok || echo "said $out")"

# With no series match, a tree at the pin loses its series. Evict the least
# recently used, not the first by name, so two pull requests at one pin do not
# evict each other.
root="$(build_root 2)"
carrying "$root" 0 aaaaaaa
stamped "$root" 0 series-x
used_at "$root" 0 1
carrying "$root" 1 aaaaaaa
stamped "$root" 1 series-y
used_at "$root" 1 99999
out="$(pick "$root" aaaaaaa 'new series')"
expect "with no series match, the least recently used tree at the pin is taken" ok \
  "$([ "$out" = "$root/trees/tree-1/src" ] && echo ok || echo "said $out")"

echo
echo "== whether the tree pick would take needs a compile =="

# engine.yml asks this before the build job takes a runner, so a run that will
# compile queues on GitHub without holding a runner. It answers for the tree
# `pick` would take now.
compiles() { # root pin
  : >"$WORK/output"
  DOMICILE_BUILD_ROOT="$1" GITHUB_OUTPUT="$WORK/output" \
    "$POOL_SH" compiles "$2" >/dev/null 2>&1
  sed -n 's/^compile=//p' "$WORK/output"
}
built() { # root slot
  mkdir -p "$1/trees/tree-$2/src/out/Release"
  : >"$1/trees/tree-$2/src/out/Release/args.gn"
  "$ROOT/.github/scripts/engine-compile-slot.sh" built "$1/trees/tree-$2/src"
}

root="$(build_root 2)"
carrying "$root" 0 aaaaaaa
carrying "$root" 1 aaaaaaa
stamped "$root" 1 "$SERIES_ID"
built "$root" 1
expect "a free tree carrying this series, built from it, compiles nothing" \
  false "$(compiles "$root" aaaaaaa)"
expect "and asking takes no lock" ok \
  "$([ ! -d "$(lock_of "$root" tree-1)" ] && echo ok || echo "locked it")"

rm -f "$root/trees/tree-1/.domicile-built"
expect "the same tree never built from it compiles" \
  true "$(compiles "$root" aaaaaaa)"

built "$root" 1
DOMICILE_BUILD_ROOT="$root" "$ROOT/.github/scripts/engine-tree-lock.sh" \
  take "$root/trees/tree-1/src" 'holder' >/dev/null 2>&1
expect "held, so the pick would take the cold tree beside it, which compiles" \
  true "$(compiles "$root" aaaaaaa)"

root="$(build_root 2)"
carrying "$root" 0 aaaaaaa
stamped "$root" 0 some-other-series
built "$root" 0
expect "a warm tree carrying another series compiles" \
  true "$(compiles "$root" aaaaaaa)"

echo
echo "== whether that compile is cold =="

# A cold compile holds the slot for over an hour, a warm one a minute or two.
# engine.yml queues them separately and asks this which is which.
# engine-series-diff.sh is stubbed here; its own test covers it.
cat >"$WORK/series-diff" <<'EOF'
#!/usr/bin/env bash
printf '%s' "$STUB_CHANGED"
exit "${STUB_STATUS:-0}"
EOF
chmod +x "$WORK/series-diff"
cold() { # root pin changed [status]
  : >"$WORK/output"
  DOMICILE_BUILD_ROOT="$1" GITHUB_OUTPUT="$WORK/output" \
    DOMICILE_SERIES_DIFF="$WORK/series-diff" STUB_CHANGED="$3" STUB_STATUS="${4:-0}" \
    "$POOL_SH" compiles "$2" >/dev/null 2>&1
  sed -n 's/^cold=//p' "$WORK/output"
}

root="$(build_root 1)"
carrying "$root" 0 aaaaaaa
stamped "$root" 0 some-other-series
built "$root" 0
expect "a built tree at the pin whose series changes only sources is warm" \
  false "$(cold "$root" aaaaaaa 'content/a.cc
content/b.cc
')"
expect "one that changes a header is cold" \
  true "$(cold "$root" aaaaaaa 'content/a.cc
content/public/a.h
')"
expect "and so is one that changes a mojom, which generates headers" \
  true "$(cold "$root" aaaaaaa 'content/a.mojom
')"
expect "a tree whose changes cannot be read is cold" \
  true "$(cold "$root" aaaaaaa 'content/a.cc' 1)"

rm -f "$root/trees/tree-0/.domicile-built"
expect "a tree at the pin whose out/Release is not built from what it carries is cold" \
  true "$(cold "$root" aaaaaaa 'content/a.cc')"

built "$root" 0
carrying "$root" 0 bbbbbbb
expect "a tree at another pin is cold" true "$(cold "$root" aaaaaaa 'content/a.cc')"

carrying "$root" 0 aaaaaaa
stamped "$root" 0 "$SERIES_ID"
built "$root" 0
expect "a run that compiles nothing is not cold" false "$(cold "$root" aaaaaaa '')"

# A run from a workflow that predates per-tree locks holds the single pool lock
# and may repoint /build/chromium into any tree, so no tree is free.
root="$(build_root 2)"
mkdir "$root/.domicile-tree-lock"
echo "old run" >"$root/.domicile-tree-lock/owner"
out="$(pick "$root" aaaaaaa 'new run')"
expect "a run holding the old single lock blocks every pick" refused \
  "$(case "$out" in (*::error::*) echo refused ;; (*) echo "$out" ;; esac)"
contains "and the refusal names it" "old run" "$out"

echo
if [ "$FAILED" -eq 0 ]; then
  echo "engine-tree-pool: all cases passed"
else
  echo "engine-tree-pool: $FAILED case(s) failed"
fi
exit "$FAILED"
