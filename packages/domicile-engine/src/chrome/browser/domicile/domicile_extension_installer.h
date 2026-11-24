// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef CHROME_BROWSER_DOMICILE_DOMICILE_EXTENSION_INSTALLER_H_
#define CHROME_BROWSER_DOMICILE_DOMICILE_EXTENSION_INSTALLER_H_

#include <string>
#include <vector>

#include "base/functional/callback.h"
#include "base/memory/weak_ptr.h"
#include "base/types/expected.h"
#include "components/domicile/browser/command_protocol.h"
#include "components/domicile/browser/extension_installer.h"

class PrefChangeRegistrar;
class PrefRegistrySimple;
class Profile;

namespace base {
class FilePath;
}

namespace extensions {
class Extension;
}

namespace domicile {

// Registers the pref of extension ids `InstallExtensionsInto` added, so it
// only uninstalls extensions it installed, the settings it set
// (domicile_extension_settings.h), and the sites the user pinned to a browser
// profile (domicile_browser_profiles.h): the desk's profile prefs.
void RegisterExtensionInstallerPrefs(PrefRegistrySimple* registry);

// Grants `extension` its active permissions in `profile`, as the Web Store's
// prompt does, and lifts DISABLE_PERMISSIONS_INCREASE.
//
// A Web Store install with no prompt grants nothing, so Chrome switches it
// off at every start. Call only where consent exists: the config's
// extensions, and ones mirrored from a profile where the user installed them.
void GrantPermissionsOf(Profile& profile,
                        const extensions::Extension& extension);

// Takes every extension the desk's config names, for the shell in `shell`:
// resolves their directories, then has BrowserProfileRegistry install into
// each browser profile the ones it turns on.
//
// Must be called on the UI thread. `shell` is weak because the request comes
// from the IO thread and the profile may be gone at shutdown.
void InstallExtensionsInto(base::WeakPtr<Profile> shell,
                           const ExtensionList& wanted);

// Installs the extensions in `wanted`, its directories resolved, into
// `profile` and uninstalls ones it added earlier that `wanted` no longer
// lists. Web Store ids install from the Store; directories load unpacked. Then
// sets `wanted.settings` (ApplyConfigSettings). There is no prompt: the config
// is the consent. Waits for the profile's extension system first. The diffs
// are `ReconcileExtensions` and `ReconcileSettings`, which have the tests.
void ReconcileConfigExtensions(base::WeakPtr<Profile> profile,
                               ExtensionList wanted);

// Loads the unpacked extension in `directory` into `profile` for the Settings
// app. The config did not add it, so reconciling leaves it, and it stays until
// uninstalled. Runs `loaded` with its id, or why it did not load.
void LoadUnpackedInto(
    Profile& profile,
    const base::FilePath& directory,
    base::OnceCallback<void(base::expected<std::string, std::string>)> loaded);

// Uninstalls extension `id` from `profile` as the user would. Refuses one the
// config added: reconciling would install it again.
base::expected<void, std::string> UninstallFrom(Profile& profile,
                                                const std::string& id);

// The ids of the extensions the config added to `profile`.
std::vector<std::string> ConfigExtensionsOf(Profile& profile);

// Calls `changed` whenever the config's extensions, or the settings it sets
// on them, change.
void WatchConfigExtensions(PrefChangeRegistrar& registrar,
                           const base::RepeatingClosure& changed);

// Every extension in `profile`, for the Settings app: no apps, themes or
// Chrome's own components, as `chrome.management` lists them.
std::vector<InstalledExtension> ExtensionsOf(Profile& profile);

// Switches extension `id` in `profile` on or off, as its user would, or says
// why not: one not installed, or one the config switches in the browser
// profile `profile` is (BrowserProfileRegistry::IsSwitchLocked).
base::expected<void, std::string> SetExtensionEnabledIn(Profile& profile,
                                                        const std::string& id,
                                                        bool enabled);

}  // namespace domicile

#endif  // CHROME_BROWSER_DOMICILE_DOMICILE_EXTENSION_INSTALLER_H_
