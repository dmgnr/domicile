// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "chrome/browser/domicile/domicile_extension_settings.h"

#include <memory>
#include <optional>
#include <set>
#include <string>
#include <utility>

#include "base/check.h"
#include "base/check_op.h"
#include "base/functional/bind.h"
#include "base/functional/callback_helpers.h"
#include "base/logging.h"
#include "base/memory/raw_ref.h"
#include "base/memory/scoped_refptr.h"
#include "base/memory/weak_ptr.h"
#include "base/scoped_observation.h"
#include "base/strings/strcat.h"
#include "base/supports_user_data.h"
#include "base/task/sequenced_task_runner.h"
#include "base/values.h"
#include "chrome/browser/extensions/extension_util.h"
#include "chrome/browser/profiles/profile.h"
#include "components/prefs/pref_change_registrar.h"
#include "components/prefs/pref_registry_simple.h"
#include "components/prefs/pref_service.h"
#include "extensions/browser/extension_prefs.h"
#include "extensions/browser/extension_registry.h"
#include "extensions/browser/extension_registry_observer.h"
#include "extensions/browser/extension_system.h"
#include "extensions/browser/extension_util.h"
#include "extensions/browser/permissions/scripting_permissions_modifier.h"
#include "extensions/browser/permissions_manager.h"
#include "extensions/browser/user_script_manager.h"
#include "extensions/common/extension.h"
#include "extensions/common/manifest.h"
#include "extensions/common/permissions/permission_set.h"
#include "extensions/common/permissions/permissions_data.h"
#include "extensions/common/url_pattern.h"

namespace domicile {
namespace {

// The settings the config last set, as ExtensionSettingsValue spells them, so
// a setting it drops goes back to Chrome's default and no other does.
constexpr char kConfigSettingsPref[] = "domicile.extensions.settings";

// The profile user data key for the InstallWatch.
constexpr char kInstallWatchKey[] = "domicile_extension_settings";

// The schemes a site in `site_access` covers, as chrome://extensions' "add a
// site" does.
constexpr int kSiteSchemes = URLPattern::SCHEME_HTTP | URLPattern::SCHEME_HTTPS;

bool CanUseFileAccess(const extensions::Extension& extension) {
  return extension.wants_file_access() ||
         extensions::Manifest::ShouldAlwaysAllowFileAccess(
             extension.location());
}

// Whether the user may choose `extension`'s site access: it asks for sites,
// and Chrome lets them be withheld. One that asks for activeTab alone has no
// sites to choose.
bool CanUseSiteAccess(Profile& profile,
                      const extensions::Extension& extension) {
  const extensions::PermissionsManager& permissions =
      *extensions::PermissionsManager::Get(&profile);
  return permissions.CanAffectExtension(extension) &&
         permissions.HasRequestedHostPermissions(extension);
}

extensions::UserScriptManager* UserScriptsOf(Profile& profile) {
  return extensions::ExtensionSystem::Get(&profile)->user_script_manager();
}

bool CanUseUserScripts(Profile& profile,
                       const extensions::Extension& extension) {
  return UserScriptsOf(profile) != nullptr &&
         extensions::UserScriptManager::IsUserScriptsAPIPermissionAvailable(
             extension);
}

// A granted host as the Settings app shows it: `*.host` where it covers the
// subdomains.
std::string SiteOf(const URLPattern& pattern) {
  return pattern.match_subdomains() ? base::StrCat({"*.", pattern.host()})
                                    : pattern.host();
}

// Where `extension` runs, as ExtensionInfoGenerator reads it for
// chrome://extensions. Sets `settings.sites` for kSpecificSites.
void ReadSiteAccess(Profile& profile,
                    const extensions::Extension& extension,
                    ExtensionSettings& settings) {
  if (!extensions::PermissionsManager::Get(&profile)
           ->HasWithheldHostPermissions(extension)) {
    settings.site_access = SiteAccess::kAllSites;
    return;
  }
  std::unique_ptr<const extensions::PermissionSet> granted =
      extensions::ExtensionPrefs::Get(&profile)->GetRuntimeGrantedPermissions(
          extension.id());
  if (granted == nullptr || granted->effective_hosts().is_empty()) {
    settings.site_access = SiteAccess::kOnClick;
    return;
  }
  if (granted->ShouldWarnAllHosts(/*include_api_permissions=*/false)) {
    settings.site_access = SiteAccess::kAllSites;
    return;
  }
  settings.site_access = SiteAccess::kSpecificSites;
  std::set<std::string> sites;
  for (const URLPattern& pattern : granted->effective_hosts()) {
    sites.insert(SiteOf(pattern));
  }
  settings.sites.assign(sites.begin(), sites.end());
}

// Why `extension` cannot take `settings`, or nothing.
std::optional<std::string> WhyNot(Profile& profile,
                                  const extensions::Extension& extension,
                                  const ExtensionSettings& settings) {
  if (settings.in_private.has_value() &&
      !extensions::util::CanBeIncognitoEnabled(&extension)) {
    return base::StrCat(
        {extension.name(), "'s manifest keeps it out of private windows"});
  }
  if (settings.file_access.has_value() && !CanUseFileAccess(extension)) {
    return base::StrCat({extension.name(), " does not run on local files"});
  }
  if (settings.user_scripts.has_value() &&
      !CanUseUserScripts(profile, extension)) {
    return base::StrCat(
        {extension.name(), " does not ask to run user scripts"});
  }
  if (settings.site_access.has_value() &&
      !CanUseSiteAccess(profile, extension)) {
    return base::StrCat({extension.name(), " asks for no sites"});
  }
  for (const std::string& site : settings.sites) {
    // ParseOneExtensionSettings checked each is a host, by a rule meant to
    // match URLPattern's. Refused rather than granted if they ever differ.
    URLPattern pattern(kSiteSchemes);
    if (pattern.Parse(*SitePattern(site)) !=
        URLPattern::ParseResult::kSuccess) {
      return base::StrCat({site, " is not a site Chrome can grant"});
    }
  }
  return std::nullopt;
}

void SetSiteAccess(Profile& profile,
                   const scoped_refptr<const extensions::Extension>& extension,
                   SiteAccess access,
                   const std::vector<std::string>& sites) {
  extensions::ScriptingPermissionsModifier modifier(&profile, extension);
  switch (access) {
    case SiteAccess::kAllSites:
      modifier.SetWithholdHostPermissions(false);
      return;
    case SiteAccess::kOnClick:
      modifier.SetWithholdHostPermissions(true);
      modifier.RemoveAllGrantedHostPermissions();
      return;
    case SiteAccess::kSpecificSites:
      modifier.SetWithholdHostPermissions(true);
      modifier.RemoveAllGrantedHostPermissions();
      for (const std::string& site : sites) {
        // ParseOneExtensionSettings checked each site.
        URLPattern pattern(kSiteSchemes);
        CHECK_EQ(pattern.Parse(*SitePattern(site)),
                 URLPattern::ParseResult::kSuccess);
        modifier.GrantHostPermission(pattern, base::DoNothing());
      }
      return;
  }
}

// Sets `settings` on the installed extension `id`, which can take them.
void Apply(Profile& profile,
           const std::string& id,
           const ExtensionSettings& settings) {
  const scoped_refptr<const extensions::Extension> extension(
      extensions::ExtensionRegistry::Get(&profile)->GetInstalledExtension(id));
  CHECK(extension);
  if (settings.site_access.has_value()) {
    SetSiteAccess(profile, extension, *settings.site_access, settings.sites);
  }
  if (settings.user_scripts.has_value()) {
    UserScriptsOf(profile)->SetUserScriptPrefEnabled(id,
                                                     *settings.user_scripts);
  }
  // These two reload the extension, so they go by id.
  if (settings.file_access.has_value()) {
    extensions::util::SetAllowFileAccess(id, &profile, *settings.file_access);
  }
  if (settings.in_private.has_value()) {
    extensions::util::SetIsIncognitoEnabled(id, &profile, *settings.in_private);
  }
}

// Applies the config's settings for `id` to it if it is installed and can
// take them, and logs why not if it cannot.
void ApplyConfigured(Profile& profile,
                     const std::string& id,
                     const ExtensionSettings& settings) {
  const extensions::Extension* extension =
      extensions::ExtensionRegistry::Get(&profile)->GetInstalledExtension(id);
  if (extension == nullptr) {
    return;
  }
  if (const std::optional<std::string> why =
          WhyNot(profile, *extension, settings)) {
    LOG(ERROR) << "domicile: the desk's config sets extension " << id
               << "'s settings, and " << *why << ".";
    return;
  }
  Apply(profile, id, settings);
}

// What the config last set in `prefs`. Nothing if the pref is unreadable,
// such as one a later engine wrote, which is logged: the profile is on disk,
// not this engine's to trust.
ExtensionSettingsMap ConfiguredBefore(const PrefService& prefs) {
  std::optional<ExtensionSettingsMap> configured =
      ParseExtensionSettings(prefs.GetDict(kConfigSettingsPref));
  if (!configured) {
    LOG(ERROR) << "domicile: cannot read " << kConfigSettingsPref
               << ", so no extension setting the config set before goes back "
                  "to Chrome's default.";
    return {};
  }
  return *std::move(configured);
}

// Gives an extension the config's settings once it installs: a Web Store id
// the config names is still pending when the config is applied. Not on an
// update or reload, which keeps them: `private` and `file_access` reload the
// extension, and an unpacked one reloads by installing again.
class InstallWatch final : public base::SupportsUserData::Data,
                           public extensions::ExtensionRegistryObserver {
 public:
  explicit InstallWatch(Profile& profile) : profile_(profile) {
    observation_.Observe(extensions::ExtensionRegistry::Get(&profile));
  }

  // extensions::ExtensionRegistryObserver:
  void OnExtensionInstalled(content::BrowserContext* browser_context,
                            const extensions::Extension* extension,
                            bool is_update) override {
    if (is_update) {
      return;
    }
    // Later: applying reloads the extension, which the registry is still
    // telling its observers it installed.
    base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE, base::BindOnce(&InstallWatch::Installed,
                                  weak_factory_.GetWeakPtr(), extension->id()));
  }
  void OnShutdown(extensions::ExtensionRegistry* registry) override {
    observation_.Reset();
  }

 private:
  void Installed(const std::string& id) {
    const ExtensionSettingsMap configured =
        ConfiguredBefore(*profile_->GetPrefs());
    const auto found = configured.find(id);
    if (found != configured.end()) {
      ApplyConfigured(*profile_, id, found->second);
    }
  }

  const raw_ref<Profile> profile_;
  base::ScopedObservation<extensions::ExtensionRegistry,
                          extensions::ExtensionRegistryObserver>
      observation_{this};
  base::WeakPtrFactory<InstallWatch> weak_factory_{this};
};

}  // namespace

void RegisterExtensionSettingsPrefs(PrefRegistrySimple* registry) {
  registry->RegisterDictionaryPref(kConfigSettingsPref);
}

ExtensionSettings SettingsOf(Profile& profile,
                             const extensions::Extension& extension) {
  ExtensionSettings settings;
  if (CanUseFileAccess(extension)) {
    settings.file_access =
        extensions::util::AllowFileAccess(extension.id(), &profile);
  }
  if (CanUseUserScripts(profile, extension)) {
    settings.user_scripts =
        UserScriptsOf(profile)->AreUserScriptsAllowed(extension);
  }
  if (CanUseSiteAccess(profile, extension)) {
    ReadSiteAccess(profile, extension, settings);
  }
  return settings;
}

ExtensionSettings ConfiguredSettingsOf(Profile& profile,
                                       const std::string& id) {
  const ExtensionSettingsMap configured = ConfiguredBefore(*profile.GetPrefs());
  const auto found = configured.find(id);
  return found == configured.end() ? ExtensionSettings() : found->second;
}

void WatchConfiguredSettings(PrefChangeRegistrar& registrar,
                             const base::RepeatingClosure& changed) {
  registrar.Add(kConfigSettingsPref, changed);
}

base::expected<void, std::string> ConfigureExtensionIn(
    Profile& profile,
    const std::string& id,
    const ExtensionSettings& settings) {
  const extensions::Extension* extension =
      extensions::ExtensionRegistry::Get(&profile)->GetInstalledExtension(id);
  if (extension == nullptr) {
    return base::unexpected(
        base::StrCat({"no extension ", id, " is installed"}));
  }
  if (const std::optional<std::string> why =
          WhyNot(profile, *extension, settings)) {
    return base::unexpected(*why);
  }
  Apply(profile, id, settings);
  return base::ok();
}

void ApplyConfigSettings(Profile& profile,
                         const ExtensionSettingsMap& settings) {
  if (profile.GetUserData(kInstallWatchKey) == nullptr) {
    profile.SetUserData(kInstallWatchKey,
                        std::make_unique<InstallWatch>(profile));
  }
  PrefService& prefs = *profile.GetPrefs();
  const ExtensionSettingsMap previous = ConfiguredBefore(prefs);
  prefs.SetDict(kConfigSettingsPref, ExtensionSettingsValue(settings));
  for (const auto& [id, changes] : ReconcileSettings(settings, previous)) {
    ApplyConfigured(profile, id, changes);
  }
}

}  // namespace domicile
