#!/usr/bin/env bash
# Checks an app window with an id is reused instead of opened again: by
# `open_url` with `app_id` and `reuse`, and by a shell's `openAppWindow`. Also
# checks `countBrowserWindowMatches` counts in a window the shell draws.
#
#   nix develop .#full --command \
#     ./packages/domicile-engine/scripts/guard-app-window-reuse.sh /build/chromium/src
#
# Headless and software-composited: nothing is measured in pixels.
#
# DeskWindows::OpenApp matches an open app window by its id. "focus" brings it
# to the front through WebViewGuest::RequestFocus, which fires
# `domicile-focus-request` on its <webview>; "navigate" also loads the
# address in it (docs/architecture/WEB-APPS.md).
#
# The guard opens `mail?n=1` with app id `mail`, then `mail?n=2` with "focus",
# then `mail?n=3` with "navigate", each once the last one's window is drawn.
# The shell opens `chat` with app id `chat` twice in a row, with "focus", and
# counts the chat page's three `p.item`s.
#
# Asserts, in order (each only meaningful if the previous holds):
#
#   the shell ran                       it can list windows
#   the engine answered each `opened`   the commands reached the engine
#   a mail window is listed             the shell can draw it
#   it was drawn                        a focus request has an element to reach
#   the third address is loaded in it   "navigate" loads it in the open window
#   only one mail window was listed     "focus" and "navigate" open none
#   the mail window asked to be in front, twice
#                                       the shell would raise it
#   a chat window is listed             the shell's openAppWindow opened one
#   only one was                        the shell's second call reused it
#   the count is 3                      countBrowserWindowMatches counts in it
#
# NEGATIVE=1 opens every window with "new". There must then be three mail
# windows, two chat windows and no focus request, so a run where nothing is
# ever opened twice cannot pass.
set -u

SCRIPTS="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=packages/domicile-engine/scripts/lib-annotate.sh
. "$SCRIPTS/lib-annotate.sh"
# shellcheck source=packages/domicile-engine/scripts/lib-last-words.sh
. "$SCRIPTS/lib-last-words.sh"
# shellcheck source=packages/domicile-engine/scripts/lib-ports.sh
. "$SCRIPTS/lib-ports.sh"
# shellcheck source=packages/domicile-engine/scripts/lib-profile.sh
. "$SCRIPTS/lib-profile.sh"
# shellcheck source=packages/domicile-engine/scripts/lib-broker.sh
. "$SCRIPTS/lib-broker.sh"

CHROMIUM="${1:-}"
if [ -z "$CHROMIUM" ]; then
  annotate "guard-app-window-reuse: no path to chromium/src was given"
  exit 1
fi

# NEGATIVE=1 opens every window with "new". See the header.
NEGATIVE="${NEGATIVE:-0}"

OUT="${OUT:-out/Domicile}"
WHICH=""
[ "$NEGATIVE" = "1" ] && WHICH="-negative"
BROKER="${BROKER:-/tmp/domicile-app-window-reuse$WHICH-broker}"
COMMAND="${COMMAND:-/tmp/domicile-app-window-reuse$WHICH-command}"
PROFILE="${PROFILE:-/tmp/domicile-app-window-reuse$WHICH-profile}"
ENGINE_LOG="${ENGINE_LOG:-/tmp/domicile-app-window-reuse$WHICH-engine.log}"
HTTP_LOG="${HTTP_LOG:-/tmp/domicile-app-window-reuse$WHICH-http.log}"

# Time for each step. Generous because every step is asynchronous and the
# machine is shared.
FOR_SECONDS="${FOR_SECONDS:-90}"

STARTED=()
cleanup() {
  if [ ${#STARTED[@]} -gt 0 ]; then
    kill "${STARTED[@]}" 2>/dev/null
  fi
  remove_profile "$PROFILE"
  rm -f "$COMMAND"
}
trap cleanup EXIT

[ -x "$CHROMIUM/$OUT/chrome" ] || {
  annotate "guard-app-window-reuse: no engine at $CHROMIUM/$OUT/chrome; build it with ./packages/domicile-engine/scripts/build.sh"
  exit 1
}
command -v python3 >/dev/null || {
  skip "guard-app-window-reuse: no python3, and the pages and the commands are both driven by one"
  exit 77
}

fresh_broker
rm -f "$COMMAND"
rm -rf "$PROFILE"
mkdir -p "$PROFILE"

TRIES=$((FOR_SECONDS * 4))
wait_for_line() { # $1 tries, $2 pattern, $3 file
  for _ in $(seq 1 "$1"); do
    grep -qF -- "$2" "$3" 2>/dev/null && return 0
    grep -qF "Received signal" "$ENGINE_LOG" 2>/dev/null && return 1
    sleep 0.25
  done
  return 1
}

# Sends `open_url` for app window $1 with app id `mail` and reuse $2 to the
# engine's command socket, and prints its answer.
open_mail() {
  python3 - "$COMMAND" "$1" "$2" <<'PY' 2>&1
import json, socket, sys

path, url, reuse = sys.argv[1], sys.argv[2], sys.argv[3]
line = json.dumps({"type": "open_url", "version": 1, "url": url, "app": True,
                   "app_id": "mail", "reuse": reuse})
try:
    connection = socket.socket(socket.AF_UNIX)
    connection.settimeout(10)
    connection.connect(path)
    connection.sendall((line + "\n").encode())
    print(connection.makefile().readline().strip())
except OSError as failure:
    print("no answer: %s" % failure)
PY
}

# 1. The pages.
rm -f "$HTTP_LOG"
python3 "$SCRIPTS/guard-app-window-reuse-server.py" --port 0 \
  >"$HTTP_LOG" 2>&1 &
STARTED+=($!)
wait_for_line 240 "serving" "$HTTP_LOG" || {
  annotate_from "guard-app-window-reuse: its page server never came up" "$HTTP_LOG"
  tail -20 "$HTTP_LOG" >&2
  exit 1
}
PORT="$(served_port "$HTTP_LOG")" || {
  annotate_from "guard-app-window-reuse: its page server never said which port it took" "$HTTP_LOG"
  exit 1
}
SITE="http://127.0.0.1:$PORT"
FOCUS=focus
NAVIGATE=navigate
if [ "$NEGATIVE" = "1" ]; then
  FOCUS=new
  NAVIGATE=new
fi

# 2. The engine, with the command socket `domicile open --app` uses.
rm -f "$ENGINE_LOG"
"$CHROMIUM/$OUT/chrome" \
  --ozone-platform=headless \
  --disable-gpu \
  --app="domicile://shell/?site=$SITE&reuse=$FOCUS" \
  --domicile-shell-root="$SCRIPTS" \
  --domicile-shell-module="guard-app-window-reuse.js" \
  --domicile-command-socket="$COMMAND" \
  --no-sandbox --password-store=basic --no-first-run --disable-component-update \
  --user-data-dir="$PROFILE" \
  --enable-logging=stderr --log-level=0 \
  --domicile-broker-socket="$BROKER" >"$ENGINE_LOG" 2>&1 &
STARTED+=($!)

# 3. Each mail window once the last one is drawn and loaded, so a focus
#    request has an element to reach.
wait_for_line "$TRIES" "GUARD shell-loaded" "$ENGINE_LOG"
FIRST_ANSWER="$(open_mail "$SITE/mail?n=1" "$FOCUS")"
echo "the engine answered mail 1 (reuse=$FOCUS): $FIRST_ANSWER"
wait_for_line "$TRIES" "loaded mail n=1" "$HTTP_LOG"
# The shell lists the window after the page loads, not before: read its id
# only once it is listed.
wait_for_line "$TRIES" "GUARD list mail=1 " "$ENGINE_LOG"
MAIL_ID="$(sed -n 's/.*GUARD list mail=[0-9]* chat=[0-9]* mail-id=\([0-9][0-9]*\) .*/\1/p' "$ENGINE_LOG" | head -1)"
wait_for_line "$TRIES" "attached browser window ${MAIL_ID:-none} to a <webview>" "$ENGINE_LOG"
SECOND_ANSWER="$(open_mail "$SITE/mail?n=2" "$FOCUS")"
echo "the engine answered mail 2 (reuse=$FOCUS): $SECOND_ANSWER"
# "focus" loads nothing, so the run waits for its focus request instead.
if [ "$NEGATIVE" = "1" ]; then
  wait_for_line "$TRIES" "loaded mail n=2" "$HTTP_LOG"
else
  wait_for_line "$TRIES" "GUARD focus app=mail" "$ENGINE_LOG"
fi
THIRD_ANSWER="$(open_mail "$SITE/mail?n=3" "$NAVIGATE")"
echo "the engine answered mail 3 (reuse=$NAVIGATE): $THIRD_ANSWER"
wait_for_line "$TRIES" "loaded mail n=3" "$HTTP_LOG"
wait_for_line "$TRIES" "GUARD count" "$ENGINE_LOG"
# Room for a window opened by mistake to be listed.
sleep 2

saw() { # $1 pattern, $2 log
  grep -qF -- "$1" "$2" && echo 1 || echo 0
}
# The most windows any list line had for app id $1.
most() {
  sed -n "s/.*GUARD list .*$1=\([0-9][0-9]*\).*/\1/p" "$ENGINE_LOG" | sort -n | tail -1
}

OPENED='{"type":"opened"}'
SAW_SHELL=$(saw "GUARD shell-loaded" "$ENGINE_LOG")
SAW_CRASH=$(saw "Received signal" "$ENGINE_LOG")
OPENED_MAIL=0
[ "$FIRST_ANSWER" = "$OPENED" ] && [ "$SECOND_ANSWER" = "$OPENED" ] &&
  [ "$THIRD_ANSWER" = "$OPENED" ] && OPENED_MAIL=1
SAW_MAIL=0
[ -n "$MAIL_ID" ] && SAW_MAIL=1
DREW_MAIL=$(saw "attached browser window ${MAIL_ID:-none} to a <webview>" "$ENGINE_LOG")
NAVIGATED=$(saw "mail-url=$SITE/mail?n=3" "$ENGINE_LOG")
MAIL_WINDOWS="$(most mail)"
MAIL_FOCUSED="$(grep -cF "GUARD focus app=mail" "$ENGINE_LOG")"
CHAT_WINDOWS="$(most chat)"
COUNTED="$(sed -n 's/.*GUARD count=\([0-9][0-9]*\).*/\1/p' "$ENGINE_LOG" | head -1)"

echo
echo "shell=$SAW_SHELL crash=$SAW_CRASH"
echo "mail: opened=$OPENED_MAIL listed=$SAW_MAIL drawn=$DREW_MAIL navigated=$NAVIGATED windows=${MAIL_WINDOWS:-0} focused=$MAIL_FOCUSED"
echo "chat: windows=${CHAT_WINDOWS:-0} counted=${COUNTED:-none}"
echo

# The verdict. `packages/domicile-engine/tests/test-app-window-reuse-guard.sh`
# runs this block directly.
#
# The run reuses one window per app id; the control opens one per call.
FAILURE=""
PASSED=""
WANT_MAIL=1
WANT_FOCUSED=2
WANT_CHAT=1
[ "$NEGATIVE" = "1" ] && {
  WANT_MAIL=3
  WANT_FOCUSED=0
  WANT_CHAT=2
}
if [ "$SAW_SHELL" != "1" ]; then
  FAILURE="the shell page never ran, so nothing here was ever set up. This is \
the harness: the module did not load, or it threw, and the engine log has its \
console"
elif [ "$SAW_CRASH" = "1" ]; then
  FAILURE="a process dumped a signal. Read the dumped stack"
elif [ "$OPENED_MAIL" != "1" ]; then
  FAILURE="the engine did not answer every mail open_url with opened: the \
command socket was not bound (--domicile-command-socket), or the engine \
refused \"app_id\" or \"reuse\". The answers are printed above"
elif [ "$SAW_MAIL" != "1" ]; then
  FAILURE="no window with app id mail reached the shell's list. That is \
DeskWindows::List or DomicileBrowserWindow's appId"
elif [ "$DREW_MAIL" != "1" ]; then
  FAILURE="the mail window was never attached to the shell's <webview>, so a \
focus request had nothing to reach. That is the harness's draw"
elif [ "$NEGATIVE" != "1" ] && [ "$NAVIGATED" != "1" ]; then
  FAILURE="\"navigate\" did not load its address in the open mail window. \
That is DeskWindows::OpenApp's Navigate"
elif [ "${MAIL_WINDOWS:-0}" != "$WANT_MAIL" ] && [ "$NEGATIVE" = "1" ]; then
  FAILURE="\"new\" did not open a mail window per call (wanted $WANT_MAIL, \
saw ${MAIL_WINDOWS:-0}), so the run's single window proves nothing. That is \
DeskWindows::OpenApp"
elif [ "${MAIL_WINDOWS:-0}" != "$WANT_MAIL" ]; then
  FAILURE="AN OPEN APP WINDOW WAS NOT REUSED: \"focus\" or \"navigate\" opened \
another mail window (saw ${MAIL_WINDOWS:-0}). Check DeskWindows::OpenApp \
matches by app id"
elif [ "$MAIL_FOCUSED" != "$WANT_FOCUSED" ]; then
  FAILURE="the mail window asked to be in front $MAIL_FOCUSED times, wanted \
$WANT_FOCUSED, so the shell would not raise a reused window, or would raise a \
new one. That is DeskWindows::OpenApp's RequestFocus"
elif [ "${CHAT_WINDOWS:-0}" = "0" ]; then
  FAILURE="the shell's openAppWindow opened no chat window. That is \
DomicileHost::openAppWindow or the shell's call, whose console is in the \
engine log"
elif [ "${CHAT_WINDOWS:-0}" != "$WANT_CHAT" ]; then
  FAILURE="the shell's two openAppWindow calls opened ${CHAT_WINDOWS:-0} chat \
windows, wanted $WANT_CHAT. That is BrowserWindowsService::OpenApp"
elif [ "${COUNTED:-none}" != "3" ]; then
  FAILURE="countBrowserWindowMatches answered ${COUNTED:-nothing}, wanted 3. \
That is BrowserWindowsService::CountMatches; a count-failed line in the \
engine log says why it rejected"
elif [ "$NEGATIVE" = "1" ]; then
  PASSED="the control is sharp: with \"new\" every call opens a window and \
none asks to be in front"
else
  PASSED="an app window with an id is reused by \"focus\" and \"navigate\", \
from the command socket and from openAppWindow, and asks to be in front; \
countBrowserWindowMatches counts in it"
fi

if [ -n "$PASSED" ]; then
  echo "PASS: $PASSED"
  exit 0
fi

annotate "guard-app-window-reuse: $FAILURE"
echo "what the engine died of, if it did:" >&2
grep -n -A45 -E "FATAL|Check failed|Received signal" "$ENGINE_LOG" | head -150 >&2
echo "the engine's last words:" >&2
last_words "$ENGINE_LOG" >&2
echo "what the server was asked for:" >&2
tail -20 "$HTTP_LOG" >&2
exit 1
