#!/usr/bin/env bash
# Tests the verdict of `guard-webview-download.sh`: which readings pass and
# which component a failure blames.
#
# Runs the verdict block from the real guard, so moving it fails here.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
GUARD="$ROOT/packages/domicile-engine/scripts/guard-webview-download.sh"
[ -f "$GUARD" ] || {
  echo "no guard at $GUARD" >&2
  exit 1
}

BLOCK="$(awk '/^FAILURE=""$/,/^fi$/' "$GUARD")"
[ -n "$BLOCK" ] || {
  echo "no verdict block in $GUARD — its markers moved. Fix this test with it." >&2
  exit 1
}
# Names the failure messages interpolate.
NAME="guard-download.txt"
PICK="saved/renamed-by-the-shell.txt"

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

# Runs the verdict with every reading true; each case overrides one.
run_block() { # $1 NEGATIVE, then NAME=value overrides
  SAW_SHELL=1
  SAW_PAGE=1
  SAW_CHROME=1
  SAW_GUEST=1
  SAW_FETCHED=1
  SAW_BROWSER=1
  SAW_ASKED=1
  SAW_SUGGESTED=1
  SAW_FOLDER=1
  SAW_ASKED_AGAIN=1
  SAW_ANSWERED=1
  SAVED=1
  SAVED_ANYWHERE=1
  SAW_GUEST_COUNTED=1
  SAW_COUNTED=1
  SAW_FINISHED=1
  SAW_FORGOTTEN=1
  NEGATIVE="$1"
  shift
  for override in "$@"; do
    eval "$override"
  done
  eval "$BLOCK"
}

verdict() {
  (
    run_block "$@"
    if [ -n "$PASSED" ]; then
      echo "pass"
    elif [ -n "$FAILURE" ]; then
      echo "fail"
    else
      echo "neither"
    fi
  )
}

blames() { # $1 word, then the args verdict takes
  local word="$1"
  shift
  case "$( (run_block "$@"; echo "$FAILURE"))" in
  *"$word"*) echo yes ;;
  *) echo no ;;
  esac
}

# The control's readings: the shell canceled, so nothing was saved.
CONTROL="SAVED=0 SAVED_ANYWHERE=0 SAW_GUEST_COUNTED=0 SAW_COUNTED=0 SAW_FINISHED=0 SAW_FORGOTTEN=0"

echo "a run that never got as far as measuring anything"
# shellcheck disable=SC2086
expect "a shell that never ran is a failure, in the control too" "fail" \
  "$(verdict 1 $CONTROL SAW_SHELL=0)"
expect "no press in the shell's document blames the harness" "yes" \
  "$(blames "harness" 0 SAW_CHROME=0)"
expect "an empty window names the guest" "yes" \
  "$(blames "the guest" 0 SAW_PAGE=0)"
expect "a press that missed the guest is a failure" "fail" \
  "$(verdict 0 SAW_GUEST=0)"
expect "a link that fetched nothing names the fixture" "yes" \
  "$(blames "fixture" 0 SAW_FETCHED=0)"

echo
echo "which process the question stopped in"
expect "a download that never asked names the prompt pref and patch 0053" "yes" \
  "$(blames "prompt_for_download" 0 SAW_BROWSER=0 SAW_ASKED=0)"
expect "a browser that asked and a shell not told says so" "yes" \
  "$(blames "SHELL WAS NOT TOLD" 0 SAW_ASKED=0)"
expect "the wrong suggested name says so" "yes" \
  "$(blames "wrong name" 0 SAW_SUGGESTED=0)"
expect "a picker that starts outside the download folder blames the folder" yes \
  "$(blames "wrong folder" 0 SAW_FOLDER=0)"
expect "a download held behind an unanswered picker is a failure" "fail" \
  "$(verdict 0 SAW_ASKED_AGAIN=0 SAW_ANSWERED=0 SAVED=0)"
expect "a download held behind an unanswered picker names the queue" "yes" \
  "$(blames "HELD THE NEXT DOWNLOAD" 0 SAW_ASKED_AGAIN=0 SAW_ANSWERED=0 SAVED=0)"
# shellcheck disable=SC2086
expect "the control holds nothing, so asking once is enough" "pass" \
  "$(verdict 1 $CONTROL SAW_ASKED_AGAIN=0)"
expect "an answer that threw blames this guard's page" "yes" \
  "$(blames "threw" 0 SAW_ANSWERED=0)"

echo
echo "the positive run"
expect "the file where the shell said is the pass" "pass" "$(verdict 0)"
expect "the file somewhere else is a failure" "fail" "$(verdict 0 SAVED=0)"
expect "the file somewhere else says so" "yes" \
  "$(blames "SOMEWHERE ELSE" 0 SAVED=0)"
expect "no file at all is a failure" "fail" \
  "$(verdict 0 SAVED=0 SAVED_ANYWHERE=0)"

echo
echo "the progress the shell was shown"
expect "a download the desk never listed names DeskDownloads::Add" "yes" \
  "$(blames "DeskDownloads::Add" 0 SAW_GUEST_COUNTED=0 SAW_COUNTED=0)"
expect "a download the shell never heard names the client" "yes" \
  "$(blames "DownloadsClient" 0 SAW_COUNTED=0)"
expect "a finished download not listed as finished is a failure" "fail" \
  "$(verdict 0 SAW_FINISHED=0 SAW_FORGOTTEN=0)"
expect "a finished download not listed as finished says so" "yes" \
  "$(blames "NOT LISTED" 0 SAW_FINISHED=0 SAW_FORGOTTEN=0)"
expect "a finished download the shell could not remove is a failure" "fail" \
  "$(verdict 0 SAW_FORGOTTEN=0)"
expect "a finished download the shell could not remove names the call" "yes" \
  "$(blames "removeDownload" 0 SAW_FORGOTTEN=0)"

echo
echo "the control run — a shell that cancels"
# shellcheck disable=SC2086
expect "nothing on the disk is the pass" "pass" "$(verdict 1 $CONTROL)"
# shellcheck disable=SC2086
expect "a file after a cancel is the failure" "fail" \
  "$(verdict 1 $CONTROL SAVED_ANYWHERE=1)"
# shellcheck disable=SC2086
expect "a canceled download listed as in progress is a failure" "fail" \
  "$(verdict 1 $CONTROL SAW_COUNTED=1)"
# shellcheck disable=SC2086
expect "a canceled download listed as finished is a failure" "fail" \
  "$(verdict 1 $CONTROL SAW_FINISHED=1)"

echo
if [ "$FAILED" -eq 0 ]; then
  echo "the download guard's verdict names the right end in every case"
  exit 0
fi
echo "$FAILED case(s) wrong" >&2
exit 1
