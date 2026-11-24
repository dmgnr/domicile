// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/browser/command_protocol.h"

#include <algorithm>
#include <cmath>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "base/base64.h"
#include "base/check.h"
#include "base/files/file_path.h"
#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/logging.h"
#include "base/numerics/safe_conversions.h"
#include "base/strings/strcat.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/string_util.h"
#include "base/time/time.h"
#include "base/types/expected.h"
#include "base/values.h"
#include "components/domicile/browser/site_permissions.h"

namespace domicile {
namespace {

// The command names.
constexpr char kLoadShell[] = "load_shell";
constexpr char kRunApp[] = "run_app";
constexpr char kOpenUrl[] = "open_url";
constexpr char kListSitePermissionsCommand[] = "site_permissions";
constexpr char kSetSitePermissionCommand[] = "set_site_permission";
constexpr char kLoadUnpacked[] = "load_unpacked";
constexpr char kUninstallExtension[] = "uninstall_extension";
constexpr char kConfigExtensions[] = "config_extensions";
constexpr char kExtensions[] = "extensions";
constexpr char kSetExtensionEnabled[] = "set_extension_enabled";
constexpr char kConfigureExtension[] = "configure_extension";
constexpr char kBrowserProfiles[] = "browser_profiles";
constexpr char kPinBrowserSite[] = "pin_browser_site";
constexpr char kMediaDevices[] = "media_devices";
constexpr char kSetMediaDevice[] = "set_media_device";
constexpr char kHistory[] = "history";
constexpr char kVisits[] = "visits";
constexpr char kDeleteHistory[] = "delete_history";
constexpr char kClearBrowsingData[] = "clear_browsing_data";
constexpr char kSiteData[] = "site_data";
constexpr char kClearSiteData[] = "clear_site_data";
constexpr char kDisableWhileTyping[] = "disable_while_typing";
constexpr char kSetLogLevels[] = "set_log_levels";
constexpr char kDevTools[] = "devtools";

std::string Line(base::DictValue reply) {
  std::string line;
  // Replies hold only strings, finite numbers, booleans, lists and objects,
  // so a write failure is a bug.
  CHECK(base::JSONWriter::Write(reply, &line));
  line.push_back('\n');
  return line;
}

std::string Done(std::string_view type) {
  base::DictValue reply;
  reply.Set("type", type);
  return Line(std::move(reply));
}

void AnswerLoadShell(const base::DictValue& request,
                     LoadShell load_shell,
                     CommandReply reply);
void AnswerRunApp(const base::DictValue& request,
                  RunApp run_app,
                  CommandReply reply);
void AnswerOpenUrl(const base::DictValue& request,
                   OpenUrl open_url,
                   HasBrowserProfile has_browser_profile,
                   CommandReply reply);
void AnswerOpened(const std::string& refusal, CommandReply reply, bool opened);
std::string AnswerSitePermissions(ListSitePermissions list_site_permissions);
std::string AnswerSetSitePermission(const base::DictValue& request,
                                    SetSitePermission set_site_permission);
void AnswerLoadUnpacked(const base::DictValue& request,
                        LoadUnpacked load_unpacked,
                        CommandReply reply);
std::string AnswerUninstallExtension(const base::DictValue& request,
                                     UninstallExtension uninstall_extension);
std::string AnswerConfigExtensions(
    ListConfigExtensions list_config_extensions);
std::string AnswerExtensions(ListExtensions list_extensions);
std::string AnswerSetExtensionEnabled(const base::DictValue& request,
                                      SetExtensionEnabled set_extension_enabled);
std::string AnswerConfigureExtension(const base::DictValue& request,
                                     ConfigureExtension configure_extension);
std::string BrowserProfilesLine(const std::optional<BrowserProfileList>& list);
void AnswerBrowserProfiles(ListBrowserProfiles list_browser_profiles,
                           CommandReply reply);
std::string AnswerPinBrowserSite(const base::DictValue& request,
                                 PinBrowserSite pin_browser_site);
CommandDone ReplyWhenDone(std::string_view type, CommandReply reply);
void AnswerMediaDevices(ListMediaDevices list_media_devices,
                        CommandReply reply);
void AnswerSetMediaDevice(const base::DictValue& request,
                          SetMediaDevice set_media_device,
                          CommandReply reply);
void AnswerHistory(const base::DictValue& request,
                   SearchHistory search_history,
                   CommandReply reply);
void AnswerVisits(const base::DictValue& request,
                  ListVisits list_visits,
                  CommandReply reply);
void AnswerDeleteHistory(const base::DictValue& request,
                         DeleteVisits delete_visits,
                         CommandReply reply);
void AnswerClearBrowsingData(const base::DictValue& request,
                             ClearBrowsingData clear_browsing_data,
                             CommandReply reply);
void AnswerSiteData(ListSiteData list_site_data, CommandReply reply);
void AnswerClearSiteData(const base::DictValue& request,
                         ClearSiteData clear_site_data,
                         CommandReply reply);
std::string AnswerDisableWhileTyping(const base::DictValue& request,
                                     DisableWhileTyping disable_while_typing);
std::string AnswerSetLogLevels(const base::DictValue& request,
                               SetLogLevels set_log_levels);
void AnswerDevTools(const base::DictValue& request,
                    SendDevTools send_devtools,
                    CommandReply reply);

}  // namespace

ListedBrowserProfile::ListedBrowserProfile() = default;
ListedBrowserProfile::ListedBrowserProfile(const ListedBrowserProfile&) =
    default;
ListedBrowserProfile& ListedBrowserProfile::operator=(
    const ListedBrowserProfile&) = default;
ListedBrowserProfile::~ListedBrowserProfile() = default;

BrowserProfileList::BrowserProfileList() = default;
BrowserProfileList::BrowserProfileList(const BrowserProfileList&) = default;
BrowserProfileList& BrowserProfileList::operator=(const BrowserProfileList&) =
    default;
BrowserProfileList::~BrowserProfileList() = default;

SitePermissionList::SitePermissionList() = default;
SitePermissionList::SitePermissionList(const SitePermissionList&) = default;
SitePermissionList& SitePermissionList::operator=(const SitePermissionList&) =
    default;
SitePermissionList::~SitePermissionList() = default;

InstalledExtension::InstalledExtension() = default;
InstalledExtension::InstalledExtension(const InstalledExtension&) = default;
InstalledExtension& InstalledExtension::operator=(const InstalledExtension&) =
    default;
InstalledExtension::~InstalledExtension() = default;

MediaDeviceList::MediaDeviceList() = default;
MediaDeviceList::MediaDeviceList(const MediaDeviceList&) = default;
MediaDeviceList& MediaDeviceList::operator=(const MediaDeviceList&) = default;
MediaDeviceList::~MediaDeviceList() = default;

HistoryEntry::HistoryEntry() = default;
HistoryEntry::HistoryEntry(const HistoryEntry&) = default;
HistoryEntry& HistoryEntry::operator=(const HistoryEntry&) = default;
HistoryEntry::~HistoryEntry() = default;

BrowsingDataClearing::BrowsingDataClearing() = default;
BrowsingDataClearing::BrowsingDataClearing(const BrowsingDataClearing&) =
    default;
BrowsingDataClearing& BrowsingDataClearing::operator=(
    const BrowsingDataClearing&) = default;
BrowsingDataClearing::~BrowsingDataClearing() = default;

std::string RefusedCommand(std::string_view why) {
  base::DictValue reply;
  reply.Set("type", "refused");
  reply.Set("why", why);
  return Line(std::move(reply));
}

void AnswerCommand(std::string_view line,
                   const CommandActions& actions,
                   CommandReply reply) {
  const std::optional<base::DictValue> request =
      base::JSONReader::ReadDict(line, base::JSON_PARSE_RFC);
  if (!request) {
    std::move(reply).Run(RefusedCommand(
        "a command is one JSON object on one line, and this is not one"));
    return;
  }

  // Check the version before `type`: an unknown version means the rest of the
  // request cannot be trusted either.
  const std::optional<int> version = request->FindInt("version");
  if (version != kCommandVersion) {
    std::move(reply).Run(RefusedCommand(base::StrCat(
        {"this engine speaks version ", base::NumberToString(kCommandVersion),
         " of the command protocol and the request says ",
         version ? base::NumberToString(*version) : std::string("nothing"),
         ". The supervisor and the engine are published separately, so this "
         "is two different releases talking rather than a typo: "
         "packages/domicile-engine/engine-release.nix is which engine this "
         "desktop is running."})));
    return;
  }

  const std::string* type = request->FindString("type");
  if (type == nullptr) {
    std::move(reply).Run(RefusedCommand("a command needs a \"type\""));
    return;
  }
  if (*type == kLoadShell) {
    AnswerLoadShell(*request, actions.load_shell, std::move(reply));
    return;
  }
  if (*type == kRunApp) {
    AnswerRunApp(*request, actions.run_app, std::move(reply));
    return;
  }
  if (*type == kOpenUrl) {
    AnswerOpenUrl(*request, actions.open_url, actions.has_browser_profile,
                  std::move(reply));
    return;
  }
  if (*type == kListSitePermissionsCommand) {
    std::move(reply).Run(AnswerSitePermissions(actions.list_site_permissions));
    return;
  }
  if (*type == kSetSitePermissionCommand) {
    std::move(reply).Run(
        AnswerSetSitePermission(*request, actions.set_site_permission));
    return;
  }
  if (*type == kLoadUnpacked) {
    AnswerLoadUnpacked(*request, actions.load_unpacked, std::move(reply));
    return;
  }
  if (*type == kUninstallExtension) {
    std::move(reply).Run(
        AnswerUninstallExtension(*request, actions.uninstall_extension));
    return;
  }
  if (*type == kConfigExtensions) {
    std::move(reply).Run(
        AnswerConfigExtensions(actions.list_config_extensions));
    return;
  }
  if (*type == kExtensions) {
    std::move(reply).Run(AnswerExtensions(actions.list_extensions));
    return;
  }
  if (*type == kSetExtensionEnabled) {
    std::move(reply).Run(
        AnswerSetExtensionEnabled(*request, actions.set_extension_enabled));
    return;
  }
  if (*type == kConfigureExtension) {
    std::move(reply).Run(
        AnswerConfigureExtension(*request, actions.configure_extension));
    return;
  }
  if (*type == kBrowserProfiles) {
    AnswerBrowserProfiles(actions.list_browser_profiles, std::move(reply));
    return;
  }
  if (*type == kPinBrowserSite) {
    std::move(reply).Run(
        AnswerPinBrowserSite(*request, actions.pin_browser_site));
    return;
  }
  if (*type == kMediaDevices) {
    AnswerMediaDevices(actions.list_media_devices, std::move(reply));
    return;
  }
  if (*type == kSetMediaDevice) {
    AnswerSetMediaDevice(*request, actions.set_media_device, std::move(reply));
    return;
  }
  if (*type == kHistory) {
    AnswerHistory(*request, actions.search_history, std::move(reply));
    return;
  }
  if (*type == kVisits) {
    AnswerVisits(*request, actions.list_visits, std::move(reply));
    return;
  }
  if (*type == kDeleteHistory) {
    AnswerDeleteHistory(*request, actions.delete_visits, std::move(reply));
    return;
  }
  if (*type == kClearBrowsingData) {
    AnswerClearBrowsingData(*request, actions.clear_browsing_data,
                            std::move(reply));
    return;
  }
  if (*type == kSiteData) {
    AnswerSiteData(actions.list_site_data, std::move(reply));
    return;
  }
  if (*type == kClearSiteData) {
    AnswerClearSiteData(*request, actions.clear_site_data, std::move(reply));
    return;
  }
  if (*type == kDisableWhileTyping) {
    std::move(reply).Run(
        AnswerDisableWhileTyping(*request, actions.disable_while_typing));
    return;
  }
  if (*type == kDevTools) {
    AnswerDevTools(*request, actions.send_devtools, std::move(reply));
    return;
  }
  if (*type == kSetLogLevels) {
    std::move(reply).Run(AnswerSetLogLevels(*request, actions.set_log_levels));
    return;
  }
  std::move(reply).Run(RefusedCommand(base::StrCat(
      {"\"", *type, "\" is not a command this engine knows; it takes \"",
       kLoadShell, "\", \"", kRunApp, "\", \"", kOpenUrl, "\", \"",
       kListSitePermissionsCommand,
       "\", \"", kSetSitePermissionCommand, "\", \"", kLoadUnpacked, "\", \"",
       kUninstallExtension, "\", \"", kConfigExtensions, "\", \"",
       kExtensions, "\", \"", kSetExtensionEnabled, "\", \"",
       kConfigureExtension, "\", \"",
       kMediaDevices, "\", \"", kSetMediaDevice, "\", \"", kHistory, "\", \"",
       kVisits, "\", \"", kDeleteHistory, "\", \"", kClearBrowsingData,
       "\", \"", kSiteData, "\", \"", kClearSiteData, "\", \"",
       kDisableWhileTyping, "\", \"", kDevTools, "\" and \"", kSetLogLevels,
       "\""})));
}

namespace {

void AnswerLoadShell(const base::DictValue& request,
                     LoadShell load_shell,
                     CommandReply reply) {
  // Requires both `root` and `module`: changing only one would serve a 404 or
  // the wrong shell.
  const std::string* root = request.FindString("root");
  if (root == nullptr || root->empty()) {
    std::move(reply).Run(RefusedCommand(
        "load_shell needs a \"root\": the directory the shell is served out "
        "of"));
    return;
  }
  const base::FilePath shell_root = base::FilePath::FromUTF8Unsafe(*root);
  if (!shell_root.IsAbsolute()) {
    std::move(reply).Run(RefusedCommand(base::StrCat(
        {"\"", *root,
         "\" is not an absolute path. The root is resolved in the engine's "
         "process, whose working directory the sender does not know -- a "
         "relative one would serve some other directory without saying so."})));
    return;
  }

  const std::string* module = request.FindString("module");
  if (module == nullptr || module->empty()) {
    std::move(reply).Run(RefusedCommand(
        "load_shell needs a \"module\": the one JavaScript file a shell is, "
        "as a name under \"root\""));
    return;
  }

  // Left out is a directory. Anything but a boolean is refused rather than
  // read as one, so a sender's mistake does not serve a socket as a
  // directory.
  ShellFiles files = ShellFiles::kDirectory;
  if (const base::Value* dev_server = request.Find("dev_server")) {
    if (!dev_server->is_bool()) {
      std::move(reply).Run(RefusedCommand(
          "load_shell's \"dev_server\" says whether the root is a dev "
          "server's socket: true or false"));
      return;
    }
    files = dev_server->GetBool() ? ShellFiles::kDevServer
                                  : ShellFiles::kDirectory;
  }

  // The root and module are not checked here. `domicile load-shell` validates
  // the path first (`shell_path` in domicile-launch), and a module that fails
  // to run is refused once the page says so.
  load_shell(shell_root, *module, files,
             base::BindOnce(
                 [](CommandReply reply,
                    base::expected<void, std::string> loaded) {
                   std::move(reply).Run(loaded.has_value()
                                            ? Done("loaded")
                                            : RefusedCommand(loaded.error()));
                 },
                 std::move(reply)));
}

void AnswerRunApp(const base::DictValue& request,
                  RunApp run_app,
                  CommandReply reply) {
  const std::string* root = request.FindString("root");
  const std::string* module = request.FindString("module");
  if (root == nullptr || module == nullptr || module->empty()) {
    std::move(reply).Run(RefusedCommand(
        "run_app needs a \"root\", the directory the app is served out of, "
        "and a \"module\", its entry as a name under the root"));
    return;
  }
  // Absolute for load_shell's reason. `domicile run-app` resolves the path and
  // makes it canonical, so one directory is one app.
  const base::FilePath app_root = base::FilePath::FromUTF8Unsafe(*root);
  if (!app_root.IsAbsolute()) {
    std::move(reply).Run(RefusedCommand(
        base::StrCat({"\"", *root, "\" is not an absolute path"})));
    return;
  }
  run_app(app_root, *module,
          base::BindOnce(
              &AnswerOpened,
              std::string("this engine has no shell page to open an app in"),
              std::move(reply)));
}

// `open_url`'s app window, from `app_id` and `reuse`: nothing for a browser
// window, which may have neither, or why the request is refused. Both are
// optional, so a supervisor older than them is still understood.
base::expected<std::optional<AppLaunch>, std::string> AppLaunchIn(
    const base::DictValue& request,
    bool is_app) {
  const base::Value* id = request.Find("app_id");
  const base::Value* reuse = request.Find("reuse");
  if (!is_app) {
    if (id != nullptr || reuse != nullptr) {
      return base::unexpected(
          "open_url's \"app_id\" and \"reuse\" are for an app window "
          "(\"app\":true)");
    }
    return std::nullopt;
  }
  if (id != nullptr && !id->is_string()) {
    return base::unexpected("open_url's \"app_id\" is a string");
  }
  AppLaunch launch;
  if (id != nullptr) {
    launch.id = id->GetString();
  }
  if (reuse == nullptr) {
    return launch;
  }
  const std::string* named = reuse->GetIfString();
  if (named != nullptr && *named == "new") {
    launch.reuse = mojom::AppReuse::kNew;
  } else if (named != nullptr && *named == "focus") {
    launch.reuse = mojom::AppReuse::kFocus;
  } else if (named != nullptr && *named == "navigate") {
    launch.reuse = mojom::AppReuse::kNavigate;
  } else {
    return base::unexpected(
        "open_url's \"reuse\" is \"new\", \"focus\" or \"navigate\"");
  }
  if (launch.reuse != mojom::AppReuse::kNew && launch.id.empty()) {
    return base::unexpected(
        "open_url's \"reuse\" needs an \"app_id\" to find the window by");
  }
  return launch;
}

void AnswerOpenUrl(const base::DictValue& request,
                   OpenUrl open_url,
                   HasBrowserProfile has_browser_profile,
                   CommandReply reply) {
  const std::string* url = request.FindString("url");
  if (url == nullptr) {
    std::move(reply).Run(
        RefusedCommand("open_url needs a \"url\": the address to open"));
    return;
  }
  // Validated here so an invalid URL is refused instead of opening an empty
  // window and reporting success.
  const GURL parsed(*url);
  if (!parsed.is_valid()) {
    std::move(reply).Run(RefusedCommand(
        base::StrCat({"\"", *url, "\" is not a URL this engine can open"})));
    return;
  }
  // Optional, so a supervisor older than app windows is still understood.
  const base::Value* app = request.Find("app");
  if (app != nullptr && !app->is_bool()) {
    std::move(reply).Run(RefusedCommand(
        "open_url's \"app\" is true for an app window or false for a "
        "browser window"));
    return;
  }
  const bool is_app = app != nullptr && app->GetBool();
  const base::expected<std::optional<AppLaunch>, std::string> launch =
      AppLaunchIn(request, is_app);
  if (!launch.has_value()) {
    std::move(reply).Run(RefusedCommand(launch.error()));
    return;
  }
  // Optional: none is the profile the site opens in.
  const base::Value* profile = request.Find("profile");
  if (profile != nullptr &&
      (!profile->is_string() || profile->GetString().empty())) {
    std::move(reply).Run(RefusedCommand(
        "open_url's \"profile\" is the id of a browser profile"));
    return;
  }
  if (profile != nullptr && !has_browser_profile(profile->GetString())) {
    std::move(reply).Run(RefusedCommand(base::StrCat(
        {"the desk has no browser profile \"", profile->GetString(),
         "\"; the config's browser.profiles names them"})));
    return;
  }
  open_url(
      parsed, *launch,
      profile != nullptr ? profile->GetString() : std::string(),
      base::BindOnce(&AnswerOpened,
                     std::string("this engine has no shell page to open it in"),
                     std::move(reply)));
}

// Replies to `run_app` or `open_url` once its window opened, or with
// `refusal` when there was no shell to own it.
void AnswerOpened(const std::string& refusal, CommandReply reply, bool opened) {
  std::move(reply).Run(opened ? Done("opened") : RefusedCommand(refusal));
}

std::string AnswerSitePermissions(ListSitePermissions list_site_permissions) {
  const std::optional<SitePermissionList> list = list_site_permissions();
  if (!list) {
    return RefusedCommand(
        "this engine has no shell, and so no profile whose site permissions "
        "to list");
  }
  base::DictValue defaults;
  for (const auto& [permission, setting] : list->defaults) {
    defaults.Set(PermissionName(permission), SettingName(setting));
  }
  base::ListValue sites;
  for (const StoredSitePermission& site : list->sites) {
    base::DictValue entry;
    entry.Set("origin", site.origin.Serialize());
    entry.Set("permission", PermissionName(site.permission));
    entry.Set("setting", SettingName(site.setting));
    sites.Append(std::move(entry));
  }
  base::DictValue reply;
  reply.Set("type", kListSitePermissionsCommand);
  reply.Set("defaults", std::move(defaults));
  reply.Set("sites", std::move(sites));
  return Line(std::move(reply));
}

std::string AnswerSetSitePermission(const base::DictValue& request,
                                    SetSitePermission set_site_permission) {
  const std::string* origin = request.FindString("origin");
  const std::string* permission_name = request.FindString("permission");
  const std::string* setting_name = request.FindString("setting");
  if (origin == nullptr || permission_name == nullptr ||
      setting_name == nullptr) {
    return RefusedCommand(
        "set_site_permission needs an \"origin\", a \"permission\" and a "
        "\"setting\"");
  }
  const GURL site(*origin);
  if (!site.is_valid() || !HasSitePermissions(site)) {
    return RefusedCommand(base::StrCat(
        {"\"", *origin,
         "\" is not a site: only http, https and extension pages have site "
         "permissions"}));
  }
  const std::optional<mojom::WebViewPermission> permission =
      PermissionNamed(*permission_name);
  if (!permission) {
    return RefusedCommand(
        base::StrCat({"\"", *permission_name,
                      "\" is not a permission a site is asked for"}));
  }
  const std::optional<mojom::WebViewPermissionSetting> setting =
      SettingNamed(*setting_name);
  if (!setting) {
    return RefusedCommand(base::StrCat(
        {"\"", *setting_name,
         "\" is not a setting; a site permission is \"ask\", \"allow\" or "
         "\"block\""}));
  }
  if (!set_site_permission(url::Origin::Create(site), *permission, *setting)) {
    return RefusedCommand(
        "this engine has no shell, and so no profile to store the setting in");
  }
  return Done("set");
}

void AnswerLoadUnpacked(const base::DictValue& request,
                        LoadUnpacked load_unpacked,
                        CommandReply reply) {
  const std::string* directory = request.FindString("directory");
  if (directory == nullptr || directory->empty()) {
    std::move(reply).Run(RefusedCommand(
        "load_unpacked needs a \"directory\": the folder holding the "
        "extension's manifest.json"));
    return;
  }
  const base::FilePath path = base::FilePath::FromUTF8Unsafe(*directory);
  if (!path.IsAbsolute()) {
    std::move(reply).Run(RefusedCommand(base::StrCat(
        {"\"", *directory,
         "\" is not an absolute path, and the engine's working directory is "
         "not the sender's"})));
    return;
  }
  load_unpacked(
      path, base::BindOnce(
                [](CommandReply reply,
                   base::expected<std::string, std::string> loaded) {
                  if (!loaded.has_value()) {
                    std::move(reply).Run(RefusedCommand(loaded.error()));
                    return;
                  }
                  base::DictValue done;
                  done.Set("type", "loaded_unpacked");
                  done.Set("id", loaded.value());
                  std::move(reply).Run(Line(std::move(done)));
                },
                std::move(reply)));
}

// Whether `id` is an extension id: 32 letters from a to p.
bool IsExtensionId(std::string_view id) {
  return id.size() == 32 &&
         std::ranges::all_of(id, [](char c) { return c >= 'a' && c <= 'p'; });
}

std::string AnswerUninstallExtension(const base::DictValue& request,
                                     UninstallExtension uninstall_extension) {
  const std::string* id = request.FindString("id");
  if (id == nullptr) {
    return RefusedCommand(
        "uninstall_extension needs an \"id\": the extension to uninstall");
  }
  if (!IsExtensionId(*id)) {
    return RefusedCommand(base::StrCat(
        {"\"", *id,
         "\" is not an extension id, which is 32 letters from a to p"}));
  }
  const base::expected<void, std::string> uninstalled =
      uninstall_extension(*id);
  if (!uninstalled.has_value()) {
    return RefusedCommand(uninstalled.error());
  }
  return Done("uninstalled");
}

std::string AnswerConfigExtensions(
    ListConfigExtensions list_config_extensions) {
  const std::optional<std::vector<std::string>> ids = list_config_extensions();
  if (!ids) {
    return RefusedCommand(
        "this engine has no shell, and so no profile whose extensions to "
        "list");
  }
  base::ListValue listed;
  for (const std::string& id : *ids) {
    listed.Append(id);
  }
  base::DictValue reply;
  reply.Set("type", kConfigExtensions);
  reply.Set("ids", std::move(listed));
  return Line(std::move(reply));
}

std::string AnswerExtensions(ListExtensions list_extensions) {
  const std::optional<std::vector<InstalledExtension>> extensions =
      list_extensions();
  if (!extensions) {
    return RefusedCommand(
        "this engine has no shell, and so no profile whose extensions to "
        "list");
  }
  base::ListValue listed;
  for (const InstalledExtension& extension : *extensions) {
    base::DictValue entry;
    entry.Set("id", extension.id);
    entry.Set("name", extension.name);
    entry.Set("description", extension.description);
    entry.Set("version", extension.version);
    entry.Set("enabled", extension.enabled);
    entry.Set("settings", OneExtensionSettingsValue(extension.settings));
    if (extension.options_url.is_valid()) {
      entry.Set("options_url", extension.options_url.spec());
    }
    if (!extension.icon_path.empty()) {
      entry.Set("icon_path", extension.icon_path);
    }
    listed.Append(std::move(entry));
  }
  base::DictValue reply;
  reply.Set("type", kExtensions);
  reply.Set("extensions", std::move(listed));
  return Line(std::move(reply));
}

std::string AnswerSetExtensionEnabled(
    const base::DictValue& request,
    SetExtensionEnabled set_extension_enabled) {
  const std::string* id = request.FindString("id");
  const std::optional<bool> enabled = request.FindBool("enabled");
  if (id == nullptr || !enabled) {
    return RefusedCommand(
        "set_extension_enabled needs an \"id\" and whether it is "
        "\"enabled\"");
  }
  const base::Value* profile = request.Find("profile");
  if (profile != nullptr && !profile->is_string()) {
    return RefusedCommand(
        "set_extension_enabled's \"profile\" is a browser profile's id");
  }
  const base::expected<void, std::string> set = set_extension_enabled(
      *id, *enabled, profile == nullptr ? std::string() : profile->GetString());
  if (!set.has_value()) {
    return RefusedCommand(set.error());
  }
  return Done("set");
}

std::string BrowserProfilesLine(const std::optional<BrowserProfileList>& list) {
  if (!list) {
    return RefusedCommand(
        "this engine has no shell, and so no browser profiles to list");
  }
  base::ListValue profiles;
  for (const ListedBrowserProfile& profile : list->profiles) {
    base::ListValue extensions;
    for (const ListedProfileExtension& extension : profile.extensions) {
      base::DictValue entry;
      entry.Set("id", extension.id);
      entry.Set("enabled", extension.enabled);
      entry.Set("locked", extension.locked);
      extensions.Append(std::move(entry));
    }
    base::DictValue entry;
    entry.Set("id", profile.id);
    entry.Set("name", profile.name);
    entry.Set("color", profile.color);
    entry.Set("private", profile.is_private);
    entry.Set("extensions", std::move(extensions));
    profiles.Append(std::move(entry));
  }
  base::ListValue sites;
  for (const ListedBrowserSite& site : list->sites) {
    base::DictValue entry;
    entry.Set("site", site.site);
    entry.Set("profile", site.profile);
    entry.Set("pinned", site.pinned);
    sites.Append(std::move(entry));
  }
  base::DictValue reply;
  reply.Set("type", kBrowserProfiles);
  reply.Set("default_profile", list->default_profile);
  reply.Set("default_private_profile", list->default_private_profile);
  reply.Set("profiles", std::move(profiles));
  reply.Set("sites", std::move(sites));
  return Line(std::move(reply));
}

void AnswerBrowserProfiles(ListBrowserProfiles list_browser_profiles,
                           CommandReply reply) {
  list_browser_profiles(base::BindOnce(
      [](CommandReply reply, std::optional<BrowserProfileList> list) {
        std::move(reply).Run(BrowserProfilesLine(list));
      },
      std::move(reply)));
}

std::string AnswerPinBrowserSite(const base::DictValue& request,
                                 PinBrowserSite pin_browser_site) {
  const std::string* site = request.FindString("site");
  const std::string* profile = request.FindString("profile");
  if (site == nullptr || profile == nullptr) {
    return RefusedCommand(
        "pin_browser_site needs a \"site\" and the \"profile\" to open it "
        "in");
  }
  const base::expected<void, std::string> pinned =
      pin_browser_site(*site, *profile);
  if (!pinned.has_value()) {
    return RefusedCommand(pinned.error());
  }
  return Done("set");
}

std::string AnswerConfigureExtension(const base::DictValue& request,
                                     ConfigureExtension configure_extension) {
  const std::string* id = request.FindString("id");
  const base::DictValue* settings = request.FindDict("settings");
  if (id == nullptr || settings == nullptr) {
    return RefusedCommand(
        "configure_extension needs an \"id\" and the \"settings\" to set");
  }
  const std::optional<ExtensionSettings> read =
      ParseOneExtensionSettings(*settings);
  if (!read) {
    return RefusedCommand(
        "configure_extension's \"settings\" takes \"file_access\" and "
        "\"user_scripts\" as booleans, and \"site_access\" as "
        "\"on_click\", \"all_sites\" or a list of hosts");
  }
  // Private windows are a private browser profile's, whose switches say
  // which extensions run in them.
  if (read->in_private.has_value()) {
    return RefusedCommand(
        "configure_extension has no \"private\": switch the extension in "
        "a private browser profile instead");
  }
  const base::expected<void, std::string> set =
      configure_extension(*id, *read);
  if (!set.has_value()) {
    return RefusedCommand(set.error());
  }
  return Done("set");
}

base::ListValue DeviceEntries(const std::vector<MediaDevice>& devices) {
  base::ListValue entries;
  for (const MediaDevice& device : devices) {
    base::DictValue entry;
    entry.Set("id", device.id);
    entry.Set("name", device.name);
    entries.Append(std::move(entry));
  }
  return entries;
}

std::string MediaDevicesLine(const std::optional<MediaDeviceList>& list) {
  if (!list) {
    return RefusedCommand(
        "this engine has no shell, and so no profile whose media devices to "
        "list");
  }
  base::DictValue reply;
  reply.Set("type", kMediaDevices);
  reply.Set("cameras", DeviceEntries(list->cameras));
  reply.Set("microphones", DeviceEntries(list->microphones));
  return Line(std::move(reply));
}

void AnswerMediaDevices(ListMediaDevices list_media_devices,
                        CommandReply reply) {
  list_media_devices(base::BindOnce(
      [](CommandReply reply, std::optional<MediaDeviceList> list) {
        std::move(reply).Run(MediaDevicesLine(list));
      },
      std::move(reply)));
}

std::optional<MediaDeviceKind> MediaDeviceKindNamed(std::string_view name) {
  if (name == "camera") {
    return MediaDeviceKind::kCamera;
  }
  if (name == "microphone") {
    return MediaDeviceKind::kMicrophone;
  }
  return std::nullopt;
}

void AnswerSetMediaDevice(const base::DictValue& request,
                          SetMediaDevice set_media_device,
                          CommandReply reply) {
  const std::string* kind_name = request.FindString("kind");
  const std::string* id = request.FindString("id");
  if (kind_name == nullptr || id == nullptr) {
    std::move(reply).Run(RefusedCommand(
        "set_media_device needs a \"kind\" and an \"id\": the device sites "
        "get when they name none"));
    return;
  }
  const std::optional<MediaDeviceKind> kind = MediaDeviceKindNamed(*kind_name);
  if (!kind) {
    std::move(reply).Run(RefusedCommand(
        base::StrCat({"\"", *kind_name,
                      "\" is not a kind of device; it is \"camera\" or "
                      "\"microphone\""})));
    return;
  }
  set_media_device(*kind, *id, ReplyWhenDone("set", std::move(reply)));
}

// The time `ms` milliseconds after the Unix epoch, to the nearest microsecond.
//
// A double holds a visit's fractional milliseconds only to within a fraction
// of a microsecond, and `base::Milliseconds` would truncate that to the
// microsecond before.
base::Time TimeFromWire(double ms) {
  return base::Time::UnixEpoch() + base::Microseconds(std::round(ms * 1000));
}

// Answers `reply` with `type` once `done` says the action is done, or with
// why it is not.
CommandDone ReplyWhenDone(std::string_view type, CommandReply reply) {
  return base::BindOnce(
      [](std::string type, CommandReply reply,
         base::expected<void, std::string> done) {
        std::move(reply).Run(done.has_value() ? Done(type)
                                              : RefusedCommand(done.error()));
      },
      std::string(type), std::move(reply));
}

void AnswerHistory(const base::DictValue& request,
                   SearchHistory search_history,
                   CommandReply reply) {
  const std::string* text = request.FindString("text");
  const std::optional<double> end_time = request.FindDouble("end_time");
  const std::optional<int> max_results = request.FindInt("max_results");
  if (text == nullptr || !end_time || !max_results || *max_results < 1) {
    std::move(reply).Run(RefusedCommand(
        "history needs the \"text\" to match, an \"end_time\" the visits are "
        "before and how many \"max_results\", at least 1"));
    return;
  }
  search_history(
      {.text = *text,
       .end_time = TimeFromWire(*end_time),
       .max_results = *max_results},
      base::BindOnce(
          [](CommandReply reply,
             base::expected<std::vector<HistoryEntry>, std::string> found) {
            if (!found.has_value()) {
              std::move(reply).Run(RefusedCommand(found.error()));
              return;
            }
            base::ListValue items;
            for (const HistoryEntry& entry : found.value()) {
              base::DictValue item;
              item.Set("url", entry.url.spec());
              item.Set("title", entry.title);
              if (!entry.favicon_png.empty()) {
                item.Set("favicon",
                         base::StrCat({"data:image/png;base64,",
                                       base::Base64Encode(entry.favicon_png)}));
              }
              items.Append(std::move(item));
            }
            base::DictValue done;
            done.Set("type", kHistory);
            done.Set("items", std::move(items));
            std::move(reply).Run(Line(std::move(done)));
          },
          std::move(reply)));
}

void AnswerVisits(const base::DictValue& request,
                  ListVisits list_visits,
                  CommandReply reply) {
  const std::string* url = request.FindString("url");
  if (url == nullptr) {
    std::move(reply).Run(RefusedCommand(
        "visits needs a \"url\": the page whose visits to list"));
    return;
  }
  const GURL page(*url);
  if (!page.is_valid()) {
    std::move(reply).Run(
        RefusedCommand(base::StrCat({"\"", *url, "\" is not a URL"})));
    return;
  }
  list_visits(
      page,
      base::BindOnce(
          [](CommandReply reply,
             base::expected<std::vector<base::Time>, std::string> found) {
            if (!found.has_value()) {
              std::move(reply).Run(RefusedCommand(found.error()));
              return;
            }
            base::ListValue times;
            for (const base::Time& visit : found.value()) {
              times.Append(visit.InMillisecondsFSinceUnixEpoch());
            }
            base::DictValue done;
            done.Set("type", kVisits);
            done.Set("times", std::move(times));
            std::move(reply).Run(Line(std::move(done)));
          },
          std::move(reply)));
}

// The times in `list`, or nothing if it holds anything but numbers.
std::optional<std::vector<base::Time>> TimesIn(const base::ListValue& list) {
  std::vector<base::Time> times;
  for (const base::Value& value : list) {
    const std::optional<double> ms = value.GetIfDouble();
    if (!ms) {
      return std::nullopt;
    }
    times.push_back(TimeFromWire(*ms));
  }
  return times;
}

void AnswerDeleteHistory(const base::DictValue& request,
                         DeleteVisits delete_visits,
                         CommandReply reply) {
  const base::ListValue* visits = request.FindList("visits");
  const std::optional<std::vector<base::Time>> times =
      visits == nullptr ? std::nullopt : TimesIn(*visits);
  if (!times) {
    std::move(reply).Run(RefusedCommand(
        "delete_history needs the \"visits\" to delete, as a list of their "
        "times"));
    return;
  }
  delete_visits(*times, ReplyWhenDone("deleted", std::move(reply)));
}

std::optional<BrowsingDataKind> BrowsingDataKindNamed(std::string_view name) {
  static constexpr std::pair<std::string_view, BrowsingDataKind> kNames[] = {
      {"cache", BrowsingDataKind::kCache},
      {"cacheStorage", BrowsingDataKind::kCacheStorage},
      {"cookies", BrowsingDataKind::kCookies},
      {"downloads", BrowsingDataKind::kDownloads},
      {"fileSystems", BrowsingDataKind::kFileSystems},
      {"formData", BrowsingDataKind::kFormData},
      {"history", BrowsingDataKind::kHistory},
      {"indexedDB", BrowsingDataKind::kIndexedDB},
      {"localStorage", BrowsingDataKind::kLocalStorage},
      {"passwords", BrowsingDataKind::kPasswords},
      {"serviceWorkers", BrowsingDataKind::kServiceWorkers},
      {"webSQL", BrowsingDataKind::kWebSQL},
  };
  for (const auto& [kind_name, kind] : kNames) {
    if (kind_name == name) {
      return kind;
    }
  }
  return std::nullopt;
}

// Whether `kind` is kept per site, and so can be cleared for some sites only.
// The rest are kept per visit or per form.
bool IsKeptPerSite(BrowsingDataKind kind) {
  switch (kind) {
    case BrowsingDataKind::kCache:
    case BrowsingDataKind::kCacheStorage:
    case BrowsingDataKind::kCookies:
    case BrowsingDataKind::kFileSystems:
    case BrowsingDataKind::kIndexedDB:
    case BrowsingDataKind::kLocalStorage:
    case BrowsingDataKind::kServiceWorkers:
    case BrowsingDataKind::kWebSQL:
      return true;
    case BrowsingDataKind::kDownloads:
    case BrowsingDataKind::kFormData:
    case BrowsingDataKind::kHistory:
    case BrowsingDataKind::kPasswords:
      return false;
  }
}

// What a `clear_browsing_data` request clears, or why it cannot be cleared.
base::expected<BrowsingDataClearing, std::string> ClearingIn(
    const base::DictValue& request) {
  const std::optional<double> since = request.FindDouble("since");
  const base::ListValue* types = request.FindList("types");
  if (!since || types == nullptr) {
    return base::unexpected(
        "clear_browsing_data needs a \"since\", 0 for all time, and the "
        "\"types\" to clear");
  }
  BrowsingDataClearing clearing;
  // 0 is all time, as for `chrome.browsingData`.
  clearing.since = *since == 0 ? base::Time() : TimeFromWire(*since);
  for (const base::Value& type : *types) {
    const std::string* name = type.GetIfString();
    if (name == nullptr) {
      return base::unexpected("clear_browsing_data's \"types\" are strings");
    }
    const std::optional<BrowsingDataKind> kind = BrowsingDataKindNamed(*name);
    if (!kind) {
      return base::unexpected(base::StrCat(
          {"\"", *name,
           "\" is not a type of browsing data; they are \"cache\", "
           "\"cacheStorage\", \"cookies\", \"downloads\", \"fileSystems\", "
           "\"formData\", \"history\", \"indexedDB\", \"localStorage\", "
           "\"passwords\", \"serviceWorkers\" and \"webSQL\""}));
    }
    clearing.kinds.push_back(*kind);
  }

  // Optional: without it, every site's data is cleared.
  const base::Value* origins = request.Find("origins");
  if (origins == nullptr) {
    return clearing;
  }
  if (!origins->is_list() || origins->GetList().empty()) {
    return base::unexpected(
        "clear_browsing_data's \"origins\" lists the sites to clear; leave it "
        "out to clear every site");
  }
  for (const base::Value& origin : origins->GetList()) {
    const std::string* spec = origin.GetIfString();
    if (spec == nullptr) {
      return base::unexpected("clear_browsing_data's \"origins\" are strings");
    }
    const url::Origin site = url::Origin::Create(GURL(*spec));
    if (site.opaque()) {
      return base::unexpected(
          base::StrCat({"\"", *spec, "\" is not a site's origin"}));
    }
    clearing.origins.push_back(site);
  }
  for (const BrowsingDataKind kind : clearing.kinds) {
    if (!IsKeptPerSite(kind)) {
      return base::unexpected(
          "\"origins\" clears only data kept per site, which \"downloads\", "
          "\"formData\", \"history\" and \"passwords\" are not");
    }
  }
  return clearing;
}

void AnswerClearBrowsingData(const base::DictValue& request,
                             ClearBrowsingData clear_browsing_data,
                             CommandReply reply) {
  const base::expected<BrowsingDataClearing, std::string> clearing =
      ClearingIn(request);
  if (!clearing.has_value()) {
    std::move(reply).Run(RefusedCommand(clearing.error()));
    return;
  }
  clear_browsing_data(clearing.value(),
                      ReplyWhenDone("cleared", std::move(reply)));
}

void AnswerSiteData(ListSiteData list_site_data, CommandReply reply) {
  list_site_data(base::BindOnce(
      [](CommandReply reply,
         base::expected<std::vector<StoredSiteData>, std::string> found) {
        if (!found.has_value()) {
          std::move(reply).Run(RefusedCommand(found.error()));
          return;
        }
        base::ListValue sites;
        for (const StoredSiteData& stored : found.value()) {
          base::DictValue site;
          site.Set("host", stored.host);
          // A double: a site can store more bytes than an int holds.
          site.Set("bytes", static_cast<double>(stored.bytes));
          site.Set("cookies", base::checked_cast<int>(stored.cookies));
          sites.Append(std::move(site));
        }
        base::DictValue done;
        done.Set("type", kSiteData);
        done.Set("sites", std::move(sites));
        std::move(reply).Run(Line(std::move(done)));
      },
      std::move(reply)));
}

void AnswerClearSiteData(const base::DictValue& request,
                         ClearSiteData clear_site_data,
                         CommandReply reply) {
  const std::string* host = request.FindString("host");
  if (host == nullptr || host->empty()) {
    std::move(reply).Run(RefusedCommand(
        "clear_site_data needs a \"host\": the site whose data to clear, as "
        "site_data names it"));
    return;
  }
  clear_site_data(*host, ReplyWhenDone("cleared", std::move(reply)));
}

std::string AnswerDisableWhileTyping(const base::DictValue& request,
                                     DisableWhileTyping disable_while_typing) {
  const std::optional<bool> enabled = request.FindBool("enabled");
  if (request.Find("enabled") != nullptr && !enabled) {
    return RefusedCommand(
        "disable_while_typing's \"enabled\" is true or false, or left out "
        "to ask");
  }
  const base::expected<bool, std::string> rests =
      disable_while_typing(enabled);
  if (!rests.has_value()) {
    return RefusedCommand(rests.error());
  }
  base::DictValue reply;
  reply.Set("type", kDisableWhileTyping);
  reply.Set("enabled", rests.value());
  return Line(std::move(reply));
}

std::string AnswerSetLogLevels(const base::DictValue& request,
                               SetLogLevels set_log_levels) {
  const std::optional<int> min_level = request.FindInt("min_level");
  const std::string* vmodule = request.FindString("vmodule");
  if (!min_level || *min_level < logging::LOGGING_VERBOSE ||
      *min_level > logging::LOGGING_FATAL || !vmodule) {
    return RefusedCommand(
        "set_log_levels takes a \"min_level\" from -1 (VERBOSE) to 3 (FATAL) "
        "and a \"vmodule\" string");
  }
  set_log_levels(*min_level, *vmodule);
  return Done("set");
}

void AnswerDevTools(const base::DictValue& request,
                    SendDevTools send_devtools,
                    CommandReply reply) {
  const std::string* window = request.FindString("window");
  if (window == nullptr || window->empty()) {
    std::move(reply).Run(RefusedCommand(
        "devtools needs a \"window\": the id of the browser window to send "
        "to"));
    return;
  }
  const std::string* method = request.FindString("method");
  if (method == nullptr) {
    std::move(reply).Run(RefusedCommand(
        "devtools needs a \"method\": the DevTools Protocol method to send"));
    return;
  }
  if (!std::ranges::contains(kDevToolsMethods, *method)) {
    std::move(reply).Run(RefusedCommand(base::StrCat(
        {"\"", *method, "\" is not a method agents get; devtools sends ",
         base::JoinString(kDevToolsMethods, ", ")})));
    return;
  }
  const base::Value* given = request.Find("params");
  if (given != nullptr && !given->is_dict()) {
    std::move(reply).Run(
        RefusedCommand("devtools's \"params\" is an object, or left out"));
    return;
  }
  base::DictValue params =
      given != nullptr ? given->GetDict().Clone() : base::DictValue();
  if (*method == "Page.navigate") {
    const std::string* url = params.FindString("url");
    if (url == nullptr || !GURL(*url).SchemeIsHTTPOrHTTPS()) {
      std::move(reply).Run(RefusedCommand(
          "Page.navigate takes a \"url\" that is an http or https address"));
      return;
    }
  }
  send_devtools(
      *window, *method, std::move(params),
      base::BindOnce(
          [](CommandReply reply,
             base::expected<base::DictValue, std::string> answered) {
            if (!answered.has_value()) {
              std::move(reply).Run(RefusedCommand(answered.error()));
              return;
            }
            base::DictValue done;
            done.Set("type", kDevTools);
            done.Set("result", std::move(answered.value()));
            std::move(reply).Run(Line(std::move(done)));
          },
          std::move(reply)));
}

}  // namespace
}  // namespace domicile
