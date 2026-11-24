#!/usr/bin/env bash
# Guard: a download in a browser window asks the shell where to save, and the
# file lands there.
#
#   nix develop .#full --command \
#     ./packages/domicile-engine/scripts/guard-webview-download.sh /build/chromium/src
#
# Runs headless; nothing here is measured in pixels.
#
# Patch 0053 routes a guest's download to WebViewGuest::ChooseDownloadPath,
# which asks the element in save mode like an `<input type="file">`, instead of
# Chrome's portal save dialog. It also sets `download.prompt_for_download` so
# every download asks.
#
# The link is pressed twice. The positive run's shell holds the first question
# unanswered, as a hidden window's picker, and answers the second: Chrome shows
# one picker at a time per profile, and a guest's download must not wait behind
# one nobody answers.
#
# Assertions, in order:
#
#   the shell page ran
#   a press on the strip reached the shell's document (the harness works)
#   the guest page loaded
#   the press landed on the guest's link
#   the file was fetched
#   the browser called ChooseDownloadPath
#   the shell was asked in save mode with the site's file name
#   the second download asked while the first was held
#   the shell answered without throwing
#   the file is at the shell's path with the site's bytes (the claim)
#   the desk listed the download in progress, then as finished, with its path
#   and its window, until the shell removed it
#
# NEGATIVE=1 runs a shell that cancels. Nothing may be saved anywhere in the
# home, proving the browser does not save regardless of the answer, and the
# desk never lists it, in progress or finished.
#
# The guard uses its own empty home, so any file there with the site's bytes
# is this run's download.
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
  annotate "guard-webview-download: no path to chromium/src was given"
  exit 1
fi

NEGATIVE="${NEGATIVE:-0}"

OUT="${OUT:-out/Domicile}"
BROKER="${BROKER:-/tmp/domicile-webview-download-broker}"
PROFILE="${PROFILE:-/tmp/domicile-webview-download-profile}"
HOME_DIR="${HOME_DIR:-/tmp/domicile-webview-download-home}"
WIDTH="${WIDTH:-1024}"
HEIGHT="${HEIGHT:-768}"
# Not `STRIP`: `nix develop .#full` exports STRIP=strip.
STRIP_HEIGHT="${STRIP_HEIGHT:-64}"
CHROME_X=$((WIDTH / 2))
CHROME_Y=$((STRIP_HEIGHT / 2))
# The middle of the guest, which the link fills.
WINDOW_X=$((WIDTH / 2))
WINDOW_Y=$((STRIP_HEIGHT + (HEIGHT - STRIP_HEIGHT) / 2))

FOR_SECONDS="${FOR_SECONDS:-90}"

# Must match FILE_NAME and FILE_TEXT in guard-webview-file-chooser-server.py.
# PICK is where the shell saves it.
NAME="guard-download.txt"
TEXT="a file the shell was asked where to put"
PICK="saved/renamed-by-the-shell.txt"

WHICH=""
[ "$NEGATIVE" = "1" ] && WHICH="-negative"
ENGINE_LOG="${ENGINE_LOG:-/tmp/domicile-webview-download$WHICH-engine.log}"
HTTP_LOG="${HTTP_LOG:-/tmp/domicile-webview-download$WHICH-http.log}"
CLICK_LOG="${CLICK_LOG:-/tmp/domicile-webview-download$WHICH-mouse.log}"

ANSWER="choose"
HOLD="&hold=first"
if [ "$NEGATIVE" = "1" ]; then
  ANSWER="cancel"
  HOLD=""
fi

STARTED=()
cleanup() {
  if [ ${#STARTED[@]} -gt 0 ]; then
    kill "${STARTED[@]}" 2>/dev/null
  fi
  remove_profile "$PROFILE"
  rm -rf "$HOME_DIR"
}
trap cleanup EXIT

[ -x "$CHROMIUM/$OUT/chrome" ] || {
  annotate "guard-webview-download: no engine at $CHROMIUM/$OUT/chrome; build it with ./packages/domicile-engine/scripts/build.sh"
  exit 1
}
command -v python3 >/dev/null || {
  skip "guard-webview-download: no python3, and the page in the window and the click are both driven by one"
  exit 77
}

fresh_broker
rm -rf "$PROFILE" "$HOME_DIR"; mkdir -p "$PROFILE"
mkdir -p "$HOME_DIR/$(dirname "$PICK")"

wait_for_line() { # $1 tries, $2 pattern, $3 file
  for _ in $(seq 1 "$1"); do
    grep -qF "$2" "$3" 2>/dev/null && return 0
    sleep 0.25
  done
  return 1
}

# 1. Serve the window's page.
rm -f "$HTTP_LOG"
python3 "$SCRIPTS/guard-webview-file-chooser-server.py" --port 0 \
  >"$HTTP_LOG" 2>&1 &
STARTED+=($!)
wait_for_line 240 "serving" "$HTTP_LOG" || {
  annotate_from "guard-webview-download: its page server never came up" "$HTTP_LOG"
  exit 1
}
PORT="$(served_port "$HTTP_LOG")" || {
  annotate_from "guard-webview-download: its page server never said which port it took" "$HTTP_LOG"
  exit 1
}
SITE="http://127.0.0.1:$PORT"

# 2. Start the engine on a domicile:// page with this guard's home.
rm -f "$ENGINE_LOG"
HOME="$HOME_DIR" "$CHROMIUM/$OUT/chrome" \
  --ozone-platform=headless \
  --disable-gpu \
  --app="domicile://shell/?strip=$STRIP_HEIGHT&src=$SITE/download&answer=$ANSWER&pick=$PICK$HOLD" \
  --domicile-shell-root="$SCRIPTS" \
  --domicile-shell-module="guard-webview-file-chooser.js" \
  --remote-debugging-port=0 \
  --no-sandbox --password-store=basic --no-first-run --disable-component-update \
  --user-data-dir="$PROFILE" \
  --window-size="$WIDTH,$HEIGHT" \
  --enable-logging=stderr --log-level=0 \
  --domicile-broker-socket="$BROKER" >"$ENGINE_LOG" 2>&1 &
STARTED+=($!)

TRIES=$((FOR_SECONDS * 4))
wait_for_line "$TRIES" "GUARD shell-loaded" "$ENGINE_LOG" || {
  annotate_from "guard-webview-download: the shell page never ran, so nothing here was ever set up" "$ENGINE_LOG"
  exit 1
}
DEBUG_PORT="$(devtools_port "$PROFILE" "$TRIES")" || {
  annotate_from "guard-webview-download: the engine never said which debugging port it took" "$ENGINE_LOG"
  exit 1
}

# 3. Wait for the guest page, then settle for its first frame.
wait_for_line "$TRIES" "GUARD download-loaded" "$ENGINE_LOG" ||
  echo "nothing ever loaded in the window" >&2
sleep 3

# 4. Click the shell's strip to check the harness.
python3 "$SCRIPTS/guard-webview-click-mouse.py" \
  --port "$DEBUG_PORT" --x "$CHROME_X" --y "$CHROME_Y" \
  >"$CLICK_LOG" 2>&1 ||
  echo "the first click could not be driven; see $CLICK_LOG" >&2
wait_for_line 20 "GUARD chrome-mousedown" "$ENGINE_LOG" ||
  echo "the shell's document never reported the first click" >&2

# 5. Click the link in the guest, and again once the shell has been asked.
python3 "$SCRIPTS/guard-webview-click-mouse.py" \
  --port "$DEBUG_PORT" --x "$WINDOW_X" --y "$WINDOW_Y" \
  >>"$CLICK_LOG" 2>&1 ||
  echo "the click into the window could not be driven; see $CLICK_LOG" >&2
wait_for_line 40 "GUARD file-chooser mode=save " "$ENGINE_LOG" ||
  echo "the first download never asked the shell" >&2
python3 "$SCRIPTS/guard-webview-click-mouse.py" \
  --port "$DEBUG_PORT" --x "$WINDOW_X" --y "$WINDOW_Y" \
  >>"$CLICK_LOG" 2>&1 ||
  echo "the second click into the window could not be driven; see $CLICK_LOG" >&2

# A fixed wait, because the control checks for absences. Long enough to fetch,
# ask, answer and write the file.
sleep 10

saw() { # $1 pattern
  grep -qF "$1" "$ENGINE_LOG" && echo 1 || echo 0
}

SAW_SHELL=$(saw "GUARD shell-loaded")
SAW_PAGE=$(saw "GUARD download-loaded")
SAW_CHROME=$(saw "GUARD chrome-mousedown")
SAW_GUEST=$(saw "GUARD guest-mousedown")
SAW_FETCHED=$(grep -qF "GET /file " "$HTTP_LOG" && echo 1 || echo 0)
# Logged by WebViewGuest::ChooseDownloadPath. Tells "never asked" from "asked
# but the shell was not told".
SAW_BROWSER=$(saw "domicile: a <webview>'s download asked the shell where to go.")
SAW_ASKED=$(saw "GUARD file-chooser mode=save ")
SAW_SUGGESTED=$(saw "GUARD file-chooser mode=save suggested=$NAME ")
# No user-dirs.dirs under the guard's home, so the download folder is
# ~/Downloads.
SAW_FOLDER=$(saw "GUARD file-chooser mode=save suggested=$NAME accept= folder=$HOME_DIR/Downloads")
SAW_ASKED_AGAIN=$([ "$(grep -cF "GUARD file-chooser mode=save " "$ENGINE_LOG")" -ge 2 ] && echo 1 || echo 0)
SAW_ANSWERED=$(saw "GUARD answered")
SAVED=$([ "$(cat "$HOME_DIR/$PICK" 2>/dev/null)" = "$TEXT" ] && echo 1 || echo 0)
# The download anywhere in the home: a file with the site's bytes, or a
# `.crdownload` partial. Matched by content, because the browser writes its own
# files under `HOME` (such as `~/.pki/nssdb`) regardless of the answer.
FOUND="$(
  {
    grep -rlF -- "$TEXT" "$HOME_DIR" 2>/dev/null
    find "$HOME_DIR" -type f -name '*.crdownload' 2>/dev/null
  } | sort -u
)"
SAVED_ANYWHERE=$([ -n "$FOUND" ] && echo 1 || echo 0)
# Logged by DeskDownloads::Add. Tells "never listed" from "listed but the
# shell was not told". The guard's <webview> is not a browser window, so it
# names none.
SAW_GUEST_COUNTED=$(saw 'domicile: the desk listed a download from browser window "".')
# With the path it is saved at, absolute.
SAW_COUNTED=$(saw "GUARD downloads in-progress:$HOME_DIR/$PICK:")
SAW_FINISHED=$(saw "GUARD downloads complete:$HOME_DIR/$PICK:")
SAW_FORGOTTEN=$(saw "GUARD download-removed")

echo
echo "shell=$SAW_SHELL page=$SAW_PAGE press=$SAW_CHROME guest=$SAW_GUEST fetched=$SAW_FETCHED"
echo "the browser asked=$SAW_BROWSER; the shell was asked=$SAW_ASKED with the name=$SAW_SUGGESTED in the folder=$SAW_FOLDER, again=$SAW_ASKED_AGAIN and answered=$SAW_ANSWERED"
echo "on the disk: where the shell said=$SAVED anywhere=$SAVED_ANYWHERE"
echo "in progress: the desk listed=$SAW_GUEST_COUNTED; the shell heard=$SAW_COUNTED"
echo "finished: listed=$SAW_FINISHED, removed=$SAW_FORGOTTEN"
[ -n "$FOUND" ] && printf '  %s\n' $FOUND
echo "everything in the home, for the record:"
find "$HOME_DIR" -type f 2>/dev/null | sed 's/^/  /'
echo

# Turn the readings into a verdict. `packages/domicile-engine/tests/test-webview-download-guard.sh`
# tests this block.
FAILURE=""
PASSED=""
if [ "$SAW_SHELL" != "1" ]; then
  FAILURE="the shell page never ran, so nothing here was ever set up. This is \
the harness: the module did not load, or it threw"
elif [ "$SAW_CHROME" != "1" ]; then
  FAILURE="no press reached the shell's document at all, so every reading \
below is about a desktop nobody touched. This is the harness"
elif [ "$SAW_PAGE" != "1" ]; then
  FAILURE="nothing ever loaded in the window, so there was no link to press. \
That is the guest: not made, not attached, or not navigated"
elif [ "$SAW_GUEST" != "1" ]; then
  FAILURE="the press never reached the page in the window. That is this \
harness or the element's box rather than anything about downloads"
elif [ "$SAW_FETCHED" != "1" ]; then
  FAILURE="the press landed and the file was never fetched: the link started \
no download. That is the fixture or the guest's navigation, and the http log \
says what was asked for"
elif [ "$SAW_BROWSER" != "1" ]; then
  FAILURE="THE DOWNLOAD NEVER ASKED: the file was fetched and \
WebViewGuest::ChooseDownloadPath never ran. Either download.prompt_for_download \
is off -- patch 0053's PostProfileInit -- or ShowFilePickerWithUserTakeover \
did not find this guest from the download's WebContents"
elif [ "$SAW_ASKED" != "1" ]; then
  FAILURE="THE BROWSER ASKED AND THE SHELL WAS NOT TOLD: ChooseDownloadPath \
ran and no domicile-file-chooser in save mode reached this document. That is \
FileChooserRequested on WebViewGuestClient, the dispatch in \
HTMLWebViewElement, or the event's name"
elif [ "$SAW_SUGGESTED" != "1" ]; then
  FAILURE="the shell was asked with the wrong name: the site called the file \
$NAME and the question did not carry it. The suggestion is the base name of \
the path //chrome proposed -- see ChooseDownloadPath"
elif [ "$SAW_FOLDER" != "1" ]; then
  FAILURE="the shell was asked with the wrong folder: a download's picker \
starts in the download folder, the folder of the path //chrome proposed -- \
see StartFolder in file_choice.h"
elif [ "$NEGATIVE" != "1" ] && [ "$SAW_ASKED_AGAIN" != "1" ]; then
  FAILURE="A HELD PICKER HELD THE NEXT DOWNLOAD: the shell held the first \
question unanswered and the second download never asked. A guest's download \
must ask before Chrome's one-picker-at-a-time queue -- see patch 0053's \
ShowFilePickerWithUserTakeover"
elif [ "$SAW_ANSWERED" != "1" ]; then
  FAILURE="the shell was asked and its answer threw: this guard's page called \
choose() or cancel() and never got past it. The engine log has the exception"
elif [ "$NEGATIVE" = "1" ]; then
  if [ "$SAVED_ANYWHERE" = "1" ]; then
    FAILURE="THE CONTROL SAVED A FILE: the shell canceled and the download \
landed in the home anyway, so the positive run's file is not the shell's \
answer being followed"
  elif [ "$SAW_COUNTED" = "1" ]; then
    FAILURE="THE CONTROL LISTED A DOWNLOAD: the shell canceled and the desk \
said one was in progress. A download is listed once it has a target -- see \
IsListed in download_list.h"
  elif [ "$SAW_FINISHED" = "1" ]; then
    FAILURE="THE CONTROL LISTED A FINISHED DOWNLOAD: the shell canceled and \
the desk said one finished. A canceled download is kCanceled -- see StageOf \
in desk_downloads.cc"
  else
    PASSED="the control is sharp: the shell canceled, and nothing landed \
anywhere in the home. So what the positive run reads is the shell's answer"
  fi
elif [ "$SAVED" = "1" ]; then
  if [ "$SAW_GUEST_COUNTED" != "1" ]; then
    FAILURE="the download was saved and the desk never listed it: \
WebViewGuest::OnDownloadCreated did not find this guest from the download's \
WebContents, so DeskDownloads::Add never ran"
  elif [ "$SAW_COUNTED" != "1" ]; then
    FAILURE="the desk listed the download and the shell never heard it in \
progress: DownloadsChanged on DownloadsClient, DomicileHost's dispatch, or \
the event's name. Or the download had no target while in progress"
  elif [ "$SAW_FINISHED" != "1" ]; then
    FAILURE="THE FINISHED DOWNLOAD WAS NOT LISTED: the shell heard it in \
progress and never as complete with its path. See StageOf and List in \
desk_downloads.cc"
  elif [ "$SAW_FORGOTTEN" != "1" ]; then
    FAILURE="the shell called removeDownload() with its id and the desk \
still lists the finished download: DeskDownloads::Remove, or the call over \
Downloads"
  else
    PASSED="a download started inside a browser window asked the shell where \
it goes -- carrying the site's name for it -- landed at the path the shell \
answered with, relative to the home, with the bytes the site sent, and the \
desk listed it in progress, then as finished, until the shell removed it"
  fi
elif [ "$SAVED_ANYWHERE" = "1" ]; then
  FAILURE="THE FILE LANDED SOMEWHERE ELSE: the shell chose $PICK and the \
download is elsewhere in the home. The path is resolved under the home in the \
browser -- see PathInHome in file_choice.h -- and handed back in \
ChromeDownloadManagerDelegate"
else
  FAILURE="the shell answered and nothing landed: the download was canceled \
or never finished. The browser refused the answer -- a bad message, which the \
engine log names -- or //chrome dropped the confirmation"
fi

if [ -n "$PASSED" ]; then
  echo "PASS: $PASSED"
  exit 0
fi

annotate "guard-webview-download: $FAILURE"
echo "the engine's last words:" >&2
last_words "$ENGINE_LOG" >&2
echo "what the server was asked for:" >&2
tail -20 "$HTTP_LOG" >&2
exit 1
