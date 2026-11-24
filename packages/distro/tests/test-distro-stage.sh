#!/usr/bin/env bash
# Tests `packages/distro/stage.sh`, which lays out the tree every distribution package
# is made from.
#
# `domicile` finds its parts from its own path (`../libexec/domicile`), so a
# file in the wrong place fails only when a desktop starts. This runs the
# script against stand-in inputs and checks each part is where `domicile`, the
# display manager, systemd and the portal look.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
STAGE_SH="$ROOT/packages/distro/stage.sh"
[ -x "$STAGE_SH" ] || { echo "no $STAGE_SH" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FAILED=0
ok() { printf '  ok    %s\n' "$1"; }
fail() {
  printf '  FAIL  %s\n    %s\n' "$1" "$2"
  FAILED=$((FAILED + 1))
}
expect() { # what, want, got
  if [ "$3" = "$2" ]; then
    ok "$1"
  else
    fail "$1" "wanted: $(printf '%q' "$2")  got: $(printf '%q' "$3")"
  fi
}
holds_line() { # what, file, line
  if [ -f "$2" ] && grep -qxF "$3" "$2"; then
    ok "$1"
  else
    fail "$1" "$2 has no line: $3"
  fi
}

# The binaries `flake.nix` copies into `bin/`, so the two packagings cannot
# drift apart.
FLAKE_BINARIES="$(grep -o 'cp ${domicileBinaries}/bin/[a-z-]*' "$ROOT/flake.nix" |
  sed 's|.*/bin/||' | sort -u)"

# ---- stand-in inputs -------------------------------------------------------

BINARIES="$WORK/binaries"
mkdir -p "$BINARIES"
for binary in $FLAKE_BINARIES; do
  printf '#!/bin/sh\necho %s\n' "$binary" >"$BINARIES/$binary"
  chmod +x "$BINARIES/$binary"
done
# `help --man <dir>` writes the man pages, as the real one does.
cat >"$BINARIES/domicile" <<'STUB'
#!/bin/sh
if [ "$1 $2" = "help --man" ]; then
  mkdir -p "$3" && echo '.TH DOMICILE 1' >"$3/domicile.1"
fi
STUB

ENGINE="$WORK/engine"
mkdir -p "$ENGINE/locales"
touch "$ENGINE/chrome" "$ENGINE/libdomicile_engine.so" "$ENGINE/locales/en-US.pak"
chmod +x "$ENGINE/chrome"

# stage.sh installs the workspace's modules with the bun it ships.
BUN="$(command -v bun)" || { echo "SKIP: no bun to install the workspace with"; exit 77; }

# A bun workspace shaped like this repository's, installable offline: its
# third-party packages are tarballs named by absolute path, which the staged
# copy's lockfile finds too.
WORKSPACE="$WORK/workspace"
VENDOR="$WORK/vendor"
put() { # file, text
  mkdir -p "$(dirname "$1")"
  printf '%s\n' "$2" >"$1"
}
# A workspace package's manifest: its name, then `fields`.
manifest() { # package, fields
  put "$WORKSPACE/packages/$1/package.json" \
    "{\"name\":\"@domicile-desktop/$1\",\"version\":\"0.0.0\"${2:-}}"
}
# Packs `$VENDOR/<name>/package` into `$VENDOR/<name>.tgz`.
vendor() { # name
  put "$VENDOR/$1/package/package.json" "{\"name\":\"$1\",\"version\":\"1.0.0\"}"
  put "$VENDOR/$1/package/index.js" "$1"
  tar -C "$VENDOR/$1" -czf "$VENDOR/$1.tgz" package
}
put "$WORKSPACE/package.json" '{"name":"stand-in","private":true,"workspaces":["packages/*"]}'
put "$WORKSPACE/bunfig.toml" '[install]'
put "$VENDOR/vite/package/index.js.map" '{}'
put "$VENDOR/vite/package/README.md" vite
put "$VENDOR/vite/package/LICENSE" MIT
vendor vite
vendor typescript
vendor lightningcss-linux-x64-musl

manifest domicile-builder ",\"files\":[\"src/**\",\"!src/**/*.test.ts\"],
  \"dependencies\":{\"@domicile-desktop/sdk\":\"workspace:*\",\"vite\":\"$VENDOR/vite.tgz\",
    \"lightningcss-linux-x64-musl\":\"$VENDOR/lightningcss-linux-x64-musl.tgz\"},
  \"devDependencies\":{\"@domicile-desktop/test-support\":\"workspace:*\",\"typescript\":\"$VENDOR/typescript.tgz\"}"
# Prints its arguments, so the builder's command line can be read back.
put "$WORKSPACE/packages/domicile-builder/src/main.ts" 'console.log(process.argv.slice(1).join(" "));'
put "$WORKSPACE/packages/domicile-builder/src/main.test.ts" test
manifest sdk ',"files":["dist/**"]'
put "$WORKSPACE/packages/sdk/src/index.ts" sdk
put "$WORKSPACE/packages/sdk/dist/index.js" sdk
manifest test-support
put "$WORKSPACE/packages/test-support/src/preload.ts" test-support
manifest shell-manganese ',"files":["src/**"],"dependencies":{"@domicile-desktop/sdk":"workspace:*"}'
put "$WORKSPACE/packages/shell-manganese/src/index.tsx" manganese
manifest electron-host ',"files":["src/**","!src/**/*.test.ts"]'
put "$WORKSPACE/packages/electron-host/src/main.ts" 'console.log(process.argv.slice(1).join(" "));'
put "$WORKSPACE/packages/electron-host/src/main.test.ts" test
for shell in manganese simple splash; do
  [ -f "$WORKSPACE/packages/shell-$shell/package.json" ] || manifest "shell-$shell"
  put "$WORKSPACE/packages/shell-$shell/.vite/renderer/main_window/shell.js" "$shell"
done
for app in history settings; do
  manifest "app-$app"
  put "$WORKSPACE/packages/app-$app/icons/$app.svg" "$app"
  put "$WORKSPACE/packages/app-$app/icons/$app-preview.svg" "$app"
done
put "$WORKSPACE/packages/app-history/.vite/app/history.js" 'export const main = () => {};'
put "$WORKSPACE/packages/app-settings/.vite/app/settings.js" 'export const main = () => {};'
# The distribution package's manifest, whose version `--version` prints.
put "$WORKSPACE/packages/domicile/package.json" '{"name":"domicile","private":true,"version":"0.0.0"}'
# A crate: no `package.json`, so not part of the workspace.
put "$WORKSPACE/packages/domicile-launch/Cargo.toml" ''
# As `packages/distro/build.sh` installs before it builds.
(cd "$WORKSPACE" && "$BUN" install --ignore-scripts --no-progress >/dev/null 2>&1) || {
  echo "the stand-in workspace would not install" >&2
  exit 1
}

# ---- a complete stage ------------------------------------------------------

STAGE="$WORK/stage"
REV=0123456789abcdef0123456789abcdef01234567
echo "a stage from complete inputs"
if out="$("$STAGE_SH" "$BINARIES" "$ENGINE" "$BUN" "$WORKSPACE" "$REV" "$STAGE" 2>&1)"; then
  ok "stage.sh succeeds"
else
  fail "stage.sh succeeds" "$out"
fi

USR="$STAGE/usr"
LIBEXEC="$USR/libexec/domicile"

echo "domicile finds its parts beside itself"
for binary in $FLAKE_BINARIES; do
  if [ -x "$USR/bin/$binary" ] && [ ! -L "$USR/bin/$binary" ]; then
    ok "bin/$binary is a copy, as in the flake"
  else
    fail "bin/$binary is a copy, as in the flake" \
      "missing or a symlink; \`current_exe\` would not find libexec beside it"
  fi
done
expect "bin holds only what the flake installs" "$FLAKE_BINARIES" \
  "$(ls "$USR/bin" | sort)"
[ -x "$LIBEXEC/engine/chrome" ] && [ -f "$LIBEXEC/engine/locales/en-US.pak" ] &&
  ok "the engine is libexec/domicile/engine, as unpacked" ||
  fail "the engine is libexec/domicile/engine, as unpacked" \
    "$(ls -R "$LIBEXEC/engine" 2>&1)"
[ -f "$USR/share/man/man1/domicile.1" ] &&
  ok "the man pages are in share/man/man1" ||
  fail "the man pages are in share/man/man1" "no $USR/share/man/man1/domicile.1"
expect "libexec/domicile/version names the version and commit" \
  "$(printf 'domicile 0.0.0\ncommit   %s' "$REV")" "$(cat "$LIBEXEC/version" 2>&1)"
for shell in manganese simple splash; do
  [ -f "$LIBEXEC/shells/$shell/shell.js" ] &&
    ok "the $shell shell is prebuilt" ||
    fail "the $shell shell is prebuilt" "no $LIBEXEC/shells/$shell/shell.js"
done
for module in settings history; do
  [ -f "$LIBEXEC/app-modules/$module/$module.js" ] &&
    ok "the $module app module is installed" ||
    fail "the $module app module is installed" "no $LIBEXEC/app-modules/$module/$module.js"
  [ ! -e "$LIBEXEC/apps/$module" ] &&
    ok "the $module app is not installed as an extension" ||
    fail "the $module app is not installed as an extension" "$LIBEXEC/apps/$module exists"
done

echo "the builder runs the bundled bun against the bundled workspace"
expect "the builder's command line" \
  "$LIBEXEC/workspace/packages/domicile-builder/src/main.ts --domicile $LIBEXEC/workspace --entry desk.tsx" \
  "$("$LIBEXEC/builder" --entry desk.tsx 2>&1)"
echo "electron-host runs the bundled bun against the bundled workspace"
expect "electron-host's command line" \
  "$LIBEXEC/workspace/packages/electron-host/src/main.ts /opt/Slack/resources -u" \
  "$("$LIBEXEC/electron-host" /opt/Slack/resources -u 2>&1)"
SHIPPED="$LIBEXEC/workspace/packages"
present() { # what, file under the shipped packages
  [ -f "$SHIPPED/$2" ] && ok "$1" || fail "$1" "no $SHIPPED/$2"
}
absent() { # what, path under the shipped packages
  [ ! -e "$SHIPPED/$2" ] && [ ! -L "$SHIPPED/$2" ] && ok "$1" || fail "$1" "$SHIPPED/$2 was shipped"
}
present "the packages manganese uses" shell-manganese/node_modules/@domicile-desktop/sdk/dist/index.js
present "and the builder's production dependencies" domicile-builder/node_modules/vite/index.js
present "with their licenses" domicile-builder/node_modules/vite/LICENSE
absent "without its development dependencies" domicile-builder/node_modules/typescript
absent "or the musl builds of native modules" domicile-builder/node_modules/lightningcss-linux-x64-musl
absent "or the workspace packages only they use" test-support/src
absent "only the files a package publishes" sdk/src
absent "without tests" domicile-builder/src/main.test.ts
absent "without electron-host's tests" electron-host/src/main.test.ts
absent "without the shells' builds" shell-manganese/.vite
absent "without the crates" domicile-launch
expect "without source maps or readmes" "" \
  "$(find "$LIBEXEC/workspace" -name '*.map' -o -name 'README*')"
expect "every package carries the commit's version" "0.0.0-alpha-0123456789ab" \
  "$(jq -r .version "$SHIPPED"/*/package.json | sort -u)"

echo "a release ships the versions the workspace holds"
if out="$(DOMICILE_RELEASE=1 "$STAGE_SH" "$BINARIES" "$ENGINE" "$BUN" "$WORKSPACE" "$REV" "$WORK/release" 2>&1)"; then
  expect "every package carries its own version" 0.0.0 \
    "$(jq -r .version "$WORK/release/usr/libexec/domicile/workspace/packages"/*/package.json | sort -u)"
else
  fail "stage.sh succeeds for a release" "$out"
fi

echo "the session and what it starts"
SESSION="$USR/share/wayland-sessions/domicile.desktop"
holds_line "the session runs domicile" "$SESSION" "Exec=/usr/bin/domicile"
holds_line "the session names the desktop" "$SESSION" "DesktopNames=domicile"
MIRACAST="$USR/lib/systemd/user/domicile-miracast.service"
holds_line "D-Bus starts Miracast as a unit" "$USR/share/dbus-1/services/net.domicile.Miracast.service" \
  "SystemdService=domicile-miracast.service"
holds_line "the Miracast unit runs domicile-miracast" "$MIRACAST" "ExecStart=/usr/bin/domicile-miracast"
holds_line "the Miracast unit ends with the desk" "$MIRACAST" "PartOf=graphical-session.target"
for unit in domicile-session.target domicile-session-shutdown.target; do
  cmp -s "$ROOT/packages/distro/share/$unit" "$USR/lib/systemd/user/$unit" &&
    ok "$unit is the flake's" ||
    fail "$unit is the flake's" "missing or different"
done
cmp -s "$ROOT/packages/distro/share/domicile.portal" "$USR/share/xdg-desktop-portal/portals/domicile.portal" &&
  ok "domicile.portal is the flake's" ||
  fail "domicile.portal is the flake's" "missing or different"
cmp -s "$ROOT/packages/distro/share/domicile-portals.conf" "$USR/share/xdg-desktop-portal/domicile-portals.conf" &&
  ok "domicile-portals.conf is the flake's" ||
  fail "domicile-portals.conf is the flake's" "missing or different"
holds_line "the domicile group is declared" "$USR/lib/sysusers.d/domicile.conf" \
  "g domicile -"

echo "links open on the desktop"
holds_line "the link handler runs domicile-open-url" \
  "$USR/share/applications/domicile-open-url.desktop" "Exec=/usr/bin/domicile-open-url %u"
holds_line "and is the default for https" \
  "$USR/share/applications/domicile-mimeapps.list" \
  "x-scheme-handler/https=domicile-open-url.desktop"
holds_line "and for PDFs" \
  "$USR/share/applications/domicile-mimeapps.list" \
  "application/pdf=domicile-open-url.desktop"

echo "the launcher's entries"
for entry in history settings screenshot screen-record shutdown reboot logout; do
  file="$USR/share/applications/domicile-$entry.desktop"
  icon="$(sed -n 's/^Icon=//p' "$file" 2>/dev/null)"
  preview="$(sed -n 's/^X-Domicile-Preview=//p' "$file" 2>/dev/null)"
  if [ -n "$icon" ] && [ -f "$STAGE$icon" ] && [ -n "$preview" ] && [ -f "$STAGE$preview" ]; then
    ok "domicile-$entry.desktop names icons the package holds"
  else
    fail "domicile-$entry.desktop names icons the package holds" \
      "Icon=$icon X-Domicile-Preview=$preview"
  fi
done
holds_line "Screenshot runs domicile screenshot" \
  "$USR/share/applications/domicile-screenshot.desktop" "Exec=/usr/bin/domicile screenshot"
holds_line "Screen Record runs domicile screen-record" \
  "$USR/share/applications/domicile-screen-record.desktop" "Exec=/usr/bin/domicile screen-record"
holds_line "Shutdown runs domicile power-off" \
  "$USR/share/applications/domicile-shutdown.desktop" "Exec=/usr/bin/domicile power-off"
holds_line "Reboot runs domicile reboot" \
  "$USR/share/applications/domicile-reboot.desktop" "Exec=/usr/bin/domicile reboot"
holds_line "Logout runs domicile log-out" \
  "$USR/share/applications/domicile-logout.desktop" "Exec=/usr/bin/domicile log-out"

left="$(grep -rlE '@[a-z]+@' "$USR/share" 2>/dev/null)"
expect "no placeholder is left unfilled" "" "$left"

# ---- incomplete inputs -----------------------------------------------------

echo "incomplete inputs are refused"
refused() { # what, needle, stage.sh arguments...
  local what="$1" needle="$2" out; shift 2
  rm -rf "$WORK/refused"
  if out="$("$STAGE_SH" "$@" "$WORK/refused" 2>&1)"; then
    fail "$what" "stage.sh succeeded"
  else
    case "$out" in
      (*"$needle"*) ok "$what" ;;
      (*) fail "$what" "the refusal does not name $needle: $out" ;;
    esac
  fi
}

mv "$BINARIES/domicile-app-host" "$WORK/held"
refused "a missing binary is named" domicile-app-host \
  "$BINARIES" "$ENGINE" "$BUN" "$WORKSPACE" "$REV"
mv "$WORK/held" "$BINARIES/domicile-app-host"

rm "$ENGINE/libdomicile_engine.so"
refused "an engine without its library is named" libdomicile_engine.so \
  "$BINARIES" "$ENGINE" "$BUN" "$WORKSPACE" "$REV"

if [ "$FAILED" -gt 0 ]; then
  echo "$FAILED failed"
  exit 1
fi
echo "all ok"
