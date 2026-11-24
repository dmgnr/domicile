// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef COMPONENTS_DOMICILE_BROWSER_ELECTRON_APP_H_
#define COMPONENTS_DOMICILE_BROWSER_ELECTRON_APP_H_

#include <map>
#include <memory>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <vector>

#include "base/functional/callback.h"
#include "base/memory/raw_ref.h"
#include "base/memory/weak_ptr.h"
#include "base/types/expected.h"
#include "base/values.h"
#include "components/domicile/browser/browser_window_listing.h"
#include "components/domicile/browser/electron_network_calls.h"
#include "components/domicile/browser/electron_protocol.h"
#include "components/domicile/browser/electron_sign_ins.h"
#include "components/domicile/browser/web_view_partition.h"
#include "components/domicile/mojom/web_view_guest.mojom-shared.h"
#include "url/gurl.h"

namespace domicile {

// An ipcMain handler's answer to an invoke: its result, or why it failed.
using ElectronAnswer =
    base::OnceCallback<void(base::expected<base::Value, std::string>)>;

// What a window's page says to its app through its preload's ipcRenderer.
// A page's new window that its opener keeps a handle on, held unshown while
// the app decides: the desk adopts it as the app's window, and destroying it
// is the app saying no. //chrome makes them over the page's WebContents.
class ElectronHeldPage {
 public:
  virtual ~ElectronHeldPage() = default;
};

struct ElectronPageCalls {
  // ipcRenderer.send.
  base::RepeatingCallback<void(std::string channel, base::ListValue args)> sent;
  // ipcRenderer.invoke. The answer may come after the page is gone.
  base::RepeatingCallback<
      void(std::string channel, base::ListValue args, ElectronAnswer answer)>
      invoked;
  // ipcRenderer.sendSync: as invoked, while the page waits.
  base::RepeatingCallback<
      void(std::string channel, base::ListValue args, ElectronAnswer answer)>
      sent_sync;
  // ipcRenderer.postMessage, with the names of the page's ports that went.
  base::RepeatingCallback<void(std::string channel,
                               base::Value message,
                               std::vector<std::string> ports)>
      posted;
  // A message on one of the page's ports, and the page closing one.
  base::RepeatingCallback<void(std::string port, base::Value data)> port_posted;
  base::RepeatingCallback<void(std::string port)> port_closed;
  // A new document replaced the page, its ports and listeners with it.
  base::RepeatingClosure gone;
  // The shell gave the page a new size, in CSS pixels.
  base::RepeatingCallback<void(int width, int height)> resized;
  // The user clicked entry `command` of the window's menu bar.
  base::RepeatingCallback<void(int command)> menu_clicked;
  // The user asked to close the window, which closes only if the app closes
  // it, as an Electron window's `close` event can prevent it.
  base::RepeatingClosure close_asked;
  // The page asked for a new window, `details`: `held` is it, for one its
  // opener keeps a handle on, or null for one it doesn't (noopener, a middle
  // click), which opens at `details.url` if the app allows it.
  base::RepeatingCallback<void(ElectronWindowOpenDetails details,
                               std::unique_ptr<ElectronHeldPage> held)>
      window_opening;
  // What the page is now: its history, loading, focus and renderer.
  base::RepeatingCallback<void(ElectronPageState state)> state;
  // A find_in_page search is done.
  base::RepeatingCallback<void(ElectronFindResult result)> found;
  // The user asked for a context menu over the page, which the app draws if
  // it wants one, as the engine draws none.
  base::RepeatingCallback<void(ElectronContextMenu menu)> context_menu;
  // The shell made the window `state`; called only when that changes.
  base::RepeatingCallback<void(ElectronWindowState state)> window_state;
  // An event of the page's DevTools client, which page calls drive.
  base::RepeatingCallback<void(std::string method, base::DictValue params)>
      devtools_event;
  // What the page's frames did, which the app hears of as Electron's
  // navigation events: a navigation starting, redirected and committing, a
  // frame failing to load, a frame but the main frame finishing loading, and
  // a frame made.
  base::RepeatingCallback<void(ElectronNavigation navigation)>
      navigation_started;
  base::RepeatingCallback<void(ElectronNavigation navigation)>
      navigation_redirected;
  base::RepeatingCallback<void(ElectronNavigationCommit commit)>
      navigation_committed;
  base::RepeatingCallback<void(ElectronLoadFailure failure)> load_failed;
  base::RepeatingCallback<void(ElectronFrame frame)> frame_loaded;
  base::RepeatingCallback<void(ElectronFrame frame, bool main_frame)>
      frame_created;
  // The page navigates a frame itself, or a server redirects a navigation
  // (`redirect`): the app decides, and `answered` runs once with whether it
  // goes on.
  base::RepeatingCallback<void(ElectronNavigation navigation,
                               bool redirect,
                               base::OnceCallback<void(bool proceed)> answered)>
      will_navigate;
  // The page's `beforeunload` asked to stay: the app decides, and `answered`
  // runs once with whether the page leaves anyway.
  base::RepeatingCallback<void(base::OnceCallback<void(bool unload)> answered)>
      will_prevent_unload;
  // What else the app's webContents hears of its page: its console, its
  // sound, its input, and the rest of electron_page_reports.h.
  base::RepeatingCallback<void(ElectronPageReport report)> reported;
};

// A window's menu bar, as the desk lists it: the menu's entries as JSON
// (empty for none), whether the bar shows, and whether it hides until Alt.
struct ElectronDeskMenuBar {
  std::string menu;
  bool visible = true;
  bool auto_hide = false;

  friend bool operator==(const ElectronDeskMenuBar&,
                         const ElectronDeskMenuBar&) = default;
};

// A message box over a window, as the desk lists it: the box as JSON (see
// ElectronShowMessageBox), how many buttons it has, and the button that
// answers when the shell can't, as when the window closes first.
struct ElectronDeskMessageBox {
  std::string message_box;
  int buttons = 0;
  int cancel_id = 0;
};

// A popup menu over a window, as the desk lists it: the menu's entries as
// JSON (see ElectronMenuJson), and where the app asked for it, in CSS pixels
// from the page's top left. Without `x` and `y` it goes where the user last
// pressed in the page.
struct ElectronDeskPopupMenu {
  std::string menu;
  std::optional<int> x;
  std::optional<int> y;
};

// Where a window holds one of its views, as the desk lists it: the view's
// desk id and the app's bounds, in CSS pixels from the window page's top left.
struct ElectronDeskView {
  std::string id;
  int x = 0;
  int y = 0;
  int width = 0;
  int height = 0;
  bool hidden = false;

  friend bool operator==(const ElectronDeskView&,
                         const ElectronDeskView&) = default;
};

// Where a page's protocol request is answered: the loader that made it. The
// app calls Respond or Fail once; after a streamed Respond, Data until End.
// Destroying a responder that has not finished fails its request, as when
// the app goes.
class ElectronResponder {
 public:
  virtual ~ElectronResponder() = default;

  virtual void Respond(ElectronResponse response) = 0;
  // Why the app's handler failed, instead of a response.
  virtual void Fail(const std::string& why) = 0;
  // A piece of a streamed body.
  virtual void Data(std::string bytes) = 0;
  // A streamed body is complete, or broke off for `error`.
  virtual void End(const std::optional<std::string>& error) = 0;
};

class ElectronApp;

// What setPermissionRequestHandler is asked for a page's request for
// `permissions` from `origin`, which Chrome groups into one prompt: Electron's
// name for them. Nothing when Electron has no name for one, or groups them
// apart, and the shell is asked instead.
std::optional<ElectronPermissionDetails> ElectronPermissionFor(
    const std::vector<mojom::WebViewPermission>& permissions,
    const GURL& origin);

// What the app does to one of its pages' downloads, which
// electron_downloads.h implements over the DownloadItem.
class ElectronDownloadControl {
 public:
  virtual ~ElectronDownloadControl() = default;

  virtual void Pause() = 0;
  virtual void Resume() = 0;
  virtual void Cancel() = 0;
};

// Where a waiting request hears the app's answer to one of its webRequest
// events.
using ElectronWebRequestAnswered =
    base::OnceCallback<void(ElectronWebRequestAnswer)>;

// One of an app's sessions, as its pages' loaders see it: which schemes the
// app handles there, and the way to its handlers. Lives as long as its app.
class ElectronSession {
 public:
  ElectronSession(ElectronApp& app, std::string name);
  ElectronSession(const ElectronSession&) = delete;
  ElectronSession& operator=(const ElectronSession&) = delete;
  ~ElectronSession();

  // Whether the app handles `scheme`'s requests in this session.
  bool Handles(std::string_view scheme) const;
  // The schemes it handles that the network does not: file: and the app's
  // own, which a document needs a loader for before it asks.
  std::vector<std::string> LocalSchemes() const;
  // Asks the app's handler for `fetch`, a request in a scheme it handles.
  void Fetch(ElectronFetch fetch, std::unique_ptr<ElectronResponder> responder);

  // Whether the app has a webRequest listener for `event` in this session.
  bool ListensFor(ElectronWebRequestEvent event) const;
  // Whether it has any.
  bool ListensForWebRequests() const { return !web_request_events_.empty(); }
  // Asks the app's listener for `event`, one a request waits on, about a
  // request desk window `window`'s page made (nothing when no window's page
  // made it). `answered` runs once, with the answer or, when the app goes
  // first, with a cancel.
  void AskWebRequest(ElectronWebRequestEvent event,
                     const std::optional<std::string>& window,
                     ElectronWebRequestDetails details,
                     ElectronWebRequestAnswered answered);
  // Tells the app's listener of `event`, one nothing waits on.
  void TellWebRequest(ElectronWebRequestEvent event,
                      const std::optional<std::string>& window,
                      ElectronWebRequestDetails details);

  // Whether the app has a permission request handler in this session.
  bool HandlesPermissions() const { return handles_permissions_; }
  // Asks the app's handler about `details`, a request desk window `window`'s
  // page made. `answered` runs once, with the handler's answer or, when the
  // app goes first, with a denial.
  void AskPermission(const std::string& window,
                     ElectronPermissionDetails details,
                     base::OnceCallback<void(bool granted)> answered);

  // Asks the app's will-download where `details`, a download desk window
  // `window`'s page started, goes, and gives the app `control` of it.
  // `decided` runs once, with the app's answer or, when the app goes first,
  // with a cancel. Returns the number the app knows the download by.
  int AskDownload(const std::string& window,
                  const ElectronDownloadDetails& details,
                  base::WeakPtr<ElectronDownloadControl> control,
                  base::OnceCallback<void(ElectronDownloadAnswer)> decided);
  // Tells the app how download `download` goes: from its answer until the
  // download is done.
  void DownloadUpdated(int download, const ElectronDownloadProgress& progress);
  // Asks the app's `login` listeners about a sign-in a request in this
  // session needs, made by desk window `window`'s page (nothing when none
  // made it). `answered` runs once, with a cancel when the app goes first.
  void AskToSignIn(const std::optional<std::string>& window,
                   const ElectronLoginAsk& login,
                   ElectronSignInAsks::LoginAnswered answered);
  // Asks its `certificate-error` listeners whether to trust a certificate the
  // engine could not verify; a refusal when the app goes first.
  void AskAboutCertificateError(const std::string& window,
                                const ElectronCertificateErrorAsk& error,
                                ElectronSignInAsks::CertificateAnswered answered);
  // Asks its `select-client-certificate` listeners which of the offered
  // certificates to sign in with; none when the app goes first.
  void AskForClientCertificate(
      const std::optional<std::string>& window,
      const ElectronClientCertificateAsk& select,
      ElectronSignInAsks::ClientCertificateAnswered answered);

  // Tells the app's `preconnect` listeners that a page's resource hint
  // opened a connection to `url`.
  void TellPreconnect(const GURL& url, bool allow_credentials);

  // The user agent of the session's pages: session.setUserAgent's, else the
  // app's fallback; empty for the engine's.
  const std::string& user_agent() const;
  const std::string& name() const { return name_; }
  // What the app said of itself, which its pages are told. A session is made
  // only after the hello.
  const ElectronHello& hello() const;
  base::WeakPtr<ElectronSession> GetWeakPtr() {
    return weak_factory_.GetWeakPtr();
  }

 private:
  friend class ElectronApp;

  const raw_ref<ElectronApp> app_;
  const std::string name_;
  std::set<std::string> schemes_;
  std::set<ElectronWebRequestEvent> web_request_events_;
  bool handles_permissions_ = false;
  std::string user_agent_;
  base::WeakPtrFactory<ElectronSession> weak_factory_{this};
};

// A watch on a session's cookies, which ElectronDesk::WatchCookies starts.
// Destroying it ends the watch.
class ElectronCookieWatch {
 public:
  virtual ~ElectronCookieWatch() = default;
};

// What an Electron app's windows are on the desk: app windows, named by the
// desk's own window ids. //chrome implements it over its browser windows.
class ElectronDesk {
 public:
  virtual ~ElectronDesk() = default;

  // Opens an app window at `url` for app `app_id`, in `partition`, whose
  // pages run `preload` (none when empty) in a renderer told `arguments`,
  // make `calls` and load through
  // `session`. A `view` is a WebContentsView's page, listed only while a
  // window holds it. A window shows `title` instead of its page's when it
  // isn't empty, and opens `hidden` when asked. It loads as `user_agent`,
  // or as its session's when that is empty. With a `history`, the page opens
  // with it, at its entry `url`, instead of loading `url`. Returns its id, or
  // nothing when there is no shell to open it in.
  virtual std::optional<std::string> Open(
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
      const std::string& user_agent) = 0;
  // Makes `page`, a page's new window the app allowed, a window of app
  // `app_id`, as Open does with the rest. It stays in its opener's partition
  // and session. Returns its id, or nothing when there is no shell to show
  // it in.
  virtual std::optional<std::string> Adopt(
      std::unique_ptr<ElectronHeldPage> page,
      const std::string& app_id,
      const std::string& preload,
      const std::vector<std::string>& arguments,
      const std::optional<ElectronNode>& node,
      ElectronPageCalls calls,
      base::WeakPtr<ElectronSession> session,
      const std::string& title,
      bool hidden,
      const std::string& user_agent) = 0;
  // Window `id` holds `views`, bottom first, and no others. A view another
  // window held moves here.
  virtual void SetViews(const std::string& id,
                        std::vector<ElectronDeskView> views) = 0;
  // Window `id`'s menu bar, which the shell draws under its tab.
  virtual void SetMenuBar(const std::string& id, ElectronDeskMenuBar bar) = 0;
  // Asks `box` over window `id`, after any the window is already asking, and
  // runs `answered` with the button the user pressed and whether the checkbox
  // was left checked. A window that closes first answers its boxes with their
  // cancel buttons.
  virtual void ShowMessageBox(
      const std::string& id,
      ElectronDeskMessageBox box,
      base::OnceCallback<void(int response, bool checkbox_checked)>
          answered) = 0;
  // Shows `menu` over window `id`, in place of any it shows, which closes
  // with nothing chosen, and runs `closed` with the entry the user chose, or
  // 0 once it is put away: by the user, by ClosePopupMenu or by the window
  // closing.
  virtual void ShowPopupMenu(const std::string& id,
                             ElectronDeskPopupMenu menu,
                             base::OnceCallback<void(int command)> closed) = 0;
  // Puts away the popup menu window `id` shows, if it shows one.
  virtual void ClosePopupMenu(const std::string& id) = 0;
  virtual void Load(const std::string& id, const GURL& url) = 0;
  virtual void Focus(const std::string& id) = 0;
  // Shows entry `index` of window `id`'s page's history, if it has one.
  virtual void GoToIndex(const std::string& id, int index) = 0;
  // Forgets every entry of window `id`'s page's history but the one shown.
  virtual void ClearHistory(const std::string& id) = 0;
  // Forgets entry `index` of window `id`'s page's history, if it has one
  // and doesn't show it.
  virtual void RemoveHistoryEntry(const std::string& id, int index) = 0;
  // Does `command` at the focus in window `id`'s page.
  virtual void Edit(const std::string& id, ElectronEditCommand command) = 0;
  // Puts `text` in place of the word at the selection in window `id`'s page:
  // as a spelling correction, if `misspelling`.
  virtual void Replace(const std::string& id,
                       const std::string& text,
                       bool misspelling) = 0;
  // Searches window `id`'s page, which answers with its page calls' `found`.
  virtual void FindInPage(const std::string& id,
                          const ElectronFindInPage& find) = 0;
  // Ends window `id`'s page's search, doing `action` with its match.
  virtual void StopFindInPage(const std::string& id,
                              ElectronStopFindAction action) = 0;
  // The title the desktop shows for window `id`, over its page's.
  virtual void SetTitle(const std::string& id, const std::string& title) = 0;
  // Whether the desktop shows window `id`. A hidden window stays open, its
  // page running.
  virtual void SetHidden(const std::string& id, bool hidden) = 0;
  // The state the app asks for window `id`, listed for the shell, which
  // decides and says what it did through the page's window_state call.
  virtual void SetWindowState(const std::string& id,
                              ElectronWindowState state) = 0;
  // Closes window `id` once its page agrees.
  virtual void AskToClose(const std::string& id) = 0;
  // Closes window `id` without asking.
  virtual void Close(const std::string& id) = 0;
  // webContents.send: `args_json`, a JSON array, on `channel` to window
  // `id`'s page, for its preload's ipcRenderer.
  virtual void SendToPage(const std::string& id,
                          const std::string& channel,
                          const std::string& args_json) = 0;
  // webContents.executeJavaScript: runs `code` in the main world of window
  // `id`'s page, as if the user had acted when `user_gesture`, and runs
  // `done` once with what it gave, after a promise it gives settles, or why
  // it gave nothing, which a page that goes first is.
  virtual void ExecuteJavaScript(
      const std::string& id,
      const std::string& code,
      bool user_gesture,
      base::OnceCallback<void(base::expected<base::Value, std::string>)>
          done) = 0;
  // webContents.postMessage: `message_json` on `channel`, and a port in the
  // page for each of `ports`.
  virtual void PostToPage(const std::string& id,
                          const std::string& channel,
                          const std::string& message_json,
                          const std::vector<std::string>& ports) = 0;
  // `data_json` on port `port`, to its end in window `id`'s page.
  virtual void PostToPort(const std::string& id,
                          const std::string& port,
                          const std::string& data_json) = 0;
  // Closes port `port`'s end in window `id`'s page.
  virtual void ClosePort(const std::string& id, const std::string& port) = 0;
  // Window `id`'s page loads as `user_agent` from its next navigation on.
  virtual void SetUserAgent(const std::string& id,
                            const std::string& user_agent) = 0;
  // Carries `method` out on window `id`'s page, and runs `done` once with
  // what it gave, or why it gave nothing, which a page that goes first is.
  // See electron_page_call.h.
  virtual void CallPage(const std::string& id,
                        ElectronPageMethod method,
                        ElectronAnswer done) = 0;
  // Does `action` to window `id`'s page; see electron_page_reports.h. Returns
  // why the page refuses it, as for an answer to a question it never asked.
  // ElectronApp does set_page_user_agent itself, with SetUserAgent.
  virtual std::optional<std::string> AskPage(const std::string& id,
                                             ElectronPageAction action) = 0;

  // An app session's storage, in `partition`. Each runs `done` once, which
  // may be after the app has gone.
  //
  // The cookies a request to `url` would send, or every cookie without one.
  virtual void GetCookies(
      const WebViewPartition& partition,
      const std::optional<GURL>& url,
      base::OnceCallback<void(std::vector<ElectronCookie>)> done) = 0;
  // Sets a cookie, or says why it could not.
  virtual void SetCookie(
      const WebViewPartition& partition,
      const ElectronCookieDetails& details,
      base::OnceCallback<void(std::optional<std::string> why)> done) = 0;
  // Removes cookie `name` that a request to `url` would send.
  virtual void RemoveCookie(const WebViewPartition& partition,
                            const GURL& url,
                            const std::string& name,
                            base::OnceClosure done) = 0;
  // Writes the cookies to disk.
  virtual void FlushCookies(const WebViewPartition& partition,
                            base::OnceClosure done) = 0;
  // Calls `changed` with each change to the cookies until the watch is
  // destroyed.
  virtual std::unique_ptr<ElectronCookieWatch> WatchCookies(
      const WebViewPartition& partition,
      base::RepeatingCallback<void(const ElectronCookieChange& change)>
          changed) = 0;
  virtual void ClearStorage(const WebViewPartition& partition,
                            const ElectronClearStorage& clear,
                            base::OnceClosure done) = 0;
  // The HTTP cache.
  virtual void ClearCache(const WebViewPartition& partition,
                          base::OnceClosure done) = 0;
  // A call on the session's network or the rest of its storage
  // (electron_network_calls.h): its result, or why it failed.
  virtual void RunNetworkCall(
      const WebViewPartition& partition,
      const ElectronNetworkCall& call,
      base::OnceCallback<void(base::expected<base::Value, std::string>)>
          done) = 0;
  // Calls `changed` with each change to the session's service workers until
  // the watch is destroyed.
  virtual std::unique_ptr<ElectronServiceWorkerWatch> WatchServiceWorkers(
      const WebViewPartition& partition,
      base::RepeatingCallback<void(const ElectronServiceWorkerChange& change)>
          changed) = 0;
};

// One connection to the Electron socket: one running app. Turns its request
// lines into calls on the desk, and what happens to its windows into event
// lines. See electron_protocol.h. UI thread only.
class ElectronApp {
 public:
  using Send = base::RepeatingCallback<void(std::string line)>;

  // `engine` and `schemes`, the apps' own schemes the engine registered as it
  // started, are what hello's answer names.
  ElectronApp(ElectronDesk& desk,
              Send send,
              ElectronEngineInfo engine,
              std::vector<ElectronScheme> schemes = {});
  ElectronApp(const ElectronApp&) = delete;
  ElectronApp& operator=(const ElectronApp&) = delete;
  // Closes the app's windows: an app whose main process is gone cannot run
  // them.
  ~ElectronApp();

  // Answers one request line.
  void Take(std::string_view line);

  // Reports the app's windows that closed or changed title, from the desk's
  // whole list of browser windows.
  void Listed(const std::vector<ListedBrowserWindow>& listing);

  // Reports that window `id`'s page finished loading. Any other id is not
  // this app's.
  void Loaded(const std::string& id);
  // Reports that window `id`'s main frame's DOM is ready. Any other id is not
  // this app's.
  void DomReady(const std::string& id);

  // Reports that the engine loaded its dictionary for `language`, now or once
  // the app has said hello. Each language is reported once.
  void SpellcheckDictionaryInitialized(const std::string& language);
  // Reports that the engine learned more of its GPU, once the app has said
  // hello.
  void GpuInfoUpdated();

 private:
  friend class ElectronSession;

  struct Window {
    std::string id;
    std::string title;
    // Its session, by its Electron partition.
    std::string session;
    // A WebContentsView's page rather than a BrowserWindow.
    bool view = false;
    // Its webContents has a listener its navigations wait on.
    bool listens_for_navigation = false;

    // webContents.setUserAgent's, over its session's; empty for none.
    std::string user_agent;
  };

  // A page's protocol request, waiting on the app's handler.
  struct Pending {
    std::unique_ptr<ElectronResponder> responder;
    // Responded with a body that follows in pieces.
    bool streaming = false;
  };

  // A request waiting on the app's answer to one of its webRequest events.
  struct Ask {
    ElectronWebRequestEvent event;
    ElectronWebRequestAnswered answered;
  };

  // Session `name`, made the first time the app names it.
  ElectronSession& SessionNamed(const std::string& name);
  void HandleProtocol(const ElectronHandleProtocol& handle);
  void ListenForWebRequests(ElectronWebRequestListen listen);
  void SendWebRequest(const std::string& session,
                      ElectronWebRequestEvent event,
                      std::optional<int> ask,
                      const std::optional<std::string>& window,
                      const ElectronWebRequestDetails& details);
  void StartAsk(const std::string& session,
                ElectronWebRequestEvent event,
                const std::optional<std::string>& window,
                const ElectronWebRequestDetails& details,
                ElectronWebRequestAnswered answered);
  void Answer(ElectronWebRequestAnswer answer);
  void HandlePermissions(const ElectronPermissionHandler& handler);
  void StartPermissionAsk(const std::string& session,
                          const std::string& window,
                          const ElectronPermissionDetails& details,
                          base::OnceCallback<void(bool granted)> answered);
  void AnswerPermission(const ElectronPermissionAnswer& answer);
  int StartDownloadAsk(
      const std::string& session,
      const std::string& window,
      const ElectronDownloadDetails& details,
      base::WeakPtr<ElectronDownloadControl> control,
      base::OnceCallback<void(ElectronDownloadAnswer)> decided);
  void AnswerDownload(ElectronDownloadAnswer answer);
  void DownloadUpdated(int number, const ElectronDownloadProgress& progress);
  void ControlDownload(const ElectronDownloadControlCall& call);
  // The app's number for desk window `id`, if it is one of the app's.
  std::optional<ElectronWindow> NumberOf(const std::string& id) const;
  // A call on one of the app's sessions, answered with a session_result.
  void RunSessionCall(ElectronSessionCall call);
  void SessionCallDone(int call,
                       base::expected<base::Value, std::string> result);
  // A change to the cookies of session `session`, which the app watches.
  void CookieChanged(const std::string& session,
                     const ElectronCookieChange& change);
  void StartFetch(const std::string& session,
                  ElectronFetch fetch,
                  std::unique_ptr<ElectronResponder> responder);
  void Respond(ElectronProtocolResponse response);
  void ReceiveData(ElectronProtocolData data);
  void EndBody(const ElectronProtocolEnd& end);
  // Fails protocol request `request` for the app's bad line, `why`.
  void FailRequest(int request, const std::string& why);
  // Whether `url` opens in session `session`'s windows, or else refuses
  // window `number`'s request.
  bool Opens(ElectronWindow number,
             const std::string& session,
             const GURL& url);

  void Open(const ElectronOpenWindow& open);
  // What window `number`'s page calls the app with.
  ElectronPageCalls CallsFor(ElectronWindow number);
  // Window `number`'s page asked for a window: the app's handler decides.
  void PageWindowOpening(ElectronWindow number,
                         ElectronWindowOpenDetails details,
                         std::unique_ptr<ElectronHeldPage> held);
  void AnswerWindowOpen(ElectronWindowOpenAnswer answer);
  void Reply(ElectronReply reply);
  void PageSent(ElectronWindow number,
                std::string channel,
                base::ListValue args);
  // ipcRenderer.invoke and sendSync, which differ only in their event.
  void PageInvoked(ElectronWindow number,
                   bool sync,
                   std::string channel,
                   base::ListValue args,
                   ElectronAnswer answer);
  void PagePosted(ElectronWindow number,
                  std::string channel,
                  base::Value message,
                  std::vector<std::string> ports);
  void PagePortPosted(ElectronWindow number,
                      std::string port,
                      base::Value data);
  void PagePortClosed(ElectronWindow number, std::string port);
  void PageGone(ElectronWindow number);
  void PageResized(ElectronWindow number, int width, int height);
  void SetViews(const ElectronSetViews& set);
  void MenuClicked(ElectronWindow number, int command);
  void CloseAsked(ElectronWindow number);
  void PageStateChanged(ElectronWindow number, ElectronPageState state);
  void WindowStateChanged(ElectronWindow number, ElectronWindowState state);
  void PageFound(ElectronWindow number, ElectronFindResult result);
  // Sends `line`, of what window `number`'s page did, while it is open.
  void TellOfPage(ElectronWindow number, const std::string& line);
  void PageNavigationStarted(ElectronWindow number,
                             ElectronNavigation navigation);
  void PageNavigationRedirected(ElectronWindow number,
                                ElectronNavigation navigation);
  void PageNavigationCommitted(ElectronWindow number,
                               ElectronNavigationCommit commit);
  void PageLoadFailed(ElectronWindow number, ElectronLoadFailure failure);
  void PageFrameLoaded(ElectronWindow number, ElectronFrame frame);
  void PageFrameCreated(ElectronWindow number,
                        ElectronFrame frame,
                        bool main_frame);
  // Window `number`'s page asked whether a navigation goes on, or whether it
  // leaves though its `beforeunload` asked to stay: the app decides.
  void PageWillNavigate(ElectronWindow number,
                        ElectronNavigation navigation,
                        bool redirect,
                        base::OnceCallback<void(bool)> answered);
  void PageWillPreventUnload(ElectronWindow number,
                             base::OnceCallback<void(bool)> answered);
  void AnswerNavigation(const ElectronNavigationAnswer& answer);
  void AnswerUnload(const ElectronUnloadAnswer& answer);
  void PageContextMenu(ElectronWindow number, ElectronContextMenu menu);
  void CallPage(ElectronPageCall call);
  void PageDevToolsEvent(ElectronWindow number,
                         std::string method,
                         base::DictValue params);
  void PageReported(ElectronWindow number, ElectronPageReport report);
  // One of electron_page_reports.h's requests of a window's page.
  void AskPage(ElectronPageRequest request);
  void SetMenuBar(const ElectronSetMenuBar& bar);
  // The desk id of window `number` when it is a window, not a view, or
  // nothing after refusing `what` of a view.
  std::optional<std::string> WindowIdOf(ElectronWindow number,
                                        std::string_view what);
  void PopupMenu(const ElectronPopupMenu& popup);
  void ClosePopupMenu(const ElectronClosePopupMenu& close);
  void PopupMenuClosed(ElectronWindow number, int popup, int command);
  void ShowMessageBox(const ElectronShowMessageBox& box);
  void MessageBoxAnswered(ElectronWindow number,
                          int box,
                          int response,
                          bool checkbox_checked);
  // The desk id of window `number`, or nothing after refusing the request.
  std::optional<std::string> IdOf(ElectronWindow number);

  // Applies app.userAgentFallback to the sessions without their own.
  void SetUserAgentFallback(const ElectronSetUserAgentFallback& fallback);
  // service_workers_watch on `session`, in `partition`: answers `done` with
  // the workers running now. See electron_app_sign_ins.cc.
  void WatchServiceWorkers(
      const std::string& session,
      const WebViewPartition& partition,
      base::OnceCallback<void(base::expected<base::Value, std::string>)> done);
  void ServiceWorkerChanged(const std::string& session,
                            const ElectronServiceWorkerChange& change);
  // An answer to one of sign_ins_'s questions.
  void AnswerSignIn(const ElectronSignInReply& reply);

  const raw_ref<ElectronDesk> desk_;
  const Send send_;
  const ElectronEngineInfo engine_;
  const std::vector<ElectronScheme> schemes_;
  // app.userAgentFallback; empty leaves pages the engine's.
  std::string user_agent_fallback_;
  // Set by the app's hello.
  std::optional<ElectronHello> hello_;
  // The languages whose dictionaries the engine loaded.
  std::set<std::string> dictionaries_;
  // The app's open windows, by the numbers it gave them.
  std::map<ElectronWindow, Window> windows_;
  // The popup menu each window shows, by the app's number for it.
  std::map<ElectronWindow, int> popups_;
  // The pages' invokes waiting on the app's handlers, by number.
  std::map<int, ElectronAnswer> invokes_;
  int next_invoke_ = 1;
  // The app's sessions, by Electron partition, "" its own.
  std::map<std::string, std::unique_ptr<ElectronSession>> sessions_;
  // The sessions whose cookies the app watches (cookies_watch), by partition.
  std::map<std::string, std::unique_ptr<ElectronCookieWatch>> cookie_watches_;
  // The pages' protocol requests waiting on the app, by number.
  std::map<int, Pending> fetches_;
  int next_fetch_ = 1;
  // The requests waiting on the app's webRequest listeners, by ask.
  std::map<int, Ask> asks_;
  int next_ask_ = 1;
  // The pages' permission requests waiting on the app's handlers, by ask.
  std::map<int, base::OnceCallback<void(bool granted)>> permission_asks_;
  int next_permission_ask_ = 1;
  // The pages' downloads, by the numbers the app knows them by.
  struct Download {
    // Runs with the app's answer; null once it has.
    base::OnceCallback<void(ElectronDownloadAnswer)> decided;
    // Null once the download is gone.
    base::WeakPtr<ElectronDownloadControl> control;
    // The app heard it is done.
    bool done = false;
  };
  std::map<int, Download> downloads_;
  int next_download_ = 1;
  // The pages' new windows waiting on the app's window open handlers, by ask.
  struct WindowOpenAsk {
    // The page that asked: its session is the held window's.
    ElectronWindow opener;
    GURL url;
    std::unique_ptr<ElectronHeldPage> held;
  };
  std::map<int, WindowOpenAsk> window_open_asks_;
  int next_window_open_ask_ = 1;
  // The pages' navigations waiting on the app's will-navigate listeners, and
  // their `beforeunload`s on its will-prevent-unload ones, by ask.
  std::map<int, base::OnceCallback<void(bool proceed)>> navigation_asks_;
  int next_navigation_ask_ = 1;
  std::map<int, base::OnceCallback<void(bool unload)>> unload_asks_;
  int next_unload_ask_ = 1;
  // The sessions whose service workers the app watches, by partition.
  std::map<std::string, std::unique_ptr<ElectronServiceWorkerWatch>>
      service_worker_watches_;
  // The pages' sign-in and certificate questions waiting on the app.
  ElectronSignInAsks sign_ins_;
  base::WeakPtrFactory<ElectronApp> weak_factory_{this};
};

}  // namespace domicile

#endif  // COMPONENTS_DOMICILE_BROWSER_ELECTRON_APP_H_
