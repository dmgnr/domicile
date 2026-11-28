#!/usr/bin/env bash
# Chromium history suggestions stay in the browser window's profile.
set -euo pipefail

SCRIPTS="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPTS/lib-annotate.sh"

CHROME="${1:?pass chromium/src}/${OUT:-out/Domicile}/chrome"
[[ -x "$CHROME" ]] || { annotate "omnibox guard: no engine at $CHROME"; exit 1; }
command -v python3 >/dev/null || { skip "omnibox guard needs python3"; exit 77; }

scratch="$(mktemp -d)"
pids=()
cleanup() {
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  for pid in "${pids[@]}"; do wait "$pid" 2>/dev/null || true; done
  rm -rf -- "$scratch"
}
trap cleanup EXIT

fixture=domicile-omnibox-profile-fixture.html
mkdir "$scratch/web"
printf '<title>%s</title>\n' "$fixture" >"$scratch/web/$fixture"
python3 -u -m http.server 0 --bind 127.0.0.1 --directory "$scratch/web" \
  >"$scratch/http.log" 2>&1 &
pids+=("$!")
python3 "$SCRIPTS/guard-extension-installer-compositor.py" \
  --socket "$scratch/control" \
  --browser-profiles '{"profiles":[{"id":"default","name":"Default","color":"#0d9488","private":false,"extensions":null},{"id":"work","name":"Work","color":"#d97706","private":false,"extensions":null},{"id":"private","name":"Private","color":"#a78bfa","private":true,"extensions":null}],"default_profile":"default","default_private_profile":"private","sites":{}}' \
  >"$scratch/control.log" 2>&1 &
pids+=("$!")

port=
for _ in {1..100}; do
  port="$(sed -n 's/.* port \([0-9][0-9]*\) .*/\1/p' "$scratch/http.log")"
  if [[ -n "$port" && -S "$scratch/control" ]]; then break; fi
  sleep 0.1
done
[[ -n "$port" && -S "$scratch/control" ]] || {
  annotate "omnibox guard: fixture or compositor stand-in did not start"
  exit 1
}

"$CHROME" --ozone-platform=headless --disable-gpu --window-size=800,600 \
  --app="domicile://shell/?visit=http%3A%2F%2F127.0.0.1%3A$port%2F$fixture" \
  --domicile-shell-root="$SCRIPTS" --domicile-shell-module=guard-omnibox-profile.js \
  --domicile-control-socket="$scratch/control" --domicile-broker-socket="$scratch/broker" \
  --no-sandbox --password-store=basic --no-first-run --disable-component-update \
  --user-data-dir="$scratch/profile" --enable-logging=stderr >"$scratch/engine.log" 2>&1 &
pids+=("$!")
for _ in {1..300}; do
  if grep -q 'OMNIBOX_GUARD passed' "$scratch/engine.log"; then exit 0; fi
  if grep -q 'OMNIBOX_GUARD failed' "$scratch/engine.log"; then break; fi
  sleep 0.1
done
annotate_from "omnibox guard: no passing profile-isolation verdict" "$scratch/engine.log"
exit 1
