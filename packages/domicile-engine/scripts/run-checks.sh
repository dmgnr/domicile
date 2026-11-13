#!/usr/bin/env bash
# Runs the engine's checks against a built tree: its unit tests, the
# compositor build against it, and every guard with its control.
#
#   nix develop .#full -c packages/domicile-engine/scripts/run-checks.sh
#   nix develop .#full -c packages/domicile-engine/scripts/run-checks.sh guard-client-window
#
# With no argument it runs every check and reports each, as `test:engine`.
# With a check's name it runs only that check and reports nothing.
#
# Every check uses the one Chromium tree on `crux`, so the cheap checks run
# first and a failure stops the expensive guards. A missing tree is a skip;
# see `lib-engine-guard.sh` for which build a check runs against. See
# docs/TESTING.md and docs/GUARDS.md.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SCRIPTS="$ROOT/packages/domicile-engine/scripts"

# Run one at a time, before the rest.
FIRST=(
  build-produced-what-the-guards-load
  locales-are-trimmed
  unit-tests
  drm-unit-tests
  build-the-compositor
  guard-shortcuts-inhibitor
  guard-client-window
  guard-client-window-in-memory
  guard-two-windows
  guard-buffer-transform
  guard-scrolling-bubble
  guard-webview-permissions
  guard-app-survives-load-shell
  guard-app-survives-compositor-restart
  guard-shell
  guard-shell-manganese
  guard-shell-shortcuts
)

# Run together: they are headless and share no card, port, broker, profile or
# log. At most `CHECKS_AT_ONCE` at a time.
TOGETHER=(
  guard-webview-framing
  guard-shell-local-network
  guard-webview-notifications
  guard-notification-server-late
  guard-notification-window
  guard-shell-web-apis
  guard-display-capture
  guard-headless-desk
  guard-webview-content-script
  guard-extension-installer
  guard-extension-in-private
  guard-extension-tray
  guard-extension-open-popup
  guard-extension-side-panel
  guard-webview-keyboard
  guard-webview-escape
  guard-webview-browser-page
  guard-webview-history
  guard-webview-history-new-window
  guard-webview-untrusted-cert
  guard-webview-find
  guard-webview-click
  guard-webview-activate
  guard-webview-new-window
  guard-webview-window-open
  guard-webview-private
  guard-webview-partition
  guard-webview-will-navigate
  guard-webview-app-window
  guard-app-window-reuse
  guard-webview-routed-link
  guard-webview-target-url
  guard-webview-tooltip
  guard-webview-fullscreen
  guard-webview-wake-lock
  guard-webview-device-request
  guard-webview-media-devices
  guard-webview-count-matches
  guard-webview-dialog
  guard-webview-beforeunload
  guard-webview-external-app
  guard-webview-sign-in
  guard-webview-file-access
  guard-webview-page-failure
  guard-webview-resend-form
  guard-webview-page-picker
  guard-webview-chrome-sheets
  guard-webview-sign-in-with
  guard-webview-print
  guard-webview-context-menu
  guard-webview-upload
  guard-webview-download
  guard-webview-save-picker
  guard-webview-tabs
  guard-webview-active-tab
  guard-webview-popup-window
  guard-webview-passkey-extension
  guard-webview-survives-load-shell
  guard-webview-hidden
  guard-webview-moved
  guard-webview-paused
  guard-animation-main-frames
  guard-webview-crash
  guard-desktop-geometry
  guard-windows-state
  guard-desk-state
  guard-held-moments
  guard-asks-promise
  guard-portal-requests
  guard-shortcut-chords
  guard-app-routes-input
  guard-shell-handover
  guard-shell-script-src
  guard-shell-crash
  guard-app-only-in-shell
  guard-domicile-fetch
  guard-shell-pdf
  guard-app-module
  guard-video-codecs
  guard-browser-brand
)

# Run one at a time, after the rest. Latency measures time, so it runs alone.
# The chord runs last: it can fail because of the host compositor, not the
# build, and that should not stop the other guards.
LAST=(
  guard-css-and-resize
  guard-latency
  guard-shortcuts-inhibitor-chord
)

# Guards with no control run.
ONCE=(
  guard-app-only-in-shell
  guard-asks-promise
  guard-browser-brand
  guard-desk-state
  guard-desktop-geometry
  guard-domicile-fetch
  guard-held-moments
  guard-portal-requests
  guard-shell-handover
  guard-shell-pdf
  guard-shell-script-src
  guard-shortcut-chords
  guard-video-codecs
  guard-windows-state
)

# Guards that read a client's pixels, so they run under a headless wlroots
# compositor: `--ozone-platform=headless` cannot import a dmabuf.
UNDER_WAYLAND=(
  guard-app-survives-compositor-restart
  guard-app-survives-load-shell
  guard-buffer-transform
  guard-client-window
  guard-scrolling-bubble
  guard-shell
  guard-shortcuts-inhibitor
  guard-shortcuts-inhibitor-chord
  guard-two-windows
  guard-webview-permissions
)

# Each check's timeout. The budget is a cold cargo build's.
ENGINE_CHECK_TIMEOUT="${DOMICILE_ENGINE_CHECK_TIMEOUT:-1800}"

# How many of TOGETHER run at once. Each starts a browser or two, and `crux`
# runs two engine jobs: all of them at once starve the browsers of CPU and
# memory until they miss their guards' deadlines. Half the cores, so both
# jobs' batches together fill the machine.
CHECKS_AT_ONCE="${DOMICILE_ENGINE_CHECKS_AT_ONCE:-$(( $(nproc) / 2 > 0 ? $(nproc) / 2 : 1 ))}"

main() {
  if [ "$#" -gt 0 ]; then
    one "$@"
  else
    every
  fi
}

# Runs one check in this process, unreported.
one() { # name, args...
  local name="$1"; shift
  case "$name" in
    build-produced-what-the-guards-load|unit-tests|drm-unit-tests|build-the-compositor)
      exec "$SCRIPTS/$name.sh" "$@" ;;
    guard-css-and-resize) exec "$SCRIPTS/check-css-and-resize.sh" ;;
    guard-latency) exec "$SCRIPTS/check-latency.sh" ;;
  esac
  listed "$name" "${FIRST[@]}" "${TOGETHER[@]}" "${LAST[@]}" || {
    echo "run-checks: no check named '$name'" >&2
    exit 2
  }
  . "$SCRIPTS/lib-engine-guard.sh"
  require_engine_out
  case "$name" in
    guard-client-window-in-memory)
      SOFTWARE=1 engine_guard_and_control_under_wayland guard-client-window.sh ;;
    guard-client-window-in-memory-on-headless)
      SOFTWARE=1 HEADLESS=1 engine_guard_and_control guard-client-window.sh ;;
    guard-shell-manganese)
      engine_guard_and_control_under_wayland guard-shell.sh manganese ;;
    *)
      if listed "$name" "${ONCE[@]}"; then
        engine_guard "$name.sh"
      elif listed "$name" "${UNDER_WAYLAND[@]}"; then
        engine_guard_and_control_under_wayland "$name.sh"
      else
        engine_guard_and_control "$name.sh"
      fi
      ;;
  esac
}

# Whether `name` is one of the rest of the arguments.
listed() { # name, names...
  local name="$1" each; shift
  for each in "$@"; do [ "$each" = "$name" ] && return 0; done
  return 1
}

# Runs every check in order and reports each, stopping at the first failure.
every() {
  . "$ROOT/packages/check-runner/src/report.sh"
  report_start
  # `engine-diagnostics.sh` prints every kept log, so keep only this run's.
  rm -rf "$KEEP_LOGS"; mkdir -p "$KEEP_LOGS"
  # A skip does not stop the run, so a machine with no tree reports every
  # check that did not run.
  serial "${FIRST[@]}" &&
    { together "${TOGETHER[@]}"; ! stop; } &&
    serial guard-css-and-resize &&
    run guard-latency "$0" guard-latency &&
    serial guard-shortcuts-inhibitor-chord
  report_end
}

# Runs checks one at a time as noise, stopping at the first failure.
serial() { # names...
  local name
  for name in "$@"; do
    run "$name" noisy "$name"
    stop && return 1
  done
  return 0
}

# Runs checks `CHECKS_AT_ONCE` at a time as noise, then prints their verdicts
# in order.
together() { # names...
  local dir name running=0; dir="$(mktemp -d)"
  for name in "$@"; do
    if [ "$running" -ge "$CHECKS_AT_ONCE" ]; then
      wait -n
      running=$((running - 1))
    fi
    ( noisy "$name" >"$dir/$name" 2>&1; echo $? >"$dir/$name.status" ) &
    running=$((running + 1))
  done
  wait
  for name in "$@"; do
    label "$name"
    verdict "$name" "$(cat "$dir/$name.status")" "$dir/$name"
  done
  rm -rf "$dir"
}

# Whether a failure means the rest should not run.
stop() {
  [ "${#FAILED[@]}" -eq 0 ] && return 1
  echo "  (stopping: the tree is one slot, and the rest would measure a build already known bad)"
}

# Runs one check, killed at `ENGINE_CHECK_TIMEOUT` with its whole process
# group.
#
# Every check but latency runs as noise, so another run's latency guard waits
# for it; latency is not noise, or it would wait for itself. Only when
# `CARD_OWNER` is set (engine.yml), since the lock registry lives on `crux`.
# The timeout runs inside the noise, so waiting for the card does not count.
noisy() { # name
  local status
  if [ -n "${CARD_OWNER:-}" ]; then
    "$ROOT/.github/scripts/engine-render-node-lock.sh" noisy "$CARD_OWNER" -- \
      timeout -k 30 "$ENGINE_CHECK_TIMEOUT" "$0" "$1"
  else
    timeout -k 30 "$ENGINE_CHECK_TIMEOUT" "$0" "$1"
  fi
  status=$?
  [ "$status" -ne 124 ] || echo "$1 ran past ${ENGINE_CHECK_TIMEOUT}s and was killed"
  return "$status"
}

main "$@"
