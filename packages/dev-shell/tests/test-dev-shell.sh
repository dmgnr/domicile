#!/usr/bin/env bash
# Tests what `dev-shell.sh` passes to the desktop and what it refuses.
#
# Covers which module the desktop serves, that the compositor comes from this
# checkout, where the control socket path comes from, and what a finished
# build does. Each failure would otherwise show up as something else: a blank
# page, a shell that never joins, or a loop that reloads nothing.
#
# The launch block runs out of the real script with `nix`, `cargo`, `bunx` and
# `domicile` stubbed. `dev-shell-reload.sh` takes its inputs as arguments, so
# the real loop runs below.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SCRIPT_UNDER_TEST="$ROOT/packages/dev-shell/bin/dev-shell.sh"
[ -x "$SCRIPT_UNDER_TEST" ] || { echo "no $SCRIPT_UNDER_TEST" >&2; exit 1; }

# From the engine resolution to the end of the script.
LAUNCH="$(awk '/^ENGINE="\$\{DOMICILE_ENGINE:-\}"$/,0' "$SCRIPT_UNDER_TEST")"
[ -n "$LAUNCH" ] || {
  echo "no launch in $SCRIPT_UNDER_TEST — its markers moved." >&2
  exit 1
}
case "$LAUNCH" in
  (*DOMICILE_PAGE*target/debug/domicile*) ;;
  (*) echo "the launch block no longer starts a desktop." >&2; exit 1 ;;
esac

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

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
CHECKOUT="$WORK/checkout"

# Prints what the desktop received, one line per variable, so a variable that
# stops being passed shows up as `unset` or empty.
launch() { # $1 DOMICILE_ENGINE
  (
    ROOT="$CHECKOUT"
    SHELL_NAME=simple
    PAGE_DIR="$WORK/page"
    DOMICILE_ENGINE="$1"
    # `nix` must not run when an engine was passed in, or the dev loop needs a
    # network.
    nix() { echo "nix $*" >>"$WORK/nix.log"; echo "$WORK/store-engine"; }
    command() { [ "${2:-}" = "nix" ] && return 0; builtin command "$@"; }
    # The launch builds the components with cargo; this test does not.
    cargo() { echo "cargo $*" >>"$WORK/cargo.log"; }
    mkdir -p "$ROOT/target/debug"
    cat >"$ROOT/target/debug/domicile" <<'STUB'
#!/usr/bin/env bash
echo "shell=$1"
echo "engine=${DOMICILE_ENGINE:-unset}"
echo "page=${DOMICILE_PAGE:-}"
echo "reload=${DOMICILE_DEV_RELOAD:-unset}"
echo "compositor=${DOMICILE_COMPOSITOR:-unset}"
echo "bridge=${DOMICILE_BRIDGE:-unset}"
# The two supervisor lines the script reads. Checks below confirm
# `bin/domicile.rs` still prints them.
echo "domicile is up. shell /desk/shell.js · platform wayland · DOMICILE_SOCK=/run/user/1000/domicile-ipc.4242.sock"
STUB
    chmod +x "$ROOT/target/debug/domicile"
    eval "$LAUNCH"
  ) 2>&1
}

: >"$WORK/nix.log"
handed="$(launch "$WORK/my-engine")"

expect "the engine handed in is the one that is run" \
  "engine=$WORK/my-engine" \
  "$(printf '%s\n' "$handed" | sed -n 's/^engine=/engine=/p')"

# The engine has no dev-reload support, so passing a token would imply a reload
# that never happens.
expect "no reload token is handed over any more" "reload=unset" \
  "$(printf '%s\n' "$handed" | sed -n 's/^reload=/reload=/p')"

# `domicile` takes the module file and refuses a directory. `shell.js` is the
# name the shell's vite config sets.
expect "the desktop is handed the module the watcher writes" \
  "page=$WORK/page/shell.js" \
  "$(printf '%s\n' "$handed" | sed -n 's/^page=/page=/p')"

# `domicile` builds nothing, so this script builds and passes the compositor.
# Otherwise the desktop looks beside `target/debug/domicile`.
expect "the compositor comes out of this checkout" \
  "compositor=$CHECKOUT/target/debug/domicile-compositor" \
  "$(printf '%s\n' "$handed" | sed -n 's/^compositor=/compositor=/p')"

# The engine serves the shell over `domicile://`, so there is no bridge.
expect "no bridge is handed over any more" "bridge=unset" \
  "$(printf '%s\n' "$handed" | sed -n 's/^bridge=/bridge=/p')"

expect "an engine that was handed in is not fetched again" "" \
  "$(cat "$WORK/nix.log")"

# The supervisor sets `DOMICILE_SOCK` only on processes it spawns, so the script
# reads the path from the supervisor's output instead of reimplementing
# `control_socket::address`.
#
# It writes the path only once the desktop is up. The socket is bound before
# the engine starts, so an earlier reload would be refused.
expect "the socket is taken from what the desktop printed" \
  "/run/user/1000/domicile-ipc.4242.sock" "$(cat "$WORK/sock")"

# Both programs must agree on these strings, or a reword in Rust silently stops
# the dev loop reloading.
SUPERVISOR="$ROOT/packages/domicile-launch/src/startup.rs"
expect "the supervisor still ends its up line with its socket" "yes" \
  "$(grep -qF '.chain([format!("{VARIABLE}={}", started.socket.display())])' "$SUPERVISOR" &&
     echo yes || echo no)"
expect "and that variable is still the one the script matches on" "yes" \
  "$(grep -qF 'VARIABLE: &str = "DOMICILE_SOCK"' \
       "$ROOT/packages/domicile-launch/src/control_socket.rs" && echo yes || echo no)"
expect "and it still says when a desktop is up" "yes" \
  "$(grep -qF '"domicile is up.' "$SUPERVISOR" && echo yes || echo no)"

# With no engine passed in, the flake's pinned engine runs.
: >"$WORK/nix.log"
fetched="$(launch "")"
expect "the pinned engine is fetched when none was given" \
  "engine=$WORK/store-engine" \
  "$(printf '%s\n' "$fetched" | sed -n 's/^engine=/engine=/p')"
expect "and it is the flake's own engine that is built" "yes" \
  "$(grep -q '#engine' "$WORK/nix.log" && echo yes || echo no)"

# The turbo build already wrote `shell.js`. Vite's first watch build would
# empty the output directory, and a desktop or reload loop started in that
# window finds no shell (#1936).
expect "the watcher keeps the last build while it rebuilds" "yes" \
  "$(grep -qF 'vite build --watch --no-emptyOutDir' "$SCRIPT_UNDER_TEST" &&
     echo yes || echo no)"

# The refusals, from the real script.
refuse() { "$SCRIPT_UNDER_TEST" "$@" 2>&1 | head -1; }
expect "a shell nobody named is refused with the usage" \
  "usage: dev-shell.sh <shell>   e.g. dev-shell.sh manganese" \
  "$(refuse)"
expect "a shell that does not exist is named in the refusal" \
  "no shell 'nonesuch' — there is no packages/shell-nonesuch." \
  "$(refuse nonesuch)"

# The reload loop, driven without a desktop. `dev-shell-reload.sh` takes the
# binary, module, socket file and both coalescing windows as arguments.
RELOAD="$ROOT/packages/dev-shell/bin/dev-shell-reload.sh"
[ -x "$RELOAD" ] || { echo "no $RELOAD" >&2; exit 1; }

# A `domicile` stub that records its arguments and answers `loaded` or a
# refusal. The real one prints the engine's `why` from `Response::Refused`.
mkdir -p "$WORK/bin"
cat >"$WORK/bin/domicile" <<'STUB'
#!/usr/bin/env bash
echo "$* sock=${DOMICILE_SOCK:-unset}" >>"$DOMICILE_LOG"
read -r answer <"$DOMICILE_ANSWER"
if [ "$answer" = loaded ]; then
  exit 0
else
  echo "domicile: $answer" >&2
  exit 1
fi
STUB
chmod +x "$WORK/bin/domicile"

# The socket path a desktop would print. Nothing binds it: the test checks that
# the loop reads it from the file and passes it as `DOMICILE_SOCK`.
SOCKET=/run/user/1000/domicile-ipc.4242.sock

# Starts a loop over a case's own bundle, socket file and logs. Windows are in
# tenths of a second, the loop's tick.
watching() { # $1 case  $2 settle ticks  $3 burst ticks
  local dir="$WORK/$1"
  mkdir -p "$dir"
  : >"$dir/shell.js"
  : >"$dir/domicile.log"
  echo loaded >"$dir/answer"
  printf '%s\n' "$SOCKET" >"$dir/sock"
  DOMICILE_LOG="$dir/domicile.log" DOMICILE_ANSWER="$dir/answer" \
    "$RELOAD" "$WORK/bin/domicile" "$dir/shell.js" "$dir/sock" "$2" "$3" \
    >"$dir/loop.log" 2>&1 &
  RELOADER=$!
}
built() { touch "$WORK/$1/shell.js"; }
handed_over() { grep -c 'load-shell' "$WORK/$1/domicile.log"; }
stop_watching() { kill "$RELOADER" 2>/dev/null; wait "$RELOADER" 2>/dev/null; }

# Waits poll for the result instead of sleeping a fixed time: the handover
# takes from a third of a second to a second and a half depending on load.
#
# A wait that times out returns quietly, so the expectation after it reports
# the failure once.
waited() { # $1 a shell test, re-run every tick until it holds
  local ticks=0
  until eval "$1"; do
    ticks=$((ticks + 1))
    [ "$ticks" -ge 200 ] && return 1
    sleep 0.1
  done
}
# The loop takes its baseline stamp before printing `reloading`, so builds
# after that line are seen.
now_watching() { # $1 case
  waited "grep -q 'reloading' \"\$WORK/$1/loop.log\""
}

# The loop must not reload the module the desktop started on. That reload
# would also hit the engine while it is still starting and be refused.
watching baseline 2 50
now_watching baseline
# This expectation is an absence, so check the loop started; otherwise it
# passes vacuously.
expect "the loop is watching before it is asked what it did" "yes" \
  "$(grep -q 'reloading' "$WORK/baseline/loop.log" && echo yes || echo no)"
# A fixed wait, since an absence cannot be polled for.
sleep 1
stop_watching
expect "the shell the desktop started on is not handed to it again" "0" \
  "$(handed_over baseline)"

watching rebuilt 2 50
now_watching rebuilt
built rebuilt
waited '[ "$(handed_over rebuilt)" -ge 1 ]'
expect "a rebuilt shell is handed to the desktop at the socket it printed" \
  "load-shell $WORK/rebuilt/shell.js sock=$SOCKET" \
  "$(head -1 "$WORK/rebuilt/domicile.log")"

# A refused shell is the normal case: a syntax error mid-edit. The loop must
# report the engine's message and keep going.
REFUSAL="Unexpected token '}'"
echo "the shell would not load: $REFUSAL" >"$WORK/rebuilt/answer"
built rebuilt
waited 'grep -qF "$REFUSAL" "$WORK/rebuilt/loop.log"'
expect "a refused reload says why, in the engine's own words" "yes" \
  "$(grep -qF "$REFUSAL" "$WORK/rebuilt/loop.log" && echo yes || echo no)"

echo loaded >"$WORK/rebuilt/answer"
built rebuilt
waited '[ "$(handed_over rebuilt)" -ge 3 ]'
stop_watching
expect "and the next build is still handed over" "3" "$(handed_over rebuilt)"

# `vite build --watch` writes the bundle several times per build, and a reload
# of a half-written file shows a broken shell. The loop reloads once writes go
# quiet. The quiet window is longer than the burst's gaps.
watching burst 15 300
now_watching burst
for _ in 1 2 3 4 5 6 7 8 9 10; do
  built burst
  sleep 0.1
done
# Wait for the first reload, then give a fixed window for a second one that
# must not come.
waited '[ "$(handed_over burst)" -ge 1 ]'
sleep 2
stop_watching
expect "a burst of writes is one reload rather than ten" "1" "$(handed_over burst)"

# The burst bound: without it, a bundle that never goes quiet would never be
# handed over.
watching relentless 50 6
now_watching relentless
for _ in $(seq 1 30); do
  built relentless
  sleep 0.05
done
waited '[ "$(handed_over relentless)" -ge 1 ]'
stop_watching
expect "a bundle that never goes quiet is handed over anyway" "yes" \
  "$([ "$(handed_over relentless)" -gt 0 ] && echo yes || echo no)"

# End to end: the launch writes the paths the loop reads, and a mismatch
# reloads nothing silently. This runs the real script with `bunx`, `cargo` and
# `domicile` stubbed.
#
# No fixed waits: the watcher builds once the desktop is up and repeats until a
# build lands, and the desktop stays up until then.
RUN="$(awk '/^WORK="\$\(mktemp -d\)"$/,0' "$SCRIPT_UNDER_TEST")"
[ -n "$RUN" ] || {
  echo "no run in $SCRIPT_UNDER_TEST — its markers moved." >&2
  exit 1
}

FIXTURE="$WORK/join"
mkdir -p "$FIXTURE/bin" "$FIXTURE/checkout/packages/dev-shell/bin" "$FIXTURE/checkout/target/debug" \
         "$FIXTURE/page" "$FIXTURE/shell"
ln -s "$RELOAD" "$FIXTURE/checkout/packages/dev-shell/bin/dev-shell-reload.sh"
: >"$FIXTURE/page/shell.js"

# The watcher builds repeatedly once the desktop is up. The loop's starting
# stamp may absorb the first build.
cat >"$FIXTURE/bin/bunx" <<'STUB'
#!/usr/bin/env bash
while [ ! -e "$FIXTURE/up" ]; do sleep 0.1; done
while true; do
  touch "$FIXTURE/page/shell.js"
  sleep 0.5
done
STUB
cat >"$FIXTURE/bin/cargo" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
# The stub serves both roles: the desktop and the `load-shell` client.
cat >"$FIXTURE/checkout/target/debug/domicile" <<'STUB'
#!/usr/bin/env bash
if [ "${1:-}" = load-shell ]; then
  echo "load-shell $2 sock=${DOMICILE_SOCK:-unset}" >>"$FIXTURE/handed"
  exit 0
fi
echo "domicile is up. shell /desk/shell.js · platform wayland · DOMICILE_SOCK=/run/user/1000/domicile-ipc.4242.sock"
: >"$FIXTURE/up"
waited=0
while [ ! -s "$FIXTURE/handed" ] && [ "$waited" -lt 150 ]; do
  sleep 0.1
  waited=$((waited + 1))
done
STUB
chmod +x "$FIXTURE/bin/bunx" "$FIXTURE/bin/cargo" \
         "$FIXTURE/checkout/target/debug/domicile"

(
  export FIXTURE PATH="$FIXTURE/bin:$PATH"
  ROOT="$FIXTURE/checkout"
  SHELL_NAME=simple
  SHELL_DIR="$FIXTURE/shell"
  PAGE_DIR="$FIXTURE/page"
  # Passed in, so the engine resolution never calls `nix`.
  DOMICILE_ENGINE="$FIXTURE/engine"
  eval "$RUN"
) >"$FIXTURE/run.log" 2>&1

expect "a shell rebuilt while the desktop runs is handed to that desktop" \
  "load-shell $FIXTURE/page/shell.js sock=/run/user/1000/domicile-ipc.4242.sock" \
  "$(head -1 "$FIXTURE/handed" 2>/dev/null)"

# A loop pointed at a missing module would poll forever without saying so.
refuse_reload() { "$RELOAD" "$@" 2>&1 | head -1; }
expect "a reload loop with nothing to watch is refused with the usage" \
  "usage: dev-shell-reload.sh <domicile> <module> <socket-file> [settle] [burst]" \
  "$(refuse_reload)"
expect "a module that is not there is named in the refusal" \
  "no shell module at $WORK/nonesuch.js — nothing would ever be reloaded." \
  "$(refuse_reload "$WORK/bin/domicile" "$WORK/nonesuch.js" "$WORK/sock")"

if [ "$FAILED" -gt 0 ]; then
  echo "$FAILED failed"
  exit 1
fi
echo "all ok"
