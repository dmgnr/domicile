// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "chrome/browser/domicile/domicile_browser_windows.h"

#include <algorithm>
#include <memory>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "base/check.h"
#include "base/functional/bind.h"
#include "base/functional/callback.h"
#include "base/functional/callback_helpers.h"
#include "base/functional/function_ref.h"
#include "base/location.h"
#include "base/logging.h"
#include "base/memory/raw_ptr.h"
#include "base/memory/self_deleting.h"
#include "base/memory/weak_ptr.h"
#include "base/no_destructor.h"
#include "base/observer_list.h"
#include "base/observer_list_types.h"
#include "base/scoped_observation.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/utf_string_conversions.h"
#include "base/supports_user_data.h"
#include "base/task/sequenced_task_runner.h"
#include "base/time/time.h"
#include "base/types/expected.h"
#include "chrome/browser/domicile/domicile_tab_helpers.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/profiles/profile_destroyer.h"
#include "chrome/browser/profiles/profile_observer.h"
#include "chrome/browser/ui/browser_window/public/browser_collection.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/browser_window/public/global_browser_collection.h"
#include "components/domicile/browser/browser_window_capture_target.h"
#include "components/domicile/browser/browser_window_listing.h"
#include "components/domicile/browser/notification_window.h"
#include "components/domicile/browser/private_pages.h"
#include "components/domicile/browser/web_view_guest.h"
#include "components/domicile/browser/web_view_partition.h"
#include "components/domicile/common/domicile_scheme.h"
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
#include "ui/gfx/geometry/point_f.h"
#include "ui/gfx/geometry/rect.h"
#include "ui/gfx/geometry/rect_f.h"
#include "ui/gfx/geometry/size.h"
#include "ui/gfx/geometry/vector2d_f.h"
#include "url/gurl.h"

namespace domicile {
namespace {

constexpr char kWindowsUserDataKey[] = "domicile_browser_windows";

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

  explicit DeskWindows(Profile* profile)
      : profile_(profile),
        private_pages_(base::BindRepeating(&DeskWindows::EndPrivateProfile,
                                           base::Unretained(this))) {
    profile_observation_.Observe(profile);
  }
  DeskWindows(const DeskWindows&) = delete;
  DeskWindows& operator=(const DeskWindows&) = delete;
  ~DeskWindows() override { ListBrowserWindows(this, {}); }

  // Opens a window at `url` as a tab of the desk's own window, or a private
  // window in the off-the-record profile, in `partition` when there is one.
  // Returns it, or null when the profile has no shell to own it.
  WebViewGuest* Open(const GURL& url,
                     bool private_browsing,
                     const std::optional<WebViewPartition>& partition) {
    return Make([&](WebViewGuest& guest) { guest.Navigate(url); },
                /*popup_window=*/std::nullopt, 0, 0, private_browsing,
                /*app=*/false, partition);
  }

  // Opens a window with a copy of `source`'s history and takes `step` there,
  // private when `private_browsing`. Returns false and opens nothing when the
  // profile has no shell to own it.
  bool OpenHistoryStep(WebViewGuest& source,
                       HistoryStep step,
                       bool private_browsing,
                       const std::optional<WebViewPartition>& partition) {
    return Make(
        [&](WebViewGuest& guest) { guest.TakeHistoryStep(source, step); },
        /*popup_window=*/std::nullopt, 0, 0, private_browsing,
        /*app=*/false, partition) != nullptr;
  }

  // Opens an app window at `url`: a window of the desk's own window that the
  // shell draws without an address bar. Its page's new windows are browser
  // windows, as a link out of a Chrome app opens in the browser.
  //
  // With an `app_id` and a `reuse` other than kNew, reuses the oldest open app
  // window with that id instead; see mojom::BrowserWindows.OpenApp.
  bool OpenApp(const GURL& url,
               const std::string& app_id,
               mojom::AppReuse reuse) {
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
                /*private_browsing=*/false, /*app=*/true,
                /*partition=*/std::nullopt, /*app_host=*/std::string(),
                app_id) != nullptr;
  }

  // Opens an app window at an app module's `url`, pinned to `app_host`. See
  // WebViewGuest::PinToApp.
  bool OpenAppModule(const GURL& url, const std::string& app_host) {
    return Make([&](WebViewGuest& guest) { guest.Navigate(url); },
                /*popup_window=*/std::nullopt, 0, 0,
                /*private_browsing=*/false, /*app=*/true,
                /*partition=*/std::nullopt, app_host) != nullptr;
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
    const std::string id = guest->window_id();
    auto watch = std::make_unique<Watch>(
        guest->contents(),
        base::BindRepeating(&DeskWindows::Changed, base::Unretained(this)));
    windows_.push_back(Window{
        id, std::move(guest), std::move(watch), size.width(), size.height(),
        /*app=*/false, /*app_id=*/std::string(), target_url});
    Changed();
  }

  // Opens a window at `url` as popup window `window_id`'s one tab.
  bool OpenPopupWindow(int window_id, const GURL& url, int width, int height) {
    return Make([&](WebViewGuest& guest) { guest.Navigate(url); }, window_id,
                width, height, /*private_browsing=*/false,
                /*app=*/false, /*partition=*/std::nullopt) != nullptr;
  }

  // The off-the-record profile a new private page lives in, made on first
  // use. Watched, so its windows close before it is destroyed.
  Profile& PrivateProfile() {
    if (ending_private_profile_) {
      // Still waiting on its renderers. A page made in it would be destroyed
      // with it, so finish it now and start a new one.
      ProfileDestroyer::DestroyOTRProfileImmediately(
          ending_private_profile_.get());
    }
    Profile* otr = profile_->GetPrimaryOTRProfile(/*create_if_needed=*/true);
    if (!private_observation_.IsObserving()) {
      private_observation_.Observe(otr);
    }
    return *otr;
  }

  void PrivatePageOpened() { private_pages_.Opened(); }
  void PrivatePageClosed() { private_pages_.Closed(); }

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
    closing_.push_back({id, std::move(found->guest)});
    base::SequencedTaskRunner::GetCurrentDefault()->PostDelayedTask(
        FROM_HERE,
        base::BindOnce(&DeskWindows::Reap, weak_factory_.GetWeakPtr(),
                       closing_.back().id),
        kLinger);
    windows_.erase(found);
    LOG(INFO) << "domicile: closed browser window " << id << ".";
    Changed();
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

  // The whole list, as sent to the shell.
  std::vector<mojom::BrowserWindowPtr> List() const {
    std::vector<mojom::BrowserWindowPtr> list;
    for (const Window& window : windows_) {
      content::WebContents& contents = window.guest->contents();
      content::NavigationEntry* entry =
          contents.GetController().GetVisibleEntry();
      // A page's new window has only its initial entry until its first
      // navigation commits.
      const bool navigated = entry != nullptr && !entry->IsInitialEntry();
      const std::optional<WebViewPartition> partition =
          window.guest->partition();
      list.push_back(mojom::BrowserWindow::New(
          window.id, navigated ? entry->GetVirtualURL() : window.opened_at,
          base::UTF16ToUTF8(contents.GetTitle()),
          window.guest->popup_window().value_or(0), window.width,
          window.height, contents.GetBrowserContext()->IsOffTheRecord(),
          partition.has_value() ? WebViewPartitionAttribute(*partition)
                                : std::string(),
          window.app, window.app_id, window.captures > 0));
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
  // Reports a change to a page's address or title.
  class Watch final : public content::WebContentsObserver {
   public:
    Watch(content::WebContents& contents, base::RepeatingClosure changed)
        : WebContentsObserver(&contents), changed_(std::move(changed)) {}

    void TitleWasSet(content::NavigationEntry* entry) override {
      changed_.Run();
    }
    void DidFinishNavigation(content::NavigationHandle* navigation) override {
      if (navigation->IsInPrimaryMainFrame()) {
        changed_.Run();
      }
    }

   private:
    base::RepeatingClosure changed_;
  };

  struct Window {
    std::string id;
    std::unique_ptr<WebViewGuest> guest;
    std::unique_ptr<Watch> watch;
    int width = 0;
    int height = 0;
    bool app = false;
    // The id OpenApp was given; empty for none.
    std::string app_id;
    // For a window a page opened, the address content navigates it to. Listed
    // until its first navigation commits, since content lists it first.
    GURL opened_at;
    // The captures of its page running; see Capture.
    int captures = 0;
  };

  // Makes a window and gives it its first page with `load`. Returns it, or
  // null when the profile has no shell to own it.
  WebViewGuest* Make(base::FunctionRef<void(WebViewGuest&)> load,
            std::optional<int> popup_window,
            int width,
            int height,
            bool private_browsing,
            bool app,
            const std::optional<WebViewPartition>& partition,
            const std::string& app_host = std::string(),
            const std::string& app_id = std::string()) {
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
        *shell, id, popup_window, private_browsing, partition,
        base::BindRepeating(app ? &AttachAppTabHelpers : &AttachTabHelpers));
    // `windows_` owns `guest` and the watch from here.
    auto watch = std::make_unique<Watch>(
        guest->contents(),
        base::BindRepeating(&DeskWindows::Changed, base::Unretained(this)));
    if (!app_host.empty()) {
      guest->PinToApp(app_host);
    }
    load(*guest);
    WebViewGuest* made = guest.get();
    windows_.push_back(Window{id, std::move(guest), std::move(watch), width,
                              height, app, app_id});
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

  // Ends private browsing once the last private page closes: its cookies,
  // cache and storage go with the off-the-record profile.
  void EndPrivateProfile() {
    // The original profile's destruction takes the off-the-record one with
    // it.
    if (!profile_observation_.IsObserving()) {
      return;
    }
    Profile* otr = profile_->GetPrimaryOTRProfile(/*create_if_needed=*/false);
    // Null when it was destroyed first, which closed the last page.
    if (otr != nullptr) {
      LOG(INFO) << "domicile: ended private browsing.";
      ending_private_profile_ = otr->GetWeakPtr();
      ProfileDestroyer::DestroyOTRProfileWhenAppropriate(otr);
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

  // The windows as a capture tool lists them.
  std::vector<ListedBrowserWindow> Listing() const {
    std::vector<ListedBrowserWindow> listing;
    for (const Window& window : windows_) {
      listing.push_back(ListedBrowserWindow{
          .id = window.id,
          .title = base::UTF16ToUTF8(window.guest->contents().GetTitle()),
          .app_id = window.app_id});
    }
    return listing;
  }

  // ProfileObserver:
  void OnProfileWillBeDestroyed(Profile* profile) override {
    if (profile->IsOffTheRecord()) {
      // Only the private windows, which would otherwise outlive their
      // profile.
      private_observation_.Reset();
      std::erase_if(windows_, [](const Window& window) {
        return window.guest->contents().GetBrowserContext()->IsOffTheRecord();
      });
      std::erase_if(closing_, [](const Closing& closing) {
        return closing.guest->contents().GetBrowserContext()->IsOffTheRecord();
      });
      Changed();
      return;
    }
    profile_observation_.Reset();
    private_observation_.Reset();
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
  // The off-the-record profile, once PrivateProfile made it.
  base::ScopedObservation<Profile, ProfileObserver> private_observation_{this};
  PrivatePages private_pages_;
  // The off-the-record profile EndPrivateProfile is destroying, until it is.
  base::WeakPtr<Profile> ending_private_profile_;

  base::WeakPtrFactory<DeskWindows> weak_factory_{this};
};

// WebViewGuest's host. Routes each call to the desk of the guest's profile,
// which for a private guest is its original profile's.
class Host final : public BrowserWindowHost {
 public:
  // A private page's new window is private too.
  WebViewGuest* Open(
      content::BrowserContext& context,
      const GURL& url,
      const std::optional<WebViewPartition>& partition) override {
    return Windows(context).Open(url, context.IsOffTheRecord(), partition);
  }

  // As Open, in `source`'s context and partition.
  void OpenHistoryStep(WebViewGuest& source, HistoryStep step) override {
    content::BrowserContext& context = *source.contents().GetBrowserContext();
    Windows(context).OpenHistoryStep(source, step, context.IsOffTheRecord(),
                                     source.partition());
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
    Windows(context).OpenPopupWindow(window_id, url, width, height);
  }

  void Close(content::BrowserContext& context, const std::string& id) override {
    Windows(context).Close(id);
  }

  WebViewGuest* Find(content::BrowserContext& context,
                     const std::string& id) override {
    return Windows(context).Find(id);
  }

  content::BrowserContext& PrivateContext(
      content::BrowserContext& context) override {
    return Windows(context).PrivateProfile();
  }

  void PrivatePageOpened(content::BrowserContext& context) override {
    Windows(context).PrivatePageOpened();
  }

  void PrivatePageClosed(content::BrowserContext& context) override {
    Windows(context).PrivatePageClosed();
  }

 private:
  static DeskWindows& Windows(content::BrowserContext& context) {
    return DeskWindows::For(
        Profile::FromBrowserContext(&context)->GetOriginalProfile());
  }
};

// The list for one shell document. A DocumentService like ExtensionTray, so a
// reloaded shell binds a new one and gets the list again.
class BrowserWindowsService final
    : public content::DocumentService<mojom::BrowserWindows>,
      public DeskWindows::Observer {
 public:
  BrowserWindowsService(content::RenderFrameHost& frame,
                        mojo::PendingReceiver<mojom::BrowserWindows> receiver,
                        base::SelfDeletingPassKey key)
      : DocumentService(frame, std::move(receiver), key),
        windows_(&DeskWindows::For(
            Profile::FromBrowserContext(frame.GetBrowserContext()))) {
    windows_->AddObserver(this);
  }

 private:
  ~BrowserWindowsService() override { windows_->RemoveObserver(this); }

  // mojom::BrowserWindows:
  void SetClient(
      mojo::PendingRemote<mojom::BrowserWindowsClient> client) override {
    if (client_.is_bound()) {
      ReportBadMessageAndDeleteThis(
          "domicile: the browser windows have one client per document.");
      return;
    }
    client_.Bind(std::move(client));
    OnWindowsChanged();
  }

  void Open(const GURL& url,
            bool private_browsing,
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
    windows_->Open(url, private_browsing, *parsed);
  }

  void OpenApp(const GURL& url,
               const std::string& app_id,
               mojom::AppReuse reuse) override {
    windows_->OpenApp(url, app_id, reuse);
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

  void Close(const std::string& id) override { windows_->AskToClose(id); }

  // DeskWindows::Observer:
  void OnWindowsChanged() override {
    if (client_.is_bound()) {
      client_->WindowsChanged(windows_->List());
    }
  }

  // Owned by the profile, which outlives every document in it.
  const raw_ptr<DeskWindows> windows_;
  mojo::Remote<mojom::BrowserWindowsClient> client_;
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

bool OpenBrowserWindow(const GURL& url) {
  content::WebContents* shell = ShellContentsIn(nullptr);
  if (shell == nullptr) {
    return false;
  }
  return DeskWindows::For(
             Profile::FromBrowserContext(shell->GetBrowserContext()))
             .Open(url, /*private_browsing=*/false,
                   /*partition=*/std::nullopt) != nullptr;
}

bool OpenAppWindow(const GURL& url,
                   const std::string& app_id,
                   mojom::AppReuse reuse) {
  content::WebContents* shell = ShellContentsIn(nullptr);
  if (shell == nullptr) {
    return false;
  }
  return DeskWindows::For(
             Profile::FromBrowserContext(shell->GetBrowserContext()))
      .OpenApp(url, app_id, reuse);
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
