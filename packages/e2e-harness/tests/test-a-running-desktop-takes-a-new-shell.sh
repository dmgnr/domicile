#!/usr/bin/env bash
# Checks a running desktop loads a new shell, opens URLs and apps, takes
# screenshots and sends the shell commands on command, via `domicile
# load-shell`, `BROWSER`, `domicile open --app`, `domicile-settings`,
# `domicile-history`, the `xdg-open` shim on its apps' PATH, `domicile
# screenshot` with and without a file, and `domicile send-shell`.
#
#   packages/e2e-harness/tests/test-a-running-desktop-takes-a-new-shell.sh
#
# Unit tests cover the parts: `tests/cli.rs` the arguments, `tests/command.rs`
# the line sent, `tests/command_socket.rs` and `tests/compositor_socket.rs` the
# reply. This covers the wiring: the supervisor gives the engine a command
# socket, a command from another terminal reaches it, or the compositor's chrome
# socket for a screenshot or a shell command, over DOMICILE_SOCK, and a refusal
# is printed in that terminal.
#
# The engine and the compositor are small Python stubs of their sockets. The
# real sides, `components/domicile/browser/command_protocol.cc` and the
# compositor's `screenshot` and `send_shell` system calls, have their own unit
# tests.
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
[ -x "$DOMICILE" ] || { echo "FAIL: no binary at $DOMICILE"; exit 1; }

WORK="$(mktemp -d)"
DESKTOP=""
cleanup() {
  [ -n "$DESKTOP" ] && { kill "$DESKTOP" 2>/dev/null; wait "$DESKTOP" 2>/dev/null; }
  pkill -f "$WORK/engine/chrome" 2>/dev/null
  pkill -f "$WORK/domicile-compositor" 2>/dev/null
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

# The starting shell and the one to load. Never run, but must exist for the
# paths to resolve.
mkdir -p "$WORK/first" "$WORK/second"
: >"$WORK/first/shell.js"
: >"$WORK/second/shell.js"
# The app modules `domicile-settings` and `domicile-history` run.
for app in settings history; do
  mkdir -p "$WORK/app-modules/$app"
  : >"$WORK/app-modules/$app/$app.js"
done

# The stub engine's next answer, read per connection, so one desktop can test
# both success and refusal.
echo loaded >"$WORK/answer"

# Stub engine: creates the broker socket, binds the command socket, and
# answers one line per connection, as the real engine does.
mkdir -p "$WORK/engine"
cat >"$WORK/engine/chrome" <<ENGINE
#!/usr/bin/env python3
import json, os, socket, sys

broker = command = None
for arg in sys.argv[1:]:
    if arg.startswith("--domicile-broker-socket="):
        broker = arg.split("=", 1)[1]
    elif arg.startswith("--domicile-command-socket="):
        command = arg.split("=", 1)[1]

# Record the arguments for the test to check.
with open("$WORK/engine-argv", "w") as saying:
    saying.write("\n".join(sys.argv[1:]))

if command is None:
    # Fail fast so the desktop does not come up without a command socket.
    sys.exit("no --domicile-command-socket")

listening = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
listening.bind(command)
listening.listen(4)
# After the bind, so the command socket is ready once the broker appears.
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
    answer = open("$WORK/answer").read().strip()
    done = ({"type": "opened"}
            if b'"type":"open_url"' in line or b'"type":"run_app"' in line
            else {"type": "loaded"})
    reply = (done if answer == "loaded"
             else {"type": "refused", "why": answer})
    connection.sendall((json.dumps(reply) + "\n").encode())
    connection.close()
ENGINE
chmod +x "$WORK/engine/chrome"

# Stub compositor: binds the chrome socket, publishes the session, records every
# program it is told to start, sends every shell command, and saves every
# screenshot it is asked for. With no file, it is
# the user picking: it waits for \$WORK/picked, which names the file saved or
# says "cancel".
cat >"$WORK/domicile-compositor" <<COMPOSITOR
#!/usr/bin/env python3
import json, os, socket, sys, time

arguments = dict(zip(sys.argv[1::2], sys.argv[2::2]))
session = arguments["--session"]
# Record the environment apps inherit, for the test to check.
for name in ("BROWSER", "PATH"):
    with open(os.path.join(os.path.dirname(session), name.lower()), "w") as saying:
        saying.write(os.environ[name])

listening = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
listening.bind(arguments["--chrome-socket"])
listening.listen(4)
open(session, "w").close()

def first_question(connection):
    """The first line that asks something."""
    for line in connection.makefile("rb"):
        with open("$WORK/compositor-heard", "a") as heard:
            heard.write(line.decode())
        return json.loads(line)

while True:
    connection, _ = listening.accept()
    asked = first_question(connection)
    if asked["type"] == "exec":
        with open("$WORK/compositor-spawned", "a") as spawned:
            spawned.write(json.dumps(asked["command"]) + "\n")
        connection.sendall((json.dumps({"type": "executed"}) + "\n").encode())
        connection.close()
        continue
    if asked["type"] == "which_status":
        connection.sendall((json.dumps(
            {"type": "status", "theme": "dark", "locked": False, "keymap": None,
             "screens_off": False, "held_awake_by": [], "capturing": []}) + "\n").encode())
        connection.close()
        continue
    if asked["request"]["call"] == "send_shell":
        connection.sendall((json.dumps(
            {"type": "system_reply", "id": asked["id"], "reply": {"kind": "sent"}}) + "\n").encode())
        connection.close()
        continue
    file = asked["request"]["file"]
    if file is None:
        while not os.path.exists("$WORK/picked"):
            time.sleep(0.05)
        file = open("$WORK/picked").read().strip()
        os.remove("$WORK/picked")
    reply = ({"kind": "failed",
              "error": {"kind": "canceled", "message": "the screenshot dialog was dismissed"}}
             if file == "cancel" else {"kind": "saved", "path": file})
    connection.sendall((json.dumps(
        {"type": "system_reply", "id": asked["id"], "reply": reply}) + "\n").encode())
    connection.close()
COMPOSITOR
chmod +x "$WORK/domicile-compositor"

mkdir -p "$WORK/runtime"
LOG="$WORK/desktop.log"
env OZONE=headless \
    XDG_RUNTIME_DIR="$WORK/runtime" \
    DOMICILE_ENGINE="$WORK/engine" \
    DOMICILE_COMPOSITOR="$WORK/domicile-compositor" \
    "$DOMICILE" "$WORK/first/shell.js" >"$LOG" 2>&1 &
DESKTOP=$!

WAITED=0
while ! grep -q "domicile is up" "$LOG" 2>/dev/null; do
  if [ "$WAITED" -ge 100 ]; then
    echo "FAIL: the desktop never came up, so nothing below would mean"
    echo "      anything. What it said:"
    sed 's/^/    /' "$LOG"
    exit 1
  fi
  sleep 0.1
  WAITED=$((WAITED + 1))
done
SOCK="$(sed -n 's/^domicile is up..*DOMICILE_SOCK=//p' "$LOG")"

FAILED=0

# Runs a `domicile` command as a terminal inside the desktop would.
ask_desktop() {
  env DOMICILE_SOCK="$SOCK" "$DOMICILE" "$@" 2>&1
}

echo "== the engine was started with a command socket of this run's own =="
GIVEN="$(sed -n 's/^--domicile-command-socket=//p' "$WORK/engine-argv")"
case "$GIVEN" in
  "$WORK/runtime/domicile-"*/command.sock)
    echo "PASS: $GIVEN" ;;
  *)
    echo "FAIL: the engine was given '$GIVEN', and this run's own directory is"
    echo "      $WORK/runtime/domicile-<pid>"
    FAILED=1 ;;
esac

echo "== load-shell reaches the engine as the line the protocol says it is =="
SAID="$(ask_desktop load-shell "$WORK/second/shell.js")"
HEARD="$(tail -n 1 "$WORK/engine-heard" 2>/dev/null)"
WANT="{\"type\":\"load_shell\",\"version\":1,\"root\":\"$WORK/second\",\"module\":\"shell.js\"}"
if [ "$HEARD" = "$WANT" ]; then
  echo "PASS: $HEARD"
else
  echo "FAIL: the engine heard '$HEARD'"
  echo "      and the protocol says  $WANT"
  FAILED=1
fi

echo "== and the terminal is told which shell the desktop is on now =="
if [ "$SAID" = "$WORK/second/shell.js" ]; then
  echo "PASS: $SAID"
else
  echo "FAIL: load-shell said '$SAID', and it loaded $WORK/second/shell.js"
  FAILED=1
fi

echo "== which-shell answers with the shell that was loaded, not the one it started on =="
# The supervisor must update the served shell after a load.
NOW="$(ask_desktop which-shell)"
if [ "$NOW" = "$WORK/second/shell.js" ]; then
  echo "PASS: $NOW"
else
  echo "FAIL: which-shell said '$NOW', and the desktop is serving"
  echo "      $WORK/second/shell.js"
  FAILED=1
fi

echo "== an engine that refuses is quoted to whoever typed the command =="
echo "this engine has no shell window to load a shell into" >"$WORK/answer"
REFUSED="$WORK/refused.log"
if ask_desktop load-shell "$WORK/first/shell.js" >"$REFUSED" 2>&1; then
  echo "FAIL: a shell the engine refused was reported loaded:"
  sed 's/^/    /' "$REFUSED"
  FAILED=1
elif grep -q "no shell window" "$REFUSED"; then
  echo "PASS: $(grep -m1 'no shell window' "$REFUSED")"
else
  echo "FAIL: it failed without the engine's own reason in it:"
  sed 's/^/    /' "$REFUSED"
  FAILED=1
fi

echo "== a path that names no shell is refused before any engine hears it =="
# `load-shell` resolves the path in the client, so the error is local and the
# engine never sees it.
BEFORE="$(wc -l <"$WORK/engine-heard")"
MISSING="$WORK/missing.log"
if ask_desktop load-shell "$WORK/nothing-here.js" >"$MISSING" 2>&1; then
  echo "FAIL: a shell that is not there was reported loaded:"
  sed 's/^/    /' "$MISSING"
  FAILED=1
elif grep -q "no shell at" "$MISSING" &&
     [ "$(wc -l <"$WORK/engine-heard")" = "$BEFORE" ]; then
  echo "PASS: $(grep -m1 'no shell at' "$MISSING")"
else
  echo "FAIL: it failed for some other reason, or it reached the engine:"
  sed 's/^/    /' "$MISSING"
  FAILED=1
fi

echo "== screenshot reaches the compositor with the file made absolute =="
# The compositor does not share the terminal's working directory.
SAID="$(cd "$WORK" && ask_desktop screenshot shot.png)"
HEARD="$(tail -n 1 "$WORK/compositor-heard" 2>/dev/null)"
WANT="{\"type\":\"system_request\",\"id\":1,\"request\":{\"call\":\"screenshot\",\"file\":\"$WORK/shot.png\"}}"
if [ "$HEARD" = "$WANT" ]; then
  echo "PASS: $HEARD"
else
  echo "FAIL: the compositor heard '$HEARD'"
  echo "      and the protocol says  $WANT"
  FAILED=1
fi

echo "== and the terminal is told where the screenshot is =="
if [ "$SAID" = "$WORK/shot.png" ]; then
  echo "PASS: $SAID"
else
  echo "FAIL: screenshot said '$SAID', and it wrote $WORK/shot.png"
  FAILED=1
fi

echo "== a bare screenshot is the shell's, and other commands answer while the user picks =="
PICKED="$WORK/Pictures/Screenshots/picked.png"
ask_desktop screenshot >"$WORK/picking.log" &
PICKING=$!
WAITED=0
until tail -n 1 "$WORK/compositor-heard" 2>/dev/null | grep -q '"file": *null' ||
      [ "$WAITED" -ge 100 ]; do
  sleep 0.1
  WAITED=$((WAITED + 1))
done
HEARD="$(tail -n 1 "$WORK/compositor-heard" 2>/dev/null)"
WANT='{"type":"system_request","id":1,"request":{"call":"screenshot","file":null}}'
if [ "$HEARD" = "$WANT" ]; then
  echo "PASS: $HEARD"
else
  echo "FAIL: the compositor heard '$HEARD'"
  echo "      and the protocol says  $WANT"
  FAILED=1
fi
if NOW="$(ask_desktop which-shell)"; then
  echo "PASS: which-shell answered $NOW while the user was picking"
else
  echo "FAIL: which-shell did not answer while the user was picking: $NOW"
  FAILED=1
fi
echo "$PICKED" >"$WORK/picked"
if wait "$PICKING" && [ "$(cat "$WORK/picking.log")" = "$PICKED" ]; then
  echo "PASS: $PICKED"
else
  echo "FAIL: screenshot said '$(cat "$WORK/picking.log")', and the shell saved $PICKED"
  FAILED=1
fi

echo "== a screenshot the user dismissed fails and says so =="
echo cancel >"$WORK/picked"
if CANCELED="$(ask_desktop screenshot)"; then
  echo "FAIL: a dismissed screenshot exited 0: $CANCELED"
  FAILED=1
elif [ "$CANCELED" = "error: the screenshot was canceled" ]; then
  echo "PASS: $CANCELED"
else
  echo "FAIL: it failed for some other reason: $CANCELED"
  FAILED=1
fi

echo "== send-shell reaches the compositor as the line the protocol says it is =="
if SAID="$(ask_desktop send-shell focus right)"; then
  echo "PASS: send-shell exited 0"
else
  echo "FAIL: send-shell failed: $SAID"
  FAILED=1
fi
HEARD="$(tail -n 1 "$WORK/compositor-heard" 2>/dev/null)"
WANT='{"type":"system_request","id":1,"request":{"call":"send_shell","command":["focus","right"]}}'
if [ "$HEARD" = "$WANT" ]; then
  echo "PASS: $HEARD"
else
  echo "FAIL: the compositor heard '$HEARD'"
  echo "      and the protocol says  $WANT"
  FAILED=1
fi

echo "== the apps a desktop starts are handed domicile-open-url as BROWSER =="
BROWSER_WAS="$(cat "$(dirname "$GIVEN")/browser" 2>/dev/null)"
if [ "$BROWSER_WAS" = "$TARGET/debug/domicile-open-url" ]; then
  echo "PASS: $BROWSER_WAS"
else
  echo "FAIL: the compositor was given BROWSER='$BROWSER_WAS', and the program"
  echo "      beside domicile is $TARGET/debug/domicile-open-url"
  FAILED=1
fi

echo "== BROWSER reaches the engine as the line the protocol says it is =="
# Run BROWSER as an app would, with one argument. A relative path becomes a
# file URL against the working directory.
echo loaded >"$WORK/answer"
if ! ( cd "$WORK" && env DOMICILE_SOCK="$SOCK" "$TARGET/debug/domicile-open-url" \
         "first/a page.html" ) >"$WORK/opened.log" 2>&1; then
  echo "FAIL: domicile-open-url failed:"
  sed 's/^/    /' "$WORK/opened.log"
  FAILED=1
fi
HEARD="$(tail -n 1 "$WORK/engine-heard" 2>/dev/null)"
WANT="{\"type\":\"open_url\",\"version\":1,\"url\":\"file://$WORK/first/a%20page.html\"}"
if [ "$HEARD" = "$WANT" ]; then
  echo "PASS: $HEARD"
else
  echo "FAIL: the engine heard '$HEARD'"
  echo "      and the protocol says  $WANT"
  FAILED=1
fi

echo "== open --app, Settings and History reach the engine as app windows =="
for opener in "domicile open --app https://example.com/" domicile-settings domicile-history; do
  WANT_URL="https://example.com/"
  # shellcheck disable=SC2086 # `opener` is a program and its arguments.
  if ! env DOMICILE_SOCK="$SOCK" DOMICILE_APP_MODULES="$WORK/app-modules" \
         "$TARGET/debug/"$opener >"$WORK/app.log" 2>&1; then
    echo "FAIL: $opener failed:"
    sed 's/^/    /' "$WORK/app.log"
    FAILED=1
  fi
  HEARD="$(tail -n 1 "$WORK/engine-heard" 2>/dev/null)"
  WANT="{\"type\":\"open_url\",\"version\":1,\"url\":\"$WANT_URL\",\"app\":true}"
  case "$opener" in
    domicile-settings | domicile-history)
      APP="${opener#domicile-}"
      ROOT_DIR="$(realpath "$WORK/app-modules/$APP")"
      WANT="{\"type\":\"run_app\",\"version\":1,\"root\":\"$ROOT_DIR\",\"module\":\"$APP.js\"}"
      ;;
  esac
  if [ "$HEARD" = "$WANT" ]; then
    echo "PASS: $opener: $HEARD"
  else
    echo "FAIL: for $opener the engine heard '$HEARD'"
    echo "      and the protocol says  $WANT"
    FAILED=1
  fi
done

echo "== xdg-open, for the apps a desktop starts, is the desktop's =="
APP_PATH="$(cat "$(dirname "$GIVEN")/path" 2>/dev/null)"
SHIMS="${APP_PATH%%:*}"
if [ "$(readlink "$SHIMS/xdg-open")" = "$TARGET/debug/domicile-xdg-open" ]; then
  echo "PASS: $SHIMS/xdg-open"
else
  echo "FAIL: the first directory on the apps' PATH is '$SHIMS', and its xdg-open"
  echo "      is not $TARGET/debug/domicile-xdg-open"
  FAILED=1
fi
# Chromium runs `xdg-email` for a page's `mailto:` link.
if [ "$(readlink "$SHIMS/xdg-email")" = "$TARGET/debug/domicile-xdg-email" ]; then
  echo "PASS: $SHIMS/xdg-email"
else
  echo "FAIL: the first directory on the apps' PATH is '$SHIMS', and its xdg-email"
  echo "      is not $TARGET/debug/domicile-xdg-email"
  FAILED=1
fi
if [ "$(readlink "$SHIMS/domicile-app-host")" = "$TARGET/debug/domicile-app-host" ]; then
  echo "PASS: $SHIMS/domicile-app-host, which Domicile's apps spawn"
else
  echo "FAIL: the first directory on the apps' PATH, '$SHIMS', has no"
  echo "      domicile-app-host for Domicile's apps to spawn"
  FAILED=1
fi

if [ "$(readlink "$SHIMS/domicile")" = "$TARGET/debug/domicile" ]; then
  echo "PASS: $SHIMS/domicile, which the launcher asks what opens a file"
else
  echo "FAIL: the first directory on the apps' PATH, '$SHIMS', has no"
  echo "      domicile of this desktop's own"
  FAILED=1
fi

echo "== a link handed to that xdg-open reaches the engine =="
if ! env DOMICILE_SOCK="$SOCK" PATH="$APP_PATH" xdg-open "https://example.com/" \
       >"$WORK/xdg-opened.log" 2>&1; then
  echo "FAIL: xdg-open failed:"
  sed 's/^/    /' "$WORK/xdg-opened.log"
  FAILED=1
fi
HEARD="$(tail -n 1 "$WORK/engine-heard" 2>/dev/null)"
WANT='{"type":"open_url","version":1,"url":"https://example.com/"}'
if [ "$HEARD" = "$WANT" ]; then
  echo "PASS: $HEARD"
else
  echo "FAIL: the engine heard '$HEARD'"
  echo "      and the protocol says  $WANT"
  FAILED=1
fi

echo "== and a file opens with its type's default application =="
# A desk of its own: one type, one application.
mkdir -p "$WORK/desk/mime" "$WORK/desk/applications" "$WORK/desk-config"
printf '50:application/pdf:*.pdf\n' >"$WORK/desk/mime/globs2"
printf '#!/bin/sh\n' >"$WORK/viewer"
chmod +x "$WORK/viewer"
printf '[Desktop Entry]\nType=Application\nName=Viewer\nExec=%s %%f\nMimeType=application/pdf;\n' \
  "$WORK/viewer" >"$WORK/desk/applications/viewer.desktop"
touch "$WORK/notes.pdf"
( cd "$WORK" && env DOMICILE_SOCK="$SOCK" PATH="$SHIMS:$APP_PATH" \
    XDG_DATA_HOME="$WORK/desk" XDG_DATA_DIRS="$WORK/none" \
    XDG_CONFIG_HOME="$WORK/desk-config" XDG_CONFIG_DIRS="$WORK/none" \
    xdg-open notes.pdf >"$WORK/file.log" 2>&1 )
# The compositor starts it, as the launcher does.
SPAWNED="$(tail -n 1 "$WORK/compositor-spawned" 2>/dev/null)"
WANT="[\"$WORK/viewer\", \"$WORK/notes.pdf\"]"
if [ "$SPAWNED" = "$WANT" ]; then
  echo "PASS: the compositor was told to start $SPAWNED"
else
  echo "FAIL: the compositor was told to start '$SPAWNED', not $WANT:"
  sed 's/^/    /' "$WORK/file.log"
  FAILED=1
fi

echo "== and open --which names that application =="
WHICH="$( cd "$WORK" && env PATH="$SHIMS:$APP_PATH" \
    XDG_DATA_HOME="$WORK/desk" XDG_DATA_DIRS="$WORK/none" \
    XDG_CONFIG_HOME="$WORK/desk-config" XDG_CONFIG_DIRS="$WORK/none" \
    domicile open --which notes.pdf 2>&1 )"
if [ "$WHICH" = "viewer.desktop" ]; then
  echo "PASS: open --which said $WHICH"
else
  echo "FAIL: open --which said '$WHICH', not viewer.desktop"
  FAILED=1
fi

exit "$FAILED"
