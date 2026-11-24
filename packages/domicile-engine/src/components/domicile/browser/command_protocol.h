// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef COMPONENTS_DOMICILE_BROWSER_COMMAND_PROTOCOL_H_
#define COMPONENTS_DOMICILE_BROWSER_COMMAND_PROTOCOL_H_

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "base/files/file_path.h"
#include "base/functional/callback.h"
#include "base/functional/function_ref.h"
#include "base/time/time.h"
#include "base/types/expected.h"
#include "base/values.h"
#include "components/domicile/browser/extension_settings.h"
#include "components/domicile/browser/shell_source.h"
#include "components/domicile/mojom/browser_windows.mojom-shared.h"
#include "components/domicile/mojom/web_view_guest.mojom-shared.h"
#include "url/gurl.h"
#include "url/origin.h"

namespace domicile {

// The command protocol: requests a running engine accepts about the shell it
// serves. Each connection carries one JSON request line and one reply line.
//
//   {"type":"load_shell","version":1,"root":"/x/dist","module":"shell.js"}
//   {"type":"load_shell","version":1,"root":"/run/user/1000/dev.sock",
//    "module":"@domicile/shell.js","dev_server":true}
//                                      (`domicile dev`: the root is a dev
//                                       server's socket; see
//                                       shell_dev_server.h)
//   -> {"type":"loaded"}
//   -> {"type":"refused","why":"..."}
//
//   {"type":"run_app","version":1,"root":"/opt/notes","module":"notes.js"}
//   -> {"type":"opened"}
//   -> {"type":"refused","why":"..."}
//
//   {"type":"open_url","version":1,"url":"https://example.com/"}
//   {"type":"open_url","version":1,"url":"https://example.com/","app":true}
//   {"type":"open_url","version":1,"url":"https://example.com/","app":true,
//    "app_id":"mail","reuse":"focus"}
//   {"type":"open_url","version":1,"url":"https://example.com/",
//    "profile":"work"}
//   {"type":"open_url","version":1,"url":"https://example.com/","app":true,
//    "app_id":"mail","reuse":"focus","profile":"work"}
//   -> {"type":"opened"}
//   -> {"type":"refused","why":"..."}
//
//   {"type":"site_permissions","version":1}
//   -> {"type":"site_permissions","defaults":{"camera":"ask",...},
//       "sites":[{"origin":"https://meet.example","permission":"camera",
//                 "setting":"allow"}]}
//   -> {"type":"refused","why":"..."}
//
//   {"type":"set_site_permission","version":1,
//    "origin":"https://meet.example","permission":"camera","setting":"block"}
//   -> {"type":"set"}
//   -> {"type":"refused","why":"..."}
//
//   {"type":"load_unpacked","version":1,"directory":"/home/me/src/x"}
//   -> {"type":"loaded_unpacked","id":"..."}
//   -> {"type":"refused","why":"..."}
//
//   {"type":"uninstall_extension","version":1,"id":"..."}
//   -> {"type":"uninstalled"}
//   -> {"type":"refused","why":"..."}
//
//   {"type":"config_extensions","version":1}
//   -> {"type":"config_extensions","ids":["..."]}
//   -> {"type":"refused","why":"..."}
//
//   {"type":"extensions","version":1}
//   -> {"type":"extensions","extensions":[{"id":"...","name":"...",
//       "description":"...","version":"1.0","enabled":true,
//       "settings":{"private":false,"site_access":"all_sites"},
//       "options_url":"chrome-extension://.../options.html",
//       "icon_path":"/home/.../icons/128.png"}]}
//   -> {"type":"refused","why":"..."}
//
//   {"type":"set_extension_enabled","version":1,"id":"...","enabled":false}
//   {"type":"set_extension_enabled","version":1,"id":"...","enabled":false,
//    "profile":"work"}
//   -> {"type":"set"}
//   -> {"type":"refused","why":"..."}
//
//   {"type":"browser_profiles","version":1}
//   -> {"type":"browser_profiles","default_profile":"personal",
//       "default_private_profile":"private",
//       "profiles":[{"id":"work","name":"Work","color":"#d97706",
//                    "private":false,"extensions":[{"id":"...",
//                    "enabled":true,"locked":false}]}],
//       "sites":[{"site":"github.com/acme","profile":"work",
//                 "pinned":true}]}
//   -> {"type":"refused","why":"..."}
//
//   {"type":"pin_browser_site","version":1,"site":"github.com/acme",
//    "profile":"work"}
//   -> {"type":"set"}
//   -> {"type":"refused","why":"..."}
//
//   {"type":"configure_extension","version":1,"id":"...",
//    "settings":{"private":true,"site_access":["github.com"]}}
//   -> {"type":"set"}
//   -> {"type":"refused","why":"..."}
//
//   {"type":"media_devices","version":1}
//   -> {"type":"media_devices",
//       "cameras":[{"id":"/dev/video2","name":"USB Camera"}],
//       "microphones":[...]}
//   -> {"type":"refused","why":"..."}
//
//   {"type":"set_media_device","version":1,"kind":"camera","id":"..."}
//   -> {"type":"set"}
//   -> {"type":"refused","why":"..."}
//
//   {"type":"history","version":1,"text":"news",
//    "end_time":1700000000000.5,"max_results":100}
//   -> {"type":"history","items":[{"url":"https://news.example/",
//       "title":"News","favicon":"data:image/png;base64,..."}]}
//   -> {"type":"refused","why":"..."}
//
//   {"type":"visits","version":1,"url":"https://news.example/"}
//   -> {"type":"visits","times":[1700000000000.5]}
//   -> {"type":"refused","why":"..."}
//
//   {"type":"delete_history","version":1,"visits":[1700000000000.5]}
//   -> {"type":"deleted"}
//   -> {"type":"refused","why":"..."}
//
//   {"type":"clear_browsing_data","version":1,"since":1700000000000,
//    "types":["cookies","localStorage"],"origins":["https://a.example"]}
//   -> {"type":"cleared"}
//   -> {"type":"refused","why":"..."}
//
//   {"type":"site_data","version":1}
//   -> {"type":"site_data","sites":[{"host":"mail.example","bytes":20480,
//       "cookies":3}]}
//   -> {"type":"refused","why":"..."}
//
//   {"type":"clear_site_data","version":1,"host":"mail.example"}
//   -> {"type":"cleared"}
//   -> {"type":"refused","why":"..."}
//
//   {"type":"disable_while_typing","version":1}
//   {"type":"disable_while_typing","version":1,"enabled":false}
//   -> {"type":"disable_while_typing","enabled":false}
//   -> {"type":"refused","why":"..."}
//
//   {"type":"set_log_levels","version":1,"min_level":0,
//    "vmodule":"*/domicile/*=2"}
//   -> {"type":"set"}
//   -> {"type":"refused","why":"..."}
//
//   {"type":"devtools","version":1,"window":"<browser window id>",
//    "method":"Accessibility.getFullAXTree","params":{"depth":4}}
//   -> {"type":"devtools","result":{"nodes":[...]}}
//   -> {"type":"refused","why":"..."}
//
// `devtools` is how `domicile mcp` drives a browser window for an agent: one
// Chrome DevTools Protocol method sent to the window's page, answered with
// the method's result. Only the methods kDevToolsMethods names go through:
// enough to read the page's accessibility tree, click, type, scroll and
// navigate, and nothing that reads cookies or storage or runs script. A
// private window is never driven. `params` defaults to {}.
// `set_log_levels` is `domicile set-log-level`: `min_level` is Chromium's
// minimum severity (0 INFO to 3 FATAL) and `vmodule` its `--vmodule`, in every
// engine process until the engine exits.
// `disable_while_typing` is `domicile disable-while-typing`: whether the
// touchpads rest while a keyboard types, set when the request says.
// The site permissions, extensions and media devices are the Settings app's,
// relayed by the supervisor (docs/SETTINGS.md), as is the site data. Names are
// site_permissions.h's.
// The history and browsing data are the History app's. Times are milliseconds
// since the Unix epoch, fractional to the microsecond, as `chrome.history`
// gives them.
//
// This file only parses and answers lines; the actions are injected so it can
// be tested with strings. chrome/browser/domicile/domicile_command_socket.cc
// owns the socket.

// The command protocol version.
//
// The supervisor and the engine ship separately (`engine-release.nix` pins the
// engine), so the two ends can run different revisions. Each request carries
// the version because there is no handshake. An engine that does not speak it
// refuses the request and names both versions.
inline constexpr int kCommandVersion = 1;

// Why `load_shell` loaded nothing while the shell window's first page has not
// committed. Matched whole by domicile-launch (`NO_SHELL_WINDOW` in
// command.rs), which asks again on it.
inline constexpr char kNoShellWindow[] =
    "this engine has no shell window to load a shell into";

// Runs once when `load_shell` loaded the shell, or with why it did not:
// kNoShellWindow, or why the new shell did not run (see ShellSwap).
using ShellLoaded =
    base::OnceCallback<void(base::expected<void, std::string> loaded)>;

// Carries out `load_shell`: serves this shell and shows it. Runs `loaded`
// once, possibly after returning, as the shell window's first page may still
// be loading and the new shell has yet to run.
using LoadShell = base::FunctionRef<void(const base::FilePath& root,
                                         const std::string& module,
                                         ShellFiles files,
                                         ShellLoaded loaded)>;

// Runs once with whether `run_app` or `open_url` opened its window: false if
// there is no shell to own it.
using WindowOpened = base::OnceCallback<void(bool opened)>;

// Carries out `run_app`: serves the app module `module` under `root` and opens
// an app window on it. Runs `opened` once, possibly after returning, as the
// shell window's first page may still be loading. See
// docs/architecture/APP-MODULES.md.
using RunApp = base::FunctionRef<void(const base::FilePath& root,
                                      const std::string& module,
                                      WindowOpened opened)>;

// How `open_url` opens an app window: its id, and what to do when one with
// that id is open. See mojom::BrowserWindows.OpenApp.
struct AppLaunch {
  // Empty for none.
  std::string id;
  mojom::AppReuse reuse = mojom::AppReuse::kNew;

  friend bool operator==(const AppLaunch&, const AppLaunch&) = default;
};

// Carries out `open_url`: opens a browser window at `url`, or with `app` an app
// window, which the shell draws without an address bar. A new window is in
// browser profile `profile`, one the desk has, or for an empty one the
// profile `url`'s site opens in. Runs `opened` once, possibly after
// returning, as for `run_app`.
using OpenUrl = base::FunctionRef<void(const GURL& url,
                                       std::optional<AppLaunch> app,
                                       const std::string& profile,
                                       WindowOpened opened)>;

// Whether the desk has browser profile `id`, so `open_url` can refuse one it
// does not instead of opening the window elsewhere.
using HasBrowserProfile = base::FunctionRef<bool(const std::string& id)>;

// One site's stored setting for one permission.
struct StoredSitePermission {
  url::Origin origin;
  mojom::WebViewPermission permission;
  mojom::WebViewPermissionSetting setting;
};

// Every permission's default and every site's stored setting.
struct SitePermissionList {
  SitePermissionList();
  SitePermissionList(const SitePermissionList&);
  SitePermissionList& operator=(const SitePermissionList&);
  ~SitePermissionList();

  std::vector<
      std::pair<mojom::WebViewPermission, mojom::WebViewPermissionSetting>>
      defaults;
  std::vector<StoredSitePermission> sites;
};

// Carries out `site_permissions`. Returns nothing if there is no shell, and so
// no profile to read.
using ListSitePermissions =
    base::FunctionRef<std::optional<SitePermissionList>()>;

// Carries out `set_site_permission`, storing the default as no setting.
// Returns false if there is no shell, and so no profile to store in.
using SetSitePermission =
    base::FunctionRef<bool(const url::Origin& origin,
                           mojom::WebViewPermission permission,
                           mojom::WebViewPermissionSetting setting)>;

// Runs once with the id of the extension `load_unpacked` loaded, or the
// reason it did not load.
using UnpackedLoaded =
    base::OnceCallback<void(base::expected<std::string, std::string>)>;

// Carries out `load_unpacked`: loads the extension in `directory` into the
// shell's profile, where it stays until uninstalled. Runs `loaded` once,
// possibly after returning.
using LoadUnpacked =
    base::FunctionRef<void(const base::FilePath& directory,
                           UnpackedLoaded loaded)>;

// Carries out `uninstall_extension`, or says why it did not.
using UninstallExtension =
    base::FunctionRef<base::expected<void, std::string>(const std::string& id)>;

// Carries out `config_extensions`: the ids the desk's config installed, which
// only the config uninstalls. Returns nothing if there is no shell, and so no
// profile to read.
using ListConfigExtensions =
    base::FunctionRef<std::optional<std::vector<std::string>>()>;

// An extension in the shell's profile, as the Settings app lists it.
struct InstalledExtension {
  InstalledExtension();
  InstalledExtension(const InstalledExtension&);
  InstalledExtension& operator=(const InstalledExtension&);
  ~InstalledExtension();

  std::string id;
  std::string name;
  std::string description;
  std::string version;
  bool enabled = false;
  // Its chrome://extensions settings, each unset where it cannot use it: in
  // private windows where its manifest keeps it out, file access and site
  // access where it asks for no sites, user scripts where it asks for no
  // chrome.userScripts.
  ExtensionSettings settings;
  // Empty when the extension has no options page.
  GURL options_url;
  // The absolute path of its manifest icon closest to 128px, for a list to
  // draw; empty when its manifest names none. A path rather than the image,
  // so listing reads no files.
  std::string icon_path;
};

// Carries out `extensions`: every extension in the shell's profile, apps,
// themes and Chrome's own left out. Returns nothing if there is no shell, and
// so no profile to read.
using ListExtensions =
    base::FunctionRef<std::optional<std::vector<InstalledExtension>>()>;

// Carries out `set_extension_enabled` in browser profile `profile`, the
// shell's own when empty, or says why it did not.
using SetExtensionEnabled =
    base::FunctionRef<base::expected<void, std::string>(
        const std::string& id,
        bool enabled,
        const std::string& profile)>;

// One extension's switch in a browser profile, as `browser_profiles` lists
// it. `locked` when the config switches it, so the user cannot.
struct ListedProfileExtension {
  std::string id;
  bool enabled = false;
  bool locked = false;
};

// A browser profile, as `browser_profiles` lists it.
struct ListedBrowserProfile {
  ListedBrowserProfile();
  ListedBrowserProfile(const ListedBrowserProfile&);
  ListedBrowserProfile& operator=(const ListedBrowserProfile&);
  ~ListedBrowserProfile();

  std::string id;
  std::string name;
  std::string color;
  bool is_private = false;
  std::vector<ListedProfileExtension> extensions;
};

// A site the desk opens in a profile other than the default: the config's
// (`pinned` false), or one the user pinned.
struct ListedBrowserSite {
  std::string site;
  std::string profile;
  bool pinned = false;
};

// Everything `browser_profiles` lists.
struct BrowserProfileList {
  BrowserProfileList();
  BrowserProfileList(const BrowserProfileList&);
  BrowserProfileList& operator=(const BrowserProfileList&);
  ~BrowserProfileList();

  std::vector<ListedBrowserProfile> profiles;
  std::string default_profile;
  std::string default_private_profile;
  std::vector<ListedBrowserSite> sites;
};

// Runs once with what `browser_profiles` lists, or nothing if there is no
// shell, and so no profiles to read.
using BrowserProfilesFound =
    base::OnceCallback<void(std::optional<BrowserProfileList>)>;

// Carries out `browser_profiles`: runs `found` once every profile has
// loaded, so each lists its extensions, possibly after returning.
using ListBrowserProfiles = base::FunctionRef<void(BrowserProfilesFound found)>;

// Carries out `pin_browser_site`: opens `site` in `profile` from now on (the
// default profile unpins it), or says why not.
using PinBrowserSite =
    base::FunctionRef<base::expected<void, std::string>(
        const std::string& site,
        const std::string& profile)>;

// Carries out `configure_extension`: sets each of `settings` that is set, or
// says why it did not.
using ConfigureExtension =
    base::FunctionRef<base::expected<void, std::string>(
        const std::string& id,
        const ExtensionSettings& settings)>;

// A camera or a microphone.
struct MediaDevice {
  // The system's id for it, which Chrome's device preference stores.
  std::string id;
  std::string name;
};

// Each kind's devices, most preferred first. A site that names no device gets
// the first.
struct MediaDeviceList {
  MediaDeviceList();
  MediaDeviceList(const MediaDeviceList&);
  MediaDeviceList& operator=(const MediaDeviceList&);
  ~MediaDeviceList();

  std::vector<MediaDevice> cameras;
  std::vector<MediaDevice> microphones;
};

enum class MediaDeviceKind { kCamera, kMicrophone };

// Runs once when a command that answers later is done, or with why it is not.
using CommandDone = base::OnceCallback<void(base::expected<void, std::string>)>;

// Runs once with what `media_devices` lists, or nothing if there is no shell,
// and so no profile whose preference ranks them.
using MediaDevicesFound =
    base::OnceCallback<void(std::optional<MediaDeviceList>)>;

// Carries out `media_devices`: runs `found` once the devices are listed,
// possibly after returning, as nothing lists them before the first ask.
using ListMediaDevices = base::FunctionRef<void(MediaDevicesFound found)>;

// Carries out `set_media_device`: sites that ask for a `kind` without naming a
// device get `id`. Runs `done` once the devices are listed, with why not when
// there is no such device.
using SetMediaDevice = base::FunctionRef<
    void(MediaDeviceKind kind, const std::string& id, CommandDone done)>;

// What `history` looks for: like `chrome.history.search` from the start of
// time.
struct HistorySearch {
  // Matched against each page's title and address; empty matches every page.
  std::string text;
  // Only visits before this count.
  base::Time end_time;
  int max_results = 0;
};

// A page in the history, as the History app lists it.
struct HistoryEntry {
  HistoryEntry();
  HistoryEntry(const HistoryEntry&);
  HistoryEntry& operator=(const HistoryEntry&);
  ~HistoryEntry();

  GURL url;
  std::string title;
  // The page's cached favicon as a PNG, or empty when there is none.
  std::vector<uint8_t> favicon_png;
};

// Runs once with the pages `history` found, most recently visited first, or
// why it could not look.
using HistoryFound = base::OnceCallback<void(
    base::expected<std::vector<HistoryEntry>, std::string>)>;

// Carries out `history` in the shell's profile. Runs `found` once, possibly
// after returning.
using SearchHistory =
    base::FunctionRef<void(const HistorySearch& search, HistoryFound found)>;

// Runs once with the times of a page's visits, or why it could not look.
using VisitsFound = base::OnceCallback<void(
    base::expected<std::vector<base::Time>, std::string>)>;

// Carries out `visits`: every visit to `url` in the shell's profile. Runs
// `found` once, possibly after returning.
using ListVisits = base::FunctionRef<void(const GURL& url, VisitsFound found)>;

// Carries out `delete_history`: removes the visits at exactly these times, as
// their user would. Runs `done` once, possibly after returning.
using DeleteVisits =
    base::FunctionRef<void(const std::vector<base::Time>& visits,
                           CommandDone done)>;

// The kinds of data `clear_browsing_data` clears, as `chrome.browsingData`
// names them.
enum class BrowsingDataKind {
  kCache,
  kCacheStorage,
  kCookies,
  kDownloads,
  kFileSystems,
  kFormData,
  kHistory,
  kIndexedDB,
  kLocalStorage,
  kPasswords,
  kServiceWorkers,
  kWebSQL,
};

// What `clear_browsing_data` clears.
struct BrowsingDataClearing {
  BrowsingDataClearing();
  BrowsingDataClearing(const BrowsingDataClearing&);
  BrowsingDataClearing& operator=(const BrowsingDataClearing&);
  ~BrowsingDataClearing();

  // Data changed since this; null for all time.
  base::Time since;
  std::vector<BrowsingDataKind> kinds;
  // Only these sites' data, or every site's when empty. Only kinds kept per
  // site may be cleared per site.
  std::vector<url::Origin> origins;
};

// Carries out `clear_browsing_data` in the shell's profile. Runs `done` once,
// possibly after returning.
using ClearBrowsingData =
    base::FunctionRef<void(const BrowsingDataClearing& clearing,
                           CommandDone done)>;

// The data one host stores: cookies, local storage, IndexedDB and the rest.
struct StoredSiteData {
  std::string host;
  // On disk, summed over every kind.
  uint64_t bytes = 0;
  uint64_t cookies = 0;
};

// Runs once with every host that stores data, or why it could not look.
using SiteDataFound = base::OnceCallback<void(
    base::expected<std::vector<StoredSiteData>, std::string>)>;

// Carries out `site_data` in the shell's profile. Runs `found` once, possibly
// after returning.
using ListSiteData = base::FunctionRef<void(SiteDataFound found)>;

// Carries out `clear_site_data`: removes everything `host` stores in the
// shell's profile. Runs `done` once, possibly after returning.
using ClearSiteData =
    base::FunctionRef<void(const std::string& host, CommandDone done)>;

// Carries out `disable_while_typing`: sets whether the touchpads rest while a
// keyboard types when `enabled` has a value, and returns whether they do. Says
// why not where the engine reads no touchpad.
using DisableWhileTyping =
    base::FunctionRef<base::expected<bool, std::string>(
        std::optional<bool> enabled)>;

// The Chrome DevTools Protocol methods `devtools` sends. Page.navigate goes
// only to http and https addresses.
inline constexpr std::string_view kDevToolsMethods[] = {
    "Accessibility.getFullAXTree",
    "Accessibility.getPartialAXTree",
    "Accessibility.queryAXTree",
    "DOM.focus",
    "DOM.getBoxModel",
    "DOM.getContentQuads",
    "DOM.scrollIntoViewIfNeeded",
    "Input.dispatchKeyEvent",
    "Input.dispatchMouseEvent",
    "Input.insertText",
    "Page.captureScreenshot",
    "Page.getLayoutMetrics",
    "Page.getNavigationHistory",
    "Page.navigate",
    "Page.navigateToHistoryEntry",
    "Page.reload",
};

// Runs once with a `devtools` method's result, or why there is none: no such
// window, a private one, or the method's own error.
using DevToolsAnswered =
    base::OnceCallback<void(base::expected<base::DictValue, std::string>)>;

// Carries out `devtools`: sends `method` with `params` to browser window
// `window`'s page. Runs `answered` once, possibly after returning.
using SendDevTools = base::FunctionRef<void(const std::string& window,
                                            const std::string& method,
                                            base::DictValue params,
                                            DevToolsAnswered answered)>;

// Carries out `set_log_levels`: logs at `min_level` and VLOGs at `vmodule` in
// every engine process, and in those started later.
using SetLogLevels =
    base::FunctionRef<void(int min_level, const std::string& vmodule)>;

// What each command does, injected so this file can be tested with strings.
struct CommandActions {
  LoadShell load_shell;
  RunApp run_app;
  OpenUrl open_url;
  HasBrowserProfile has_browser_profile;
  ListSitePermissions list_site_permissions;
  SetSitePermission set_site_permission;
  LoadUnpacked load_unpacked;
  UninstallExtension uninstall_extension;
  ListConfigExtensions list_config_extensions;
  ListExtensions list_extensions;
  SetExtensionEnabled set_extension_enabled;
  ConfigureExtension configure_extension;
  ListBrowserProfiles list_browser_profiles;
  PinBrowserSite pin_browser_site;
  ListMediaDevices list_media_devices;
  SetMediaDevice set_media_device;
  SearchHistory search_history;
  ListVisits list_visits;
  DeleteVisits delete_visits;
  ClearBrowsingData clear_browsing_data;
  ListSiteData list_site_data;
  ClearSiteData clear_site_data;
  DisableWhileTyping disable_while_typing;
  SendDevTools send_devtools;
  SetLogLevels set_log_levels;
};

// Receives the reply line, including its trailing newline.
using CommandReply = base::OnceCallback<void(std::string)>;

// Answers one request line (without its newline). `reply` runs once: before
// this returns, except for `load_shell`, `run_app`, `open_url`,
// `load_unpacked`, `browser_profiles`, `history`, `visits`, `delete_history`,
// `clear_browsing_data`, `site_data`, `clear_site_data` and `devtools`, which
// answer once their action is done.
void AnswerCommand(std::string_view line,
                   const CommandActions& actions,
                   CommandReply reply);

// Returns the refusal reply line for `why`.
//
// Public so the socket can refuse a peer that never ends a line with the same
// reply shape.
std::string RefusedCommand(std::string_view why);

}  // namespace domicile

#endif  // COMPONENTS_DOMICILE_BROWSER_COMMAND_PROTOCOL_H_
