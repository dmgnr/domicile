// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "chrome/browser/domicile/domicile_command_socket.h"

#include <unistd.h>

#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "base/barrier_closure.h"
#include "base/check.h"
#include "base/check_op.h"
#include "base/command_line.h"
#include "base/files/file_path.h"
#include "base/functional/bind.h"
#include "base/logging.h"
#include "base/memory/scoped_refptr.h"
#include "base/no_destructor.h"
#include "base/strings/strcat.h"
#include "base/time/time.h"
#include "base/types/expected.h"
#include "chrome/browser/domicile/domicile_agent_devtools.h"
#include "chrome/browser/domicile/domicile_browser_profiles.h"
#include "chrome/browser/domicile/domicile_browser_windows.h"
#include "chrome/browser/domicile/domicile_extension_installer.h"
#include "chrome/browser/domicile/domicile_extension_settings.h"
#include "chrome/browser/domicile/domicile_history.h"
#include "chrome/browser/domicile/domicile_media_devices.h"
#include "chrome/browser/domicile/domicile_site_data.h"
#include "chrome/browser/profiles/profile.h"
#include "base/task/bind_post_task.h"
#include "chrome/browser/ui/browser_window/public/browser_collection.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/browser_window/public/global_browser_collection.h"
#include "components/content_settings/core/browser/host_content_settings_map.h"
#include "components/content_settings/core/common/content_settings.h"
#include "components/content_settings/core/common/content_settings_pattern.h"
#include "components/domicile/browser/app_roots.h"
#include "components/domicile/browser/browser_profiles.h"
#include "components/domicile/browser/command_protocol.h"
#include "components/domicile/browser/shell_source.h"
#include "components/domicile/browser/shell_swap.h"
#include "components/domicile/browser/shell_window_wait.h"
#include "components/domicile/browser/shortcut_registry.h"
#include "components/domicile/browser/site_permissions.h"
#include "components/domicile/mojom/web_view_guest.mojom.h"
#include "components/permissions/permissions_client.h"
#include "components/domicile/common/domicile_scheme.h"
#include "components/tabs/public/tab_interface.h"
#include "content/public/browser/browser_task_traits.h"
#include "content/public/browser/browser_thread.h"
#include "content/public/browser/domicile_log_levels.h"
#include "content/public/browser/navigation_controller.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/site_instance.h"
#include "content/public/browser/web_contents.h"
#include "net/base/io_buffer.h"
#include "net/base/net_errors.h"
#include "net/socket/stream_socket.h"
#include "net/socket/unix_domain_server_socket_posix.h"
#include "net/traffic_annotation/network_traffic_annotation.h"
#include "ui/base/page_transition_types.h"
#include "ui/ozone/public/ozone_platform.h"
#include "url/gurl.h"
#include "url/origin.h"

namespace domicile {
namespace {

// Commands are served one at a time. The backlog lets a concurrent
// `domicile load-shell` wait instead of being refused by the kernel.
constexpr int kBacklog = 4;

constexpr int kReadBufferSize = 4 * 1024;

// Caps a request line so a peer that never sends a newline cannot grow the
// heap.
constexpr size_t kMaxRequestSize = 64 * 1024;

// Accepts only peers running as this user. The socket's directory already
// limits access; this is a second check.
bool ConnectedByUs(const net::UnixDomainServerSocket::Credentials& peer) {
  return peer.user_id == getuid();
}

// The shell's window, or null when this browser has none.
//
// Matched by the domicile:// scheme. Searched in creation order so the result
// does not depend on which window was last focused.
content::WebContents* FindShellContents() {
  content::WebContents* shell = nullptr;
  GlobalBrowserCollection::GetInstance()->ForEach(
      [&shell](BrowserWindowInterface* browser) {
        tabs::TabInterface* tab = browser->GetActiveTabInterface();
        if (tab != nullptr &&
            tab->GetContents()->GetLastCommittedURL().SchemeIs(
                kDomicileScheme)) {
          shell = tab->GetContents();
          return false;
        }
        return true;
      },
      BrowserCollection::Order::kCreation);
  return shell;
}

// Whether a window is opening a domicile:// address it has not committed yet,
// as the shell's window is until its first page commits. The startup
// navigation is browser-initiated, so its address is the visible one.
bool AWindowIsOpeningTheShell() {
  bool opening = false;
  GlobalBrowserCollection::GetInstance()->ForEach(
      [&opening](BrowserWindowInterface* browser) {
        tabs::TabInterface* tab = browser->GetActiveTabInterface();
        if (tab != nullptr &&
            tab->GetContents()->GetVisibleURL().SchemeIs(kDomicileScheme)) {
          opening = true;
          return false;
        }
        return true;
      },
      BrowserCollection::Order::kCreation);
  return opening;
}

ShellWindowState LookForTheShellWindow() {
  if (FindShellContents() != nullptr) {
    return ShellWindowState::kShowingAPage;
  }
  return AWindowIsOpeningTheShell() ? ShellWindowState::kOpening
                                    : ShellWindowState::kAbsent;
}

// How long `load_shell`, `run_app` and `open_url` wait for the shell window's
// first page. Under the supervisor's wait for a reply (`PATIENCE` in
// domicile-launch's control_socket.rs), so the supervisor hears the refusal.
constexpr base::TimeDelta kFirstPagePatience = base::Seconds(3);

// Runs `ready` once the shell window shows a page.
//
// The socket binds before the shell window's first page commits, so a command
// sent at login can arrive while that page is loading. Each command that needs
// the shell's page waits for it rather than refusing.
void WhenTheShellWindowCanTakeIt(ShellWindowReady ready) {
  CHECK_CURRENTLY_ON(content::BrowserThread::UI);
  WhenTheShellWindowHasAPage(base::BindRepeating(&LookForTheShellWindow),
                             kFirstPagePatience, std::move(ready));
}

// How long `load_shell` waits for the new shell's page to say whether its
// module ran, after which the shell is taken as loaded. With
// kFirstPagePatience, under the supervisor's wait for a `load_shell` reply
// (`LOAD_WITHIN` in domicile-launch's domicile.rs), so it hears why a shell
// did not run.
constexpr base::TimeDelta kShellRunsWithin = base::Seconds(5);

// Loads what ShellSource serves into the shell window's page. A swap runs
// this in the task WhenTheShellWindowHasAPage found the page in; a revert,
// later, finds none once the window has closed, and has nothing to load.
//
// A renderer-initiated replacement rather than a reload: Chromium runs a
// cross-document view transition only for that kind of navigation, and the
// shell document's `@view-transition` crossfades the splash into the built
// shell. Shell files are served `no-store` (ShellURLLoaderFactory), so a
// rebuilt shell with the same URLs is read fresh.
void LoadTheServedShell() {
  CHECK_CURRENTLY_ON(content::BrowserThread::UI);
  content::WebContents* shell = FindShellContents();
  if (shell == nullptr) {
    return;
  }
  content::RenderFrameHost* page = shell->GetPrimaryMainFrame();
  content::NavigationController::LoadURLParams params(
      shell->GetLastCommittedURL());
  params.transition_type = ui::PAGE_TRANSITION_LINK;
  params.should_replace_current_entry = true;
  params.is_renderer_initiated = true;
  params.initiator_origin = page->GetLastCommittedOrigin();
  params.source_site_instance = page->GetSiteInstance();
  shell->GetController().LoadURLWithParams(params);
  LOG(INFO) << "domicile: now serving " << ShellSource::Get().Module()
            << " out of "
            << (ShellSource::Get().Files() == ShellFiles::kDevServer
                    ? "the dev server at "
                    : "")
            << ShellSource::Get().Root();
}

// The process's shell swap, which hears from the shell's page through
// ShellReports. See StartCommandSocket.
ShellSwap& TheShellSwap() {
  static base::NoDestructor<ShellSwap> swap(
      ShellSource::Get(), base::BindRepeating(&LoadTheServedShell),
      // Drops the old shell's shortcut claims on a swap to another shell.
      base::BindRepeating(&ShortcutRegistry::ShellChanged,
                          base::Unretained(&ShortcutRegistry::Get())),
      kShellRunsWithin);
  return *swap;
}

// Swaps in the shell at `root`/`module`, as `files` says, and answers once it
// ran or the old one is back, or refuses when there is no page to load it
// into.
//
// The source is set before the navigation because the navigation reads it.
void LoadShellIntoAPage(const base::FilePath& root,
                        const std::string& module,
                        ShellFiles files,
                        ShellLoaded loaded,
                        bool has_a_page) {
  CHECK_CURRENTLY_ON(content::BrowserThread::UI);
  if (!has_a_page) {
    std::move(loaded).Run(base::unexpected(kNoShellWindow));
    return;
  }
  TheShellSwap().Swap(
      root, module, files,
      base::BindOnce(
          [](ShellLoaded loaded, const ShellOutcome& ran) {
            if (ran.has_value()) {
              LOG(ERROR) << "domicile: " << *ran;
              std::move(loaded).Run(base::unexpected(*ran));
            } else {
              std::move(loaded).Run(base::ok());
            }
          },
          std::move(loaded)));
}

// Serves the shell at `root`/`module` and loads it into the shell window, once
// that window shows a page. The load navigates from the committed page.
void LoadShellIntoTheShellWindow(const base::FilePath& root,
                                 const std::string& module,
                                 ShellFiles files,
                                 ShellLoaded loaded) {
  WhenTheShellWindowCanTakeIt(base::BindOnce(&LoadShellIntoAPage, root, module,
                                             files, std::move(loaded)));
}

// Serves the app module `module` under `root` and opens an app window pinned
// to it, or refuses when there is no shell page to own it. See
// docs/architecture/APP-MODULES.md.
void RunAppOnceTheShellHasAPage(const base::FilePath& root,
                                const std::string& module,
                                WindowOpened opened,
                                bool has_a_page) {
  CHECK_CURRENTLY_ON(content::BrowserThread::UI);
  if (!has_a_page) {
    std::move(opened).Run(false);
    return;
  }
  const std::string host = AppRoots::Get().Add(root, module);
  LOG(INFO) << "domicile: running the app " << module << " out of " << root
            << " at " << kDomicileScheme << "://" << host << "/";
  std::move(opened).Run(OpenAppModuleWindow(
      GURL(base::StrCat({kDomicileScheme, "://", host, "/"})), host));
}

// Runs the app module once the shell window shows a page, which owns the app
// window.
void RunAppInAnAppWindow(const base::FilePath& root,
                         const std::string& module,
                         WindowOpened opened) {
  WhenTheShellWindowCanTakeIt(base::BindOnce(&RunAppOnceTheShellHasAPage, root,
                                             module, std::move(opened)));
}

// Opens a browser window at `url`, as for a page's target="_blank", or with
// `app` an app window, or refuses when there is no shell page to own it. The
// shell sees it in its window list. See domicile_browser_windows.h.
void OpenUrlOnceTheShellHasAPage(const GURL& url,
                                 std::optional<AppLaunch> app,
                                 const std::string& profile,
                                 WindowOpened opened,
                                 bool has_a_page) {
  CHECK_CURRENTLY_ON(content::BrowserThread::UI);
  if (!has_a_page) {
    std::move(opened).Run(false);
  } else if (app.has_value()) {
    std::move(opened).Run(OpenAppWindow(url, app->id, app->reuse, profile));
  } else {
    std::move(opened).Run(OpenBrowserWindow(url, profile));
  }
}

// Opens the window once the shell window shows a page, which owns it.
void OpenUrlInABrowserWindow(const GURL& url,
                             std::optional<AppLaunch> app,
                             const std::string& profile,
                             WindowOpened opened) {
  WhenTheShellWindowCanTakeIt(base::BindOnce(&OpenUrlOnceTheShellHasAPage, url,
                                             std::move(app), profile,
                                             std::move(opened)));
}

// Whether the config names browser profile `id`.
bool DeskHasBrowserProfile(const std::string& id) {
  return BrowserProfileRegistry::Get().profiles().Find(id) != nullptr;
}

// The site settings of the shell's profile, which browser windows share, or
// null when there is no shell.
HostContentSettingsMap* ShellSettings() {
  content::WebContents* shell = FindShellContents();
  if (shell == nullptr) {
    return nullptr;
  }
  return permissions::PermissionsClient::Get()->GetSettingsMap(
      shell->GetBrowserContext());
}

// Each permission's default and each site's own setting, as the address
// bar's panel stores them: user settings for one origin. Settings from
// policy or extensions, and patterns wider than an origin, are left out,
// since `set_site_permission` could not change them.
std::optional<SitePermissionList> ListShellSitePermissions() {
  CHECK_CURRENTLY_ON(content::BrowserThread::UI);

  const HostContentSettingsMap* map = ShellSettings();
  if (map == nullptr) {
    return std::nullopt;
  }
  SitePermissionList list;
  for (const mojom::WebViewPermission permission : kSitePermissions) {
    const ContentSettingsType type = SettingsTypeFor(permission);
    list.defaults.emplace_back(permission,
                               SettingFor(map->GetDefaultContentSetting(type)));
    for (const ContentSettingPatternSource& rule :
         map->GetSettingsForOneType(type)) {
      const ContentSetting setting = rule.GetContentSetting();
      const bool shown = setting == CONTENT_SETTING_ASK ||
                         setting == CONTENT_SETTING_ALLOW ||
                         setting == CONTENT_SETTING_BLOCK;
      const GURL site = rule.primary_pattern.ToRepresentativeUrl();
      if (rule.source != content_settings::ProviderType::kPrefProvider ||
          rule.incognito || !shown || rule.primary_pattern.MatchesAllHosts() ||
          rule.primary_pattern.HasDomainWildcard() || !site.is_valid() ||
          !HasSitePermissions(site)) {
        continue;
      }
      list.sites.push_back({url::Origin::Create(site), permission,
                            SettingFor(setting)});
    }
  }
  return list;
}

// Stores `origin`'s setting as the address bar's panel does
// (WebViewGuest::SetSitePermission). Open browser windows on the site see the
// change through their content settings observers.
bool SetShellSitePermission(const url::Origin& origin,
                            mojom::WebViewPermission permission,
                            mojom::WebViewPermissionSetting setting) {
  CHECK_CURRENTLY_ON(content::BrowserThread::UI);

  HostContentSettingsMap* map = ShellSettings();
  if (map == nullptr) {
    return false;
  }
  const GURL site = origin.GetURL();
  const ContentSettingsType type = SettingsTypeFor(permission);
  map->SetContentSettingDefaultScope(
      site, site, type,
      StoredSetting(setting, map->GetDefaultContentSetting(type)));
  return true;
}

// The shell's profile, which browser windows share, or null when there is no
// shell.
Profile* ShellProfile() {
  content::WebContents* shell = FindShellContents();
  if (shell == nullptr) {
    return nullptr;
  }
  return Profile::FromBrowserContext(shell->GetBrowserContext());
}

constexpr char kNoProfile[] =
    "this engine has no shell, and so no profile to hold extensions";

void LoadUnpackedIntoTheShellProfile(const base::FilePath& directory,
                                     UnpackedLoaded loaded) {
  CHECK_CURRENTLY_ON(content::BrowserThread::UI);
  Profile* profile = ShellProfile();
  if (profile == nullptr) {
    std::move(loaded).Run(base::unexpected(kNoProfile));
    return;
  }
  LoadUnpackedInto(*profile, directory, std::move(loaded));
}

base::expected<void, std::string> UninstallFromTheShellProfile(
    const std::string& id) {
  CHECK_CURRENTLY_ON(content::BrowserThread::UI);
  Profile* profile = ShellProfile();
  if (profile == nullptr) {
    return base::unexpected(kNoProfile);
  }
  return UninstallFrom(*profile, id);
}

std::optional<std::vector<std::string>> ListTheShellProfilesConfigExtensions() {
  CHECK_CURRENTLY_ON(content::BrowserThread::UI);
  Profile* profile = ShellProfile();
  if (profile == nullptr) {
    return std::nullopt;
  }
  return ConfigExtensionsOf(*profile);
}

// The shell profile's extensions, for the Settings app.
std::optional<std::vector<InstalledExtension>> ListShellExtensions() {
  CHECK_CURRENTLY_ON(content::BrowserThread::UI);
  Profile* profile = ShellProfile();
  if (profile == nullptr) {
    return std::nullopt;
  }
  return ExtensionsOf(*profile);
}

// In browser profile `browser_profile`, or the shell's own when empty.
base::expected<void, std::string> SetShellExtensionEnabled(
    const std::string& id,
    bool enabled,
    const std::string& browser_profile) {
  CHECK_CURRENTLY_ON(content::BrowserThread::UI);
  Profile* profile = ShellProfile();
  if (profile == nullptr) {
    return base::unexpected(kNoProfile);
  }
  if (browser_profile.empty()) {
    return SetExtensionEnabledIn(*profile, id, enabled);
  }
  return BrowserProfileRegistry::Get().SetExtensionEnabled(
      *profile->GetOriginalProfile(), browser_profile, id, enabled);
}

// The desk's browser profiles, their extension switches and the sites that
// open outside the default, as they are now.
BrowserProfileList BrowserProfilesNow() {
  BrowserProfileRegistry& registry = BrowserProfileRegistry::Get();
  const BrowserProfiles& profiles = registry.profiles();
  BrowserProfileList list;
  list.default_profile = profiles.default_profile;
  list.default_private_profile = profiles.default_private_profile;
  for (const BrowserProfile& profile : profiles.profiles) {
    ListedBrowserProfile& listed = list.profiles.emplace_back();
    listed.id = profile.id;
    listed.name = profile.name;
    listed.color = profile.color;
    listed.is_private = profile.is_private;
    for (const BrowserProfileRegistry::ExtensionSwitch& extension :
         registry.ExtensionSwitchesOf(profile.id)) {
      listed.extensions.push_back(ListedProfileExtension{
          .id = extension.id,
          .enabled = extension.enabled,
          .locked = extension.locked});
    }
  }
  for (const auto& [site, profile] : profiles.sites) {
    list.sites.push_back(ListedBrowserSite{
        .site = site,
        .profile = profile,
        .pinned = !registry.IsConfigSite(site)});
  }
  return list;
}

// The desk's browser profiles for the Settings app, once each has loaded:
// ExtensionSwitchesOf has nothing for a profile that has not.
void ListDeskBrowserProfiles(BrowserProfilesFound found) {
  CHECK_CURRENTLY_ON(content::BrowserThread::UI);
  Profile* profile = ShellProfile();
  if (profile == nullptr) {
    std::move(found).Run(std::nullopt);
    return;
  }
  BrowserProfileRegistry& registry = BrowserProfileRegistry::Get();
  const std::vector<BrowserProfile>& profiles = registry.profiles().profiles;
  base::RepeatingClosure loaded = base::BarrierClosure(
      profiles.size(), base::BindOnce(
                           [](BrowserProfilesFound found) {
                             // The shell may have gone while they loaded.
                             if (ShellProfile() == nullptr) {
                               std::move(found).Run(std::nullopt);
                               return;
                             }
                             std::move(found).Run(BrowserProfilesNow());
                           },
                           std::move(found)));
  // Copied: the compositor may send new profiles while one loads.
  std::vector<std::string> ids;
  for (const BrowserProfile& each : profiles) {
    ids.push_back(each.id);
  }
  for (const std::string& id : ids) {
    registry.WhenLoaded(*profile->GetOriginalProfile(), id, loaded);
  }
}

base::expected<void, std::string> PinDeskBrowserSite(
    const std::string& site,
    const std::string& browser_profile) {
  CHECK_CURRENTLY_ON(content::BrowserThread::UI);
  Profile* profile = ShellProfile();
  if (profile == nullptr) {
    return base::unexpected(kNoProfile);
  }
  return BrowserProfileRegistry::Get().PinSite(*profile->GetOriginalProfile(),
                                               site, browser_profile);
}

base::expected<void, std::string> ConfigureShellExtension(
    const std::string& id,
    const ExtensionSettings& settings) {
  CHECK_CURRENTLY_ON(content::BrowserThread::UI);
  Profile* profile = ShellProfile();
  if (profile == nullptr) {
    return base::unexpected(kNoProfile);
  }
  return ConfigureExtensionIn(*profile, id, settings);
}

// The cameras and microphones, ranked by the shell profile's preference, once
// Chrome has listed them. The profile is looked up then, as it may be gone.
void ListShellMediaDevices(MediaDevicesFound found) {
  CHECK_CURRENTLY_ON(content::BrowserThread::UI);
  WhenMediaDevicesListed(base::BindOnce(
      [](MediaDevicesFound found) {
        Profile* profile = ShellProfile();
        if (profile == nullptr) {
          std::move(found).Run(std::nullopt);
          return;
        }
        std::move(found).Run(RankedMediaDevices(*profile->GetPrefs()));
      },
      std::move(found)));
}

void PreferShellMediaDevice(MediaDeviceKind kind,
                            const std::string& id,
                            CommandDone done) {
  CHECK_CURRENTLY_ON(content::BrowserThread::UI);
  WhenMediaDevicesListed(base::BindOnce(
      [](MediaDeviceKind kind, const std::string& id, CommandDone done) {
        Profile* profile = ShellProfile();
        if (profile == nullptr) {
          std::move(done).Run(
              base::unexpected("this engine has no shell, and so no profile "
                               "to store the device in"));
          return;
        }
        std::move(done).Run(PreferMediaDevice(*profile->GetPrefs(), kind, id));
      },
      kind, id, std::move(done)));
}

constexpr char kNoHistory[] =
    "this engine has no shell, and so no profile to hold history and browsing "
    "data";

// The shell profile's history and browsing data, for the History app.
void SearchShellHistory(const HistorySearch& search, HistoryFound found) {
  CHECK_CURRENTLY_ON(content::BrowserThread::UI);
  Profile* profile = ShellProfile();
  if (profile == nullptr) {
    std::move(found).Run(base::unexpected(kNoHistory));
    return;
  }
  SearchHistoryIn(*profile, search, std::move(found));
}

void ListShellVisits(const GURL& url, VisitsFound found) {
  CHECK_CURRENTLY_ON(content::BrowserThread::UI);
  Profile* profile = ShellProfile();
  if (profile == nullptr) {
    std::move(found).Run(base::unexpected(kNoHistory));
    return;
  }
  ListVisitsIn(*profile, url, std::move(found));
}

void DeleteShellVisits(const std::vector<base::Time>& visits,
                       CommandDone done) {
  CHECK_CURRENTLY_ON(content::BrowserThread::UI);
  Profile* profile = ShellProfile();
  if (profile == nullptr) {
    std::move(done).Run(base::unexpected(kNoHistory));
    return;
  }
  DeleteVisitsIn(*profile, visits, std::move(done));
}

void ClearShellBrowsingData(const BrowsingDataClearing& clearing,
                            CommandDone done) {
  CHECK_CURRENTLY_ON(content::BrowserThread::UI);
  Profile* profile = ShellProfile();
  if (profile == nullptr) {
    std::move(done).Run(base::unexpected(kNoHistory));
    return;
  }
  ClearBrowsingDataIn(*profile, clearing, std::move(done));
}

constexpr char kNoSiteData[] =
    "this engine has no shell, and so no profile to hold site data";

// The shell profile's site data, for the Settings app.
void ListShellSiteData(SiteDataFound found) {
  CHECK_CURRENTLY_ON(content::BrowserThread::UI);
  Profile* profile = ShellProfile();
  if (profile == nullptr) {
    std::move(found).Run(base::unexpected(kNoSiteData));
    return;
  }
  ListSiteDataIn(*profile, std::move(found));
}

void ClearShellSiteData(const std::string& host, CommandDone done) {
  CHECK_CURRENTLY_ON(content::BrowserThread::UI);
  Profile* profile = ShellProfile();
  if (profile == nullptr) {
    std::move(done).Run(base::unexpected(kNoSiteData));
    return;
  }
  ClearSiteDataIn(*profile, host, std::move(done));
}

// Sets whether the touchpads rest while a keyboard types, when asked to, and
// says whether they do. Only the DRM platform reads touchpads itself: nested,
// the host compositor does.
base::expected<bool, std::string> DisableTouchpadsWhileTyping(
    std::optional<bool> enabled) {
  CHECK_CURRENTLY_ON(content::BrowserThread::UI);
  ui::OzonePlatform* platform = ui::OzonePlatform::GetInstance();
  if (!platform->GetDomicileDisableWhileTyping().has_value()) {
    return base::unexpected(
        "this desktop reads no touchpad itself; the compositor it runs inside "
        "does, and has its own setting");
  }
  if (enabled.has_value()) {
    platform->SetDomicileDisableWhileTyping(*enabled);
  }
  return *platform->GetDomicileDisableWhileTyping();
}

// Carries out `set_log_levels`. See content/public/browser/domicile_log_levels.h.
void SetEngineLogLevels(int min_level, const std::string& vmodule) {
  content::SetDomicileLogLevels(min_level, vmodule);
}

// One request line, answered from the UI thread.
//
// Runs on the UI thread because `ShellSource` is unlocked and UI-thread only,
// and loading a shell navigates a window. `reply` is bound to the IO thread,
// so it may be called from any thread, and later for `load_shell`, `run_app`,
// `open_url`, `load_unpacked`, the History app's commands, site data and
// `devtools`.
void AnswerOnUIThread(const std::string& line, CommandReply reply) {
  CHECK_CURRENTLY_ON(content::BrowserThread::UI);
  AnswerCommand(line,
                {.load_shell = &LoadShellIntoTheShellWindow,
                 .run_app = &RunAppInAnAppWindow,
                 .open_url = &OpenUrlInABrowserWindow,
                 .has_browser_profile = &DeskHasBrowserProfile,
                 .list_site_permissions = &ListShellSitePermissions,
                 .set_site_permission = &SetShellSitePermission,
                 .load_unpacked = &LoadUnpackedIntoTheShellProfile,
                 .uninstall_extension = &UninstallFromTheShellProfile,
                 .list_config_extensions =
                     &ListTheShellProfilesConfigExtensions,
                 .list_extensions = &ListShellExtensions,
                 .set_extension_enabled = &SetShellExtensionEnabled,
                 .configure_extension = &ConfigureShellExtension,
                 .list_browser_profiles = &ListDeskBrowserProfiles,
                 .pin_browser_site = &PinDeskBrowserSite,
                 .list_media_devices = &ListShellMediaDevices,
                 .set_media_device = &PreferShellMediaDevice,
                 .search_history = &SearchShellHistory,
                 .list_visits = &ListShellVisits,
                 .delete_visits = &DeleteShellVisits,
                 .clear_browsing_data = &ClearShellBrowsingData,
                 .list_site_data = &ListShellSiteData,
                 .clear_site_data = &ClearShellSiteData,
                 .disable_while_typing = &DisableTouchpadsWhileTyping,
                 .send_devtools = &SendDevToolsToBrowserWindow,
                 .set_log_levels = &SetEngineLogLevels},
                std::move(reply));
}

// The socket the supervisor dials, on the browser's IO thread.
//
// Serves one connection at a time; each connection carries one request. Lives
// for the life of the browser.
class CommandSocket {
 public:
  CommandSocket()
      : listener_(base::BindRepeating(&ConnectedByUs),
                  /*use_abstract_namespace=*/false),
        read_buffer_(
            base::MakeRefCounted<net::IOBufferWithSize>(kReadBufferSize)) {}

  CommandSocket(const CommandSocket&) = delete;
  CommandSocket& operator=(const CommandSocket&) = delete;

  ~CommandSocket() = default;

  void Listen(const std::string& path) {
    CHECK_CURRENTLY_ON(content::BrowserThread::IO);
    // Crash on failure: the socket was asked for, and a missing one would
    // look like a `load-shell` that did nothing. The supervisor makes a fresh
    // path per run, so a stale file here is a bug too.
    const int result = listener_.BindAndListen(path, kBacklog);
    CHECK_EQ(result, net::OK)
        << "domicile: could not listen on " << path << ": "
        << net::ErrorToString(result);
    LOG(INFO) << "domicile: taking commands on " << path;
    Accept();
  }

 private:
  void Accept() {
    const int result = listener_.Accept(
        &connection_,
        base::BindOnce(&CommandSocket::OnAccept, base::Unretained(this)));
    if (result != net::ERR_IO_PENDING) {
      OnAccept(result);
    }
  }

  void OnAccept(int result) {
    if (result != net::OK) {
      // No retry: `Accept` fails only when the listener is broken, and a
      // synchronous error would spin this thread forever.
      LOG(ERROR) << "domicile: the command socket stopped accepting: "
                 << net::ErrorToString(result)
                 << ". This desktop will not take further commands.";
      return;
    }
    request_.clear();
    Read();
  }

  void Read() {
    const int result = connection_->Read(
        read_buffer_.get(), kReadBufferSize,
        base::BindOnce(&CommandSocket::OnRead, base::Unretained(this)));
    if (result != net::ERR_IO_PENDING) {
      OnRead(result);
    }
  }

  void OnRead(int result) {
    if (result <= 0) {
      // The peer closed or failed before sending a full line.
      Close();
      return;
    }

    request_.append(read_buffer_->data(), static_cast<size_t>(result));

    const size_t newline = request_.find('\n');
    if (newline == std::string::npos) {
      if (request_.size() > kMaxRequestSize) {
        Reply(RefusedCommand(
            "a request is one line of JSON, and this one has not ended"));
        return;
      }
      Read();
      return;
    }

    // One request per connection: anything after the first newline is
    // dropped.
    content::GetUIThreadTaskRunner({})->PostTask(
        FROM_HERE,
        base::BindOnce(
            &AnswerOnUIThread, request_.substr(0, newline),
            base::BindPostTask(content::GetIOThreadTaskRunner({}),
                               base::BindOnce(&CommandSocket::Reply,
                                              base::Unretained(this)))));
  }

  void Reply(std::string line) {
    write_buffer_ = std::move(line);
    write_offset_ = 0;
    OnWrite(net::OK);
  }

  void OnWrite(int result) {
    if (result < 0) {
      LOG(ERROR) << "domicile: could not answer a command: "
                 << net::ErrorToString(result);
      Close();
      return;
    }
    write_offset_ += static_cast<size_t>(result);
    if (write_offset_ >= write_buffer_.size()) {
      Close();
      return;
    }

    auto remaining = base::MakeRefCounted<net::StringIOBuffer>(
        write_buffer_.substr(write_offset_));
    const int written = connection_->Write(
        remaining.get(), remaining->size(),
        base::BindOnce(&CommandSocket::OnWrite, base::Unretained(this)),
        MISSING_TRAFFIC_ANNOTATION);
    if (written != net::ERR_IO_PENDING) {
      OnWrite(written);
    }
  }

  // Closing ends the reply: the supervisor reads until end of stream.
  void Close() {
    connection_.reset();
    request_.clear();
    write_buffer_.clear();
    Accept();
  }

  net::UnixDomainServerSocket listener_;
  std::unique_ptr<net::StreamSocket> connection_;

  scoped_refptr<net::IOBufferWithSize> read_buffer_;
  std::string request_;

  std::string write_buffer_;
  size_t write_offset_ = 0;
};

void ListenOnIOThread(const std::string& path) {
  static base::NoDestructor<CommandSocket> socket;
  socket->Listen(path);
}

}  // namespace

void StartCommandSocket() {
  CHECK_CURRENTLY_ON(content::BrowserThread::UI);

  const base::CommandLine& command_line =
      *base::CommandLine::ForCurrentProcess();
  if (!command_line.HasSwitch(kDomicileCommandSocketSwitch)) {
    return;
  }

  // What the shell's page says of its module reaches the swap waiting on it.
  // Heard on the IO thread, where its control channel is read.
  ShellReports::Get().Listen(base::BindPostTask(
      content::GetUIThreadTaskRunner({}),
      base::BindRepeating(
          [](const std::string& serial, const ShellOutcome& ran) {
            TheShellSwap().Heard(serial, ran);
          })));

  // A net socket needs an IO message pump; the IO thread has one, and the
  // traffic is too light for a dedicated thread.
  content::GetIOThreadTaskRunner({})->PostTask(
      FROM_HERE,
      base::BindOnce(&ListenOnIOThread, command_line.GetSwitchValueASCII(
                                            kDomicileCommandSocketSwitch)));
}

}  // namespace domicile
