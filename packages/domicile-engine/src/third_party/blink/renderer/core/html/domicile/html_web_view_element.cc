// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "third_party/blink/renderer/core/html/domicile/html_web_view_element.h"

#include <cstdint>
#include <limits>
#include <optional>
#include <utility>

#include "base/functional/callback.h"
#include "base/logging.h"
#include "base/task/single_thread_task_runner.h"
#include "third_party/blink/public/common/page/page_zoom.h"
#include "third_party/blink/public/platform/browser_interface_broker_proxy.h"
#include "third_party/blink/public/platform/task_type.h"
#include "third_party/blink/renderer/bindings/core/v8/script_promise_resolver.h"
#include "third_party/blink/renderer/bindings/core/v8/v8_domicile_media_device.h"
#include "third_party/blink/renderer/bindings/core/v8/v8_domicile_media_devices.h"
#include "third_party/blink/renderer/bindings/core/v8/v8_keyboard_event_init.h"
#include "third_party/blink/renderer/core/dom/events/event.h"
#include "third_party/blink/renderer/core/event_type_names.h"
#include "third_party/blink/renderer/core/events/focus_event.h"
#include "third_party/blink/renderer/core/events/keyboard_event.h"
#include "third_party/blink/renderer/core/execution_context/execution_context.h"
#include "third_party/blink/renderer/core/frame/local_dom_window.h"
#include "third_party/blink/renderer/core/frame/local_frame.h"
#include "third_party/blink/renderer/core/html/domicile/domicile_context_menu_event.h"
#include "third_party/blink/renderer/core/html/domicile/domicile_device_request_event.h"
#include "third_party/blink/renderer/core/html/domicile/domicile_dialog_event.h"
#include "third_party/blink/renderer/core/html/domicile/domicile_external_app_event.h"
#include "third_party/blink/renderer/core/html/domicile/domicile_file_chooser_event.h"
#include "third_party/blink/renderer/core/html/domicile/domicile_identity_event.h"
#include "third_party/blink/renderer/core/html/domicile/domicile_permission_request_event.h"
#include "third_party/blink/renderer/core/html/domicile/domicile_picker_event.h"
#include "third_party/blink/renderer/core/html/domicile/domicile_prompt_event.h"
#include "third_party/blink/renderer/core/html/domicile/domicile_sign_in_event.h"
#include "third_party/blink/renderer/core/html/domicile/domicile_will_navigate_event.h"
#include "third_party/blink/renderer/core/html/parser/html_parser_idioms.h"
#include "third_party/blink/renderer/core/html_names.h"
#include "third_party/blink/renderer/core/layout/layout_iframe.h"
#include "third_party/blink/renderer/core/page/focus_controller.h"
#include "third_party/blink/renderer/core/page/page.h"
#include "third_party/blink/renderer/platform/bindings/exception_state.h"
#include "third_party/blink/renderer/platform/heap/garbage_collected.h"
#include "third_party/blink/renderer/platform/heap/persistent.h"
#include "third_party/blink/renderer/platform/weborigin/kurl.h"
#include "third_party/blink/renderer/platform/weborigin/security_origin.h"
#include "third_party/blink/renderer/platform/wtf/functional.h"

namespace blink {

// Event names. State events carry no detail: the state is readable on the
// element, so a shell that mounts late still sees it. The other end is
// packages/chrome-sdk/src/webview-element.ts.
//
// Char arrays, not AtomicStrings, because the atom table does not exist at
// static initialization.

// The guest took focus. Not `focus`; see SetFocused in the header.
constexpr char kGuestFocusEvent[] = "domicile-guest-focus";

// State changes.
constexpr char kHistoryChangeEvent[] = "domicile-history-change";
constexpr char kLoadingChangeEvent[] = "domicile-loading-change";
constexpr char kLoadProgressChangeEvent[] = "domicile-load-progress-change";
constexpr char kPageChangeEvent[] = "domicile-page-change";

// An unhandled chord, as a KeyboardEvent with its own type so shell `keydown`
// listeners do not mistake it for a key in the shell's document. The zoom
// requests encode direction in the name, so they stay plain Events.
constexpr char kGuestKeydownEvent[] = "domicile-guest-keydown";
constexpr char kZoomChangeEvent[] = "domicile-zoom-change";
constexpr char kZoomInRequestEvent[] = "domicile-zoom-in-request";
constexpr char kZoomOutRequestEvent[] = "domicile-zoom-out-request";

// More state changes.
constexpr char kFaviconChangeEvent[] = "domicile-favicon-change";
constexpr char kDescriptionChangeEvent[] = "domicile-description-change";
constexpr char kTargetUrlChangeEvent[] = "domicile-target-url-change";
constexpr char kTooltipChangeEvent[] = "domicile-tooltip-change";

namespace {

// The document's `mousemove`, for HTMLWebViewElement::PointerMoved.
class PointerMovedListener final : public NativeEventListener {
 public:
  explicit PointerMovedListener(base::RepeatingCallback<void(Event*)> moved)
      : moved_(std::move(moved)) {}

  void Invoke(ExecutionContext*, Event* event) override { moved_.Run(event); }

 private:
  const base::RepeatingCallback<void(Event*)> moved_;
};

}  // namespace
constexpr char kFindChangeEvent[] = "domicile-find-change";
constexpr char kContentSizeChangeEvent[] = "domicile-content-size-change";
constexpr char kPageFullscreenChangeEvent[] =
    "domicile-page-fullscreen-change";
constexpr char kWakeLockChangeEvent[] = "domicile-wake-lock-change";
constexpr char kRenderProcessChangeEvent[] = "domicile-render-process-change";
constexpr char kPageFailureChangeEvent[] = "domicile-page-failure-change";

// A request the shell answers on the event. See
// domicile_file_chooser_event.h.
constexpr char kFileChooserEvent[] = "domicile-file-chooser";

// See domicile_context_menu_event.h.
constexpr char kContextMenuEvent[] = "domicile-context-menu";

// A request the shell answers on the event, and its withdrawal. See
// domicile_permission_request_event.h.
constexpr char kPermissionRequestEvent[] = "domicile-permission-request";
constexpr char kPermissionRequestWithdrawnEvent[] =
    "domicile-permission-request-withdrawn";
constexpr char kSitePermissionsChangeEvent[] =
    "domicile-site-permissions-change";

// A request the shell answers on the event, a change to its devices, and its
// withdrawal. See domicile_device_request_event.h.
constexpr char kDeviceRequestEvent[] = "domicile-device-request";
constexpr char kDeviceRequestChangeEvent[] = "domicile-device-request-change";
constexpr char kDeviceRequestWithdrawnEvent[] =
    "domicile-device-request-withdrawn";

// A page's `alert()`, `confirm()` or `prompt()`, which the shell answers on
// the event, and its withdrawal. See domicile_dialog_event.h.
constexpr char kDialogEvent[] = "domicile-dialog";
constexpr char kDialogWithdrawnEvent[] = "domicile-dialog-withdrawn";

// A link for an application the shell answers on the event, and its
// withdrawal. See domicile_external_app_event.h.
constexpr char kExternalAppEvent[] = "domicile-external-app";
constexpr char kExternalAppWithdrawnEvent[] = "domicile-external-app-withdrawn";

// A sign-in a site or proxy asked for, which the shell answers on the event,
// and its withdrawal. See domicile_sign_in_event.h.
constexpr char kSignInEvent[] = "domicile-sign-in";
constexpr char kSignInWithdrawnEvent[] = "domicile-sign-in-withdrawn";

// A question Chrome would ask with its own dialog, which the shell answers on
// the event, and its withdrawal. See domicile_prompt_event.h.
constexpr char kPromptEvent[] = "domicile-prompt";
constexpr char kPickerEvent[] = "domicile-picker";
constexpr char kPickerWithdrawnEvent[] = "domicile-picker-withdrawn";
constexpr char kPromptWithdrawnEvent[] = "domicile-prompt-withdrawn";

// A step of a site's "Sign in with" request, which the shell answers on the
// event, and its withdrawal. See domicile_identity_event.h.
constexpr char kIdentityEvent[] = "domicile-identity";
constexpr char kIdentityWithdrawnEvent[] = "domicile-identity-withdrawn";

// The values of a site permission's setting. Strings, as for `security`.
constexpr char kSettingAsk[] = "ask";
constexpr char kSettingAllow[] = "allow";
constexpr char kSettingBlock[] = "block";

// The page is about to navigate. See domicile_will_navigate_event.h.
constexpr char kWillNavigateEvent[] = "domicile-will-navigate";

// The page called window.close().
constexpr char kCloseEvent[] = "domicile-close";
// An extension asked to raise this window.
constexpr char kFocusRequestEvent[] = "domicile-focus-request";

// Marks the <webview> as an extension action popup, so its guest is a popup
// rather than a tab. Read once, on requesting the guest; only presence
// matters.
constexpr char kExtensionPopupAttr[] = "extensionpopup";

// Makes the guest's page private: in the off-the-record profile. Read once,
// on requesting the guest; only presence matters.
constexpr char kPrivateAttr[] = "private";

// Gives the guest's page storage of its own: "persist:<name>" on disk, any
// other name in memory. Read once, on requesting the guest. See
// components/domicile/browser/web_view_partition.h.
constexpr char kPartitionAttr[] = "partition";

// Names the browser window a <webview> shows. Read once, on requesting the
// guest. Not in html_names, to avoid patching Chromium's list. See
// browser_windows.mojom.
constexpr char kWindowAttr[] = "window";

// The values of `security`, matching the omnibox's four levels. Strings, not
// an IDL enum; see the .idl.
constexpr char kSecurityNeutral[] = "neutral";
constexpr char kSecureSecurity[] = "secure";
constexpr char kSecurityWarning[] = "warning";
constexpr char kSecurityDangerous[] = "dangerous";

// Maps a site permission's setting to its string. No default, so a new mojom
// value breaks the build.
const char* SettingName(domicile::mojom::blink::WebViewPermissionSetting s) {
  switch (s) {
    case domicile::mojom::blink::WebViewPermissionSetting::kAsk:
      return kSettingAsk;
    case domicile::mojom::blink::WebViewPermissionSetting::kAllow:
      return kSettingAllow;
    case domicile::mojom::blink::WebViewPermissionSetting::kBlock:
      return kSettingBlock;
  }
}

// The setting named `name`, or nothing for an unknown name.
std::optional<domicile::mojom::blink::WebViewPermissionSetting> SettingNamed(
    const String& name) {
  for (const domicile::mojom::blink::WebViewPermissionSetting setting :
       {domicile::mojom::blink::WebViewPermissionSetting::kAsk,
        domicile::mojom::blink::WebViewPermissionSetting::kAllow,
        domicile::mojom::blink::WebViewPermissionSetting::kBlock}) {
    if (name == SettingName(setting)) {
      return setting;
    }
  }
  return std::nullopt;
}

// Whether `action` is an edit command, which acts on the focused frame. No
// default arm, so a new action fails the build.
bool IsEdit(domicile::mojom::blink::WebViewContextMenuAction action) {
  switch (action) {
    case domicile::mojom::blink::WebViewContextMenuAction::kUndo:
    case domicile::mojom::blink::WebViewContextMenuAction::kRedo:
    case domicile::mojom::blink::WebViewContextMenuAction::kCut:
    case domicile::mojom::blink::WebViewContextMenuAction::kCopy:
    case domicile::mojom::blink::WebViewContextMenuAction::kPaste:
    case domicile::mojom::blink::WebViewContextMenuAction::kPasteAndMatchStyle:
    case domicile::mojom::blink::WebViewContextMenuAction::kDelete:
    case domicile::mojom::blink::WebViewContextMenuAction::kSelectAll:
      return true;
    case domicile::mojom::blink::WebViewContextMenuAction::kCopyLinkAddress:
    case domicile::mojom::blink::WebViewContextMenuAction::kSaveLinkAs:
    case domicile::mojom::blink::WebViewContextMenuAction::kCopyImage:
    case domicile::mojom::blink::WebViewContextMenuAction::kCopyMediaAddress:
    case domicile::mojom::blink::WebViewContextMenuAction::kSaveMediaAs:
    case domicile::mojom::blink::WebViewContextMenuAction::kInspect:
      return false;
  }
}

// Maps the security level to its string. No default, so a new mojom value
// breaks the build.
const char* SecurityName(domicile::mojom::blink::WebViewSecurity security) {
  switch (security) {
    case domicile::mojom::blink::WebViewSecurity::kNeutral:
      return kSecurityNeutral;
    case domicile::mojom::blink::WebViewSecurity::kSecure:
      return kSecureSecurity;
    case domicile::mojom::blink::WebViewSecurity::kWarning:
      return kSecurityWarning;
    case domicile::mojom::blink::WebViewSecurity::kDangerous:
      return kSecurityDangerous;
  }
}

// Maps why the page's renderer went away to `renderProcessGone`. No default,
// so a new mojom value breaks the build. The names must match the browser's
// and the SDK's; scripts/test-render-process-reasons-agree.sh checks this.
const char* RenderProcessName(
    domicile::mojom::blink::WebViewRenderProcess state) {
  switch (state) {
    case domicile::mojom::blink::WebViewRenderProcess::kRunning:
      return "";
    case domicile::mojom::blink::WebViewRenderProcess::kCleanExit:
      return "clean-exit";
    case domicile::mojom::blink::WebViewRenderProcess::kAbnormalExit:
      return "abnormal-exit";
    case domicile::mojom::blink::WebViewRenderProcess::kKilled:
      return "killed";
    case domicile::mojom::blink::WebViewRenderProcess::kCrashed:
      return "crashed";
    case domicile::mojom::blink::WebViewRenderProcess::kOom:
      return "oom";
    case domicile::mojom::blink::WebViewRenderProcess::kLaunchFailed:
      return "launch-failed";
    case domicile::mojom::blink::WebViewRenderProcess::kMemoryEviction:
      return "memory-eviction";
  }
}

// Maps why the page failed to `pageFailure`. No default, so a new mojom value
// breaks the build. The names must match the SDK's.
const char* PageFailureName(
    domicile::mojom::blink::WebViewPageFailureKind kind) {
  switch (kind) {
    case domicile::mojom::blink::WebViewPageFailureKind::kNetwork:
      return "network";
    case domicile::mojom::blink::WebViewPageFailureKind::kHttp:
      return "http";
    case domicile::mojom::blink::WebViewPageFailureKind::kCertificate:
      return "certificate";
    case domicile::mojom::blink::WebViewPageFailureKind::kWarning:
      return "warning";
  }
}

HTMLWebViewElement::HTMLWebViewElement(Document& document)
    : HTMLFrameElementBase(html_names::kWebviewTag, document),
      // Null for a document with no window (e.g. a template's), which
      // HeapMojoRemote accepts. Nothing binds before there is a frame.
      host_(document.GetExecutionContext()),
      guest_(document.GetExecutionContext()),
      client_receiver_(this, document.GetExecutionContext()) {}

HTMLWebViewElement::~HTMLWebViewElement() = default;

void HTMLWebViewElement::Trace(Visitor* visitor) const {
  visitor->Trace(host_);
  visitor->Trace(guest_);
  visitor->Trace(client_receiver_);
  visitor->Trace(waiting_choosers_);
  visitor->Trace(permission_request_);
  visitor->Trace(device_request_);
  visitor->Trace(dialog_);
  visitor->Trace(external_app_);
  visitor->Trace(sign_in_);
  visitor->Trace(prompt_);
  visitor->Trace(identity_);
  visitor->Trace(picker_);
  visitor->Trace(pointer_listener_);
  HTMLFrameElementBase::Trace(visitor);
}

void HTMLWebViewElement::ParseAttribute(
    const AttributeModificationParams& params) {
  // `src` goes to the guest. The base would navigate the placeholder frame,
  // which must stay on about:blank.
  if (params.name == html_names::kSrcAttr) {
    NavigateGuest();
  } else {
    HTMLFrameElementBase::ParseAttribute(params);
  }
}

void HTMLWebViewElement::DidNotifySubtreeInsertionsToDocument() {
  // Creates the placeholder frame on about:blank, as AttachInnerWebContents
  // prefers (to avoid beforeunload problems).
  HTMLFrameElementBase::DidNotifySubtreeInsertionsToDocument();
  RequestGuest();
  // A parsed `src` arrived before there was a guest, so send it now. A browser
  // window's page is already loaded and gets no `src` on attach.
  if (BrowserWindow().IsNull()) {
    NavigateGuest();
  }
}

void HTMLWebViewElement::RemovedFrom(ContainerNode& insertion_point) {
  HTMLFrameElementBase::RemovedFrom(insertion_point);
  if (insertion_point.isConnected()) {
    host_.reset();
    guest_.reset();
    client_receiver_.reset();
  }
}

void HTMLWebViewElement::RequestGuest() {
  if (guest_.is_bound()) {
    return;
  }
  ExecutionContext* context = GetDocument().GetExecutionContext();
  if (!context) {
    return;
  }
  // The local about:blank placeholder. Absent when subframe loading is
  // disabled or the document has no frame.
  LocalFrame* placeholder = DynamicTo<LocalFrame>(ContentFrame());
  if (!placeholder) {
    return;
  }

  // Not moved into the calls below: argument evaluation order is unspecified,
  // so a moved-from runner could reach another pipe.
  const scoped_refptr<base::SingleThreadTaskRunner> task_runner =
      context->GetTaskRunner(TaskType::kInternalDefault);
  // Kept open; see `host_`.
  context->GetBrowserInterfaceBroker().GetInterface(
      host_.BindNewPipeAndPassReceiver(task_runner));
  // The client goes in the same message, so no early report from the guest
  // is lost.
  host_->CreateGuest(placeholder->GetLocalFrameToken(),
                     guest_.BindNewPipeAndPassReceiver(task_runner),
                     client_receiver_.BindNewPipeAndPassRemote(task_runner),
                     BrowserWindow(),
                     hasAttribute(AtomicString(kExtensionPopupAttr)),
                     hasAttribute(AtomicString(kPrivateAttr)), Partition());
}

String HTMLWebViewElement::BrowserWindow() const {
  return getAttribute(AtomicString(kWindowAttr));
}

String HTMLWebViewElement::Partition() const {
  const AtomicString& partition = getAttribute(AtomicString(kPartitionAttr));
  // Empty, not null, when absent: Mojo's string cannot be null.
  return partition.IsNull() ? g_empty_string : partition.GetString();
}

void HTMLWebViewElement::NavigateGuest() {
  if (!guest_.is_bound()) {
    return;
  }
  const AtomicString& source = FastGetAttribute(html_names::kSrcAttr);
  if (source.IsNull()) {
    return;
  }
  // Resolved against this document, like <iframe src>. An invalid URL is still
  // sent so the guest shows an error page, as an <iframe> would.
  guest_->Navigate(
      GetDocument().CompleteURL(StripLeadingAndTrailingHtmlSpaces(source)));
}

void HTMLWebViewElement::SetFocused(bool received,
                                    mojom::blink::FocusType type,
                                    BlurEventBehavior blur_event_behavior) {
  // Logged first and unconditionally, so a log shows whether this ran at all.
  LOG(INFO) << "domicile: <webview> SetFocused received=" << received;

  HTMLFrameElementBase::SetFocused(received, type, blur_event_behavior);
  if (received) {
    // Tell the browser first, so the active tab is updated before shell
    // handlers run. Unbound means no guest yet.
    if (guest_.is_bound()) {
      guest_->Focused();
    }
    DispatchSuppressedFocus(type);
    DispatchGuestFocus();
  }
}

void HTMLWebViewElement::DispatchSuppressedFocus(
    mojom::blink::FocusType type) {
  Page* page = GetDocument().GetPage();
  if (!page || page->GetFocusController().IsFocused()) {
    return;
  }
  LOG(INFO) << "domicile: dispatching the focus a <webview>'s guest took";
  // Stop if a handler moved focus away, as Document's dispatch does.
  DispatchFocusEvent(nullptr, type, nullptr);
  if (GetDocument().FocusedElement() != this) {
    return;
  }
  DispatchEvent(*FocusEvent::Create(event_type_names::kFocusin,
                                    Event::Bubbles::kYes,
                                    GetDocument().domWindow(), 0, nullptr,
                                    nullptr));
}

void HTMLWebViewElement::DispatchGuestFocus() {
  // These two log lines bracket the dispatch so a log separates "never ran"
  // from "ran but the page heard nothing". guard-webview-click.sh reads them.
  LOG(INFO) << "domicile: a <webview>'s guest took focus; announcing it";

  // Synchronous: Document::SetFocusedElement expects SetFocused to dispatch
  // events ("Element::setFocused for frames can dispatch events"), and
  // deferring loses the event.
  //
  // Bubbles so a shell can listen once on the window it drew. See
  // BrowserWindow.tsx in the Domicile repository.
  DispatchEvent(*Event::CreateBubble(AtomicString(kGuestFocusEvent)));

  // Closes the bracket: a missing second line means a handler never returned.
  LOG(INFO) << "domicile: announced a <webview>'s guest focus";
}

LayoutObject* HTMLWebViewElement::CreateLayoutObject(
    const ComputedStyle& style) {
  return MakeGarbageCollected<LayoutIFrame>(this);
}

network::ParsedPermissionsPolicy HTMLWebViewElement::ConstructContainerPolicy()
    const {
  // No `allow` attribute, so no features are delegated, as for an <iframe>
  // with no allow list. Delegating a feature should be an explicit change.
  return network::ParsedPermissionsPolicy();
}

// History controls, sent to the guest in the browser.
//
// Without a guest (the element is not in a document yet) they do nothing, as
// NavigateGuest does.
void HTMLWebViewElement::goBack() {
  if (guest_.is_bound()) {
    guest_->GoBack();
  }
}

void HTMLWebViewElement::goForward() {
  if (guest_.is_bound()) {
    guest_->GoForward();
  }
}

void HTMLWebViewElement::goBackInNewWindow() {
  if (guest_.is_bound()) {
    guest_->GoBackInNewWindow();
  }
}

void HTMLWebViewElement::goForwardInNewWindow() {
  if (guest_.is_bound()) {
    guest_->GoForwardInNewWindow();
  }
}

void HTMLWebViewElement::stop() {
  if (guest_.is_bound()) {
    guest_->Stop();
  }
}

void HTMLWebViewElement::reload() {
  if (guest_.is_bound()) {
    guest_->Reload();
  }
}

// Does not set `zoom_`: the browser's result may differ (e.g. another window
// on the site zooms), so only ZoomChanged updates it.
void HTMLWebViewElement::setZoom(double factor,
                                 ExceptionState& exception_state) {
  if (factor < kMinimumBrowserZoomFactor ||
      factor > kMaximumBrowserZoomFactor) {
    exception_state.ThrowRangeError(
        "The zoom factor must be between 0.25 and 5.");
    return;
  }
  if (guest_.is_bound()) {
    guest_->SetZoom(factor);
  }
}

// Results come from the browser, which counts across frames this renderer
// cannot see. Does nothing without a guest.
void HTMLWebViewElement::find(const String& text, bool backward) {
  if (guest_.is_bound()) {
    if (text.empty()) {
      // Empty text ends the find; content cannot search for nothing. See
      // WebViewGuest.Find.
      guest_->StopFinding(/*keep_selection=*/false);
    } else {
      guest_->Find(text, !backward);
    }
  }
}

void HTMLWebViewElement::stopFinding() {
  if (guest_.is_bound()) {
    guest_->StopFinding(/*keep_selection=*/true);
  }
}

// A no-op with no guest, like the history controls.
void HTMLWebViewElement::inspect() {
  if (guest_.is_bound()) {
    guest_->Inspect();
  }
}

// A no-op with no guest, like inspect().
void HTMLWebViewElement::print() {
  if (guest_.is_bound()) {
    guest_->Print();
  }
}

void HTMLWebViewElement::exitPageFullscreen() {
  if (guest_.is_bound()) {
    guest_->ExitPageFullscreen();
  }
}

void HTMLWebViewElement::proceedPastWarning() {
  if (guest_.is_bound()) {
    guest_->ProceedPastWarning();
  }
}

// Only the guest dispatches menus, so a guest exists here.
void HTMLWebViewElement::RunContextMenuAction(
    const DomicileContextMenuEvent& menu,
    domicile::mojom::blink::WebViewContextMenuAction action,
    ExceptionState& exception_state) {
  if (menu.id() != context_menu_id_) {
    exception_state.ThrowDOMException(
        DOMExceptionCode::kInvalidStateError,
        "A newer context menu has replaced this one.");
    return;
  }
  CHECK(guest_.is_bound());
  // Edits act on the focused element, but the shell's menu has focus. Refocus
  // the page first; the browser waits for it (WebViewGuest::EditWhenFocused).
  if (IsEdit(action)) {
    // Qualified: a frame owner's Focus(const FocusParams&) override hides the
    // no-argument overload.
    Element::Focus();
  }
  guest_->RunContextMenuAction(menu.id(), action);
}

// Does not change `site_permissions_`: the browser reports the stored result
// in SitePermissionsChanged.
void HTMLWebViewElement::setSitePermission(const String& permission,
                                           const String& setting,
                                           ExceptionState& exception_state) {
  const std::optional<domicile::mojom::blink::WebViewPermission> named =
      DomicilePermissionRequestEvent::PermissionNamed(permission);
  if (!named.has_value()) {
    exception_state.ThrowTypeError(String("Unknown permission: ") +
                                   permission + ".");
    return;
  }
  const std::optional<domicile::mojom::blink::WebViewPermissionSetting>
      stored = SettingNamed(setting);
  if (!stored.has_value()) {
    exception_state.ThrowTypeError(
        "A setting must be \"ask\", \"allow\" or \"block\".");
    return;
  }
  // Only a guest reports site permissions, so a guest exists past this.
  if (site_permissions_.empty()) {
    exception_state.ThrowDOMException(
        DOMExceptionCode::kInvalidStateError,
        "This page has no site permissions.");
    return;
  }
  CHECK(guest_.is_bound());
  guest_->SetSitePermission(*named, *stored);
}

namespace {

HeapVector<Member<DomicileMediaDevice>> Listed(
    const Vector<domicile::mojom::blink::WebViewMediaDevicePtr>& devices) {
  HeapVector<Member<DomicileMediaDevice>> listed;
  listed.reserve(devices.size());
  for (const auto& device : devices) {
    auto* entry = DomicileMediaDevice::Create();
    entry->setId(device->id);
    entry->setName(device->name);
    listed.push_back(entry);
  }
  return listed;
}

void ResolveMediaDevices(
    ScriptPromiseResolver<DomicileMediaDevices>* resolver,
    domicile::mojom::blink::WebViewMediaDevicesPtr devices) {
  auto* answer = DomicileMediaDevices::Create();
  answer->setCameras(Listed(devices->cameras));
  answer->setMicrophones(Listed(devices->microphones));
  resolver->Resolve(answer);
}

void SettleMediaDevice(ScriptPromiseResolver<IDLUndefined>* resolver,
                       const String& refusal) {
  if (refusal.IsNull()) {
    resolver->Resolve();
  } else {
    resolver->RejectWithDOMException(DOMExceptionCode::kNotFoundError,
                                     refusal);
  }
}

void SettleCount(ScriptPromiseResolver<IDLLong>* resolver,
                 std::optional<int32_t> count) {
  if (count.has_value()) {
    resolver->Resolve(*count);
  } else {
    resolver->RejectWithDOMException(DOMExceptionCode::kInvalidStateError,
                                     "The page gave no count.");
  }
}

std::optional<domicile::mojom::blink::WebViewMediaDeviceKind>
MediaDeviceKindNamed(const String& kind) {
  if (kind == "camera") {
    return domicile::mojom::blink::WebViewMediaDeviceKind::kCamera;
  }
  if (kind == "microphone") {
    return domicile::mojom::blink::WebViewMediaDeviceKind::kMicrophone;
  }
  return std::nullopt;
}

}  // namespace

// The preference is the profile's, so the browser answers the same for every
// element; the guest is only the way there.
ScriptPromise<DomicileMediaDevices> HTMLWebViewElement::mediaDevices(
    ScriptState* script_state,
    ExceptionState& exception_state) {
  if (!guest_.is_bound()) {
    exception_state.ThrowDOMException(DOMExceptionCode::kInvalidStateError,
                                      "This <webview> has no page yet.");
    return EmptyPromise();
  }
  auto* resolver =
      MakeGarbageCollected<ScriptPromiseResolver<DomicileMediaDevices>>(
          script_state, exception_state.GetContext());
  auto promise = resolver->Promise();
  guest_->ListMediaDevices(
      BindOnce(&ResolveMediaDevices, WrapPersistent(resolver)));
  return promise;
}

ScriptPromise<IDLUndefined> HTMLWebViewElement::setMediaDevice(
    ScriptState* script_state,
    const String& kind,
    const String& id,
    ExceptionState& exception_state) {
  const std::optional<domicile::mojom::blink::WebViewMediaDeviceKind> named =
      MediaDeviceKindNamed(kind);
  if (!named.has_value()) {
    exception_state.ThrowTypeError(
        "A kind must be \"camera\" or \"microphone\".");
    return EmptyPromise();
  }
  if (!guest_.is_bound()) {
    exception_state.ThrowDOMException(DOMExceptionCode::kInvalidStateError,
                                      "This <webview> has no page yet.");
    return EmptyPromise();
  }
  auto* resolver = MakeGarbageCollected<ScriptPromiseResolver<IDLUndefined>>(
      script_state, exception_state.GetContext());
  auto promise = resolver->Promise();
  guest_->SetMediaDevice(
      *named, id, BindOnce(&SettleMediaDevice, WrapPersistent(resolver)));
  return promise;
}

// The selector is parsed here first, against the shell's own document, so a
// bad one throws as querySelectorAll() does rather than rejecting later.
ScriptPromise<IDLLong> HTMLWebViewElement::countMatches(
    ScriptState* script_state,
    const String& selector,
    ExceptionState& exception_state) {
  GetDocument().QuerySelector(AtomicString(selector), exception_state);
  if (exception_state.HadException()) {
    return EmptyPromise();
  }
  if (!guest_.is_bound()) {
    exception_state.ThrowDOMException(DOMExceptionCode::kInvalidStateError,
                                      "This <webview> has no page yet.");
    return EmptyPromise();
  }
  auto* resolver = MakeGarbageCollected<ScriptPromiseResolver<IDLLong>>(
      script_state, exception_state.GetContext());
  auto promise = resolver->Promise();
  guest_->CountMatches(selector,
                       BindOnce(&SettleCount, WrapPersistent(resolver)));
  return promise;
}

// State updates store the new value before dispatching, so handlers read it.
void HTMLWebViewElement::HistoryChanged(bool can_go_back, bool can_go_forward) {
  can_go_back_ = can_go_back;
  can_go_forward_ = can_go_forward;

  // Bubbles, like the focus event.
  DispatchEvent(*Event::CreateBubble(AtomicString(kHistoryChangeEvent)));
}

void HTMLWebViewElement::LoadingChanged(bool is_loading) {
  loading_ = is_loading;

  DispatchEvent(*Event::CreateBubble(AtomicString(kLoadingChangeEvent)));
}

void HTMLWebViewElement::LoadProgressChanged(double progress) {
  load_progress_ = progress;

  DispatchEvent(*Event::CreateBubble(AtomicString(kLoadProgressChangeEvent)));
}

void HTMLWebViewElement::PageChanged(
    const KURL& url,
    domicile::mojom::blink::WebViewSecurity security) {
  // Set both before dispatching, so a handler never sees a new URL with the
  // old security level.
  url_ = url.GetString();
  security_ = String(SecurityName(security));

  DispatchEvent(*Event::CreateBubble(AtomicString(kPageChangeEvent)));
}

void HTMLWebViewElement::UnhandledKeyDown(const String& key,
                                          const String& code,
                                          bool alt_key,
                                          bool ctrl_key,
                                          bool shift_key,
                                          bool meta_key,
                                          bool repeat) {
  KeyboardEventInit* init = KeyboardEventInit::Create();
  init->setBubbles(true);
  init->setKey(key);
  init->setCode(code);
  init->setAltKey(alt_key);
  init->setCtrlKey(ctrl_key);
  init->setShiftKey(shift_key);
  init->setMetaKey(meta_key);
  init->setRepeat(repeat);
  DispatchEvent(*MakeGarbageCollected<KeyboardEvent>(
      AtomicString(kGuestKeydownEvent), init));
}

void HTMLWebViewElement::ZoomChanged(double factor) {
  zoom_ = factor;

  DispatchEvent(*Event::CreateBubble(AtomicString(kZoomChangeEvent)));
}

void HTMLWebViewElement::FaviconChanged(const KURL& icon) {
  favicon_ = icon.IsValid() ? icon.GetString() : String("");

  DispatchEvent(*Event::CreateBubble(AtomicString(kFaviconChangeEvent)));
}

void HTMLWebViewElement::DescriptionChanged(const String& description) {
  description_ = description;

  DispatchEvent(*Event::CreateBubble(AtomicString(kDescriptionChangeEvent)));
}

void HTMLWebViewElement::TargetUrlChanged(const KURL& url) {
  target_url_ = url.IsValid() ? url.GetString() : String("");
  UpdatePointerListener();

  DispatchEvent(*Event::CreateBubble(AtomicString(kTargetUrlChangeEvent)));
}

void HTMLWebViewElement::TooltipChanged(const String& text,
                                        int32_t x,
                                        int32_t y) {
  tooltip_ = text;
  tooltip_x_ = x;
  tooltip_y_ = y;
  UpdatePointerListener();

  DispatchEvent(*Event::CreateBubble(AtomicString(kTooltipChangeEvent)));
}

void HTMLWebViewElement::UpdatePointerListener() {
  // The guest's renderer reports nothing when the pointer leaves the page, but
  // the pointer then moves over this document.
  if (target_url_.empty() && tooltip_.empty()) {
    if (pointer_listener_) {
      GetDocument().removeEventListener(event_type_names::kMousemove,
                                        pointer_listener_.Get(),
                                        /*use_capture=*/false);
      pointer_listener_ = nullptr;
    }
  } else if (!pointer_listener_) {
    pointer_listener_ = MakeGarbageCollected<PointerMovedListener>(
        BindRepeating(&HTMLWebViewElement::PointerMoved,
                      WrapWeakPersistent(this)));
    GetDocument().addEventListener(event_type_names::kMousemove,
                                   pointer_listener_.Get());
  }
}

void HTMLWebViewElement::PointerMoved(Event* event) {
  // A move on this element is the pointer entering the page.
  if (event->target() != this && guest_.is_bound()) {
    guest_->PointerLeft();
  }
}

void HTMLWebViewElement::FindChanged(int32_t matches, int32_t active_match) {
  find_matches_ = matches;
  find_active_match_ = active_match;

  DispatchEvent(*Event::CreateBubble(AtomicString(kFindChangeEvent)));
}

void HTMLWebViewElement::ContentSizeChanged(int32_t width, int32_t height) {
  content_width_ = width;
  content_height_ = height;

  DispatchEvent(*Event::CreateBubble(AtomicString(kContentSizeChangeEvent)));
}

void HTMLWebViewElement::PageFullscreenChanged(bool fullscreen) {
  page_fullscreen_ = fullscreen;

  DispatchEvent(
      *Event::CreateBubble(AtomicString(kPageFullscreenChangeEvent)));
}

void HTMLWebViewElement::WakeLockChanged(bool held) {
  wake_lock_ = held;

  DispatchEvent(*Event::CreateBubble(AtomicString(kWakeLockChangeEvent)));
}

void HTMLWebViewElement::RenderProcessChanged(
    domicile::mojom::blink::WebViewRenderProcess state,
    int32_t exit_code) {
  // Set both before dispatching, so a handler reads a matching pair.
  render_process_gone_ = String(RenderProcessName(state));
  render_process_exit_code_ = exit_code;

  DispatchEvent(*Event::CreateBubble(AtomicString(kRenderProcessChangeEvent)));
}

void HTMLWebViewElement::PageFailureChanged(
    domicile::mojom::blink::WebViewPageFailurePtr failure) {
  // Set all before dispatching, so a handler reads a matching set.
  if (failure) {
    page_failure_ = String(PageFailureName(failure->kind));
    page_failure_url_ = failure->url.GetString();
    page_failure_error_ = failure->error;
    page_failure_http_status_ = failure->http_status;
    page_failure_can_proceed_ = failure->can_proceed;
  } else {
    page_failure_ = g_empty_string;
    page_failure_url_ = g_empty_string;
    page_failure_error_ = g_empty_string;
    page_failure_http_status_ = 0;
    page_failure_can_proceed_ = false;
  }

  DispatchEvent(*Event::CreateBubble(AtomicString(kPageFailureChangeEvent)));
}

void HTMLWebViewElement::ZoomRequested(bool zoom_in) {
  DispatchEvent(*Event::CreateBubble(
      AtomicString(zoom_in ? kZoomInRequestEvent : kZoomOutRequestEvent)));
}

// Held in `waiting_choosers_` until answered. If no listener calls
// `preventDefault()`, the shell has no picker, so cancel immediately.
void HTMLWebViewElement::FileChooserRequested(
    domicile::mojom::blink::WebViewFileChooserMode mode,
    const Vector<String>& accept,
    const String& suggested_name,
    const String& home,
    const String& folder,
    FileChooserRequestedCallback callback) {
  auto* event = MakeGarbageCollected<DomicileFileChooserEvent>(
      AtomicString(kFileChooserEvent), mode, accept, suggested_name, home,
      folder, std::move(callback), *this);
  waiting_choosers_.insert(event);
  DispatchEvent(*event);
  if (!event->defaultPrevented()) {
    event->CancelIfUnanswered();
  }
}

// Held in `permission_request_` until answered. If no listener calls
// `preventDefault()`, the shell draws no prompt, so ignore immediately.
void HTMLWebViewElement::PermissionRequested(
    const KURL& origin,
    const Vector<domicile::mojom::blink::WebViewPermission>& permissions,
    PermissionRequestedCallback callback) {
  // The browser withdraws a request before sending the next one. Answer a
  // stale one anyway, so its callback is never dropped unrun.
  if (permission_request_) {
    permission_request_->IgnoreIfUnanswered();
  }
  auto* event = MakeGarbageCollected<DomicilePermissionRequestEvent>(
      AtomicString(kPermissionRequestEvent),
      SecurityOrigin::Create(origin)->ToString(), permissions,
      std::move(callback), *this);
  permission_request_ = event;
  DispatchEvent(*event);
  if (!event->defaultPrevented()) {
    event->IgnoreIfUnanswered();
  }
}

// Only for a request still held: one the shell answered is already gone.
void HTMLWebViewElement::PermissionRequestWithdrawn() {
  if (permission_request_) {
    permission_request_->IgnoreIfUnanswered();
    DispatchEvent(
        *Event::CreateBubble(AtomicString(kPermissionRequestWithdrawnEvent)));
  }
}

void HTMLWebViewElement::PermissionRequestAnswered(
    DomicilePermissionRequestEvent& event) {
  if (permission_request_ == &event) {
    permission_request_ = nullptr;
  }
}

// Held in `device_request_` until answered. If no listener calls
// `preventDefault()`, the shell draws no chooser, so cancel immediately.
void HTMLWebViewElement::DeviceRequested(const String& title,
                                         bool multiple,
                                         DeviceRequestedCallback callback) {
  // The browser withdraws a request before sending the next one. Answer a
  // stale one anyway, so its callback is never dropped unrun.
  if (device_request_) {
    device_request_->CancelIfUnanswered();
  }
  auto* event = MakeGarbageCollected<DomicileDeviceRequestEvent>(
      AtomicString(kDeviceRequestEvent), title, multiple, std::move(callback),
      *this);
  device_request_ = event;
  DispatchEvent(*event);
  if (!event->defaultPrevented()) {
    event->CancelIfUnanswered();
  }
}

// Only for a request still held: devices for one already answered are stale.
void HTMLWebViewElement::DevicesOffered(
    Vector<domicile::mojom::blink::WebViewDevicePtr> devices) {
  if (device_request_) {
    device_request_->Offer(devices);
    DispatchEvent(
        *Event::CreateBubble(AtomicString(kDeviceRequestChangeEvent)));
  }
}

// Only for a request still held: one the shell answered is already gone.
void HTMLWebViewElement::DeviceRequestWithdrawn() {
  if (device_request_) {
    device_request_->CancelIfUnanswered();
    DispatchEvent(
        *Event::CreateBubble(AtomicString(kDeviceRequestWithdrawnEvent)));
  }
}

void HTMLWebViewElement::DeviceRequestAnswered(
    DomicileDeviceRequestEvent& event) {
  if (device_request_ == &event) {
    device_request_ = nullptr;
  }
}

// Held in `dialog_` until answered. If no listener calls `preventDefault()`,
// the shell shows nothing, so answer immediately (AnswerUnclaimed).
void HTMLWebViewElement::DialogRequested(
    const KURL& origin,
    domicile::mojom::blink::WebViewDialogType type,
    const String& message,
    const String& default_prompt,
    DialogRequestedCallback callback) {
  // The browser withdraws a dialog before sending the next one. Answer a stale
  // one anyway, so its callback is never dropped unrun.
  if (dialog_) {
    dialog_->DismissIfUnanswered();
  }
  auto* event = MakeGarbageCollected<DomicileDialogEvent>(
      AtomicString(kDialogEvent), type,
      SecurityOrigin::Create(origin)->ToString(), message, default_prompt,
      std::move(callback), *this);
  dialog_ = event;
  DispatchEvent(*event);
  if (!event->defaultPrevented()) {
    event->AnswerUnclaimed();
  }
}

// Only for a dialog still held: one the shell answered is already gone.
void HTMLWebViewElement::DialogWithdrawn() {
  if (dialog_) {
    dialog_->DismissIfUnanswered();
    DispatchEvent(*Event::CreateBubble(AtomicString(kDialogWithdrawnEvent)));
  }
}

// Answered when dispatch returns, so the navigation waits only on the shell's
// listeners.
void HTMLWebViewElement::WillNavigate(const KURL& url,
                                      WillNavigateCallback callback) {
  auto* event = MakeGarbageCollected<DomicileWillNavigateEvent>(
      AtomicString(kWillNavigateEvent), url.GetString());
  DispatchEvent(*event);
  std::move(callback).Run(!event->defaultPrevented());
}

// Held in `external_app_` until answered. A newer request replaces an older
// one, which opens nothing and is withdrawn from the shell first.
void HTMLWebViewElement::ExternalAppRequested(
    const KURL& url,
    const KURL& origin,
    bool may_remember,
    ExternalAppRequestedCallback callback) {
  if (external_app_) {
    external_app_->DismissIfUnanswered();
    DispatchEvent(
        *Event::CreateBubble(AtomicString(kExternalAppWithdrawnEvent)));
  }
  auto* event = MakeGarbageCollected<DomicileExternalAppEvent>(
      AtomicString(kExternalAppEvent), url.GetString(),
      origin.IsValid() ? SecurityOrigin::Create(origin)->ToString()
                       : g_empty_string,
      may_remember, std::move(callback), *this);
  external_app_ = event;
  DispatchEvent(*event);
  if (!event->defaultPrevented()) {
    event->DismissIfUnanswered();
  }
}

void HTMLWebViewElement::ExternalAppAnswered(DomicileExternalAppEvent& event) {
  if (external_app_ == &event) {
    external_app_ = nullptr;
  }
}

// Held in `sign_in_` until answered. A newer request replaces an older one,
// which is canceled and withdrawn from the shell first.
void HTMLWebViewElement::SignInRequested(const KURL& url,
                                         const String& realm,
                                         bool proxy,
                                         bool secure,
                                         SignInRequestedCallback callback) {
  if (sign_in_) {
    sign_in_->DismissIfUnanswered();
    DispatchEvent(*Event::CreateBubble(AtomicString(kSignInWithdrawnEvent)));
  }
  auto* event = MakeGarbageCollected<DomicileSignInEvent>(
      AtomicString(kSignInEvent), url.GetString(), realm, proxy, secure,
      std::move(callback), *this);
  sign_in_ = event;
  DispatchEvent(*event);
  if (!event->defaultPrevented()) {
    event->DismissIfUnanswered();
  }
}

// Only for a request still held: one the shell answered is already gone.
void HTMLWebViewElement::SignInWithdrawn() {
  if (sign_in_) {
    sign_in_->DismissIfUnanswered();
    DispatchEvent(*Event::CreateBubble(AtomicString(kSignInWithdrawnEvent)));
  }
}

void HTMLWebViewElement::SignInAnswered(DomicileSignInEvent& event) {
  if (sign_in_ == &event) {
    sign_in_ = nullptr;
  }
}

// Held in `prompt_` until answered. A newer prompt replaces an older one,
// which is answered no and withdrawn from the shell first.
void HTMLWebViewElement::PromptRequested(
    domicile::mojom::blink::WebViewPromptPtr prompt,
    PromptRequestedCallback callback) {
  if (prompt_) {
    prompt_->DismissIfUnanswered();
    DispatchEvent(*Event::CreateBubble(AtomicString(kPromptWithdrawnEvent)));
  }
  auto* event = MakeGarbageCollected<DomicilePromptEvent>(
      AtomicString(kPromptEvent), *prompt, std::move(callback), *this);
  prompt_ = event;
  DispatchEvent(*event);
  if (!event->defaultPrevented()) {
    event->DismissIfUnanswered();
  }
}

// Only for a prompt still held: one the shell answered is already gone.
void HTMLWebViewElement::PromptWithdrawn() {
  if (prompt_) {
    prompt_->DismissIfUnanswered();
    DispatchEvent(*Event::CreateBubble(AtomicString(kPromptWithdrawnEvent)));
  }
}

void HTMLWebViewElement::PromptAnswered(DomicilePromptEvent& event) {
  if (prompt_ == &event) {
    prompt_ = nullptr;
  }
}

// Held in `identity_` until answered. The next step replaces the one shown,
// which is answered as unanswered and withdrawn from the shell first.
void HTMLWebViewElement::IdentityRequested(
    domicile::mojom::blink::WebViewIdentityRequestPtr request,
    IdentityRequestedCallback callback) {
  if (identity_) {
    identity_->NoneIfUnanswered();
    DispatchEvent(*Event::CreateBubble(AtomicString(kIdentityWithdrawnEvent)));
  }
  auto* event = MakeGarbageCollected<DomicileIdentityEvent>(
      AtomicString(kIdentityEvent), std::move(request), std::move(callback),
      *this);
  identity_ = event;
  DispatchEvent(*event);
  if (!event->defaultPrevented()) {
    event->NoneIfUnanswered();
  }
}

// Only for a step still held: one the shell answered is already gone.
void HTMLWebViewElement::IdentityWithdrawn() {
  if (identity_) {
    identity_->NoneIfUnanswered();
    DispatchEvent(*Event::CreateBubble(AtomicString(kIdentityWithdrawnEvent)));
  }
}

void HTMLWebViewElement::IdentityAnswered(DomicileIdentityEvent& event) {
  if (identity_ == &event) {
    identity_ = nullptr;
  }
}

void HTMLWebViewElement::PickerRequested(
    domicile::mojom::blink::WebViewPickerPtr picker,
    PickerRequestedCallback callback) {
  if (picker_) {
    picker_->CancelIfUnanswered();
    DispatchEvent(*Event::CreateBubble(AtomicString(kPickerWithdrawnEvent)));
  }
  auto* event = MakeGarbageCollected<DomicilePickerEvent>(
      AtomicString(kPickerEvent), *picker, std::move(callback), *this);
  picker_ = event;
  DispatchEvent(*event);
  if (!event->defaultPrevented()) {
    event->CancelIfUnanswered();
  }
}

void HTMLWebViewElement::PickerWithdrawn() {
  if (picker_) {
    picker_->CancelIfUnanswered();
    DispatchEvent(*Event::CreateBubble(AtomicString(kPickerWithdrawnEvent)));
  }
}

void HTMLWebViewElement::PickerAnswered(DomicilePickerEvent& event) {
  if (picker_ == &event) {
    picker_ = nullptr;
  }
}

void HTMLWebViewElement::DialogAnswered(DomicileDialogEvent& event) {
  if (dialog_ == &event) {
    dialog_ = nullptr;
  }
}

void HTMLWebViewElement::SitePermissionsChanged(
    Vector<domicile::mojom::blink::WebViewSitePermissionPtr> permissions) {
  site_permissions_.clear();
  for (const auto& permission : permissions) {
    site_permissions_.push_back(std::make_pair(
        DomicilePermissionRequestEvent::PermissionName(permission->permission),
        String(SettingName(permission->setting))));
  }

  DispatchEvent(
      *Event::CreateBubble(AtomicString(kSitePermissionsChangeEvent)));
}

// Stored before dispatch, so a handler can run the menu immediately.
void HTMLWebViewElement::ContextMenuRequested(
    domicile::mojom::blink::WebViewContextMenuPtr menu) {
  context_menu_id_ = menu->id;
  DispatchEvent(*MakeGarbageCollected<DomicileContextMenuEvent>(
      AtomicString(kContextMenuEvent), std::move(menu), *this));
}

// Bubbles, like the state events.
void HTMLWebViewElement::CloseRequested() {
  DispatchEvent(*Event::CreateBubble(AtomicString(kCloseEvent)));
}

// Bubbles, like CloseRequested.
void HTMLWebViewElement::FocusRequested() {
  DispatchEvent(*Event::CreateBubble(AtomicString(kFocusRequestEvent)));
}

void HTMLWebViewElement::FileChooserAnswered(DomicileFileChooserEvent& event) {
  waiting_choosers_.erase(&event);
}

}  // namespace blink
