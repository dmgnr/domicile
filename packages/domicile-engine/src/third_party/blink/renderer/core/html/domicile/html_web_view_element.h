// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef THIRD_PARTY_BLINK_RENDERER_CORE_HTML_DOMICILE_HTML_WEB_VIEW_ELEMENT_H_
#define THIRD_PARTY_BLINK_RENDERER_CORE_HTML_DOMICILE_HTML_WEB_VIEW_ELEMENT_H_

#include <cstdint>
#include <optional>
#include <utility>

#include "components/domicile/mojom/web_view_guest.mojom-blink.h"
#include "third_party/blink/renderer/bindings/core/v8/idl_types.h"
#include "third_party/blink/renderer/bindings/core/v8/script_promise.h"
#include "third_party/blink/renderer/core/core_export.h"
#include "third_party/blink/renderer/core/dom/events/native_event_listener.h"
#include "third_party/blink/renderer/core/html/html_frame_element_base.h"
#include "third_party/blink/renderer/platform/mojo/heap_mojo_receiver.h"
#include "third_party/blink/renderer/platform/heap/collection_support/heap_hash_set.h"
#include "third_party/blink/renderer/platform/mojo/heap_mojo_remote.h"
#include "third_party/blink/renderer/platform/weborigin/kurl.h"
#include "third_party/blink/renderer/platform/wtf/text/wtf_string.h"
#include "third_party/blink/renderer/platform/wtf/vector.h"

namespace blink {

class DomicileContextMenuEvent;
class DomicileDeviceRequestEvent;
class DomicileDialogEvent;
class DomicileExternalAppEvent;
class DomicilePickerEvent;
class DomicileIdentityEvent;
class DomicilePromptEvent;
class DomicileSignInEvent;
class DomicileFileChooserEvent;
class DomicileMediaDevices;
class DomicilePermissionRequestEvent;
class ExceptionState;
class ScriptState;

// <webview>: a browser page embedded in a shell, driven by `src`, goBack(),
// goForward(), stop() and reload(). Defined by the fork because a custom
// element's name needs a hyphen.
//
// The element owns a placeholder frame that stays on about:blank. `src` goes
// to the browser over WebViewGuestHost, which attaches a guest WebContents to
// that frame. A guest's main frame passes X-Frame-Options and CSP
// frame-ancestors; see components/domicile/browser/web_view_guest.h.
//
// Known gap: `srcdoc` is not intercepted, so setting it would navigate the
// placeholder frame. The IDL has no srcdoc and nothing sets it.
class CORE_EXPORT HTMLWebViewElement final
    : public HTMLFrameElementBase,
      public domicile::mojom::blink::WebViewGuestClient {
  DEFINE_WRAPPERTYPEINFO();

 public:
  explicit HTMLWebViewElement(Document&);
  ~HTMLWebViewElement() override;

  // Required for `DynamicTo` and `IsA`: without it every downcast returns null
  // and nothing else fails. See node.h and
  // scripts/test-fork-elements-know-their-type.sh.
  ElementType GetElementType() const final {
    return ElementType::kHTMLWebViewElement;
  }

  // Address bar controls. They act on the guest's history in the browser, not
  // on the placeholder frame's.
  //
  // They never throw: the pipe lives as long as the element, and going back
  // with no history is a no-op.
  void goBack();
  void goForward();
  void goBackInNewWindow();
  void goForwardInNewWindow();
  void stop();
  void reload();

  // Whether goBack() and goForward() would navigate, for graying out buttons.
  //
  // Properties, so a shell that mounts late can read the current state;
  // `domicile-history-change` only signals a change. Not content attributes,
  // which authors could overwrite. The browser pushes the values (see
  // WebViewGuestClient in components/domicile/mojom/web_view_guest.mojom) so
  // reading them never blocks.
  bool canGoBack() const { return can_go_back_; }
  bool canGoForward() const { return can_go_forward_; }

  // Whether a browser would show a loading spinner. A property, like
  // canGoBack. Combines `IsLoading()` with `should_show_loading_ui`, so
  // same-document navigations do not count. See WebViewGuest::ReportLoading.
  bool loading() const { return loading_; }

  // How far the page has loaded. A property, like canGoBack. See
  // LoadProgressChanged in components/domicile/mojom/web_view_guest.mojom.
  double loadProgress() const { return load_progress_; }

  // The page's current URL and security level, for an address bar. Both come
  // from the same navigation entry in one message, so they always match.
  // Properties, like canGoBack.
  //
  // Empty means the browser has not reported yet (the initial entry). Do not
  // read it as any security level.
  const String& url() const { return url_; }
  const String& security() const { return security_; }

  double zoom() const { return zoom_; }

  // The page's icon, or empty. See FaviconChanged in
  // components/domicile/mojom/web_view_guest.mojom.
  const String& favicon() const { return favicon_; }

  // The page's description, or empty. See DescriptionChanged in
  // components/domicile/mojom/web_view_guest.mojom.
  const String& description() const { return description_; }

  // The link under the pointer, or empty. See TargetUrlChanged in
  // components/domicile/mojom/web_view_guest.mojom.
  const String& targetUrl() const { return target_url_; }

  // The tooltip under the pointer, or empty, and where the pointer was when it
  // appeared, in this element's CSS pixels. See TooltipChanged in
  // components/domicile/mojom/web_view_guest.mojom.
  const String& tooltip() const { return tooltip_; }
  int32_t tooltipX() const { return tooltip_x_; }
  int32_t tooltipY() const { return tooltip_y_; }

  // Tells the browser the pointer left the page when the document sees a
  // move off this element. Listens only while a link or tooltip is shown;
  // UpdatePointerListener adds and removes it.
  void PointerMoved(Event* event);
  void UpdatePointerListener();
  void setZoom(double factor, ExceptionState&);

  // Find in page. The browser searches the guest; results arrive in
  // FindChanged.
  void find(const String& text, bool backward);
  void stopFinding();
  int32_t findMatches() const { return find_matches_; }
  int32_t findActiveMatch() const { return find_active_match_; }

  // The content's preferred size, from ContentSizeChanged.
  int32_t contentWidth() const { return content_width_; }
  int32_t contentHeight() const { return content_height_; }

  // Opens DevTools on the guest's page. See WebViewGuest.Inspect.
  void inspect();

  // Prints the guest's page. See WebViewGuest.Print.
  void print();

  // Whether the page is fullscreen, from PageFullscreenChanged.
  bool pageFullscreen() const { return page_fullscreen_; }
  void exitPageFullscreen();

  // Whether the page keeps the screens on, from WakeLockChanged.
  bool wakeLock() const { return wake_lock_; }

  // Why the page's renderer went away, or empty while it runs, and its exit
  // code. See RenderProcessChanged in
  // components/domicile/mojom/web_view_guest.mojom.
  const String& renderProcessGone() const { return render_process_gone_; }
  int32_t renderProcessExitCode() const { return render_process_exit_code_; }

  // Why the page failed to load, or empty while it loaded, with the address,
  // Chromium's error name, the HTTP status and whether a warning may be
  // passed. See PageFailureChanged in
  // components/domicile/mojom/web_view_guest.mojom.
  const String& pageFailure() const { return page_failure_; }
  const String& pageFailureUrl() const { return page_failure_url_; }
  const String& pageFailureError() const { return page_failure_error_; }
  int32_t pageFailureHttpStatus() const { return page_failure_http_status_; }
  bool pageFailureCanProceed() const { return page_failure_can_proceed_; }
  void proceedPastWarning();

  // Runs `action` for `menu`. Throws InvalidStateError if a newer menu has
  // replaced it. See domicile_context_menu_event.h.
  void RunContextMenuAction(
      const DomicileContextMenuEvent& menu,
      domicile::mojom::blink::WebViewContextMenuAction action,
      ExceptionState&);

  // Releases a dispatched file chooser event once answered. See
  // `waiting_choosers_`.
  void FileChooserAnswered(DomicileFileChooserEvent&);

  // The site permissions from SitePermissionsChanged, as name and setting.
  const Vector<std::pair<String, String>>& sitePermissions() const {
    return site_permissions_;
  }
  void setSitePermission(const String& permission,
                         const String& setting,
                         ExceptionState&);
  ScriptPromise<DomicileMediaDevices> mediaDevices(ScriptState*,
                                                   ExceptionState&);
  ScriptPromise<IDLUndefined> setMediaDevice(ScriptState*,
                                             const String& kind,
                                             const String& id,
                                             ExceptionState&);
  ScriptPromise<IDLLong> countMatches(ScriptState*,
                                      const String& selector,
                                      ExceptionState&);

  // Releases the permission request once answered. See
  // `permission_request_`.
  void PermissionRequestAnswered(DomicilePermissionRequestEvent&);

  // Releases the device request once answered. See `device_request_`.
  void DeviceRequestAnswered(DomicileDeviceRequestEvent&);

  // Releases the dialog once answered. See `dialog_`.
  void DialogAnswered(DomicileDialogEvent&);

  // Releases the external app request once answered. See `external_app_`.
  void ExternalAppAnswered(DomicileExternalAppEvent&);

  // Releases the sign-in request once answered. See `sign_in_`.
  void SignInAnswered(DomicileSignInEvent&);

  // Releases the prompt once answered. See `prompt_`.
  void PromptAnswered(DomicilePromptEvent&);
  // Releases the sign-in step once answered. See `identity_`.
  void IdentityAnswered(DomicileIdentityEvent&);
  // Releases the picker once answered. See `picker_`.
  void PickerAnswered(DomicilePickerEvent&);

  void Trace(Visitor*) const override;

 private:
  /**
   * Dispatches an event when this element gains focus, so the shell can raise
   * the window.
   *
   * A guest taking focus unfocuses the embedder's page first
   * (WebContentsImpl::SetFocusedFrameTree), and Document::SetFocusedElement
   * skips `focus` and `focusin` on an unfocused page. Without this, a click in
   * a browser window would produce no event. guard-webview-click.sh checks
   * this.
   *
   * Overrides SetFocused because Document::SetFocusedElement always calls it,
   * whatever route focus took. Patch 0011 makes the base's SetFocused callable
   * from a subclass.
   */
  void SetFocused(bool received,
                  mojom::blink::FocusType,
                  BlurEventBehavior) override;

  /**
   * Dispatches the focus event synchronously. Deferring it (by queue or task)
   * loses the event. Document::SetFocusedElement allows frames to dispatch
   * events from SetFocused. Logs before and after for diagnosis.
   */
  void DispatchGuestFocus();

  /**
   * Dispatches the `focus` and `focusin` that Document::SetFocusedElement
   * skipped because the embedder's page is unfocused. Only then: a focused
   * page already got them.
   *
   * Upstream defers them until the page regains focus, but here the page lost
   * focus to its own guest, so focus-out handlers and React's onFocus would
   * see stale focus. The matching `blur` and `focusout` already fired in
   * FocusController::FocusHasChanged.
   *
   * Dispatched directly, not via Element::DispatchFocusInEvent, which may
   * queue on a ScopedEventQueue and lose the event. guard-webview-click.sh
   * checks this.
   */
  void DispatchSuppressedFocus(mojom::blink::FocusType);

  LayoutObject* CreateLayoutObject(const ComputedStyle&) override;

  // `src` never reaches HTMLFrameElementBase, which would navigate the
  // placeholder frame. Everything else does.
  void ParseAttribute(const AttributeModificationParams&) override;

  // The base creates the about:blank placeholder frame here, so this is the
  // earliest point to request a guest.
  void DidNotifySubtreeInsertionsToDocument() override;

  // Leaving the document removes the frame the page was attached to, and
  // content detaches the page. Drops every pipe to the browser, so it hides
  // the page and an element put back in the document (a move, as React's
  // `insertBefore` does) asks for it again from its new frame.
  void RemovedFrom(ContainerNode& insertion_point) override;

  // Requests a guest for the placeholder frame. Does nothing if there already
  // is one or there is no placeholder yet.
  void RequestGuest();

  // Sends the current `src` to the guest. Safe before the attach finishes.
  void NavigateGuest();

  // kIframe, not a new value: everything that switches on owner type should
  // treat this like an <iframe>, and a new value in this //content enum would
  // touch every such switch.
  FrameOwnerElementType OwnerType() const final {
    return FrameOwnerElementType::kIframe;
  }

  network::ParsedPermissionsPolicy ConstructContainerPolicy() const override;

  // domicile::mojom::blink::WebViewGuestClient:
  //
  // The browser sends these only on change, so each dispatches its event
  // unconditionally.
  void HistoryChanged(bool can_go_back, bool can_go_forward) override;
  void LoadingChanged(bool is_loading) override;
  void LoadProgressChanged(double progress) override;
  void PageChanged(const KURL& url,
                   domicile::mojom::blink::WebViewSecurity security) override;

  // Dispatches a chord the page did not handle as a KeyboardEvent on this
  // element. See UnhandledKeyDown in
  // components/domicile/mojom/web_view_guest.mojom.
  void UnhandledKeyDown(const String& key,
                        const String& code,
                        bool alt_key,
                        bool ctrl_key,
                        bool shift_key,
                        bool meta_key,
                        bool repeat) override;

  void ZoomChanged(double factor) override;

  void ZoomRequested(bool zoom_in) override;

  void FaviconChanged(const KURL& icon) override;

  void DescriptionChanged(const String& description) override;

  void TargetUrlChanged(const KURL& url) override;
  void TooltipChanged(const String& text, int32_t x, int32_t y) override;

  // Sent only on change, like HistoryChanged.
  void FindChanged(int32_t matches, int32_t active_match) override;
  void ContentSizeChanged(int32_t width, int32_t height) override;
  void PageFullscreenChanged(bool fullscreen) override;
  void WakeLockChanged(bool held) override;
  void RenderProcessChanged(domicile::mojom::blink::WebViewRenderProcess state,
                            int32_t exit_code) override;
  void PageFailureChanged(
      domicile::mojom::blink::WebViewPageFailurePtr failure) override;

  // Dispatches `domicile-file-chooser` for the shell to answer. If no listener
  // calls `preventDefault()`, the chooser is canceled after dispatch. See
  // domicile_file_chooser_event.h.
  void FileChooserRequested(
      domicile::mojom::blink::WebViewFileChooserMode mode,
      const Vector<String>& accept,
      const String& suggested_name,
      const String& home,
      const String& folder,
      FileChooserRequestedCallback callback) override;

  // Dispatches `domicile-permission-request`. If no listener calls
  // `preventDefault()`, the request is ignored after dispatch. See
  // domicile_permission_request_event.h.
  void PermissionRequested(
      const KURL& origin,
      const Vector<domicile::mojom::blink::WebViewPermission>& permissions,
      PermissionRequestedCallback callback) override;

  // Ignores the held request and dispatches
  // `domicile-permission-request-withdrawn`, so the shell stops showing it.
  void PermissionRequestWithdrawn() override;

  void SitePermissionsChanged(
      Vector<domicile::mojom::blink::WebViewSitePermissionPtr> permissions)
      override;

  // Dispatches `domicile-device-request`. If no listener calls
  // `preventDefault()`, the request is canceled after dispatch. See
  // domicile_device_request_event.h.
  void DeviceRequested(const String& title,
                       bool multiple,
                       DeviceRequestedCallback callback) override;

  // Gives the held request its devices and dispatches
  // `domicile-device-request-change`.
  void DevicesOffered(
      Vector<domicile::mojom::blink::WebViewDevicePtr> devices) override;

  // Cancels the held request and dispatches
  // `domicile-device-request-withdrawn`, so the shell stops showing it.
  void DeviceRequestWithdrawn() override;

  // Dispatches `domicile-dialog`. If no listener calls `preventDefault()`,
  // the dialog is dismissed after dispatch. See domicile_dialog_event.h.
  void DialogRequested(const KURL& origin,
                       domicile::mojom::blink::WebViewDialogType type,
                       const String& message,
                       const String& default_prompt,
                       DialogRequestedCallback callback) override;

  // Dismisses the held dialog and dispatches `domicile-dialog-withdrawn`, so
  // the shell stops showing it.
  void DialogWithdrawn() override;

  // Dispatches `domicile-external-app`. If no listener calls
  // `preventDefault()`, it is dismissed after dispatch. See
  // domicile_external_app_event.h.
  void ExternalAppRequested(const KURL& url,
                            const KURL& origin,
                            bool may_remember,
                            ExternalAppRequestedCallback callback) override;

  // Dispatches `domicile-sign-in`. If no listener calls `preventDefault()`,
  // it is dismissed after dispatch. See domicile_sign_in_event.h.
  void SignInRequested(const KURL& url,
                       const String& realm,
                       bool proxy,
                       bool secure,
                       SignInRequestedCallback callback) override;

  // Dismisses the held sign-in request and dispatches
  // `domicile-sign-in-withdrawn`, so the shell stops showing it.
  void SignInWithdrawn() override;

  // Dispatches `domicile-prompt`. If no listener calls `preventDefault()`, it
  // is dismissed after dispatch. See domicile_prompt_event.h.
  void PromptRequested(domicile::mojom::blink::WebViewPromptPtr prompt,
                       PromptRequestedCallback callback) override;

  // Dismisses the held prompt and dispatches `domicile-prompt-withdrawn`, so
  // the shell stops showing it.
  void PromptWithdrawn() override;
  // Dispatches `domicile-identity`. If no listener calls `preventDefault()`,
  // it is answered as unanswered after dispatch. See
  // domicile_identity_event.h.
  void IdentityRequested(
      domicile::mojom::blink::WebViewIdentityRequestPtr request,
      IdentityRequestedCallback callback) override;

  // Answers the held sign-in step as unanswered and dispatches
  // `domicile-identity-withdrawn`, so the shell stops showing it.
  void IdentityWithdrawn() override;
  void PickerRequested(domicile::mojom::blink::WebViewPickerPtr picker,
                       PickerRequestedCallback callback) override;
  void PickerWithdrawn() override;

  // Dispatches `domicile-will-navigate`; `preventDefault()` cancels. See
  // domicile_will_navigate_event.h.
  void WillNavigate(const KURL& url, WillNavigateCallback callback) override;

  // Dispatches `domicile-context-menu`. See domicile_context_menu_event.h.
  void ContextMenuRequested(
      domicile::mojom::blink::WebViewContextMenuPtr menu) override;

  // Dispatches `domicile-close` when the page called window.close(); the shell
  // removes the element. Only for elements without `window`, since the browser
  // closes browser windows itself.
  void CloseRequested() override;

  // Dispatches `domicile-focus-request` when an extension asks to raise this
  // window. The shell decides window order.
  void FocusRequested() override;

  // The `window` attribute for CreateGuest, or a null String if absent.
  String BrowserWindow() const;

  // The `partition` attribute for CreateGuest, or empty if absent.
  String Partition() const;

  // Kept open while the element is in the document: the browser may hold the
  // request on this pipe until the placeholder frame arrives. Reset on
  // removal, with the placeholder; see RemovedFrom. See WebViewGuestHost in
  // components/domicile/browser/web_view_guest.cc.
  HeapMojoRemote<domicile::mojom::blink::WebViewGuestHost> host_;

  // Bound once while in the document. A later `src` reuses it, since the
  // attach destroys the placeholder frame a second request would need. Reset
  // on removal; see RemovedFrom.
  HeapMojoRemote<domicile::mojom::blink::WebViewGuest> guest_;

  // Passed in CreateGuest, so the browser always has somewhere to report.
  HeapMojoReceiver<domicile::mojom::blink::WebViewGuestClient,
                   HTMLWebViewElement>
      client_receiver_;

  // The browser's last reports. Defaults match a fresh guest, for which the
  // browser sends nothing. `security_` is empty, not "neutral", until the
  // browser reports one.
  bool can_go_back_ = false;
  bool can_go_forward_ = false;
  bool loading_ = false;
  double load_progress_ = 0.0;
  String url_;
  String security_;
  double zoom_ = 1.0;
  String favicon_;
  String description_;
  String target_url_;
  String tooltip_;
  int32_t tooltip_x_ = 0;
  int32_t tooltip_y_ = 0;
  // On the document's `mousemove` while `target_url_` or `tooltip_` is set.
  // See
  // PointerMoved.
  Member<NativeEventListener> pointer_listener_;
  int32_t find_matches_ = 0;
  int32_t find_active_match_ = 0;
  int32_t content_width_ = 0;
  int32_t content_height_ = 0;
  bool page_fullscreen_ = false;
  bool wake_lock_ = false;
  String render_process_gone_;
  int32_t render_process_exit_code_ = 0;
  String page_failure_;
  String page_failure_url_;
  String page_failure_error_;
  int32_t page_failure_http_status_ = 0;
  bool page_failure_can_proceed_ = false;

  // The newest context menu dispatched; the browser acts only on it. 0 before
  // the first.
  int32_t context_menu_id_ = 0;

  // File chooser events the shell has not answered yet.
  //
  // Held so garbage collection cannot destroy the browser's reply callback
  // unrun, which would leave the page waiting forever.
  HeapHashSet<Member<DomicileFileChooserEvent>> waiting_choosers_;

  // The permission request the shell has not answered, if any. The browser
  // sends one at a time. Held for `waiting_choosers_`' reason.
  Member<DomicilePermissionRequestEvent> permission_request_;

  // The device request the shell has not answered, if any. The browser sends
  // one at a time. Held for `waiting_choosers_`' reason, and so DevicesOffered
  // reaches it.
  Member<DomicileDeviceRequestEvent> device_request_;

  // The dialog the shell has not answered, if any. The browser sends one at a
  // time. Held for `waiting_choosers_`' reason.
  Member<DomicileDialogEvent> dialog_;

  // The external app request the shell has not answered, if any. A newer one
  // replaces it. Held for `waiting_choosers_`' reason.
  Member<DomicileExternalAppEvent> external_app_;

  // The sign-in request the shell has not answered, if any. A newer one
  // replaces it. Held for `waiting_choosers_`' reason.
  Member<DomicileSignInEvent> sign_in_;

  // The prompt the shell has not answered, if any. A newer one replaces it.
  // Held for `waiting_choosers_`' reason.
  Member<DomicilePromptEvent> prompt_;
  // The open picker, held as `prompt_` is.
  Member<DomicilePickerEvent> picker_;
  // The sign-in step the shell shows, held as `prompt_` is.
  Member<DomicileIdentityEvent> identity_;

  // See sitePermissions().
  Vector<std::pair<String, String>> site_permissions_;
};

}  // namespace blink

#endif  // THIRD_PARTY_BLINK_RENDERER_CORE_HTML_DOMICILE_HTML_WEB_VIEW_ELEMENT_H_
