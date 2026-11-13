// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "third_party/blink/renderer/modules/domicile/domicile_host.h"

#include <algorithm>
#include <cmath>
#include <optional>
#include <string_view>
#include <utility>
#include <vector>

#include "base/check.h"
#include "base/functional/callback.h"
#include "base/functional/callback_helpers.h"
#include "base/notreached.h"
#include "base/numerics/safe_conversions.h"
#include "ui/events/keycodes/dom/keycode_converter.h"
#include "ui/gfx/geometry/rect_f.h"
#include "ui/gfx/geometry/size.h"
#include "components/domicile/common/cursor_shape.h"
#include "components/domicile/common/display_transform.h"
#include "components/domicile/common/theme.h"
#include "third_party/blink/renderer/bindings/core/v8/frozen_array.h"
#include "third_party/blink/renderer/bindings/core/v8/script_value.h"
#include "third_party/blink/renderer/bindings/core/v8/v8_binding_for_core.h"
#include "third_party/blink/renderer/bindings/core/v8/v8_object_builder.h"
#include "third_party/blink/renderer/bindings/modules/v8/v8_domicile_cursor_shape.h"
#include "third_party/blink/renderer/bindings/modules/v8/v8_domicile_download_state.h"
#include "third_party/blink/renderer/bindings/modules/v8/v8_domicile_fetch_header.h"
#include "third_party/blink/renderer/bindings/modules/v8/v8_domicile_fetch_response.h"
#include "third_party/blink/renderer/bindings/modules/v8/v8_domicile_file_search.h"
#include "third_party/blink/renderer/bindings/modules/v8/v8_domicile_theme.h"
#include "third_party/blink/renderer/core/css/media_query_list.h"
#include "third_party/blink/renderer/core/css/media_query_list_listener.h"
#include "third_party/blink/renderer/core/dom/document.h"
#include "third_party/blink/renderer/core/dom/element_traversal.h"
#include "third_party/blink/renderer/core/dom/events/custom_event.h"
#include "third_party/blink/renderer/core/dom/events/native_event_listener.h"
#include "third_party/blink/renderer/core/events/keyboard_event.h"
#include "third_party/blink/renderer/core/geometry/dom_rect_read_only.h"
#include "third_party/blink/renderer/core/inspector/console_message.h"
#include "third_party/blink/renderer/core/event_target_names.h"
#include "third_party/blink/renderer/core/event_type_names.h"
#include "third_party/blink/renderer/core/events/message_event.h"
#include "third_party/blink/renderer/core/frame/local_dom_window.h"
#include "third_party/blink/renderer/core/frame/local_frame.h"
#include "third_party/blink/renderer/core/html_names.h"
#include "third_party/blink/renderer/modules/domicile/domicile_app_event.h"
#include "third_party/blink/renderer/modules/domicile/domicile_clipboard_entry.h"
#include "third_party/blink/renderer/modules/domicile/domicile_browser_window.h"
#include "third_party/blink/renderer/modules/domicile/domicile_cast_sink.h"
#include "third_party/blink/renderer/modules/domicile/domicile_picture_in_picture_video.h"
#include "third_party/blink/renderer/modules/domicile/domicile_display.h"
#include "third_party/blink/renderer/modules/domicile/domicile_download.h"
#include "third_party/blink/renderer/modules/domicile/domicile_extension.h"
#include "third_party/blink/renderer/modules/domicile/domicile_extension_popup_event.h"
#include "third_party/blink/renderer/modules/domicile/domicile_notification.h"
#include "third_party/blink/renderer/modules/domicile/domicile_notification_action.h"
#include "third_party/blink/renderer/modules/domicile/domicile_gesture_event.h"
#include "third_party/blink/renderer/modules/domicile/domicile_shortcut_event.h"
#include "third_party/blink/renderer/modules/domicile/domicile_tray_item.h"
#include "third_party/blink/renderer/modules/domicile/domicile_window.h"
#include "third_party/blink/renderer/platform/bindings/exception_code.h"
#include "third_party/blink/renderer/platform/heap/garbage_collected.h"
#include "third_party/blink/renderer/platform/heap/persistent.h"
#include "third_party/blink/renderer/platform/json/json_parser.h"
#include "third_party/blink/renderer/platform/json/json_values.h"
#include "third_party/blink/renderer/platform/weborigin/kurl.h"
#include "third_party/blink/renderer/platform/wtf/functional.h"
#include "third_party/blink/renderer/platform/wtf/text/string_builder.h"

namespace blink {

namespace {

// `resize` on the shell's window, which is the desktop changing size.
class DesktopResized final : public NativeEventListener {
 public:
  explicit DesktopResized(base::RepeatingClosure report)
      : report_(std::move(report)) {}

  void Invoke(ExecutionContext*, Event*) override { report_.Run(); }

 private:
  const base::RepeatingClosure report_;
};

// The Linux evdev key a key event is on, from its DOM `code`; zero or less
// for a code with none.
int EvdevOf(const KeyboardEvent& key) {
  return ui::KeycodeConverter::DomCodeToEvdevCode(
      ui::KeycodeConverter::CodeStringToDomCode(key.code().Utf8()));
}

// The events an <app> dispatches for the shell to answer. Not the desktop's
// own names -- they are dispatched on the element, not on the desktop, and the
// SDK names them -- so they are not in domicile_event_names.h.
constexpr char kFocusRequested[] = "domicile-focus-requested";
constexpr char kFocusReleaseRequested[] = "domicile-focus-release-requested";

// The events an <app> dispatches to tell the shell about its window.
constexpr char kPresented[] = "domicile-presented";
constexpr char kSuspended[] = "domicile-suspended";
constexpr char kResumed[] = "domicile-resumed";

// Something happened on the page: a key went down or up, a press, a blur.
class PageHeard final : public NativeEventListener {
 public:
  explicit PageHeard(base::RepeatingCallback<void(Event*)> heard)
      : heard_(std::move(heard)) {}

  void Invoke(ExecutionContext*, Event* event) override { heard_.Run(event); }

 private:
  const base::RepeatingCallback<void(Event*)> heard_;
};

// The ratio the last report named stopped matching: the window moved to a
// display of another density, or the page was zoomed.
class DensityChanged final : public MediaQueryListListener {
 public:
  explicit DensityChanged(base::RepeatingClosure report)
      : report_(std::move(report)) {}

  void NotifyMediaQueryChanged() override { report_.Run(); }

 private:
  const base::RepeatingClosure report_;
};

// A grabbed gesture as written, `swipe:3`: its kind, and its fingers or 0 for
// any. Sway's grammar without the direction, which the SDK matches on the
// gesture's motion. Two fingers are the page's.
//
// Or `edge:left`: one touchscreen finger in from that side of a display, or
// from any side for `edge`. The engine withholds a finger landing on a side
// grabbed, so the side is the grab's.
struct WrittenGesture {
  domicile::mojom::blink::GestureKind kind;
  uint32_t fingers = 0;
  std::optional<domicile::mojom::blink::GestureEdge> edge;
};

std::optional<WrittenGesture> ParseEdge(const String& written,
                                        const String& side,
                                        String* error) {
  WrittenGesture gesture{domicile::mojom::blink::GestureKind::kEdge, 1};
  if (side.IsNull()) {
    return gesture;
  }
  if (side == "left") {
    gesture.edge = domicile::mojom::blink::GestureEdge::kLeft;
  } else if (side == "right") {
    gesture.edge = domicile::mojom::blink::GestureEdge::kRight;
  } else if (side == "top") {
    gesture.edge = domicile::mojom::blink::GestureEdge::kTop;
  } else if (side == "bottom") {
    gesture.edge = domicile::mojom::blink::GestureEdge::kBottom;
  } else {
    *error = "gesture \"" + written + "\": \"" + side +
             "\" is not an edge; write left, right, top or bottom";
    return std::nullopt;
  }
  return gesture;
}

std::optional<WrittenGesture> ParseGesture(const String& written,
                                           String* error) {
  const wtf_size_t colon = written.find(':');
  const String name = colon == kNotFound ? written : written.substr(0, colon);
  const String count =
      colon == kNotFound ? String() : written.substr(colon + 1);
  if (name == "edge") {
    return ParseEdge(written, count, error);
  }
  WrittenGesture gesture;
  if (name == "swipe") {
    gesture.kind = domicile::mojom::blink::GestureKind::kSwipe;
  } else if (name == "pinch") {
    gesture.kind = domicile::mojom::blink::GestureKind::kPinch;
  } else if (name == "hold") {
    gesture.kind = domicile::mojom::blink::GestureKind::kHold;
  } else {
    *error = "gesture \"" + written +
             "\" is not a swipe, pinch, hold or edge; write it as `swipe:3`";
    return std::nullopt;
  }
  if (count.IsNull()) {
    return gesture;
  }
  if (count.length() != 1 || count[0] < '0' || count[0] > '9') {
    *error = "gesture \"" + written + "\": \"" + count +
             "\" is not a number of fingers";
    return std::nullopt;
  }
  gesture.fingers = count[0] - '0';
  if (gesture.fingers < 3) {
    *error = "gesture \"" + written +
             "\": two fingers are the page's; bind three or more";
    return std::nullopt;
  }
  return gesture;
}

String GestureKindName(domicile::mojom::blink::GestureKind kind) {
  switch (kind) {
    case domicile::mojom::blink::GestureKind::kSwipe:
      return "swipe";
    case domicile::mojom::blink::GestureKind::kPinch:
      return "pinch";
    case domicile::mojom::blink::GestureKind::kHold:
      return "hold";
    case domicile::mojom::blink::GestureKind::kEdge:
      return "edge";
  }
  NOTREACHED();
}

String GestureEdgeName(
    std::optional<domicile::mojom::blink::GestureEdge> edge) {
  if (!edge) {
    return g_empty_string;
  }
  switch (*edge) {
    case domicile::mojom::blink::GestureEdge::kLeft:
      return "left";
    case domicile::mojom::blink::GestureEdge::kRight:
      return "right";
    case domicile::mojom::blink::GestureEdge::kTop:
      return "top";
    case domicile::mojom::blink::GestureEdge::kBottom:
      return "bottom";
  }
  NOTREACHED();
}

String GesturePhaseName(domicile::mojom::blink::GesturePhase phase) {
  switch (phase) {
    case domicile::mojom::blink::GesturePhase::kBegin:
      return "begin";
    case domicile::mojom::blink::GesturePhase::kUpdate:
      return "update";
    case domicile::mojom::blink::GesturePhase::kEnd:
      return "end";
  }
  NOTREACHED();
}

}  // namespace

DomicileHost::DomicileHost(LocalDOMWindow& window)
    : AppInputClient(window),
      window_(&window),
      // `displays_` is left null: a shell that has not been told about a
      // desktop must be able to tell that apart from one told there are no
      // screens. See the attribute's note in the IDL.
      //
      // Initialized in declaration order, which is not a style point here:
      // Chromium builds -Wreorder -Werror, so a list out of order is a build
      // failure rather than a warning.
      channel_(&window),
      client_receiver_(this, &window),
      tray_(&window),
      tray_receiver_(this, &window),
      windows_(&window),
      windows_receiver_(this, &window),
      cast_(&window),
      cast_receiver_(this, &window),
      downloads_remote_(&window),
      downloads_receiver_(this, &window),
      picture_in_picture_(&window),
      picture_in_picture_receiver_(this, &window),
      shell_fetch_(&window) {}

DomicileHost::~DomicileHost() = default;

bool DomicileHost::EnsureBound() {
  if (channel_.is_bound()) {
    return true;
  }
  if (!window_ || !window_->GetFrame()) {
    return false;
  }
  auto task_runner = window_->GetTaskRunner(TaskType::kInternalDefault);
  window_->GetBrowserInterfaceBroker().GetInterface(
      channel_.BindNewPipeAndPassReceiver(task_runner));
  if (!channel_.is_bound()) {
    return false;
  }

  // Hand back the other direction in the same breath. A channel bound without
  // a client is one the compositor can be heard on by nobody, and every
  // inbound message would be dropped in the browser with no way to tell.
  channel_->SetClient(
      client_receiver_.BindNewPipeAndPassRemote(task_runner));

  // AND THE TRAY, IN THE SAME BREATH, for the same reason: listening is what
  // binds, and a page listening for `extensions` is told the tray as soon as
  // this pipe carries its client. Its own pipe because an action is this
  // browser's, not the compositor's -- see extension_tray.mojom.
  window_->GetBrowserInterfaceBroker().GetInterface(
      tray_.BindNewPipeAndPassReceiver(task_runner));
  tray_->SetClient(tray_receiver_.BindNewPipeAndPassRemote(task_runner));

  ReportGeometry();

  // The browser windows, bound eagerly for the tray's reason. The list arrives
  // as soon as this pipe carries its client; after `domicile load-shell` it
  // holds every window the last shell had open. See browser_windows.mojom.
  window_->GetBrowserInterfaceBroker().GetInterface(
      windows_.BindNewPipeAndPassReceiver(task_runner));
  windows_->SetClient(windows_receiver_.BindNewPipeAndPassRemote(task_runner));

  // The TVs, bound eagerly too: the shell shows a Cast item only while one is
  // near, so it must hear of them unasked. Its client starts the browser's
  // discovery. See cast_sinks.mojom.
  window_->GetBrowserInterfaceBroker().GetInterface(
      cast_.BindNewPipeAndPassReceiver(task_runner));
  cast_->SetClient(cast_receiver_.BindNewPipeAndPassRemote(task_runner));

  // The downloads, bound eagerly too: the shell shows a downloads item only
  // while there are any, so it must hear of them unasked. See downloads.mojom.
  window_->GetBrowserInterfaceBroker().GetInterface(
      downloads_remote_.BindNewPipeAndPassReceiver(task_runner));
  downloads_remote_->SetClient(
      downloads_receiver_.BindNewPipeAndPassRemote(task_runner));

  // The videos in picture-in-picture, bound eagerly too: a page puts one there
  // unasked, and only the shell draws it. See picture_in_picture.mojom.
  window_->GetBrowserInterfaceBroker().GetInterface(
      picture_in_picture_.BindNewPipeAndPassReceiver(task_runner));
  picture_in_picture_->SetClient(
      picture_in_picture_receiver_.BindNewPipeAndPassRemote(task_runner));
  return true;
}

void DomicileHost::ReportGeometry() {
  // WrapWeakPersistent: the listeners belong to the window and its media
  // queries, which can outlive nothing here, but a callback that kept this
  // host alive would keep the channel open for a document that is gone.
  resize_listener_ = MakeGarbageCollected<DesktopResized>(BindRepeating(
      &DomicileHost::ReportDesktopSize, WrapWeakPersistent(this)));
  density_listener_ = MakeGarbageCollected<DensityChanged>(BindRepeating(
      &DomicileHost::ReportDevicePixelRatio, WrapWeakPersistent(this)));
  window_->addEventListener(event_type_names::kResize, resize_listener_.Get());
  ReportDevicePixelRatio();
  ReportDesktopSize();
}

void DomicileHost::ReportDesktopSize() {
  if (!window_ || !channel_.is_bound()) {
    return;
  }
  // CSS pixels, which are the compositor's logical units. The density goes
  // separately and the compositor multiplies.
  channel_->SetDesktopSize(window_->innerWidth(), window_->innerHeight());
}

void DomicileHost::ReportDevicePixelRatio() {
  if (!window_ || !channel_.is_bound()) {
    return;
  }
  const double ratio = window_->devicePixelRatio();
  // Zero or less is not a scale, and the compositor would divide by it.
  if (!(ratio > 0)) {
    return;
  }
  channel_->SetDevicePixelRatio(ratio);

  if (density_query_) {
    density_query_->RemoveListener(density_listener_.Get());
  }
  StringBuilder query;
  query.Append("(resolution: ");
  query.AppendNumber(ratio);
  query.Append("dppx)");
  density_query_ = window_->matchMedia(query.ToString());
  density_query_->AddListener(density_listener_.Get());
}

const FrozenArray<DomicileWindow>& DomicileHost::windows() {
  EnsureBound();
  if (!client_windows_) {
    client_windows_ = MakeGarbageCollected<FrozenArray<DomicileWindow>>(
        HeapVector<Member<DomicileWindow>>());
  }
  return *client_windows_;
}

const FrozenArray<DomicileClipboardEntry>* DomicileHost::clipboard() const {
  return clipboard_.Get();
}

const FrozenArray<DomicileTrayItem>* DomicileHost::tray() const {
  return tray_items_.Get();
}

const FrozenArray<DomicileNotification>* DomicileHost::notifications() const {
  return notifications_.Get();
}

const FrozenArray<DomicileExtension>* DomicileHost::extensions() const {
  return extensions_.Get();
}

std::optional<bool> DomicileHost::idle() const {
  return idle_;
}

std::optional<bool> DomicileHost::locked() const {
  return locked_;
}

std::optional<V8DomicileTheme> DomicileHost::theme() const {
  return theme_;
}

std::optional<V8DomicileTheme> DomicileHost::windowsTheme() const {
  return windows_theme_;
}

std::optional<bool> DomicileHost::altKey() const {
  return alt_key_;
}

std::optional<bool> DomicileHost::ctrlKey() const {
  return ctrl_key_;
}

std::optional<bool> DomicileHost::shiftKey() const {
  return shift_key_;
}

std::optional<bool> DomicileHost::metaKey() const {
  return meta_key_;
}

std::optional<bool> DomicileHost::highContrast() const {
  return high_contrast_;
}

std::optional<bool> DomicileHost::reducedMotion() const {
  return reduced_motion_;
}

DomicileWindowState& DomicileHost::WindowNamed(const String& app_id) {
  for (DomicileWindowState& state : window_states_) {
    if (state.app_id == app_id) {
      return state;
    }
  }
  DomicileWindowState state;
  state.app_id = app_id;
  window_states_.push_back(std::move(state));
  return window_states_.back();
}

namespace {

// Enough for every address and focus request a shell could plausibly miss
// while it loads, and few enough that a page that never listens costs nothing.
constexpr wtf_size_t kMostHeld = 64;

}  // namespace

void DomicileHost::DispatchOrHold(Event& event) {
  if (HasEventListeners(event.type())) {
    DispatchEvent(event);
  } else if (held_.size() < kMostHeld) {
    held_.push_back(&event);
  }
}

void DomicileHost::DeliverHeld(const AtomicString& event_type) {
  HeapVector<Member<Event>> deliver;
  HeapVector<Member<Event>> keep;
  for (const Member<Event>& event : held_) {
    (event->type() == event_type ? deliver : keep).push_back(event);
  }
  held_ = std::move(keep);
  for (const Member<Event>& event : deliver) {
    DispatchEvent(*event);
  }
}

void DomicileHost::WindowsChanged() {
  HeapVector<Member<DomicileWindow>> windows;
  windows.reserve(window_states_.size());
  for (const DomicileWindowState& state : window_states_) {
    windows.push_back(MakeGarbageCollected<DomicileWindow>(state));
  }
  client_windows_ =
      MakeGarbageCollected<FrozenArray<DomicileWindow>>(std::move(windows));
  DispatchEvent(*Event::Create(domicile_event_names::Windowschanged()));
}

void DomicileHost::spawn(ScriptState* script_state,
                         const Vector<String>& command,
                         ExceptionState& exception_state) {
  // An empty argv reaches the compositor as a request to run nothing, which it
  // cannot answer and should not have to refuse. Caught here so the shell gets
  // a stack rather than silence; the browser refuses it again, because that is
  // where refusing matters.
  if (command.empty()) {
    exception_state.ThrowTypeError(
        "spawn: command must be a non-empty argv array");
    return;
  }
  if (!EnsureBound()) {
    exception_state.ThrowDOMException(
        DOMExceptionCode::kInvalidStateError,
        "There is no compositor for this document to control.");
    return;
  }

  Vector<String> argv;
  argv.reserve(command.size());
  for (const String& argument : command) {
    argv.push_back(argument);
  }
  channel_->Spawn(argv);
}


// Every outbound call needs the same two answers first: is there anything to
// send to, and did the page name a window. Written once rather than twelve
// times, because twelve copies is where one of them ends up missing.
bool DomicileHost::Ready(ExceptionState& exception_state) {
  if (!EnsureBound()) {
    exception_state.ThrowDOMException(
        DOMExceptionCode::kInvalidStateError,
        "There is no compositor for this document to control.");
    return false;
  }
  return true;
}

bool DomicileHost::ReadyForApp(const String& app_id,
                               ExceptionState& exception_state) {
  if (app_id.empty()) {
    exception_state.ThrowTypeError("appId must be a non-empty string");
    return false;
  }
  return Ready(exception_state);
}

// Both halves: the compositor's seat, and where this page's keys go. A shell
// used to need the SDK's `focusApp` for the second, and one that called this
// alone moved the seat and went on typing into the page.
void DomicileHost::focusApp(ScriptState*, const String& app_id,
                            ExceptionState& exception_state) {
  if (ReadyForApp(app_id, exception_state)) {
    FocusAppKeyboard(app_id);
  }
}

namespace {

// Make the resolver for a new ask and reject the one it supersedes.
template <typename Answer>
ScriptPromiseResolver<Answer>* Supersede(
    Member<ScriptPromiseResolver<Answer>>& outstanding,
    ScriptState* script_state,
    ExceptionState& exception_state) {
  if (outstanding) {
    outstanding->RejectWithDOMException(DOMExceptionCode::kAbortError,
                                        "A newer ask superseded this one.");
  }
  outstanding = MakeGarbageCollected<ScriptPromiseResolver<Answer>>(
      script_state, exception_state.GetContext());
  return outstanding.Get();
}

// Settle the outstanding ask with `answer` if `asked` is what it asked.
template <typename Answer>
void Settle(Member<ScriptPromiseResolver<Answer>>& outstanding,
            const String& outstanding_asked,
            const String& asked,
            Answer* answer) {
  if (outstanding && outstanding_asked == asked) {
    outstanding->Resolve(answer);
    outstanding = nullptr;
  }
}

}  // namespace

ScriptPromise<DomicileFileSearch> DomicileHost::searchFiles(
    ScriptState* script_state,
    const String& query,
    ExceptionState& exception_state) {
  if (!Ready(exception_state)) {
    return EmptyPromise();
  }
  auto* resolver = Supersede(file_search_, script_state, exception_state);
  file_search_query_ = query;
  auto promise = resolver->Promise();
  channel_->SearchFiles(query);
  return promise;
}

void DomicileHost::callSystem(ScriptState*,
                              uint32_t id,
                              const String& request,
                              ExceptionState& exception_state) {
  if (Ready(exception_state)) {
    channel_->CallSystem(id, request);
  }
}

void DomicileHost::answerPortalRequest(ScriptState*,
                                       uint32_t id,
                                       const String& answer,
                                       ExceptionState& exception_state) {
  if (Ready(exception_state)) {
    channel_->AnswerPortalRequest(id, answer);
  }
}

// The whole of what a page may do about the lock, and it is an offer rather
// than a decision: what opens the desk is the compositor agreeing, and what
// this page hears about it is `lockedchanged` like every other chrome on the
// desk. A wrong passphrase is answered with nothing -- there is no verdict on
// this channel to leak a guess through, and the compositor's own log says it
// refused one without saying what it was.
//
// No empty-string guard. An empty passphrase is a wrong passphrase, which this
// call already has an answer for, and the compositor refuses an empty one in
// its config too -- so there is nothing here for a throw to tell a shell that
// the refusal does not.
void DomicileHost::unlock(ScriptState*,
                          const String& passphrase,
                          ExceptionState& exception_state) {
  if (Ready(exception_state)) {
    channel_->Unlock(passphrase);
  }
}

// The other way, and just as much a request: what this page hears is the
// `lockedchanged` every chrome on the desk hears.
void DomicileHost::lock(ScriptState*, ExceptionState& exception_state) {
  if (Ready(exception_state)) {
    channel_->Lock();
  }
}

// The whole of what a page may do to the seat's clipboard, and it names a row
// rather than carrying text: a call that took bytes would let this document
// write the desktop's clipboard, where this one only chooses among what has
// already been copied on it. An id the compositor no longer holds sets
// nothing, and it says so in its own log -- there is no answer to this for it
// to say so in.
void DomicileHost::copyClipboardEntry(ScriptState*,
                                      uint32_t entry,
                                      ExceptionState& exception_state) {
  if (Ready(exception_state)) {
    channel_->CopyClipboardEntry(entry);
  }
}

void DomicileHost::focusChrome(ScriptState*, ExceptionState& exception_state) {
  if (Ready(exception_state)) {
    FocusChromeKeyboard();
  }
}

void DomicileHost::syncFrames(ScriptState*, ExceptionState& exception_state) {
  if (Ready(exception_state)) {
    channel_->SyncFrames();
  }
}

void DomicileHost::warpPointer(ScriptState*,
                               double x,
                               double y,
                               DOMRectReadOnly* unless_over,
                               ExceptionState& exception_state) {
  // A coordinate that is not a number is not a place, and every arithmetic
  // that follows it -- the browser's clamp into this page's box, the round to
  // a pixel -- would carry it. Refused here because the page is where the
  // mistake is, the way a device pixel ratio of zero is.
  //
  // A coordinate OUTSIDE this page is not refused: it is clamped to the page's
  // own box in the browser process, which is where the box is known. See
  // `PointerWarpTarget`.
  if (!std::isfinite(x) || !std::isfinite(y)) {
    exception_state.ThrowTypeError("warpPointer: x and y must be finite");
    return;
  }
  // A box with a NaN edge holds no point, so the warp would always happen.
  if (unless_over != nullptr &&
      (!std::isfinite(unless_over->x()) || !std::isfinite(unless_over->y()) ||
       !std::isfinite(unless_over->width()) ||
       !std::isfinite(unless_over->height()))) {
    exception_state.ThrowTypeError("warpPointer: unlessOver must be finite");
    return;
  }
  if (Ready(exception_state)) {
    warped_to_ = gfx::PointF(x, y);
    channel_->WarpPointer(
        x, y,
        unless_over == nullptr
            ? std::nullopt
            : std::make_optional(gfx::RectF(
                  unless_over->left(), unless_over->top(),
                  unless_over->right() - unless_over->left(),
                  unless_over->bottom() - unless_over->top())));
  }
}

void DomicileHost::closeApp(ScriptState*, const String& app_id,
                            ExceptionState& exception_state) {
  if (ReadyForApp(app_id, exception_state)) {
    channel_->CloseApp(app_id);
  }
}

void DomicileHost::pointerConstrained(ScriptState*,
                                      const String& app_id,
                                      bool active,
                                      ExceptionState& exception_state) {
  if (ReadyForApp(app_id, exception_state)) {
    channel_->PointerConstrained(app_id, active);
  }
}

void DomicileHost::setAppBounds(ScriptState*, const String& app_id, double x,
                                double y, double width, double height,
                                ExceptionState& exception_state) {
  if (ReadyForApp(app_id, exception_state)) {
    channel_->SetAppBounds(app_id, x, y, width, height);
  }
}

// THROUGH THE WIRE NAME, for the reason `AppCursor` below reads one: the only
// mapping between `DomicileTheme` and `mojom::Theme` in either direction is
// the X-macro in components/domicile/common/theme.h, so the list stays
// singular and scripts/test-themes-agree.sh can read every writing of it.
//
// No argument guard, and nothing to guard: the bindings have already refused
// anything that is not one of the two, which is what the enum in
// domicile_theme.idl is for. The `CHECK` is the same unreachable assertion
// `AppCursor` makes, pointing the other way -- it fires only if the .idl and
// the X-macro have drifted, which is a build this repository should not have
// produced.
namespace {

domicile::mojom::blink::Theme MojoTheme(V8DomicileTheme theme) {
  const std::optional<domicile::mojom::blink::Theme> mode =
      domicile::ThemeFromWire<domicile::mojom::blink::Theme>(
          theme.AsString().Utf8());
  CHECK(mode.has_value()) << "no theme named '" << theme.AsString().Utf8()
                          << "', so domicile_theme.idl and theme.h disagree";
  return *mode;
}

V8DomicileTheme PageTheme(domicile::mojom::blink::Theme theme) {
  const std::string_view name = domicile::ThemeToWire(theme);
  const std::optional<V8DomicileTheme> mode =
      V8DomicileTheme::Create(String::FromUtf8(name));
  CHECK(mode.has_value()) << "no DomicileTheme named '" << name
                          << "', so domicile_theme.idl and theme.h disagree";
  return *mode;
}

// A switch rather than a wire name: the button goes no further than this
// channel's own mojom, which the compositor never reads.
domicile::mojom::blink::TrayAction MojoTrayAction(V8DomicileTrayAction action) {
  switch (action.AsEnum()) {
    case V8DomicileTrayAction::Enum::kPrimary:
      return domicile::mojom::blink::TrayAction::kPrimary;
    case V8DomicileTrayAction::Enum::kSecondary:
      return domicile::mojom::blink::TrayAction::kSecondary;
    case V8DomicileTrayAction::Enum::kContext:
      return domicile::mojom::blink::TrayAction::kContext;
  }
}

}  // namespace

// An icon and a button, and nothing about what the click does. An empty id
// throws, as activateExtension's does: it is a shell that forgot to say which
// icon, rather than one that raced an application going away.
void DomicileHost::activateTrayItem(ScriptState*,
                                    const String& id,
                                    V8DomicileTrayAction action,
                                    ExceptionState& exception_state) {
  if (id.empty()) {
    exception_state.ThrowTypeError("id must be a non-empty tray item id");
    return;
  }
  if (Ready(exception_state)) {
    channel_->ActivateTrayItem(id, MojoTrayAction(action));
  }
}

// Ids and nothing else. An empty list is a shell that cleared nothing, which is
// not an error and asks nothing of the compositor.
void DomicileHost::dismissNotifications(ScriptState*,
                                        const Vector<uint32_t>& ids,
                                        ExceptionState& exception_state) {
  if (ids.empty()) {
    return;
  }
  if (Ready(exception_state)) {
    channel_->DismissNotifications(ids);
  }
}

// A notification and a key, and nothing about what the press does. An empty
// key throws, as activateTrayItem's empty id does: it is a shell that forgot to
// say which button, rather than one that raced the notification going away.
void DomicileHost::invokeNotificationAction(ScriptState*,
                                            uint32_t id,
                                            const String& action,
                                            ExceptionState& exception_state) {
  if (action.empty()) {
    exception_state.ThrowTypeError(
        "action must be a non-empty notification action key");
    return;
  }
  if (Ready(exception_state)) {
    channel_->InvokeNotificationAction(id, action);
  }
}

void DomicileHost::replyToNotification(ScriptState*,
                                       uint32_t id,
                                       const String& text,
                                       ExceptionState& exception_state) {
  if (Ready(exception_state)) {
    channel_->ReplyToNotification(id, text);
  }
}

void DomicileHost::setTheme(ScriptState*, V8DomicileTheme theme,
                            ExceptionState& exception_state) {
  // `Ready` first, which every other member here does and this one did not:
  // a call on a host whose channel is not up throws, and doing the lookup and
  // the assertion in front of that would be work on the way to a throw.
  if (Ready(exception_state)) {
    channel_->SetTheme(MojoTheme(theme));
  }
}

void DomicileHost::themeCaptured(ScriptState*, V8DomicileTheme theme,
                                 ExceptionState& exception_state) {
  if (Ready(exception_state)) {
    channel_->ThemeCaptured(MojoTheme(theme));
  }
}

void DomicileHost::grabShortcut(ScriptState*,
                                const String& written,
                                bool while_inhibited,
                                ExceptionState& exception_state) {
  if (const auto modifier = ParseDomicileTap(written)) {
    if (!Ready(exception_state)) {
      return;
    }
    GrabbedTap* found = nullptr;
    for (GrabbedTap& grabbed : taps_) {
      if (grabbed.written == written) {
        found = &grabbed;
      }
    }
    if (found) {
      ++found->holds;
      found->while_inhibited |= while_inhibited;
    } else {
      taps_.push_back(
          GrabbedTap{written, *modifier, /*holds=*/1, while_inhibited});
    }
    RegrabTap(*modifier);
    return;
  }
  String error;
  const std::optional<DomicileWrittenChord> chord =
      ParseDomicileChord(written, &error);
  if (!chord) {
    exception_state.ThrowDOMException(DOMExceptionCode::kSyntaxError, error);
    return;
  }
  // A keyboard already heard can say now that the keysym is on no key. One
  // not heard yet says so when it arrives, as a warning: the page has long
  // since returned.
  if (keys_ && !ResolveDomicileChord(*chord, *keys_)) {
    exception_state.ThrowDOMException(
        DOMExceptionCode::kNotFoundError,
        "chord \"" + written + "\": \"" + chord->keysym +
            "\" is on no key of this keyboard");
    return;
  }
  if (!Ready(exception_state)) {
    return;
  }
  for (GrabbedChord& grabbed : chords_) {
    if (grabbed.written == written) {
      ++grabbed.holds;
      grabbed.while_inhibited |= while_inhibited;
      return;
    }
  }
  chords_.push_back(GrabbedChord{written, *chord, std::nullopt, /*holds=*/1,
                                 while_inhibited});
  if (!key_listener_) {
    key_listener_ = MakeGarbageCollected<PageHeard>(BindRepeating(
        &DomicileHost::PageKeyDown, WrapWeakPersistent(this)));
    // Capturing, on the window: first of anything on the page, so a forward
    // of keys to an `<app>` sees the chord already taken (`defaultPrevented`)
    // and leaves it.
    window_->addEventListener(event_type_names::kKeydown, key_listener_.Get(),
                              /*use_capture=*/true);
  }
  ResolveChords();
}

void DomicileHost::ungrabShortcut(ScriptState*,
                                  const String& written,
                                  ExceptionState& exception_state) {
  if (const auto modifier = ParseDomicileTap(written)) {
    if (!Ready(exception_state)) {
      return;
    }
    for (wtf_size_t i = 0; i < taps_.size(); ++i) {
      if (taps_[i].written == written) {
        if (--taps_[i].holds == 0) {
          taps_.EraseAt(i);
          RegrabTap(*modifier);
        }
        return;
      }
    }
    return;
  }
  String error;
  if (!ParseDomicileChord(written, &error)) {
    exception_state.ThrowDOMException(DOMExceptionCode::kSyntaxError, error);
    return;
  }
  if (!Ready(exception_state)) {
    return;
  }
  for (wtf_size_t i = 0; i < chords_.size(); ++i) {
    if (chords_[i].written == written) {
      if (--chords_[i].holds > 0) {
        return;
      }
      const std::optional<DomicilePress> press = chords_[i].press;
      chords_.EraseAt(i);
      if (press) {
        UngrabUnclaimed(*press);
      }
      return;
    }
  }
}

void DomicileHost::grabGesture(ScriptState*,
                               const String& written,
                               ExceptionState& exception_state) {
  String error;
  const std::optional<WrittenGesture> gesture = ParseGesture(written, &error);
  if (!gesture) {
    exception_state.ThrowDOMException(DOMExceptionCode::kSyntaxError, error);
    return;
  }
  if (!Ready(exception_state)) {
    return;
  }
  for (GrabbedGesture& grabbed : gestures_) {
    if (grabbed.written == written) {
      ++grabbed.holds;
      return;
    }
  }
  gestures_.push_back(GrabbedGesture{written});
  channel_->GrabGesture(domicile::mojom::blink::GestureGrab::New(
      gesture->kind, gesture->fingers, gesture->edge));
}

void DomicileHost::ungrabGesture(ScriptState*,
                                 const String& written,
                                 ExceptionState& exception_state) {
  String error;
  const std::optional<WrittenGesture> gesture = ParseGesture(written, &error);
  if (!gesture) {
    exception_state.ThrowDOMException(DOMExceptionCode::kSyntaxError, error);
    return;
  }
  if (!Ready(exception_state)) {
    return;
  }
  for (wtf_size_t i = 0; i < gestures_.size(); ++i) {
    if (gestures_[i].written == written) {
      if (--gestures_[i].holds > 0) {
        return;
      }
      gestures_.EraseAt(i);
      channel_->UngrabGesture(domicile::mojom::blink::GestureGrab::New(
          gesture->kind, gesture->fingers, gesture->edge));
      return;
    }
  }
}

void DomicileHost::UngrabUnclaimed(const DomicilePress& press) {
  if (ChordFor(press).IsNull()) {
    channel_->UngrabShortcut(domicile::mojom::blink::Shortcut::New(
        press.keycode, press.alt, press.ctrl, press.shift, press.meta));
  }
}

// A chord whose key moved is grabbed on its new key, and the old one is given
// back once no chord is on it.
void DomicileHost::ResolveChords() {
  if (!keys_ || !channel_.is_bound()) {
    return;
  }
  Vector<DomicilePress> moved_off;
  for (GrabbedChord& grabbed : chords_) {
    const std::optional<DomicilePress> press =
        ResolveDomicileChord(grabbed.chord, *keys_);
    if (!press) {
      if (window_) {
        window_->AddConsoleMessage(MakeGarbageCollected<ConsoleMessage>(
            mojom::blink::ConsoleMessageSource::kJavaScript,
            mojom::blink::ConsoleMessageLevel::kWarning,
            "domicile: chord \"" + grabbed.written + "\": \"" +
                grabbed.chord.keysym + "\" is on no key of this keyboard"));
      }
    } else if (press != grabbed.press) {
      channel_->GrabShortcut(domicile::mojom::blink::Shortcut::New(
          press->keycode, press->alt, press->ctrl, press->shift, press->meta));
    }
    if (grabbed.press && press != grabbed.press) {
      moved_off.push_back(*grabbed.press);
    }
    grabbed.press = press;
  }
  for (const DomicilePress& press : moved_off) {
    UngrabUnclaimed(press);
  }
}

bool DomicileHost::KeyboardWindowInhibitsShortcuts() const {
  if (keyboard_app_.IsNull()) {
    return false;
  }
  for (const DomicileWindowState& state : window_states_) {
    if (state.app_id == keyboard_app_) {
      return state.inhibits_shortcuts;
    }
  }
  return false;
}

void DomicileHost::TellWhetherTheKeyboardWindowInhibits() {
  const bool inhibits = KeyboardWindowInhibitsShortcuts();
  if (inhibits == told_inhibits_ || !EnsureBound()) {
    return;
  }
  told_inhibits_ = inhibits;
  channel_->KeyboardWindowInhibitsShortcuts(inhibits);
}

void DomicileHost::RegrabTap(domicile::mojom::blink::TapModifier modifier) {
  bool grabbed = false;
  bool while_inhibited = false;
  for (const GrabbedTap& tap : taps_) {
    if (tap.modifier == modifier) {
      grabbed = true;
      while_inhibited |= tap.while_inhibited;
    }
  }
  if (grabbed) {
    // Sent again on each grab: the browser process keeps the latest
    // `while_inhibited`, which an ungrab of another name can take away.
    channel_->GrabModifierTap(modifier, while_inhibited);
  } else {
    channel_->UngrabModifierTap(modifier);
  }
}

bool DomicileHost::StaysWhileInhibited(const DomicilePress& press) const {
  for (const GrabbedChord& grabbed : chords_) {
    if (grabbed.press == press) {
      return grabbed.while_inhibited;
    }
  }
  return false;
}

String DomicileHost::ChordFor(const DomicilePress& press) const {
  for (const GrabbedChord& grabbed : chords_) {
    if (grabbed.press == press) {
      return grabbed.written;
    }
  }
  return String();
}

void DomicileHost::PageKeyDown(Event* event) {
  auto* key = DynamicTo<KeyboardEvent>(event);
  if (!key) {
    return;
  }
  const int evdev = EvdevOf(*key);
  if (evdev <= 0) {
    return;
  }
  const DomicilePress press{static_cast<uint32_t>(evdev), key->altKey(),
                            key->ctrlKey(), key->shiftKey(), key->metaKey()};
  const String chord = ChordFor(press);
  // A window holding a shortcuts inhibitor gets the chord as a key, unless
  // the shell grabbed it `whileInhibited`: its way back to the desktop. The
  // console switch is the DRM platform's, below the page, so it still works.
  if (chord.IsNull() ||
      (KeyboardWindowInhibitsShortcuts() && !StaysWhileInhibited(press))) {
    return;
  }
  // Taken from the page whether or not it fires: the chord is the desktop's
  // for as long as it is held. A held key repeats; the compositor never sees a
  // repeat, so neither does the shell.
  event->preventDefault();
  if (key->repeat()) {
    return;
  }
  FireShortcut(press);
}

void DomicileHost::FireShortcut(const DomicilePress& press) {
  held_chords_.Press(press);
  // Capturing, on the window, as PageKeyDown: a release the page stops is
  // still heard.
  if (!key_up_listener_ && window_) {
    key_up_listener_ = MakeGarbageCollected<PageHeard>(
        BindRepeating(&DomicileHost::PageKeyUp, WrapWeakPersistent(this)));
    window_->addEventListener(event_type_names::kKeyup, key_up_listener_.Get(),
                              /*use_capture=*/true);
  }
  DispatchOrHold(*MakeGarbageCollected<DomicileShortcutEvent>(
      domicile_event_names::Shortcut(), ChordFor(press), press.keycode,
      press.alt, press.ctrl, press.shift, press.meta));
}

void DomicileHost::PageKeyUp(Event* event) {
  auto* key = DynamicTo<KeyboardEvent>(event);
  if (!key) {
    return;
  }
  const int evdev = EvdevOf(*key);
  if (evdev <= 0) {
    return;
  }
  ReleaseChords(DomicilePress{static_cast<uint32_t>(evdev), key->altKey(),
                              key->ctrlKey(), key->shiftKey(),
                              key->metaKey()});
}

void DomicileHost::ReleaseChords(const DomicilePress& up) {
  Vector<DomicilePress> released;
  held_chords_.Release(up, [&released](const DomicilePress& press) {
    released.push_back(press);
  });
  for (const DomicilePress& press : released) {
    DispatchOrHold(*MakeGarbageCollected<DomicileShortcutEvent>(
        domicile_event_names::Shortcutrelease(), ChordFor(press),
        press.keycode, press.alt, press.ctrl, press.shift, press.meta));
  }
}

// Through the tray's pipe rather than the channel's: see the IDL. Ready()
// because EnsureBound binds the two together, so a bound channel is a bound
// tray.
void DomicileHost::activateExtension(ScriptState*,
                                     const String& id,
                                     ExceptionState& exception_state) {
  if (id.empty()) {
    exception_state.ThrowTypeError("id must be a non-empty extension id");
    return;
  }
  if (Ready(exception_state)) {
    tray_->Activate(id);
  }
}

// A document going away has nobody waiting to hear it.
void DomicileHost::ReportShellRan(const String& serial) {
  if (EnsureBound()) {
    channel_->ShellRan(serial);
  }
}

void DomicileHost::ReportShellFailed(const String& serial, const String& why) {
  if (EnsureBound()) {
    channel_->ShellFailed(serial, why);
  }
}

// THE PAGE'S INPUT, which was the SDK's `registerElements`. An <app> maps a
// pointer over it and hands it here; the keys are the document's, and are
// heard on it. On the document and in the bubbling phase, as the SDK's were,
// so a shell that stops a key or a press before it gets there has taken it.
void DomicileHost::RouteInput() {
  ProvideTo(*window_, static_cast<AppInputClient*>(this));
  Document& document = *window_->document();
  const auto listen = [this](EventTarget& target, const AtomicString& type,
                             void (DomicileHost::*heard)(Event*)) {
    auto* listener = MakeGarbageCollected<PageHeard>(
        BindRepeating(heard, WrapWeakPersistent(this)));
    target.addEventListener(type, listener);
    input_listeners_.push_back(listener);
  };
  listen(document, event_type_names::kKeydown, &DomicileHost::ForwardKeyDown);
  listen(document, event_type_names::kKeyup, &DomicileHost::ForwardKeyUp);
  listen(document, event_type_names::kPointerdown,
         &DomicileHost::ReleaseKeyboardOffApp);
  // A page that has lost the keyboard -- or is going away -- is never told a
  // key came up. `pagehide` as well as `blur` because a reload is not a focus
  // change, and it is the event a navigation fires reliably.
  listen(*window_, event_type_names::kBlur, &DomicileHost::ReleaseHeldKeys);
  listen(*window_, event_type_names::kPagehide,
         &DomicileHost::ReleaseHeldKeys);
  listen(document, event_type_names::kFocusin, &DomicileHost::ReleaseIntoGuest);
  // AND A WHEEL LISTENER THAT DOES NOTHING, because listening is what brings a
  // wheel to this thread at all: with none on the page the compositor thread
  // scrolls by itself and no `wheel` is dispatched, so an <app> would never
  // see one. Passive -- the platform makes a document's so -- so it holds up
  // no scroll. The pointer needs no such thing: the `pointerdown` above is a
  // pointer listener, which is what Blink asks before it dispatches any.
  auto* wheel = MakeGarbageCollected<PageHeard>(
      base::DoNothingAs<void(Event*)>());
  document.addEventListener(event_type_names::kWheel, wheel);
  input_listeners_.push_back(wheel);
}

void DomicileHost::AppPressed(HTMLAppElement& app, const String& app_id) {
  // A popup's window rather than the popup: a click on a menu is a click on
  // the window it belongs to.
  const String window = WindowOf(app_id);
  if (Ask(app, kFocusRequested, window, std::nullopt)) {
    FocusAppKeyboard(window);
  }
}

gfx::PointF DomicileHost::IntoClient(const String& app_id,
                                     const gfx::PointF& point,
                                     const gfx::SizeF& size) const {
  // Into what the client drew, which the compositor said; one that has drawn
  // nothing yet is mapped through its own box, 1:1.
  double x = point.x();
  double y = point.y();
  for (const DomicileWindowState& state : window_states_) {
    if (state.app_id == app_id && state.width && state.height) {
      x = *state.width > 0 ? x * *state.width / size.width() : x;
      y = *state.height > 0 ? y * *state.height / size.height() : y;
      break;
    }
  }
  return gfx::PointF(x, y);
}

void DomicileHost::AppPointerMotion(const String& app_id,
                                    const gfx::PointF& point,
                                    const gfx::SizeF& size,
                                    bool moved) {
  const gfx::PointF at = IntoClient(app_id, point, size);
  if (EnsureBound()) {
    channel_->PointerMotion(app_id, at.x(), at.y(), moved);
  }
}

// A WARP MOVES THE POINTER TOO, AND NOBODY MOVED IT. The browser reports a
// warp as a move (synthesized, which Blink does not see), and Blink measures
// its `movementX/Y` from where the pointer was, so it would reach a game as a
// flick of the mouse. The move that lands where the page last warped is taken
// as the warp. A warp the browser skipped or clamped leaves its target
// waiting, which costs at most one later move that lands exactly there.
void DomicileHost::AppPointerRelative(const String& app_id,
                                      const gfx::Vector2dF& movement,
                                      const gfx::PointF& on_page,
                                      const gfx::SizeF& size) {
  if (warped_to_ && std::abs(warped_to_->x() - on_page.x()) < 1 &&
      std::abs(warped_to_->y() - on_page.y()) < 1) {
    warped_to_.reset();
    return;
  }
  // Scaled as a point is, from the element's CSS pixels into the client's.
  const gfx::PointF scaled = IntoClient(
      app_id, gfx::PointF(movement.x(), movement.y()), size);
  if (EnsureBound()) {
    channel_->PointerRelative(app_id, scaled.x(), scaled.y());
  }
}

void DomicileHost::AppTouch(const String& app_id,
                            AppTouchPhase phase,
                            int32_t id,
                            uint32_t time,
                            const gfx::PointF& point,
                            const gfx::SizeF& size) {
  if (!EnsureBound()) {
    return;
  }
  domicile::mojom::blink::TouchPhase step;
  switch (phase) {
    case AppTouchPhase::kDown:
      step = domicile::mojom::blink::TouchPhase::kDown;
      break;
    case AppTouchPhase::kMotion:
      step = domicile::mojom::blink::TouchPhase::kMotion;
      break;
    case AppTouchPhase::kUp:
      step = domicile::mojom::blink::TouchPhase::kUp;
      break;
    case AppTouchPhase::kCancel:
      step = domicile::mojom::blink::TouchPhase::kCancel;
      break;
  }
  const bool placed =
      phase == AppTouchPhase::kDown || phase == AppTouchPhase::kMotion;
  const gfx::PointF at = placed ? IntoClient(app_id, point, size) : gfx::PointF();
  channel_->Touch(app_id, domicile::mojom::blink::Touch::New(
                              step, id, time, at.x(), at.y()));
}

void DomicileHost::AppPointerButton(const String& app_id,
                                    uint32_t button,
                                    bool pressed) {
  if (EnsureBound()) {
    channel_->PointerButton(app_id, button, pressed);
  }
}

void DomicileHost::AppPointerLeave(const String& app_id) {
  if (EnsureBound()) {
    channel_->PointerLeave(app_id);
  }
}

void DomicileHost::AppPointerPinch(const String& app_id,
                                   const ui::NativePinch& pinch) {
  if (!EnsureBound()) {
    return;
  }
  domicile::mojom::blink::PinchPhase phase;
  switch (pinch.phase) {
    case ui::NativePinchPhase::kBegin:
      phase = domicile::mojom::blink::PinchPhase::kBegin;
      break;
    case ui::NativePinchPhase::kUpdate:
      phase = domicile::mojom::blink::PinchPhase::kUpdate;
      break;
    case ui::NativePinchPhase::kEnd:
      phase = domicile::mojom::blink::PinchPhase::kEnd;
      break;
  }
  channel_->PointerPinch(
      app_id, domicile::mojom::blink::Pinch::New(
                  phase, pinch.device, pinch.time, pinch.fingers, pinch.dx,
                  pinch.dy, pinch.scale, pinch.rotation, pinch.canceled));
}

void DomicileHost::AppPointerAxis(const String& app_id,
                                  double dx,
                                  double dy,
                                  int32_t v120_x,
                                  int32_t v120_y,
                                  ui::NativeScrollSource source,
                                  bool stop_x,
                                  bool stop_y) {
  if (EnsureBound()) {
    domicile::mojom::blink::PointerAxisSource wire_source;
    switch (source) {
      case ui::NativeScrollSource::kWheel:
        wire_source = domicile::mojom::blink::PointerAxisSource::kWheel;
        break;
      case ui::NativeScrollSource::kFinger:
        wire_source = domicile::mojom::blink::PointerAxisSource::kFinger;
        break;
      case ui::NativeScrollSource::kWheelTilt:
        wire_source = domicile::mojom::blink::PointerAxisSource::kWheelTilt;
        break;
      case ui::NativeScrollSource::kContinuous:
        wire_source = domicile::mojom::blink::PointerAxisSource::kContinuous;
        break;
    }
    channel_->PointerAxis(app_id, dx, dy, v120_x, v120_y, wire_source, stop_x,
                          stop_y);
  }
}

void DomicileHost::FocusAppKeyboard(const String& app_id) {
  keyboard_app_ = app_id;
  if (EnsureBound()) {
    channel_->FocusApp(app_id);
  }
  TellWhetherTheKeyboardWindowInhibits();
}

void DomicileHost::FocusChromeKeyboard() {
  keyboard_app_ = String();
  if (EnsureBound()) {
    channel_->FocusChrome();
  }
  TellWhetherTheKeyboardWindowInhibits();
}

// The window the keyboard was routed to can leave the page without anything
// saying so: a shell takes an <app> down when its client closes. Left alone,
// every key after a window closes is taken from the page and sent to a client
// that is gone. The compositor's seat still points at it too, so the page says
// the keyboard is its own again, which is where a closed client's keyboard
// goes. One walk of the <app>s per key, against a socket write on the same
// path.
String DomicileHost::KeyboardTarget() {
  if (!keyboard_app_.IsNull() && !AppElement(keyboard_app_)) {
    FocusChromeKeyboard();
  }
  return keyboard_app_;
}

void DomicileHost::ForwardKeyDown(Event* event) {
  auto* key = DynamicTo<KeyboardEvent>(event);
  if (!key) {
    return;
  }
  const String app_id = KeyboardTarget();
  const int evdev = EvdevOf(*key);
  if (evdev <= 0) {
    return;
  }
  const uint32_t keycode = static_cast<uint32_t>(evdev);
  // A chord grabbed by name arrives taken -- PageKeyDown heard it first and
  // answered it as `shortcut` -- and so does a key the page took. Its release
  // is not the client's either.
  if (event->defaultPrevented()) {
    forwarded_keys_.Take(keycode);
    return;
  }
  if (app_id.IsNull()) {
    return;
  }
  event->preventDefault();
  // The browser repeats a held key; Wayland does not. A client repeats from
  // `wl_keyboard.repeat_info` itself, so forwarding these as presses would
  // give it two sources of repeat, drawn as one character over and over.
  if (key->repeat()) {
    return;
  }
  forwarded_keys_.Forward(keycode, app_id);
  if (EnsureBound()) {
    channel_->Key(app_id, keycode, true);
  }
}

// Every release the page hears, not only those for a press it forwarded: a
// key held while the page reloads comes up on a page that never saw it go
// down, and kept back it stays down in the seat under every later key. The
// compositor drops a release for a key its seat does not hold, which is what
// makes sending them all safe. Except a key whose press was taken.
void DomicileHost::ForwardKeyUp(Event* event) {
  auto* key = DynamicTo<KeyboardEvent>(event);
  if (!key) {
    return;
  }
  const int evdev = EvdevOf(*key);
  if (evdev <= 0) {
    return;
  }
  const uint32_t keycode = static_cast<uint32_t>(evdev);
  if (forwarded_keys_.TakenUp(keycode)) {
    return;
  }
  const std::optional<String> held = forwarded_keys_.HeldUp(keycode);
  if (held.has_value()) {
    event->preventDefault();
  }
  // The window the press was sent for where this page sent it, and otherwise
  // the one that has the keyboard. The compositor reads neither -- it injects
  // the key into the seat, whose focus delivers it -- and an empty one is a
  // desk where no window has it.
  const String app_id =
      held.value_or(keyboard_app_.IsNull() ? g_empty_string : keyboard_app_);
  if (EnsureBound()) {
    channel_->Key(app_id, keycode, false);
  }
}

void DomicileHost::ReleaseHeldKeys(Event*) {
  const std::vector<std::pair<uint32_t, String>> held =
      forwarded_keys_.TakeHeld();
  if (EnsureBound()) {
    for (const auto& [keycode, app_id] : held) {
      channel_->Key(app_id, keycode, false);
    }
  }
}

// A key released while a <webview>'s guest has the focus comes up on the site
// and never in this document, so what this page holds is let go as the guest
// takes it. Without that, Super held through the chord that focuses a browser
// window stays down in the seat, and every window afterward takes each key as
// a Super chord.
void DomicileHost::ReleaseIntoGuest(Event* event) {
  auto* element =
      DynamicTo<Element>(event->target() ? event->target()->ToNode() : nullptr);
  if (element && element->localName() == "webview") {
    ReleaseHeldKeys(event);
  }
}

// A press off every <app> landed on the page, and nothing in it says whether
// that was the desktop behind the windows or the title bar of the window that
// has the keyboard. So the shell is asked, and the keyboard comes back to the
// page unless it says no. A window whose <app> has left the page is not asked
// and does not keep it.
void DomicileHost::ReleaseKeyboardOffApp(Event* event) {
  Element* pressed =
      DynamicTo<Element>(event->target() ? event->target()->ToNode() : nullptr);
  if (keyboard_app_.IsNull() ||
      (pressed && Traversal<HTMLAppElement>::FirstAncestorOrSelf(*pressed))) {
    return;
  }
  const String app_id = keyboard_app_;
  HTMLAppElement* app = AppElement(app_id);
  if (!app || Ask(*app, kFocusReleaseRequested, app_id, pressed)) {
    FocusChromeKeyboard();
  }
}

String DomicileHost::WindowOf(const String& app_id) const {
  for (const DomicileWindowState& state : window_states_) {
    if (state.app_id == app_id) {
      return state.parent.empty() ? app_id : WindowOf(state.parent);
    }
  }
  return app_id;
}

void DomicileHost::FrameHeard(const String& app_id, uint32_t frame) {
  // An <app> that sets no `frame` shows the newest, so a shell that never
  // called syncFrames() is not left on a frame the compositor moved past.
  if (Document* document = window_ ? window_->document() : nullptr) {
    HTMLAppElement::FrameHeard(*document, app_id, frame);
  }
}

HTMLAppElement* DomicileHost::AppElement(const String& app_id) const {
  Document* document = window_ ? window_->document() : nullptr;
  if (!document) {
    return nullptr;
  }
  for (HTMLAppElement& app :
       Traversal<HTMLAppElement>::DescendantsOf(*document)) {
    if (app.FastGetAttribute(html_names::kAppIdAttr) == app_id) {
      return &app;
    }
  }
  return nullptr;
}

// A CustomEvent, as the SDK dispatched it, so a shell reads the same `detail`.
// Untrusted, as that one was: the page is being asked, not told.
bool DomicileHost::Ask(Element& target,
                       const char* type,
                       const String& app_id,
                       std::optional<Element*> pressed) {
  LocalFrame* frame = window_ ? window_->GetFrame() : nullptr;
  ScriptState* script_state =
      frame ? ToScriptStateForMainWorld(frame) : nullptr;
  // A document with no script has no shell to say no.
  if (!script_state) {
    return true;
  }
  ScriptState::Scope scope(script_state);
  V8ObjectBuilder detail(script_state);
  detail.AddString("appId", app_id);
  if (pressed && *pressed) {
    detail.Add("pressed", *pressed);
  } else if (pressed) {
    detail.AddV8Value("pressed", v8::Undefined(script_state->GetIsolate()));
  }
  CustomEvent* event = CustomEvent::Create();
  event->initCustomEvent(
      script_state, AtomicString(type), /*bubbles=*/true, /*cancelable=*/true,
      ScriptValue(script_state->GetIsolate(), detail.V8Object()));
  return target.DispatchEvent(*event) == DispatchEventResult::kNotCanceled;
}

// A CustomEvent like Ask's, so a shell reads `detail.appId` off every event an
// <app> dispatches. An <app> not in the page, or a document with no script,
// has no shell to tell.
void DomicileHost::Tell(const String& app_id, const char* type) {
  HTMLAppElement* app = AppElement(app_id);
  LocalFrame* frame = window_ ? window_->GetFrame() : nullptr;
  ScriptState* script_state =
      frame ? ToScriptStateForMainWorld(frame) : nullptr;
  if (!app || !script_state) {
    return;
  }
  ScriptState::Scope scope(script_state);
  V8ObjectBuilder detail(script_state);
  detail.AddString("appId", app_id);
  CustomEvent* event = CustomEvent::Create();
  event->initCustomEvent(
      script_state, AtomicString(type), /*bubbles=*/true, /*cancelable=*/false,
      ScriptValue(script_state->GetIsolate(), detail.V8Object()));
  app->DispatchEvent(*event);
}

void DomicileHost::AppAppeared(const String& app_id,
                               const String& title,
                               const String& desktop_id,
                               double width,
                               double height,
                               bool dialog,
                               bool client_frame,
                               domicile::mojom::blink::WindowOwnerPtr owner,
                               uint32_t frame) {
  DomicileWindowState& state = WindowNamed(app_id);
  // A reload's catch-up can be older than a move this page already heard.
  state.frame = std::max(state.frame, frame);
  FrameHeard(app_id, frame);
  if (owner) {
    state.pid = owner->pid;
    state.uid = owner->uid;
    state.gid = owner->gid;
    state.pidfd_inode = owner->pidfd_inode;
    state.sandboxed = !owner->sandbox.is_null();
    if (owner->sandbox) {
      state.sandbox_engine = owner->sandbox->engine;
      state.sandbox_app_id = owner->sandbox->app_id;
      state.sandbox_instance_id = owner->sandbox->instance_id;
    }
  }
  state.title = title;
  state.desktop_id = desktop_id;
  state.width = width;
  state.height = height;
  state.dialog = dialog;
  state.client_frame = client_frame;
  WindowsChanged();
}

void DomicileHost::AppResized(const String& app_id, double width,
                              double height) {
  DomicileWindowState& state = WindowNamed(app_id);
  state.width = width;
  state.height = height;
  WindowsChanged();
}

void DomicileHost::AppMinSize(const String& app_id, double width,
                              double height) {
  DomicileWindowState& state = WindowNamed(app_id);
  state.min_width = width;
  state.min_height = height;
  WindowsChanged();
}

void DomicileHost::AppMaxSize(const String& app_id, double width,
                              double height) {
  DomicileWindowState& state = WindowNamed(app_id);
  state.max_width = width;
  state.max_height = height;
  WindowsChanged();
}

void DomicileHost::PopupPlaced(
    const String& app_id,
    const String& parent_app_id,
    double x,
    double y,
    double width,
    double height,
    bool grab,
    Vector<domicile::mojom::blink::AppFramePtr> frames) {
  DomicileWindowState& state = WindowNamed(app_id);
  state.parent = parent_app_id;
  state.x = x;
  state.y = y;
  state.width = width;
  state.height = height;
  state.grab = grab;
  // In the same change as the move, so a shell sets both in one render. A
  // frame for a window this page has not heard of is dropped.
  for (const auto& synced : frames) {
    for (DomicileWindowState& shown : window_states_) {
      if (shown.app_id == synced->app_id) {
        shown.frame = std::max(shown.frame, synced->frame);
      }
    }
    FrameHeard(synced->app_id, synced->frame);
  }
  WindowsChanged();
}

void DomicileHost::AppClosed(const String& app_id) {
  HTMLAppElement::FramesForgotten(app_id);
  EraseIf(window_states_, [&](const DomicileWindowState& state) {
    return state.app_id == app_id;
  });
  TellWhetherTheKeyboardWindowInhibits();
  WindowsChanged();
}

namespace {

// A client's own cursor as a CSS `cursor` value for its element: the PNG at
// its scale, clicking at the hotspot in CSS pixels, over the arrow should the
// image not load. CSS scales a hotspot by the image's resolution, as Wayland
// gives it in logical pixels.
String CursorImageCss(const domicile::mojom::blink::AppCursorImage& image) {
  StringBuilder css;
  css.Append("image-set(url(\"data:image/png;base64,");
  css.Append(image.png);
  css.Append("\") ");
  css.AppendNumber(image.scale);
  css.Append("x) ");
  css.AppendNumber(image.hotspot_x);
  css.Append(' ');
  css.AppendNumber(image.hotspot_y);
  css.Append(", default");
  return css.ToString();
}

}  // namespace

void DomicileHost::AppCursor(
    const String& app_id,
    domicile::mojom::blink::CursorShape cursor,
    domicile::mojom::blink::AppCursorImagePtr image) {
  // THROUGH THE WIRE NAME, WHICH IS WHAT KEEPS THE LIST SINGULAR. The mojom
  // enum and `DomicileCursorShape` are two spellings of the same closed set,
  // and the obvious conversion between them is a 35-arm switch -- a third
  // hand-written list, which is one more than can be kept honest and which
  // `scripts/test-cursor-shapes-agree.sh` could not read. Going via the string
  // instead means the only mapping either direction is the X-macro in
  // components/domicile/common/cursor_shape.h, and every list that exists is
  // one that script compares.
  //
  // The `CHECK` is unreachable rather than defensive: `Create` is refusing a
  // name that is not a shape, and the name came from `CursorShapeToWire` over
  // a mojo-validated enum. What would reach it is the .idl and the X-macro
  // having drifted, which is a build this repository should not have produced
  // -- so it fails here, loudly, instead of dispatching an arrow.
  const std::string_view name = domicile::CursorShapeToWire(cursor);
  const std::optional<V8DomicileCursorShape> shape =
      V8DomicileCursorShape::Create(String::FromUtf8(name));
  CHECK(shape.has_value())
      << "no DomicileCursorShape named '" << name
      << "', so domicile_cursor_shape.idl and cursor_shape.h disagree";
  DomicileWindowState& window = WindowNamed(app_id);
  window.cursor = *shape;
  window.cursor_image = image ? CursorImageCss(*image) : String();
  WindowsChanged();
}

void DomicileHost::AppPresented(const String& app_id) {
  Tell(app_id, kPresented);
}

void DomicileHost::AppPointerConstraint(
    const String& app_id,
    std::optional<domicile::mojom::blink::PointerConstraint> constraint) {
  String named;
  if (constraint) {
    named = *constraint == domicile::mojom::blink::PointerConstraint::kLock
                ? "lock"
                : "confine";
  }
  WindowNamed(app_id).pointer_constraint = named;
  WindowsChanged();
}

void DomicileHost::AppSuspended(const String& app_id, bool suspended) {
  Tell(app_id, suspended ? kSuspended : kResumed);
}

void DomicileHost::AppTransientFor(const String& app_id,
                                   const String& transient_for) {
  // Empty on the pipe is no parent, which the page reads as null.
  WindowNamed(app_id).transient_for =
      transient_for.empty() ? String() : transient_for;
  WindowsChanged();
}

void DomicileHost::AppAnchored(const String& app_id, const String& anchor) {
  // Empty on the pipe is no anchor, which the page reads as null.
  WindowNamed(app_id).anchor = anchor.empty() ? String() : anchor;
  WindowsChanged();
}

void DomicileHost::AppUrgent(const String& app_id, bool urgent) {
  WindowNamed(app_id).urgent = urgent;
  WindowsChanged();
}

void DomicileHost::ShortcutPressed(
    domicile::mojom::blink::ShortcutPtr shortcut) {
  FireShortcut(DomicilePress{shortcut->keycode, shortcut->alt, shortcut->ctrl,
                             shortcut->shift, shortcut->meta});
}

void DomicileHost::GesturePerformed(
    domicile::mojom::blink::GesturePtr gesture) {
  // Not held for a late listener, as a shortcut is: a gesture's updates are a
  // stream, and a stale one moves nothing. One begun while the keyboard
  // window held a shortcuts inhibitor never reaches here: the browser process
  // sends it to the window (`TellWhetherTheKeyboardWindowInhibits`).
  DispatchEvent(*MakeGarbageCollected<DomicileGestureEvent>(
      domicile_event_names::Gesture(), GestureKindName(gesture->kind),
      GesturePhaseName(gesture->phase), gesture->fingers, gesture->dx,
      gesture->dy, gesture->scale, gesture->rotation, gesture->canceled,
      GestureEdgeName(gesture->edge)));
}

void DomicileHost::ModifierTapped(
    domicile::mojom::blink::TapModifier modifier) {
  using domicile::mojom::blink::TapModifier;
  // A tap is over when it is heard: the key is already up. So `shortcut` and
  // `shortcutrelease` together, for each name it is grabbed by, with no key
  // and the modifier as the one held.
  const bool alt = modifier == TapModifier::kAlt;
  const bool ctrl = modifier == TapModifier::kCtrl;
  const bool shift = modifier == TapModifier::kShift;
  const bool meta = modifier == TapModifier::kMeta;
  Vector<String> names;
  for (const GrabbedTap& tap : taps_) {
    if (tap.modifier == modifier) {
      names.push_back(tap.written);
    }
  }
  for (const String& name : names) {
    DispatchOrHold(*MakeGarbageCollected<DomicileShortcutEvent>(
        domicile_event_names::Shortcut(), name, 0, alt, ctrl, shift, meta));
    DispatchOrHold(*MakeGarbageCollected<DomicileShortcutEvent>(
        domicile_event_names::Shortcutrelease(), name, 0, alt, ctrl, shift,
        meta));
  }
}

void DomicileHost::ShortcutReleased(
    domicile::mojom::blink::ShortcutPtr shortcut) {
  ReleaseChords(DomicilePress{shortcut->keycode, shortcut->alt, shortcut->ctrl,
                              shortcut->shift, shortcut->meta});
}

void DomicileHost::Modifiers(bool alt, bool ctrl, bool shift, bool meta) {
  alt_key_ = alt;
  ctrl_key_ = ctrl;
  shift_key_ = shift;
  meta_key_ = meta;
  DispatchEvent(*Event::Create(domicile_event_names::Modifierschanged()));
}

// The wire name of a turn, as the page reads it off `DomicileDisplay`.
//
// THROUGH THE WIRE NAME, for the reason `AppCursor` above goes through one:
// the only mapping in either direction is the X-macro in
// components/domicile/common/display_transform.h, so there is no second list
// to drift from the first. No `Create` and no `CHECK` here, because the
// attribute is a `DOMString` rather than a generated enum -- the set is closed
// on the compositor's side and on the page's schema, and this is the middle.
namespace {

String TransformName(domicile::mojom::blink::DisplayTransform transform) {
  return String::FromUtf8(domicile::DisplayTransformToWire(transform));
}

}  // namespace

void DomicileHost::Displays(
    Vector<domicile::mojom::blink::DisplayInfoPtr> displays) {
  HeapVector<Member<DomicileDisplay>> described;
  described.reserve(displays.size());
  for (const auto& display : displays) {
    described.push_back(MakeGarbageCollected<DomicileDisplay>(
        display->name, display->x, display->y, display->width, display->height,
        display->scale, display->mode_width, display->mode_height,
        display->refresh_mhz, display->adaptive_sync,
        TransformName(display->transform)));
  }
  displays_ = MakeGarbageCollected<FrozenArray<DomicileDisplay>>(
      std::move(described));
  // The event says the desktop moved; `displays` says what it is. Splitting
  // them is what lets a component that mounted after the description read the
  // desktop at all -- an event carrying the only copy is gone once dispatched.
  DispatchEvent(*Event::Create(domicile_event_names::Displayschanged()));
}

// The whole tray, as rows a shell draws. An empty popup is WebIDL's null --
// see DomicileExtension -- because an action with no popup has nothing for the
// shell to open, and "" is not an address to open.
void DomicileHost::ExtensionsChanged(
    Vector<domicile::mojom::blink::TrayExtensionPtr> extensions) {
  HeapVector<Member<DomicileExtension>> tray;
  tray.reserve(extensions.size());
  for (const auto& extension : extensions) {
    tray.push_back(MakeGarbageCollected<DomicileExtension>(
        extension->id, extension->name, extension->title, extension->icon,
        extension->badge_text, extension->badge_color,
        extension->popup.empty() ? String() : extension->popup,
        extension->enabled));
  }
  extensions_ =
      MakeGarbageCollected<FrozenArray<DomicileExtension>>(std::move(tray));
  DispatchEvent(*Event::Create(domicile_event_names::Extensionschanged()));
}

// Dispatched, not held: see onextensionpopuprequested in the IDL.
void DomicileHost::PopupRequested(const String& id, const String& popup) {
  DispatchEvent(*MakeGarbageCollected<DomicileExtensionPopupEvent>(
      domicile_event_names::Extensionpopuprequested(), id, popup));
}

// An answer to searchFiles(): it settles the promise that asked it.
void DomicileHost::Files(const String& query,
                         const Vector<String>& files,
                         uint32_t matched,
                         bool indexing) {
  auto* answer = DomicileFileSearch::Create();
  answer->setFiles(files);
  answer->setMatched(matched);
  answer->setIndexing(indexing);
  Settle(file_search_, file_search_query_, query, answer);
}

// Pushed, unlike Files: the compositor hears a copy without
// anybody asking. The rows are built here rather than carried as two arrays
// because what a panel draws is a row -- see `domicile_clipboard_entry.h`.
void DomicileHost::Clipboard(
    Vector<domicile::mojom::blink::ClipboardEntryPtr> entries) {
  HeapVector<Member<DomicileClipboardEntry>> history;
  history.reserve(entries.size());
  for (const auto& entry : entries) {
    history.push_back(MakeGarbageCollected<DomicileClipboardEntry>(
        entry->id, entry->image, entry->preview, entry->thumbnail));
  }
  clipboard_ = MakeGarbageCollected<FrozenArray<DomicileClipboardEntry>>(
      std::move(history));
  DispatchEvent(*Event::Create(domicile_event_names::Clipboardchanged()));
}

// Pushed, like Clipboard: an icon is the session bus's, which the compositor
// hears without anybody asking.
void DomicileHost::Tray(Vector<domicile::mojom::blink::TrayItemPtr> items) {
  HeapVector<Member<DomicileTrayItem>> tray;
  tray.reserve(items.size());
  for (const auto& item : items) {
    tray.push_back(MakeGarbageCollected<DomicileTrayItem>(
        item->id, item->title, item->icon, item->bus, item->menu,
        item->item_is_menu));
  }
  tray_items_ =
      MakeGarbageCollected<FrozenArray<DomicileTrayItem>>(std::move(tray));
  DispatchEvent(*Event::Create(domicile_event_names::Traychanged()));
}

// Pushed, like Tray: a notification is a call on the session bus, which the
// compositor hears without anybody asking.
void DomicileHost::Notifications(
    Vector<domicile::mojom::blink::NotificationPtr> items) {
  HeapVector<Member<DomicileNotification>> notifications;
  notifications.reserve(items.size());
  for (const auto& item : items) {
    HeapVector<Member<DomicileNotificationAction>> actions;
    actions.reserve(item->actions.size());
    for (const auto& action : item->actions) {
      actions.push_back(MakeGarbageCollected<DomicileNotificationAction>(
          action->key, action->label));
    }
    notifications.push_back(MakeGarbageCollected<DomicileNotification>(
        item->id, item->app_name, item->summary, item->body, item->icon,
        item->urgency, std::move(actions), item->clickable, item->timeout_ms,
        item->time, item->browser_window));
  }
  notifications_ = MakeGarbageCollected<FrozenArray<DomicileNotification>>(
      std::move(notifications));
  DispatchEvent(*Event::Create(domicile_event_names::Notificationschanged()));
}

// Pushed, like Clipboard, and the one pushed message this page can cause:
// `setTheme` above is answered with it, to every chrome on the desk rather
// than to the one that called. Through the wire name, for `AppCursor`'s
// reason and with `AppCursor`'s unreachable CHECK.
void DomicileHost::ThemeChanged(domicile::mojom::blink::Theme theme) {
  theme_ = PageTheme(theme);
  DispatchEvent(*Event::Create(domicile_event_names::Themechanged()));
}

// The same closed set as `theme`, about the desk's windows rather than its
// chrome.
void DomicileHost::WindowsThemeChanged(domicile::mojom::blink::Theme theme) {
  windows_theme_ = PageTheme(theme);
  DispatchEvent(*Event::Create(domicile_event_names::Windowsthemechanged()));
}

// A state like `theme`, so all three are set before the one event.
void DomicileHost::AppearanceChanged(const String& accent_color,
                                     bool high_contrast,
                                     bool reduced_motion) {
  accent_color_ = accent_color;
  high_contrast_ = high_contrast;
  reduced_motion_ = reduced_motion;
  DispatchEvent(*Event::Create(domicile_event_names::Appearancechanged()));
}

// Pushed like Clipboard, and a state rather than an edge -- the compositor
// decides the edge, because lighting a connector is a modeset and a dark desk
// must not ask for one per tick, and then sends where the desk stands so that
// a page which has only just loaded is not left drawing a desktop somebody is
// at. See `crate::idle` in the compositor.
void DomicileHost::Idle(bool idle) {
  idle_ = idle;
  DispatchEvent(*Event::Create(domicile_event_names::Idlechanged()));
}

// Pushed like Idle above, and a state for its reason with the stakes the other
// way up: the edge a reloaded page missed is the one that would have raised its
// lock screen, and the compositor holding the lock is what makes a reload
// something the desk survives rather than something that opens it. See
// `crate::lock` in the compositor.
void DomicileHost::Locked(bool locked) {
  locked_ = locked;
  DispatchEvent(*Event::Create(domicile_event_names::Lockedchanged()));
}

// Pushed like ThemeChanged. Its keys resolve the chords grabbed by name and
// do not reach the page; its options do, as the text they came as. See
// ControlChannelClient::ShellConfig.
void DomicileHost::ShellConfig(const String& config) {
  if (std::unique_ptr<JSONObject> parsed = JSONObject::From(ParseJSON(config))) {
    // The options, dispatched when they change. A line without them leaves
    // the last ones heard, as for the keys below.
    String options;
    if (parsed->GetString("options", &options) && options != shell_options_) {
      shell_options_ = options;
      DispatchEvent(
          *Event::Create(domicile_event_names::Shelloptionschanged()));
    }
    // The keys, for the chords grabbed by name. A line without them leaves
    // the last keyboard heard in place: the browser forwards only what
    // parsed.
    if (JSONObject* keys = parsed->GetJSONObject("keys")) {
      HashMap<String, uint32_t> read;
      for (wtf_size_t at = 0; at < keys->size(); ++at) {
        const JSONObject::Entry entry = keys->at(at);
        int keycode = 0;
        if (entry.second->AsInteger(&keycode) && keycode > 0) {
          read.Set(entry.first, static_cast<uint32_t>(keycode));
        }
      }
      keys_ = std::move(read);
      ResolveChords();
    }
  }
}

void DomicileHost::FocusChanged(const String& app_id) {
  // Empty is the shell's page holding the keyboard, which `focusedWindow`
  // says as null.
  //
  // Dispatched for every word the compositor says about the keyboard, not
  // only when it moves: the first is also the end of the windows replayed to
  // a channel that has just bound, and a shell that waits for it is how it
  // tells a window opened now from one that was already running.
  focused_window_ = app_id.empty() ? String() : app_id;
  // The keys this page forwards go where the compositor says the keyboard is,
  // and not only where the page last asked: it moves the keyboard on its own
  // too, and a page that heard only its own asks went on forwarding every key
  // to a client that no longer had it.
  keyboard_app_ = focused_window_;
  TellWhetherTheKeyboardWindowInhibits();
  DispatchEvent(*Event::Create(domicile_event_names::Focusedwindowchanged()));
}

// Deliberately not `focusedWindow`: that says where the keyboard went and this
// says a client would like it. A page that conflated them would grant every
// request by drawing it as granted.
void DomicileHost::FocusRequested(const String& app_id) {
  DispatchOrHold(*MakeGarbageCollected<DomicileAppEvent>(
      domicile_event_names::Focusrequested(), app_id));
}

// Uses the windows' pipe, not the channel's, as activateExtension uses the
// tray's. EnsureBound binds them together.
void DomicileHost::openBrowserWindow(ScriptState*,
                                     const String& url,
                                     const String& partition,
                                     ExceptionState& exception_state) {
  OpenBrowserWindow(url, WindowKind::kBrowser, partition, exception_state);
}

void DomicileHost::openPrivateBrowserWindow(ScriptState*,
                                            const String& url,
                                            ExceptionState& exception_state) {
  OpenBrowserWindow(url, WindowKind::kPrivate, g_empty_string,
                    exception_state);
}

namespace {

// openAppWindow()'s `reuse`, or nothing for a name it does not take.
std::optional<domicile::mojom::blink::AppReuse> AppReuseNamed(
    const String& reuse) {
  if (reuse == "new") {
    return domicile::mojom::blink::AppReuse::kNew;
  }
  if (reuse == "focus") {
    return domicile::mojom::blink::AppReuse::kFocus;
  }
  if (reuse == "navigate") {
    return domicile::mojom::blink::AppReuse::kNavigate;
  }
  return std::nullopt;
}

// The browser's answer to countBrowserWindowMatches(): the count, or nothing
// when the window is gone or its page gave no number.
void SettleBrowserWindowCount(ScriptPromiseResolver<IDLLong>* resolver,
                              std::optional<int32_t> count) {
  if (!count.has_value()) {
    resolver->RejectWithDOMException(
        DOMExceptionCode::kInvalidStateError,
        "The browser window is gone, or its page gave no count.");
    return;
  }
  resolver->Resolve(*count);
}

}  // namespace

void DomicileHost::openAppWindow(ScriptState*,
                                 const String& url,
                                 const String& app_id,
                                 const String& reuse,
                                 ExceptionState& exception_state) {
  // Resolved against this document, as openBrowserWindow's is.
  const KURL resolved = window_->CompleteURL(url);
  if (!resolved.IsValid()) {
    exception_state.ThrowTypeError("url must be an address");
    return;
  }
  const std::optional<domicile::mojom::blink::AppReuse> named =
      AppReuseNamed(reuse);
  if (!named.has_value()) {
    exception_state.ThrowTypeError(
        "reuse must be \"new\", \"focus\" or \"navigate\"");
    return;
  }
  if (*named != domicile::mojom::blink::AppReuse::kNew && app_id.empty()) {
    exception_state.ThrowTypeError(
        "reuse \"focus\" or \"navigate\" needs an appId to find the window "
        "by");
    return;
  }
  if (Ready(exception_state)) {
    windows_->OpenApp(resolved, app_id, *named);
  }
}

ScriptPromise<IDLLong> DomicileHost::countBrowserWindowMatches(
    ScriptState* script_state,
    const String& id,
    const String& selector,
    ExceptionState& exception_state) {
  // Parsed here, so a bad selector throws as a <webview>'s countMatches()
  // does instead of rejecting later.
  window_->document()->QuerySelector(AtomicString(selector), exception_state);
  if (exception_state.HadException()) {
    return EmptyPromise();
  }
  if (!Ready(exception_state)) {
    return EmptyPromise();
  }
  auto* resolver = MakeGarbageCollected<ScriptPromiseResolver<IDLLong>>(
      script_state, exception_state.GetContext());
  auto promise = resolver->Promise();
  windows_->CountMatches(
      id, selector,
      BindOnce(&SettleBrowserWindowCount, WrapPersistent(resolver)));
  return promise;
}

void DomicileHost::OpenBrowserWindow(const String& url,
                                     WindowKind kind,
                                     const String& partition,
                                     ExceptionState& exception_state) {
  // Resolved against this document, as a <webview src> is. An unresolvable
  // address is a shell bug, so it throws a TypeError instead of opening an
  // empty window.
  const KURL resolved = window_->CompleteURL(url);
  if (!resolved.IsValid()) {
    exception_state.ThrowTypeError("url must be an address");
    return;
  }
  // The one name ParseWebViewPartition refuses
  // (components/domicile/browser/web_view_partition.h). The browser treats it
  // as a bad message, so a shell bug throws here instead.
  if (partition == "persist:") {
    exception_state.ThrowTypeError(
        "partition \"persist:\" names no partition to keep");
    return;
  }
  if (Ready(exception_state)) {
    switch (kind) {
      case WindowKind::kBrowser:
        windows_->Open(resolved, /*private_browsing=*/false, partition);
        break;
      case WindowKind::kPrivate:
        windows_->Open(resolved, /*private_browsing=*/true, partition);
        break;
    }
  }
}

void DomicileHost::closeBrowserWindow(ScriptState*,
                                      const String& id,
                                      ExceptionState& exception_state) {
  if (id.empty()) {
    exception_state.ThrowTypeError("id must be a browser window's id");
    return;
  }
  if (Ready(exception_state)) {
    windows_->Close(id);
  }
}

namespace {

// The browser's answer to startCasting(): the cast's route, or why there is
// none.
void Casting(ScriptPromiseResolver<IDLString>* resolver,
             const String& route,
             const String& error) {
  if (route.empty()) {
    resolver->RejectWithDOMException(DOMExceptionCode::kOperationError, error);
    return;
  }
  resolver->Resolve(route);
}

}  // namespace

ScriptPromise<IDLString> DomicileHost::startCasting(
    ScriptState* script_state,
    const String& id,
    ExceptionState& exception_state) {
  if (id.empty()) {
    exception_state.ThrowTypeError("id must be a TV's id");
    return EmptyPromise();
  }
  if (!Ready(exception_state)) {
    return EmptyPromise();
  }
  auto* resolver = MakeGarbageCollected<ScriptPromiseResolver<IDLString>>(
      script_state, exception_state.GetContext());
  auto promise = resolver->Promise();
  cast_->Cast(id, BindOnce(&Casting, WrapPersistent(resolver)));
  return promise;
}

void DomicileHost::stopCasting(ScriptState*,
                               const String& route,
                               ExceptionState& exception_state) {
  if (route.empty()) {
    exception_state.ThrowTypeError("route must be a cast's route");
    return;
  }
  if (Ready(exception_state)) {
    cast_->Stop(route);
  }
}

void DomicileHost::cancelDownload(ScriptState*,
                                  const String& id,
                                  ExceptionState& exception_state) {
  if (id.empty()) {
    exception_state.ThrowTypeError("id must be a download's id");
    return;
  }
  if (Ready(exception_state)) {
    downloads_remote_->Cancel(id);
  }
}

void DomicileHost::removeDownload(ScriptState*,
                                  const String& id,
                                  ExceptionState& exception_state) {
  if (id.empty()) {
    exception_state.ThrowTypeError("id must be a download's id");
    return;
  }
  if (Ready(exception_state)) {
    downloads_remote_->Remove(id);
  }
}

void DomicileHost::clearDownloads(ScriptState*,
                                  ExceptionState& exception_state) {
  if (Ready(exception_state)) {
    downloads_remote_->Clear();
  }
}

namespace {

// A switch rather than a wire name, as for MojoTrayAction.
domicile::mojom::blink::PictureInPictureAction MojoPictureInPictureAction(
    V8DomicilePictureInPictureAction action) {
  switch (action.AsEnum()) {
    case V8DomicilePictureInPictureAction::Enum::kPlay:
      return domicile::mojom::blink::PictureInPictureAction::kPlay;
    case V8DomicilePictureInPictureAction::Enum::kPause:
      return domicile::mojom::blink::PictureInPictureAction::kPause;
    case V8DomicilePictureInPictureAction::Enum::kPreviousTrack:
      return domicile::mojom::blink::PictureInPictureAction::kPreviousTrack;
    case V8DomicilePictureInPictureAction::Enum::kNextTrack:
      return domicile::mojom::blink::PictureInPictureAction::kNextTrack;
    case V8DomicilePictureInPictureAction::Enum::kBackToPage:
      return domicile::mojom::blink::PictureInPictureAction::kBackToPage;
    case V8DomicilePictureInPictureAction::Enum::kClose:
      return domicile::mojom::blink::PictureInPictureAction::kClose;
  }
}

}  // namespace

// An empty id throws, as cancelDownload's does: it is a shell that forgot to
// say which video, rather than one that raced the video's end.
void DomicileHost::actOnPictureInPictureVideo(
    ScriptState*,
    const String& id,
    V8DomicilePictureInPictureAction action,
    ExceptionState& exception_state) {
  if (id.empty()) {
    exception_state.ThrowTypeError("id must be a picture-in-picture video's");
    return;
  }
  if (Ready(exception_state)) {
    picture_in_picture_->Act(id, MojoPictureInPictureAction(action));
  }
}

void DomicileHost::resizePictureInPictureVideo(
    ScriptState*,
    const String& id,
    uint32_t width,
    uint32_t height,
    ExceptionState& exception_state) {
  if (id.empty()) {
    exception_state.ThrowTypeError("id must be a picture-in-picture video's");
    return;
  }
  if (Ready(exception_state)) {
    picture_in_picture_->Resize(
        id, gfx::Size(base::saturated_cast<int>(width),
                      base::saturated_cast<int>(height)));
  }
}

namespace {

// The browser's answer to fetchWithCookies(): a response, or why there is
// none.
void Fetched(ScriptPromiseResolver<DomicileFetchResponse>* resolver,
             domicile::mojom::blink::ShellFetchResponsePtr response,
             const String& error) {
  if (!response) {
    resolver->RejectWithDOMException(DOMExceptionCode::kNetworkError, error);
    return;
  }
  auto* answer = DomicileFetchResponse::Create();
  answer->setStatus(response->status);
  answer->setUrl(response->url.GetString());
  answer->setBody(response->body);
  resolver->Resolve(answer);
}

}  // namespace

// Not Ready(): the browser answers this, and a fetch should not open the
// compositor's channel.
ScriptPromise<DomicileFetchResponse> DomicileHost::fetchWithCookies(
    ScriptState* script_state,
    const String& url,
    const String& method,
    const HeapVector<Member<DomicileFetchHeader>>& headers,
    const String& body,
    const String& sapisid_hash_origin,
    ExceptionState& exception_state) {
  const KURL resolved = window_->CompleteURL(url);
  if (!resolved.IsValid()) {
    exception_state.ThrowTypeError("url must be an address");
    return EmptyPromise();
  }
  if (!window_->GetFrame()) {
    exception_state.ThrowDOMException(
        DOMExceptionCode::kInvalidStateError,
        "There is no browser for this document to fetch through.");
    return EmptyPromise();
  }
  if (!shell_fetch_.is_bound()) {
    window_->GetBrowserInterfaceBroker().GetInterface(
        shell_fetch_.BindNewPipeAndPassReceiver(
            window_->GetTaskRunner(TaskType::kInternalDefault)));
  }
  Vector<domicile::mojom::blink::ShellFetchHeaderPtr> sent;
  sent.reserve(headers.size());
  for (const auto& header : headers) {
    sent.push_back(domicile::mojom::blink::ShellFetchHeader::New(
        header->name(), header->value()));
  }
  auto* resolver =
      MakeGarbageCollected<ScriptPromiseResolver<DomicileFetchResponse>>(
          script_state, exception_state.GetContext());
  auto promise = resolver->Promise();
  // The browser checks the method and the body: see shell_fetch.h.
  shell_fetch_->Fetch(resolved, method, std::move(sent), body,
                      sapisid_hash_origin,
                      BindOnce(&Fetched, WrapPersistent(resolver)));
  return promise;
}

// Stored, like Displays: the event signals a change and the attribute holds
// the list, so a shell that mounts late can still read it.
void DomicileHost::WindowsChanged(
    Vector<domicile::mojom::blink::BrowserWindowPtr> windows) {
  HeapVector<Member<DomicileBrowserWindow>> listed;
  listed.reserve(windows.size());
  for (const auto& window : windows) {
    listed.push_back(MakeGarbageCollected<DomicileBrowserWindow>(
        window->id, window->url.GetString(), window->title,
        window->popup_window == 0 ? std::nullopt
                                  : std::optional<int32_t>(window->popup_window),
        window->width, window->height, window->private_browsing,
        window->partition, window->app, window->app_id, window->captured));
  }
  browser_windows_ = MakeGarbageCollected<FrozenArray<DomicileBrowserWindow>>(
      std::move(listed));
  DispatchEvent(
      *Event::Create(domicile_event_names::Browserwindowschanged()));
}

// Stored, like WindowsChanged.
void DomicileHost::SinksChanged(
    Vector<domicile::mojom::blink::CastSinkPtr> sinks) {
  HeapVector<Member<DomicileCastSink>> listed;
  listed.reserve(sinks.size());
  for (const auto& sink : sinks) {
    listed.push_back(MakeGarbageCollected<DomicileCastSink>(
        sink->id, sink->name, sink->route.empty() ? String() : sink->route));
  }
  cast_sinks_ =
      MakeGarbageCollected<FrozenArray<DomicileCastSink>>(std::move(listed));
  DispatchEvent(*Event::Create(domicile_event_names::Castsinkschanged()));
}

namespace {

V8DomicileDownloadState DownloadStateOf(
    domicile::mojom::blink::DownloadState state) {
  switch (state) {
    case domicile::mojom::blink::DownloadState::kInProgress:
      return V8DomicileDownloadState(
          V8DomicileDownloadState::Enum::kInProgress);
    case domicile::mojom::blink::DownloadState::kComplete:
      return V8DomicileDownloadState(V8DomicileDownloadState::Enum::kComplete);
    case domicile::mojom::blink::DownloadState::kFailed:
      return V8DomicileDownloadState(V8DomicileDownloadState::Enum::kFailed);
  }
  NOTREACHED();
}

}  // namespace

// Stored, like WindowsChanged.
void DomicileHost::DownloadsChanged(
    Vector<domicile::mojom::blink::DownloadPtr> downloads) {
  HeapVector<Member<DomicileDownload>> listed;
  listed.reserve(downloads.size());
  for (const auto& download : downloads) {
    listed.push_back(MakeGarbageCollected<DomicileDownload>(
        download->id, DownloadStateOf(download->state), download->path,
        download->received_bytes, download->total_bytes, download->window,
        download->page.GetString()));
  }
  downloads_ =
      MakeGarbageCollected<FrozenArray<DomicileDownload>>(std::move(listed));
  DispatchEvent(*Event::Create(domicile_event_names::Downloadschanged()));
}

// Stored, like WindowsChanged.
void DomicileHost::VideosChanged(
    Vector<domicile::mojom::blink::PictureInPictureVideoPtr> videos) {
  HeapVector<Member<DomicilePictureInPictureVideo>> listed;
  listed.reserve(videos.size());
  for (const auto& video : videos) {
    listed.push_back(
        MakeGarbageCollected<DomicilePictureInPictureVideo>(*video));
  }
  picture_in_picture_videos_ =
      MakeGarbageCollected<FrozenArray<DomicilePictureInPictureVideo>>(
          std::move(listed));
  DispatchEvent(*Event::Create(
      domicile_event_names::Pictureinpicturevideoschanged()));
}

// A standard MessageEvent, so a line the page parses needs no event type of
// its own.
void DomicileHost::System(const String& message) {
  MessageEvent* event = MessageEvent::Create();
  event->initMessageEvent(domicile_event_names::System(), /*bubbles=*/false,
                          /*cancelable=*/false, message, /*origin=*/nullptr,
                          /*last_event_id=*/String(), /*source=*/nullptr,
                          /*ports=*/nullptr);
  DispatchEvent(*event);
}

// The page has heard the old compositor's windows close and its calls end by
// now. The new compositor knows nothing of this page, so its size and density
// go again, as on load. See "A compositor restart" in
// docs/architecture/ENGINE-FORK.md.
void DomicileHost::CompositorReplaced() {
  ReportDevicePixelRatio();
  ReportDesktopSize();
  DispatchEvent(*Event::Create(domicile_event_names::Compositorreplaced()));
}

void DomicileHost::PortalRequests(const String& message) {
  portal_requests_ = message;
  DispatchPortalRequests();
}

// A MessageEvent, as System() builds one.
void DomicileHost::DispatchPortalRequests() {
  MessageEvent* event = MessageEvent::Create();
  event->initMessageEvent(domicile_event_names::Portalrequests(),
                          /*bubbles=*/false, /*cancelable=*/false,
                          portal_requests_, /*origin=*/nullptr,
                          /*last_event_id=*/String(), /*source=*/nullptr,
                          /*ports=*/nullptr);
  DispatchEvent(*event);
}

void DomicileHost::AppTitled(const String& app_id, const String& title) {
  WindowNamed(app_id).title = title;
  WindowsChanged();
}

void DomicileHost::AppDesktopId(const String& app_id,
                                const String& desktop_id) {
  WindowNamed(app_id).desktop_id = desktop_id;
  WindowsChanged();
}

void DomicileHost::AppInhibitsShortcuts(const String& app_id, bool inhibits) {
  WindowNamed(app_id).inhibits_shortcuts = inhibits;
  TellWhetherTheKeyboardWindowInhibits();
  WindowsChanged();
}

const AtomicString& DomicileHost::InterfaceName() const {
  return event_target_names::kDomicileHost;
}

void DomicileHost::AddedEventListener(
    const AtomicString& event_type,
    RegisteredEventListener& registered_listener) {
  EventTarget::AddedEventListener(event_type, registered_listener);
  // On a task of its own rather than now: the listener is being added inside
  // the page's own `addEventListener` call, which should return before
  // anything is dispatched to it.
  for (const Member<Event>& event : held_) {
    if (event->type() == event_type) {
      if (window_) {
        window_->GetTaskRunner(TaskType::kInternalDefault)
            ->PostTask(FROM_HERE,
                       BindOnce(&DomicileHost::DeliverHeld,
                                WrapWeakPersistent(this), event_type));
      }
      break;
    }
  }
  // The latest requests again, on a task for the reason above. Every listener
  // hears it; requests are state, so hearing them twice changes nothing.
  if (event_type == domicile_event_names::Portalrequests() &&
      !portal_requests_.IsNull() && window_) {
    window_->GetTaskRunner(TaskType::kInternalDefault)
        ->PostTask(FROM_HERE,
                   BindOnce(&DomicileHost::DispatchPortalRequests,
                            WrapWeakPersistent(this)));
  }
  // Binding is what opens the inbound direction, so a listener registered
  // before anything has been called has to be what opens it. Ignoring the
  // failure is deliberate: there is no exception channel here, and a document
  // with no frame has nothing to hear anyway.
  EnsureBound();
}

ExecutionContext* DomicileHost::GetExecutionContext() const {
  return window_.Get();
}

void DomicileHost::Trace(Visitor* visitor) const {
  visitor->Trace(displays_);
  visitor->Trace(browser_windows_);
  visitor->Trace(cast_sinks_);
  visitor->Trace(downloads_);
  visitor->Trace(picture_in_picture_videos_);
  visitor->Trace(client_windows_);
  visitor->Trace(held_);
  visitor->Trace(file_search_);
  visitor->Trace(clipboard_);
  visitor->Trace(tray_items_);
  visitor->Trace(notifications_);
  visitor->Trace(extensions_);
  visitor->Trace(window_);
  visitor->Trace(channel_);
  visitor->Trace(client_receiver_);
  visitor->Trace(tray_);
  visitor->Trace(tray_receiver_);
  visitor->Trace(resize_listener_);
  visitor->Trace(key_listener_);
  visitor->Trace(key_up_listener_);
  visitor->Trace(density_query_);
  visitor->Trace(density_listener_);
  visitor->Trace(windows_);
  visitor->Trace(windows_receiver_);
  visitor->Trace(cast_);
  visitor->Trace(cast_receiver_);
  visitor->Trace(downloads_remote_);
  visitor->Trace(downloads_receiver_);
  visitor->Trace(picture_in_picture_);
  visitor->Trace(picture_in_picture_receiver_);
  visitor->Trace(shell_fetch_);
  visitor->Trace(input_listeners_);
  EventTarget::Trace(visitor);
  AppInputClient::Trace(visitor);
}

}  // namespace blink
