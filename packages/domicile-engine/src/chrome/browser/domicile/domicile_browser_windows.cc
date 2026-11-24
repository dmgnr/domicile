// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "chrome/browser/domicile/domicile_browser_windows.h"

#include <algorithm>
#include <deque>
#include <memory>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "base/callback_list.h"
#include "base/check.h"
#include "base/functional/bind.h"
#include "base/functional/callback.h"
#include "base/functional/callback_helpers.h"
#include "base/functional/function_ref.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/location.h"
#include "base/logging.h"
#include "base/memory/raw_ptr.h"
#include "base/memory/self_deleting.h"
#include "base/memory/weak_ptr.h"
#include "base/no_destructor.h"
#include "base/observer_list.h"
#include "base/observer_list_types.h"
#include "base/scoped_multi_source_observation.h"
#include "base/scoped_observation.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/string_util.h"
#include "base/strings/utf_string_conversions.h"
#include "base/supports_user_data.h"
#include "base/task/sequenced_task_runner.h"
#include "base/time/time.h"
#include "base/types/expected.h"
#include "chrome/browser/domicile/domicile_browser_profiles.h"
#include "chrome/browser/domicile/domicile_electron_page.h"
#include "chrome/browser/domicile/domicile_electron_page_events.h"
#include "chrome/browser/domicile/domicile_tab_helpers.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/profiles/profile_observer.h"
#include "chrome/browser/ui/browser_window/public/browser_collection.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/browser_window/public/global_browser_collection.h"
#include "components/domicile/browser/browser_window_capture_target.h"
#include "components/domicile/browser/browser_window_listing.h"
#include "components/domicile/browser/context_menu.h"
#include "components/domicile/browser/notification_window.h"
#include "components/domicile/browser/web_view_guest.h"
#include "components/domicile/browser/web_view_partition.h"
#include "components/domicile/common/domicile_scheme.h"
#include "components/embedder_support/user_agent_utils.h"
#include "components/tabs/public/tab_interface.h"
#include "content/public/browser/browser_context.h"
#include "content/public/browser/document_service.h"
#include "content/public/browser/navigation_controller.h"
#include "content/public/browser/navigation_entry.h"
#include "content/public/browser/navigation_handle.h"
#include "content/public/browser/notification_event_dispatcher.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/render_widget_host.h"
#include "content/public/browser/render_widget_host_view.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_contents_observer.h"
#include "mojo/public/cpp/bindings/pending_remote.h"
#include "mojo/public/cpp/bindings/remote.h"
#include "third_party/blink/public/common/user_agent/user_agent_metadata.h"
#include "ui/gfx/geometry/point.h"
#include "ui/gfx/geometry/point_f.h"
#include "ui/gfx/geometry/rect.h"
#include "ui/gfx/geometry/rect_f.h"
#include "ui/gfx/geometry/size.h"
#include "ui/gfx/geometry/vector2d_f.h"
#include "url/gurl.h"

namespace domicile {
namespace {

// A page's new window held while its Electron app decides on it.
class HeldPage : public ElectronHeldPage {
 public:
  explicit HeldPage(std::unique_ptr<content::WebContents> contents)
      : contents_(std::move(contents)) {}
  std::unique_ptr<content::WebContents> Take() { return std::move(contents_); }

 private:
  std::unique_ptr<content::WebContents> contents_;
};

// Electron's name for how a page asked for a window.
std::string ElectronDisposition(WindowOpenDisposition disposition) {
  switch (disposition) {
    case WindowOpenDisposition::kCurrentTab:
      return "default";
    case WindowOpenDisposition::kNewForegroundTab:
      return "foreground-tab";
    case WindowOpenDisposition::kNewBackgroundTab:
      return "background-tab";
    case WindowOpenDisposition::kNewPopup:
    case WindowOpenDisposition::kNewWindow:
      return "new-window";
    default:
      return "other";
  }
}

// window.open's features, from what Blink kept of them: its size and place.
std::string ElectronFeatures(const WebViewGuest::WindowRequest& request) {
  std::vector<std::string> features;
  if (request.width.has_value()) {
    features.push_back("width=" + base::NumberToString(*request.width));
  }
  if (request.height.has_value()) {
    features.push_back("height=" + base::NumberToString(*request.height));
  }
  if (request.x.has_value()) {
    features.push_back("left=" + base::NumberToString(*request.x));
  }
  if (request.y.has_value()) {
    features.push_back("top=" + base::NumberToString(*request.y));
  }
  return base::JoinString(features, ",");
}

// An Electron page's new windows go to its app, which decides on each as
// setWindowOpenHandler does.
WebViewGuest::WindowOpening AskTheApp(
    base::RepeatingCallback<void(ElectronWindowOpenDetails,
                                 std::unique_ptr<ElectronHeldPage>)> opening) {
  return base::BindRepeating(
      [](const base::RepeatingCallback<void(ElectronWindowOpenDetails,
                                            std::unique_ptr<ElectronHeldPage>)>&
             opening,
         WebViewGuest::WindowRequest request,
         std::unique_ptr<content::WebContents> held) {
        ElectronWindowOpenDetails details{
            .url = request.url,
            .frame_name = request.frame_name,
            .features = ElectronFeatures(request),
            .disposition = ElectronDisposition(request.disposition),
            .referrer = request.referrer,
        };
        opening.Run(
            std::move(details),
            held ? std::make_unique<HeldPage>(std::move(held)) : nullptr);
      },
      std::move(opening));
}

// Hands each context menu an Electron window's page asks for to its app, as
// Electron's webContents `context-menu`.
WebViewGuest::ContextMenuTaking TellTheApp(
    base::RepeatingCallback<void(ElectronContextMenu)> context_menu) {
  return base::BindRepeating(
      [](const base::RepeatingCallback<void(ElectronContextMenu)>&
             context_menu,
         const content::ContextMenuParams& params, const gfx::Point& in_page) {
        context_menu.Run(AsElectronContextMenu(params, in_page));
      },
      std::move(context_menu));
}

// `history`'s entries as a guest restores them.
std::vector<WebViewGuest::HistoryEntry> HistoryEntries(
    const ElectronHistory& history) {
  std::vector<WebViewGuest::HistoryEntry> entries;
  for (const ElectronHistory::Entry& entry : history.entries) {
    entries.push_back(
        {.url = entry.url, .title = base::UTF8ToUTF16(entry.title)});
  }
  return entries;
}

// Has `contents` load as `user_agent`: its next browser navigation, as
// WebViewGuest::Navigate asks for the override, and the navigations its
// page makes after its current document, which take its entry's.
void UseUserAgent(content::WebContents& contents,
                  const std::string& user_agent) {
  blink::UserAgentOverride override =
      blink::UserAgentOverride::UserAgentOnly(user_agent);
  // Without metadata a page's navigator.userAgentData and Sec-CH-UA go
  // blank; Electron keeps the engine's. No user agent is no override, which
  // takes none.
  if (!user_agent.empty()) {
    override.ua_metadata_override = embedder_support::GetUserAgentMetadata();
  }
  contents.SetUserAgentOverride(override, /*override_in_new_tabs=*/true);
  if (content::NavigationEntry* entry =
          contents.GetController().GetLastCommittedEntry()) {
    entry->SetIsOverridingUserAgent(true);
  }
}

// Makes `guest` an Electron app's page, which reports to its app with
// `reported` and loads as `user_agent`, its own (webContents.setUserAgent),
// when it has one. After its session's user agent, which its own is over.
void HearTheApp(WebViewGuest& guest,
                const std::string& user_agent,
                ElectronPageEvents::Reported reported) {
  if (!user_agent.empty()) {
    UseUserAgent(guest.contents(), user_agent);
  }
  ElectronPageEvents::Attach(guest, std::move(reported));
}

constexpr char kWindowsUserDataKey[] = "domicile_browser_windows";

// Each browser window's page that finished loading, by the window's id. See
// WatchBrowserWindowLoads.
base::RepeatingCallbackList<void(const std::string&)>& BrowserWindowLoads() {
  static base::NoDestructor<
      base::RepeatingCallbackList<void(const std::string&)>>
      loads;
  return *loads;
}

// Each browser window whose main frame's DOM is ready, by the window's id. See
// WatchBrowserWindowDomReadies.
base::RepeatingCallbackList<void(const std::string&)>&
BrowserWindowDomReadies() {
  static base::NoDestructor<
      base::RepeatingCallbackList<void(const std::string&)>>
      readies;
  return *readies;
}

// Returns the shell's WebContents in `context`, or null when it has none.
//
// Matches by scheme, as the command socket does: the shell is the page served
// over domicile://, and a guest has no window of its own. Creation order keeps
// the result independent of which window the user touched last.
content::WebContents* ShellContentsIn(content::BrowserContext* context) {
  content::WebContents* shell = nullptr;
  GlobalBrowserCollection::GetInstance()->ForEach(
      [&shell, context](BrowserWindowInterface* browser) {
        tabs::TabInterface* tab = browser->GetActiveTabInterface();
        if (tab != nullptr &&
            (context == nullptr ||
             tab->GetContents()->GetBrowserContext() == context) &&
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

// One profile's browser windows, held as profile user data like the desk's
// window.
//
// Emptied on OnProfileWillBeDestroyed, not with the user data. Each window is
// a tab of the desk window and must not outlive it, and SupportsUserData's
// destruction order does not guarantee that.
class DeskWindows final : public base::SupportsUserData::Data,
                          public ProfileObserver {
 public:
  // A shell document listening.
  class Observer : public base::CheckedObserver {
   public:
    virtual void OnWindowsChanged() = 0;
  };

  // Returns `profile`'s windows, creating them on first use.
  static DeskWindows& For(Profile* profile) {
    if (auto* windows = static_cast<DeskWindows*>(
            profile->GetUserData(kWindowsUserDataKey))) {
      return *windows;
    }
    auto made = std::make_unique<DeskWindows>(profile);
    DeskWindows& windows = *made;
    profile->SetUserData(kWindowsUserDataKey, std::move(made));
    return windows;
  }

  explicit DeskWindows(Profile* profile) : profile_(profile) {
    profile_observation_.Observe(profile);
  }
  DeskWindows(const DeskWindows&) = delete;
  DeskWindows& operator=(const DeskWindows&) = delete;
  ~DeskWindows() override { ListBrowserWindows(this, {}); }

  // Opens a window at `url` as a tab of the desk's own window, in browser
  // profile `profile` (BrowserWindowHost::ContextFor), in `partition` when
  // there is one. Returns it, or null when the profile has no shell to own
  // it.
  WebViewGuest* Open(const GURL& url,
                     bool private_browsing,
                     const std::string& profile,
                     const std::optional<WebViewPartition>& partition) {
    return Make([&](WebViewGuest& guest) { guest.Navigate(url); },
                /*popup_window=*/std::nullopt, 0, 0, private_browsing, profile,
                /*app=*/false, partition);
  }

  // Opens a window with a copy of `source`'s history and takes `step` there,
  // as Open. Returns false and opens nothing when the profile has no shell to
  // own it.
  bool OpenHistoryStep(WebViewGuest& source,
                       HistoryStep step,
                       bool private_browsing,
                       const std::string& profile,
                       const std::optional<WebViewPartition>& partition) {
    return Make(
        [&](WebViewGuest& guest) { guest.TakeHistoryStep(source, step); },
        /*popup_window=*/std::nullopt, 0, 0, private_browsing, profile,
        /*app=*/false, partition) != nullptr;
  }

  // Opens an app window at `url`: a window of the desk's own window that the
  // shell draws without an address bar. Its page's new windows are browser
  // windows, as a link out of a Chrome app opens in the browser.
  //
  // With an `app_id` and a `reuse` other than kNew, reuses the oldest open app
  // window with that id instead; see mojom::BrowserWindows.OpenApp. A new
  // one is in browser profile `profile`.
  bool OpenApp(const GURL& url,
               const std::string& app_id,
               mojom::AppReuse reuse,
               const std::string& profile) {
    if (!app_id.empty() && reuse != mojom::AppReuse::kNew) {
      auto open = std::ranges::find(windows_, app_id, &Window::app_id);
      if (open != windows_.end()) {
        LOG(INFO) << "domicile: reused app window " << open->id << " for "
                  << app_id << ".";
        if (reuse == mojom::AppReuse::kNavigate) {
          open->guest->Navigate(url);
        }
        open->guest->RequestFocus();
        return true;
      }
    }
    return Make([&](WebViewGuest& guest) { guest.Navigate(url); },
                /*popup_window=*/std::nullopt, 0, 0,
                /*private_browsing=*/false, profile,
                /*app=*/true, /*partition=*/std::nullopt,
                /*app_host=*/std::string(), app_id) != nullptr;
  }

  // Opens an app window at `url` for an Electron app, with `app_id`, in its
  // own `partition`, or with `history` at its entry `url`. Returns its id, or
  // nothing when the profile has no shell to own it.
  std::optional<std::string> OpenElectron(
      const GURL& url,
      const std::optional<ElectronHistory>& history,
      const std::string& app_id,
      const WebViewPartition& partition,
      const std::string& preload,
      const std::vector<std::string>& arguments,
      const std::optional<ElectronNode>& node,
      ElectronPageCalls calls,
      base::WeakPtr<ElectronSession> session,
      bool view,
      const std::string& title,
      bool hidden,
      const std::string& user_agent) {
    WebViewGuest* made = Make(
        [&](WebViewGuest& guest) {
          // An app, not a page: Energy Saver leaves it at full rate.
          guest.KeepFullFrameRate();
          // Its new windows are the app's to decide on.
          guest.DecideWindowsWith(AskTheApp(calls.window_opening));
          // Its context menus are the app's to draw.
          guest.TakeContextMenusWith(TellTheApp(calls.context_menu));
          // Before the first navigation, which runs the preload and loads
          // through the session too.
          if (session && !session->user_agent().empty()) {
            UseUserAgent(guest.contents(), session->user_agent());
          }
          HearTheApp(guest, user_agent, calls.reported);
          ElectronPage::Attach(guest.contents(), preload, arguments, node,
                               std::move(calls), std::move(session));
          // Its navigations and beforeunloads are the app's to decide on.
          ElectronPage::FromWebContents(&guest.contents())->DecideFor(guest);
          if (history.has_value()) {
            guest.RestoreHistory(HistoryEntries(*history), history->index);
          } else {
            guest.Navigate(url);
          }
        },
        /*popup_window=*/std::nullopt, 0, 0,
        /*private_browsing=*/false, /*profile=*/std::string(), /*app=*/true,
        partition, /*app_host=*/std::string(), app_id, view, title, hidden);
    if (made == nullptr) {
      return std::nullopt;
    }
    return made->window_id();
  }

  // Makes `contents`, a page's new window its Electron app allowed, a window
  // of app `app_id`; see ElectronDesk::Adopt. Returns its id.
  std::string AdoptElectron(std::unique_ptr<content::WebContents> contents,
                            const std::string& app_id,
                            const std::string& preload,
                            const std::vector<std::string>& arguments,
                            const std::optional<ElectronNode>& node,
                            ElectronPageCalls calls,
                            base::WeakPtr<ElectronSession> session,
                            const std::string& title,
                            bool hidden,
                            const std::string& user_agent) {
    std::unique_ptr<WebViewGuest> guest =
        WebViewGuest::AdoptOpenedWindow(std::move(contents));
    guest->KeepFullFrameRate();
    guest->DecideWindowsWith(AskTheApp(calls.window_opening));
    guest->TakeContextMenusWith(TellTheApp(calls.context_menu));
    // Content started its first navigation before the app answered, so the
    // preload runs from the page's next document, and the session's user agent
    // from its next request.
    if (session && !session->user_agent().empty()) {
      UseUserAgent(guest->contents(), session->user_agent());
    }
    HearTheApp(*guest, user_agent, calls.reported);
    ElectronPage::Attach(guest->contents(), preload, arguments, node,
                         std::move(calls), std::move(session));
    ElectronPage::FromWebContents(&guest->contents())->DecideFor(*guest);
    const std::string id = guest->window_id();
    auto watch = std::make_unique<Watch>(
        guest->contents(), id,
        base::BindRepeating(&DeskWindows::Changed, base::Unretained(this)));
    windows_.push_back(Window{.id = id,
                              .guest = std::move(guest),
                              .watch = std::move(watch),
                              .app = true,
                              .profiled = false,
                              .app_id = app_id,
                              .hidden = hidden,
                              .app_title = title});
    // guard-electron-window-open.sh greps for this.
    LOG(INFO) << "domicile: Electron app " << app_id
              << " allowed its page's window " << id << ".";
    Changed();
    return id;
  }

  // Electron window `id`'s own title, shown over its page's. The app made
  // sure `id` is one of its windows, not a view; one that closed meanwhile
  // is skipped.
  void SetTitle(const std::string& id, const std::string& title) {
    auto window = std::ranges::find(windows_, id, &Window::id);
    if (window == windows_.end()) {
      LOG(WARNING) << "domicile: asked to title browser window " << id
                   << ", which is not open.";
      return;
    }
    CHECK(!window->view) << "browser window " << id << " is a view";
    window->app_title = title;
    Changed();
  }

  // Whether Electron window `id` is hidden, as SetTitle.
  void SetHidden(const std::string& id, bool hidden) {
    auto window = std::ranges::find(windows_, id, &Window::id);
    if (window == windows_.end()) {
      LOG(WARNING) << "domicile: asked to hide or show browser window " << id
                   << ", which is not open.";
      return;
    }
    CHECK(!window->view) << "browser window " << id << " is a view";
    if (window->hidden != hidden) {
      window->hidden = hidden;
      Changed();
    }
  }

  // The state the Electron app asks for window `id`. The app made sure `id`
  // is one of its windows; one that closed meanwhile is skipped.
  void SetWindowState(const std::string& id, ElectronWindowState state) {
    auto window = std::ranges::find(windows_, id, &Window::id);
    if (window == windows_.end()) {
      LOG(WARNING) << "domicile: asked to set the state of browser window "
                   << id << ", which is not open.";
      return;
    }
    CHECK(!window->view) << "browser window " << id
                         << " was given a window state and is a view";
    if (window->wanted_state != state) {
      window->wanted_state = state;
      Changed();
    }
  }

  // The shell made window `id` `state`. Only an Electron app hears it; a
  // window that closed meanwhile is a report that raced it.
  void ReportWindowState(const std::string& id, ElectronWindowState state) {
    auto window = std::ranges::find(windows_, id, &Window::id);
    // A view has no state of its own: its window's is the view's.
    if (window == windows_.end() || window->view) {
      return;
    }
    if (ElectronPage* page =
            ElectronPage::FromWebContents(&window->guest->contents())) {
      page->WindowStateChanged(state);
    }
  }

  // Window `id` holds `views`, bottom first, and no others. The app made
  // sure `id` is a window and each of `views` a view, both its own; a window
  // or view that closed meanwhile is skipped.
  void SetViews(const std::string& id, std::vector<ElectronDeskView> views) {
    if (std::ranges::find(windows_, id, &Window::id) == windows_.end()) {
      LOG(WARNING) << "domicile: asked to set the views of browser window "
                   << id << ", which is not open.";
      return;
    }
    for (Window& window : windows_) {
      if (window.parent == id) {
        window.parent.clear();
      }
    }
    int stack = 0;
    for (const ElectronDeskView& placed : views) {
      auto view = std::ranges::find(windows_, placed.id, &Window::id);
      if (view == windows_.end()) {
        continue;
      }
      CHECK(view->view) << "browser window " << placed.id
                        << " was placed as a view and is a window";
      view->parent = id;
      view->x = placed.x;
      view->y = placed.y;
      view->width = placed.width;
      view->height = placed.height;
      view->hidden = placed.hidden;
      view->stack = stack++;
    }
    Changed();
  }

  // Window `id`'s menu bar. The app made sure `id` is one of its windows; one
  // that closed meanwhile is skipped.
  void SetMenuBar(const std::string& id, ElectronDeskMenuBar bar) {
    auto window = std::ranges::find(windows_, id, &Window::id);
    if (window == windows_.end()) {
      LOG(WARNING) << "domicile: asked to set the menu bar of browser window "
                   << id << ", which is not open.";
      return;
    }
    CHECK(!window->view) << "browser window " << id
                         << " was given a menu bar and is a view";
    if (window->menu_bar == bar) {
      return;
    }
    window->menu_bar = std::move(bar);
    Changed();
  }

  // The user clicked entry `command` of window `id`'s menu bar. A window that
  // closed meanwhile, or that has no menu, is a click that raced it.
  void ClickMenu(const std::string& id, int command) {
    auto window = std::ranges::find(windows_, id, &Window::id);
    if (window == windows_.end() || window->menu_bar.menu.empty()) {
      LOG(WARNING) << "domicile: a click on the menu of browser window " << id
                   << ", which has none.";
      return;
    }
    ElectronPage* page = ElectronPage::FromWebContents(&window->guest->contents());
    CHECK(page) << "browser window " << id
                << " has a menu bar and no Electron app";
    page->MenuClicked(command);
  }

  // Asks `box` over window `id`, after any it is already asking. The app made
  // sure `id` is one of its windows; one that closed meanwhile answers with
  // the box's cancel button at once.
  void ShowMessageBox(const std::string& id,
                      ElectronDeskMessageBox box,
                      base::OnceCallback<void(int, bool)> answered) {
    auto window = std::ranges::find(windows_, id, &Window::id);
    if (window == windows_.end()) {
      LOG(WARNING) << "domicile: asked to show a message box over browser "
                      "window "
                   << id << ", which is not open; it answers Cancel.";
      std::move(answered).Run(box.cancel_id, false);
      return;
    }
    CHECK(!window->view) << "browser window " << id
                         << " was asked to show a message box and is a view";
    window->message_boxes.push_back(
        {.box = std::move(box), .answered = std::move(answered)});
    // The shell lists only the first; later ones wait their turn.
    if (window->message_boxes.size() == 1) {
      Changed();
    }
  }

  // Shows `menu` over window `id`, in place of any it shows, which closes
  // with nothing chosen. The app made sure `id` is one of its windows; one
  // that closed meanwhile closes the menu at once.
  void ShowPopupMenu(const std::string& id,
                     ElectronDeskPopupMenu menu,
                     base::OnceCallback<void(int)> closed) {
    auto window = std::ranges::find(windows_, id, &Window::id);
    if (window == windows_.end()) {
      LOG(WARNING) << "domicile: asked to pop up a menu over browser window "
                   << id << ", which is not open; it closes at once.";
      std::move(closed).Run(0);
      return;
    }
    CHECK(!window->view) << "browser window " << id
                         << " was asked to pop up a menu and is a view";
    std::optional<ShownPopup> replaced = std::move(window->popup_menu);
    window->popup_menu = ShownPopup{.listed = PopupMenuListing(*window, menu),
                                    .closed = std::move(closed)};
    Changed();
    if (replaced.has_value()) {
      std::move(replaced->closed).Run(0);
    }
  }

  // Puts away the popup menu window `id` shows, as if nothing was chosen.
  void ClosePopupMenu(const std::string& id) {
    // An unknown window, or one showing none, is a close that raced it.
    AnswerPopupMenu(id, 0);
  }

  // The user chose entry `command` of the popup menu window `id` shows, or
  // put it away for 0. A window that closed meanwhile, or shows none, is an
  // answer that raced it.
  void AnswerPopupMenu(const std::string& id, int command) {
    auto window = std::ranges::find(windows_, id, &Window::id);
    if (window == windows_.end() || !window->popup_menu.has_value()) {
      LOG(WARNING) << "domicile: an answer to a popup menu over browser "
                      "window "
                   << id << ", which shows none.";
      return;
    }
    base::OnceCallback<void(int)> closed =
        std::move(window->popup_menu->closed);
    window->popup_menu.reset();
    Changed();
    std::move(closed).Run(command);
  }

  // The user answered the message box window `id` shows with button
  // `response`. A window that closed meanwhile, or shows none, is an answer
  // that raced it. Returns false for a button the box doesn't have.
  bool AnswerMessageBox(const std::string& id,
                        int response,
                        bool checkbox_checked) {
    auto window = std::ranges::find(windows_, id, &Window::id);
    if (window == windows_.end() || window->message_boxes.empty()) {
      LOG(WARNING) << "domicile: an answer to a message box over browser "
                      "window "
                   << id << ", which shows none.";
      return true;
    }
    AskedMessageBox& shown = window->message_boxes.front();
    if (response < 0 || response >= shown.box.buttons) {
      return false;
    }
    base::OnceCallback<void(int, bool)> answered = std::move(shown.answered);
    window->message_boxes.pop_front();
    Changed();
    std::move(answered).Run(response, checkbox_checked);
    return true;
  }

  // Opens an app window at an app module's `url`, pinned to `app_host`. See
  // WebViewGuest::PinToApp.
  bool OpenAppModule(const GURL& url, const std::string& app_host) {
    return Make([&](WebViewGuest& guest) { guest.Navigate(url); },
                /*popup_window=*/std::nullopt, 0, 0,
                /*private_browsing=*/false, /*profile=*/std::string(),
                /*app=*/true, /*partition=*/std::nullopt,
                app_host) != nullptr;
  }

  // Makes the page of a window a page opened, for content to hold until
  // Adopt. A page in a guest implies a shell to own it.
  std::unique_ptr<content::WebContents> MakeOpened(
      const content::WebContents::CreateParams& params) {
    content::WebContents* shell = ShellContentsIn(profile_);
    CHECK(shell);
    // Taken now, so an unshown window content drops leaves a gap. Ids are
    // still never reused.
    return WebViewGuest::MakeOpenedWindow(
        *shell, base::NumberToString(next_id_++), params,
        base::BindRepeating(&AttachTabHelpers));
  }

  // Lists a window MakeOpened made, at the `size` its page asked for.
  // Content navigates it, so this does not.
  void Adopt(std::unique_ptr<content::WebContents> contents,
             const GURL& target_url,
             const gfx::Size& size) {
    std::unique_ptr<WebViewGuest> guest =
        WebViewGuest::AdoptOpenedWindow(std::move(contents));
    WatchProfileOf(*guest);
    const std::string id = guest->window_id();
    auto watch = std::make_unique<Watch>(
        guest->contents(), id,
        base::BindRepeating(&DeskWindows::Changed, base::Unretained(this)));
    windows_.push_back(Window{
        id, std::move(guest), std::move(watch), size.width(), size.height(),
        /*app=*/false, /*profiled=*/true, /*app_id=*/std::string(),
        target_url});
    Changed();
  }

  // Opens a window at `url` as popup window `window_id`'s one tab, in browser
  // profile `profile`, private or not as it is.
  bool OpenPopupWindow(int window_id,
                       const GURL& url,
                       int width,
                       int height,
                       bool private_browsing,
                       const std::string& profile) {
    return Make([&](WebViewGuest& guest) { guest.Navigate(url); }, window_id,
                width, height, private_browsing, profile,
                /*app=*/false, /*partition=*/std::nullopt) != nullptr;
  }

  // Closes window `id`. An unknown id is a close that raced another.
  void Close(const std::string& id) {
    auto found = std::ranges::find(windows_, id, &Window::id);
    if (found == windows_.end()) {
      LOG(WARNING) << "domicile: asked to close browser window " << id
                   << ", which is not open.";
      return;
    }
    // Remove from the list now and destroy later. Close runs inside the
    // window's own WebContents (window.close(), tabs.remove), and destroying a
    // WebContents under its own call stack is a use-after-free.
    //
    // Later is kLinger: the shell animates a closed window out, and its
    // <webview> shows the page only while the page exists. Muted meanwhile,
    // since the window is closed as far as anyone hears.
    found->guest->contents().SetAudioMuted(true);
    // Its message boxes answer with their cancel buttons, as the app waits on
    // each.
    std::deque<AskedMessageBox> boxes = std::move(found->message_boxes);
    std::optional<ShownPopup> popup = std::move(found->popup_menu);
    closing_.push_back({id, std::move(found->guest)});
    base::SequencedTaskRunner::GetCurrentDefault()->PostDelayedTask(
        FROM_HERE,
        base::BindOnce(&DeskWindows::Reap, weak_factory_.GetWeakPtr(),
                       closing_.back().id),
        kLinger);
    windows_.erase(found);
    // Its views stay open, unlisted, as an Electron app's WebContentsViews
    // outlive the window that held them until the app closes them.
    for (Window& window : windows_) {
      if (window.parent == id) {
        window.parent.clear();
      }
    }
    LOG(INFO) << "domicile: closed browser window " << id << ".";
    Changed();
    for (AskedMessageBox& box : boxes) {
      std::move(box.answered).Run(box.box.cancel_id, false);
    }
    if (popup.has_value()) {
      std::move(popup->closed).Run(0);
    }
  }

  // Moves window `id`'s page to browser profile `profile`, as `move` says; see
  // mojom::BrowserWindows.Reopen. The new page takes the window's place in
  // the list, and the old one lingers as a closed window's does, muted.
  void Reopen(const std::string& id,
              const std::string& profile,
              const PageMove& move) {
    Reopen(id, profile, move, /*loaded=*/false);
  }

  // Reopen, once its profile has loaded (BrowserProfileRegistry::WhenLoaded).
  void ReopenLoaded(const std::string& id,
                    const std::string& profile,
                    const PageMove& move) {
    Reopen(id, profile, move, /*loaded=*/true);
  }

  void Reopen(const std::string& id,
              const std::string& profile,
              const PageMove& move,
              bool loaded) {
    auto found = std::ranges::find(windows_, id, &Window::id);
    if (found == windows_.end()) {
      LOG(WARNING) << "domicile: asked to move browser window " << id
                   << ", which is not open, to browser profile " << profile
                   << ".";
      return;
    }
    if (found->app) {
      LOG(WARNING) << "domicile: asked to move app window " << id
                   << " to browser profile " << profile
                   << "; an app window's page is its app's, and stays.";
      return;
    }
    BrowserProfileRegistry& registry = BrowserProfileRegistry::Get();
    if (registry.profiles().Find(profile) == nullptr) {
      LOG(WARNING) << "domicile: asked to move browser window " << id
                   << " to browser profile " << profile
                   << ", which the desk does not have; it stays.";
      return;
    }
    if (!loaded) {
      // A profile still loading would block the UI thread on the disk, so
      // the move waits for it, and finds the window again then.
      registry.WhenLoaded(
          *profile_, profile,
          base::BindOnce(&DeskWindows::ReopenLoaded,
                         weak_factory_.GetWeakPtr(), id, profile, move));
      return;
    }
    WebViewGuest& old = *found->guest;
    if (registry.IdOf(*old.contents().GetBrowserContext()) == profile) {
      LOG(INFO) << "domicile: browser window " << id
                << " is already in browser profile " << profile << ".";
      return;
    }
    content::WebContents* shell = ShellContentsIn(profile_);
    if (shell == nullptr) {
      LOG(WARNING) << "domicile: no shell to move browser window " << id
                   << " in.";
      return;
    }
    std::unique_ptr<WebViewGuest> guest = WebViewGuest::MakeWindow(
        *shell, id, old.popup_window(), /*private_browsing=*/false, profile,
        old.partition(), base::BindRepeating(&AttachTabHelpers));
    WatchProfileOf(*guest);
    auto watch = std::make_unique<Watch>(
        guest->contents(), id,
        base::BindRepeating(&DeskWindows::Changed, base::Unretained(this)));
    guest->MoveHistoryFrom(old, move);
    std::unique_ptr<WebViewGuest> replaced =
        std::exchange(found->guest, std::move(guest));
    found->watch = std::move(watch);
    found->opened_at = GURL();
    // Its <webview> asks for the window again, and gets the new page.
    replaced->Replaced();
    replaced->contents().SetAudioMuted(true);
    closing_.push_back({id, std::move(replaced)});
    base::SequencedTaskRunner::GetCurrentDefault()->PostDelayedTask(
        FROM_HERE,
        base::BindOnce(&DeskWindows::Reap, weak_factory_.GetWeakPtr(), id),
        kLinger);
    // The profile-routing guard greps for this.
    LOG(INFO) << "domicile: moved browser window " << id
              << " to browser profile " << profile << ".";
    Changed();
  }

  // Whether window `id` is an app window.
  bool IsApp(const std::string& id) const {
    auto found = std::ranges::find(windows_, id, &Window::id);
    return found != windows_.end() && found->app;
  }

  // Closes window `id` once its page agrees; see WebViewGuest::AskToClose. An
  // unknown id is a close that raced another.
  void AskToClose(const std::string& id) {
    WebViewGuest* guest = Find(id);
    if (guest == nullptr) {
      LOG(WARNING) << "domicile: asked to close browser window " << id
                   << ", which is not open.";
      return;
    }
    guest->AskToClose();
  }

  // The user asked to close window `id`. An Electron app's window asks its
  // app, which closes it or not, as Electron's `close` event can prevent;
  // any other is AskToClose.
  void UserAskedToClose(const std::string& id) {
    WebViewGuest* guest = Find(id);
    if (ElectronPage* page = guest == nullptr ? nullptr
                                              : ElectronPage::FromWebContents(
                                                    &guest->contents())) {
      page->CloseAsked();
    } else {
      AskToClose(id);
    }
  }

  WebViewGuest* Find(const std::string& id) {
    auto found = std::ranges::find(windows_, id, &Window::id);
    return found == windows_.end() ? nullptr : found->guest.get();
  }

  // The id of the window showing `page`, or empty when none does.
  std::string IdOf(const content::WebContents& page) const {
    auto found = std::ranges::find_if(windows_, [&page](const Window& window) {
      return &window.guest->contents() == &page;
    });
    return found == windows_.end() ? std::string() : found->id;
  }

  // The whole list, as sent to the shell: the windows oldest first, each
  // followed by the views it holds, bottom first. A view no window holds is
  // left out.
  std::vector<mojom::BrowserWindowPtr> List() const {
    std::vector<mojom::BrowserWindowPtr> list;
    for (const Window& window : windows_) {
      if (window.view) {
        continue;
      }
      list.push_back(Listed(window));
      std::vector<const Window*> views;
      for (const Window& view : windows_) {
        if (view.view && view.parent == window.id) {
          views.push_back(&view);
        }
      }
      std::ranges::sort(views, {}, &Window::stack);
      for (const Window* view : views) {
        list.push_back(Listed(*view));
      }
    }
    return list;
  }

  // The windows whose pages `on_screen` is on, and where on each. Both are
  // in screen coordinates, which a guest's view bounds are in.
  std::vector<PointerOverWindow> At(const gfx::PointF& on_screen) const {
    std::vector<PointerOverWindow> over;
    for (const Window& window : windows_) {
      content::RenderWidgetHostView* view =
          window.guest->contents().GetRenderWidgetHostView();
      if (view == nullptr) {
        continue;
      }
      const gfx::Rect bounds = view->GetViewBounds();
      if (bounds.IsEmpty() || !gfx::RectF(bounds).Contains(on_screen)) {
        continue;
      }
      over.push_back(PointerOverWindow{
          window.id,
          gfx::PointF((on_screen.x() - bounds.x()) / bounds.width(),
                      (on_screen.y() - bounds.y()) / bounds.height())});
    }
    return over;
  }

  // Counts a capture of window `id` until the returned runner runs, and lists
  // the window as captured meanwhile. An unknown id counts nothing.
  base::ScopedClosureRunner Capture(const std::string& id) {
    auto found = std::ranges::find(windows_, id, &Window::id);
    if (found == windows_.end()) {
      return base::ScopedClosureRunner();
    }
    if (found->captures++ == 0) {
      Changed();
    }
    return base::ScopedClosureRunner(base::BindOnce(
        &DeskWindows::Uncapture, weak_factory_.GetWeakPtr(), id));
  }

  void AddObserver(Observer* observer) { observers_.AddObserver(observer); }
  void RemoveObserver(Observer* observer) {
    observers_.RemoveObserver(observer);
  }

 private:
  // Reports a change to a page's address or title, and its loads.
  class Watch final : public content::WebContentsObserver {
   public:
    Watch(content::WebContents& contents,
          std::string id,
          base::RepeatingClosure changed)
        : WebContentsObserver(&contents),
          id_(std::move(id)),
          changed_(std::move(changed)) {}

    void DOMContentLoaded(content::RenderFrameHost* frame) override {
      if (frame->IsInPrimaryMainFrame()) {
        BrowserWindowDomReadies().Notify(id_);
      }
    }
    void DocumentOnLoadCompletedInPrimaryMainFrame() override {
      BrowserWindowLoads().Notify(id_);
    }

    void TitleWasSet(content::NavigationEntry* entry) override {
      changed_.Run();
    }
    void DidFinishNavigation(content::NavigationHandle* navigation) override {
      if (navigation->IsInPrimaryMainFrame()) {
        changed_.Run();
      }
    }

   private:
    const std::string id_;
    base::RepeatingClosure changed_;
  };

  // A message box a window asks, and where its answer goes.
  struct AskedMessageBox {
    ElectronDeskMessageBox box;
    base::OnceCallback<void(int, bool)> answered;
  };

  // A popup menu a window shows: as the shell lists it, and where the
  // entry chosen goes.
  struct ShownPopup {
    std::string listed;
    base::OnceCallback<void(int)> closed;
  };

  struct Window {
    std::string id;
    std::unique_ptr<WebViewGuest> guest;
    std::unique_ptr<Watch> watch;
    int width = 0;
    int height = 0;
    bool app = false;
    // Whether its page is in a browser profile: every browser window, and a
    // site's app window (OpenApp). An app module's or an Electron app's page
    // is its app's, in none.
    bool profiled = false;
    // The id OpenApp was given; empty for none.
    std::string app_id;
    // For a window a page opened, the address content navigates it to. Listed
    // until its first navigation commits, since content lists it first.
    GURL opened_at;
    // The captures of its page running; see Capture.
    int captures = 0;
    // An Electron app's WebContentsView page: listed only while a window
    // holds it, as `parent`, at `x`, `y`, `width` and `height` in its page,
    // `stack` from the bottom of its views, and `hidden` when the app hid it.
    bool view = false;
    std::string parent;
    int x = 0;
    int y = 0;
    // A view the app hid, or an Electron app window the app hid: listed so,
    // for the shell to keep out of sight while its page runs.
    bool hidden = false;
    // An Electron app window's own title, listed over its page's; empty for
    // none.
    std::string app_title;
    int stack = 0;
    // An Electron app window's menu bar, which the shell draws under its tab.
    ElectronDeskMenuBar menu_bar;
    // The message boxes its Electron app asks over it, first shown first.
    std::deque<AskedMessageBox> message_boxes;
    // The popup menu its Electron app shows over it, if any.
    std::optional<ShownPopup> popup_menu;
    // The state its Electron app asks for it.
    ElectronWindowState wanted_state;
  };

  // `menu` as the shell lists it over `window`: {"menu": its entries, "x",
  // "y"}, where the app asked, or where the user last pressed in the page.
  static std::string PopupMenuListing(const Window& window,
                                      const ElectronDeskPopupMenu& menu) {
    std::optional<base::Value> entries =
        base::JSONReader::Read(menu.menu, base::JSON_PARSE_CHROMIUM_EXTENSIONS);
    CHECK(entries.has_value() && entries->is_list())
        << "an Electron popup menu's entries are not a JSON list: "
        << menu.menu;
    gfx::Point at;
    if (menu.x.has_value() && menu.y.has_value()) {
      at = gfx::Point(*menu.x, *menu.y);
    } else if (const ElectronPage* page =
                   ElectronPage::FromWebContents(&window.guest->contents())) {
      at = page->last_press().value_or(gfx::Point());
    }
    std::string listed;
    CHECK(base::JSONWriter::Write(base::DictValue()
                                      .Set("menu", std::move(*entries))
                                      .Set("x", at.x())
                                      .Set("y", at.y()),
                                  &listed));
    return listed;
  }

  // One window as the shell's list has it.
  static mojom::BrowserWindowPtr Listed(const Window& window) {
    content::WebContents& contents = window.guest->contents();
    content::NavigationEntry* entry =
        contents.GetController().GetVisibleEntry();
    // A page's new window has only its initial entry until its first
    // navigation commits.
    const bool navigated = entry != nullptr && !entry->IsInitialEntry();
    const std::optional<WebViewPartition> partition = window.guest->partition();
    return mojom::BrowserWindow::New(
        window.id, navigated ? entry->GetVirtualURL() : window.opened_at,
        window.app_title.empty() ? base::UTF16ToUTF8(contents.GetTitle())
                                 : window.app_title,
        window.guest->popup_window().value_or(0), window.width, window.height,
        contents.GetBrowserContext()->IsOffTheRecord(),
        // An app module's or Electron app's page is its app's: listed in
        // no browser profile.
        window.profiled
            ? BrowserProfileRegistry::Get().IdOf(*contents.GetBrowserContext())
            : std::string(),
        partition.has_value() ? WebViewPartitionAttribute(*partition)
                              : std::string(),
        window.app, window.app_id, window.captures > 0, window.parent, window.x,
        window.y, window.hidden, window.menu_bar.menu, window.menu_bar.visible,
        window.menu_bar.auto_hide,
        window.message_boxes.empty()
            ? std::string()
            : window.message_boxes.front().box.message_box,
        window.popup_menu.has_value() ? window.popup_menu->listed
                                      : std::string(),
        window.wanted_state.maximized, window.wanted_state.minimized,
        window.wanted_state.fullscreen);
  }

  // Makes a window and gives it its first page with `load`. Returns it, or
  // null when the profile has no shell to own it.
  WebViewGuest* Make(base::FunctionRef<void(WebViewGuest&)> load,
                     std::optional<int> popup_window,
                     int width,
                     int height,
                     bool private_browsing,
                     const std::string& profile,
                     bool app,
                     const std::optional<WebViewPartition>& partition,
                     const std::string& app_host = std::string(),
                     const std::string& app_id = std::string(),
                     bool view = false,
                     const std::string& app_title = std::string(),
                     bool hidden = false) {
    // The shell owns every guest, browser windows included: content's guest
    // machinery reads the owner's WebContents when making a guest. A desk with
    // no shell has nothing to draw a window in anyway.
    content::WebContents* shell = ShellContentsIn(profile_);
    if (shell == nullptr) {
      LOG(WARNING) << "domicile: no shell to open a browser window in.";
      return nullptr;
    }
    const std::string id = base::NumberToString(next_id_++);
    std::unique_ptr<WebViewGuest> guest = WebViewGuest::MakeWindow(
        *shell, id, popup_window, private_browsing, profile, partition,
        base::BindRepeating(app ? &AttachAppTabHelpers : &AttachTabHelpers));
    WatchProfileOf(*guest);
    // `windows_` owns `guest` and the watch from here.
    auto watch = std::make_unique<Watch>(
        guest->contents(), id,
        base::BindRepeating(&DeskWindows::Changed, base::Unretained(this)));
    if (!app_host.empty()) {
      guest->PinToApp(app_host);
    }
    load(*guest);
    WebViewGuest* made = guest.get();
    windows_.push_back(
        Window{.id = id,
               .guest = std::move(guest),
               .watch = std::move(watch),
               .width = width,
               .height = height,
               .app = app,
               .profiled = !app || (app_host.empty() && !partition.has_value()),
               .app_id = app_id,
               .view = view,
               .hidden = hidden,
               .app_title = app_title});
    Changed();
    return made;
  }

  // Destroys a closed window's page once its linger is over. A profile
  // destroyed first already took it.
  //
  // Takes it out of the list first: destroying a page can close another
  // window, as DevTools closes its own with the page it inspects, and that
  // Close adds to `closing_` and posts its own Reap.
  void Reap(const std::string& id) {
    auto found = std::ranges::find(closing_, id, &Closing::id);
    if (found == closing_.end()) {
      return;
    }
    std::unique_ptr<WebViewGuest> reaping = std::move(found->guest);
    closing_.erase(found);
  }

  // Watches the profile `guest`'s page is in, when it is not this desk's own,
  // so its windows close before it is destroyed: a private profile ends with
  // its last page, and a browser profile the config drops unloads.
  void WatchProfileOf(WebViewGuest& guest) {
    Profile* in =
        Profile::FromBrowserContext(guest.contents().GetBrowserContext());
    if (in != profile_.get() && !page_profiles_.IsObservingSource(in)) {
      page_profiles_.AddObservation(in);
    }
  }

  // A capture Capture counted ended. The window may have closed first.
  void Uncapture(const std::string& id) {
    auto found = std::ranges::find(windows_, id, &Window::id);
    if (found != windows_.end() && --found->captures == 0) {
      Changed();
    }
  }

  void Changed() {
    for (Observer& observer : observers_) {
      observer.OnWindowsChanged();
    }
    ListBrowserWindows(this, Listing());
  }

  // The windows as a capture tool lists them, each view a window holds and
  // shows with where the app placed it.
  std::vector<ListedBrowserWindow> Listing() const {
    std::vector<ListedBrowserWindow> listing;
    for (const Window& window : windows_) {
      content::WebContents& contents = window.guest->contents();
      const GURL& committed = contents.GetLastCommittedURL();
      const bool placed =
          window.view && !window.hidden && !window.parent.empty();
      listing.push_back(ListedBrowserWindow{
          .id = window.id,
          .title = base::UTF16ToUTF8(contents.GetTitle()),
          .app_title = window.app_title,
          .app_id = window.app_id,
          .url = (committed.is_empty() ? window.opened_at : committed)
                     .possibly_invalid_spec(),
          .off_the_record = contents.GetBrowserContext()->IsOffTheRecord(),
          .view = window.view,
          .hidden = !window.view && window.hidden,
          .parent = placed ? window.parent : std::string(),
          .x = placed ? window.x : 0,
          .y = placed ? window.y : 0,
          .width = placed ? window.width : 0,
          .height = placed ? window.height : 0,
          .stack = placed ? window.stack : 0});
    }
    return listing;
  }

  // ProfileObserver:
  void OnProfileWillBeDestroyed(Profile* profile) override {
    if (profile != profile_.get()) {
      // Only that profile's windows, which would otherwise outlive it.
      page_profiles_.RemoveObservation(profile);
      std::erase_if(windows_, [profile](const Window& window) {
        return window.guest->contents().GetBrowserContext() == profile;
      });
      std::erase_if(closing_, [profile](const Closing& closing) {
        return closing.guest->contents().GetBrowserContext() == profile;
      });
      Changed();
      return;
    }
    profile_observation_.Reset();
    page_profiles_.RemoveAllObservations();
    windows_.clear();
    closing_.clear();
    ListBrowserWindows(this, {});
  }

  const raw_ptr<Profile> profile_;

  // In open order, which is the order sent to the shell.
  std::vector<Window> windows_;
  int next_id_ = 1;

  // How long a closed window's page outlives it: longer than the shell's
  // close animation, which draws its <webview> until the end.
  static constexpr base::TimeDelta kLinger = base::Seconds(1);

  // A closed window awaiting Reap, by its old id. Ids are never reused.
  struct Closing {
    std::string id;
    std::unique_ptr<WebViewGuest> guest;
  };

  // Closed and awaiting Reap. Held here, not in a DeleteSoon, so a profile
  // destroyed first takes them with it, before its desk's window.
  std::vector<Closing> closing_;

  base::ObserverList<Observer> observers_;
  base::ScopedObservation<Profile, ProfileObserver> profile_observation_{this};
  // The other profiles its windows' pages are in: browser profiles', private
  // ones' off-the-record profiles. See WatchProfileOf.
  base::ScopedMultiSourceObservation<Profile, ProfileObserver> page_profiles_{
      this};

  base::WeakPtrFactory<DeskWindows> weak_factory_{this};
};

// WebViewGuest's host. Routes each call to the desk that lists the guest:
// the shell's, for a page in any browser profile (BrowserProfileRegistry).
class Host final : public BrowserWindowHost {
 public:
  // A page's new window with no opener, or an extension's new tab, is in the
  // profile its site opens in, and an extension's own page in the profile
  // that asked for it (ProfileForNewWindow); a private page's stays in its
  // profile.
  WebViewGuest* Open(
      content::BrowserContext& context,
      const GURL& url,
      const std::optional<WebViewPartition>& partition) override {
    BrowserProfileRegistry& registry = BrowserProfileRegistry::Get();
    const bool private_browsing = context.IsOffTheRecord();
    const std::string asker = registry.IdOf(context);
    return Windows(context).Open(
        url, private_browsing,
        private_browsing
            ? asker
            : ProfileForNewWindow(registry.profiles(), asker, url),
        partition);
  }

  // As Open, in `source`'s context and partition.
  void OpenHistoryStep(WebViewGuest& source, HistoryStep step) override {
    content::BrowserContext& context = *source.contents().GetBrowserContext();
    Windows(context).OpenHistoryStep(
        source, step, context.IsOffTheRecord(),
        BrowserProfileRegistry::Get().IdOf(context), source.partition());
  }

  std::unique_ptr<content::WebContents> MakeOpenedWindow(
      const content::WebContents::CreateParams& params) override {
    return Windows(*params.browser_context).MakeOpened(params);
  }

  void AdoptOpenedWindow(std::unique_ptr<content::WebContents> contents,
                         const GURL& target_url,
                         const gfx::Size& size) override {
    content::BrowserContext& context = *contents->GetBrowserContext();
    Windows(context).Adopt(std::move(contents), target_url, size);
  }

  void OpenPopupWindow(content::BrowserContext& context,
                       int window_id,
                       const GURL& url,
                       int width,
                       int height) override {
    // In the profile of the extension that asked: a popup of another
    // profile's would show it a page it may not see.
    Windows(context).OpenPopupWindow(
        window_id, url, width, height, context.IsOffTheRecord(),
        BrowserProfileRegistry::Get().IdOf(context));
  }

  void Close(content::BrowserContext& context, const std::string& id) override {
    Windows(context).Close(id);
  }

  WebViewGuest* Find(content::BrowserContext& context,
                     const std::string& id) override {
    return Windows(context).Find(id);
  }

  content::BrowserContext& ContextFor(content::BrowserContext& owner,
                                      bool private_browsing,
                                      const std::string& profile) override {
    // The owner is the shell, in the default profile.
    Profile& shell = *Profile::FromBrowserContext(&owner)->GetOriginalProfile();
    BrowserProfileRegistry& registry = BrowserProfileRegistry::Get();
    const std::string& fallback =
        private_browsing ? registry.profiles().default_private_profile
                         : registry.profiles().default_profile;
    Profile* context =
        registry.ContextOf(shell, profile.empty() ? fallback : profile);
    if (context == nullptr && !profile.empty()) {
      // The shell's list may be a change behind the config.
      LOG(WARNING) << "domicile: a page asked for browser profile \""
                   << profile << "\", which the desk does not have; it opens "
                   << "in " << fallback << ".";
      context = registry.ContextOf(shell, fallback);
    }
    if (private_browsing && context != nullptr &&
        !context->IsOffTheRecord()) {
      // A private page is never made where it would keep anything.
      LOG(WARNING) << "domicile: a private page asked for browser profile \""
                   << profile << "\", which is not private; it opens in "
                   << fallback << ".";
      context = registry.ContextOf(shell, fallback);
    }
    if (context != nullptr) {
      return *context;
    }
    // The profile would not load, which the registry logged. A private page
    // still opens off the record, in the shell's own off-the-record profile.
    LOG(ERROR) << "domicile: browser profile " << fallback
               << " is not loaded; the page opens in the shell's profile"
               << (private_browsing ? ", off the record." : ".");
    return private_browsing ? *shell.GetPrimaryOTRProfile(
                                  /*create_if_needed=*/true)
                            : shell;
  }

  void WhenContextReady(content::BrowserContext& owner,
                        bool private_browsing,
                        const std::string& profile,
                        base::OnceClosure ready) override {
    // Waits on the profile ContextFor will pick, so it finds it loaded.
    Profile& shell = *Profile::FromBrowserContext(&owner)->GetOriginalProfile();
    BrowserProfileRegistry& registry = BrowserProfileRegistry::Get();
    const std::string& fallback =
        private_browsing ? registry.profiles().default_private_profile
                         : registry.profiles().default_profile;
    const BrowserProfile* named =
        profile.empty() ? nullptr : registry.profiles().Find(profile);
    const std::string& id =
        named != nullptr && (!private_browsing || named->is_private)
            ? profile
            : fallback;
    registry.WhenLoaded(shell, id, std::move(ready));
  }

  std::optional<std::string> ProfileToMoveTo(WebViewGuest& guest,
                                             const GURL& from,
                                             const GURL& to) override {
    content::BrowserContext& context = *guest.contents().GetBrowserContext();
    // A private page never leaves private browsing, and an app window's page
    // is its app's.
    if (context.IsOffTheRecord() || Windows(context).IsApp(guest.window_id())) {
      return std::nullopt;
    }
    BrowserProfileRegistry& registry = BrowserProfileRegistry::Get();
    return RouteNavigation(registry.profiles(), registry.IdOf(context), from,
                           to);
  }

  void Reopen(WebViewGuest& guest,
              const std::string& profile,
              const PageMove& move) override {
    Windows(*guest.contents().GetBrowserContext())
        .Reopen(guest.window_id(), profile, move);
  }

  void PrivatePageOpened(content::BrowserContext& context) override {
    BrowserProfileRegistry::Get().PrivatePageOpened(context);
  }

  void PrivatePageClosed(content::BrowserContext& context) override {
    BrowserProfileRegistry::Get().PrivatePageClosed(context);
  }

 private:
  static DeskWindows& Windows(content::BrowserContext& context) {
    return DeskWindows::For(&BrowserProfileRegistry::Get().HomeOf(context));
  }
};

// The list for one shell document. A DocumentService like ExtensionTray, so a
// reloaded shell binds a new one and gets the list again.
class BrowserWindowsService final
    : public content::DocumentService<mojom::BrowserWindows>,
      public DeskWindows::Observer,
      public BrowserProfileRegistry::Observer {
 public:
  BrowserWindowsService(content::RenderFrameHost& frame,
                        mojo::PendingReceiver<mojom::BrowserWindows> receiver,
                        base::SelfDeletingPassKey key)
      : DocumentService(frame, std::move(receiver), key),
        windows_(&DeskWindows::For(
            Profile::FromBrowserContext(frame.GetBrowserContext()))) {
    windows_->AddObserver(this);
    BrowserProfileRegistry::Get().AddObserver(this);
  }

 private:
  ~BrowserWindowsService() override {
    BrowserProfileRegistry::Get().RemoveObserver(this);
    windows_->RemoveObserver(this);
  }

  // mojom::BrowserWindows:
  void SetClient(
      mojo::PendingRemote<mojom::BrowserWindowsClient> client) override {
    if (client_.is_bound()) {
      ReportBadMessageAndDeleteThis(
          "domicile: the browser windows have one client per document.");
      return;
    }
    client_.Bind(std::move(client));
    OnBrowserProfilesChanged();
    OnWindowsChanged();
  }

  void Open(const GURL& url,
            bool private_browsing,
            const std::string& profile,
            const std::string& partition) override {
    // The page throws for "persist:" with no name first.
    const base::expected<std::optional<WebViewPartition>, std::string> parsed =
        ParseWebViewPartition(partition);
    if (!parsed.has_value()) {
      ReportBadMessageAndDeleteThis(
          "domicile: a browser window was opened in a partition it may not "
          "have.");
      return;
    }
    // No profile is the one its site opens in, or the default private one.
    BrowserProfileRegistry& registry = BrowserProfileRegistry::Get();
    const std::string id =
        profile.empty() && !private_browsing
            ? ProfileForUrl(registry.profiles(), url)
            : profile;
    // A profile still loading would block the UI thread on the disk, so the
    // window waits for it.
    registry.WhenLoaded(
        *Profile::FromBrowserContext(
             render_frame_host().GetBrowserContext())
             ->GetOriginalProfile(),
        id.empty() ? (private_browsing
                          ? registry.profiles().default_private_profile
                          : registry.profiles().default_profile)
                   : id,
        base::BindOnce(&BrowserWindowsService::OpenLoaded,
                       weak_factory_.GetWeakPtr(), url, private_browsing, id,
                       *parsed));
  }

  void OpenLoaded(const GURL& url,
                  bool private_browsing,
                  const std::string& profile,
                  const std::optional<WebViewPartition>& partition) {
    windows_->Open(url, private_browsing, profile, partition);
  }

  void OpenApp(const GURL& url,
               const std::string& app_id,
               mojom::AppReuse reuse,
               const std::string& profile) override {
    // No profile is the one its site opens in, as for Open.
    windows_->OpenApp(
        url, app_id, reuse,
        profile.empty()
            ? ProfileForUrl(BrowserProfileRegistry::Get().profiles(), url)
            : profile);
  }

  void CountMatches(const std::string& id,
                    const std::string& selector,
                    CountMatchesCallback callback) override {
    WebViewGuest* guest = windows_->Find(id);
    if (guest == nullptr) {
      std::move(callback).Run(std::nullopt);
      return;
    }
    guest->CountMatches(selector, std::move(callback));
  }

  void ClickMatch(const std::string& id,
                  const std::string& selector,
                  ClickMatchCallback callback) override {
    WebViewGuest* guest = windows_->Find(id);
    if (guest == nullptr) {
      std::move(callback).Run(std::nullopt);
      return;
    }
    guest->ClickMatch(selector, std::move(callback));
  }

  void Close(const std::string& id) override { windows_->UserAskedToClose(id); }

  void ClickMenu(const std::string& id, int32_t command) override {
    if (command < 1) {
      ReportBadMessageAndDeleteThis(
          "domicile: a menu entry was clicked by a number no entry has.");
      return;
    }
    windows_->ClickMenu(id, command);
  }

  void SetWindowState(const std::string& id,
                      bool maximized,
                      bool minimized,
                      bool fullscreen) override {
    windows_->ReportWindowState(id, {.maximized = maximized,
                                     .minimized = minimized,
                                     .fullscreen = fullscreen});
  }

  void AnswerPopupMenu(const std::string& id, int32_t command) override {
    if (command < 0) {
      ReportBadMessageAndDeleteThis(
          "domicile: a popup menu was answered with a negative entry.");
      return;
    }
    windows_->AnswerPopupMenu(id, command);
  }

  void AnswerMessageBox(const std::string& id,
                        int32_t response,
                        bool checkbox_checked) override {
    if (!windows_->AnswerMessageBox(id, response, checkbox_checked)) {
      ReportBadMessageAndDeleteThis(
          "domicile: a message box was answered with a button it doesn't "
          "have.");
    }
  }

  void Reopen(const std::string& id, const std::string& profile) override {
    windows_->Reopen(id, profile, PageMove());
  }

  void ProfileFor(const GURL& url, ProfileForCallback callback) override {
    std::move(callback).Run(
        ProfileForUrl(BrowserProfileRegistry::Get().profiles(), url));
  }

  void SiteFor(const GURL& url, SiteForCallback callback) override {
    const std::string* site =
        SiteForUrl(BrowserProfileRegistry::Get().profiles(), url);
    std::move(callback).Run(site == nullptr ? std::nullopt
                                            : std::optional(*site));
  }

  void PinSite(const std::string& site,
               const std::string& profile,
               PinSiteCallback callback) override {
    const base::expected<void, std::string> pinned =
        BrowserProfileRegistry::Get().PinSite(
            *Profile::FromBrowserContext(
                 render_frame_host().GetBrowserContext())
                 ->GetOriginalProfile(),
            site, profile);
    std::move(callback).Run(pinned.has_value() ? std::string()
                                               : pinned.error());
  }

  void SetExtensionEnabled(const std::string& profile,
                           const std::string& id,
                           bool enabled,
                           SetExtensionEnabledCallback callback) override {
    LOG(INFO) << "domicile: the shell switches " << id
              << (enabled ? " on" : " off") << " in browser profile "
              << profile << ".";
    const base::expected<void, std::string> done =
        BrowserProfileRegistry::Get().SetExtensionEnabled(
            *Profile::FromBrowserContext(
                 render_frame_host().GetBrowserContext())
                 ->GetOriginalProfile(),
            profile, id, enabled);
    std::move(callback).Run(done.has_value() ? std::string() : done.error());
  }

  // DeskWindows::Observer:
  void OnWindowsChanged() override {
    if (client_.is_bound()) {
      client_->WindowsChanged(windows_->List());
    }
  }

  // BrowserProfileRegistry::Observer:
  void OnBrowserProfilesChanged() override {
    if (!client_.is_bound()) {
      return;
    }
    BrowserProfileRegistry& registry = BrowserProfileRegistry::Get();
    const BrowserProfiles& profiles = registry.profiles();
    std::vector<mojom::BrowserProfilePtr> listed;
    for (const BrowserProfile& profile : profiles.profiles) {
      std::vector<mojom::BrowserProfileExtensionPtr> extensions;
      for (const BrowserProfileRegistry::ExtensionSwitch& extension :
           registry.ExtensionSwitchesOf(profile.id)) {
        extensions.push_back(mojom::BrowserProfileExtension::New(
            extension.id, extension.enabled, extension.locked));
      }
      listed.push_back(mojom::BrowserProfile::New(
          profile.id, profile.name, profile.color, profile.is_private,
          std::vector<std::string>(), std::vector<std::string>(),
          std::move(extensions)));
    }
    for (const auto& [site, id] : profiles.sites) {
      auto profile = std::ranges::find(profiles.profiles, id,
                                       &BrowserProfile::id);
      CHECK(profile != profiles.profiles.end())
          << "site " << site << " routes to profile " << id
          << ", which the desk does not have";
      mojom::BrowserProfilePtr& entry =
          listed[profile - profiles.profiles.begin()];
      (registry.IsConfigSite(site) ? entry->config_sites : entry->pinned_sites)
          .push_back(site);
    }
    client_->ProfilesChanged(std::move(listed), profiles.default_profile,
                             profiles.default_private_profile);
  }

  // Owned by the profile, which outlives every document in it.
  const raw_ptr<DeskWindows> windows_;
  mojo::Remote<mojom::BrowserWindowsClient> client_;
  base::WeakPtrFactory<BrowserWindowsService> weak_factory_{this};
};

// Browser window `id`'s page in the shell's profile, for a capture of it
// alone. nullopt when there is no shell, no such window, or no page drawn.
//
// The page counts as captured while the target's `drawing` is held, so it
// keeps drawing, and tells its page it is visible, as a captured tab does in
// Chrome. The list says so meanwhile, so the shell keeps a window it hides
// laid out: a page with no layout box draws nothing.
std::optional<BrowserWindowCaptureTarget> CaptureTargetOf(
    const std::string& id) {
  content::WebContents* shell = ShellContentsIn(nullptr);
  if (shell == nullptr) {
    return std::nullopt;
  }
  DeskWindows& windows =
      DeskWindows::For(Profile::FromBrowserContext(shell->GetBrowserContext()));
  WebViewGuest* guest = windows.Find(id);
  if (guest == nullptr) {
    return std::nullopt;
  }
  content::RenderWidgetHostView* view =
      guest->contents().GetRenderWidgetHostView();
  if (view == nullptr) {
    return std::nullopt;
  }
  std::optional<BrowserWindowCaptureTarget> target =
      BrowserWindowCaptureTargetOf(
          view->GetRenderWidgetHost()->GetFrameSinkId(),
          view->GetViewBounds().size(), view->GetDeviceScaleFactor());
  if (target.has_value()) {
    // Both end with the capture: the runners run as the callback holding
    // them goes.
    target->drawing = base::ScopedClosureRunner(base::BindOnce(
        [](base::ScopedClosureRunner drawing,
           base::ScopedClosureRunner listed) {},
        guest->contents().IncrementCapturerCount(
            /*capture_size=*/gfx::Size(), /*stay_hidden=*/false,
            /*stay_awake=*/true, /*is_activity=*/false),
        windows.Capture(id)));
  }
  return target;
}

// The id of the browser window whose page showed non-persistent notification
// `notification_id`, for Chrome's notification bridge to tell the desktop.
// Empty when there is no shell, or no browser window's page showed it: the
// shell's own, or one from a page already gone.
std::string NotificationWindowOf(const std::string& notification_id) {
  content::WebContents* page =
      content::NotificationEventDispatcher::GetInstance()
          ->GetNonPersistentNotificationWebContents(notification_id);
  content::WebContents* shell = ShellContentsIn(nullptr);
  if (page == nullptr || shell == nullptr) {
    return std::string();
  }
  return DeskWindows::For(
             Profile::FromBrowserContext(shell->GetBrowserContext()))
      .IdOf(*page);
}

}  // namespace

void StartBrowserWindows() {
  static base::NoDestructor<Host> host;
  WebViewGuest::SetBrowserWindowHost(host.get());
  SetBrowserWindowCaptureTargetFinder(base::BindRepeating(&CaptureTargetOf));
  SetNotificationWindowFinder(base::BindRepeating(&NotificationWindowOf));
}

bool OpenBrowserWindow(const GURL& url, const std::string& profile) {
  content::WebContents* shell = ShellContentsIn(nullptr);
  if (shell == nullptr) {
    return false;
  }
  return DeskWindows::For(
             Profile::FromBrowserContext(shell->GetBrowserContext()))
             .Open(url, /*private_browsing=*/false,
                   profile.empty() ? ProfileForUrl(
                                         BrowserProfileRegistry::Get()
                                             .profiles(),
                                         url)
                                   : profile,
                   /*partition=*/std::nullopt) != nullptr;
}

bool OpenAppWindow(const GURL& url,
                   const std::string& app_id,
                   mojom::AppReuse reuse,
                   const std::string& profile) {
  content::WebContents* shell = ShellContentsIn(nullptr);
  if (shell == nullptr) {
    return false;
  }
  return DeskWindows::For(
             Profile::FromBrowserContext(shell->GetBrowserContext()))
      .OpenApp(url, app_id, reuse,
               profile.empty()
                   ? ProfileForUrl(BrowserProfileRegistry::Get().profiles(),
                                   url)
                   : profile);
}

bool OpenAppModuleWindow(const GURL& url, const std::string& app_host) {
  content::WebContents* shell = ShellContentsIn(nullptr);
  if (shell == nullptr) {
    return false;
  }
  return DeskWindows::For(
             Profile::FromBrowserContext(shell->GetBrowserContext()))
      .OpenAppModule(url, app_host);
}

namespace {

// The desk's windows in the shell's profile, or null while there is no shell.
DeskWindows* ShellDeskWindows() {
  content::WebContents* shell = ShellContentsIn(nullptr);
  if (shell == nullptr) {
    return nullptr;
  }
  return &DeskWindows::For(
      Profile::FromBrowserContext(shell->GetBrowserContext()));
}

}  // namespace

std::optional<std::string> AdoptElectronWindow(
    std::unique_ptr<ElectronHeldPage> page,
    const std::string& app_id,
    const std::string& preload,
    const std::vector<std::string>& arguments,
    const std::optional<ElectronNode>& node,
    ElectronPageCalls calls,
    base::WeakPtr<ElectronSession> session,
    const std::string& title,
    bool hidden,
    const std::string& user_agent) {
  DeskWindows* windows = ShellDeskWindows();
  if (windows == nullptr) {
    return std::nullopt;
  }
  // Every held page is one AskTheApp made.
  return windows->AdoptElectron(static_cast<HeldPage&>(*page).Take(), app_id,
                                preload, arguments, node, std::move(calls),
                                std::move(session), title, hidden,
                                user_agent);
}

std::optional<std::string> OpenElectronWindow(
    const GURL& url,
    const std::optional<ElectronHistory>& history,
    const std::string& app_id,
    const WebViewPartition& partition,
    const std::string& preload,
    const std::vector<std::string>& arguments,
    const std::optional<ElectronNode>& node,
    ElectronPageCalls calls,
    base::WeakPtr<ElectronSession> session,
    bool view,
    const std::string& title,
    bool hidden,
    const std::string& user_agent) {
  DeskWindows* windows = ShellDeskWindows();
  if (windows == nullptr) {
    return std::nullopt;
  }
  return windows->OpenElectron(url, history, app_id, partition, preload,
                               arguments, node, std::move(calls),
                               std::move(session), view, title, hidden,
                               user_agent);
}

void SetElectronTitle(const std::string& id, const std::string& title) {
  if (DeskWindows* windows = ShellDeskWindows()) {
    windows->SetTitle(id, title);
  }
}

void SetElectronHidden(const std::string& id, bool hidden) {
  if (DeskWindows* windows = ShellDeskWindows()) {
    windows->SetHidden(id, hidden);
  }
}

void SetElectronWindowState(const std::string& id, ElectronWindowState state) {
  if (DeskWindows* windows = ShellDeskWindows()) {
    windows->SetWindowState(id, state);
  }
}

void SetElectronViews(const std::string& id,
                      std::vector<ElectronDeskView> views) {
  if (DeskWindows* windows = ShellDeskWindows()) {
    windows->SetViews(id, std::move(views));
  }
}

void SetElectronMenuBar(const std::string& id, ElectronDeskMenuBar bar) {
  if (DeskWindows* windows = ShellDeskWindows()) {
    windows->SetMenuBar(id, std::move(bar));
  }
}

void ShowElectronPopupMenu(const std::string& id,
                           ElectronDeskPopupMenu menu,
                           base::OnceCallback<void(int)> closed) {
  if (DeskWindows* windows = ShellDeskWindows()) {
    windows->ShowPopupMenu(id, std::move(menu), std::move(closed));
  } else {
    std::move(closed).Run(0);
  }
}

void CloseElectronPopupMenu(const std::string& id) {
  if (DeskWindows* windows = ShellDeskWindows()) {
    windows->ClosePopupMenu(id);
  }
}

void ShowElectronMessageBox(const std::string& id,
                            ElectronDeskMessageBox box,
                            base::OnceCallback<void(int, bool)> answered) {
  if (DeskWindows* windows = ShellDeskWindows()) {
    windows->ShowMessageBox(id, std::move(box), std::move(answered));
  } else {
    std::move(answered).Run(box.cancel_id, false);
  }
}

ElectronPage* ElectronPageOf(const std::string& id) {
  DeskWindows* windows = ShellDeskWindows();
  WebViewGuest* guest = windows == nullptr ? nullptr : windows->Find(id);
  if (guest == nullptr) {
    LOG(WARNING) << "domicile: asked to message browser window " << id
                 << ", which is not open.";
    return nullptr;
  }
  return ElectronPage::FromWebContents(&guest->contents());
}

void SetBrowserWindowUserAgent(const std::string& id,
                               const std::string& user_agent) {
  DeskWindows* windows = ShellDeskWindows();
  WebViewGuest* guest = windows == nullptr ? nullptr : windows->Find(id);
  if (guest == nullptr) {
    LOG(WARNING) << "domicile: asked to set the user agent of browser window "
                 << id << ", which is not open.";
  } else {
    UseUserAgent(guest->contents(), user_agent);
  }
}

void LoadBrowserWindow(const std::string& id, const GURL& url) {
  DeskWindows* windows = ShellDeskWindows();
  WebViewGuest* guest = windows == nullptr ? nullptr : windows->Find(id);
  if (guest == nullptr) {
    LOG(WARNING) << "domicile: asked to load browser window " << id
                 << ", which is not open.";
  } else {
    guest->Navigate(url);
  }
}

content::WebContents* BrowserWindowContents(const std::string& id) {
  DeskWindows* windows = ShellDeskWindows();
  WebViewGuest* guest = windows == nullptr ? nullptr : windows->Find(id);
  return guest == nullptr ? nullptr : &guest->contents();
}

void FocusBrowserWindow(const std::string& id) {
  DeskWindows* windows = ShellDeskWindows();
  WebViewGuest* guest = windows == nullptr ? nullptr : windows->Find(id);
  if (guest == nullptr) {
    LOG(WARNING) << "domicile: asked to focus browser window " << id
                 << ", which is not open.";
  } else {
    guest->RequestFocus();
  }
}

void AskToCloseBrowserWindow(const std::string& id) {
  if (DeskWindows* windows = ShellDeskWindows()) {
    windows->AskToClose(id);
  }
}

void CloseBrowserWindow(const std::string& id) {
  if (DeskWindows* windows = ShellDeskWindows()) {
    windows->Close(id);
  }
}

base::CallbackListSubscription WatchBrowserWindowLoads(
    base::RepeatingCallback<void(const std::string& id)> loaded) {
  return BrowserWindowLoads().Add(std::move(loaded));
}

base::CallbackListSubscription WatchBrowserWindowDomReadies(
    base::RepeatingCallback<void(const std::string& id)> ready) {
  return BrowserWindowDomReadies().Add(std::move(ready));
}

content::WebContents* DeskShellContents() {
  return ShellContentsIn(nullptr);
}

std::vector<PointerOverWindow> BrowserWindowsAt(const gfx::PointF& at) {
  content::WebContents* shell = ShellContentsIn(nullptr);
  if (shell == nullptr) {
    return {};
  }
  content::RenderWidgetHostView* page = shell->GetRenderWidgetHostView();
  if (page == nullptr) {
    return {};
  }
  const gfx::PointF on_screen =
      at + gfx::Vector2dF(page->GetViewBounds().OffsetFromOrigin());
  return DeskWindows::For(
             Profile::FromBrowserContext(shell->GetBrowserContext()))
      .At(on_screen);
}

void BindBrowserWindows(content::RenderFrameHost* frame,
                        mojo::PendingReceiver<mojom::BrowserWindows> receiver) {
  // Owns itself and dies with the document, like every DocumentService.
  base::MakeSelfDeleting<BrowserWindowsService>(*frame, std::move(receiver));
}

}  // namespace domicile
