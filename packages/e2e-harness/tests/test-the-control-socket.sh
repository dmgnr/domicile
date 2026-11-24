#!/usr/bin/env bash
# Tests that every running desktop answers its own control socket.
#
#   packages/e2e-harness/tests/test-the-control-socket.sh
#
# The unit tests cover the socket's rules. This covers the wiring in the
# binary: a desktop takes its own socket, names it in DOMICILE_SOCK, answers
# from a thread while the supervisor waits on its components, and a second
# `domicile` in the same session starts beside the first with its own socket.
#
# The positive case runs first, as in `test-a-desktop-that-fails-says-why.sh`.
# Otherwise "the command was refused" and "the desktop never came up" look the
# same.
#
# The components are shell scripts. The supervisor does not care what they
# are, and a real engine takes hours to build and needs a display.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
TARGET="${CARGO_TARGET_DIR:-$ROOT/target}"

command -v cargo >/dev/null 2>&1 || { echo "SKIP: no cargo"; exit 77; }

echo "== building domicile =="
( cd "$ROOT" && cargo build -q -p domicile-launch --bin domicile ) || {
  echo "FAIL: domicile would not build"; exit 1; }
DOMICILE="$TARGET/debug/domicile"
[ -x "$DOMICILE" ] || { echo "FAIL: no binary at $DOMICILE"; exit 1; }

WORK="$(mktemp -d)"
DESKTOPS=""
cleanup() {
  for desktop in $DESKTOPS; do
    kill "$desktop" 2>/dev/null
    wait "$desktop" 2>/dev/null
  done
  # The fake components outlive a supervisor killed by a signal, as the real
  # ones do. Each keeps a name the patterns below match across its final
  # `exec` (see `exec -a`).
  #
  # Kill until they are gone, not once. They hold this script's inherited
  # stdout and stderr, so a survivor keeps the caller's pipe open and a CI step
  # never ends. A supervisor still exiting can also replace an engine just
  # killed. After five seconds, report what is left.
  local left=0
  while pgrep -f "$WORK/(engine/chrome|domicile-compositor)" >/dev/null 2>&1; do
    if [ "$left" -ge 50 ]; then
      echo "the fake components would not go, and this run leaves them:" >&2
      pgrep -af "$WORK/(engine/chrome|domicile-compositor)" >&2
      break
    fi
    pkill -f "$WORK/engine/chrome" 2>/dev/null
    pkill -f "$WORK/domicile-compositor" 2>/dev/null
    sleep 0.1
    left=$((left + 1))
  done
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

# One shell module per desktop, so `which-shell` can name the wrong one. The
# files are empty because the fake engine loads nothing.
mkdir -p "$WORK/first" "$WORK/second"
: >"$WORK/first/shell.js"
: >"$WORK/second/shell.js"

# The engine: creates the broker socket it is given, then stays alive.
mkdir -p "$WORK/engine"
cat >"$WORK/engine/chrome" <<'ENGINE'
#!/usr/bin/env bash
for arg in "$@"; do
  case "$arg" in
    --domicile-broker-socket=*) broker="${arg#*=}" ;;
  esac
done
: >"$broker"
# One error, as Chromium formats it, for `domicile logs` to find.
echo "[1:1:1121/000000.000000:ERROR:fake.cc:1] the fake engine started" >&2
# Keep this path on bash for cleanup; a multicall sleep uses its program name.
# Forward cleanup's signal to the child that holds stdout and stderr.
exec -a "$0" bash -c 'sleep 60 & trap "kill $!" TERM; wait'
ENGINE
chmod +x "$WORK/engine/chrome"

# The compositor: publishes the session document, then stays alive. It records
# the DOMICILE_SOCK it was started with: apps it spawns inherit that value, and
# no unit test sees this hand-off.
cat >"$WORK/domicile-compositor" <<'COMPOSITOR'
#!/usr/bin/env bash
while [ $# -gt 0 ]; do
  case "$1" in --session) session="$2"; shift ;; esac
  shift
done
printf '%s' "${DOMICILE_SOCK-}" >"$session.sock-it-was-given"
# One error, as its tracing formats it off the journal, naming a site that
# `domicile export-logs` hides.
echo "2026-11-21T00:00:00.000000Z ERROR domicile_compositor::fake: opened https://private.example/inbox"
: >"$session"
# Keeps its name across the exec, as the engine does; see `cleanup`.
exec -a "$0" bash -c 'sleep 60 & trap "kill $!" TERM; wait'
COMPOSITOR
chmod +x "$WORK/domicile-compositor"

mkdir -p "$WORK/runtime"
# `headless` because there is no display and `platform` does not guess. Both
# desktops share one XDG_RUNTIME_DIR: a session may hold several desktops.
run_domicile() {
  env OZONE=headless \
      XDG_RUNTIME_DIR="$WORK/runtime" \
      DOMICILE_ENGINE="$WORK/engine" \
      DOMICILE_COMPOSITOR="$WORK/domicile-compositor" \
      "$DOMICILE" "$@"
}

# Sends one command to the desktop at $1, as a terminal inside that desktop
# would.
ask_desktop() {
  env DOMICILE_SOCK="$1" "$DOMICILE" which-shell 2>&1
}

FAILED=0

# Starts a desktop on $2, logging to $1, and waits until it is up. Sets UP_SOCK
# to the socket it reported and UP_PID to its process.
start_desktop() {
  local log="$1" shell="$2" waited=0
  run_domicile "$shell" >"$log" 2>&1 &
  DESKTOPS="$DESKTOPS $!"
  while ! grep -q "domicile is up" "$log" 2>/dev/null; do
    if [ "$waited" -ge 100 ]; then
      echo "FAIL: the desktop on $shell never came up, so nothing below would"
      echo "      mean anything. What it said:"
      sed 's/^/    /' "$log"
      exit 1
    fi
    sleep 0.1
    waited=$((waited + 1))
  done
  UP_SOCK="$(sed -n 's/^domicile is up..*DOMICILE_SOCK=//p' "$log")"
  if [ -z "$UP_SOCK" ]; then
    echo "FAIL: the desktop on $shell came up without saying where it answers."
    echo "      A socket nothing names is a socket nothing can reach:"
    sed 's/^/    /' "$log"
    exit 1
  fi
  # Taken from the socket name, not `$!`: `$!` may be the background
  # subshell. The socket name and run directory use the supervisor's pid.
  UP_PID="${UP_SOCK##*domicile-ipc.}"
  UP_PID="${UP_PID%.sock}"
  DESKTOPS="$DESKTOPS $UP_PID"
}

# ---- a desktop that is up, and is asked -----------------------------------

echo "== a desktop comes up and takes a control socket of its own =="
start_desktop "$WORK/first.log" "$WORK/first/shell.js"
FIRST_SOCK="$UP_SOCK"
FIRST_PID="$UP_PID"
echo "PASS: it is answering at $FIRST_SOCK"

echo "== which-shell names the module the desktop is running =="
SAID="$(ask_desktop "$FIRST_SOCK")"
if [ "$SAID" = "$WORK/first/shell.js" ]; then
  echo "PASS: $SAID"
else
  echo "FAIL: which-shell said '$SAID', and the desktop is running"
  echo "      $WORK/first/shell.js"
  FAILED=1
fi

echo "== the compositor is started with the socket to hand on to its apps =="
# Apps spawned by the shell inherit this. Without it, `domicile which-shell`
# in the desktop's own terminal finds nothing.
GIVEN="$(cat "$WORK/runtime/domicile-$FIRST_PID/session.json.sock-it-was-given" 2>/dev/null)"
if [ "$GIVEN" = "$FIRST_SOCK" ]; then
  echo "PASS: the compositor was handed $GIVEN"
else
  echo "FAIL: the compositor was handed '$GIVEN', and the desktop answers at"
  echo "      $FIRST_SOCK"
  FAILED=1
fi

echo "== domicile logs prints what the parts said off the journal =="
# The desktop's stderr is a file, not the journal, so it kept the lines.
LOGS="$(env DOMICILE_SOCK="$FIRST_SOCK" "$DOMICILE" logs 2>&1)"
if printf '%s' "$LOGS" | grep -q "domicile-engine err: the fake engine started" &&
   printf '%s' "$LOGS" | grep -q "domicile-compositor err: domicile_compositor::fake: opened"; then
  echo "PASS: the engine's and the compositor's errors are there"
else
  echo "FAIL: domicile logs missed the engine's or the compositor's error:"
  printf '%s\n' "$LOGS" | sed 's/^/    /'
  FAILED=1
fi
# The compositor's tracing still reaches the desktop's own stdout.
if grep -q "domicile_compositor::fake: opened" "$WORK/first.log"; then
  echo "PASS: the compositor's line still reached the desktop's output"
else
  echo "FAIL: the compositor's line was kept but not passed on:"
  sed 's/^/    /' "$WORK/first.log"
  FAILED=1
fi

echo "== domicile export-logs writes them with web addresses hidden =="
( cd "$WORK" && env DOMICILE_SOCK="$FIRST_SOCK" "$DOMICILE" export-logs bug.txt \
    >"$WORK/export.log" 2>&1 )
if grep -q "domicile_compositor::fake: opened <url>" "$WORK/bug.txt" 2>/dev/null &&
   ! grep -q "private.example" "$WORK/bug.txt" &&
   grep -q "domicile is up." "$WORK/bug.txt"; then
  echo "PASS: $(head -1 "$WORK/export.log")"
else
  echo "FAIL: the export is missing, says the site, or lacks the up line:"
  sed 's/^/    /' "$WORK/export.log" "$WORK/bug.txt" 2>&1
  FAILED=1
fi

# ---- the second desktop ---------------------------------------------------

echo "== a second desktop on the same session comes up beside the first =="
start_desktop "$WORK/second.log" "$WORK/second/shell.js"
SECOND_SOCK="$UP_SOCK"
SECOND_PID="$UP_PID"
if [ "$SECOND_SOCK" = "$FIRST_SOCK" ]; then
  echo "FAIL: both desktops took the same socket ($SECOND_SOCK), so one of"
  echo "      them is answering for the other."
  FAILED=1
else
  echo "PASS: it is answering at $SECOND_SOCK, and the first one still has"
  echo "      $FIRST_SOCK"
fi

echo "== each desktop answers for itself =="
MINE="$(ask_desktop "$SECOND_SOCK")"
THEIRS="$(ask_desktop "$FIRST_SOCK")"
if [ "$MINE" = "$WORK/second/shell.js" ] && [ "$THEIRS" = "$WORK/first/shell.js" ]; then
  echo "PASS: the second says $MINE and the first still says $THEIRS"
else
  echo "FAIL: the second desktop said '$MINE' (running $WORK/second/shell.js)"
  echo "      and the first said '$THEIRS' (running $WORK/first/shell.js)"
  FAILED=1
fi

# ---- nowhere to ask -------------------------------------------------------

echo "== asking from outside every desktop says so rather than guessing =="
OUTSIDE="$WORK/outside.log"
# Two desktops are running, so there are sockets that would answer. Picking
# one would guess for the user.
if env -u DOMICILE_SOCK XDG_RUNTIME_DIR="$WORK/runtime" "$DOMICILE" which-shell \
     >"$OUTSIDE" 2>&1; then
  echo "FAIL: a command answered from outside every desktop:"
  sed 's/^/    /' "$OUTSIDE"
  FAILED=1
elif grep -q "DOMICILE_SOCK is not set" "$OUTSIDE"; then
  echo "PASS: $(grep -m1 'DOMICILE_SOCK is not set' "$OUTSIDE")"
else
  echo "FAIL: it failed for some other reason:"
  sed 's/^/    /' "$OUTSIDE"
  FAILED=1
fi

# ---- the desktop that is gone ---------------------------------------------

echo "== the socket a killed desktop left behind fails rather than hangs =="
# SIGKILL, so nothing unlinks the socket. Terminals still open in that desktop
# keep this path in their environment.
kill -9 "$SECOND_PID" 2>/dev/null
# `kill` only sends the signal, and `wait` cannot help: the supervisor is a
# grandchild of this shell. Asking a still-running desktop gives a different
# error, so poll until the process is gone. On a loaded machine that takes a
# while.
#
# Poll the process, not the socket: a socket that still answers after its
# desktop is gone is what this case checks for.
KILLED=0
while kill -0 "$SECOND_PID" 2>/dev/null; do
  if [ "$KILLED" -ge 100 ]; then
    echo "FAIL: the second desktop ($SECOND_PID) took SIGKILL ten seconds ago"
    echo "      and is still in the process table, so nothing below would be"
    echo "      about a desktop that is gone."
    exit 1
  fi
  sleep 0.1
  KILLED=$((KILLED + 1))
done
GONE="$WORK/gone.log"
if [ ! -S "$SECOND_SOCK" ]; then
  echo "FAIL: the killed desktop's socket is gone, so this proves nothing"
  echo "      about the case it exists for."
  FAILED=1
elif ask_desktop "$SECOND_SOCK" >"$GONE" 2>&1; then
  echo "FAIL: a desktop that is not running answered:"
  sed 's/^/    /' "$GONE"
  FAILED=1
elif grep -q "no desktop is running here" "$GONE"; then
  echo "PASS: $(grep -m1 'no desktop is running here' "$GONE")"
else
  echo "FAIL: it failed for some other reason:"
  sed 's/^/    /' "$GONE"
  FAILED=1
fi

exit "$FAILED"
