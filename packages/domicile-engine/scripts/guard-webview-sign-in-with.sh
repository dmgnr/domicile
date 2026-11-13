#!/usr/bin/env bash
# A page in a <webview> signs in with an identity provider ("Sign in with",
# FedCM) through the shell, which shows the steps Chrome would draw over its
# window (patch 0210 and components/domicile/browser/identity_dialog.h).
#
#   nix develop .#full --command \
#     ./packages/domicile-engine/scripts/guard-webview-sign-in-with.sh /build/chromium/src
#
# Headless with software compositing, like guard-webview-click.sh: nothing here
# is measured in pixels, and nothing is pressed. The shell answers in script.
#
# guard-webview-sign-in-with-server.py serves the site and its provider on one
# origin. guard-webview-sign-in-with.js chooses the account the first time the
# page asks, navigates away the second, and dismisses the third.
#
# Assertions, in order; each is meaningful only if the previous one holds:
#
#   the shell page ran               or nothing was set up
#   the page ran                     the guest was made, attached and
#                                     navigated, and the page's script ran
#   the shell was asked              the request reached the <webview> as a
#                                     domicile-identity event with the
#                                     accounts, and not Chrome's own sheet
#   with the provider and account    the request carries the provider's name,
#                                     its one account, and what signing in
#                                     shares with the site
#   choosing signs in                the provider issued its token for the
#                                     account the shell chose, and the page got
#                                     it
#   leaving withdraws                navigating away while the shell shows the
#                                     accounts withdraws them
#   dismissing rejects               the shell's dismissal rejects the page's
#                                     request
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
  annotate "guard-webview-sign-in-with: no path to chromium/src was given"
  exit 1
fi

OUT="${OUT:-out/Domicile}"
BROKER="${BROKER:-/tmp/domicile-webview-sign-in-with-broker}"
PROFILE="${PROFILE:-/tmp/domicile-webview-sign-in-with-profile}"
WIDTH="${WIDTH:-1024}"
HEIGHT="${HEIGHT:-768}"

# Height of the shell's strip in CSS pixels.
#
# Not `STRIP`: `nix develop .#full` exports `STRIP=strip`. See
# guard-webview-external-app.sh.
STRIP_HEIGHT="${STRIP_HEIGHT:-64}"

# Time for the shell to load and its guest to attach and navigate, and for
# each of the page's reports.
FOR_SECONDS="${FOR_SECONDS:-90}"

ENGINE_LOG="${ENGINE_LOG:-/tmp/domicile-webview-sign-in-with-engine.log}"
HTTP_LOG="${HTTP_LOG:-/tmp/domicile-webview-sign-in-with-http.log}"

# What the server writes for the page's reports and for nothing else. The
# `GUARD` prefix keeps the server's `serving /rp, /report ...` banner from
# matching, which would end the wait before the page reported.
REPORT_LINE="GUARD report "

STARTED=()
cleanup() {
  if [ ${#STARTED[@]} -gt 0 ]; then
    kill "${STARTED[@]}" 2>/dev/null
  fi
  remove_profile "$PROFILE"
}
trap cleanup EXIT

[ -x "$CHROMIUM/$OUT/chrome" ] || {
  annotate "guard-webview-sign-in-with: no engine at $CHROMIUM/$OUT/chrome; build it with ./packages/domicile-engine/scripts/build.sh"
  exit 1
}
command -v python3 >/dev/null || {
  skip "guard-webview-sign-in-with: no python3, and the site and its provider are served by one"
  exit 77
}

fresh_broker
rm -rf "$PROFILE"; mkdir -p "$PROFILE"

# Waits for `$2` to appear in `$3`, for `$1` quarter-seconds.
wait_for_line() { # $1 tries, $2 pattern, $3 file
  for _ in $(seq 1 "$1"); do
    grep -qF "$2" "$3" 2>/dev/null && return 0
    sleep 0.25
  done
  return 1
}

# 1. The pages: one local server, because `crux` cannot reach arbitrary hosts.
rm -f "$HTTP_LOG"
python3 "$SCRIPTS/guard-webview-sign-in-with-server.py" --port 0 \
  >"$HTTP_LOG" 2>&1 &
STARTED+=($!)
wait_for_line 240 "serving" "$HTTP_LOG" || {
  annotate_from "guard-webview-sign-in-with: its page server never came up" "$HTTP_LOG"
  echo "the server said:" >&2
  tail -20 "$HTTP_LOG" >&2
  exit 1
}
PORT="$(served_port "$HTTP_LOG")" || {
  annotate_from "guard-webview-sign-in-with: its page server never said which port it took" "$HTTP_LOG"
  exit 1
}
SITE="http://127.0.0.1:$PORT"
WALK="src=$SITE/rp?phase=1"
echo "walking $WALK"

# 2. The engine, on a domicile:// document, because the browser binds
#    WebViewGuestHost for that origin only.
rm -f "$ENGINE_LOG"
"$CHROMIUM/$OUT/chrome" \
  --ozone-platform=headless \
  --disable-gpu \
  --app="domicile://shell/?strip=$STRIP_HEIGHT&$WALK" \
  --domicile-shell-root="$SCRIPTS" \
  --domicile-shell-module="guard-webview-sign-in-with.js" \
  --no-sandbox --password-store=basic --no-first-run --disable-component-update \
  --user-data-dir="$PROFILE" \
  --window-size="$WIDTH,$HEIGHT" \
  --enable-logging=stderr --log-level=0 \
  --domicile-broker-socket="$BROKER" >"$ENGINE_LOG" 2>&1 &
STARTED+=($!)

TRIES=$((FOR_SECONDS * 4))
wait_for_line "$TRIES" "GUARD shell-loaded" "$ENGINE_LOG" || {
  annotate_from "guard-webview-sign-in-with: the shell page never ran, so nothing here was ever set up" "$ENGINE_LOG"
  echo "the engine said:" >&2
  tail -40 "$ENGINE_LOG" >&2
  exit 1
}
echo "the shell is up, with a <webview> under a ${STRIP_HEIGHT}px strip"

# 3. The page's last report: the dismissal comes after the rest.
wait_for_line "$TRIES" "${REPORT_LINE}step=dismissed" "$HTTP_LOG" ||
  echo "the page never reported its dismissal" >&2

saw() { # $1 pattern, $2 log
  grep -qF -- "$1" "$2" && echo 1 || echo 0
}

# The shell's line for the first step that asked with the accounts.
ASKED="$(grep -F "GUARD identity step=accounts" "$ENGINE_LOG" | head -1)"

SAW_SHELL=$(saw "GUARD shell-loaded" "$ENGINE_LOG")
SAW_PAGE=$(saw "$REPORT_LINE" "$HTTP_LOG")
SAW_ASKED=$([ -n "$ASKED" ] && echo 1 || echo 0)
SAW_DETAILS=$(case "$ASKED" in
  *"site=127.0.0.1"*"provider=127.0.0.1"*"account=Guard Tester"*"shared="*email*)
    echo 1 ;;
  *) echo 0 ;;
  esac)
SAW_TOKEN=$(saw "${REPORT_LINE}step=chosen token=guard-token" "$HTTP_LOG")
# The engine's withdrawal, not Blink's: the element also withdraws a step it
# holds when the next arrives. Only one after the second accounts step and
# before the third is the navigation's: a step between the first two
# (verifying, say) is withdrawn too.
SAW_WITHDRAWN=$(awk '
  /asking the shell to show its .*kAccounts/ { asks++ }
  /sign-in step was withdrawn/ && asks == 2 { found = 1 }
  END { print found + 0 }
' "$ENGINE_LOG")
# Rejected after the shell dismissed, not for some reason of its own.
SAW_REJECTED=$(grep -qF "GUARD identity dismissing" "$ENGINE_LOG" &&
  grep -F "${REPORT_LINE}step=dismissed" "$HTTP_LOG" |
  grep -qvF "error=none" && echo 1 || echo 0)

echo
grep -F "GUARD identity" "$ENGINE_LOG" || true
grep -F "$REPORT_LINE" "$HTTP_LOG" || true
echo "shell=$SAW_SHELL page=$SAW_PAGE asked=$SAW_ASKED details=$SAW_DETAILS"
echo "token=$SAW_TOKEN withdrawn=$SAW_WITHDRAWN rejected=$SAW_REJECTED"
echo

# The verdict: names the component to blame. Checks run in dependency order.
# `packages/domicile-engine/tests/test-webview-sign-in-with-guard.sh` runs this block directly.
FAILURE=""
PASSED=""
if [ "$SAW_SHELL" != "1" ]; then
  FAILURE="the shell page never ran, so nothing here was set up. This is the \
harness: the module did not load, or it threw, and the engine log has its \
console"
elif [ "$SAW_PAGE" != "1" ]; then
  FAILURE="the page never reported. That is the guest: it was not made, \
attached or navigated, or the page's script never ran"
elif [ "$SAW_ASKED" != "1" ]; then
  FAILURE="the shell was never asked with the accounts. Either FedCM is off \
in the page (domicile_chrome_dialogs.cc must not disable it), \
CreateIdentityRequestDialogController does not make MakeIdentityDialog \
(patch 0210), or the guest did not send IdentityRequested to the element"
elif [ "$SAW_DETAILS" != "1" ]; then
  FAILURE="the shell was asked, but without the site, the provider, its \
account or what signing in shares. IdentityDialog::ShowAccountsDialog filled \
the request wrong, or DomicileIdentityEvent reads it wrong"
elif [ "$SAW_TOKEN" != "1" ]; then
  FAILURE="the shell chose the account, but the page never got the \
provider's token. IdentityDialog did not run on_selected with that account, \
or DomicileIdentityEvent.choose did not answer kChoose"
elif [ "$SAW_WITHDRAWN" != "1" ]; then
  FAILURE="navigating away while the shell showed the accounts never \
withdrew them. ~IdentityDialog did not withdraw its open step, or the guest \
did not send IdentityWithdrawn"
elif [ "$SAW_REJECTED" != "1" ]; then
  FAILURE="the shell never dismissed the accounts on the next page, or it \
did and the page's request was not rejected. Either the shell was never asked \
there, or IdentityDialog did not run the dismiss callback for kDismiss"
else
  PASSED="a page in a <webview> signs in with an identity provider through \
the shell: the shell is asked with the account, choosing it signs in, \
leaving withdraws it and dismissing rejects the request"
fi

if [ -n "$PASSED" ]; then
  echo "PASS: $PASSED"
  exit 0
fi

annotate "guard-webview-sign-in-with: $FAILURE"
echo "the engine's last words:" >&2
last_words "$ENGINE_LOG" >&2
echo "the server said:" >&2
tail -20 "$HTTP_LOG" >&2
exit 1
