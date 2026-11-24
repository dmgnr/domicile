// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef COMPONENTS_DOMICILE_BROWSER_FRAME_SINK_BROKER_H_
#define COMPONENTS_DOMICILE_BROWSER_FRAME_SINK_BROKER_H_

#include <array>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "base/containers/flat_map.h"
#include "base/containers/flat_set.h"
#include "base/functional/callback.h"
#include "base/functional/callback_helpers.h"
#include "base/memory/raw_ptr.h"
#include "base/unguessable_token.h"
#include "components/domicile/browser/brokered_frame_sink.h"
#include "components/domicile/browser/browser_window_capture_target.h"
#include "components/domicile/browser/browser_window_listing.h"
#include "components/domicile/browser/display_capture.h"
#include "components/domicile/mojom/external_surface.mojom.h"
#include "components/domicile/mojom/frame_sink_broker.mojom.h"
#include "components/viz/common/surfaces/frame_sink_id.h"
#include "components/viz/common/surfaces/local_surface_id.h"
#include "gpu/command_buffer/common/sync_token.h"
#include "mojo/public/cpp/bindings/pending_receiver.h"
#include "mojo/public/cpp/bindings/pending_remote.h"
#include "mojo/public/cpp/bindings/receiver_set.h"
#include "mojo/public/cpp/bindings/remote_set.h"
#include "ui/gfx/color_space.h"
#include "ui/gfx/geometry/size.h"
#include "ui/gfx/gpu_fence_handle.h"

namespace viz {
class HostFrameSinkManager;
}

namespace domicile {

// The windows of `listing` a capture tool lists, as a producer hears them:
// every window not hidden, titled by its app when the app gave a title, with
// the views it holds and shows with an area, bottom first. A view is never
// listed as a window of its own.
std::vector<mojom::ListedBrowserWindowPtr> ForCaptureTools(
    const std::vector<ListedBrowserWindow>& listing);

// Brokers viz frame sinks to a non-renderer producer (the compositor) and
// connects each one to the page that embeds it.
//
// The renderer equivalent, content::EmbeddedFrameSinkProviderImpl, validates
// that a FrameSinkId is in the caller's namespace. A producer outside the
// process tree has no namespace, so this allocates ids itself with
// `allocate_frame_sink_id`. That must be the browser's own allocator, or ids
// collide.
//
// Pages do not get this interface: it can allocate any frame sink. They use
// mojom::ExternalSurfaceProvider instead.
class FrameSinkBroker : public mojom::FrameSinkBroker {
 public:
  using FrameSinkIdAllocator = base::RepeatingCallback<viz::FrameSinkId()>;
  using SharedImageInterfaceGetter =
      BrokeredFrameSink::SharedImageInterfaceGetter;
  using EmbedCallback =
      base::OnceCallback<void(const std::optional<viz::FrameSinkId>&)>;
  // Applies the producer's display layout to the connectors. Injected because
  // this target does not depend on //ui/ozone or //content. Empty when the
  // embedder has no CRTC (anything but a tty); the layout is then dropped.
  using DisplayLayoutSetter =
      base::RepeatingCallback<void(std::vector<mojom::DisplayLayoutPtr>)>;
  // Binds the producer's tablets and touchscreens to displays. Injected for
  // the same reason. Empty when the embedder has no CRTC; the targets are then
  // dropped.
  using PointerTargetsSetter =
      base::RepeatingCallback<void(std::vector<mojom::PointerTargetPtr>)>;
  // Sets the producer's virtual displays. Injected for the same reason. Empty
  // when the embedder has no CRTC; the displays are then dropped.
  using VirtualDisplaysSetter =
      base::RepeatingCallback<void(std::vector<mojom::VirtualDisplayPtr>)>;
  // Sets one display's gamma ramp. Injected for the same reason. Empty when
  // the embedder has no CRTC; the ramp is then dropped.
  using GammaSetter =
      base::RepeatingCallback<void(int64_t, const mojom::GammaRamp&)>;
  // Delivers emulated input to the desk. Injected for the same reason. Empty
  // when the engine reads no input of its own; the input is then dropped.
  using InputInjector = base::RepeatingCallback<void(const mojom::DeskInput&)>;
  using InputConfigSetter = base::RepeatingCallback<void(const std::string&)>;
  // Redraws the browser window showing a display, after its gamma ramp is
  // set. A lit CRTC takes a ramp with its next page flip, so a screen that
  // is not redrawing would show it only when something next changed.
  // Injected for the same reason. Empty when the embedder has no CRTC.
  using DisplayRedrawer = base::RepeatingCallback<void(int64_t)>;
  // Sets the color matrix viz draws one display with, 3x3 and row-major, and
  // redraws it. Injected because finding a display's window needs //ui/aura.
  // Empty when the embedder has no windows; the matrix is then dropped.
  using ColorMatrix = std::array<float, 9>;
  using ColorMatrixSetter =
      base::RepeatingCallback<void(int64_t, const ColorMatrix&)>;
  // Writes the producer's clipboard into `ui::OzonePlatform`'s clipboard.
  // Injected for the same reason. Empty when the embedder runs inside another
  // session; the contents are then dropped.
  using ClipboardContents = base::flat_map<std::string, std::vector<uint8_t>>;
  using ClipboardSetter =
      base::RepeatingCallback<void(mojom::Clipboard,
                                   const ClipboardContents&)>;
  // The root frame sink of the browser window showing a display, or nullopt
  // when none does. Injected because finding windows needs //ui/aura. Empty
  // when the embedder has no windows to capture; every capture is then
  // refused.
  using DisplayCaptureTargetGetter =
      base::RepeatingCallback<std::optional<viz::FrameSinkId>(int64_t)>;
  // Browser window `window_id`'s page, for a capture of it alone. Injected
  // because the windows are //chrome's. Empty when the embedder has no
  // browser windows; every such capture is then refused.
  using BrowserWindowCaptureTargetGetter = BrowserWindowCaptureTargetFinder;
  // Whether the GPU can make the dmabufs viz captures into. Injected because
  // asking needs //ui/ozone. Empty, or false, when it cannot, as nested in a
  // Wayland session that offers no render node: captures then come in shared
  // memory.
  using DmabufCaptureChecker = base::RepeatingCallback<bool()>;
  // Runs the closure once the browser's GPU channel passes the sync token.
  // Injected because the channel's context comes from //ui/aura. An import
  // answers only once its SharedImage exists: the producer's frame reaches
  // viz on another pipe than the one that made it, and viz drew a frame
  // naming an image the GPU had not made yet, which left the window blank.
  // Required whenever `get_shared_image_interface` returns an interface.
  using SyncTokenSignaler =
      base::RepeatingCallback<void(const gpu::SyncToken&, base::OnceClosure)>;

  // `get_shared_image_interface` gives imported dmabufs a GPU. Injected because
  // this target does not depend on //ui/aura. It returns null when headless.
  //
  // `get_software_shared_image_interface` makes windows in shared memory into
  // software images. It returns null while the browser composites on the GPU,
  // where viz draws none.
  FrameSinkBroker(
      viz::HostFrameSinkManager* host_frame_sink_manager,
      FrameSinkIdAllocator allocate_frame_sink_id,
      SharedImageInterfaceGetter get_shared_image_interface =
          SharedImageInterfaceGetter(),
      DisplayLayoutSetter set_display_layout = DisplayLayoutSetter(),
      ClipboardSetter set_clipboard = ClipboardSetter(),
      DisplayCaptureTargetGetter get_display_capture_target =
          DisplayCaptureTargetGetter(),
      BrowserWindowCaptureTargetGetter get_browser_window_capture_target =
          BrowserWindowCaptureTargetGetter(),
      PointerTargetsSetter set_pointer_targets = PointerTargetsSetter(),
      SharedImageInterfaceGetter get_software_shared_image_interface =
          SharedImageInterfaceGetter(),
      VirtualDisplaysSetter set_virtual_displays = VirtualDisplaysSetter(),
      GammaSetter set_gamma = GammaSetter(),
      InputInjector inject_input = InputInjector(),
      InputConfigSetter set_input_config = InputConfigSetter(),
      DisplayRedrawer redraw_display = DisplayRedrawer(),
      ColorMatrixSetter set_color_matrix = ColorMatrixSetter(),
      DmabufCaptureChecker can_capture_into_dmabufs = DmabufCaptureChecker(),
      SyncTokenSignaler signal_sync_token = SyncTokenSignaler());

  FrameSinkBroker(const FrameSinkBroker&) = delete;
  FrameSinkBroker& operator=(const FrameSinkBroker&) = delete;

  ~FrameSinkBroker() override;

  void Bind(mojo::PendingReceiver<mojom::FrameSinkBroker> receiver);

  // Run each time a producer disconnects, once its sinks are gone. The
  // embedder listens for the next producer from it: a compositor restarted
  // under this browser connects again. See "A compositor restart" in
  // docs/architecture/ENGINE-FORK.md.
  void SetProducerGoneCallback(base::RepeatingClosure callback);

  // A new id for a page that sends Embed, so its waiting embeds can be dropped
  // with DropEmbeds. Never reused.
  uint64_t NewEmbedRequester();

  // Embeds the surface for `app_id` under `parent_frame_sink_id`. Registers
  // the hierarchy, tells the producer its LocalSurfaceId, and runs `callback`
  // with the FrameSinkId.
  //
  // As with RemoteFrame, the browser owns the FrameSinkId and the page owns
  // the LocalSurfaceId, whose embed_token the producer needs.
  //
  // `app_id` matches the one the producer passed to CreateFrameSink. If that
  // app has no sink yet, `callback` waits until it does: an <app> element can
  // exist before its client window.
  //
  // Runs `callback` with nullopt at once if the embed token was used on a sink
  // whose producer disconnected: viz would refuse it on the new sink.
  //
  // `requester` is the page's id from NewEmbedRequester.
  void Embed(uint64_t requester,
             const std::string& app_id,
             const viz::FrameSinkId& parent_frame_sink_id,
             const viz::LocalSurfaceId& local_surface_id,
             const gfx::Size& size,
             double scale,
             double zoom,
             EmbedCallback callback);

  // Drops `requester`'s waiting embeds without running their callbacks. For a
  // page that disconnected: its app may never connect, and an answer would
  // embed the window under a page that is gone.
  void DropEmbeds(uint64_t requester);

  // Runs `callback` once `frame_sink_id` is no longer brokered, with why. Runs
  // it at once if it is not brokered.
  //
  // A restarted compositor reuses app ids, and viz refuses one embed token on
  // two frame sinks. On kProducerGone the page drops its token for the sink.
  using EndCallback = base::OnceCallback<void(mojom::FrameSinkEnd)>;
  void WaitForEnd(const viz::FrameSinkId& frame_sink_id, EndCallback callback);

  // Forwards the browser's displays to observers and stores them for
  // observers that connect later.
  //
  // Ignores an empty list, which means the screen has not been read yet
  // (DrmScreen never reports zero displays). Advertising no displays would
  // leave windows nowhere to go.
  void OnDisplaysChanged(std::vector<mojom::DisplayPtr> displays);

  // Forwards a copy in this browser to clipboard observers. Not stored: a
  // producer that connects later owns its own clipboard state.
  void OnCopied(mojom::Clipboard clipboard, const ClipboardContents& contents);

  // Forwards how the browser composites to observers, when it changes, and
  // stores it for observers that connect later. `in_memory` is true while
  // the browser composites in software.
  void OnCompositingChanged(bool in_memory);

  // Forwards the browser windows a capture tool lists to observers, and
  // stores them for observers that connect later.
  void OnBrowserWindowsChanged(
      std::vector<mojom::ListedBrowserWindowPtr> windows);

  // Forwards the input devices the browser reads to observers, and stores
  // them for observers that connect later.
  void OnInputDevicesChanged(std::vector<mojom::ListedInputDevicePtr> devices);

  // mojom::FrameSinkBroker implementation.
  void CreateFrameSink(
      mojo::PendingRemote<viz::mojom::CompositorFrameSinkClient> client,
      mojo::PendingReceiver<viz::mojom::CompositorFrameSink> receiver,
      mojo::PendingRemote<mojom::SurfaceObserver> observer,
      const std::string& app_id,
      CreateFrameSinkCallback callback) override;
  void DestroyFrameSink(const viz::FrameSinkId& frame_sink_id) override;
  void EmbedFrameSink(const viz::FrameSinkId& child,
                      const viz::FrameSinkId& parent,
                      const viz::LocalSurfaceId& local_surface_id,
                      const gfx::Size& size,
                      double scale) override;
  void ImportBuffer(const viz::FrameSinkId& frame_sink_id,
                    gfx::GpuMemoryBufferHandle handle,
                    const gfx::Size& size,
                    uint32_t fourcc,
                    const gfx::ColorSpace& color_space,
                    ImportBufferCallback callback) override;
  void SubmitBuffer(const viz::FrameSinkId& frame_sink_id,
                    uint64_t buffer_id,
                    const gfx::Rect& damage) override;
  void FenceBuffer(const viz::FrameSinkId& frame_sink_id,
                   uint64_t buffer_id,
                   gfx::GpuFenceHandle fence,
                   FenceBufferCallback callback) override;
  void DestroyBuffer(const viz::FrameSinkId& frame_sink_id,
                     uint64_t buffer_id,
                     const gpu::SyncToken& read_done) override;
  void ConfigureDisplays(
      std::vector<mojom::DisplayLayoutPtr> layout) override;
  void ConfigurePointers(
      std::vector<mojom::PointerTargetPtr> targets) override;
  void ConfigureInput(const std::string& config) override;
  void ConfigureVirtualDisplays(
      std::vector<mojom::VirtualDisplayPtr> displays) override;
  void SetGamma(int64_t display_id, mojom::GammaRampPtr ramp) override;
  void SetColorMatrix(int64_t display_id,
                      const std::vector<float>& matrix) override;
  void InjectInput(mojom::DeskInputPtr input) override;
  void SetClipboard(mojom::Clipboard clipboard,
                    const ClipboardContents& contents) override;
  void ObserveClipboard(
      mojo::PendingRemote<mojom::ClipboardObserver> observer) override;
  void ObserveDisplays(
      mojo::PendingRemote<mojom::DisplayListObserver> observer) override;
  void ObserveCompositing(
      mojo::PendingRemote<mojom::CompositingObserver> observer) override;
  void ObserveBrowserWindows(
      mojo::PendingRemote<mojom::BrowserWindowListObserver> observer) override;
  void ObserveInputDevices(
      mojo::PendingRemote<mojom::InputDeviceListObserver> observer) override;
  void CaptureDisplay(
      int64_t display_id,
      const gfx::Size& size,
      uint32_t max_fps,
      mojo::PendingReceiver<mojom::DisplayCapture> capture,
      mojo::PendingRemote<mojom::DisplayCaptureObserver> observer,
      CaptureDisplayCallback callback) override;
  void CaptureBrowserWindow(
      const std::string& window_id,
      uint32_t max_fps,
      mojo::PendingReceiver<mojom::DisplayCapture> capture,
      mojo::PendingRemote<mojom::DisplayCaptureObserver> observer,
      CaptureBrowserWindowCallback callback) override;

 private:
  // A page's embed request waiting for its producer.
  struct PendingEmbed {
    PendingEmbed(uint64_t requester,
                 const std::string& app_id,
                 const viz::FrameSinkId& parent_frame_sink_id,
                 const viz::LocalSurfaceId& local_surface_id,
                 const gfx::Size& size,
                 double scale,
                 double zoom,
                 EmbedCallback callback);
    PendingEmbed(PendingEmbed&&);
    PendingEmbed& operator=(PendingEmbed&&);
    ~PendingEmbed();

    uint64_t requester;
    std::string app_id;
    viz::FrameSinkId parent_frame_sink_id;
    viz::LocalSurfaceId local_surface_id;
    gfx::Size size;
    double scale;
    double zoom;
    EmbedCallback callback;
  };

  // The sink for `app_id`, or null if that app has no producer yet.
  //
  // A linear scan: there are few windows, and a second map would need updating
  // on disconnect.
  BrokeredFrameSink* SinkForApp(const std::string& app_id);

  // Destroys and unregisters every sink of the disconnected producer.
  void OnProducerDisconnected();

  // Destroys the sink `iter` names and runs its WaitForEnd callbacks with
  // `end`.
  void EraseFrameSink(
      base::flat_map<viz::FrameSinkId,
                     std::unique_ptr<BrokeredFrameSink>>::iterator iter,
      mojom::FrameSinkEnd end);

  // The sink `frame_sink_id` names, if this producer owns one.
  BrokeredFrameSink* OwnedFrameSink(const viz::FrameSinkId& frame_sink_id);

  const raw_ptr<viz::HostFrameSinkManager> host_frame_sink_manager_;
  const FrameSinkIdAllocator allocate_frame_sink_id_;
  const SharedImageInterfaceGetter get_shared_image_interface_;
  const SharedImageInterfaceGetter get_software_shared_image_interface_;
  // See DisplayLayoutSetter.
  const DisplayLayoutSetter set_display_layout_;
  // See ClipboardSetter.
  const ClipboardSetter set_clipboard_;
  // See DisplayCaptureTargetGetter.
  const DisplayCaptureTargetGetter get_display_capture_target_;
  // See BrowserWindowCaptureTargetGetter.
  const BrowserWindowCaptureTargetGetter get_browser_window_capture_target_;
  // See PointerTargetsSetter.
  const PointerTargetsSetter set_pointer_targets_;
  // See VirtualDisplaysSetter.
  const VirtualDisplaysSetter set_virtual_displays_;
  // See GammaSetter.
  const GammaSetter set_gamma_;
  // See InputInjector.
  const InputInjector inject_input_;
  const InputConfigSetter set_input_config_;
  // See DisplayRedrawer.
  const DisplayRedrawer redraw_display_;
  // See ColorMatrixSetter.
  const ColorMatrixSetter set_color_matrix_;
  // See DmabufCaptureChecker.
  const DmabufCaptureChecker can_capture_into_dmabufs_;
  // See SyncTokenSignaler.
  const SyncTokenSignaler signal_sync_token_;

  mojo::ReceiverSet<mojom::FrameSinkBroker> receivers_;
  base::RepeatingClosure producer_gone_;

  base::flat_map<viz::FrameSinkId, std::unique_ptr<BrokeredFrameSink>>
      frame_sink_map_;

  std::vector<PendingEmbed> pending_embeds_;
  uint64_t next_embed_requester_ = 1;

  // WaitForEnd callbacks, by the brokered sink they wait on.
  base::flat_map<viz::FrameSinkId, std::vector<EndCallback>> end_waiters_;

  // Every embed token each brokered sink was embedded with.
  base::flat_map<viz::FrameSinkId, base::flat_set<base::UnguessableToken>>
      embed_tokens_;

  // Sinks whose producer disconnected, and the embed tokens used on them. Kept
  // for the browser's lifetime: they grow only by the windows open at each
  // compositor restart. See WaitForEnd and Embed.
  base::flat_set<viz::FrameSinkId> disconnected_frame_sinks_;
  base::flat_set<base::UnguessableToken> disconnected_embed_tokens_;

  mojo::RemoteSet<mojom::DisplayListObserver> display_observers_;

  mojo::RemoteSet<mojom::ClipboardObserver> clipboard_observers_;

  // Runs a capture of `target` at `size` until its producer closes it, and
  // holds `held` as long.
  void StartCapture(
      const viz::FrameSinkId& target,
      const gfx::Size& size,
      uint32_t max_fps,
      mojo::PendingReceiver<mojom::DisplayCapture> capture,
      mojo::PendingRemote<mojom::DisplayCaptureObserver> observer,
      base::ScopedClosureRunner held = base::ScopedClosureRunner());

  // Running captures, each until its producer closes it.
  base::flat_map<uint64_t, std::unique_ptr<DisplayCapture>> captures_;
  uint64_t next_capture_ = 1;

  // The last display list, or empty if none yet. See OnDisplaysChanged.
  std::vector<mojom::DisplayPtr> displays_;

  mojo::RemoteSet<mojom::CompositingObserver> compositing_observers_;
  // Whether the browser composites in memory, or nullopt until the embedder
  // says. See OnCompositingChanged.
  std::optional<bool> in_memory_;

  mojo::RemoteSet<mojom::BrowserWindowListObserver> browser_window_observers_;
  // The last browser window list. See OnBrowserWindowsChanged.
  std::vector<mojom::ListedBrowserWindowPtr> browser_windows_;

  mojo::RemoteSet<mojom::InputDeviceListObserver> input_device_observers_;
  // The last input device list. See OnInputDevicesChanged.
  std::vector<mojom::ListedInputDevicePtr> input_devices_;
};

}  // namespace domicile

#endif  // COMPONENTS_DOMICILE_BROWSER_FRAME_SINK_BROKER_H_
