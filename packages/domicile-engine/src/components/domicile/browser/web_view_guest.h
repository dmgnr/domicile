// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef COMPONENTS_DOMICILE_BROWSER_WEB_VIEW_GUEST_H_
#define COMPONENTS_DOMICILE_BROWSER_WEB_VIEW_GUEST_H_

#include <cstdint>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "base/callback_list.h"
#include "base/files/file_path.h"
#include "base/functional/callback.h"
#include "base/memory/raw_ptr.h"
#include "base/memory/weak_ptr.h"
#include "base/scoped_observation.h"
#include "base/timer/timer.h"
#include "base/types/expected.h"
#include "base/values.h"
#include "components/content_settings/core/browser/content_settings_observer.h"
#include "components/content_settings/core/browser/host_content_settings_map.h"
#include "components/domicile/browser/guest_dialogs.h"
#include "components/domicile/browser/screen_choice.h"
#include "components/domicile/browser/web_view_partition.h"
#include "components/domicile/mojom/web_view_guest.mojom.h"
#include "components/input/native_web_keyboard_event.h"
#include "content/public/browser/browser_plugin_guest_delegate.h"
#include "content/public/browser/context_menu_params.h"
#include "content/public/browser/download_manager.h"
#include "content/public/browser/file_select_listener.h"
#include "content/public/browser/global_routing_id.h"
#include "content/public/browser/host_zoom_map.h"
#include "content/public/browser/invalidate_type.h"
#include "content/public/browser/javascript_dialog_manager.h"
#include "content/public/browser/keyboard_event_processing_result.h"
#include "content/public/browser/media_stream_request.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/weak_document_ptr.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_contents_delegate.h"
#include "content/public/browser/web_contents_observer.h"
#include "mojo/public/cpp/bindings/pending_receiver.h"
#include "mojo/public/cpp/bindings/pending_remote.h"
#include "mojo/public/cpp/bindings/receiver.h"
#include "mojo/public/cpp/bindings/receiver_set.h"
#include "mojo/public/cpp/bindings/remote.h"
#include "third_party/blink/public/common/input/web_mouse_event.h"
#include "third_party/blink/public/common/tokens/tokens.h"
#include "third_party/blink/public/mojom/choosers/file_chooser.mojom-forward.h"
#include "third_party/blink/public/mojom/favicon/favicon_url.mojom-forward.h"
#include "third_party/blink/public/mojom/mediastream/media_stream.mojom-shared.h"
#include "ui/gfx/geometry/point.h"
#include "ui/gfx/geometry/rect.h"
#include "ui/gfx/geometry/size.h"
#include "url/gurl.h"
#include "url/origin.h"

namespace content {
class BrowserContext;
}  // namespace content

namespace domicile {

// Called on a new guest's WebContents before it is attached, so //chrome can
// add its tab helpers. A callback because this target must not depend on
// //chrome. See //chrome/browser/domicile/domicile_tab_helpers.h.
using GuestCreatedCallback =
    base::RepeatingCallback<void(content::WebContents&)>;

class WebViewGuest;

// A step through a guest's history.
enum class HistoryStep { kBack, kForward };

// Holds the desk's browser windows, one per profile. Implemented in //chrome
// (//chrome/browser/domicile/domicile_browser_windows.h) because a window's
// page is a tab, and tab helpers live in //chrome.
//
// //chrome sets it once, with SetBrowserWindowHost, before any shell can bind
// a WebViewGuestHost.
class BrowserWindowHost {
 public:
  virtual ~BrowserWindowHost() = default;

  // Opens a browser window at `url` in `context`'s desk and `partition`, for a
  // page's new window or an extension's tabs.create. Returns it, or null when
  // there is no shell to own it.
  virtual WebViewGuest* Open(
      content::BrowserContext& context,
      const GURL& url,
      const std::optional<WebViewPartition>& partition) = 0;

  // Opens a browser window with a copy of `source`'s history, in its context
  // and partition, and takes `step` there. See
  // mojom::WebViewGuest.GoBackInNewWindow.
  virtual void OpenHistoryStep(WebViewGuest& source, HistoryStep step) = 0;

  // Makes a browser window for a page's `window.open()` or `target="_blank"`
  // from content's `params`, which name the opener and the window. Content
  // holds the page until it shows it with AdoptOpenedWindow.
  virtual std::unique_ptr<content::WebContents> MakeOpenedWindow(
      const content::WebContents::CreateParams& params) = 0;

  // Lists the window MakeOpenedWindow made, now that content shows it.
  // `target_url` is the address content navigates it to next; the list shows
  // it until the window's first navigation. `size` is the size the page asked
  // for, empty on an axis it left unset.
  virtual void AdoptOpenedWindow(std::unique_ptr<content::WebContents> contents,
                                 const GURL& target_url,
                                 const gfx::Size& size) = 0;

  // Opens popup window `window_id`'s one tab at `url`, for an extension's
  // chrome.windows.create. `width` and `height` are the requested size, or 0.
  virtual void OpenPopupWindow(content::BrowserContext& context,
                               int window_id,
                               const GURL& url,
                               int width,
                               int height) = 0;

  // Closes window `id`. The list updates immediately and the page is
  // destroyed on a later task, since the caller is usually that window's own
  // WebContents.
  virtual void Close(content::BrowserContext& context,
                     const std::string& id) = 0;

  // Returns window `id` in `context`, or null.
  virtual WebViewGuest* Find(content::BrowserContext& context,
                             const std::string& id) = 0;

  // Returns the off-the-record context of `context`'s profile, making it on
  // first use. Private guests' pages live there.
  virtual content::BrowserContext& PrivateContext(
      content::BrowserContext& context) = 0;

  // A private guest's page was made in, or destroyed from, `context`, an
  // off-the-record context. Private browsing ends when every page made has
  // been destroyed.
  virtual void PrivatePageOpened(content::BrowserContext& context) = 0;
  virtual void PrivatePageClosed(content::BrowserContext& context) = 0;
};

// Opens DevTools on `frame`'s page, at `root_point` (a context menu's click,
// in root view coordinates) when given. Provided by //chrome, which owns the
// DevTools front end: see //chrome/browser/domicile/domicile_devtools.h.
using InspectCallback =
    base::RepeatingCallback<void(content::RenderFrameHost& frame,
                                 std::optional<gfx::Point> root_point)>;

// Prints `guest`'s page through the desktop's print dialog. Provided by
// //chrome, which owns printing: see
// //chrome/browser/domicile/domicile_printing.h.
using PrintCallback =
    base::RepeatingCallback<void(content::WebContents& guest)>;

// Answers a guest page's camera and microphone requests. Implemented in
// //chrome (//chrome/browser/domicile/domicile_permissions.h), whose
// MediaCaptureDevicesDispatcher asks through the guest's permission prompt.
//
// //chrome sets it once, with SetMediaAccess, before any guest exists.
class MediaAccess {
 public:
  virtual ~MediaAccess() = default;

  // As WebContentsDelegate::RequestMediaAccessPermission.
  virtual void Request(content::WebContents& contents,
                       const content::MediaStreamRequest& request,
                       content::MediaResponseCallback callback) = 0;

  // As WebContentsDelegate::CheckMediaAccessPermission.
  virtual bool Check(content::RenderFrameHost& frame,
                     const url::Origin& origin,
                     blink::mojom::MediaStreamType type) = 0;

  // The cameras and microphones, ranked by `context`'s profile's preference.
  virtual mojom::WebViewMediaDevicesPtr ListDevices(
      content::BrowserContext& context) = 0;

  // Ranks device `id` first among `kind`'s for `context`'s profile, or says
  // why not.
  virtual base::expected<void, std::string> PreferDevice(
      content::BrowserContext& context,
      mojom::WebViewMediaDeviceKind kind,
      const std::string& id) = 0;
};

// The page behind a <webview>: an inner WebContents attached as a guest.
//
// Like components/guest_view's GuestViewBase, but without depending on
// //extensions or //components/guest_view.
//
//   BrowserPluginGuestDelegate  makes the inner WebContents a guest, with a
//                               WebContentsViewChildFrame and no platform
//                               window
//   WebContentsDelegate         handles what the page asks of its embedder
//                               (new windows, dialogs, permissions)
//   JavaScriptDialogManager     sends `alert()`, `confirm()` and `prompt()`
//                               to the shell
//   WebContentsObserver         tracks the guest's lifetime; after
//                               attaching, this object is deleted with it
//   content_settings::Observer  reports the page's site permissions when a
//                               setting changes
//   DownloadManager::Observer   lists the page's downloads on the desk
//
// A guest, not a subframe, so the page is a main frame: X-Frame-Options and
// CSP frame-ancestors pass, history works across process changes, and storage
// is first-party. `guard-webview-framing.sh` checks this.
//
// Constraints:
// - There is no guest manager, so `ProfileImpl::GetGuestManager()` returns
//   null. Content code that assumes a guest implies a manager can crash; patch
//   0037 fixes BrowserPluginEmbedder. See
//   `upstream/browser-plugin-embedder-null-guest-manager.md`.
// - Uses AttachInnerWebContents, not AttachGuestPage, which requires
//   features::kGuestViewMPArch (disabled at our pin).
// - No guest SiteInstance unless the element names a `partition`: a guest
//   SiteInstance requires a separate StoragePartition, which would log the
//   user out of every site. Patch 0115 lets WebContentsImpl::CreateNewWindow
//   make a guest's new window without one, through CreateNewGuestWindow.
class WebViewGuest : public mojom::WebViewGuest,
                     public content::BrowserPluginGuestDelegate,
                     public content::WebContentsDelegate,
                     public content::JavaScriptDialogManager,
                     public content::WebContentsObserver,
                     public content_settings::Observer,
                     public content::DownloadManager::Observer,
                     public mojom::PagePicker {
 public:
  // Creates a guest for `placeholder`, a child frame of `owner`, and starts
  // attaching it. The attach replaces and destroys `placeholder`; a refused
  // attach destroys the guest.
  //
  // `created` runs once, before the guest is attached or navigated, so tab
  // helpers see the first navigation. `extension_popup`: see
  // extension_popup(). `private_browsing` makes the page in
  // BrowserWindowHost::PrivateContext rather than the owner's context.
  // `partition` gives it storage of its own; see partition().
  static void CreateAndAttach(
      content::RenderFrameHost& owner,
      content::RenderFrameHost& placeholder,
      mojo::PendingReceiver<mojom::WebViewGuest> receiver,
      mojo::PendingRemote<mojom::WebViewGuestClient> client,
      bool extension_popup,
      bool private_browsing,
      const std::optional<WebViewPartition>& partition,
      const GuestCreatedCallback& created);

  // Makes a browser window's page, owned by BrowserWindowHost's
  // implementation. See components/domicile/mojom/browser_windows.mojom.
  //
  // A guest needs an owner WebContents from creation, so this uses `shell`.
  // A shell reload keeps the same WebContents.
  //
  // - `window_id`: the id a <webview window> uses.
  // - `popup_window`: the chrome.windows popup window whose one tab this is;
  //   empty for a tab of the desk's window. See popup_window().
  // - `private_browsing`, `partition`: as in CreateAndAttach.
  // - `created`: runs before the first navigation, as in CreateAndAttach.
  //
  // The caller navigates it with Navigate.
  static std::unique_ptr<WebViewGuest> MakeWindow(
      content::WebContents& shell,
      const std::string& window_id,
      std::optional<int> popup_window,
      bool private_browsing,
      const std::optional<WebViewPartition>& partition,
      const GuestCreatedCallback& created);

  // Makes the page of browser window `window_id` from content's `params`, for
  // a page's `window.open()`, and returns it for content to hold. See
  // BrowserWindowHost::MakeOpenedWindow.
  //
  // The guest owns itself until AdoptOpenedWindow, so a page content drops
  // unshown, such as one whose opener closed first, takes its guest with it.
  static std::unique_ptr<content::WebContents> MakeOpenedWindow(
      content::WebContents& shell,
      const std::string& window_id,
      const content::WebContents::CreateParams& params,
      const GuestCreatedCallback& created);

  // Takes back a page MakeOpenedWindow made, once content shows it, and
  // returns its guest, which owns it from here as MakeWindow's does.
  static std::unique_ptr<WebViewGuest> AdoptOpenedWindow(
      std::unique_ptr<content::WebContents> contents);

  // Shows this window in `placeholder`, the <webview window> frame under
  // `owner`, and binds the element's pipes to it.
  //
  // Refused (pipes dropped, logged) if another element already shows the
  // window. When the frame goes away, content detaches the page without
  // destroying it, so browser windows survive a shell reload.
  void AttachToElement(content::RenderFrameHost& owner,
                       content::RenderFrameHost& placeholder,
                       mojo::PendingReceiver<mojom::WebViewGuest> receiver,
                       mojo::PendingRemote<mojom::WebViewGuestClient> client);

  // Set once by //chrome, before any guest exists. See BrowserWindowHost.
  static void SetBrowserWindowHost(BrowserWindowHost* host);

  // Set once by //chrome, before any guest exists. Runs for Inspect and a
  // menu's kInspect. See InspectCallback.
  static void SetInspect(InspectCallback inspect);

  // Set once by //chrome, before any guest exists. Runs for Print. See
  // PrintCallback.
  static void SetPrint(PrintCallback print);

  // Set once by //chrome, before any guest exists. See MediaAccess.
  static void SetMediaAccess(MediaAccess* access);

  // The id a <webview window> uses for this window. Empty for a shell's own
  // page.
  const std::string& window_id() const { return window_id_; }

  // Pins this window to the app module at `app_host`, the only domicile://
  // address it may then show, and which may bind an app channel in it. Set
  // once, before the first navigation. See
  // docs/architecture/APP-MODULES.md.
  void PinToApp(const std::string& app_host);

  // The app host this window is pinned to, or empty for any other window.
  const std::string& app_host() const { return app_host_; }

  // This guest's WebContents. Lives as long as the guest.
  content::WebContents& contents() const { return *guest_contents_; }

  // Gives a new window's page a copy of `source`'s history and takes `step`
  // there, as Chrome's middle-clicked back button does with a cloned tab. In
  // place of the first Navigate. See BrowserWindowHost::OpenHistoryStep.
  void TakeHistoryStep(WebViewGuest& source, HistoryStep step);

  // The storage partition the page was made in, or nothing for its profile's
  // own. A partitioned page has a guest SiteInstance, so its new windows share
  // the partition. In a private page it is always in memory.
  std::optional<WebViewPartition> partition() const;

  WebViewGuest(const WebViewGuest&) = delete;
  WebViewGuest& operator=(const WebViewGuest&) = delete;

  ~WebViewGuest() override;

  // Returns the guest behind `contents`, or null (for example, for the shell's
  // own page).
  static WebViewGuest* FromWebContents(content::WebContents* contents);

  // Asks the shell where to save a download from this page, as a `kSave` file
  // chooser. The shell draws the dialog, not Chrome (see RunFileChooser).
  //
  // `chosen` gets an absolute path, or nothing if the shell canceled or never
  // answered.
  void ChooseDownloadPath(
      const base::FilePath& suggested_path,
      base::OnceCallback<void(std::optional<base::FilePath>)> chosen);

  // Asks the shell for files in place of a browser-drawn dialog, such as the
  // PDF viewer's save or showSaveFilePicker(). See
  // //chrome/browser/domicile/domicile_file_dialogs.h.
  //
  // `chosen` gets absolute paths, or nothing if the shell canceled or never
  // answered.
  void ChooseFiles(
      mojom::WebViewFileChooserMode mode,
      const std::vector<std::string>& accept,
      const base::FilePath& suggested_path,
      base::OnceCallback<void(std::optional<std::vector<base::FilePath>>)>
          chosen);

  // Asks the shell to answer a permission prompt for `origin`. See
  // PermissionRequested in the mojom.
  //
  // `answered` gets the shell's answer, or nothing if the shell ignored the
  // request or the element went away.
  using PermissionAnswered =
      base::OnceCallback<void(std::optional<mojom::WebViewPermissionAnswer>)>;
  void AskPermission(const GURL& origin,
                     std::vector<mojom::WebViewPermission> permissions,
                     PermissionAnswered answered);

  // Tells the shell the request AskPermission sent is gone unanswered.
  void WithdrawPermissionRequest();

  // Asks the shell to pick a device for the page. See DeviceRequested in the
  // mojom.
  //
  // `answered` gets WebViewDevice ids, or nothing if the shell canceled,
  // ignored the request or the element went away.
  using DeviceAnswered =
      base::OnceCallback<void(const std::optional<std::vector<int32_t>>&)>;
  void AskForDevice(const std::string& title,
                    bool multiple,
                    DeviceAnswered answered);

  // Sends the devices the request AskForDevice sent offers.
  void OfferDevices(std::vector<mojom::WebViewDevicePtr> devices);

  // Tells the shell the request AskForDevice sent is gone unanswered.
  void WithdrawDeviceRequest();

  // Asks the shell whether the page may navigate its main frame to `url`. See
  // WillNavigate in the mojom and WillNavigateThrottle.
  //
  // `answered` gets the shell's answer, or true if the shell ignored it or the
  // element went away.
  void AskToNavigate(const GURL& url, base::OnceCallback<void(bool)> answered);

  // Asks the shell whether to open `url` in its scheme's application. See
  // ExternalAppRequested in the mojom and
  // //chrome/browser/domicile/domicile_external_apps.h.
  //
  // `answered` gets whether to open and whether to remember, or false for
  // both if the shell ignored it or the element went away.
  using ExternalAppAnswered =
      base::OnceCallback<void(bool open, bool remember)>;
  void AskToOpenExternalApp(const GURL& url,
                            const std::optional<url::Origin>& origin,
                            bool may_remember,
                            ExternalAppAnswered answered);

  // Asks the shell for a user name and password for `url`, the server or
  // proxy that asked. See SignInRequested in the mojom and
  // //chrome/browser/domicile/domicile_sign_in.h.
  //
  // `answered` gets the user name and password, or nullopt for cancel, which
  // is also the answer if the shell ignored it or the element went away.
  // Returns the request's number, for WithdrawSignIn.
  using SignInAnswered = base::OnceCallback<void(
      std::optional<std::pair<std::u16string, std::u16string>>)>;
  int AskToSignIn(const GURL& url,
                  const std::string& realm,
                  bool proxy,
                  bool secure,
                  SignInAnswered answered);

  // Tells the shell to stop asking for request `id`. Does nothing once it was
  // answered or a newer request replaced it.
  void WithdrawSignIn(int id);

  // Asks the shell `prompt`. See PromptRequested in the mojom and
  // //chrome/browser/domicile/domicile_prompts.h.
  //
  // `answered` gets whether it was accepted, the choice and the text; no if
  // the shell ignored it or the element went away. Returns the prompt's
  // number, for WithdrawPrompt.
  using PromptAnswered =
      base::OnceCallback<void(bool accepted, int choice, std::string text)>;
  int AskPrompt(mojom::WebViewPromptPtr prompt, PromptAnswered answered);

  // Tells the shell to stop asking prompt `id`. Does nothing once it was
  // answered or a newer prompt replaced it.
  void WithdrawPrompt(int id);

  // Asks the shell to show `request`, a step of a site's "Sign in with"
  // request. See IdentityRequested in the mojom and
  // components/domicile/browser/identity_dialog.h.
  //
  // `answered` gets the shell's answer: kNone if it ignored the step or the
  // element went away. Returns the step's number, for WithdrawIdentity.
  using IdentityAnswered =
      base::OnceCallback<void(mojom::WebViewIdentityAction action,
                              int32_t index)>;
  int AskIdentity(mojom::WebViewIdentityRequestPtr request,
                  IdentityAnswered answered);

  // Tells the shell to stop showing step `id`. Does nothing once it was
  // answered or a newer step replaced it.
  void WithdrawIdentity(int id);

  // Opens a browser window at `url` in this page's profile and partition, as
  // a window its page opened with no opener. Returns it, or null when there
  // is no shell to own it.
  WebViewGuest* OpenWindowAt(const GURL& url);

  // Binds a picker for `frame`, a frame of this guest's page. See
  // mojom::PagePicker and PopulateChromeFrameBinders.
  void BindPagePicker(content::RenderFrameHost& frame,
                      mojo::PendingReceiver<mojom::PagePicker> receiver);

  base::WeakPtr<WebViewGuest> GetWeakPtr() {
    return weak_factory_.GetWeakPtr();
  }

  // chrome.tabs requests on a tab, and an app launch that reuses an app
  // window, handled as if the page had asked:
  // - Focus: the shell raises windows, so the element fires
  //   `domicile-focus-request`.
  // - Close: the browser closes a browser window; a shell's own page fires
  //   `domicile-close`.
  // - New window: the browser opens one.
  // See //chrome/browser/domicile/domicile_desk.h.
  void RequestFocus();
  void RequestClose();
  void RequestWindow(const GURL& url);

  // The shell's closeBrowserWindow: closes this browser window once its page
  // agrees. Runs the page's `beforeunload`, which may ask the shell (see
  // RunBeforeUnloadDialog); BeforeUnloadFired closes on its answer. A page
  // with no `beforeunload` handler closes at once.
  void AskToClose();

  // chrome.windows.create for popup window `window_id`: opens a browser window
  // as its one tab. `width` and `height` are 0 when the extension set none.
  void RequestPopupWindow(int window_id,
                          const GURL& url,
                          int width,
                          int height);

  // The chrome.windows.create popup window this guest is the tab of, if any.
  std::optional<int> popup_window() const { return popup_window_; }

  // Whether the element has the `extensionpopup` attribute, making this an
  // extension action popup instead of a tab. Always false for a browser
  // window. See //chrome/browser/domicile/domicile_tab_helpers.h.
  bool extension_popup() const { return extension_popup_; }

  // Runs `focused` when the element takes focus, which makes this guest the
  // active tab.
  base::CallbackListSubscription AddFocusedCallback(
      base::RepeatingClosure focused);

  // The page's zoom factor, for chrome.tabs. ZoomTo expects a factor already
  // within blink's range (see DeskZoomFactor in
  // //components/domicile:desk_tabs) and reports the change like SetZoom.
  double GetZoomFactor() const;
  void ZoomTo(double factor);

  // Runs `changed` on each zoom change, for tabs.onZoomChange.
  using ZoomChangedCallback =
      base::RepeatingCallback<void(double old_factor, double new_factor)>;
  base::CallbackListSubscription AddZoomChangedCallback(
      ZoomChangedCallback changed);

  // mojom::WebViewGuest:
  void Navigate(const GURL& url) override;
  void Focused() override;

  // History controls for the address bar. The element's own `History` belongs
  // to the swapped-out placeholder frame, so these act on the guest's
  // NavigationController instead.
  void GoBack() override;
  void GoForward() override;
  void GoBackInNewWindow() override;
  void GoForwardInNewWindow() override;
  void Stop() override;
  void Reload() override;
  void SetZoom(double factor) override;

  // Find in page on the guest's WebContents, so every guest frame is searched
  // and replies arrive at DidReceiveFindReply.
  void Find(const std::string& text, bool forward) override;
  void StopFinding(bool keep_selection) override;

  // The shell's context menu choices. Each acts on the newest menu's frame and
  // click. See HandleContextMenu.
  void RunContextMenuAction(int32_t menu,
                            mojom::WebViewContextMenuAction action) override;
  void Inspect() override;
  void Print() override;

  // Clears the link under the pointer. PreHandleMouseEvent reports it again
  // when the pointer is back over the page.
  void PointerLeft() override;

  // Leaves page fullscreen through content, which calls
  // ExitFullscreenModeForTab.
  void ExitPageFullscreen() override;
  void ProceedPastWarning() override;

  // mojom::PagePicker: asks the shell with PickerRequested, with the anchor
  // moved into the element's coordinates.
  void Pick(mojom::WebViewPickerPtr picker, PickCallback callback) override;

  // Stores the setting through the profile's HostContentSettingsMap, as
  // Chrome's page info does. The change reaches the shell through
  // OnContentSettingChanged.
  void SetSitePermission(mojom::WebViewPermission permission,
                         mojom::WebViewPermissionSetting setting) override;

  // The profile's camera and microphone preference, through MediaAccess.
  void ListMediaDevices(ListMediaDevicesCallback callback) override;
  void SetMediaDevice(mojom::WebViewMediaDeviceKind kind,
                      const std::string& id,
                      SetMediaDeviceCallback callback) override;

  // Counts in the primary main frame, as ReadDescription reads.
  void CountMatches(const std::string& selector,
                    CountMatchesCallback callback) override;

  // content::BrowserPluginGuestDelegate:
  content::WebContents* GetOwnerWebContents() override;
  content::RenderFrameHost* GetProspectiveOuterDocument() override;
  base::WeakPtr<content::BrowserPluginGuestDelegate> GetGuestDelegateWeakPtr()
      override;
  // Makes the page's new window as a browser window. See MakeOpenedWindow.
  std::unique_ptr<content::WebContents> CreateNewGuestWindow(
      const content::WebContents::CreateParams& create_params) override;

  // content::WebContentsDelegate:
  //
  // Catches desktop chords while a guest has focus. Keys in a focused guest
  // never reach the shell's document or the compositor, so this is the only
  // place to match claimed chords (`guard-webview-keyboard.sh` checks this).
  // A match is swallowed and sent down the control channel. Modifier state is
  // always sent, since the shell needs it (e.g. Alt to drag a window).
  //
  // Unclaimed chords the page ignores arrive later at HandleKeyboardEvent.
  content::KeyboardEventProcessingResult PreHandleKeyboardEvent(
      content::WebContents* source,
      const input::NativeWebKeyboardEvent& event) override;

  // Forwards chords the page did not preventDefault to the shell, matching
  // Chrome's order (site first, browser second). Plain keys are not sent; see
  // UnhandledKeyDown in components/domicile/mojom/web_view_guest.mojom.
  // Returns false because the shell handles the key asynchronously.
  bool HandleKeyboardEvent(content::WebContents* source,
                           const input::NativeWebKeyboardEvent& event) override;

  // Ctrl+wheel the page did not handle. Reported, not applied; see
  // ZoomRequested in the mojom.
  void ContentsZoomChange(bool zoom_in) override;

  // Sends the context menu to the element as ContextMenuRequested so the
  // shell draws it instead of Chrome. The page's own `contextmenu` event has
  // already fired.
  //
  // Converts the click from root view (shell) coordinates to the guest's main
  // frame view, which is the element's box.
  bool HandleContextMenu(content::RenderFrameHost& render_frame_host,
                         const content::ContextMenuParams& params) override;

  // Reports back/forward availability to the renderer, as Chrome's own
  // buttons do. Every history mutation arrives here, and so does a change to
  // the page's crashed status.
  //
  // The flags are ignored: they only mean "some UI is stale". Each Report*
  // compares against the last report instead.
  void NavigationStateChanged(content::WebContents* source,
                              content::InvalidateTypes changed_flags) override;

  // Reports loading state, as Chrome's throbber does. Used instead of
  // WebContentsObserver::DidStartLoading because `should_show_loading_ui` is
  // false for same-document navigations. Combined with IsLoading().
  void LoadingStateChanged(content::WebContents* source,
                           bool should_show_loading_ui) override;

  // Reports the link under the pointer, as Chrome's status bubble shows it.
  // See TargetUrlChanged in the mojom.
  void UpdateTargetURL(content::WebContents* source, const GURL& url) override;

  // Reports the renderer's last link again when the pointer is back over the
  // page after PointerLeft, or clears it on a MouseLeave. The renderer reports
  // no link on leaving, and only changes after: Chrome clears its bubble when
  // its view sees the mouse exit, and a guest has no view of its own.
  bool PreHandleMouseEvent(content::WebContents* source,
                           const blink::WebMouseEvent& event) override;

  // Reports the page's tooltip to the shell, which draws it; Chrome draws
  // none. See TooltipChanged in the mojom. `widget` is the page's or a frame's
  // in another process, and the pointer is in its coordinates.
  bool DomicileTooltip(content::WebContents* source,
                       content::RenderWidgetHost* widget,
                       const std::u16string& text) override;

  // Asks the shell whether to send the page's form again. See kResendForm in
  // the mojom. Content's default does nothing, so the reload never happens.
  void ShowRepostFormWarningDialog(content::WebContents* source) override;

  // Asks the shell whether to end a page that stopped responding, and
  // withdraws it when the page responds again. See kUnresponsive in the mojom.
  void RendererUnresponsive(
      content::WebContents* source,
      content::RenderWidgetHost* render_widget_host,
      base::RepeatingClosure hang_monitor_restarter) override;
  void RendererResponsive(
      content::WebContents* source,
      content::RenderWidgetHost* render_widget_host) override;

  // Returns this, so the page's dialogs reach the shell. Content's default
  // has none, which dismisses each dialog at once.
  content::JavaScriptDialogManager* GetJavaScriptDialogManager(
      content::WebContents* source) override;

  // content::JavaScriptDialogManager:
  //
  // Sends the dialog to the element as DialogRequested. One at a time; see
  // GuestDialogs.
  void RunJavaScriptDialog(content::WebContents* web_contents,
                           content::RenderFrameHost* render_frame_host,
                           content::JavaScriptDialogType dialog_type,
                           const std::u16string& message_text,
                           const std::u16string& default_prompt_text,
                           DialogClosedCallback callback,
                           bool* did_suppress_message) override;
  // Sends a `beforeunload` that asks to stay to the element as a
  // DialogRequested of type kBeforeUnload; accepting leaves. One at a time
  // with the others: one asked while a dialog is open leaves, as content does
  // with no dialog manager.
  void RunBeforeUnloadDialog(content::WebContents* web_contents,
                             content::RenderFrameHost* render_frame_host,
                             bool is_reload,
                             DialogClosedCallback callback) override;
  // Answers the open dialog with Cancel and sends DialogWithdrawn. Content
  // calls it on navigation and when the page closes.
  void CancelDialogs(content::WebContents* web_contents,
                     bool reset_state) override;

  // Lets content make a page's new window (target="_blank", window.open, ...)
  // through CreateNewGuestWindow, so the page keeps its opener, its handle,
  // the target name and a form's POST body.
  bool IsWebContentsCreationOverridden(
      content::RenderFrameHost* opener,
      content::SiteInstance* source_site_instance,
      content::mojom::WindowContainerType window_container_type,
      const GURL& opener_url,
      const std::string& frame_name,
      const GURL& target_url) override;
  // Unused: IsWebContentsCreationOverridden is false.
  content::WebContents* CreateCustomWebContents(
      content::RenderFrameHost* opener,
      content::SiteInstance* source_site_instance,
      bool is_new_browsing_instance,
      const GURL& opener_url,
      const std::string& frame_name,
      const GURL& target_url,
      WindowOpenDisposition disposition,
      const blink::mojom::WindowFeatures& window_features,
      const content::StoragePartitionConfig& partition_config,
      content::SessionStorageNamespaceHandle* session_storage_namespace) override;

  // Shows a new window CreateNewGuestWindow made as a browser window. Content
  // calls it when the page shows the window, or at once for one without an
  // opener, and then navigates it.
  content::WebContents* AddNewContents(
      content::WebContents* source,
      std::unique_ptr<content::WebContents> new_contents,
      const GURL& target_url,
      WindowOpenDisposition disposition,
      const blink::mojom::WindowFeatures& window_features,
      bool user_gesture,
      bool* was_blocked) override;

  // Performs navigations the renderer hands to the browser: a cross-site
  // subframe's `target="_top"` link, a middle or Ctrl click, or a window.open
  // naming an existing context. Content's default ignores them, which breaks
  // sign-in flows.
  //
  // A current-tab disposition navigates this guest. Anything asking for a new
  // window opens a browser window at the address with no opener, as Chrome
  // opens a middle-clicked link (ReportNewWindow).
  content::WebContents* OpenURLFromTab(
      content::WebContents* source,
      const content::OpenURLParams& params,
      base::OnceCallback<void(content::NavigationHandle&)>
          navigation_handle_callback) override;

  // Sends file chooser requests to the element as FileChooserRequested so the
  // shell draws the picker. Chrome's FileSelectHelper would open a portal
  // dialog the shell cannot place, and content's default cancels.
  //
  // FileChooserImpl grants the renderer access to the chosen paths. A folder
  // upload is expanded here, because the page wants the files inside it.
  void RunFileChooser(content::RenderFrameHost* render_frame_host,
                      scoped_refptr<content::FileSelectListener> listener,
                      const blink::mojom::FileChooserParams& params) override;

  // Lists the files under a folder dropped on a `webkitdirectory` input, as a
  // folder upload of it. Content's default refuses. Content has checked the
  // page may read `path`, which the drop granted.
  void EnumerateDirectory(content::WebContents* web_contents,
                          scoped_refptr<content::FileSelectListener> listener,
                          const base::FilePath& path) override;

  // Closes the window when the page agreed to AskToClose. A page that stayed
  // keeps its window, and a beforeunload AskToClose did not start, such as a
  // discard's, closes nothing. WebContentsObserver's one-argument
  // BeforeUnloadFired stays visible beside it.
  using content::WebContentsObserver::BeforeUnloadFired;
  void BeforeUnloadFired(content::WebContents* tab,
                         bool proceed,
                         bool* proceed_to_fire_unload) override;

  // Handles window.close(); content's default does nothing, which leaves
  // extension popups open. A browser window closes here. A shell's own page
  // fires `domicile-close` instead, because the outer WebContents owns it and
  // the shell must remove the element. See CloseRequested in the mojom.
  void CloseContents(content::WebContents* source) override;

  // Camera and microphone requests go through MediaAccess, so they ask the
  // shell like any other permission. getDisplayMedia, with or without
  // `preferCurrentTab`, asks the desktop's ScreenCast portal, in a picker the
  // shell draws, and is answered once the user picks or cancels (see
  // ScreenChoice). Chrome's own screen picker is a dialog the shell cannot
  // place. Other capture, such as an extension's `chrome.tabCapture`, is
  // refused as content's default does.
  void RequestMediaAccessPermission(
      content::WebContents* web_contents,
      const content::MediaStreamRequest& request,
      content::MediaResponseCallback callback) override;
  bool CheckMediaAccessPermission(content::RenderFrameHost* render_frame_host,
                                  const url::Origin& security_origin,
                                  blink::mojom::MediaStreamType type) override;

  // Page fullscreen (`requestFullscreen()`, a video's fullscreen button).
  // Content's default refuses it, so the page waits forever.
  //
  // The page goes fullscreen within the element's box at once, and the
  // element hears PageFullscreenChanged so the shell can grow it. As in
  // //extensions' WebViewGuest, but with no permission prompt: the page needs
  // a user gesture, as in Chrome, and the shell can leave with
  // ExitPageFullscreen.
  void EnterFullscreenModeForTab(
      content::RenderFrameHost* requesting_frame,
      const blink::mojom::FullscreenOptions& options) override;
  void ExitFullscreenModeForTab(content::WebContents* web_contents) override;
  bool IsFullscreenForTabOrPending(
      const content::WebContents* web_contents) override;

  // The page's first screen wake lock went on or its last went off. Patch
  // 0158 counts them in content's WakeLockServiceImpl; the element hears
  // WakeLockChanged.
  void ScreenWakeLockChanged(content::WebContents* source, bool held) override;

  // Handles `window.focus()` or `client.focus()` (e.g. after a notification
  // click) by asking the shell, which decides window order.
  void ActivateContents(content::WebContents* contents) override;

  // Sizes an extension popup's page from its content, as Chrome's
  // ExtensionViewViews does: Blink's auto-resize, between Chrome's popup
  // bounds. Per widget, so each new page's is turned on. Nothing for a tab.
  void EnableAutoResize();

  // Reports the size the popup's page sized itself to. See ContentSizeChanged
  // in the mojom.
  void ResizeDueToAutoResize(content::WebContents* web_contents,
                             const gfx::Size& new_size) override;

  // content::WebContentsObserver:
  void WebContentsDestroyed() override;

  // Reports load progress. See LoadProgressChanged in the mojom.
  void LoadProgressChanged(double progress) override;

  // Reports Find results. Replies to a stopped or replaced search are dropped,
  // as in Chrome's FindTabHelper.
  void DidReceiveFindReply(int request_id,
                           int number_of_matches,
                           const gfx::Rect& selection_rect,
                           int active_match_ordinal,
                           bool final_update) override;

  // Reports security state changes, as Chrome's SecurityStateTabHelper does.
  // Fires without a navigation too, e.g. for a later subresource cert error.
  //
  // Both this and NavigationStateChanged call ReportPage, which deduplicates.
  void DidChangeVisibleSecurityState() override;

  // Reports the best of the page's icons to the element. See FaviconChanged
  // in the mojom.
  void DidUpdateFaviconURL(
      content::RenderFrameHost* render_frame_host,
      const std::vector<blink::mojom::FaviconURLPtr>& candidates,
      blink::mojom::FaviconUpdateReason reason) override;

  // Reads the page's description once its head is parsed. See
  // DescriptionChanged in the mojom.
  void DOMContentLoaded(content::RenderFrameHost* render_frame_host) override;

  // Reads the page's description again: a single-page app changes it with the
  // title.
  void TitleWasSetForMainFrame(
      content::RenderFrameHost* render_frame_host) override;

  // On a new page: clears the previous favicon and description (a page
  // without them reports nothing), ends any find as Chrome does, sizes an
  // extension popup's new page from its content, and reports the new site's
  // permissions.
  void PrimaryPageChanged(content::Page& page) override;

  // Reports a failed load of the page, or a load after one, to the element.
  // See PageFailureChanged in the mojom.
  void DidFinishNavigation(
      content::NavigationHandle* navigation_handle) override;

  // content_settings::Observer:
  //
  // Any setting of a reported type may change the page's site's, so this
  // reports again; ReportSitePermissions skips an unchanged list.
  void OnContentSettingChanged(
      const ContentSettingsPattern& primary_pattern,
      const ContentSettingsPattern& secondary_pattern,
      ContentSettingsTypeSet content_type_set) override;

  // content::DownloadManager::Observer:
  //
  // Lists each download this page starts on the desk. See DeskDownloads.
  void OnDownloadCreated(content::DownloadManager* manager,
                         download::DownloadItem* item) override;
  void ManagerGoingDown(content::DownloadManager* manager) override;

 private:
  WebViewGuest(content::RenderFrameHost& owner,
               mojo::PendingReceiver<mojom::WebViewGuest> receiver,
               mojo::PendingRemote<mojom::WebViewGuestClient> client,
               bool extension_popup);
  WebViewGuest(content::WebContents& shell,
               const std::string& window_id,
               std::optional<int> popup_window);

  // One of WebContents' edit commands, which act on the focused frame.
  using EditCommand = void (content::WebContents::*)();

  // Runs `command` once this guest has focus, retrying up to `tries` times.
  //
  // Edits act on the focused frame. The element refocuses the page first, but
  // that arrives on another channel and can lag; running early would paste
  // into the shell.
  void EditWhenFocused(EditCommand command, int tries);

  // Copies `url` as text, like Chrome's "copy link address".
  void CopyAddress(const GURL& url);

  // Downloads `url` from `frame`'s page; the shell picks the location.
  void SaveFrom(content::RenderFrameHost& frame,
                const GURL& url,
                const content::ContextMenuParams& params,
                bool is_subresource);

  // Makes this guest's WebContents from `params` with this as guest
  // delegate, delegate and observer. Shared by every kind of guest.
  std::unique_ptr<content::WebContents> MakeContents(
      content::WebContents::CreateParams params,
      const GuestCreatedCallback& created);

  // Finishes AttachToElement once content has a frame safe to swap, or null
  // if the frame went away.
  void AttachWindowTo(content::RenderFrameHost* outer_contents_frame);

  // Handles the showing element going away: drops its pipes and hides the
  // page, like a background tab.
  void ElementGone();

  // Points `client_` at an unread pipe, since a window with no element still
  // reports. A reply it needs, such as a file chooser's, is dropped, and the
  // wrapped callbacks treat that as a cancel.
  void Unclient();

  // Closes this guest: via the browser for a browser window, via
  // `domicile-close` for a shell's own page.
  void Close();

  // Resends everything the element mirrors to a new element. Resets each
  // report to a fresh guest's values first, so every one is sent.
  void ReportEverything();

  // Sends the link under the pointer to the element if it changed.
  void ReportTargetUrl(const GURL& url);
  // Sends the tooltip, empty while the pointer is outside the page, if it
  // changed. A new one waits kTooltipDelay, as Chrome's does; hiding one, or
  // changing one already shown, is at once.
  void ReportTooltip();
  // Sends the tooltip as it is now, if it changed, at the pointer.
  void SendTooltip();
  // The tooltip to show: none while the pointer is outside the page, or once
  // the widget that reported it is gone.
  const std::string& TooltipNow() const;
  // The widget that reported `tooltip_`, or null once it or its view is gone.
  content::RenderWidgetHost* TooltipWidget() const;
  // The pointer in the page's coordinates. `pointer_` is in the tooltip
  // widget's, which for a frame in another process are the frame's own.
  gfx::Point PointerInPage(content::RenderWidgetHost& widget) const;
  // Withdraws the shell's picker when its page closes the pipe that asked.
  void PagePickerClosed();

  // Reads the description of `frame`, the guest's main frame, in an isolated
  // world, so the page's own scripts cannot see or change the read.
  void ReadDescription(content::RenderFrameHost& frame);

  // Reports the description read from `document`, unless a new page
  // replaced it while it was read. A reply that is not a string, as from a
  // frame that could not run the read, reports no description.
  void DescriptionRead(content::WeakDocumentPtr document,
                       base::Value description);

  // Sends the page's description to the element if it changed.
  void ReportDescription(const std::string& description);

  // Sets page fullscreen and tells the renderer and the element, if it
  // changed. The renderer reads it from the widget's visual properties.
  void SetPageFullscreen(bool fullscreen);

  // Opens a browser window at `target_url`, with no opener, for a middle click
  // or an extension. Never opens an empty window.
  void ReportNewWindow(const GURL& target_url);

  // Reports back/forward availability to the element if it changed.
  // Opens a browser window that takes `step` through a copy of this guest's
  // history; see mojom::WebViewGuest.GoBackInNewWindow.
  void OpenHistoryStep(HistoryStep step);

  //
  // Uses `CanGoBack()`, not `ShouldEnableBackButton()`. The latter stays true
  // over skippable entries for Chrome's long-press history menu, which a shell
  // lacks; `goBack()` does nothing when `CanGoBack()` is false.
  void ReportHistory();

  // Reports the page's URL and security level to the element if either
  // changed.
  //
  // Both come from `GetVisibleEntry()`, as in Chrome's omnibox, so the
  // padlock always matches the address shown.
  void ReportPage();

  // Reports the page's site's permissions to the element if they changed. A
  // page with no site reports none.
  void ReportSitePermissions();

  // Reports whether the page has a renderer, and why it went away, to the
  // element if either changed. See RenderProcessChanged in the mojom.
  void ReportRenderProcess();

  // Reports the page's failure, or null, to the element if it changed. Run in
  // a task after an error page commits, so Chrome's interstitial helper has
  // taken its warning first.
  void ReportPageFailure(GURL url, int net_error, int http_status);
  void ReportPageFailure(mojom::WebViewPageFailurePtr failure);

  // Reports loading state to the element if it changed. LoadingStateChanged
  // also fires when nothing changed.
  void ReportLoading(bool should_show_loading_ui);

  // Reports load progress to the element if it changed.
  void ReportLoadProgress(double progress);

  // Reports the page's zoom to the element if it changed. Zoom changes when
  // the shell sets it, when another window on the same host changes it
  // (HostZoomMap is per host), or on navigation to a differently zoomed site.
  void ReportZoom();

  // Reports find results to the element if they changed. `0, 0` means no
  // find.
  void ReportFind(int matches, int active_match);

  // Ends the current find so late replies are dropped and the next Find starts
  // a new search, and tells the element.
  void EndFind();

  // Finishes CreateAndAttach once content has a frame safe to swap.
  // `outer_contents_frame` is null if the frame went away or beforeunload
  // refused; dropping `guest` then cleans up.
  static void Attach(std::unique_ptr<WebViewGuest> guest,
                     content::RenderFrameHost* outer_contents_frame);

  // Owned until Attach hands it to the outer WebContents; this object then
  // owns itself. A browser window keeps it and attaches it unowned. See the
  // destructor.
  std::unique_ptr<content::WebContents> owned_guest_contents_;
  raw_ptr<content::WebContents> guest_contents_ = nullptr;

  // The private context this page is in, or null for an ordinary page. The
  // destructor reports the page closed to BrowserWindowHost.
  raw_ptr<content::BrowserContext> private_context_ = nullptr;

  // The <webview>'s document. An id, not a pointer, so it cannot dangle.
  content::GlobalRenderFrameHostId owner_rfh_id_;

  // Set by Attach. Self-destruction in WebContentsDestroyed is only correct
  // once nobody else holds a unique_ptr to this.
  bool self_owned_ = false;

  // See popup_window().
  const std::optional<int> popup_window_;

  // See extension_popup().
  const bool extension_popup_;

  // See window_id().
  const std::string window_id_;

  // See PinToApp.
  std::string app_host_;

  // A browser window's owner: the shell's WebContents, which survives shell
  // reloads. Null for a shell's own page, which uses `owner_rfh_id_`.
  base::WeakPtr<content::WebContents> owner_contents_;

  // True between AttachToElement and AttachWindowTo; a second element is
  // refused meanwhile.
  bool attaching_ = false;

  // The last reported content size, resent to a new element.
  std::optional<gfx::Size> content_size_;

  // The newest context menu sent to the element: its id (0 before the first),
  // its frame and its params.
  int context_menu_id_ = 0;
  content::GlobalRenderFrameHostId context_menu_frame_;
  std::optional<content::ContextMenuParams> context_menu_params_;

  mojo::Receiver<mojom::WebViewGuest> receiver_;

  // The element. Bound from creation, so every report has a receiver.
  mojo::Remote<mojom::WebViewGuestClient> client_;

  // Last-reported values, used to skip unchanged reports. Each starts at the
  // element's initial value, so a fresh guest sends nothing redundant.
  bool reported_can_go_back_ = false;
  bool reported_can_go_forward_ = false;

  bool reported_loading_ = false;
  double reported_load_progress_ = 0.0;
  GURL reported_url_;
  mojom::WebViewSecurity reported_security_ =
      mojom::WebViewSecurity::kNeutral;
  double reported_zoom_ = 1.0;
  GURL reported_favicon_;
  std::string reported_description_;
  GURL reported_target_url_;
  mojom::WebViewRenderProcess reported_render_process_ =
      mojom::WebViewRenderProcess::kRunning;
  int reported_exit_code_ = 0;
  // Null while the page loaded.
  mojom::WebViewPageFailurePtr reported_page_failure_;
  // The renderer's last link, which stays set while the pointer is outside the
  // page. See PreHandleMouseEvent.
  GURL renderer_target_url_;
  // The renderer's last tooltip, which stays set while the pointer is outside
  // the page, and the one the shell has. See DomicileTooltip.
  std::string tooltip_;
  std::string reported_tooltip_;
  // The widget that reported `tooltip_`, as RenderWidgetHost::FromID's
  // arguments: a frame's widget can go away under its tooltip.
  int tooltip_process_ = 0;
  int tooltip_routing_ = 0;
  // Runs out when a new tooltip shows. See ReportTooltip.
  base::OneShotTimer tooltip_delay_;
  // Where the pointer last was over the page, in the DIPs of the widget under
  // it, and whether it is over the page now. See PreHandleMouseEvent.
  gfx::Point pointer_;
  bool pointer_inside_ = false;
  // The unresponsive-page prompt's number while it is asked, or 0. See
  // RendererUnresponsive.
  int unresponsive_prompt_ = 0;
  // Whether the page is fullscreen. Also what IsFullscreenForTabOrPending
  // answers, so the renderer's state and the element's never differ.
  bool page_fullscreen_ = false;
  // Whether the page holds a screen wake lock. See ScreenWakeLockChanged.
  bool wake_lock_ = false;

  // The page's open dialog. See RunJavaScriptDialog.
  GuestDialogs dialogs_;

  // The last sign-in request's number, and the one the shell is asked now,
  // or 0 for none. See AskToSignIn.
  int last_sign_in_ = 0;
  int open_sign_in_ = 0;

  // The same for AskPrompt.
  int last_prompt_ = 0;
  int open_prompt_ = 0;
  // The same for AskIdentity.
  int last_identity_ = 0;
  int open_identity_ = 0;
  // The page's pickers, each with the frame that asked, and the one the
  // shell is asked now, or none. See Pick.
  mojo::ReceiverSet<mojom::PagePicker, content::GlobalRenderFrameHostId>
      page_pickers_;
  std::optional<mojo::ReceiverId> open_picker_;
  // Whether AskToClose is waiting on the page's beforeunload.
  bool asked_to_close_ = false;

  // The current find's text, or empty. Decides whether a Find is the next
  // match or a new search.
  std::u16string find_text_;

  // The request id that began the current find. Content's ids increase, so
  // older replies are stale.
  int find_session_id_ = 0;

  int reported_find_matches_ = 0;
  int reported_find_active_match_ = 0;

  // The last SitePermissionsChanged sent. Empty, as the element starts.
  std::vector<std::pair<mojom::WebViewPermission,
                        mojom::WebViewPermissionSetting>>
      reported_site_permissions_;

  // The profile's settings, watched for ReportSitePermissions. Reset in
  // WebContentsDestroyed, with the zoom subscription.
  base::ScopedObservation<HostContentSettingsMap, content_settings::Observer>
      settings_observation_{this};

  // The profile's downloads, watched for ones this page starts. Reset in
  // WebContentsDestroyed, since a download with no WebContents would then
  // match.
  base::ScopedObservation<content::DownloadManager,
                          content::DownloadManager::Observer>
      download_manager_observation_{this};

  // HostZoomMap zoom changes, including from other windows on the same host.
  // Dropped with the guest's WebContents, which ReportZoom reads.
  base::CallbackListSubscription zoom_subscription_;

  // See AddFocusedCallback.
  base::RepeatingClosureList focused_callbacks_;

  // See AddZoomChangedCallback.
  base::RepeatingCallbackList<void(double, double)> zoom_callbacks_;

  // The page's getDisplayMedia() requests whose picker is open, by a number
  // of their own. Each leaves when the page is answered.
  std::map<int, std::unique_ptr<ScreenChoice>> screen_choices_;
  int next_screen_choice_ = 0;

  base::WeakPtrFactory<WebViewGuest> weak_factory_{this};
};

// Binds WebViewGuestHost, the interface a <webview> uses to create a guest.
// `created` runs on every guest; see GuestCreatedCallback.
//
// This does no access control. The caller must register the interface only
// for domicile:// documents; see PopulateChromeFrameBinders.
void BindWebViewGuestHost(
    content::RenderFrameHost* frame,
    mojo::PendingReceiver<mojom::WebViewGuestHost> receiver,
    GuestCreatedCallback created);

}  // namespace domicile

#endif  // COMPONENTS_DOMICILE_BROWSER_WEB_VIEW_GUEST_H_
