#!/usr/bin/env bash
# Checks a desktop whose shell is slow to build starts on the splash and loads
# the shell once it is built, and that a failed build stays on the splash and
# says why.
#
#   packages/e2e-harness/tests/test-a-slow-first-build-starts-on-the-splash.sh
#
# `domicile_launch::splash` covers the progress file and the retry. This
# covers the supervisor around them: the engine starts on the splash, each
# builder step reaches `progress.json`, and the built shell is loaded once the
# splash writes `ended`. A fast build never shows the splash;
# `test-a-config-module-reloads.sh` runs one.
#
# The builder, engine and compositor are stubs; `packages/shell-splash` has
# its own tests.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
TARGET="${CARGO_TARGET_DIR:-$ROOT/target}"

command -v cargo >/dev/null 2>&1 || { echo "SKIP: no cargo"; exit 77; }
command -v python3 >/dev/null 2>&1 || {
  echo "SKIP: no python3, which is what binds the engine's command socket here"
  exit 77
}

echo "== building domicile =="
( cd "$ROOT" && cargo build -q -p domicile-launch --bins ) || {
  echo "FAIL: domicile would not build"; exit 1; }
DOMICILE="$TARGET/debug/domicile"

WORK="$(mktemp -d)"
DESKTOP=""
cleanup() {
  [ -n "$DESKTOP" ] && { kill "$DESKTOP" 2>/dev/null; wait "$DESKTOP" 2>/dev/null; }
  pkill -f "$WORK/engine/chrome" 2>/dev/null
  pkill -f "$WORK/domicile-compositor" 2>/dev/null
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

# The prebuilt splash, as the install has it.
mkdir -p "$WORK/shells/splash"
echo "export const Shell = () => {};" >"$WORK/shells/splash/shell.js"

# Stub builder: each step a second apart, then built, or failed when the
# entry says `broken`.
cat >"$WORK/builder" <<'BUILDER'
#!/usr/bin/env bash
entry="$2" cache=""
while [ $# -gt 0 ]; do [ "$1" = --cache ] && cache="$2"; shift; done
echo '{"step":"resolving"}'
sleep 1
echo '{"step":"installing","packages":["left-pad"]}'
sleep 1
if grep -q broken "$entry"; then
  echo '{"step":"failed","why":"entry.ts: no Shell export"}'
  exit 1
fi
mkdir -p "$cache/built"
: >"$cache/built/shell.js"
printf '{"step":"built","root":"%s","module":"shell.js","cached":false}\n' "$cache/built"
BUILDER
chmod +x "$WORK/builder"

mkdir -p "$WORK/engine"
cat >"$WORK/engine/chrome" <<ENGINE
#!/usr/bin/env python3
import socket, sys

broker = command = None
for arg in sys.argv[1:]:
    if arg.startswith("--domicile-broker-socket="):
        broker = arg.split("=", 1)[1]
    elif arg.startswith("--domicile-command-socket="):
        command = arg.split("=", 1)[1]
with open("$WORK/engine-argv", "w") as saying:
    saying.write("\n".join(sys.argv[1:]))
listening = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
listening.bind(command)
listening.listen(4)
open(broker, "w").close()
while True:
    connection, _ = listening.accept()
    line = b""
    while not line.endswith(b"\n"):
        got = connection.recv(4096)
        if not got:
            break
        line += got
    with open("$WORK/engine-heard", "a") as heard:
        heard.write(line.decode())
    connection.sendall(b'{"type":"loaded"}\n')
    connection.close()
ENGINE
chmod +x "$WORK/engine/chrome"

cat >"$WORK/domicile-compositor" <<COMPOSITOR
#!/bin/sh
while [ \$# -gt 0 ]; do
  case "\$1" in --session) session="\$2"; shift ;; esac
  shift
done
: >"\$session"
exec sleep 60
COMPOSITOR
chmod +x "$WORK/domicile-compositor"

FAILED=0

# Starts a desktop on `$WORK/entry.ts` and waits for it to come up.
start() {
  rm -rf "$WORK/runtime" "$WORK/engine-argv" "$WORK/engine-heard"
  mkdir -p "$WORK/runtime"
  LOG="$WORK/desktop.log"
  env OZONE=headless \
      XDG_RUNTIME_DIR="$WORK/runtime" \
      XDG_CONFIG_HOME="$WORK/config" \
      XDG_CACHE_HOME="$WORK/cache" \
      XDG_STATE_HOME="$WORK/state" \
      DOMICILE_ENGINE="$WORK/engine" \
      DOMICILE_COMPOSITOR="$WORK/domicile-compositor" \
      DOMICILE_BUILDER="$WORK/builder" \
      DOMICILE_SHELLS="$WORK/shells" \
      "$DOMICILE" "$WORK/entry.ts" >"$LOG" 2>&1 &
  DESKTOP=$!
  wait_for "domicile is up" || {
    echo "FAIL: the desktop never came up. What it said:"
    sed 's/^/    /' "$LOG"
    exit 1
  }
  SPLASH="$WORK/runtime/domicile-$DESKTOP/splash"
}

# Waits up to ten seconds for the desktop to say `$1`.
wait_for() { # text [file]
  local waited=0
  while ! grep -q "$1" "${2:-$LOG}" 2>/dev/null; do
    [ "$waited" -ge 100 ] && return 1
    sleep 0.1
    waited=$((waited + 1))
  done
}

stop() {
  kill "$DESKTOP" 2>/dev/null
  wait "$DESKTOP" 2>/dev/null
  DESKTOP=""
}

echo "== a slow build starts the engine on the splash =="
echo "export const Shell = () => {};" >"$WORK/entry.ts"
start
SERVED="$(sed -n 's/^--domicile-shell-root=//p' "$WORK/engine-argv")"
if [ "$SERVED" = "$SPLASH" ] && [ -f "$SPLASH/shell.js" ]; then
  echo "PASS: $SERVED"
else
  echo "FAIL: the engine serves '$SERVED', not the splash at $SPLASH"
  FAILED=1
fi

echo "== the splash hears each step =="
WAITED=0
until grep -q installing "$SPLASH/progress.json" 2>/dev/null || [ "$WAITED" -ge 50 ]; do
  sleep 0.1
  WAITED=$((WAITED + 1))
done
if grep -qF '{"state":"installing","packages":["left-pad"]}' "$SPLASH/progress.json" 2>/dev/null; then
  echo "PASS: $(cat "$SPLASH/progress.json")"
else
  echo "FAIL: the splash was told $(cat "$SPLASH/progress.json" 2>/dev/null)"
  FAILED=1
fi

echo "== the built shell waits for the splash to end =="
WAITED=0
until grep -q '"built"' "$SPLASH/progress.json" 2>/dev/null || [ "$WAITED" -ge 100 ]; do
  sleep 0.1
  WAITED=$((WAITED + 1))
done
ENDED="$(sed -n 's/.*"ended":"\([^"]*\)".*/\1/p' "$SPLASH/progress.json" 2>/dev/null)"
# Long enough for a supervisor that does not wait to have loaded the shell.
sleep 1
if [ "$ENDED" = "$SPLASH/ended" ] && ! grep -q load_shell "$WORK/engine-heard" 2>/dev/null; then
  echo "PASS: the splash was told to end in $ENDED, and the engine heard nothing"
else
  echo "FAIL: the splash was told $(cat "$SPLASH/progress.json" 2>/dev/null), and the engine heard:"
  sed 's/^/    /' "$WORK/engine-heard" 2>/dev/null
  FAILED=1
fi
# What the page writes once it has shown "Ready".
: >"$SPLASH/ended"

echo "== the built shell replaces the splash =="
WANT="{\"type\":\"load_shell\",\"version\":1,\"root\":\"$WORK/cache/domicile/shells/built\",\"module\":\"shell.js\"}"
if wait_for "\"load_shell\"" "$WORK/engine-heard" && grep -qxF "$WANT" "$WORK/engine-heard" 2>/dev/null; then
  echo "PASS: the engine was told $WANT"
else
  echo "FAIL: the engine heard:"
  sed 's/^/    /' "$WORK/engine-heard" 2>/dev/null
  echo "    and the desktop said:"
  sed 's/^/    /' "$LOG"
  FAILED=1
fi
stop

echo "== a failed build stays on the splash and says why =="
echo "broken" >"$WORK/entry.ts"
start
WANT="{\"state\":\"failed\",\"supervisor\":$DESKTOP,\"why\":\"the shell did not build: entry.ts: no Shell export\"}"
if wait_for "stays on the splash" && grep -qxF "$WANT" "$SPLASH/progress.json" \
  && kill -0 "$DESKTOP" 2>/dev/null; then
  echo "PASS: the splash was told $WANT"
else
  echo "FAIL: the splash was told $(cat "$SPLASH/progress.json" 2>/dev/null). The desktop said:"
  sed 's/^/    /' "$LOG"
  FAILED=1
fi
stop

exit "$FAILED"
