// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef THIRD_PARTY_BLINK_RENDERER_CORE_HTML_DOMICILE_HTML_APP_ELEMENT_H_
#define THIRD_PARTY_BLINK_RENDERER_CORE_HTML_DOMICILE_HTML_APP_ELEMENT_H_

#include <memory>
#include <optional>

#include "components/domicile/mojom/picture_in_picture.mojom-blink.h"
#include "components/viz/common/surfaces/surface_id.h"
#include "third_party/blink/renderer/core/core_export.h"
#include "third_party/blink/renderer/core/frame/local_dom_window.h"
#include "third_party/blink/renderer/core/html/html_element.h"
#include "third_party/blink/renderer/platform/graphics/external_surface_embedder.h"
#include "third_party/blink/renderer/platform/graphics/surface_layer_bridge.h"
#include "third_party/blink/renderer/platform/mojo/heap_mojo_receiver.h"
#include "third_party/blink/renderer/platform/mojo/heap_mojo_remote.h"
#include "third_party/blink/renderer/platform/supplementable.h"
#include "third_party/blink/renderer/platform/wtf/vector.h"
#include "ui/events/types/native_pinch.h"
#include "ui/events/types/native_scroll_source.h"
#include "ui/gfx/geometry/point_f.h"
#include "ui/gfx/geometry/size.h"
#include "ui/gfx/geometry/size_f.h"
#include "ui/gfx/geometry/vector2d_f.h"

namespace blink {

class HTMLAppElement;
class MouseEvent;
class PointerEvent;
class WheelEvent;

// Where an <app> sends what lands on it: the desktop of the window it is in.
//
// Declared here and implemented in modules, by DomicileHost, because that is
// where the channel to the compositor is and core cannot call into modules. The
// desktop installs itself on its window and the element asks the window. A
// window with no desktop -- any page but the shell's -- has none, and an <app>
// on it sends nothing.
//
// The element maps and the desktop forwards: a point arrives in the element's
// own CSS pixels, and the desktop scales it to what the client drew, which is
// the compositor's to say and is in `DomicileHost.windows`.
// A touch point's step, as `wl_touch` has them. A cancel ends every point the
// window holds.
enum class AppTouchPhase { kDown, kMotion, kUp, kCancel };

class CORE_EXPORT AppInputClient : public Supplement<LocalDOMWindow> {
 public:
  static const char kSupplementName[];

  // The desktop of `window`, or null where it has none.
  static AppInputClient* From(LocalDOMWindow& window);

  explicit AppInputClient(LocalDOMWindow&);

  // A press on `app`, which shows `app_id`: ask the shell whether its window
  // takes the keyboard, and give it the keyboard unless the shell says no.
  virtual void AppPressed(HTMLAppElement& app, const String& app_id) = 0;
  // Where the pointer is over `app_id`: `point` within an element `size` big,
  // both in the element's own CSS pixels. `moved` is whether the pointer moved
  // on the screen; see `HTMLAppElement::ForwardMotion`.
  virtual void AppPointerMotion(const String& app_id,
                                const gfx::PointF& point,
                                const gfx::SizeF& size,
                                bool moved) = 0;
  // A hand moved the pointer over `app_id` by `movement`, in the page's CSS
  // pixels, to `on_page` in the page; `size` is the element's, as for
  // `AppPointerMotion`. Sent after that motion.
  virtual void AppPointerRelative(const String& app_id,
                                  const gfx::Vector2dF& movement,
                                  const gfx::PointF& on_page,
                                  const gfx::SizeF& size) = 0;
  // A Linux button code (input-event-codes.h), going down or coming up.
  virtual void AppPointerButton(const String& app_id,
                                uint32_t button,
                                bool pressed) = 0;
  virtual void AppPointerLeave(const String& app_id) = 0;
  virtual void AppPointerPinch(const String& app_id,
                               const ui::NativePinch& pinch) = 0;
  // A finger on `app_id`'s window. `id` names the point while it is down;
  // `time` is in milliseconds, as `wl_touch` counts. `point` and `size` are as
  // for motion, and mean nothing for an up or a cancel.
  virtual void AppTouch(const String& app_id,
                        AppTouchPhase phase,
                        int32_t id,
                        uint32_t time,
                        const gfx::PointF& point,
                        const gfx::SizeF& size) = 0;
  // A scroll as `wl_pointer` wants it: a distance and 120ths of a detent.
  virtual void AppPointerAxis(const String& app_id,
                              double dx,
                              double dy,
                              int32_t v120_x,
                              int32_t v120_y,
                              ui::NativeScrollSource source,
                              bool stop_x,
                              bool stop_y) = 0;

  void Trace(Visitor*) const override;
};

// <app> — a window belonging to a Wayland client, laid out by this page.
//
// It is a cc::SurfaceLayer embedding a viz surface that domicile-compositor
// submits the client's dmabuf to, which is the same mechanism an out-of-process
// <iframe> and a hardware-decoded <video> use. That is the point: the layer
// goes into this page's property trees with every other layer, so z-index,
// transform, clip, opacity, filter and blend apply to a window structurally
// rather than being reimplemented against it. See
// docs/architecture/ENGINE-FORK.md in the Domicile repository.
//
// Why an element and not a custom element: a custom element's name must contain
// a hyphen, per spec, and the tag a shell author writes is <app>. So the fork
// defines it, the way Electron's <webview> was defined.
//
// `app-id` says which window. It is a reflected content attribute, the way
// <img src> is, so setting it in HTML and setting it from script are the same
// operation and re-point the element at another client's surface.
//
// `picture-in-picture` instead names a page's video in picture-in-picture, as
// the desktop's `pictureInPictureVideos` lists it, and the element embeds the
// surface the video's player draws to: the shell draws the window Chrome
// floats. Nothing is sent to it; the pointer over it is the page's. See
// components/domicile/mojom/picture_in_picture.mojom.
class CORE_EXPORT HTMLAppElement final
    : public HTMLElement,
      public WebSurfaceLayerBridgeObserver,
      public domicile::mojom::blink::PictureInPictureVideoSurface {
  DEFINE_WRAPPERTYPEINFO();

 public:
  explicit HTMLAppElement(Document&);
  ~HTMLAppElement() override;

  // Which element this is, for `DynamicTo` and `IsA`. NOT boilerplate, and
  // nothing in a build says so if it is missing: `DowncastTraits<HTMLAppElement>`
  // is generated as a comparison against this value, and HTMLElement's base
  // answers `kHTMLElement` for anything that does not override it. So an
  // element without this parses, lays out and reflects its attributes exactly
  // as it should, and every cast back to its own class returns null. See
  // node.h -- "every HTMLElement must override this" -- and
  // scripts/test-fork-elements-know-their-type.sh, which is what now says so.
  ElementType GetElementType() const final {
    return ElementType::kHTMLAppElement;
  }

  // The layer the surface is embedded in, or null before one exists. The
  // layout object records it as a foreign layer; nothing else should hold it.
  cc::Layer* ContentsCcLayer() const;

  // Called by LayoutAppSurface once layout has a box, and again whenever that
  // box changes size. The box is what the producer is told to render at: for an
  // <app> the layout box *is* the xdg_toplevel.configure.
  void SurfaceBoxChanged(const gfx::Size& size);

  // The control channel named synced frame `frame` for window `app_id`. Each
  // <app> for it in `document` that sets no `frame` shows the newest one
  // heard, so a page that ignores frames never shows a stale one. See
  // domicile::KnownFrames.
  static void FrameHeard(Document& document,
                         const String& app_id,
                         uint32_t frame);
  // Window `app_id` closed.
  static void FramesForgotten(const String& app_id);

  // The pointer, the wheel and the secondary button's menu over this element
  // are its client's: see the .cc. Every other event is an HTMLElement's.
  void DefaultEventHandler(Event&) override;

  // domicile::mojom::blink::PictureInPictureVideoSurface:
  void SurfaceChanged(const viz::SurfaceId& surface_id) override;

  // WebSurfaceLayerBridgeObserver:
  void OnWebLayerUpdated() override;
  void RegisterContentsLayer(cc::Layer*) override;
  void UnregisterContentsLayer(cc::Layer*) override;

  void Trace(Visitor*) const override;

 private:
  LayoutObject* CreateLayoutObject(const ComputedStyle&) override;
  void ParseAttribute(const AttributeModificationParams&) override;
  InsertionNotificationRequest InsertedInto(ContainerNode&) override;
  void RemovedFrom(ContainerNode&) override;

  // Ask the browser for the SurfaceId of `app-id`'s window and embed it.
  // A no-op without a frame, without an app-id, or before layout has given the
  // element a box -- each of which is a state the element passes through on the
  // way to its first frame rather than an error.
  void Embed();
  void OnEmbedded(const AtomicString& app_id,
                  const std::optional<viz::SurfaceId>&);
  // The producer of the surface shown disconnected.
  void OnSurfaceLost();

  // Ask the browser for the surface of the video `picture-in-picture` names,
  // and embed each it sends. A no-op without a frame or without the
  // attribute.
  void ShowPictureInPicture();

  bool CreateLayer();

  // `allocated` at the synced frame this element shows: the `frame`
  // attribute, or the newest heard when it has none.
  viz::LocalSurfaceId AtFrame(const viz::LocalSurfaceId& allocated) const;

  // Embed the frame AtFrame() names now, holding the page's frame for it.
  void ShowFrame();

  // Send `event` to the client `app_id` names, through `client`.
  void ForwardInput(AppInputClient& client,
                    const String& app_id,
                    const Event& event);
  // A finger, which is the window's as a touch, not a pointer.
  void ForwardTouch(AppInputClient&, const String&, const PointerEvent&);
  // Ends every point still down on the window, as a cancel.
  void CancelTouches();
  // The points down on this element, and the window they went to.
  Vector<int32_t> touches_;
  String touch_app_id_;

  void ForwardPinch(AppInputClient&, const String&, const WheelEvent&);
  void CancelPinch();
  std::optional<ui::NativePinch> active_pinch_;
  String pinch_app_id_;

  void ForwardMotion(AppInputClient& client,
                     const String& app_id,
                     const MouseEvent& event);
  // Where `event` is over this element's content box -- the box the surface is
  // drawn in -- in the element's own CSS pixels, and that box's size in the
  // same pixels. False where there is no box to map through.
  bool MapToContent(const MouseEvent& event,
                    gfx::PointF& point,
                    gfx::SizeF& size);

  // The LocalSurfaceId the embedder last allocated, before `frame` applies.
  // Invalid before the first embed.
  viz::LocalSurfaceId allocated_;

  // The size last sent to the producer. Kept so that a layout that did not
  // change the box does not reconfigure the client, which would make every
  // relayout of the page a resize of every window on it.
  gfx::Size configured_size_;

  // Whether an Embed() has been asked for and not yet answered. The browser
  // holds the reply until a producer connects for this app id, which may be
  // never, so a second ask would queue behind the first rather than replace it.
  bool embed_in_flight_ = false;

  // Set when app-id or the box changed while a reply was outstanding: the
  // answer in flight is for the wrong app or the wrong size, so re-ask once it
  // lands.
  bool embed_stale_ = false;

  // The app-id whose surface the layer shows, or null before one does. A
  // resize of that app embeds its new surface without waiting for the reply.
  AtomicString embedded_app_id_;

  // Whether the last resize embedded without waiting for the client, because
  // `resizing` was set. Removing `resizing` then embeds the box once more,
  // waiting.
  bool embedded_without_waiting_ = false;

  std::unique_ptr<::blink::SurfaceLayerBridge> surface_layer_bridge_;
  std::unique_ptr<ExternalSurfaceEmbedder> external_surface_embedder_;

  // A picture-in-picture video's: the browser's list of them, and the
  // surface of the one shown. Unbound for a window's <app>.
  HeapMojoRemote<domicile::mojom::blink::PictureInPictureVideos>
      picture_in_picture_;
  HeapMojoReceiver<domicile::mojom::blink::PictureInPictureVideoSurface,
                   HTMLAppElement>
      picture_in_picture_surface_;
};

}  // namespace blink

#endif  // THIRD_PARTY_BLINK_RENDERER_CORE_HTML_DOMICILE_HTML_APP_ELEMENT_H_
