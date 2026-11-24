// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/browser/electron_app.h"

#include <algorithm>
#include <iterator>
#include <memory>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <utility>
#include <variant>
#include <vector>

#include "base/check.h"
#include "base/functional/bind.h"
#include "base/json/json_writer.h"
#include "base/logging.h"
#include "base/strings/strcat.h"
#include "base/strings/string_number_conversions.h"
#include "base/types/expected.h"
#include "components/domicile/browser/electron_session_events.h"
#include "url/url_constants.h"

namespace domicile {
namespace {

std::string Json(const base::Value& value) {
  std::string json;
  // Parsed from the app's JSON, so it writes.
  CHECK(base::JSONWriter::Write(value, &json));
  return json;
}

// The schemes whose requests go to the network unless the app handles them.
bool IsNetworkScheme(std::string_view scheme) {
  return scheme == url::kHttpScheme || scheme == url::kHttpsScheme;
}

}  // namespace

ElectronSession::ElectronSession(ElectronApp& app, std::string name)
    : app_(app), name_(std::move(name)) {}

ElectronSession::~ElectronSession() = default;

const std::string& ElectronSession::user_agent() const {
  return user_agent_.empty() ? app_->user_agent_fallback_ : user_agent_;
}

const ElectronHello& ElectronSession::hello() const {
  CHECK(app_->hello_.has_value())
      << "domicile: an Electron session was made before its app's hello";
  return *app_->hello_;
}

bool ElectronSession::Handles(std::string_view scheme) const {
  return schemes_.contains(std::string(scheme));
}

std::vector<std::string> ElectronSession::LocalSchemes() const {
  std::vector<std::string> local;
  std::ranges::copy_if(
      schemes_, std::back_inserter(local),
      [](const std::string& scheme) { return !IsNetworkScheme(scheme); });
  return local;
}

void ElectronSession::Fetch(ElectronFetch fetch,
                            std::unique_ptr<ElectronResponder> responder) {
  app_->StartFetch(name_, std::move(fetch), std::move(responder));
}

bool ElectronSession::ListensFor(ElectronWebRequestEvent event) const {
  return web_request_events_.contains(event);
}

void ElectronSession::AskWebRequest(ElectronWebRequestEvent event,
                                    const std::optional<std::string>& window,
                                    ElectronWebRequestDetails details,
                                    ElectronWebRequestAnswered answered) {
  CHECK(IsBlockingElectronWebRequestEvent(event));
  app_->StartAsk(name_, event, window, details, std::move(answered));
}

void ElectronSession::AskPermission(
    const std::string& window,
    ElectronPermissionDetails details,
    base::OnceCallback<void(bool granted)> answered) {
  CHECK(handles_permissions_);
  app_->StartPermissionAsk(name_, window, details, std::move(answered));
}

int ElectronSession::AskDownload(
    const std::string& window,
    const ElectronDownloadDetails& details,
    base::WeakPtr<ElectronDownloadControl> control,
    base::OnceCallback<void(ElectronDownloadAnswer)> decided) {
  return app_->StartDownloadAsk(name_, window, details, std::move(control),
                                std::move(decided));
}

void ElectronSession::TellPreconnect(const GURL& url, bool allow_credentials) {
  app_->send_.Run(ElectronPreconnected(name_, url, allow_credentials));
}

void ElectronSession::DownloadUpdated(
    int download,
    const ElectronDownloadProgress& progress) {
  app_->DownloadUpdated(download, progress);
}

void ElectronSession::TellWebRequest(ElectronWebRequestEvent event,
                                     const std::optional<std::string>& window,
                                     ElectronWebRequestDetails details) {
  CHECK(!IsBlockingElectronWebRequestEvent(event));
  app_->SendWebRequest(name_, event, std::nullopt, window, details);
}

std::optional<ElectronPermissionDetails> ElectronPermissionFor(
    const std::vector<mojom::WebViewPermission>& permissions,
    const GURL& origin) {
  ElectronPermissionDetails details{.requesting_url = origin};
  for (mojom::WebViewPermission permission : permissions) {
    std::string_view name;
    // No default arm, so a new kind fails the build until it has a name or
    // says why it has none.
    switch (permission) {
      case mojom::WebViewPermission::kCamera:
        name = "media";
        details.media_types.push_back("video");
        break;
      case mojom::WebViewPermission::kMicrophone:
        name = "media";
        details.media_types.push_back("audio");
        break;
      case mojom::WebViewPermission::kLocation:
        name = "geolocation";
        break;
      case mojom::WebViewPermission::kNotifications:
        name = "notifications";
        break;
      case mojom::WebViewPermission::kClipboard:
        name = "clipboard-read";
        break;
      case mojom::WebViewPermission::kMidi:
        name = "midiSysex";
        break;
      case mojom::WebViewPermission::kWindowManagement:
        name = "window-management";
        break;
      case mojom::WebViewPermission::kIdleDetection:
        name = "idle-detection";
        break;
      case mojom::WebViewPermission::kLocalFonts:
        // Electron asks its handler about local fonts as "unknown".
        name = "unknown";
        break;
      case mojom::WebViewPermission::kAutomaticDownloads:
        // Electron never asks about downloads; the shell does.
        return std::nullopt;
    }
    if (!details.permission.empty() && details.permission != name) {
      return std::nullopt;
    }
    details.permission = std::string(name);
  }
  if (details.permission.empty()) {
    return std::nullopt;
  }
  return details;
}

ElectronApp::ElectronApp(ElectronDesk& desk,
                         Send send,
                         ElectronEngineInfo engine,
                         std::vector<ElectronScheme> schemes)
    : desk_(desk),
      send_(std::move(send)),
      engine_(std::move(engine)),
      schemes_(std::move(schemes)) {}

ElectronApp::~ElectronApp() {
  for (const auto& [number, window] : windows_) {
    desk_->Close(window.id);
  }
  // A request the app's listener never answered does not go ahead as if it
  // had said nothing.
  for (auto& [number, ask] : std::exchange(asks_, {})) {
    std::move(ask.answered)
        .Run(ElectronWebRequestAnswer{.ask = number, .cancel = true});
  }
  // Nor is a permission the handler never answered granted.
  for (auto& [number, answered] : std::exchange(permission_asks_, {})) {
    std::move(answered).Run(false);
  }
  // Nor is a download the app never placed saved anywhere.
  for (auto& [number, download] : std::exchange(downloads_, {})) {
    if (download.decided) {
      std::move(download.decided)
          .Run(ElectronDownloadAnswer{.download = number, .cancel = true});
    }
  }
  // Nor does a window the app never allowed open: a held one closes.
  window_open_asks_.clear();
  // Nor does a navigation the app never let through, while a page whose
  // `beforeunload` asked to stay leaves with its window.
  for (auto& [number, answered] : std::exchange(navigation_asks_, {})) {
    std::move(answered).Run(false);
  }
  for (auto& [number, answered] : std::exchange(unload_asks_, {})) {
    std::move(answered).Run(true);
  }
}

void ElectronApp::Take(std::string_view line) {
  base::expected<ElectronRequest, ElectronRefusal> request =
      ParseElectronRequest(line);
  if (!request.has_value() && request.error().page_call.has_value()) {
    send_.Run(ElectronPageResult(*request.error().window,
                                 *request.error().page_call,
                                 base::unexpected(request.error().why)));
  } else if (!request.has_value() && request.error().window.has_value()) {
    send_.Run(
        ElectronWindowRefused(*request.error().window, request.error().why));
  } else if (!request.has_value() && request.error().request.has_value()) {
    FailRequest(*request.error().request, request.error().why);
  } else if (!request.has_value() && request.error().call.has_value()) {
    send_.Run(ElectronSessionResult(*request.error().call,
                                    base::unexpected(request.error().why)));
  } else if (!request.has_value()) {
    send_.Run(ElectronRefused(request.error().why));
  } else if (const auto* hello = std::get_if<ElectronHello>(&*request)) {
    if (hello_.has_value()) {
      send_.Run(ElectronRefused("this app already said hello"));
    } else {
      hello_ = *hello;
      send_.Run(ElectronReady(schemes_, engine_));
      for (const std::string& language : dictionaries_) {
        send_.Run(ElectronSpellcheckDictionaryInitialized(language));
      }
    }
  } else if (!hello_.has_value()) {
    send_.Run(ElectronRefused("an app says hello first"));
  } else if (const auto* open = std::get_if<ElectronOpenWindow>(&*request)) {
    Open(*open);
  } else if (const auto* load = std::get_if<ElectronLoadUrl>(&*request)) {
    if (const std::optional<std::string> id = IdOf(load->window);
        id.has_value() &&
        Opens(load->window, windows_.at(load->window).session, load->url)) {
      desk_->Load(*id, load->url);
    }
  } else if (const auto* focus = std::get_if<ElectronFocusWindow>(&*request)) {
    if (const std::optional<std::string> id = IdOf(focus->window)) {
      desk_->Focus(*id);
    }
  } else if (const auto* go = std::get_if<ElectronGoToIndex>(&*request)) {
    if (const std::optional<std::string> id = IdOf(go->window)) {
      desk_->GoToIndex(*id, go->index);
    }
  } else if (const auto* clear = std::get_if<ElectronClearHistory>(&*request)) {
    if (const std::optional<std::string> id = IdOf(clear->window)) {
      desk_->ClearHistory(*id);
    }
  } else if (const auto* remove =
                 std::get_if<ElectronRemoveHistoryEntry>(&*request)) {
    if (const std::optional<std::string> id = IdOf(remove->window)) {
      desk_->RemoveHistoryEntry(*id, remove->index);
    }
  } else if (const auto* navigation_listen =
                 std::get_if<ElectronNavigationListen>(&*request)) {
    if (IdOf(navigation_listen->window)) {
      windows_.at(navigation_listen->window).listens_for_navigation =
          navigation_listen->listening;
    }
  } else if (const auto* edit = std::get_if<ElectronEdit>(&*request)) {
    if (const std::optional<std::string> id = IdOf(edit->window)) {
      desk_->Edit(*id, edit->command);
    }
  } else if (const auto* replace = std::get_if<ElectronReplace>(&*request)) {
    if (const std::optional<std::string> id = IdOf(replace->window)) {
      desk_->Replace(*id, replace->text, replace->misspelling);
    }
  } else if (const auto* find = std::get_if<ElectronFindInPage>(&*request)) {
    if (const std::optional<std::string> id = IdOf(find->window)) {
      desk_->FindInPage(*id, *find);
    }
  } else if (const auto* stop =
                 std::get_if<ElectronStopFindInPage>(&*request)) {
    if (const std::optional<std::string> id = IdOf(stop->window)) {
      desk_->StopFindInPage(*id, stop->action);
    }
  } else if (const auto* title = std::get_if<ElectronSetTitle>(&*request)) {
    if (const std::optional<std::string> id =
            WindowIdOf(title->window, "a title")) {
      desk_->SetTitle(*id, title->title);
    }
  } else if (const auto* hidden = std::get_if<ElectronSetHidden>(&*request)) {
    if (const std::optional<std::string> id =
            WindowIdOf(hidden->window, "hiding")) {
      desk_->SetHidden(*id, hidden->hidden);
    }
  } else if (const auto* asked =
                 std::get_if<ElectronSetWindowState>(&*request)) {
    if (const std::optional<std::string> id =
            WindowIdOf(asked->window, "a window state")) {
      desk_->SetWindowState(*id, asked->state);
    }
  } else if (const auto* fallback =
                 std::get_if<ElectronSetUserAgentFallback>(&*request)) {
    SetUserAgentFallback(*fallback);
  } else if (auto* page = std::get_if<ElectronPageRequest>(&*request)) {
    AskPage(std::move(*page));
  } else if (const auto* close = std::get_if<ElectronCloseWindow>(&*request)) {
    if (const std::optional<std::string> id = IdOf(close->window)) {
      desk_->AskToClose(*id);
    }
  } else if (auto* send = std::get_if<ElectronSendToPage>(&*request)) {
    if (const std::optional<std::string> id = IdOf(send->window)) {
      desk_->SendToPage(*id, send->channel,
                        Json(base::Value(send->args.Clone())));
    }
  } else if (auto* run = std::get_if<ElectronExecuteJavaScript>(&*request)) {
    if (const std::optional<std::string> id = IdOf(run->window)) {
      desk_->ExecuteJavaScript(
          *id, run->code, run->user_gesture,
          base::BindOnce(
              [](base::WeakPtr<ElectronApp> app, ElectronWindow window,
                 int call, base::expected<base::Value, std::string> result) {
                if (app) {
                  app->send_.Run(
                      ElectronJavaScriptResult(window, call, result));
                }
              },
              weak_factory_.GetWeakPtr(), run->window, run->call));
    }
  } else if (auto* post = std::get_if<ElectronPostToPage>(&*request)) {
    if (const std::optional<std::string> id = IdOf(post->window)) {
      desk_->PostToPage(*id, post->channel, Json(post->message), post->ports);
    }
  } else if (auto* port = std::get_if<ElectronPortPost>(&*request)) {
    if (const std::optional<std::string> id = IdOf(port->window)) {
      desk_->PostToPort(*id, port->port, Json(port->data));
    }
  } else if (auto* close_port = std::get_if<ElectronPortClose>(&*request)) {
    if (const std::optional<std::string> id = IdOf(close_port->window)) {
      desk_->ClosePort(*id, close_port->port);
    }
  } else if (auto* reply = std::get_if<ElectronReply>(&*request)) {
    Reply(std::move(*reply));
  } else if (auto* handle = std::get_if<ElectronHandleProtocol>(&*request)) {
    HandleProtocol(*handle);
  } else if (auto* response =
                 std::get_if<ElectronProtocolResponse>(&*request)) {
    Respond(std::move(*response));
  } else if (auto* data = std::get_if<ElectronProtocolData>(&*request)) {
    ReceiveData(std::move(*data));
  } else if (auto* end = std::get_if<ElectronProtocolEnd>(&*request)) {
    EndBody(*end);
  } else if (auto* listen = std::get_if<ElectronWebRequestListen>(&*request)) {
    ListenForWebRequests(std::move(*listen));
  } else if (auto* answer = std::get_if<ElectronWebRequestAnswer>(&*request)) {
    Answer(std::move(*answer));
  } else if (auto* call = std::get_if<ElectronSessionCall>(&*request)) {
    RunSessionCall(std::move(*call));
  } else if (auto* handler =
                 std::get_if<ElectronPermissionHandler>(&*request)) {
    HandlePermissions(*handler);
  } else if (auto* permission =
                 std::get_if<ElectronPermissionAnswer>(&*request)) {
    AnswerPermission(*permission);
  } else if (auto* download = std::get_if<ElectronDownloadAnswer>(&*request)) {
    AnswerDownload(std::move(*download));
  } else if (auto* control =
                 std::get_if<ElectronDownloadControlCall>(&*request)) {
    ControlDownload(*control);
  } else if (auto* window_open =
                 std::get_if<ElectronWindowOpenAnswer>(&*request)) {
    AnswerWindowOpen(std::move(*window_open));
  } else if (const auto* navigation =
                 std::get_if<ElectronNavigationAnswer>(&*request)) {
    AnswerNavigation(*navigation);
  } else if (const auto* unload =
                 std::get_if<ElectronUnloadAnswer>(&*request)) {
    AnswerUnload(*unload);
  } else if (auto* set = std::get_if<ElectronSetViews>(&*request)) {
    SetViews(*set);
  } else if (auto* bar = std::get_if<ElectronSetMenuBar>(&*request)) {
    SetMenuBar(*bar);
  } else if (auto* box = std::get_if<ElectronShowMessageBox>(&*request)) {
    ShowMessageBox(*box);
  } else if (auto* popup = std::get_if<ElectronPopupMenu>(&*request)) {
    PopupMenu(*popup);
  } else if (auto* close_popup =
                 std::get_if<ElectronClosePopupMenu>(&*request)) {
    ClosePopupMenu(*close_popup);
  } else if (auto* page_call = std::get_if<ElectronPageCall>(&*request)) {
    CallPage(std::move(*page_call));
  } else if (auto* sign_in = std::get_if<ElectronSignInReply>(&*request)) {
    AnswerSignIn(*sign_in);
  } else {
    const auto& destroy = std::get<ElectronDestroyWindow>(*request);
    if (const std::optional<std::string> id = IdOf(destroy.window)) {
      // Reported closed when the desk's list drops it, as any other close.
      desk_->Close(*id);
    }
  }
}

void ElectronApp::Listed(const std::vector<ListedBrowserWindow>& listing) {
  std::vector<ElectronWindow> closed;
  for (auto& [number, window] : windows_) {
    auto listed =
        std::ranges::find(listing, window.id, &ListedBrowserWindow::id);
    if (listed == listing.end()) {
      closed.push_back(number);
    } else if (listed->title != window.title) {
      window.title = listed->title;
      send_.Run(ElectronTitleChanged(number, window.title));
    }
  }
  for (ElectronWindow number : closed) {
    windows_.erase(number);
    send_.Run(ElectronWindowClosed(number));
  }
}

void ElectronApp::Loaded(const std::string& id) {
  auto found = std::ranges::find_if(
      windows_, [&id](const auto& entry) { return entry.second.id == id; });
  if (found != windows_.end()) {
    send_.Run(ElectronWindowLoaded(found->first));
  }
}

void ElectronApp::DomReady(const std::string& id) {
  auto found = std::ranges::find_if(
      windows_, [&id](const auto& entry) { return entry.second.id == id; });
  if (found != windows_.end()) {
    send_.Run(ElectronWindowDomReady(found->first));
  }
}

void ElectronApp::SpellcheckDictionaryInitialized(const std::string& language) {
  // Before the hello, the app hears it with its ready.
  if (dictionaries_.insert(language).second && hello_.has_value()) {
    send_.Run(ElectronSpellcheckDictionaryInitialized(language));
  }
}

void ElectronApp::GpuInfoUpdated() {
  if (hello_.has_value()) {
    send_.Run(ElectronGpuInfoUpdated());
  }
}

void ElectronApp::Open(const ElectronOpenWindow& open) {
  CHECK(hello_.has_value());
  if (windows_.contains(open.window)) {
    send_.Run(ElectronWindowRefused(
        open.window, base::StrCat({"window ", base::NumberToString(open.window),
                                   " is already open"})));
    return;
  }
  base::expected<WebViewPartition, std::string> partition =
      ElectronSessionPartition(hello_->partition, open.session);
  if (!partition.has_value()) {
    send_.Run(ElectronWindowRefused(open.window, partition.error()));
    return;
  } else if (!Opens(open.window, open.session, open.url)) {
    return;
  } else if (open.history.has_value() &&
             !std::ranges::all_of(open.history->entries,
                                  [&](const ElectronHistory::Entry& entry) {
                                    return Opens(open.window, open.session,
                                                 entry.url);
                                  })) {
    return;
  }
  ElectronPageCalls calls = CallsFor(open.window);
  const std::optional<std::string> id = desk_->Open(
      open.url, open.history, hello_->app_id, *partition, open.preload,
      open.arguments, open.node, std::move(calls),
      SessionNamed(open.session).GetWeakPtr(), open.view, open.title,
      open.hidden, open.user_agent);
  if (!id.has_value()) {
    send_.Run(
        ElectronWindowRefused(open.window, "there is no shell to open it in"));
  } else {
    // The session's user agent reaches the desk through the session, before
    // the window's first navigation.
    windows_.emplace(open.window, Window{.id = *id,
                                         .title = std::string(),
                                         .session = open.session,
                                         .view = open.view,
                                         .user_agent = open.user_agent});
    send_.Run(ElectronWindowOpened(open.window));
  }
}

ElectronPageCalls ElectronApp::CallsFor(ElectronWindow number) {
  return ElectronPageCalls{
      .sent = base::BindRepeating(&ElectronApp::PageSent,
                                  weak_factory_.GetWeakPtr(), number),
      .invoked = base::BindRepeating(&ElectronApp::PageInvoked,
                                     weak_factory_.GetWeakPtr(), number, false),
      .sent_sync = base::BindRepeating(
          &ElectronApp::PageInvoked, weak_factory_.GetWeakPtr(), number, true),
      .posted = base::BindRepeating(&ElectronApp::PagePosted,
                                    weak_factory_.GetWeakPtr(), number),
      .port_posted = base::BindRepeating(&ElectronApp::PagePortPosted,
                                         weak_factory_.GetWeakPtr(), number),
      .port_closed = base::BindRepeating(&ElectronApp::PagePortClosed,
                                         weak_factory_.GetWeakPtr(), number),
      .gone = base::BindRepeating(&ElectronApp::PageGone,
                                  weak_factory_.GetWeakPtr(), number),
      .resized = base::BindRepeating(&ElectronApp::PageResized,
                                     weak_factory_.GetWeakPtr(), number),
      .menu_clicked = base::BindRepeating(&ElectronApp::MenuClicked,
                                          weak_factory_.GetWeakPtr(), number),
      .close_asked = base::BindRepeating(&ElectronApp::CloseAsked,
                                         weak_factory_.GetWeakPtr(), number),
      .window_opening = base::BindRepeating(&ElectronApp::PageWindowOpening,
                                            weak_factory_.GetWeakPtr(), number),
      .state = base::BindRepeating(&ElectronApp::PageStateChanged,
                                   weak_factory_.GetWeakPtr(), number),
      .found = base::BindRepeating(&ElectronApp::PageFound,
                                   weak_factory_.GetWeakPtr(), number),
      .context_menu = base::BindRepeating(&ElectronApp::PageContextMenu,
                                          weak_factory_.GetWeakPtr(), number),
      .window_state = base::BindRepeating(&ElectronApp::WindowStateChanged,
                                          weak_factory_.GetWeakPtr(), number),
      .devtools_event = base::BindRepeating(&ElectronApp::PageDevToolsEvent,
                                            weak_factory_.GetWeakPtr(), number),
      .navigation_started =
          base::BindRepeating(&ElectronApp::PageNavigationStarted,
                              weak_factory_.GetWeakPtr(), number),
      .navigation_redirected =
          base::BindRepeating(&ElectronApp::PageNavigationRedirected,
                              weak_factory_.GetWeakPtr(), number),
      .navigation_committed =
          base::BindRepeating(&ElectronApp::PageNavigationCommitted,
                              weak_factory_.GetWeakPtr(), number),
      .load_failed = base::BindRepeating(&ElectronApp::PageLoadFailed,
                                         weak_factory_.GetWeakPtr(), number),
      .frame_loaded = base::BindRepeating(&ElectronApp::PageFrameLoaded,
                                          weak_factory_.GetWeakPtr(), number),
      .frame_created = base::BindRepeating(&ElectronApp::PageFrameCreated,
                                           weak_factory_.GetWeakPtr(), number),
      .will_navigate = base::BindRepeating(&ElectronApp::PageWillNavigate,
                                           weak_factory_.GetWeakPtr(), number),
      .will_prevent_unload =
          base::BindRepeating(&ElectronApp::PageWillPreventUnload,
                              weak_factory_.GetWeakPtr(), number),
      .reported = base::BindRepeating(&ElectronApp::PageReported,
                                      weak_factory_.GetWeakPtr(), number),
  };
}

void ElectronApp::PageReported(ElectronWindow number,
                               ElectronPageReport report) {
  send_.Run(ElectronPageReported(number, report));
}

void ElectronApp::AskPage(ElectronPageRequest request) {
  const std::optional<std::string> id = IdOf(request.window);
  if (!id.has_value()) {
    return;
  }
  if (const auto* agent =
          std::get_if<ElectronSetPageUserAgent>(&request.action)) {
    Window& window = windows_.at(request.window);
    window.user_agent = agent->user_agent;
    // None of its own is its session's again.
    desk_->SetUserAgent(*id, window.user_agent.empty()
                                 ? SessionNamed(window.session).user_agent()
                                 : window.user_agent);
    return;
  }
  if (const std::optional<std::string> why =
          desk_->AskPage(*id, std::move(request.action))) {
    send_.Run(ElectronWindowRefused(request.window, *why));
  }
}

void ElectronApp::CallPage(ElectronPageCall call) {
  const auto window = windows_.find(call.window);
  if (window == windows_.end()) {
    send_.Run(ElectronPageResult(
        call.window, call.call,
        base::unexpected(base::StrCat(
            {"window ", base::NumberToString(call.window), " is not open"}))));
    return;
  }
  desk_->CallPage(
      window->second.id, std::move(call.method),
      base::BindOnce(
          [](base::WeakPtr<ElectronApp> app, ElectronWindow window, int number,
             base::expected<base::Value, std::string> result) {
            if (app) {
              app->send_.Run(ElectronPageResult(window, number, result));
            }
          },
          weak_factory_.GetWeakPtr(), call.window, call.call));
}

void ElectronApp::PageDevToolsEvent(ElectronWindow number,
                                    std::string method,
                                    base::DictValue params) {
  if (windows_.contains(number)) {
    send_.Run(ElectronDevToolsEvent(number, method, std::move(params)));
  }
}

void ElectronApp::PageWindowOpening(ElectronWindow number,
                                    ElectronWindowOpenDetails details,
                                    std::unique_ptr<ElectronHeldPage> held) {
  if (!windows_.contains(number)) {
    // Its page outlived the window: Electron asks no handler for a window
    // that's gone, and opens nothing.
    LOG(WARNING) << "domicile: Electron window " << number
                 << "'s page asked for a window at "
                 << details.url.possibly_invalid_spec()
                 << " after the window closed; none opens.";
    return;
  }
  const int ask = next_window_open_ask_++;
  window_open_asks_.emplace(
      ask, WindowOpenAsk{
               .opener = number, .url = details.url, .held = std::move(held)});
  send_.Run(ElectronWindowOpen(ask, number, details));
}

void ElectronApp::AnswerWindowOpen(ElectronWindowOpenAnswer answer) {
  auto found = window_open_asks_.find(answer.ask);
  if (found == window_open_asks_.end()) {
    send_.Run(
        ElectronRefused(base::StrCat({"no new window is waiting for answer ",
                                      base::NumberToString(answer.ask)})));
    return;
  }
  WindowOpenAsk asked = std::move(found->second);
  window_open_asks_.erase(found);
  if (!answer.open.has_value()) {
    // Destroying a held page closes it, as a denied window.open() answers
    // null.
    return;
  }
  ElectronOpenWindow& open = *answer.open;
  open.url = asked.url;
  if (!asked.held) {
    Open(open);
    return;
  }
  auto opener = windows_.find(asked.opener);
  if (opener == windows_.end()) {
    send_.Run(ElectronWindowRefused(open.window,
                                    "the page that asked for it closed first"));
    return;
  } else if (open.session != opener->second.session) {
    send_.Run(ElectronWindowRefused(
        open.window,
        base::StrCat({"a window its opener keeps a handle on is in the "
                      "opener's session, \"",
                      opener->second.session, "\", not \"", open.session,
                      "\""})));
    return;
  } else if (windows_.contains(open.window)) {
    send_.Run(ElectronWindowRefused(
        open.window, base::StrCat({"window ", base::NumberToString(open.window),
                                   " is already open"})));
    return;
  }
  const std::optional<std::string> id = desk_->Adopt(
      std::move(asked.held), hello_->app_id, open.preload, open.arguments,
      open.node, CallsFor(open.window), SessionNamed(open.session).GetWeakPtr(),
      open.title, open.hidden, open.user_agent);
  if (!id.has_value()) {
    send_.Run(
        ElectronWindowRefused(open.window, "there is no shell to show it in"));
    return;
  }
  windows_.emplace(open.window, Window{.id = *id,
                                       .title = std::string(),
                                       .session = open.session,
                                       .view = false,
                                       .user_agent = open.user_agent});
  send_.Run(ElectronWindowOpened(open.window));
}

void ElectronApp::SetUserAgentFallback(
    const ElectronSetUserAgentFallback& fallback) {
  user_agent_fallback_ = fallback.user_agent;
  for (const auto& [number, window] : windows_) {
    // A page with its own keeps it, as in Electron.
    if (window.user_agent.empty() &&
        SessionNamed(window.session).user_agent_.empty()) {
      desk_->SetUserAgent(window.id, fallback.user_agent);
    }
  }
}

void ElectronApp::RunSessionCall(ElectronSessionCall call) {
  base::expected<WebViewPartition, std::string> partition =
      ElectronSessionPartition(hello_->partition, call.session);
  if (!partition.has_value()) {
    send_.Run(
        ElectronSessionResult(call.call, base::unexpected(partition.error())));
    return;
  }
  const int number = call.call;
  auto done = base::BindOnce(&ElectronApp::SessionCallDone,
                             weak_factory_.GetWeakPtr(), number);
  auto done_with_nothing =
      [](base::OnceCallback<void(base::expected<base::Value, std::string>)>
             done) {
        return base::BindOnce(
            [](base::OnceCallback<void(
                   base::expected<base::Value, std::string>)> done) {
              std::move(done).Run(base::Value());
            },
            std::move(done));
      };
  if (auto* get = std::get_if<ElectronGetCookies>(&call.method)) {
    desk_->GetCookies(
        *partition, get->filter.url,
        base::BindOnce(
            [](ElectronCookieFilter filter,
               base::OnceCallback<void(
                   base::expected<base::Value, std::string>)> done,
               std::vector<ElectronCookie> cookies) {
              base::ListValue matching;
              for (const ElectronCookie& cookie : cookies) {
                if (ElectronCookieMatches(cookie, filter)) {
                  matching.Append(ElectronCookieValue(cookie));
                }
              }
              std::move(done).Run(base::Value(std::move(matching)));
            },
            get->filter, std::move(done)));
  } else if (auto* set = std::get_if<ElectronSetCookie>(&call.method)) {
    desk_->SetCookie(
        *partition, set->details,
        base::BindOnce(
            [](base::OnceCallback<void(
                   base::expected<base::Value, std::string>)> done,
               std::optional<std::string> why) {
              if (why.has_value()) {
                std::move(done).Run(base::unexpected(std::move(*why)));
              } else {
                std::move(done).Run(base::Value());
              }
            },
            std::move(done)));
  } else if (auto* remove = std::get_if<ElectronRemoveCookie>(&call.method)) {
    desk_->RemoveCookie(*partition, remove->url, remove->name,
                        done_with_nothing(std::move(done)));
  } else if (std::holds_alternative<ElectronFlushCookies>(call.method)) {
    desk_->FlushCookies(*partition, done_with_nothing(std::move(done)));
  } else if (std::holds_alternative<ElectronWatchCookies>(call.method)) {
    if (!cookie_watches_.contains(call.session)) {
      cookie_watches_.emplace(
          call.session,
          desk_->WatchCookies(
              *partition,
              base::BindRepeating(&ElectronApp::CookieChanged,
                                  weak_factory_.GetWeakPtr(), call.session)));
    }
    std::move(done).Run(base::Value());
  } else if (auto* clear = std::get_if<ElectronClearStorage>(&call.method)) {
    desk_->ClearStorage(*partition, *clear, done_with_nothing(std::move(done)));
  } else if (std::holds_alternative<ElectronClearCache>(call.method)) {
    desk_->ClearCache(*partition, done_with_nothing(std::move(done)));
  } else if (auto* network = std::get_if<ElectronNetworkCall>(&call.method)) {
    desk_->RunNetworkCall(*partition, *network, std::move(done));
  } else if (std::holds_alternative<ElectronWatchServiceWorkers>(
                 call.method)) {
    WatchServiceWorkers(call.session, *partition, std::move(done));
  } else {
    const std::string& user_agent =
        std::get<ElectronSetUserAgent>(call.method).user_agent;
    ElectronSession& session = SessionNamed(call.session);
    session.user_agent_ = user_agent;
    for (const auto& [number_of_window, window] : windows_) {
      if (window.session == call.session && window.user_agent.empty()) {
        // Its own, or the app's when it has none, as a new window gets. A
        // page with its own keeps it, as in Electron.
        desk_->SetUserAgent(window.id, session.user_agent());
      }
    }
    std::move(done).Run(base::Value());
  }
}

void ElectronApp::CookieChanged(const std::string& session,
                                const ElectronCookieChange& change) {
  send_.Run(ElectronCookieChanged(session, change));
}

void ElectronApp::SessionCallDone(
    int call,
    base::expected<base::Value, std::string> result) {
  send_.Run(ElectronSessionResult(call, result));
}

void ElectronApp::Reply(ElectronReply reply) {
  auto waiting = invokes_.find(reply.invoke);
  if (waiting == invokes_.end()) {
    send_.Run(ElectronRefused(base::StrCat(
        {"no invoke ", base::NumberToString(reply.invoke), " is waiting"})));
    return;
  }
  ElectronAnswer answer = std::move(waiting->second);
  invokes_.erase(waiting);
  std::move(answer).Run(std::move(reply.answer));
}

void ElectronApp::PageSent(ElectronWindow number,
                           std::string channel,
                           base::ListValue args) {
  // A window the app closed may still have its page for a moment.
  if (windows_.contains(number)) {
    send_.Run(ElectronIpcMessage(number, channel, args));
  }
}

void ElectronApp::PageInvoked(ElectronWindow number,
                              bool sync,
                              std::string channel,
                              base::ListValue args,
                              ElectronAnswer answer) {
  if (!windows_.contains(number)) {
    std::move(answer).Run(base::unexpected("the window is closed"));
    return;
  }
  const int invoke = next_invoke_++;
  invokes_.emplace(invoke, std::move(answer));
  send_.Run(sync ? ElectronIpcSendSync(number, invoke, channel, args)
                 : ElectronIpcInvoke(number, invoke, channel, args));
}

void ElectronApp::PagePosted(ElectronWindow number,
                             std::string channel,
                             base::Value message,
                             std::vector<std::string> ports) {
  if (windows_.contains(number)) {
    send_.Run(ElectronIpcPost(number, channel, message, ports));
  }
}

void ElectronApp::PagePortPosted(ElectronWindow number,
                                 std::string port,
                                 base::Value data) {
  if (windows_.contains(number)) {
    send_.Run(ElectronPortMessage(number, port, data));
  }
}

void ElectronApp::PagePortClosed(ElectronWindow number, std::string port) {
  if (windows_.contains(number)) {
    send_.Run(ElectronPortClosed(number, port));
  }
}

void ElectronApp::PageGone(ElectronWindow number) {
  if (windows_.contains(number)) {
    send_.Run(ElectronPageGone(number));
  }
}

void ElectronApp::PageResized(ElectronWindow number, int width, int height) {
  if (windows_.contains(number)) {
    send_.Run(ElectronWindowResized(number, width, height));
  }
}

void ElectronApp::WindowStateChanged(ElectronWindow number,
                                     ElectronWindowState state) {
  if (windows_.contains(number)) {
    send_.Run(ElectronWindowStateChanged(number, state));
  }
}

void ElectronApp::MenuClicked(ElectronWindow number, int command) {
  if (windows_.contains(number)) {
    send_.Run(ElectronMenuClicked(number, command));
  }
}

void ElectronApp::CloseAsked(ElectronWindow number) {
  if (windows_.contains(number)) {
    send_.Run(ElectronCloseAsked(number));
  }
}

void ElectronApp::PageStateChanged(ElectronWindow number,
                                   ElectronPageState state) {
  if (windows_.contains(number)) {
    send_.Run(ElectronPageStateChanged(number, state));
  }
}

void ElectronApp::PageFound(ElectronWindow number, ElectronFindResult result) {
  if (windows_.contains(number)) {
    send_.Run(ElectronFoundInPage(number, result));
  }
}

void ElectronApp::TellOfPage(ElectronWindow number, const std::string& line) {
  if (windows_.contains(number)) {
    send_.Run(line);
  }
}

void ElectronApp::PageNavigationStarted(ElectronWindow number,
                                        ElectronNavigation navigation) {
  TellOfPage(number, ElectronNavigationStarted(number, navigation));
}

void ElectronApp::PageNavigationRedirected(ElectronWindow number,
                                           ElectronNavigation navigation) {
  TellOfPage(number, ElectronNavigationRedirected(number, navigation));
}

void ElectronApp::PageNavigationCommitted(ElectronWindow number,
                                          ElectronNavigationCommit commit) {
  TellOfPage(number, ElectronNavigationCommitted(number, commit));
}

void ElectronApp::PageLoadFailed(ElectronWindow number,
                                 ElectronLoadFailure failure) {
  TellOfPage(number, ElectronLoadFailed(number, failure));
}

void ElectronApp::PageFrameLoaded(ElectronWindow number, ElectronFrame frame) {
  TellOfPage(number, ElectronFrameLoaded(number, frame));
}

void ElectronApp::PageFrameCreated(ElectronWindow number,
                                   ElectronFrame frame,
                                   bool main_frame) {
  TellOfPage(number, ElectronFrameCreated(number, frame, main_frame));
}

void ElectronApp::PageWillNavigate(ElectronWindow number,
                                   ElectronNavigation navigation,
                                   bool redirect,
                                   base::OnceCallback<void(bool)> answered) {
  if (!windows_.contains(number)) {
    // Its page outlived the window, which no app's listener hears of.
    std::move(answered).Run(false);
    return;
  } else if (!windows_.at(number).listens_for_navigation) {
    // Nothing could stop it, so it doesn't wait a round trip.
    std::move(answered).Run(true);
    return;
  }
  const int ask = next_navigation_ask_++;
  navigation_asks_.emplace(ask, std::move(answered));
  send_.Run(ElectronWillNavigate(ask, number, navigation, redirect));
}

void ElectronApp::PageWillPreventUnload(
    ElectronWindow number,
    base::OnceCallback<void(bool)> answered) {
  if (!windows_.contains(number)) {
    std::move(answered).Run(true);
    return;
  }
  const int ask = next_unload_ask_++;
  unload_asks_.emplace(ask, std::move(answered));
  send_.Run(ElectronWillPreventUnload(ask, number));
}

void ElectronApp::AnswerNavigation(const ElectronNavigationAnswer& answer) {
  auto found = navigation_asks_.find(answer.ask);
  if (found == navigation_asks_.end()) {
    send_.Run(
        ElectronRefused(base::StrCat({"no navigation is waiting for answer ",
                                      base::NumberToString(answer.ask)})));
    return;
  }
  base::OnceCallback<void(bool)> answered = std::move(found->second);
  navigation_asks_.erase(found);
  std::move(answered).Run(answer.proceed);
}

void ElectronApp::AnswerUnload(const ElectronUnloadAnswer& answer) {
  auto found = unload_asks_.find(answer.ask);
  if (found == unload_asks_.end()) {
    send_.Run(ElectronRefused(
        base::StrCat({"no page's beforeunload is waiting for answer ",
                      base::NumberToString(answer.ask)})));
    return;
  }
  base::OnceCallback<void(bool)> answered = std::move(found->second);
  unload_asks_.erase(found);
  std::move(answered).Run(answer.unload);
}

void ElectronApp::PageContextMenu(ElectronWindow number,
                                  ElectronContextMenu menu) {
  if (windows_.contains(number)) {
    send_.Run(ElectronContextMenuAsked(number, menu));
  }
}

std::optional<std::string> ElectronApp::WindowIdOf(ElectronWindow number,
                                                   std::string_view what) {
  std::optional<std::string> id = IdOf(number);
  if (id.has_value() && windows_.at(number).view) {
    send_.Run(ElectronWindowRefused(
        number, base::StrCat({"window ", base::NumberToString(number),
                              " is a view, and only a window has ", what})));
    return std::nullopt;
  }
  return id;
}

void ElectronApp::SetMenuBar(const ElectronSetMenuBar& bar) {
  const std::optional<std::string> id = IdOf(bar.window);
  if (!id.has_value()) {
    return;
  }
  if (windows_.at(bar.window).view) {
    send_.Run(ElectronWindowRefused(
        bar.window, base::StrCat({"window ", base::NumberToString(bar.window),
                                  " is a view, and only a window has a menu "
                                  "bar"})));
    return;
  }
  desk_->SetMenuBar(*id, ElectronDeskMenuBar{.menu = bar.menu,
                                             .visible = bar.visible,
                                             .auto_hide = bar.auto_hide});
}

void ElectronApp::PopupMenu(const ElectronPopupMenu& popup) {
  const std::optional<std::string> id =
      WindowIdOf(popup.window, "a popup menu");
  if (!id.has_value()) {
    // The app waits on every popup: this one closed before it opened.
    send_.Run(ElectronPopupMenuClosed(popup.window, popup.popup, 0));
    return;
  }
  // Before the desk closes the one it replaces, which then isn't current.
  popups_.insert_or_assign(popup.window, popup.popup);
  desk_->ShowPopupMenu(
      *id,
      ElectronDeskPopupMenu{.menu = popup.menu, .x = popup.x, .y = popup.y},
      base::BindOnce(&ElectronApp::PopupMenuClosed, weak_factory_.GetWeakPtr(),
                     popup.window, popup.popup));
}

void ElectronApp::ClosePopupMenu(const ElectronClosePopupMenu& close) {
  const auto shown = popups_.find(close.window);
  // One that closed already, which the app hears of.
  if (shown == popups_.end() || shown->second != close.popup) {
    return;
  }
  if (const std::optional<std::string> id = IdOf(close.window)) {
    desk_->ClosePopupMenu(*id);
  }
}

// Sent even when the window has closed since: the app waits on every popup.
void ElectronApp::PopupMenuClosed(ElectronWindow number,
                                  int popup,
                                  int command) {
  if (const auto shown = popups_.find(number);
      shown != popups_.end() && shown->second == popup) {
    popups_.erase(shown);
  }
  send_.Run(ElectronPopupMenuClosed(number, popup, command));
}

void ElectronApp::ShowMessageBox(const ElectronShowMessageBox& box) {
  const std::optional<std::string> id = IdOf(box.window);
  if (!id.has_value()) {
    return;
  }
  if (windows_.at(box.window).view) {
    send_.Run(ElectronWindowRefused(
        box.window,
        base::StrCat({"window ", base::NumberToString(box.window),
                      " is a view: a message box goes over a window"})));
    return;
  }
  desk_->ShowMessageBox(
      *id,
      ElectronDeskMessageBox{.message_box = box.message_box,
                             .buttons = box.buttons,
                             .cancel_id = box.cancel_id},
      base::BindOnce(&ElectronApp::MessageBoxAnswered,
                     weak_factory_.GetWeakPtr(), box.window, box.box));
}

// Sent even when the window has closed since: the app waits on every box.
void ElectronApp::MessageBoxAnswered(ElectronWindow number,
                                     int box,
                                     int response,
                                     bool checkbox_checked) {
  send_.Run(
      ElectronMessageBoxAnswered(number, box, response, checkbox_checked));
}

void ElectronApp::SetViews(const ElectronSetViews& set) {
  const std::optional<std::string> id = IdOf(set.window);
  if (!id.has_value()) {
    return;
  }
  auto refuse = [&](std::string_view why) {
    send_.Run(ElectronWindowRefused(set.window, why));
  };
  if (windows_.at(set.window).view) {
    refuse(base::StrCat({"window ", base::NumberToString(set.window),
                         " is a view, and only a window holds views"}));
    return;
  }
  std::vector<ElectronDeskView> views;
  std::set<ElectronWindow> placed;
  for (const ElectronViewPlacement& placement : set.views) {
    auto found = windows_.find(placement.view);
    const std::string number = base::NumberToString(placement.view);
    if (found == windows_.end()) {
      refuse(base::StrCat({"view ", number, " is not open"}));
      return;
    } else if (!found->second.view) {
      refuse(base::StrCat({"window ", number, " is a window, not a view"}));
      return;
    } else if (!placed.insert(placement.view).second) {
      refuse(base::StrCat({"view ", number, " is listed twice"}));
      return;
    }
    views.push_back(ElectronDeskView{.id = found->second.id,
                                     .x = placement.x,
                                     .y = placement.y,
                                     .width = placement.width,
                                     .height = placement.height,
                                     .hidden = placement.hidden});
  }
  desk_->SetViews(*id, std::move(views));
}

ElectronSession& ElectronApp::SessionNamed(const std::string& name) {
  std::unique_ptr<ElectronSession>& session = sessions_[name];
  if (!session) {
    session = std::make_unique<ElectronSession>(*this, name);
  }
  return *session;
}

void ElectronApp::ListenForWebRequests(ElectronWebRequestListen listen) {
  // Checked as handle_protocol's session is.
  base::expected<WebViewPartition, std::string> partition =
      ElectronSessionPartition(hello_->partition, listen.session);
  if (!partition.has_value()) {
    send_.Run(ElectronRefused(partition.error()));
    return;
  }
  SessionNamed(listen.session).web_request_events_ = std::move(listen.events);
}

void ElectronApp::SendWebRequest(const std::string& session,
                                 ElectronWebRequestEvent event,
                                 std::optional<int> ask,
                                 const std::optional<std::string>& window,
                                 const ElectronWebRequestDetails& details) {
  send_.Run(ElectronWebRequest(
      event, ask, window.has_value() ? NumberOf(*window) : std::nullopt,
      session, details));
}

void ElectronApp::StartAsk(const std::string& session,
                           ElectronWebRequestEvent event,
                           const std::optional<std::string>& window,
                           const ElectronWebRequestDetails& details,
                           ElectronWebRequestAnswered answered) {
  const int number = next_ask_++;
  asks_.emplace(number, Ask{.event = event, .answered = std::move(answered)});
  SendWebRequest(session, event, number, window, details);
}

void ElectronApp::Answer(ElectronWebRequestAnswer answer) {
  auto found = asks_.find(answer.ask);
  if (found == asks_.end()) {
    send_.Run(
        ElectronRefused(base::StrCat({"no web request is waiting for answer ",
                                      base::NumberToString(answer.ask)})));
    return;
  }
  Ask ask = std::move(found->second);
  asks_.erase(found);
  // What each listener's answer may change, as in Electron.
  const char* stray = nullptr;
  if (answer.redirect_url.has_value() &&
      ask.event != ElectronWebRequestEvent::kBeforeRequest) {
    stray = "redirect_url";
  } else if (answer.request_headers.has_value() &&
             ask.event != ElectronWebRequestEvent::kBeforeSendHeaders) {
    stray = "request_headers";
  } else if (answer.response_headers.has_value() &&
             ask.event != ElectronWebRequestEvent::kHeadersReceived) {
    stray = "response_headers";
  } else if (answer.status_line.has_value() &&
             ask.event != ElectronWebRequestEvent::kHeadersReceived) {
    stray = "status_line";
  }
  if (stray != nullptr) {
    // The app's bug fails the request, rather than letting it through as if
    // the app had not asked for a change.
    send_.Run(ElectronRefused(
        base::StrCat({"an answer to ", ElectronWebRequestEventName(ask.event),
                      " cannot set ", stray})));
    std::move(ask.answered)
        .Run(ElectronWebRequestAnswer{.ask = answer.ask, .cancel = true});
    return;
  }
  std::move(ask.answered).Run(std::move(answer));
}

void ElectronApp::HandlePermissions(const ElectronPermissionHandler& handler) {
  // Checked as handle_protocol's session is.
  base::expected<WebViewPartition, std::string> partition =
      ElectronSessionPartition(hello_->partition, handler.session);
  if (!partition.has_value()) {
    send_.Run(ElectronRefused(partition.error()));
    return;
  }
  // A request already asked still waits for its answer.
  SessionNamed(handler.session).handles_permissions_ = handler.handle;
}

std::optional<ElectronWindow> ElectronApp::NumberOf(
    const std::string& id) const {
  const auto found = std::ranges::find(
      windows_, id,
      [](const auto& entry) -> const std::string& { return entry.second.id; });
  if (found == windows_.end()) {
    return std::nullopt;
  }
  return found->first;
}

void ElectronApp::StartPermissionAsk(
    const std::string& session,
    const std::string& window,
    const ElectronPermissionDetails& details,
    base::OnceCallback<void(bool granted)> answered) {
  const int number = next_permission_ask_++;
  permission_asks_.emplace(number, std::move(answered));
  send_.Run(
      ElectronPermissionRequest(number, NumberOf(window), session, details));
}

void ElectronApp::AnswerPermission(const ElectronPermissionAnswer& answer) {
  auto found = permission_asks_.find(answer.ask);
  if (found == permission_asks_.end()) {
    send_.Run(ElectronRefused(
        base::StrCat({"no permission request is waiting for answer ",
                      base::NumberToString(answer.ask)})));
    return;
  }
  base::OnceCallback<void(bool granted)> answered = std::move(found->second);
  permission_asks_.erase(found);
  std::move(answered).Run(answer.granted);
}

int ElectronApp::StartDownloadAsk(
    const std::string& session,
    const std::string& window,
    const ElectronDownloadDetails& details,
    base::WeakPtr<ElectronDownloadControl> control,
    base::OnceCallback<void(ElectronDownloadAnswer)> decided) {
  const int number = next_download_++;
  downloads_.emplace(number, Download{.decided = std::move(decided),
                                      .control = std::move(control)});
  send_.Run(ElectronWillDownload(number, NumberOf(window), session, details));
  return number;
}

void ElectronApp::AnswerDownload(ElectronDownloadAnswer answer) {
  auto found = downloads_.find(answer.download);
  if (found == downloads_.end() || !found->second.decided) {
    send_.Run(
        ElectronRefused(base::StrCat({"no download is waiting for answer ",
                                      base::NumberToString(answer.download)})));
    return;
  }
  std::move(found->second.decided).Run(std::move(answer));
}

void ElectronApp::DownloadUpdated(int number,
                                  const ElectronDownloadProgress& progress) {
  // A download canceled as the app goes updates after the app let it go.
  auto found = downloads_.find(number);
  if (found == downloads_.end()) {
    return;
  }
  // Electron's item says nothing before will-download is answered, nor
  // after it is done.
  Download& download = found->second;
  if (download.decided || download.done) {
    return;
  }
  download.done = progress.done;
  send_.Run(ElectronDownloadUpdated(number, progress));
}

void ElectronApp::ControlDownload(const ElectronDownloadControlCall& call) {
  auto found = downloads_.find(call.download);
  if (found == downloads_.end()) {
    send_.Run(ElectronRefused(base::StrCat(
        {"no download is numbered ", base::NumberToString(call.download)})));
    return;
  }
  // A download that is done or gone ignores it, as Electron's does.
  ElectronDownloadControl* control = found->second.control.get();
  if (control == nullptr || found->second.done) {
    return;
  }
  switch (call.action) {
    case ElectronDownloadAction::kPause:
      control->Pause();
      return;
    case ElectronDownloadAction::kResume:
      control->Resume();
      return;
    case ElectronDownloadAction::kCancel:
      control->Cancel();
      return;
  }
}

void ElectronApp::HandleProtocol(const ElectronHandleProtocol& handle) {
  // A session's partition is checked here too, so a handler never waits on
  // a session no window can open in.
  base::expected<WebViewPartition, std::string> partition =
      ElectronSessionPartition(hello_->partition, handle.session);
  if (!partition.has_value()) {
    send_.Run(ElectronRefused(partition.error()));
    return;
  }
  std::set<std::string>& schemes = SessionNamed(handle.session).schemes_;
  if (handle.handle) {
    schemes.insert(handle.scheme);
  } else {
    schemes.erase(handle.scheme);
  }
}

bool ElectronApp::Opens(ElectronWindow number,
                        const std::string& session,
                        const GURL& url) {
  if (IsNetworkScheme(url.scheme()) ||
      SessionNamed(session).Handles(url.scheme())) {
    return true;
  }
  send_.Run(ElectronWindowRefused(
      number, base::StrCat({url.scheme(), ": URLs open once the app handles ",
                            url.scheme(), ":"})));
  return false;
}

void ElectronApp::StartFetch(const std::string& session,
                             ElectronFetch fetch,
                             std::unique_ptr<ElectronResponder> responder) {
  const int request = next_fetch_++;
  fetches_.emplace(request, Pending{.responder = std::move(responder)});
  send_.Run(ElectronProtocolRequest(request, session, fetch));
}

void ElectronApp::Respond(ElectronProtocolResponse response) {
  auto pending = fetches_.find(response.request);
  if (pending == fetches_.end()) {
    send_.Run(ElectronRefused(
        base::StrCat({"no protocol request ",
                      base::NumberToString(response.request), " is waiting"})));
    return;
  } else if (pending->second.streaming) {
    FailRequest(response.request, "a protocol request has one response");
    return;
  }
  if (!response.response.has_value()) {
    pending->second.responder->Fail(response.response.error());
    fetches_.erase(pending);
  } else if (std::holds_alternative<ElectronStreamedBody>(
                 response.response->body)) {
    pending->second.streaming = true;
    pending->second.responder->Respond(std::move(*response.response));
  } else {
    pending->second.responder->Respond(std::move(*response.response));
    fetches_.erase(pending);
  }
}

void ElectronApp::ReceiveData(ElectronProtocolData data) {
  auto pending = fetches_.find(data.request);
  if (pending == fetches_.end()) {
    send_.Run(ElectronRefused(
        base::StrCat({"no protocol request ",
                      base::NumberToString(data.request), " is waiting"})));
  } else if (!pending->second.streaming) {
    FailRequest(data.request,
                "the app sent a body's piece before a streamed response");
  } else {
    pending->second.responder->Data(std::move(data.bytes));
  }
}

void ElectronApp::EndBody(const ElectronProtocolEnd& end) {
  auto pending = fetches_.find(end.request);
  if (pending == fetches_.end()) {
    send_.Run(ElectronRefused(
        base::StrCat({"no protocol request ", base::NumberToString(end.request),
                      " is waiting"})));
  } else if (!pending->second.streaming) {
    FailRequest(end.request, "the app ended a body before a streamed response");
  } else {
    pending->second.responder->End(end.error);
    fetches_.erase(pending);
  }
}

void ElectronApp::FailRequest(int request, const std::string& why) {
  send_.Run(ElectronRefused(why));
  auto pending = fetches_.find(request);
  if (pending == fetches_.end()) {
    return;
  }
  // A streamed body that broke off ends with the error; one that never
  // started fails.
  if (pending->second.streaming) {
    pending->second.responder->End(why);
  } else {
    pending->second.responder->Fail(why);
  }
  fetches_.erase(pending);
}

std::optional<std::string> ElectronApp::IdOf(ElectronWindow number) {
  auto found = windows_.find(number);
  if (found == windows_.end()) {
    send_.Run(ElectronWindowRefused(
        number, base::StrCat({"window ", base::NumberToString(number),
                              " is not open"})));
    return std::nullopt;
  } else {
    return found->second.id;
  }
}

}  // namespace domicile
