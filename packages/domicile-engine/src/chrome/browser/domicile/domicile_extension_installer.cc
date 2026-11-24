// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "chrome/browser/domicile/domicile_extension_installer.h"

#include <map>
#include <optional>
#include <set>
#include <string>
#include <type_traits>
#include <utility>
#include <vector>

#include "base/files/file_path.h"
#include "base/files/file_util.h"
#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/logging.h"
#include "base/memory/scoped_refptr.h"
#include "base/no_destructor.h"
#include "base/one_shot_event.h"
#include "base/strings/strcat.h"
#include "base/strings/utf_string_conversions.h"
#include "base/task/thread_pool.h"
#include "base/values.h"
#include "chrome/browser/domicile/domicile_browser_profiles.h"
#include "chrome/browser/domicile/domicile_extension_settings.h"
#include "chrome/browser/extensions/extension_service.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/common/pref_names.h"
#include "components/crx_file/id_util.h"
#include "components/prefs/pref_change_registrar.h"
#include "components/prefs/pref_registry_simple.h"
#include "components/prefs/pref_service.h"
#include "components/prefs/scoped_user_pref_update.h"
#include "content/public/browser/browser_thread.h"
#include "extensions/browser/disable_reason.h"
#include "extensions/browser/extension_prefs.h"
#include "extensions/browser/extension_registrar.h"
#include "extensions/browser/extension_registry.h"
#include "extensions/browser/extension_system.h"
#include "extensions/browser/pending_extension_manager.h"
#include "extensions/browser/permissions/permissions_updater.h"
#include "extensions/browser/uninstall_reason.h"
#include "extensions/browser/unpacked_installer.h"
#include "extensions/common/extension.h"
#include "extensions/common/extension_set.h"
#include "extensions/common/extension_urls.h"
#include "extensions/common/manifest.h"
#include "extensions/common/manifest_handlers/description_info.h"
#include "extensions/common/manifest_handlers/icons_handler.h"
#include "extensions/common/manifest_handlers/options_page_info.h"
#include "extensions/common/mojom/manifest.mojom-shared.h"

namespace domicile {
namespace {

// The ids this installer added. Stored as a list because a pending Web Store
// install has no extension to mark yet.
constexpr char kAddedPref[] = "domicile.extensions.added";

void Remember(PrefService& pref_service, const std::string& id) {
  ScopedListPrefUpdate added(pref_service, kAddedPref);
  if (!added->contains(id)) {
    added->Append(id);
  }
}

// Chromium disables unpacked extensions without developer mode
// (`ExtensionManagement::IsAllowedByUnpackedDeveloperModePolicy`), and a desk
// has no chrome://extensions to enable it. Never turned off, since the user
// may have set it.
void AllowUnpacked(PrefService& pref_service) {
  pref_service.SetBoolean(prefs::kExtensionsUIDeveloperMode, true);
}

void OnLoadedForSettings(
    base::OnceCallback<void(base::expected<std::string, std::string>)> loaded,
    const extensions::Extension* extension,
    const base::FilePath& directory,
    const std::u16string& error) {
  if (!extension) {
    std::move(loaded).Run(base::unexpected(
        base::StrCat({directory.value(), " did not load: ",
                      base::UTF16ToUTF8(error)})));
    return;
  }
  std::move(loaded).Run(base::ok(extension->id()));
}

// Resolves unpacked directories the way `UnpackedInstaller` does, so they
// match `Extension::path()`. Otherwise a symlinked path would never match and
// would reload on every connect. Does file IO, so runs off the UI thread.
// Unresolvable paths are kept for the installer to report.
ExtensionList Resolved(ExtensionList wanted) {
  for (std::string& directory : wanted.unpacked) {
    const base::FilePath resolved =
        base::MakeAbsoluteFilePath(base::FilePath(directory));
    if (!resolved.empty()) {
      directory = resolved.value();
    }
  }
  return wanted;
}

// An unpacked extension's id, as Extension::InitExtensionID makes it: from
// its manifest's `key` when it has one, which fixes the id wherever the
// directory is, else from its path. Does file IO, so runs off the UI thread.
std::string UnpackedIdOf(const base::FilePath& directory) {
  std::string manifest;
  if (!base::ReadFileToString(
          directory.Append(FILE_PATH_LITERAL("manifest.json")), &manifest)) {
    // The installer reports it when it fails to load.
    return crx_file::id_util::GenerateIdForPath(directory);
  }
  // As Chrome reads a manifest: comments and trailing commas allowed.
  std::optional<base::DictValue> parsed = base::JSONReader::ReadDict(
      manifest, base::JSON_PARSE_CHROMIUM_EXTENSIONS);
  const std::string* key =
      parsed.has_value() ? parsed->FindString("key") : nullptr;
  if (key == nullptr) {
    return crx_file::id_util::GenerateIdForPath(directory);
  }
  std::string bytes;
  if (!extensions::Extension::ParsePEMKeyBytes(*key, &bytes)) {
    // Chrome refuses to load it, and says so.
    LOG(ERROR) << "domicile: the unpacked extension in " << directory
               << " has a manifest key that is no public key.";
    return crx_file::id_util::GenerateIdForPath(directory);
  }
  return crx_file::id_util::GenerateId(bytes);
}

// Resolved, with each unpacked directory's id, for the browser profiles to
// match the ids their config names.
std::pair<ExtensionList, std::map<std::string, std::string>> ResolvedWithIds(
    ExtensionList wanted) {
  ExtensionList resolved = Resolved(std::move(wanted));
  std::map<std::string, std::string> ids;
  for (const std::string& directory : resolved.unpacked) {
    ids.emplace(directory, UnpackedIdOf(base::FilePath(directory)));
  }
  return {std::move(resolved), std::move(ids)};
}

void OnUnpackedLoaded(base::WeakPtr<Profile> profile,
                      const extensions::Extension* extension,
                      const base::FilePath& directory,
                      const std::u16string& error) {
  if (!extension) {
    // Each profile loads it, at each start and each change to the config, so
    // it is said once for each directory and reason until the engine exits.
    DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
    using Said = std::set<std::pair<base::FilePath, std::u16string>>;
    static base::NoDestructor<Said> said;
    if (said->insert({directory, error}).second) {
      LOG(ERROR) << "domicile: the desk's config names " << directory
                 << " as an unpacked extension, and it did not load: "
                 << base::UTF16ToUTF8(error);
    }
    return;
  }
  if (profile) {
    Remember(*profile->GetPrefs(), extension->id());
  }
}

void Reconcile(base::WeakPtr<Profile> profile, const ExtensionList& wanted) {
  if (!profile) {
    return;
  }
  PrefService& pref_service = *profile->GetPrefs();

  std::set<std::string> installed;
  std::map<std::string, std::string> unpacked;
  for (const auto& extension :
       extensions::ExtensionRegistry::Get(profile.get())
           ->GenerateInstalledExtensionsSet()) {
    installed.insert(extension->id());
    if (extension->location() ==
        extensions::mojom::ManifestLocation::kUnpacked) {
      unpacked.emplace(extension->path().value(), extension->id());
    }
  }
  std::set<std::string> added;
  for (const base::Value& id : pref_service.GetList(kAddedPref)) {
    added.insert(id.GetString());
  }

  const ExtensionChanges changes =
      ReconcileExtensions(wanted, installed, unpacked, added);
  for (const std::string& id : changes.claim) {
    Remember(pref_service, id);
  }

  // Uninstall first, so an unpacked extension that moved (same id, new path)
  // is gone before the new path loads.
  //
  // ORPHANED_EXTERNAL_EXTENSION skips the policy check and is not recorded as
  // a user uninstall, so the id can be configured again later.
  for (const std::string& id : changes.uninstall) {
    std::u16string error;
    if (extensions::ExtensionRegistrar::Get(profile.get())
            ->UninstallExtension(
                id, extensions::UNINSTALL_REASON_ORPHANED_EXTERNAL_EXTENSION,
                &error)) {
      ScopedListPrefUpdate(pref_service, kAddedPref)
          ->EraseValue(base::Value(id));
    } else {
      LOG(ERROR) << "domicile: the desk's config no longer names extension "
                 << id << ", and it would not uninstall: "
                 << base::UTF16ToUTF8(error);
    }
  }

  // Installed as a Web Store install (kInternal), not an external one: at
  // every start Chrome uninstalls, data and all, each external extension no
  // external provider lists (ExternalProviderManager::CheckExternalUninstall),
  // and the config is no provider. Marked acknowledged so it is never
  // disabled pending a prompt.
  for (const std::string& id : changes.install_from_web_store) {
    // AddFromExternalUpdateUrl refuses ids the user uninstalled; the config
    // overrides that.
    extensions::ExtensionPrefs::Get(profile.get())
        ->ClearExternalExtensionUninstalled(id);
    if (extensions::PendingExtensionManager::Get(profile.get())
            ->AddFromExternalUpdateUrl(
                id, /*install_parameter=*/std::string(),
                extension_urls::GetWebstoreUpdateUrl(),
                extensions::mojom::ManifestLocation::kInternal,
                extensions::Extension::NO_FLAGS,
                /*mark_acknowledged=*/true)) {
      Remember(pref_service, id);
    }
  }
  if (!changes.install_from_web_store.empty()) {
    extensions::ExtensionSystem::Get(profile.get())
        ->extension_service()
        ->CheckForUpdatesSoon();
  }

  if (!changes.load_unpacked.empty()) {
    AllowUnpacked(pref_service);
  }
  for (const std::string& directory : changes.load_unpacked) {
    scoped_refptr<extensions::UnpackedInstaller> installer =
        extensions::UnpackedInstaller::Create(profile.get());
    // A desk has no window for an error dialog; `OnUnpackedLoaded` logs
    // failures.
    installer->set_be_noisy_on_failure(false);
    installer->set_completion_callback(
        base::BindOnce(&OnUnpackedLoaded, profile));
    installer->Load(base::FilePath(directory));
  }

  ApplyConfigSettings(*profile, wanted.settings);
}

// Hands the whole list, resolved, to the desk's browser profiles, which
// install into each profile the extensions it turns on.
void HandToBrowserProfiles(
    base::WeakPtr<Profile> shell,
    std::pair<ExtensionList, std::map<std::string, std::string>> all) {
  if (shell) {
    BrowserProfileRegistry::Get().SetExtensions(*shell, std::move(all.first),
                                                std::move(all.second));
  }
}

}  // namespace

// Waits for the extension system to load; until then the registry is empty
// and every installed extension would look missing.
void ReconcileConfigExtensions(base::WeakPtr<Profile> profile,
                               ExtensionList wanted) {
  if (!profile) {
    return;
  }
  extensions::ExtensionSystem::Get(profile.get())
      ->ready()
      .Post(FROM_HERE,
            base::BindOnce(&Reconcile, profile, std::move(wanted)));
}

void LoadUnpackedInto(
    Profile& profile,
    const base::FilePath& directory,
    base::OnceCallback<void(base::expected<std::string, std::string>)> loaded) {
  AllowUnpacked(*profile.GetPrefs());
  scoped_refptr<extensions::UnpackedInstaller> installer =
      extensions::UnpackedInstaller::Create(&profile);
  // A desk has no window for an error dialog; the Settings app shows the
  // error.
  installer->set_be_noisy_on_failure(false);
  installer->set_completion_callback(
      base::BindOnce(&OnLoadedForSettings, std::move(loaded)));
  installer->Load(directory);
}

base::expected<void, std::string> UninstallFrom(Profile& profile,
                                                const std::string& id) {
  for (const base::Value& added : profile.GetPrefs()->GetList(kAddedPref)) {
    if (added.GetString() == id) {
      return base::unexpected(
          "the desk's config installs this extension, so it uninstalls only "
          "when the config's extensions no longer list it");
    }
  }
  if (extensions::ExtensionRegistry::Get(&profile)->GetInstalledExtension(
          id) == nullptr) {
    return base::unexpected(
        base::StrCat({"no extension ", id, " is installed"}));
  }
  std::u16string error;
  if (!extensions::ExtensionRegistrar::Get(&profile)->UninstallExtension(
          id, extensions::UNINSTALL_REASON_USER_INITIATED, &error)) {
    return base::unexpected(base::UTF16ToUTF8(error));
  }
  return base::ok();
}

std::vector<std::string> ConfigExtensionsOf(Profile& profile) {
  std::vector<std::string> ids;
  for (const base::Value& id : profile.GetPrefs()->GetList(kAddedPref)) {
    ids.push_back(id.GetString());
  }
  return ids;
}

void WatchConfigExtensions(PrefChangeRegistrar& registrar,
                           const base::RepeatingClosure& changed) {
  registrar.Add(kAddedPref, changed);
  WatchConfiguredSettings(registrar, changed);
}

namespace {

// The absolute path of `extension`'s manifest icon closest to 128px, the
// size chrome://extensions draws from: the smallest at least that big, else
// the biggest. Empty when the manifest names none.
std::string IconPathOf(const extensions::Extension& extension) {
  constexpr int kSize = 128;
  // The set's type as icons_handler.h names it, wherever it lives.
  const auto& icons = extensions::IconsInfo::GetIcons(&extension);
  using IconSet = std::remove_cvref_t<decltype(icons)>;
  std::string relative = icons.Get(kSize, IconSet::Match::kBigger);
  if (relative.empty()) {
    relative = icons.Get(kSize, IconSet::Match::kSmaller);
  }
  if (relative.empty()) {
    return std::string();
  }
  return extension.path()
      .Append(base::FilePath::FromUTF8Unsafe(relative))
      .AsUTF8Unsafe();
}

}  // namespace

std::vector<InstalledExtension> ExtensionsOf(Profile& profile) {
  const extensions::ExtensionRegistry* registry =
      extensions::ExtensionRegistry::Get(&profile);
  std::vector<InstalledExtension> listed;
  for (const auto& extension :
       registry->GenerateInstalledExtensionsSet()) {
    if (!extension->is_extension() ||
        extensions::Manifest::IsComponentLocation(extension->location())) {
      continue;
    }
    InstalledExtension entry;
    entry.id = extension->id();
    entry.name = extension->name();
    entry.description =
        extensions::DescriptionInfo::GetDescription(*extension);
    entry.version = extension->VersionString();
    entry.enabled = registry->enabled_extensions().Contains(extension->id());
    entry.settings = SettingsOf(profile, *extension);
    entry.options_url =
        extensions::OptionsPageInfo::GetOptionsPage(extension.get());
    entry.icon_path = IconPathOf(*extension);
    listed.push_back(std::move(entry));
  }
  return listed;
}

base::expected<void, std::string> SetExtensionEnabledIn(Profile& profile,
                                                        const std::string& id,
                                                        bool enabled) {
  const extensions::Extension* extension =
      extensions::ExtensionRegistry::Get(&profile)->GetInstalledExtension(id);
  if (extension == nullptr) {
    return base::unexpected(
        base::StrCat({"no extension ", id, " is installed"}));
  }
  if (BrowserProfileRegistry::Get().IsSwitchLocked(profile, id)) {
    return base::unexpected(
        "the desk's config names the extensions this browser profile turns "
        "on, so only the config switches this one");
  }
  extensions::ExtensionRegistrar* registrar =
      extensions::ExtensionRegistrar::Get(&profile);
  if (enabled) {
    // The user's switch is the consent, as chrome://extensions' prompt is.
    registrar->GrantPermissionsAndEnableExtension(*extension);
  } else {
    registrar->DisableExtension(
        id, {extensions::disable_reason::DISABLE_USER_ACTION});
  }
  return base::ok();
}

void GrantPermissionsOf(Profile& profile,
                        const extensions::Extension& extension) {
  const extensions::DisableReasonSet reasons =
      extensions::ExtensionPrefs::Get(&profile)->GetDisableReasons(
          extension.id());
  constexpr extensions::disable_reason::DisableReason kIncrease =
      extensions::disable_reason::DISABLE_PERMISSIONS_INCREASE;
  if (reasons == extensions::DisableReasonSet{kIncrease}) {
    LOG(INFO) << "domicile: extension " << extension.id()
              << " was off for want of permissions; granted them and "
                 "switched it on.";
    extensions::ExtensionRegistrar::Get(&profile)
        ->GrantPermissionsAndEnableExtension(extension);
    return;
  }
  extensions::PermissionsUpdater(&profile).GrantActivePermissions(&extension);
  if (reasons.contains(kIncrease)) {
    // Off for another reason too, such as the user's switch, which stays.
    extensions::ExtensionPrefs::Get(&profile)->RemoveDisableReason(
        extension.id(), kIncrease);
  }
}

void RegisterExtensionInstallerPrefs(PrefRegistrySimple* registry) {
  registry->RegisterListPref(kAddedPref);
  RegisterExtensionSettingsPrefs(registry);
  RegisterBrowserProfilesPrefs(registry);
}

void InstallExtensionsInto(base::WeakPtr<Profile> profile,
                           const ExtensionList& wanted) {
  CHECK_CURRENTLY_ON(content::BrowserThread::UI);
  base::ThreadPool::PostTaskAndReplyWithResult(
      FROM_HERE, {base::MayBlock()}, base::BindOnce(&ResolvedWithIds, wanted),
      base::BindOnce(&HandToBrowserProfiles, std::move(profile)));
}

}  // namespace domicile
