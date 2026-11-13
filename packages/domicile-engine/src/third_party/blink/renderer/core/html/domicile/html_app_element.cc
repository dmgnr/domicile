// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "third_party/blink/renderer/core/html/domicile/html_app_element.h"

#include <cmath>
#include <optional>

#include "base/functional/callback_helpers.h"
#include "base/logging.h"
#include "base/no_destructor.h"
#include "base/notreached.h"
#include "base/numerics/safe_conversions.h"
#include "base/time/time.h"
#include "cc/layers/deadline_policy.h"
#include "components/domicile/common/synced_frame.h"
#include "third_party/blink/public/platform/browser_interface_broker_proxy.h"
#include "third_party/blink/public/platform/task_type.h"
#include "third_party/blink/renderer/core/dom/document.h"
#include "third_party/blink/renderer/core/dom/element_traversal.h"
#include "third_party/blink/renderer/core/dom/events/add_event_listener_options_resolved.h"
#include "third_party/blink/renderer/core/dom/events/native_event_listener.h"
#include "third_party/blink/renderer/core/event_type_names.h"
#include "third_party/blink/renderer/core/events/mouse_event.h"
#include "third_party/blink/renderer/core/events/pointer_event.h"
#include "third_party/blink/renderer/core/events/wheel_event.h"
#include "third_party/blink/renderer/core/execution_context/execution_context.h"
#include "third_party/blink/renderer/core/frame/local_frame.h"
#include "third_party/blink/renderer/core/html/domicile/layout_app_surface.h"
#include "third_party/blink/renderer/core/html_names.h"
#include "third_party/blink/renderer/core/input/event_handler.h"
#include "third_party/blink/renderer/core/layout/layout_object.h"
#include "third_party/blink/renderer/core/layout/layout_replaced.h"
#include "third_party/blink/renderer/core/page/chrome_client.h"
#include "third_party/blink/renderer/core/page/page.h"
#include "third_party/blink/renderer/platform/heap/garbage_collected.h"
#include "third_party/blink/renderer/platform/heap/persistent.h"
#include "third_party/blink/renderer/platform/wtf/functional.h"

namespace blink {

namespace {

// Linux input-event-codes.h, for MouseEvent.button's 0 primary, 1 auxiliary
// and 2 secondary. Any other button has no code a client is sent.
std::optional<uint32_t> LinuxButton(int16_t button) {
  switch (button) {
    case 0:
      return 0x110;  // BTN_LEFT
    case 1:
      return 0x112;  // BTN_MIDDLE
    case 2:
      return 0x111;  // BTN_RIGHT
    default:
      return std::nullopt;
  }
}

// `wl_pointer.axis_value120` counts 120 per detent of a classic wheel, and a
// detent scrolls 100 pixels, 3 lines or 1 page -- the conventions browsers use.
constexpr double kValue120PerDetent = 120;
constexpr double kPixelsPerDetent = 100;

double PerDetent(unsigned delta_mode) {
  switch (delta_mode) {
    case WheelEvent::kDomDeltaPixel:
      return kPixelsPerDetent;
    case WheelEvent::kDomDeltaLine:
      return 3;
    case WheelEvent::kDomDeltaPage:
      return 1;
  }
  NOTREACHED();
}

// Multiplied before divided, so a whole number of detents stays exact: the
// commonest wheel is a pixel one, whose delta has to pass through untouched.
double Rescale(double delta, double target, double per_detent) {
  return delta * target / per_detent;
}

// JavaScript's Math.round, which halves upward, rather than std::lround,
// which halves away from zero: the value a scroll of -2.5 steps was sent as.
int32_t RoundHalfUp(double value) {
  return base::ClampFloor<int32_t>(value + 0.5);
}

// The video in picture-in-picture an <app> shows in place of a window. Not in
// html_attribute_names.json5, as <webview>'s `window` is not: the list is
// Blink's, and every name in it recompiles most of Blink.
constexpr char kPictureInPictureAttr[] = "picture-in-picture";

// The app's default handler must finish before Chromium decides whether a
// pinch wheel may zoom the shell. Only native-window regions block that ACK.
class AppWheelListener final : public NativeEventListener {
 public:
  void Invoke(ExecutionContext*, Event*) override {}
};

// The same for a finger: the compositor thread sends a touch to the page only
// where something listens for it, and a pointer listener counts only when the
// shell happens to have one. A blocking `touchstart` here makes every <app> a
// touch handler region, so a finger on a window always reaches
// `HTMLAppElement::ForwardTouch`. It never cancels: the shell still decides.
class AppTouchListener final : public NativeEventListener {
 public:
  void Invoke(ExecutionContext*, Event*) override {}
};

}  // namespace

const char AppInputClient::kSupplementName[] = "AppInputClient";

AppInputClient* AppInputClient::From(LocalDOMWindow& window) {
  return Supplement<LocalDOMWindow>::From<AppInputClient>(window);
}

AppInputClient::AppInputClient(LocalDOMWindow& window)
    : Supplement<LocalDOMWindow>(window) {}

void AppInputClient::Trace(Visitor* visitor) const {
  Supplement<LocalDOMWindow>::Trace(visitor);
}

HTMLAppElement::HTMLAppElement(Document& document)
    : HTMLElement(html_names::kAppTag, document),
      // Null for a document with no window, which HeapMojoRemote accepts, as
      // <webview>'s do. Nothing binds before there is a frame.
      picture_in_picture_(document.GetExecutionContext()),
      picture_in_picture_surface_(this, document.GetExecutionContext()) {
  AddEventListenerOptionsResolved options;
  options.SetPassive(false);
  addEventListener(event_type_names::kWheel,
                   MakeGarbageCollected<AppWheelListener>(), options);
  addEventListener(event_type_names::kTouchstart,
                   MakeGarbageCollected<AppTouchListener>(), options);
}

HTMLAppElement::~HTMLAppElement() = default;

LayoutObject* HTMLAppElement::CreateLayoutObject(const ComputedStyle& style) {
  return MakeGarbageCollected<LayoutAppSurface>(this);
}

cc::Layer* HTMLAppElement::ContentsCcLayer() const {
  return surface_layer_bridge_ ? surface_layer_bridge_->GetCcLayer() : nullptr;
}

void HTMLAppElement::ParseAttribute(
    const AttributeModificationParams& params) {
  if (params.name == html_names::kAppIdAttr) {
    CancelPinch();
    CancelTouches();
    // Re-embed into the existing layer so the element keeps its box and its
    // place in the layer tree.
    Embed();
    return;
  }
  if (params.name == html_names::kFrameAttr) {
    ShowFrame();
    return;
  }
  if (params.name.LocalName() == kPictureInPictureAttr) {
    ShowPictureInPicture();
    return;
  }
  if (params.name == html_names::kResizingAttr) {
    // While resizing, the client's latest frame shows at its own size until
    // it draws at the new box. Stretched, it would snap to the client's frame
    // on every arrival.
    if (surface_layer_bridge_) {
      surface_layer_bridge_->SetStretchContentToFillBounds(
          params.new_value.IsNull());
    }
    // The last box of a resize may show before the client drew at it. Embed
    // it again with the default deadline, so the box and the window settle in
    // one frame.
    if (params.new_value.IsNull() && embedded_without_waiting_) {
      Embed();
    }
    return;
  }
  HTMLElement::ParseAttribute(params);
}

Node::InsertionNotificationRequest HTMLAppElement::InsertedInto(
    ContainerNode& insertion_point) {
  // No box until layout runs. LayoutAppSurface calls SurfaceBoxChanged() then.
  return HTMLElement::InsertedInto(insertion_point);
}

void HTMLAppElement::RemovedFrom(ContainerNode& insertion_point) {
  CancelPinch();
  CancelTouches();
  // Keep the embedder: a moved element shows the same window. A new embedder
  // would wait for the producer to reconnect, which a running client never
  // does.
  HTMLElement::RemovedFrom(insertion_point);
}

void HTMLAppElement::SurfaceBoxChanged(const gfx::Size& size) {
  if (size == configured_size_) {
    return;
  }
  configured_size_ = size;
  Embed();
}

bool HTMLAppElement::CreateLayer() {
  DCHECK(!surface_layer_bridge_);
  LocalFrame* frame = GetDocument().GetFrame();
  if (!frame || !frame->GetPage()) {
    return false;
  }
  surface_layer_bridge_ = std::make_unique<::blink::SurfaceLayerBridge>(
      frame->GetPage()->GetChromeClient().GetFrameSinkId(frame), this,
      base::NullCallback());
  surface_layer_bridge_->SetStretchContentToFillBounds(
      !FastHasAttribute(html_names::kResizingAttr));
  // Placeholder so the element has a layer from its first frame.
  surface_layer_bridge_->CreateSolidColorLayer();
  SetNeedsCompositingUpdate();
  return true;
}

void HTMLAppElement::Embed() {
  const AtomicString& app_id = FastGetAttribute(html_names::kAppIdAttr);
  if (app_id.empty()) {
    return;
  }
  LocalFrame* frame = GetDocument().GetFrame();
  if (!frame || !frame->GetPage()) {
    return;
  }
  // Wait for layout. A Wayland client configured at 0x0 draws nothing.
  if (configured_size_.IsEmpty()) {
    return;
  }
  if (!surface_layer_bridge_ && !CreateLayer()) {
    return;
  }

  // One request at a time. The browser holds the reply until a producer
  // connects, so a second request would queue with possibly stale arguments.
  // OnEmbedded() retries instead.
  if (embed_in_flight_) {
    embed_stale_ = true;
    return;
  }

  const bool reconfiguring = !!external_surface_embedder_;
  if (!reconfiguring) {
    // WrapWeakPersistent: the element owns the embedder, which owns this
    // callback.
    external_surface_embedder_ = std::make_unique<ExternalSurfaceEmbedder>(
        frame->GetBrowserInterfaceBroker(),
        BindRepeating(&HTMLAppElement::OnSurfaceLost,
                      WrapWeakPersistent(this)));
  }
  embed_in_flight_ = true;
  embed_stale_ = false;
  allocated_ = external_surface_embedder_->Embed(
      app_id, frame->GetPage()->GetChromeClient().GetFrameSinkId(frame),
      configured_size_,
      // The box is in device pixels and the client is configured in logical
      // ones. Each monitor's page has its own scale, so the page sends it.
      frame->LayoutZoomFactor(),
      reconfiguring ? ExternalSurfaceEmbedder::Allocation::kReconfigure
                    : ExternalSurfaceEmbedder::Allocation::kAdopt,
      // WrapWeakPersistent: the embedder owns this callback too. A strong
      // one would keep a removed element, and its pipe, alive while the
      // browser holds the embed.
      BindOnce(&HTMLAppElement::OnEmbedded, WrapWeakPersistent(this), app_id));

  // A shown window resized: its frame sink is known, so embed the surface for
  // the new box in the frame whose layout changed it. Viz holds that frame
  // until the client draws at the new size, up to the default deadline, so the
  // box and the window change together instead of the old frame stretching.
  //
  // While `resizing` is set, deadline 0: an interactive resize changes the box
  // every frame, and waiting each time would hold the whole page to the
  // client's pace.
  if (app_id == embedded_app_id_) {
    embedded_without_waiting_ = FastHasAttribute(html_names::kResizingAttr);
    surface_layer_bridge_->EmbedSurface(
        viz::SurfaceId(surface_layer_bridge_->GetSurfaceId().frame_sink_id(),
                       AtFrame(allocated_)),
        embedded_without_waiting_
            ? cc::DeadlinePolicy::UseSpecifiedDeadline(0u)
            : cc::DeadlinePolicy::UseDefaultDeadline());
  }
}

void HTMLAppElement::OnEmbedded(
    const AtomicString& app_id,
    const std::optional<viz::SurfaceId>& surface_id) {
  embed_in_flight_ = false;
  const std::optional<viz::SurfaceId> shown =
      surface_id ? std::make_optional(viz::SurfaceId(
                       surface_id->frame_sink_id(),
                       AtFrame(surface_id->local_surface_id())))
                 : std::nullopt;
  // Embedding the id Embed() already did would drop its deadline.
  if (shown && surface_layer_bridge_ &&
      *shown != surface_layer_bridge_->GetSurfaceId()) {
    // SurfaceLayerBridge accepts any SurfaceId, so the window becomes an
    // ordinary layer.
    surface_layer_bridge_->EmbedSurface(*shown);
  }
  embedded_app_id_ = surface_id ? app_id : g_null_atom;
  if (embed_stale_) {
    // app-id or the box changed while the request was in flight.
    Embed();
  }
}

namespace {

// Every window's newest synced frame, for the whole renderer: a frame names a
// surface of the compositor's, the same for every page that embeds it.
domicile::KnownFrames& Known() {
  static base::NoDestructor<domicile::KnownFrames> known;
  return *known;
}

}  // namespace

// static
void HTMLAppElement::FrameHeard(Document& document,
                                const String& app_id,
                                uint32_t frame) {
  Known().Heard(app_id.Utf8(), frame);
  for (HTMLAppElement& app :
       Traversal<HTMLAppElement>::DescendantsOf(document)) {
    if (!app.FastHasAttribute(html_names::kFrameAttr) &&
        app.FastGetAttribute(html_names::kAppIdAttr) == app_id) {
      app.ShowFrame();
    }
  }
}

// static
void HTMLAppElement::FramesForgotten(const String& app_id) {
  Known().Forget(app_id.Utf8());
}

viz::LocalSurfaceId HTMLAppElement::AtFrame(
    const viz::LocalSurfaceId& allocated) const {
  const std::optional<uint32_t> set =
      FastHasAttribute(html_names::kFrameAttr)
          ? std::make_optional(
                GetUnsignedIntegralAttribute(html_names::kFrameAttr))
          : std::nullopt;
  return domicile::AtSyncedFrame(
      allocated,
      Known().Shown(FastGetAttribute(html_names::kAppIdAttr).Utf8(), set));
}

void HTMLAppElement::ShowFrame() {
  // Viz holds the page's frame until the window's synced frame is there, so
  // whatever this update moved shows with it. `allocated_` is that window's
  // only once its surface is shown: a new app-id embeds afresh.
  if (!embedded_app_id_.IsNull() &&
      embedded_app_id_ == FastGetAttribute(html_names::kAppIdAttr)) {
    surface_layer_bridge_->EmbedSurface(
        viz::SurfaceId(surface_layer_bridge_->GetSurfaceId().frame_sink_id(),
                       AtFrame(allocated_)),
        cc::DeadlinePolicy::UseDefaultDeadline());
  }
}

// A restarted compositor brokers the app a new frame sink. Ask again: the
// browser holds the request until it does, and the embedder has dropped the
// embed token viz would refuse on the new sink.
void HTMLAppElement::OnSurfaceLost() {
  embedded_app_id_ = g_null_atom;
  Embed();
}

void HTMLAppElement::OnWebLayerUpdated() {
  SetNeedsCompositingUpdate();
}

void HTMLAppElement::RegisterContentsLayer(cc::Layer* layer) {
  SetNeedsCompositingUpdate();
}

void HTMLAppElement::UnregisterContentsLayer(cc::Layer* layer) {
  SetNeedsCompositingUpdate();
}

// THE DEFAULT HANDLING, rather than a listener, which is what makes a page's
// own handling come first. Every listener on the page has had the event --
// a shell's container, its document, a React root -- before this runs, and a
// page that called `preventDefault()` has taken it: the press that starts an
// Alt-drag never reaches the client under it. It is also why a page cannot
// click into a client by script: Blink runs default handlers for trusted
// events only.
//
// Only for events aimed at this element. An <app> is a replaced element with
// no rendered children, so that is every event over it.
void HTMLAppElement::DefaultEventHandler(Event& event) {
  // A copy: a handler run from here can rewrite the attribute.
  const AtomicString app_id = FastGetAttribute(html_names::kAppIdAttr);
  LocalDOMWindow* window = GetDocument().domWindow();
  AppInputClient* client = window ? AppInputClient::From(*window) : nullptr;
  if (event.RawTarget() != this || app_id.empty() || !client) {
    HTMLElement::DefaultEventHandler(event);
    return;
  }
  // The menu the secondary button would open, which is the browser answering
  // a press already given away: the right button over a window is the
  // client's, and its own menu is drawn inside its own surface. Taken here and
  // nowhere else -- a page's own `contextmenu` listener still hears it, and a
  // right-click off every window still gets the page's menu.
  if (event.type() == event_type_names::kContextmenu) {
    event.SetDefaultHandled();
    return;
  }
  if (const auto* wheel = DynamicTo<WheelEvent>(event);
      wheel && wheel->NativeEvent().has_native_pinch) {
    ForwardPinch(*client, app_id, *wheel);
    event.SetDefaultHandled();
    return;
  }
  ForwardInput(*client, app_id, event);
  HTMLElement::DefaultEventHandler(event);
}

void HTMLAppElement::ForwardPinch(AppInputClient& client,
                                  const String& app_id,
                                  const WheelEvent& wheel) {
  const auto& pinch = wheel.NativeEvent().native_pinch;
  if (pinch.phase == ui::NativePinchPhase::kBegin) {
    CancelPinch();
    ForwardMotion(client, app_id, wheel);
    active_pinch_ = pinch;
    pinch_app_id_ = app_id;
  } else if (!active_pinch_ || active_pinch_->device != pinch.device) {
    return;
  }
  client.AppPointerPinch(app_id, pinch);
  if (pinch.phase == ui::NativePinchPhase::kEnd) {
    active_pinch_.reset();
    pinch_app_id_ = String();
  } else {
    active_pinch_ = pinch;
  }
}

void HTMLAppElement::CancelPinch() {
  if (!active_pinch_) {
    return;
  }
  auto pinch = *active_pinch_;
  active_pinch_.reset();
  pinch.phase = ui::NativePinchPhase::kEnd;
  pinch.canceled = true;
  if (auto* window = GetDocument().domWindow()) {
    if (auto* client = AppInputClient::From(*window)) {
      client->AppPointerPinch(pinch_app_id_, pinch);
    }
  }
  pinch_app_id_ = String();
}

void HTMLAppElement::ForwardInput(AppInputClient& client,
                                  const String& app_id,
                                  const Event& event) {
  const AtomicString& type = event.type();
  if (type == event_type_names::kWheel) {
    if (const auto* wheel = DynamicTo<WheelEvent>(event)) {
      const double per_detent = PerDetent(wheel->deltaMode());
      const auto& native = wheel->NativeEvent();
      // The client runs its own momentum from the axis stop. A page's fling
      // reaching it too would glide it twice.
      if (native.momentum_phase != blink::WebMouseWheelEvent::kPhaseNone) {
        return;
      }
      const bool is_wheel =
          native.native_scroll_source == ui::NativeScrollSource::kWheel ||
          native.native_scroll_source == ui::NativeScrollSource::kWheelTilt;
      client.AppPointerAxis(
          app_id,
          native.has_native_axis_distance
              ? -native.native_axis_distance_x
              : Rescale(wheel->deltaX(), kPixelsPerDetent, per_detent),
          native.has_native_axis_distance
              ? -native.native_axis_distance_y
              : Rescale(wheel->deltaY(), kPixelsPerDetent, per_detent),
          is_wheel ? RoundHalfUp(-native.wheel_ticks_x * kValue120PerDetent)
                   : 0,
          is_wheel ? RoundHalfUp(-native.wheel_ticks_y * kValue120PerDetent)
                   : 0,
          native.native_scroll_source, native.axis_stop_x, native.axis_stop_y);
    }
    return;
  }
  // `PointerEvent`, not `MouseEvent`: a `PointerEvent` says it is no
  // `MouseEvent` for every type but click, auxclick and contextmenu
  // (PointerEvent::IsMouseEvent), so `DynamicTo<MouseEvent>` is null for the
  // four handled below.
  const auto* pointer = DynamicTo<PointerEvent>(event);
  if (!pointer) {
    return;
  }
  if (pointer->pointerType() == "touch") {
    ForwardTouch(client, app_id, *pointer);
    return;
  }
  if (type == event_type_names::kPointermove) {
    ForwardMotion(client, app_id, *pointer);
  } else if (type == event_type_names::kPointerdown) {
    // Asked first: a click is the user reaching for this window, and the
    // keyboard follows it unless the shell says otherwise. Then where the
    // press is, then the press.
    client.AppPressed(*this, app_id);
    ForwardMotion(client, app_id, *pointer);
    if (const std::optional<uint32_t> button = LinuxButton(pointer->button())) {
      client.AppPointerButton(app_id, *button, true);
      // The pointer stays with this element until every button is up, as a
      // Wayland seat keeps it on the pressed surface. Without it the release
      // lands on whatever is under the pointer, and a button let go over the
      // page never reaches the client that holds the press.
      LocalFrame* frame = GetDocument().GetFrame();
      CHECK(frame);
      frame->GetEventHandler().SetPointerCapture(pointer->pointerId(), this);
    }
  } else if (type == event_type_names::kPointerup) {
    if (const std::optional<uint32_t> button = LinuxButton(pointer->button())) {
      client.AppPointerButton(app_id, *button, false);
    }
  } else if (type == event_type_names::kPointerout) {
    // `pointerout` rather than `pointerleave`: the two differ only for a
    // pointer moving into a descendant, and this element renders none. Moving
    // from one window straight to another tells the one left before the one
    // arrived at.
    client.AppPointerLeave(app_id);
  }
}

// A FINGER IS THE WINDOW'S AS A TOUCH. A client that reads `wl_touch` scrolls,
// zooms and drags under it as it would on any desktop; the compositor turns
// it into the pointer for a client that has no `wl_touch`, so neither path
// sends both.
//
// Blink captures a touch pointer to the element it went down on, so its moves
// and its lift come here wherever the finger goes, and `touch-action: none`
// on <app> (html.css) keeps the page from taking the finger to pan with, which
// would end it in a `pointercancel`.
void HTMLAppElement::ForwardTouch(AppInputClient& client,
                                  const String& app_id,
                                  const PointerEvent& pointer) {
  const AtomicString& type = pointer.type();
  const int32_t id = pointer.pointerId();
  // Milliseconds on the monotonic clock, wrapping as `wl_touch`'s do.
  const uint32_t time = static_cast<uint32_t>(
      (pointer.PlatformTimeStamp() - base::TimeTicks()).InMilliseconds());
  gfx::PointF point;
  gfx::SizeF size;
  if (type == event_type_names::kPointerdown) {
    if (!MapToContent(pointer, point, size)) {
      VLOG(1) << "domicile: a finger on " << app_id << " missed its content";
      return;
    }
    VLOG(1) << "domicile: a finger down on " << app_id << " at "
            << point.ToString();
    // A finger on another window first ends the points on the one before:
    // the element shows one window at a time.
    if (touch_app_id_ != app_id) {
      CancelTouches();
    }
    if (touches_.empty()) {
      // The first finger down is the user reaching for this window, as a
      // click is.
      client.AppPressed(*this, app_id);
    }
    touches_.push_back(id);
    touch_app_id_ = app_id;
    client.AppTouch(app_id, AppTouchPhase::kDown, id, time, point, size);
    return;
  }
  // The rest are for a point this element put down.
  const wtf_size_t index = touches_.Find(id);
  if (index == kNotFound || touch_app_id_ != app_id) {
    return;
  }
  if (type == event_type_names::kPointermove) {
    if (MapToContent(pointer, point, size)) {
      client.AppTouch(app_id, AppTouchPhase::kMotion, id, time, point, size);
    }
  } else if (type == event_type_names::kPointerup) {
    touches_.EraseAt(index);
    client.AppTouch(app_id, AppTouchPhase::kUp, id, time, point, size);
  } else if (type == event_type_names::kPointercancel) {
    CancelTouches();
  }
}

void HTMLAppElement::CancelTouches() {
  if (touches_.empty()) {
    return;
  }
  touches_.clear();
  const String app_id = touch_app_id_;
  touch_app_id_ = String();
  if (auto* window = GetDocument().domWindow()) {
    if (auto* client = AppInputClient::From(*window)) {
      client->AppTouch(app_id, AppTouchPhase::kCancel, 0, 0, gfx::PointF(),
                       gfx::SizeF());
    }
  }
}

// Motion is the one forward that needs a box: without one there is no point
// on the surface to report, where a press and a release still mean something.
//
// A STILL POINTER MOVES TOO. aura synthesizes a mouse move after a window
// changes or the displays are configured (`EF_IS_SYNTHESIZED`, which never
// reaches Blink), and Blink dispatches it as a `pointermove`. The client still
// hears it, so a window that appears under the pointer gets its enter, but the
// compositor must not read it as somebody at the desk, or blanking the screens,
// itself such a change, lights them again. Blink computes
// `movementX/Y` from the pointer's last place on the screen, so a synthesized
// move is the one with no movement.
void HTMLAppElement::ForwardMotion(AppInputClient& client,
                                   const String& app_id,
                                   const MouseEvent& event) {
  gfx::PointF point;
  gfx::SizeF size;
  if (MapToContent(event, point, size)) {
    const bool moved = event.movementX() != 0 || event.movementY() != 0;
    client.AppPointerMotion(app_id, point, size, moved);
    if (moved) {
      client.AppPointerRelative(
          app_id, gfx::Vector2dF(event.movementX(), event.movementY()),
          gfx::PointF(event.clientX(), event.clientY()), size);
    }
  }
}

// THE WHOLE TRANSFORM, INVERTED BY THE ENGINE THAT APPLIED IT. Every transform
// between this box and the document -- this element's own, each ancestor's,
// `zoom`, a perspective, the top layer's break from its ancestors -- is in the
// layout tree's mapping, which is what `MouseEvent.offsetX` is computed with.
// The same pairing as there: the event's absolute location, mapped into this
// layout object. Script had to reassemble this from `getBoundingClientRect`
// and computed styles, and could not follow a projection at all.
//
// The content box rather than the border box, because that is where the
// surface is drawn (LayoutAppSurface::PaintReplaced).
bool HTMLAppElement::MapToContent(const MouseEvent& event,
                                  gfx::PointF& point,
                                  gfx::SizeF& size) {
  GetDocument().UpdateStyleAndLayout(DocumentUpdateReason::kInput);
  const auto* box = DynamicTo<LayoutReplaced>(GetLayoutObject());
  if (!box) {
    return false;
  }
  const PhysicalRect content = box->ReplacedContentRect();
  if (content.IsEmpty()) {
    return false;
  }
  // Layout pixels are the element's CSS pixels times its effective zoom,
  // which is the page's zoom and every CSS `zoom` above it compounded.
  const float zoom = box->Style().EffectiveZoom();
  const gfx::PointF local =
      box->AbsoluteToLocalPoint(event.AbsoluteLocation()) -
      gfx::Vector2dF(content.offset);
  point = gfx::ScalePoint(local, 1 / zoom);
  size = gfx::ScaleSize(gfx::SizeF(content.size), 1 / zoom);
  // A transform that cannot be inverted maps to nothing worth sending.
  return std::isfinite(point.x()) && std::isfinite(point.y());
}

void HTMLAppElement::ShowPictureInPicture() {
  // A new id, or none: the old video's surface is no longer this element's.
  picture_in_picture_surface_.reset();
  const AtomicString& id = getAttribute(AtomicString(kPictureInPictureAttr));
  if (id.empty()) {
    return;
  }
  ExecutionContext* context = GetExecutionContext();
  LocalFrame* frame = GetDocument().GetFrame();
  if (!context || !frame || !frame->GetPage()) {
    return;
  }
  if (!surface_layer_bridge_ && !CreateLayer()) {
    return;
  }
  const scoped_refptr<base::SingleThreadTaskRunner> task_runner =
      context->GetTaskRunner(TaskType::kInternalDefault);
  if (!picture_in_picture_.is_bound()) {
    context->GetBrowserInterfaceBroker().GetInterface(
        picture_in_picture_.BindNewPipeAndPassReceiver(task_runner));
  }
  // The page's own frame sink is the video's parent while it is shown, so the
  // video's player draws at this page's BeginFrames.
  picture_in_picture_->Show(
      id, frame->GetPage()->GetChromeClient().GetFrameSinkId(frame),
      picture_in_picture_surface_.BindNewPipeAndPassRemote(task_runner));
}

// The video's player is not this page's: its surface is what its page's
// `<video>` shows, at the video's own size. Stretched to the element's box,
// as Chrome's window stretches it to its own; the shell keeps the shape.
void HTMLAppElement::SurfaceChanged(const viz::SurfaceId& surface_id) {
  surface_layer_bridge_->SetStretchContentToFillBounds(true);
  surface_layer_bridge_->EmbedSurface(surface_id);
}

void HTMLAppElement::Trace(Visitor* visitor) const {
  visitor->Trace(picture_in_picture_);
  visitor->Trace(picture_in_picture_surface_);
  HTMLElement::Trace(visitor);
}

}  // namespace blink
