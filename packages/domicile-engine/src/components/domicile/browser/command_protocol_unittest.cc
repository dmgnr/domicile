// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/browser/command_protocol.h"

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "base/files/file_path.h"
#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/strings/strcat.h"
#include "base/time/time.h"
#include "base/types/expected.h"
#include "base/values.h"
#include "components/domicile/mojom/browser_windows.mojom-shared.h"
#include "components/domicile/mojom/web_view_guest.mojom-shared.h"
#include "testing/gmock/include/gmock/gmock.h"
#include "testing/gtest/include/gtest/gtest.h"
#include "url/gurl.h"
#include "url/origin.h"

namespace domicile {
namespace {

using ::testing::HasSubstr;
using mojom::WebViewPermission;
using mojom::WebViewPermissionSetting;

// Records which actions a request triggered.
//
// Most tests assert that a refused request triggered none.
struct Told {
  // Set to hold `load_shell`'s answer in `held_load` instead of giving it.
  bool hold_load = false;
  ShellLoaded held_load;
  // Set to hold `run_app`'s or `open_url`'s answer in `held_open` instead of
  // giving it.
  bool hold_open = false;
  WindowOpened held_open;
  // Set to hold `media_devices`'s and `set_media_device`'s answers, as until
  // the devices are listed, in `held_devices` and `held_device` instead of
  // giving them.
  bool hold_devices = false;
  MediaDevicesFound held_devices;
  CommandDone held_device;
  // The last reply, which a held command gives after Answer returns.
  std::string reply;
  bool asked = false;
  base::FilePath root;
  std::string module;
  std::optional<ShellFiles> files;
  bool ran = false;
  base::FilePath app_root;
  std::string app_module;
  bool opened = false;
  std::string url;
  std::optional<AppLaunch> app;
  std::string profile;
  bool set = false;
  std::string origin;
  std::optional<WebViewPermission> permission;
  std::optional<WebViewPermissionSetting> setting;
  base::FilePath unpacked;
  std::string uninstalled;
  std::optional<MediaDeviceKind> device_kind;
  std::string device;
  std::string toggled;
  std::optional<bool> enabled;
  std::string toggled_in;
  std::string pinned_site;
  std::string pinned_to;
  std::string configured;
  std::optional<ExtensionSettings> settings;
  std::optional<HistorySearch> search;
  std::string visits_of;
  std::optional<std::vector<base::Time>> deleted;
  std::optional<BrowsingDataClearing> clearing;
  bool listed_site_data = false;
  std::string cleared_host;
  // Whether the recording `disable_while_typing` has the pads rest.
  bool typing_rests = true;
  std::string devtools_window;
  std::string devtools_method;
  std::optional<base::DictValue> devtools_params;
  std::optional<int> min_log_level;
  std::string vmodule;
};

// The id the recording `load_unpacked` gives what it loads, and the one the
// recording `config_extensions` lists.
constexpr char kExtensionId[] = "abcdefghijklmnopabcdefghijklmnop";

// What the recording `list_site_permissions` answers: camera's default is
// ask and notifications' allow, and one site has the camera.
SitePermissionList StoredSettings() {
  SitePermissionList list;
  list.defaults = {{WebViewPermission::kCamera, WebViewPermissionSetting::kAsk},
                   {WebViewPermission::kNotifications,
                    WebViewPermissionSetting::kAllow}};
  list.sites = {{url::Origin::Create(GURL("https://meet.example")),
                 WebViewPermission::kCamera, WebViewPermissionSetting::kAllow}};
  return list;
}

// What the recording `extensions` answers: one extension with an options page,
// allowed on local files and on one site, and one switched off without,
// which has no settings to change.
std::vector<InstalledExtension> InstalledExtensions() {
  InstalledExtension dark;
  dark.id = kExtensionId;
  dark.name = "Dark Reader";
  dark.description = "Dark mode for every site";
  dark.version = "4.9";
  dark.enabled = true;
  dark.settings.file_access = true;
  dark.settings.site_access = SiteAccess::kSpecificSites;
  dark.settings.sites = {"github.com"};
  dark.options_url =
      GURL("chrome-extension://abcdefghijklmnopabcdefghijklmnop/options.html");
  dark.icon_path = "/extensions/dark/icons/128.png";
  InstalledExtension quiet;
  quiet.id = "ponmlkjihgfedcbaponmlkjihgfedcba";
  quiet.name = "Quiet";
  quiet.version = "1.0";
  return {dark, quiet};
}

// What the recording `history` finds: a page with a favicon, and one without.
std::vector<HistoryEntry> VisitedPages() {
  HistoryEntry news;
  news.url = GURL("https://news.example/");
  news.title = "News";
  news.favicon_png = {0x89, 'P', 'N', 'G'};
  HistoryEntry plain;
  plain.url = GURL("https://plain.example/");
  return {news, plain};
}

// What the recording `site_data` finds: a site with cookies and storage, and
// one with storage only.
std::vector<StoredSiteData> SitesWithData() {
  return {{.host = "mail.example", .bytes = 5000000000, .cookies = 3},
          {.host = "notes.example", .bytes = 2048, .cookies = 0}};
}

// `us` microseconds after the Unix epoch, the precision history keeps.
base::Time AtMicroseconds(int64_t us) {
  return base::Time::UnixEpoch() + base::Microseconds(us);
}

// What the recording `list_media_devices` answers: one camera, and two
// microphones with the default first.
MediaDeviceList ConnectedDevices() {
  MediaDeviceList list;
  list.cameras = {{.id = "/dev/video2", .name = "USB Camera"}};
  list.microphones = {{.id = "default", .name = "Default"},
                      {.id = "alsa_input.usb", .name = "USB Microphone"}};
  return list;
}

// Answers one line with recording actions. `has_window` false makes every
// action fail, as when the engine has no shell window.
std::string Answer(std::string_view line,
                   Told* told,
                   bool has_window = true) {
  auto load_shell = [told, has_window](const base::FilePath& root,
                                       const std::string& module,
                                       ShellFiles files, ShellLoaded loaded) {
    told->asked = true;
    told->root = root;
    told->module = module;
    told->files = files;
    if (told->hold_load) {
      told->held_load = std::move(loaded);
      return;
    }
    if (has_window) {
      std::move(loaded).Run(base::ok());
    } else {
      std::move(loaded).Run(base::unexpected(kNoShellWindow));
    }
  };
  auto run_app = [told, has_window](const base::FilePath& root,
                                    const std::string& module,
                                    WindowOpened opened) {
    told->ran = true;
    told->app_root = root;
    told->app_module = module;
    if (told->hold_open) {
      told->held_open = std::move(opened);
      return;
    }
    std::move(opened).Run(has_window);
  };
  auto open_url = [told, has_window](const GURL& url,
                                     std::optional<AppLaunch> app,
                                     const std::string& profile,
                                     WindowOpened opened) {
    told->opened = true;
    told->url = url.spec();
    told->app = app;
    told->profile = profile;
    if (told->hold_open) {
      told->held_open = std::move(opened);
      return;
    }
    std::move(opened).Run(has_window);
  };
  // The desk's profiles are `default` and `work`.
  auto has_browser_profile = [](const std::string& id) {
    return id == "default" || id == "work";
  };
  auto list_site_permissions =
      [has_window]() -> std::optional<SitePermissionList> {
    if (!has_window) {
      return std::nullopt;
    }
    return StoredSettings();
  };
  auto set_site_permission = [told, has_window](
                                 const url::Origin& origin,
                                 WebViewPermission permission,
                                 WebViewPermissionSetting setting) {
    told->set = true;
    told->origin = origin.Serialize();
    told->permission = permission;
    told->setting = setting;
    return has_window;
  };
  auto load_unpacked = [told, has_window](const base::FilePath& directory,
                                          UnpackedLoaded loaded) {
    told->unpacked = directory;
    if (!has_window) {
      std::move(loaded).Run(base::unexpected("no shell"));
      return;
    }
    std::move(loaded).Run(base::ok(std::string(kExtensionId)));
  };
  auto uninstall_extension =
      [told, has_window](
          const std::string& id) -> base::expected<void, std::string> {
    told->uninstalled = id;
    if (!has_window) {
      return base::unexpected("no shell");
    }
    return base::ok();
  };
  auto list_config_extensions =
      [has_window]() -> std::optional<std::vector<std::string>> {
    if (!has_window) {
      return std::nullopt;
    }
    return std::vector<std::string>{kExtensionId};
  };
  auto list_extensions =
      [has_window]() -> std::optional<std::vector<InstalledExtension>> {
    if (!has_window) {
      return std::nullopt;
    }
    return InstalledExtensions();
  };
  auto set_extension_enabled =
      [told, has_window](const std::string& id, bool enabled,
                         const std::string& profile)
      -> base::expected<void, std::string> {
    told->toggled = id;
    told->enabled = enabled;
    told->toggled_in = profile;
    if (!has_window) {
      return base::unexpected("no shell");
    }
    return base::ok();
  };
  auto configure_extension =
      [told, has_window](const std::string& id,
                         const ExtensionSettings& settings)
      -> base::expected<void, std::string> {
    told->configured = id;
    told->settings = settings;
    if (!has_window) {
      return base::unexpected("no shell");
    }
    return base::ok();
  };
  auto list_browser_profiles = [has_window](BrowserProfilesFound found) {
    if (!has_window) {
      std::move(found).Run(std::nullopt);
      return;
    }
    BrowserProfileList list;
    list.default_profile = "personal";
    list.default_private_profile = "private";
    ListedBrowserProfile& work = list.profiles.emplace_back();
    work.id = "work";
    work.name = "Work";
    work.color = "#d97706";
    work.extensions.push_back(
        {.id = kExtensionId, .enabled = true, .locked = true});
    list.sites.push_back(
        {.site = "github.com/acme", .profile = "work", .pinned = true});
    std::move(found).Run(std::move(list));
  };
  auto pin_browser_site =
      [told, has_window](const std::string& site,
                         const std::string& profile)
      -> base::expected<void, std::string> {
    told->pinned_site = site;
    told->pinned_to = profile;
    if (!has_window) {
      return base::unexpected("no shell");
    }
    return base::ok();
  };
  auto list_media_devices = [told, has_window](MediaDevicesFound found) {
    if (told->hold_devices) {
      told->held_devices = std::move(found);
      return;
    }
    if (!has_window) {
      std::move(found).Run(std::nullopt);
      return;
    }
    std::move(found).Run(ConnectedDevices());
  };
  auto set_media_device = [told, has_window](MediaDeviceKind kind,
                                             const std::string& id,
                                             CommandDone done) {
    told->device_kind = kind;
    told->device = id;
    if (told->hold_devices) {
      told->held_device = std::move(done);
      return;
    }
    if (!has_window) {
      std::move(done).Run(base::unexpected("no shell"));
      return;
    }
    std::move(done).Run(base::ok());
  };
  auto search_history = [told, has_window](const HistorySearch& search,
                                           HistoryFound found) {
    told->search = search;
    if (!has_window) {
      std::move(found).Run(base::unexpected("no shell"));
      return;
    }
    std::move(found).Run(base::ok(VisitedPages()));
  };
  auto list_visits = [told, has_window](const GURL& url, VisitsFound found) {
    told->visits_of = url.spec();
    if (!has_window) {
      std::move(found).Run(base::unexpected("no shell"));
      return;
    }
    std::move(found).Run(base::ok(std::vector<base::Time>{
        AtMicroseconds(1700000000000500), AtMicroseconds(1700000000123000)}));
  };
  auto delete_visits = [told, has_window](const std::vector<base::Time>& visits,
                                          CommandDone done) {
    told->deleted = visits;
    if (!has_window) {
      std::move(done).Run(base::unexpected("no shell"));
      return;
    }
    std::move(done).Run(base::ok());
  };
  auto clear_browsing_data = [told, has_window](
                                 const BrowsingDataClearing& clearing,
                                 CommandDone done) {
    told->clearing = clearing;
    if (!has_window) {
      std::move(done).Run(base::unexpected("no shell"));
      return;
    }
    std::move(done).Run(base::ok());
  };
  auto list_site_data = [told, has_window](SiteDataFound found) {
    told->listed_site_data = true;
    if (!has_window) {
      std::move(found).Run(base::unexpected("no shell"));
      return;
    }
    std::move(found).Run(base::ok(SitesWithData()));
  };
  auto clear_site_data = [told, has_window](const std::string& host,
                                            CommandDone done) {
    told->cleared_host = host;
    if (!has_window) {
      std::move(done).Run(base::unexpected("no shell"));
      return;
    }
    std::move(done).Run(base::ok());
  };
  auto disable_while_typing = [told, has_window](std::optional<bool> enabled)
      -> base::expected<bool, std::string> {
    if (!has_window) {
      return base::unexpected("no touchpad");
    }
    if (enabled) {
      told->typing_rests = *enabled;
    }
    return told->typing_rests;
  };
  // Answers with the method it was sent, so a test can see it went through.
  auto send_devtools = [told, has_window](const std::string& window,
                                          const std::string& method,
                                          base::DictValue params,
                                          DevToolsAnswered answered) {
    told->devtools_window = window;
    told->devtools_method = method;
    told->devtools_params = std::move(params);
    if (!has_window) {
      std::move(answered).Run(base::unexpected("no browser window " + window));
      return;
    }
    base::DictValue result;
    result.Set("sent", method);
    std::move(answered).Run(base::ok(std::move(result)));
  };
  auto set_log_levels = [told](int min_level, const std::string& vmodule) {
    told->min_log_level = min_level;
    told->vmodule = vmodule;
  };
  told->reply.clear();
  AnswerCommand(line,
                {.load_shell = load_shell,
                 .run_app = run_app,
                 .open_url = open_url,
                 .has_browser_profile = has_browser_profile,
                 .list_site_permissions = list_site_permissions,
                 .set_site_permission = set_site_permission,
                 .load_unpacked = load_unpacked,
                 .uninstall_extension = uninstall_extension,
                 .list_config_extensions = list_config_extensions,
                 .list_extensions = list_extensions,
                 .set_extension_enabled = set_extension_enabled,
                 .configure_extension = configure_extension,
                 .list_browser_profiles = list_browser_profiles,
                 .pin_browser_site = pin_browser_site,
                 .list_media_devices = list_media_devices,
                 .set_media_device = set_media_device,
                 .search_history = search_history,
                 .list_visits = list_visits,
                 .delete_visits = delete_visits,
                 .clear_browsing_data = clear_browsing_data,
                 .list_site_data = list_site_data,
                 .clear_site_data = clear_site_data,
                 .disable_while_typing = disable_while_typing,
                 .send_devtools = send_devtools,
                 .set_log_levels = set_log_levels},
                base::BindOnce([](std::string* out,
                                  std::string line) { *out = std::move(line); },
                               &told->reply));
  return told->reply;
}

// Returns the reply's `type`, or "" if the reply is not a JSON object with
// one.
std::string TypeOf(const std::string& reply) {
  const std::optional<base::DictValue> parsed =
      base::JSONReader::ReadDict(reply, base::JSON_PARSE_RFC);
  if (!parsed) {
    return "";
  }
  const std::string* type = parsed->FindString("type");
  return type ? *type : "";
}

// Returns the reply's `why`, or "" as for TypeOf.
std::string WhyOf(const std::string& reply) {
  const std::optional<base::DictValue> parsed =
      base::JSONReader::ReadDict(reply, base::JSON_PARSE_RFC);
  if (!parsed) {
    return "";
  }
  const std::string* why = parsed->FindString("why");
  return why ? *why : "";
}

constexpr char kLoadOther[] =
    R"({"type":"load_shell","version":1,)"
    R"("root":"/home/someone/desktop/dist","module":"desktop.js"})";

TEST(CommandProtocolTest, LoadsTheShellARequestNames) {
  Told told;
  const std::string reply = Answer(kLoadOther, &told);

  EXPECT_EQ(TypeOf(reply), "loaded");
  EXPECT_TRUE(told.asked);
  EXPECT_EQ(told.root, base::FilePath("/home/someone/desktop/dist"));
  EXPECT_EQ(told.module, "desktop.js");
  EXPECT_EQ(told.files, ShellFiles::kDirectory);
  // The reply is one line and includes its newline.
  EXPECT_EQ(reply.find('\n'), reply.size() - 1);
}

// `domicile dev`: the root is the dev server's socket.
TEST(CommandProtocolTest, LoadsAShellFromTheDevServerARequestNames) {
  Told told;
  const std::string reply = Answer(
      R"({"type":"load_shell","version":1,"root":"/run/user/1000/dev.sock",)"
      R"("module":"@domicile/shell.js","dev_server":true})",
      &told);

  EXPECT_EQ(TypeOf(reply), "loaded");
  EXPECT_EQ(told.root, base::FilePath("/run/user/1000/dev.sock"));
  EXPECT_EQ(told.module, "@domicile/shell.js");
  EXPECT_EQ(told.files, ShellFiles::kDevServer);
}

TEST(CommandProtocolTest, RefusesADevServerThatIsNotABoolean) {
  // Read as false, it would serve the socket as a directory: a blank shell
  // with no reason given.
  Told told;
  const std::string reply = Answer(
      R"({"type":"load_shell","version":1,"root":"/run/user/1000/dev.sock",)"
      R"("module":"@domicile/shell.js","dev_server":"yes"})",
      &told);

  EXPECT_EQ(TypeOf(reply), "refused");
  EXPECT_THAT(WhyOf(reply), HasSubstr("dev_server"));
  EXPECT_FALSE(told.asked);
}

// An app module, opened by `domicile run-app`. See
// docs/architecture/APP-MODULES.md.
TEST(CommandProtocolTest, RunsTheAppARequestNames) {
  Told told;
  const std::string reply = Answer(
      R"({"type":"run_app","version":1,"root":"/opt/notes","module":"notes.js"})",
      &told);

  EXPECT_EQ(TypeOf(reply), "opened");
  EXPECT_TRUE(told.ran);
  EXPECT_EQ(told.app_root, base::FilePath("/opt/notes"));
  EXPECT_EQ(told.app_module, "notes.js");
}

TEST(CommandProtocolTest, RefusesAnAppWithoutAnAbsoluteRootAndAModule) {
  Told told;
  EXPECT_EQ(TypeOf(Answer(
                R"({"type":"run_app","version":1,"root":"notes","module":"notes.js"})",
                &told)),
            "refused");
  EXPECT_EQ(TypeOf(Answer(R"({"type":"run_app","version":1,"root":"/opt/notes"})",
                          &told)),
            "refused");
  EXPECT_FALSE(told.ran);
}

TEST(CommandProtocolTest, RefusesAnAppWithNoShellToDrawIt) {
  Told told;
  EXPECT_EQ(
      TypeOf(Answer(
          R"({"type":"run_app","version":1,"root":"/opt/notes","module":"notes.js"})",
          &told, /*has_window=*/false)),
      "refused");
}

TEST(CommandProtocolTest, AnswersAnAppOnceTheShellWindowCanTakeIt) {
  // An app run at login can arrive while the shell window's first page is
  // still loading.
  Told told;
  told.hold_open = true;
  EXPECT_EQ(
      Answer(
          R"({"type":"run_app","version":1,"root":"/opt/notes","module":"notes.js"})",
          &told),
      "");

  std::move(told.held_open).Run(true);
  EXPECT_EQ(TypeOf(told.reply), "opened");
}

TEST(CommandProtocolTest, RefusesALineThatIsNotARequest) {
  Told told;
  EXPECT_EQ(TypeOf(Answer("load_shell /home/someone/desktop", &told)),
            "refused");
  // Valid JSON that is not an object.
  EXPECT_EQ(TypeOf(Answer("[1, 2, 3]", &told)), "refused");
  EXPECT_FALSE(told.asked);
}

TEST(CommandProtocolTest, RefusesAVersionItDoesNotSpeak) {
  // The supervisor and engine ship separately, so a version mismatch must be
  // refused with a reason.
  Told told;
  const std::string newer = Answer(
      R"({"type":"load_shell","version":2,"root":"/x","module":"shell.js"})",
      &told);
  EXPECT_EQ(TypeOf(newer), "refused");
  EXPECT_THAT(WhyOf(newer), HasSubstr("version"));

  // A missing version is also a mismatch.
  EXPECT_EQ(
      TypeOf(Answer(R"({"type":"load_shell","root":"/x","module":"s.js"})",
                    &told)),
      "refused");

  EXPECT_FALSE(told.asked);
}

TEST(CommandProtocolTest, RefusesACommandItDoesNotKnow) {
  Told told;
  const std::string reply =
      Answer(R"({"type":"reload_shell","version":1})", &told);
  EXPECT_EQ(TypeOf(reply), "refused");
  // The reason names the command so the sender can be found.
  EXPECT_THAT(WhyOf(reply), HasSubstr("reload_shell"));
  EXPECT_FALSE(told.asked);
}

TEST(CommandProtocolTest, RefusesAShellThatIsMissingHalfOfItself) {
  // A shell needs both its root and its module; neither has a usable default.
  Told told;
  EXPECT_EQ(
      TypeOf(Answer(R"({"type":"load_shell","version":1,"module":"s.js"})",
                    &told)),
      "refused");
  EXPECT_EQ(TypeOf(Answer(
                R"({"type":"load_shell","version":1,"root":"/x/dist"})",
                &told)),
            "refused");
  // An empty field counts as missing.
  EXPECT_EQ(TypeOf(Answer(
                R"({"type":"load_shell","version":1,"root":"","module":"s.js"})",
                &told)),
            "refused");
  EXPECT_EQ(TypeOf(Answer(
                R"({"type":"load_shell","version":1,"root":"/x","module":""})",
                &told)),
            "refused");
  EXPECT_FALSE(told.asked);
}

TEST(CommandProtocolTest, RefusesARootThatIsNotAbsolute) {
  // A relative root would resolve against the engine's working directory,
  // which the sender does not know.
  Told told;
  const std::string reply = Answer(
      R"({"type":"load_shell","version":1,"root":"dist","module":"s.js"})",
      &told);
  EXPECT_EQ(TypeOf(reply), "refused");
  EXPECT_THAT(WhyOf(reply), HasSubstr("absolute"));
  EXPECT_FALSE(told.asked);
}

TEST(CommandProtocolTest, RefusesWhenThereIsNoShellWindowToLoadInto) {
  // Without a window, answering `loaded` would report a shell nobody can see.
  Told told;
  const std::string reply = Answer(kLoadOther, &told, /*has_window=*/false);
  EXPECT_EQ(TypeOf(reply), "refused");
  // domicile-launch matches this text whole and asks again on it.
  EXPECT_EQ(WhyOf(reply),
            "this engine has no shell window to load a shell into");
}

TEST(CommandProtocolTest, AnswersALoadOnceTheShellWindowCanTakeIt) {
  // The shell window's first page can still be loading when a load arrives,
  // so the engine answers once it is in.
  Told told;
  told.hold_load = true;
  EXPECT_EQ(Answer(kLoadOther, &told), "");

  std::move(told.held_load).Run(base::ok());
  EXPECT_EQ(TypeOf(told.reply), "loaded");
}

TEST(CommandProtocolTest, RefusesALoadWhoseShellDidNotRun) {
  // The engine went back to the old shell; the supervisor keeps serving it.
  Told told;
  told.hold_load = true;
  Answer(kLoadOther, &told);

  std::move(told.held_load)
      .Run(base::unexpected("the shell's Shell threw: TypeError"));
  EXPECT_EQ(TypeOf(told.reply), "refused");
  EXPECT_EQ(WhyOf(told.reply), "the shell's Shell threw: TypeError");
}

TEST(CommandProtocolTest, IgnoresFieldsItDoesNotKnow) {
  // Adding a field does not bump the version, so unknown fields are ignored.
  Told told;
  const std::string reply = Answer(
      R"({"type":"load_shell","version":1,"root":"/x/dist",)"
      R"("module":"shell.js","because":"the bundler rebuilt"})",
      &told);
  EXPECT_EQ(TypeOf(reply), "loaded");
  EXPECT_EQ(told.module, "shell.js");
}

TEST(CommandProtocolTest, HandsTheShellTheAddressARequestNames) {
  Told told;
  const std::string reply = Answer(
      R"({"type":"open_url","version":1,"url":"https://example.com/a?b=c"})",
      &told);
  EXPECT_EQ(TypeOf(reply), "opened");
  EXPECT_TRUE(told.opened);
  EXPECT_EQ(told.url, "https://example.com/a?b=c");
  EXPECT_EQ(told.app, std::nullopt);
  EXPECT_FALSE(told.asked);
}

TEST(CommandProtocolTest, OpensABrowserWindowInTheProfileARequestNames) {
  Told told;
  const std::string reply = Answer(
      R"({"type":"open_url","version":1,"url":"https://example.com/",)"
      R"("profile":"work"})",
      &told);
  EXPECT_EQ(TypeOf(reply), "opened");
  EXPECT_EQ(told.profile, "work");

  // None is the profile the site opens in, which the action works out.
  Answer(R"({"type":"open_url","version":1,"url":"https://example.com/"})",
         &told);
  EXPECT_EQ(told.profile, "");
}

TEST(CommandProtocolTest, RefusesAProfileTheDeskDoesNotHave) {
  // Opening it in another profile would put the page among the wrong
  // sign-ins without a word.
  Told told;
  const std::string reply = Answer(
      R"({"type":"open_url","version":1,"url":"https://example.com/",)"
      R"("profile":"wrok"})",
      &told);
  EXPECT_EQ(TypeOf(reply), "refused");
  EXPECT_THAT(WhyOf(reply), HasSubstr("\"wrok\""));
  EXPECT_FALSE(told.opened);
}

TEST(CommandProtocolTest, RefusesAProfileThatIsNoId) {
  for (const char* profile : {R"("")", "7", "null"}) {
    Told told;
    const std::string reply =
        Answer(base::StrCat({R"({"type":"open_url","version":1,)",
                             R"("url":"https://example.com/","profile":)",
                             profile, "}"}),
               &told);
    EXPECT_EQ(TypeOf(reply), "refused") << profile;
    EXPECT_THAT(WhyOf(reply), HasSubstr("\"profile\"")) << profile;
    EXPECT_FALSE(told.opened) << profile;
  }
}

TEST(CommandProtocolTest, OpensAnAppWindowInTheProfileARequestNames) {
  // Two accounts of one site, such as two Gmail inboxes, open in their own
  // profiles though their site routes to one.
  Told told;
  const std::string reply = Answer(
      R"({"type":"open_url","version":1,"url":"https://example.com/",)"
      R"("app":true,"app_id":"mail","profile":"work"})",
      &told);
  EXPECT_EQ(TypeOf(reply), "opened");
  EXPECT_EQ(told.app, (AppLaunch{.id = "mail"}));
  EXPECT_EQ(told.profile, "work");
}

TEST(CommandProtocolTest, OpensAnAppWindowWhenARequestAsksForOne) {
  Told told;
  const std::string reply = Answer(
      R"({"type":"open_url","version":1,"url":"https://example.com/",)"
      R"("app":true})",
      &told);
  EXPECT_EQ(TypeOf(reply), "opened");
  EXPECT_EQ(told.app, AppLaunch());
}

TEST(CommandProtocolTest, HandsTheShellAnAppWindowsIdAndReuse) {
  Told told;
  const std::string reply = Answer(
      R"({"type":"open_url","version":1,"url":"https://example.com/",)"
      R"("app":true,"app_id":"mail","reuse":"navigate"})",
      &told);
  EXPECT_EQ(TypeOf(reply), "opened");
  EXPECT_EQ(told.app,
            (AppLaunch{.id = "mail", .reuse = mojom::AppReuse::kNavigate}));
}

TEST(CommandProtocolTest, ReadsEachReuse) {
  for (const auto& [name, reuse] :
       {std::pair("new", mojom::AppReuse::kNew),
        std::pair("focus", mojom::AppReuse::kFocus),
        std::pair("navigate", mojom::AppReuse::kNavigate)}) {
    Told told;
    Answer(base::StrCat({R"({"type":"open_url","version":1,)",
                         R"("url":"https://example.com/","app":true,)",
                         R"("app_id":"mail","reuse":")",
                         name, R"("})"}),
           &told);
    EXPECT_EQ(told.app, (AppLaunch{.id = "mail", .reuse = reuse})) << name;
  }
}

TEST(CommandProtocolTest, RefusesAReuseItDoesNotKnow) {
  Told told;
  const std::string reply = Answer(
      R"({"type":"open_url","version":1,"url":"https://example.com/",)"
      R"("app":true,"app_id":"mail","reuse":"raise"})",
      &told);
  EXPECT_EQ(TypeOf(reply), "refused");
  EXPECT_THAT(WhyOf(reply), HasSubstr("\"reuse\""));
  EXPECT_FALSE(told.opened);
}

TEST(CommandProtocolTest, RefusesAReuseWithNoIdToFindTheWindowBy) {
  Told told;
  const std::string reply = Answer(
      R"({"type":"open_url","version":1,"url":"https://example.com/",)"
      R"("app":true,"reuse":"focus"})",
      &told);
  EXPECT_EQ(TypeOf(reply), "refused");
  EXPECT_THAT(WhyOf(reply), HasSubstr("\"app_id\""));
  EXPECT_FALSE(told.opened);
}

TEST(CommandProtocolTest, RefusesAnAppIdThatIsNotAString) {
  Told told;
  const std::string reply = Answer(
      R"({"type":"open_url","version":1,"url":"https://example.com/",)"
      R"("app":true,"app_id":7})",
      &told);
  EXPECT_EQ(TypeOf(reply), "refused");
  EXPECT_THAT(WhyOf(reply), HasSubstr("\"app_id\""));
  EXPECT_FALSE(told.opened);
}

TEST(CommandProtocolTest, RefusesAnAppIdForABrowserWindow) {
  // A browser window is never reused, so an id on one is a caller's mistake.
  Told told;
  const std::string reply = Answer(
      R"({"type":"open_url","version":1,"url":"https://example.com/",)"
      R"("app_id":"mail","reuse":"focus"})",
      &told);
  EXPECT_EQ(TypeOf(reply), "refused");
  EXPECT_THAT(WhyOf(reply), HasSubstr("app window"));
  EXPECT_FALSE(told.opened);
}

TEST(CommandProtocolTest, RefusesAnAppThatIsNotABoolean) {
  // A typo must not open a browser window and report success.
  Told told;
  const std::string reply = Answer(
      R"({"type":"open_url","version":1,"url":"https://example.com/",)"
      R"("app":"yes"})",
      &told);
  EXPECT_EQ(TypeOf(reply), "refused");
  EXPECT_THAT(WhyOf(reply), HasSubstr("\"app\""));
  EXPECT_FALSE(told.opened);
}

TEST(CommandProtocolTest, RefusesAnAddressThatIsNotAUrl) {
  // Otherwise the shell would open an empty window and report success.
  Told told;
  const std::string reply = Answer(
      R"({"type":"open_url","version":1,"url":"not a url"})", &told);
  EXPECT_EQ(TypeOf(reply), "refused");
  EXPECT_THAT(WhyOf(reply), HasSubstr("not a url"));
  EXPECT_EQ(TypeOf(Answer(R"({"type":"open_url","version":1})", &told)),
            "refused");
  EXPECT_FALSE(told.opened);
}

TEST(CommandProtocolTest, RefusesWhenThereIsNoShellPageToOpenIn) {
  Told told;
  const std::string reply =
      Answer(R"({"type":"open_url","version":1,"url":"https://example.com/"})",
             &told, /*has_window=*/false);
  EXPECT_EQ(TypeOf(reply), "refused");
  EXPECT_THAT(WhyOf(reply), HasSubstr("shell page"));
}

TEST(CommandProtocolTest, AnswersAnAddressOnceTheShellWindowCanTakeIt) {
  // An address opened at login can arrive while the shell window's first page
  // is still loading.
  Told told;
  told.hold_open = true;
  EXPECT_EQ(
      Answer(R"({"type":"open_url","version":1,"url":"https://example.com/"})",
             &told),
      "");

  std::move(told.held_open).Run(true);
  EXPECT_EQ(TypeOf(told.reply), "opened");
}

TEST(CommandProtocolTest, ListsEachPermissionsDefaultAndEachSitesSetting) {
  Told told;
  const std::string reply =
      Answer(R"({"type":"site_permissions","version":1})", &told);
  EXPECT_EQ(
      base::JSONReader::ReadDict(reply, base::JSON_PARSE_RFC),
      base::JSONReader::ReadDict(
          R"({"type":"site_permissions",)"
          R"("defaults":{"camera":"ask","notifications":"allow"},)"
          R"("sites":[{"origin":"https://meet.example",)"
          R"("permission":"camera","setting":"allow"}]})",
          base::JSON_PARSE_RFC));
  EXPECT_EQ(reply.find('\n'), reply.size() - 1);
}

TEST(CommandProtocolTest, StoresTheSettingARequestNames) {
  Told told;
  const std::string reply = Answer(
      R"({"type":"set_site_permission","version":1,)"
      R"("origin":"https://meet.example","permission":"microphone",)"
      R"("setting":"block"})",
      &told);
  EXPECT_EQ(TypeOf(reply), "set");
  EXPECT_TRUE(told.set);
  EXPECT_EQ(told.origin, "https://meet.example");
  EXPECT_EQ(told.permission, WebViewPermission::kMicrophone);
  EXPECT_EQ(told.setting, WebViewPermissionSetting::kBlock);
}

TEST(CommandProtocolTest, RefusesASettingItCannotStore) {
  // Each is refused by name, so the sender sees which field was wrong.
  Told told;
  const std::string permission = Answer(
      R"({"type":"set_site_permission","version":1,)"
      R"("origin":"https://meet.example","permission":"bluetooth",)"
      R"("setting":"block"})",
      &told);
  EXPECT_EQ(TypeOf(permission), "refused");
  EXPECT_THAT(WhyOf(permission), HasSubstr("bluetooth"));

  const std::string setting = Answer(
      R"({"type":"set_site_permission","version":1,)"
      R"("origin":"https://meet.example","permission":"camera",)"
      R"("setting":"sometimes"})",
      &told);
  EXPECT_EQ(TypeOf(setting), "refused");
  EXPECT_THAT(WhyOf(setting), HasSubstr("sometimes"));

  // A page with no site, such as a file, has no site permissions.
  const std::string origin = Answer(
      R"({"type":"set_site_permission","version":1,)"
      R"("origin":"file:///home/someone/a.html","permission":"camera",)"
      R"("setting":"block"})",
      &told);
  EXPECT_EQ(TypeOf(origin), "refused");
  EXPECT_THAT(WhyOf(origin), HasSubstr("file:///home/someone/a.html"));

  EXPECT_FALSE(told.set);
}

TEST(CommandProtocolTest, RefusesSitePermissionsWithNoProfileToKeepThem) {
  // The settings are the shell's profile's; without a shell there is none.
  Told told;
  EXPECT_EQ(TypeOf(Answer(R"({"type":"site_permissions","version":1})",
                          &told, /*has_window=*/false)),
            "refused");
  EXPECT_EQ(TypeOf(Answer(R"({"type":"set_site_permission","version":1,)"
                          R"("origin":"https://meet.example",)"
                          R"("permission":"camera","setting":"block"})",
                          &told, /*has_window=*/false)),
            "refused");
}

TEST(CommandProtocolTest, ListsEachKindsMediaDevicesInTheOrderGiven) {
  Told told;
  const std::string reply =
      Answer(R"({"type":"media_devices","version":1})", &told);
  EXPECT_EQ(base::JSONReader::ReadDict(reply, base::JSON_PARSE_RFC),
            base::JSONReader::ReadDict(
                R"({"type":"media_devices",)"
                R"("cameras":[{"id":"/dev/video2","name":"USB Camera"}],)"
                R"("microphones":[{"id":"default","name":"Default"},)"
                R"({"id":"alsa_input.usb","name":"USB Microphone"}]})",
                base::JSON_PARSE_RFC));
}

TEST(CommandProtocolTest, AnswersMediaDevicesOnceTheyAreListed) {
  // Nothing lists devices before the first ask, so the first answer waits for
  // the list rather than giving an empty one.
  Told told;
  told.hold_devices = true;
  EXPECT_EQ(Answer(R"({"type":"media_devices","version":1})", &told), "");

  std::move(told.held_devices).Run(ConnectedDevices());
  EXPECT_EQ(TypeOf(told.reply), "media_devices");
}

TEST(CommandProtocolTest, PrefersAMediaDeviceOnceTheyAreListed) {
  Told told;
  told.hold_devices = true;
  EXPECT_EQ(Answer(R"({"type":"set_media_device","version":1,)"
                   R"("kind":"camera","id":"/dev/video2"})",
                   &told),
            "");

  std::move(told.held_device).Run(base::ok());
  EXPECT_EQ(TypeOf(told.reply), "set");
}

TEST(CommandProtocolTest, PrefersTheMediaDeviceARequestNames) {
  Told told;
  const std::string reply = Answer(
      R"({"type":"set_media_device","version":1,"kind":"microphone",)"
      R"("id":"alsa_input.usb"})",
      &told);
  EXPECT_EQ(TypeOf(reply), "set");
  EXPECT_EQ(told.device_kind, MediaDeviceKind::kMicrophone);
  EXPECT_EQ(told.device, "alsa_input.usb");
}

TEST(CommandProtocolTest, RefusesAMediaDeviceItCannotName) {
  Told told;
  const std::string kind = Answer(
      R"({"type":"set_media_device","version":1,"kind":"speaker",)"
      R"("id":"default"})",
      &told);
  EXPECT_EQ(TypeOf(kind), "refused");
  EXPECT_THAT(WhyOf(kind), HasSubstr("speaker"));

  const std::string id = Answer(
      R"({"type":"set_media_device","version":1,"kind":"camera"})", &told);
  EXPECT_EQ(TypeOf(id), "refused");
  EXPECT_THAT(WhyOf(id), HasSubstr("\"id\""));

  EXPECT_FALSE(told.device_kind.has_value());
}

TEST(CommandProtocolTest, CarriesBackWhyAMediaDeviceWasNotPreferred) {
  Told told;
  EXPECT_EQ(TypeOf(Answer(R"({"type":"media_devices","version":1})", &told,
                          /*has_window=*/false)),
            "refused");
  const std::string reply = Answer(
      R"({"type":"set_media_device","version":1,"kind":"camera",)"
      R"("id":"/dev/video2"})",
      &told, /*has_window=*/false);
  EXPECT_EQ(TypeOf(reply), "refused");
  EXPECT_EQ(WhyOf(reply), "no shell");
}

TEST(CommandProtocolTest, LoadsTheUnpackedExtensionARequestNames) {
  Told told;
  const std::string reply = Answer(
      R"({"type":"load_unpacked","version":1,)"
      R"("directory":"/home/someone/src/an-extension"})",
      &told);
  EXPECT_EQ(base::JSONReader::ReadDict(reply, base::JSON_PARSE_RFC),
            base::JSONReader::ReadDict(
                R"({"type":"loaded_unpacked",)"
                R"("id":"abcdefghijklmnopabcdefghijklmnop"})",
                base::JSON_PARSE_RFC));
  EXPECT_EQ(told.unpacked,
            base::FilePath("/home/someone/src/an-extension"));
}

TEST(CommandProtocolTest, RefusesAnUnpackedExtensionItCannotFind) {
  Told told;
  const std::string missing =
      Answer(R"({"type":"load_unpacked","version":1})", &told);
  EXPECT_EQ(TypeOf(missing), "refused");
  EXPECT_THAT(WhyOf(missing), HasSubstr("directory"));

  // Relative to the engine's working directory, which the sender does not
  // know.
  const std::string relative = Answer(
      R"({"type":"load_unpacked","version":1,"directory":"src/x"})", &told);
  EXPECT_EQ(TypeOf(relative), "refused");
  EXPECT_THAT(WhyOf(relative), HasSubstr("src/x"));

  EXPECT_TRUE(told.unpacked.empty());
}

TEST(CommandProtocolTest, SaysWhyAnUnpackedExtensionDidNotLoad) {
  Told told;
  const std::string reply = Answer(
      R"({"type":"load_unpacked","version":1,)"
      R"("directory":"/home/someone/src/an-extension"})",
      &told, /*has_window=*/false);
  EXPECT_EQ(TypeOf(reply), "refused");
  EXPECT_THAT(WhyOf(reply), HasSubstr("no shell"));
}

TEST(CommandProtocolTest, UninstallsTheExtensionARequestNames) {
  Told told;
  const std::string reply = Answer(
      R"({"type":"uninstall_extension","version":1,)"
      R"("id":"abcdefghijklmnopabcdefghijklmnop"})",
      &told);
  EXPECT_EQ(TypeOf(reply), "uninstalled");
  EXPECT_EQ(told.uninstalled, kExtensionId);

  const std::string refused = Answer(
      R"({"type":"uninstall_extension","version":1,)"
      R"("id":"abcdefghijklmnopabcdefghijklmnop"})",
      &told, /*has_window=*/false);
  EXPECT_EQ(TypeOf(refused), "refused");
  EXPECT_THAT(WhyOf(refused), HasSubstr("no shell"));
}

TEST(CommandProtocolTest, RefusesAnIdThatNamesNoExtension) {
  Told told;
  const std::string reply = Answer(
      R"({"type":"uninstall_extension","version":1,"id":"../x"})", &told);
  EXPECT_EQ(TypeOf(reply), "refused");
  EXPECT_THAT(WhyOf(reply), HasSubstr("../x"));
  EXPECT_TRUE(told.uninstalled.empty());
}

TEST(CommandProtocolTest, ListsTheExtensionsTheConfigInstalled) {
  Told told;
  EXPECT_EQ(base::JSONReader::ReadDict(
                Answer(R"({"type":"config_extensions","version":1})", &told),
                base::JSON_PARSE_RFC),
            base::JSONReader::ReadDict(
                R"({"type":"config_extensions",)"
                R"("ids":["abcdefghijklmnopabcdefghijklmnop"]})",
                base::JSON_PARSE_RFC));
  EXPECT_EQ(TypeOf(Answer(R"({"type":"config_extensions","version":1})",
                          &told, /*has_window=*/false)),
            "refused");
}

// The Settings app's Extensions page, which these replace `chrome.management`
// for. See docs/architecture/APP-MODULES.md.
TEST(CommandProtocolTest, ListsTheProfilesExtensions) {
  Told told;
  EXPECT_EQ(
      base::JSONReader::ReadDict(
          Answer(R"({"type":"extensions","version":1})", &told),
          base::JSON_PARSE_RFC),
      base::JSONReader::ReadDict(
          R"({"type":"extensions","extensions":[)"
          R"({"id":"abcdefghijklmnopabcdefghijklmnop","name":"Dark Reader",)"
          R"("description":"Dark mode for every site","version":"4.9",)"
          R"("enabled":true,)"
          R"("settings":{"file_access":true,"site_access":["github.com"]},)"
          R"("options_url":)"
          R"("chrome-extension://abcdefghijklmnopabcdefghijklmnop/options.html",)"
          R"("icon_path":"/extensions/dark/icons/128.png"},)"
          R"({"id":"ponmlkjihgfedcbaponmlkjihgfedcba","name":"Quiet",)"
          R"("description":"","version":"1.0","enabled":false,)"
          R"("settings":{}}]})",
          base::JSON_PARSE_RFC));
  EXPECT_EQ(TypeOf(Answer(R"({"type":"extensions","version":1})", &told,
                          /*has_window=*/false)),
            "refused");
}

TEST(CommandProtocolTest, SwitchesAnExtensionOnOrOff) {
  Told told;
  EXPECT_EQ(TypeOf(Answer(R"({"type":"set_extension_enabled","version":1,)"
                          R"("id":"abcdefghijklmnopabcdefghijklmnop",)"
                          R"("enabled":false})",
                          &told)),
            "set");
  EXPECT_EQ(told.toggled, kExtensionId);
  EXPECT_EQ(told.enabled, false);
}

// The Settings app's Profiles page.
TEST(CommandProtocolTest, SwitchesAnExtensionInTheProfileARequestNames) {
  Told told;
  EXPECT_EQ(TypeOf(Answer(R"({"type":"set_extension_enabled","version":1,)"
                          R"("id":"abcdefghijklmnopabcdefghijklmnop",)"
                          R"("enabled":true,"profile":"work"})",
                          &told)),
            "set");
  EXPECT_EQ(told.toggled_in, "work");
  EXPECT_EQ(TypeOf(Answer(R"({"type":"set_extension_enabled","version":1,)"
                          R"("id":"abcdefghijklmnopabcdefghijklmnop",)"
                          R"("enabled":true,"profile":3})",
                          &told)),
            "refused");
}

TEST(CommandProtocolTest, ListsTheDesksBrowserProfiles) {
  Told told;
  EXPECT_EQ(
      base::JSONReader::ReadDict(
          Answer(R"({"type":"browser_profiles","version":1})", &told),
          base::JSON_PARSE_RFC),
      base::JSONReader::ReadDict(
          R"({"type":"browser_profiles","default_profile":"personal",)"
          R"("default_private_profile":"private",)"
          R"("profiles":[{"id":"work","name":"Work","color":"#d97706",)"
          R"("private":false,"extensions":[)"
          R"({"id":"abcdefghijklmnopabcdefghijklmnop","enabled":true,)"
          R"("locked":true}]}],)"
          R"("sites":[{"site":"github.com/acme","profile":"work",)"
          R"("pinned":true}]})",
          base::JSON_PARSE_RFC));
  EXPECT_EQ(TypeOf(Answer(R"({"type":"browser_profiles","version":1})", &told,
                          /*has_window=*/false)),
            "refused");
}

TEST(CommandProtocolTest, PinsASiteToTheProfileARequestNames) {
  Told told;
  EXPECT_EQ(TypeOf(Answer(R"({"type":"pin_browser_site","version":1,)"
                          R"("site":"github.com/acme","profile":"work"})",
                          &told)),
            "set");
  EXPECT_EQ(told.pinned_site, "github.com/acme");
  EXPECT_EQ(told.pinned_to, "work");
  Told missing;
  EXPECT_EQ(TypeOf(Answer(R"({"type":"pin_browser_site","version":1,)"
                          R"("site":"github.com/acme"})",
                          &missing)),
            "refused");
  EXPECT_EQ(missing.pinned_site, "");
}

TEST(CommandProtocolTest, RefusesASwitchWithoutAnIdAndAnEnabled) {
  Told told;
  EXPECT_EQ(TypeOf(Answer(R"({"type":"set_extension_enabled","version":1,)"
                          R"("id":"abcdefghijklmnopabcdefghijklmnop"})",
                          &told)),
            "refused");
  EXPECT_EQ(TypeOf(Answer(R"({"type":"set_extension_enabled","version":1,)"
                          R"("enabled":true})",
                          &told)),
            "refused");
  EXPECT_FALSE(told.enabled.has_value());
}

TEST(CommandProtocolTest, ConfiguresAnExtension) {
  Told told;
  EXPECT_EQ(TypeOf(Answer(R"({"type":"configure_extension","version":1,)"
                          R"("id":"abcdefghijklmnopabcdefghijklmnop",)"
                          R"("settings":{"file_access":true,)"
                          R"("site_access":"on_click"}})",
                          &told)),
            "set");
  EXPECT_EQ(told.configured, kExtensionId);
  ExtensionSettings wanted;
  wanted.file_access = true;
  wanted.site_access = SiteAccess::kOnClick;
  EXPECT_EQ(told.settings, wanted);
  EXPECT_EQ(TypeOf(Answer(R"({"type":"configure_extension","version":1,)"
                          R"("id":"abcdefghijklmnopabcdefghijklmnop",)"
                          R"("settings":{"file_access":false}})",
                          &told, /*has_window=*/false)),
            "refused");
  // A private browser profile's switches say what runs in private windows.
  Told in_private;
  EXPECT_EQ(TypeOf(Answer(R"({"type":"configure_extension","version":1,)"
                          R"("id":"abcdefghijklmnopabcdefghijklmnop",)"
                          R"("settings":{"private":true}})",
                          &in_private)),
            "refused");
  EXPECT_FALSE(in_private.settings.has_value());
}

TEST(CommandProtocolTest, RefusesAConfigurationItCannotRead) {
  Told told;
  EXPECT_EQ(TypeOf(Answer(R"({"type":"configure_extension","version":1,)"
                          R"("id":"abcdefghijklmnopabcdefghijklmnop"})",
                          &told)),
            "refused");
  EXPECT_EQ(TypeOf(Answer(R"({"type":"configure_extension","version":1,)"
                          R"("id":"abcdefghijklmnopabcdefghijklmnop",)"
                          R"("settings":{"private":"yes"}})",
                          &told)),
            "refused");
  EXPECT_FALSE(told.settings.has_value());
}

// Returns the reply's `enabled`, or nothing as for TypeOf.
std::optional<bool> EnabledOf(const std::string& reply) {
  const std::optional<base::DictValue> parsed =
      base::JSONReader::ReadDict(reply, base::JSON_PARSE_RFC);
  if (!parsed) {
    return std::nullopt;
  }
  return parsed->FindBool("enabled");
}

// `domicile disable-while-typing`. See docs/RUNNING-A-DESKTOP.md.
TEST(CommandProtocolTest, SaysWhetherTheTouchpadsRestWhileTyping) {
  Told told;
  const std::string reply =
      Answer(R"({"type":"disable_while_typing","version":1})", &told);
  EXPECT_EQ(TypeOf(reply), "disable_while_typing");
  EXPECT_EQ(EnabledOf(reply), true);
}

TEST(CommandProtocolTest, TurnsDisableWhileTypingOff) {
  Told told;
  const std::string reply = Answer(
      R"({"type":"disable_while_typing","version":1,"enabled":false})", &told);
  EXPECT_EQ(EnabledOf(reply), false);
  EXPECT_FALSE(told.typing_rests);
}

TEST(CommandProtocolTest, RefusesDisableWhileTypingItCannotSet) {
  Told told;
  EXPECT_EQ(TypeOf(Answer(
                R"({"type":"disable_while_typing","version":1,"enabled":"no"})",
                &told)),
            "refused");
  EXPECT_TRUE(told.typing_rests);
  EXPECT_EQ(WhyOf(Answer(R"({"type":"disable_while_typing","version":1})",
                         &told, /*has_window=*/false)),
            "no touchpad");
}

// `domicile set-log-level`. The supervisor turns subsystems into `vmodule`
// patterns; see domicile-launch's engine_log_levels.rs.
TEST(CommandProtocolTest, SetsTheLogLevels) {
  Told told;
  EXPECT_EQ(TypeOf(Answer(
                R"({"type":"set_log_levels","version":1,"min_level":0,)"
                R"("vmodule":"*/domicile/*=2"})",
                &told)),
            "set");
  EXPECT_EQ(told.min_log_level, 0);
  EXPECT_EQ(told.vmodule, "*/domicile/*=2");
}

TEST(CommandProtocolTest, SetsVerboseForTheShellsConsoleDebug) {
  // A shell's console.debug is VERBOSE, which `domicile set-log-level debug
  // shell` asks for.
  Told told;
  EXPECT_EQ(TypeOf(Answer(
                R"({"type":"set_log_levels","version":1,"min_level":-1,)"
                R"("vmodule":""})",
                &told)),
            "set");
  EXPECT_EQ(told.min_log_level, -1);
}

TEST(CommandProtocolTest, RefusesALogLevelChromiumHasNot) {
  // -1 is VERBOSE, a shell's console.debug, and 3 is FATAL. Below -1 is a
  // VLOG level, which `vmodule` sets per file instead of turning on all of
  // Chromium's.
  Told told;
  for (const char* line :
       {R"({"type":"set_log_levels","version":1,"min_level":-2,"vmodule":""})",
        R"({"type":"set_log_levels","version":1,"min_level":4,"vmodule":""})",
        R"({"type":"set_log_levels","version":1,"vmodule":""})",
        R"({"type":"set_log_levels","version":1,"min_level":2})"}) {
    EXPECT_EQ(TypeOf(Answer(line, &told)), "refused") << line;
  }
  EXPECT_EQ(told.min_log_level, std::nullopt);
}

// The History app, which these replace `chrome.history` and
// `chrome.browsingData` for. See docs/architecture/APP-MODULES.md.
TEST(CommandProtocolTest, ListsHistoryWithEachPagesFavicon) {
  Told told;
  EXPECT_EQ(
      base::JSONReader::ReadDict(
          Answer(R"({"type":"history","version":1,"text":"news",)"
                 R"("end_time":1700000000000.5,"max_results":100})",
                 &told),
          base::JSON_PARSE_RFC),
      base::JSONReader::ReadDict(
          R"({"type":"history","items":[)"
          R"({"url":"https://news.example/","title":"News",)"
          R"("favicon":"data:image/png;base64,iVBORw=="},)"
          R"({"url":"https://plain.example/","title":""}]})",
          base::JSON_PARSE_RFC));
  ASSERT_TRUE(told.search.has_value());
  EXPECT_EQ(told.search->text, "news");
  EXPECT_EQ(told.search->end_time, AtMicroseconds(1700000000000500));
  EXPECT_EQ(told.search->max_results, 100);

  const std::string refused =
      Answer(R"({"type":"history","version":1,"text":"",)"
             R"("end_time":1700000000000,"max_results":100})",
             &told, /*has_window=*/false);
  EXPECT_EQ(TypeOf(refused), "refused");
  EXPECT_THAT(WhyOf(refused), HasSubstr("no shell"));
}

TEST(CommandProtocolTest, RefusesAHistorySearchMissingAField) {
  Told told;
  EXPECT_EQ(TypeOf(Answer(R"({"type":"history","version":1,)"
                          R"("end_time":1700000000000,"max_results":100})",
                          &told)),
            "refused");
  EXPECT_EQ(TypeOf(Answer(R"({"type":"history","version":1,"text":"",)"
                          R"("max_results":100})",
                          &told)),
            "refused");
  EXPECT_EQ(TypeOf(Answer(R"({"type":"history","version":1,"text":"",)"
                          R"("end_time":1700000000000,"max_results":0})",
                          &told)),
            "refused");
  EXPECT_FALSE(told.search.has_value());
}

TEST(CommandProtocolTest, ListsAPagesVisits) {
  Told told;
  EXPECT_EQ(base::JSONReader::ReadDict(
                Answer(R"({"type":"visits","version":1,)"
                       R"("url":"https://news.example/"})",
                       &told),
                base::JSON_PARSE_RFC),
            base::JSONReader::ReadDict(
                R"({"type":"visits",)"
                R"("times":[1700000000000.5,1700000000123.0]})",
                base::JSON_PARSE_RFC));
  EXPECT_EQ(told.visits_of, "https://news.example/");

  told.visits_of.clear();
  const std::string refused = Answer(
      R"({"type":"visits","version":1,"url":"not a url"})", &told);
  EXPECT_EQ(TypeOf(refused), "refused");
  EXPECT_THAT(WhyOf(refused), HasSubstr("not a url"));
  EXPECT_TRUE(told.visits_of.empty());
}

// A visit time arrives as fractional milliseconds, which a double holds only
// to within a fraction of a microsecond; it is the nearest microsecond.
TEST(CommandProtocolTest, DeletesTheVisitsARequestNames) {
  Told told;
  EXPECT_EQ(TypeOf(Answer(R"({"type":"delete_history","version":1,)"
                          R"("visits":[1700000000000.123,1700000000999]})",
                          &told)),
            "deleted");
  EXPECT_EQ(told.deleted,
            (std::vector<base::Time>{AtMicroseconds(1700000000000123),
                                     AtMicroseconds(1700000000999000)}));

  const std::string refused =
      Answer(R"({"type":"delete_history","version":1,"visits":[1]})", &told,
             /*has_window=*/false);
  EXPECT_EQ(TypeOf(refused), "refused");
  EXPECT_THAT(WhyOf(refused), HasSubstr("no shell"));
}

TEST(CommandProtocolTest, RefusesADeletionThatIsNotAListOfTimes) {
  Told told;
  EXPECT_EQ(TypeOf(Answer(R"({"type":"delete_history","version":1})", &told)),
            "refused");
  EXPECT_EQ(TypeOf(Answer(R"({"type":"delete_history","version":1,)"
                          R"("visits":[1700000000000,"yesterday"]})",
                          &told)),
            "refused");
  EXPECT_FALSE(told.deleted.has_value());
}

TEST(CommandProtocolTest, ClearsTheBrowsingDataARequestNames) {
  Told told;
  EXPECT_EQ(TypeOf(Answer(R"({"type":"clear_browsing_data","version":1,)"
                          R"("since":1700000000000,)"
                          R"("types":["history","cookies","cache"]})",
                          &told)),
            "cleared");
  ASSERT_TRUE(told.clearing.has_value());
  EXPECT_EQ(told.clearing->since, AtMicroseconds(1700000000000000));
  EXPECT_EQ(told.clearing->kinds,
            (std::vector<BrowsingDataKind>{BrowsingDataKind::kHistory,
                                           BrowsingDataKind::kCookies,
                                           BrowsingDataKind::kCache}));
  EXPECT_TRUE(told.clearing->origins.empty());

  // Since 0 is all time, as for `chrome.browsingData`.
  EXPECT_EQ(TypeOf(Answer(R"({"type":"clear_browsing_data","version":1,)"
                          R"("since":0,"types":["localStorage"],)"
                          R"("origins":["https://a.example"]})",
                          &told)),
            "cleared");
  EXPECT_TRUE(told.clearing->since.is_null());
  EXPECT_EQ(told.clearing->origins,
            std::vector<url::Origin>{
                url::Origin::Create(GURL("https://a.example"))});

  const std::string refused =
      Answer(R"({"type":"clear_browsing_data","version":1,"since":0,)"
             R"("types":["cache"]})",
             &told, /*has_window=*/false);
  EXPECT_EQ(TypeOf(refused), "refused");
  EXPECT_THAT(WhyOf(refused), HasSubstr("no shell"));
}

TEST(CommandProtocolTest, RefusesBrowsingDataItCannotClear) {
  Told told;
  const std::string unknown =
      Answer(R"({"type":"clear_browsing_data","version":1,"since":0,)"
             R"("types":["cookies","appcache"]})",
             &told);
  EXPECT_EQ(TypeOf(unknown), "refused");
  EXPECT_THAT(WhyOf(unknown), HasSubstr("appcache"));

  const std::string not_a_site =
      Answer(R"({"type":"clear_browsing_data","version":1,"since":0,)"
             R"("types":["cookies"],"origins":["not a url"]})",
             &told);
  EXPECT_EQ(TypeOf(not_a_site), "refused");
  EXPECT_THAT(WhyOf(not_a_site), HasSubstr("not a url"));

  // History is kept per visit, not per site.
  const std::string per_site =
      Answer(R"({"type":"clear_browsing_data","version":1,"since":0,)"
             R"("types":["history"],"origins":["https://a.example"]})",
             &told);
  EXPECT_EQ(TypeOf(per_site), "refused");
  EXPECT_THAT(WhyOf(per_site), HasSubstr("history"));

  EXPECT_EQ(TypeOf(Answer(R"({"type":"clear_browsing_data","version":1,)"
                          R"("types":["cookies"]})",
                          &told)),
            "refused");
  EXPECT_FALSE(told.clearing.has_value());
}

// Sizes pass five billion bytes, past what an int holds.
TEST(CommandProtocolTest, ListsEachSitesStoredData) {
  Told told;
  const std::string reply =
      Answer(R"({"type":"site_data","version":1})", &told);
  EXPECT_EQ(base::JSONReader::ReadDict(reply, base::JSON_PARSE_RFC),
            base::JSONReader::ReadDict(
                R"({"type":"site_data","sites":[)"
                R"({"host":"mail.example","bytes":5000000000.0,"cookies":3},)"
                R"({"host":"notes.example","bytes":2048.0,"cookies":0}]})",
                base::JSON_PARSE_RFC));

  const std::string refused =
      Answer(R"({"type":"site_data","version":1})", &told,
             /*has_window=*/false);
  EXPECT_EQ(TypeOf(refused), "refused");
  EXPECT_THAT(WhyOf(refused), HasSubstr("no shell"));
}

TEST(CommandProtocolTest, ClearsTheSiteDataOfTheHostARequestNames) {
  Told told;
  EXPECT_EQ(TypeOf(Answer(R"({"type":"clear_site_data","version":1,)"
                          R"("host":"mail.example"})",
                          &told)),
            "cleared");
  EXPECT_EQ(told.cleared_host, "mail.example");

  const std::string refused =
      Answer(R"({"type":"clear_site_data","version":1,"host":"a.example"})",
             &told, /*has_window=*/false);
  EXPECT_EQ(TypeOf(refused), "refused");
  EXPECT_THAT(WhyOf(refused), HasSubstr("no shell"));

  told.cleared_host.clear();
  for (const char* line :
       {R"({"type":"clear_site_data","version":1})",
        R"({"type":"clear_site_data","version":1,"host":""})",
        R"({"type":"clear_site_data","version":1,"host":7})"}) {
    const std::string no_host = Answer(line, &told);
    EXPECT_EQ(TypeOf(no_host), "refused");
    EXPECT_THAT(WhyOf(no_host), HasSubstr("\"host\""));
  }
  EXPECT_TRUE(told.cleared_host.empty());
}

TEST(CommandProtocolTest, SendsADevToolsMethodToABrowserWindow) {
  Told told;
  const std::string reply = Answer(
      R"({"type":"devtools","version":1,"window":"w1",)"
      R"("method":"DOM.getBoxModel","params":{"backendNodeId":7}})",
      &told);
  EXPECT_EQ(base::JSONReader::ReadDict(reply, base::JSON_PARSE_RFC),
            base::JSONReader::ReadDict(
                R"({"type":"devtools","result":{"sent":"DOM.getBoxModel"}})",
                base::JSON_PARSE_RFC));
  EXPECT_EQ(told.devtools_window, "w1");
  EXPECT_EQ(told.devtools_method, "DOM.getBoxModel");
  EXPECT_EQ(told.devtools_params,
            base::JSONReader::ReadDict(R"({"backendNodeId":7})",
                                       base::JSON_PARSE_RFC));
}

TEST(CommandProtocolTest, SendsADevToolsMethodWithoutParamsAsAnEmptyObject) {
  Told told;
  EXPECT_EQ(TypeOf(Answer(R"({"type":"devtools","version":1,"window":"w1",)"
                          R"("method":"Accessibility.getFullAXTree"})",
                          &told)),
            "devtools");
  EXPECT_EQ(told.devtools_params, base::DictValue());
}

TEST(CommandProtocolTest, PassesOnWhyABrowserWindowCouldNotAnswer) {
  Told told;
  const std::string refused =
      Answer(R"({"type":"devtools","version":1,"window":"w9",)"
             R"("method":"Page.reload"})",
             &told, /*has_window=*/false);
  EXPECT_EQ(TypeOf(refused), "refused");
  EXPECT_THAT(WhyOf(refused), HasSubstr("no browser window w9"));
}

// An agent drives pages, but reads no cookies and runs no script of its own.
TEST(CommandProtocolTest, RefusesADevToolsMethodAgentsDoNotGet) {
  Told told;
  for (const char* method :
       {"Runtime.evaluate", "Network.getCookies", "Storage.getCookies",
        "Target.createTarget", "Browser.close", "page.reload"}) {
    const std::string refused =
        Answer(base::StrCat({R"({"type":"devtools","version":1,)",
                             R"("window":"w1","method":")",
                             method, R"("})"}),
               &told);
    EXPECT_EQ(TypeOf(refused), "refused") << method;
    EXPECT_THAT(WhyOf(refused), HasSubstr(method));
    EXPECT_THAT(WhyOf(refused), HasSubstr("Accessibility.getFullAXTree"));
  }
  EXPECT_TRUE(told.devtools_method.empty());
}

TEST(CommandProtocolTest, NavigatesABrowserWindowOnlyToTheWeb) {
  Told told;
  EXPECT_EQ(TypeOf(Answer(R"({"type":"devtools","version":1,"window":"w1",)"
                          R"("method":"Page.navigate",)"
                          R"("params":{"url":"https://example.com/"}})",
                          &told)),
            "devtools");

  told.devtools_method.clear();
  for (const char* url :
       {"file:///etc/passwd", "javascript:alert(1)", "chrome://settings",
        "not a url"}) {
    const std::string refused =
        Answer(base::StrCat({R"({"type":"devtools","version":1,)",
                             R"("window":"w1","method":"Page.navigate",)",
                             R"("params":{"url":")", url, R"("}})"}),
               &told);
    EXPECT_EQ(TypeOf(refused), "refused") << url;
    EXPECT_THAT(WhyOf(refused), HasSubstr("http"));
  }
  EXPECT_EQ(TypeOf(Answer(R"({"type":"devtools","version":1,"window":"w1",)"
                          R"("method":"Page.navigate","params":{}})",
                          &told)),
            "refused");
  EXPECT_TRUE(told.devtools_method.empty());
}

TEST(CommandProtocolTest, RefusesADevToolsRequestMissingAField) {
  Told told;
  for (const char* line :
       {R"({"type":"devtools","version":1,"method":"Page.reload"})",
        R"({"type":"devtools","version":1,"window":"","method":"Page.reload"})",
        R"({"type":"devtools","version":1,"window":"w1"})",
        R"({"type":"devtools","version":1,"window":"w1",)"
        R"("method":"Page.reload","params":[1]})"}) {
    EXPECT_EQ(TypeOf(Answer(line, &told)), "refused") << line;
  }
  EXPECT_TRUE(told.devtools_method.empty());
}

}  // namespace
}  // namespace domicile
