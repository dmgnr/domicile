#!/usr/bin/env bash
# Checks that the extensions the desk installs survive a restart, data and
# all, and stay on.
#
# - At every start Chrome uninstalls each extension at an external location
#   that no external provider lists (ExternalProviderManager's
#   CheckExternalUninstall), and the desk's config is no provider.
# - At every load Chrome switches off a `kInternal` extension whose active
#   permissions exceed its granted ones (DISABLE_PERMISSIONS_INCREASE). A
#   Web Store install with no prompt grants none, so the desk grants them, and
#   every switch-on grants them as chrome://extensions does.
#
# Reads the sources, not a Chromium tree, so it runs in the shell group.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SRC="$ROOT/packages/domicile-engine/src/chrome/browser/domicile"
[ -d "$SRC" ] || { echo "no engine sources at $SRC" >&2; exit 1; }

FAILED=0
ok()   { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n    %s\n' "$1" "$2"; FAILED=$((FAILED + 1)); }

for file in domicile_extension_installer.cc domicile_browser_profiles.cc; do
  if ! grep -q 'AddFromExternalUpdateUrl' "$SRC/$file"; then
    fail "$file installs from the Web Store" "no AddFromExternalUpdateUrl in it"
  elif grep -q 'ManifestLocation::kExternal' "$SRC/$file"; then
    fail "$file installs at a location Chrome keeps" \
      "it installs at an external location, which Chrome uninstalls at the next start"
  elif grep -q 'ManifestLocation::kInternal' "$SRC/$file"; then
    ok "$file installs at a location Chrome keeps"
  else
    fail "$file installs at a location Chrome keeps" "it names no kInternal location"
  fi
done

if grep -q 'GrantActivePermissions' "$SRC/domicile_extension_installer.cc"; then
  ok "the installer grants the permissions of what it installs"
else
  fail "the installer grants the permissions of what it installs" \
    "no GrantActivePermissions in domicile_extension_installer.cc"
fi

if grep -q 'GrantPermissionsOf' "$SRC/domicile_browser_profiles.cc"; then
  ok "browser profiles grant the permissions of what they install"
else
  fail "browser profiles grant the permissions of what they install" \
    "domicile_browser_profiles.cc never calls GrantPermissionsOf"
fi

for file in domicile_extension_installer.cc domicile_browser_profiles.cc; do
  if grep -q -- '->EnableExtension(' "$SRC/$file"; then
    fail "$file grants permissions when it switches an extension on" \
      "it calls EnableExtension, which leaves the extension to switch off at the next start"
  else
    ok "$file grants permissions when it switches an extension on"
  fi
done

if [ "$FAILED" -gt 0 ]; then
  echo "$FAILED failed"
  exit 1
fi
echo "all ok"
