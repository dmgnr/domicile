// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/browser/frame_sink_broker.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <utility>
#include <vector>

#include "base/containers/flat_map.h"
#include "base/containers/flat_set.h"
#include "base/functional/bind.h"
#include "base/functional/callback_helpers.h"
#include "base/logging.h"
#include "components/domicile/browser/brokered_frame_sink.h"
#include "mojo/public/cpp/bindings/callback_helpers.h"
#include "mojo/public/cpp/bindings/clone_traits.h"
#include "gpu/command_buffer/client/client_shared_image.h"
#include "gpu/command_buffer/client/shared_image_interface.h"
#include "components/viz/host/host_frame_sink_manager.h"

namespace domicile {

std::vector<mojom::ListedBrowserWindowPtr> ForCaptureTools(
    const std::vector<ListedBrowserWindow>& listing) {
  std::vector<mojom::ListedBrowserWindowPtr> windows;
  for (const ListedBrowserWindow& window : listing) {
    if (window.view || window.hidden) {
      continue;
    }
    std::vector<const ListedBrowserWindow*> held;
    for (const ListedBrowserWindow& view : listing) {
      // A view placed with no area draws nothing, and can't be captured.
      if (view.view && view.parent == window.id && view.width > 0 &&
          view.height > 0) {
        held.push_back(&view);
      }
    }
    std::ranges::stable_sort(held, {}, &ListedBrowserWindow::stack);
    std::vector<mojom::ListedBrowserViewPtr> views;
    for (const ListedBrowserWindow* view : held) {
      views.push_back(mojom::ListedBrowserView::New(
          view->id, view->x, view->y, view->width, view->height));
    }
    windows.push_back(mojom::ListedBrowserWindow::New(
        window.id, window.app_title.empty() ? window.title : window.app_title,
        window.app_id, window.url, window.off_the_record, std::move(views)));
  }
  return windows;
}

FrameSinkBroker::PendingEmbed::PendingEmbed(
    uint64_t requester,
    const std::string& app_id,
    const viz::FrameSinkId& parent_frame_sink_id,
    const viz::LocalSurfaceId& local_surface_id,
    const gfx::Size& size,
    double scale,
    double zoom,
    EmbedCallback callback)
    : requester(requester),
      app_id(app_id),
      parent_frame_sink_id(parent_frame_sink_id),
      local_surface_id(local_surface_id),
      size(size),
      scale(scale),
      zoom(zoom),
      callback(std::move(callback)) {}

FrameSinkBroker::PendingEmbed::PendingEmbed(PendingEmbed&&) = default;

FrameSinkBroker::PendingEmbed& FrameSinkBroker::PendingEmbed::operator=(
    PendingEmbed&&) = default;

FrameSinkBroker::PendingEmbed::~PendingEmbed() = default;

FrameSinkBroker::FrameSinkBroker(
    viz::HostFrameSinkManager* host_frame_sink_manager,
    FrameSinkIdAllocator allocate_frame_sink_id,
    SharedImageInterfaceGetter get_shared_image_interface,
    DisplayLayoutSetter set_display_layout,
    ClipboardSetter set_clipboard,
    DisplayCaptureTargetGetter get_display_capture_target,
    BrowserWindowCaptureTargetGetter get_browser_window_capture_target,
    PointerTargetsSetter set_pointer_targets,
    SharedImageInterfaceGetter get_software_shared_image_interface,
    VirtualDisplaysSetter set_virtual_displays,
    GammaSetter set_gamma,
    InputInjector inject_input,
    InputConfigSetter set_input_config,
    DisplayRedrawer redraw_display,
    ColorMatrixSetter set_color_matrix,
    DmabufCaptureChecker can_capture_into_dmabufs,
    SyncTokenSignaler signal_sync_token)
    : host_frame_sink_manager_(host_frame_sink_manager),
      allocate_frame_sink_id_(std::move(allocate_frame_sink_id)),
      get_shared_image_interface_(std::move(get_shared_image_interface)),
      get_software_shared_image_interface_(
          std::move(get_software_shared_image_interface)),
      set_display_layout_(std::move(set_display_layout)),
      set_clipboard_(std::move(set_clipboard)),
      get_display_capture_target_(std::move(get_display_capture_target)),
      get_browser_window_capture_target_(
          std::move(get_browser_window_capture_target)),
      set_pointer_targets_(std::move(set_pointer_targets)),
      set_virtual_displays_(std::move(set_virtual_displays)),
      set_gamma_(std::move(set_gamma)),
      inject_input_(std::move(inject_input)),
      set_input_config_(std::move(set_input_config)),
      redraw_display_(std::move(redraw_display)),
      set_color_matrix_(std::move(set_color_matrix)),
      can_capture_into_dmabufs_(std::move(can_capture_into_dmabufs)),
      signal_sync_token_(std::move(signal_sync_token)) {
  CHECK(host_frame_sink_manager);
  CHECK(allocate_frame_sink_id_);
  receivers_.set_disconnect_handler(base::BindRepeating(
      &FrameSinkBroker::OnProducerDisconnected, base::Unretained(this)));
}

FrameSinkBroker::~FrameSinkBroker() = default;

void FrameSinkBroker::Bind(
    mojo::PendingReceiver<mojom::FrameSinkBroker> receiver) {
  receivers_.Add(this, std::move(receiver));
}

void FrameSinkBroker::SetProducerGoneCallback(base::RepeatingClosure callback) {
  producer_gone_ = std::move(callback);
}

uint64_t FrameSinkBroker::NewEmbedRequester() {
  return next_embed_requester_++;
}

void FrameSinkBroker::Embed(uint64_t requester,
                            const std::string& app_id,
                            const viz::FrameSinkId& parent_frame_sink_id,
                            const viz::LocalSurfaceId& local_surface_id,
                            const gfx::Size& size,
                            double scale,
                            double zoom,
                            EmbedCallback callback) {
  // Sent before the page heard its compositor went away.
  if (disconnected_embed_tokens_.contains(local_surface_id.embed_token())) {
    VLOG(1) << "domicile: an embed of app " << app_id
            << " arrived after its producer went; refused";
    std::move(callback).Run(std::nullopt);
    return;
  }
  BrokeredFrameSink* frame_sink = SinkForApp(app_id);
  if (!frame_sink) {
    // The <app> element can exist before its client connects, as on a shell
    // reload. Wait for this app's sink, not whichever is brokered next.
    VLOG(1) << "domicile: an embed of app " << app_id << " in "
            << parent_frame_sink_id.ToString() << " at " << size.ToString()
            << " waits for its window";
    pending_embeds_.emplace_back(requester, app_id, parent_frame_sink_id,
                                 local_surface_id, size, scale, zoom,
                                 std::move(callback));
    return;
  }

  VLOG(1) << "domicile: app " << app_id << " ("
          << frame_sink->frame_sink_id().ToString() << ") embedded in "
          << parent_frame_sink_id.ToString() << " at " << size.ToString()
          << ", scale " << scale << ", zoom " << zoom << ", "
          << local_surface_id.ToString();
  frame_sink->Embed(parent_frame_sink_id, local_surface_id, size, scale, zoom);
  embed_tokens_[frame_sink->frame_sink_id()].insert(
      local_surface_id.embed_token());
  std::move(callback).Run(frame_sink->frame_sink_id());
}

void FrameSinkBroker::DropEmbeds(uint64_t requester) {
  std::erase_if(pending_embeds_, [requester](const PendingEmbed& embed) {
    return embed.requester == requester;
  });
}

void FrameSinkBroker::CreateFrameSink(
    mojo::PendingRemote<viz::mojom::CompositorFrameSinkClient> client,
    mojo::PendingReceiver<viz::mojom::CompositorFrameSink> receiver,
    mojo::PendingRemote<mojom::SurfaceObserver> observer,
    const std::string& app_id,
    CreateFrameSinkCallback callback) {
  const viz::FrameSinkId frame_sink_id = allocate_frame_sink_id_.Run();
  VLOG(1) << "domicile: a frame sink for app " << app_id << ": "
          << frame_sink_id.ToString();

  const auto none = base::BindRepeating(
      []() -> gpu::SharedImageInterface* { return nullptr; });
  auto frame_sink = std::make_unique<BrokeredFrameSink>(
      host_frame_sink_manager_, frame_sink_id, std::move(observer),
      receivers_.current_receiver(), app_id,
      get_shared_image_interface_ ? get_shared_image_interface_ : none,
      get_software_shared_image_interface_
          ? get_software_shared_image_interface_
          : none);
  frame_sink->CreateCompositorFrameSink(std::move(client), std::move(receiver));
  BrokeredFrameSink* raw_frame_sink = frame_sink.get();
  frame_sink_map_[frame_sink_id] = std::move(frame_sink);

  std::move(callback).Run(frame_sink_id);

  // Answer embeds that were waiting for this app. Embeds for other apps keep
  // waiting.
  std::vector<PendingEmbed> still_waiting;
  for (PendingEmbed& embed : pending_embeds_) {
    if (embed.app_id != app_id) {
      still_waiting.push_back(std::move(embed));
      continue;
    }
    VLOG(1) << "domicile: app " << app_id << " (" << frame_sink_id.ToString()
            << ") embedded where it waited, in "
            << embed.parent_frame_sink_id.ToString() << " at "
            << embed.size.ToString();
    raw_frame_sink->Embed(embed.parent_frame_sink_id, embed.local_surface_id,
                          embed.size, embed.scale, embed.zoom);
    embed_tokens_[frame_sink_id].insert(embed.local_surface_id.embed_token());
    std::move(embed.callback).Run(frame_sink_id);
  }
  pending_embeds_ = std::move(still_waiting);
}

void FrameSinkBroker::DestroyFrameSink(const viz::FrameSinkId& frame_sink_id) {
  auto iter = frame_sink_map_.find(frame_sink_id);
  if (iter == frame_sink_map_.end()) {
    receivers_.ReportBadMessage("No brokered frame sink for FrameSinkId");
    return;
  }
  if (iter->second->owner() != receivers_.current_receiver()) {
    receivers_.ReportBadMessage("FrameSinkId belongs to another producer");
    return;
  }
  EraseFrameSink(iter, mojom::FrameSinkEnd::kClosed);
}

void FrameSinkBroker::EmbedFrameSink(const viz::FrameSinkId& child,
                                     const viz::FrameSinkId& parent,
                                     const viz::LocalSurfaceId& local_surface_id,
                                     const gfx::Size& size,
                                     double scale) {
  BrokeredFrameSink* embedded = OwnedFrameSink(child);
  if (!embedded || !OwnedFrameSink(parent)) {
    return;
  }
  VLOG(1) << "domicile: subsurface " << child.ToString() << " embedded in "
          << parent.ToString() << " at " << size.ToString() << ", scale "
          << scale;
  // `scale` already carries the parent window's zoom (its client's logical
  // units in device pixels), so the subsurface is embedded unzoomed.
  embedded->Embed(parent, local_surface_id, size, scale, /*zoom=*/1.0);
}

void FrameSinkBroker::WaitForEnd(const viz::FrameSinkId& frame_sink_id,
                                 EndCallback callback) {
  if (!frame_sink_map_.contains(frame_sink_id)) {
    std::move(callback).Run(disconnected_frame_sinks_.contains(frame_sink_id)
                                ? mojom::FrameSinkEnd::kProducerGone
                                : mojom::FrameSinkEnd::kClosed);
    return;
  }
  end_waiters_[frame_sink_id].push_back(std::move(callback));
}

// A producer may only use its own sinks, because a FrameSinkId is guessable.
BrokeredFrameSink* FrameSinkBroker::OwnedFrameSink(
    const viz::FrameSinkId& frame_sink_id) {
  auto iter = frame_sink_map_.find(frame_sink_id);
  if (iter == frame_sink_map_.end()) {
    receivers_.ReportBadMessage("No brokered frame sink for FrameSinkId");
    return nullptr;
  }
  if (iter->second->owner() != receivers_.current_receiver()) {
    receivers_.ReportBadMessage("FrameSinkId belongs to another producer");
    return nullptr;
  }
  return iter->second.get();
}

void FrameSinkBroker::ImportBuffer(const viz::FrameSinkId& frame_sink_id,
                                   gfx::GpuMemoryBufferHandle handle,
                                   const gfx::Size& size,
                                   uint32_t fourcc,
                                   const gfx::ColorSpace& color_space,
                                   ImportBufferCallback callback) {
  BrokeredFrameSink* frame_sink = OwnedFrameSink(frame_sink_id);
  if (!frame_sink) {
    std::move(callback).Run(0, std::nullopt);
    return;
  }
  std::optional<gpu::ExportedSharedImage> exported;
  const uint64_t buffer_id =
      frame_sink->ImportBuffer(std::move(handle), size, fourcc,
                               color_space, &exported);
  VLOG(3) << "domicile: imported buffer " << buffer_id << " for app "
          << frame_sink->app_id() << " (" << frame_sink_id.ToString()
          << "): " << size.ToString() << ", fourcc " << fourcc << ", "
          << color_space.ToString();
  const std::optional<gpu::SyncToken> created =
      frame_sink->GpuCreationToken(buffer_id);
  if (!created.has_value()) {
    std::move(callback).Run(buffer_id, std::move(exported));
    return;
  }
  CHECK(signal_sync_token_)
      << "domicile: the embedder gave the broker a GPU but no way to wait "
         "for it";
  // A GPU channel lost first drops the closure: the import is then refused,
  // since the image may never have been made.
  signal_sync_token_.Run(
      *created,
      base::BindOnce(
          [](ImportBufferCallback callback, uint64_t buffer_id,
             std::optional<gpu::ExportedSharedImage> exported) {
            std::move(callback).Run(buffer_id, std::move(exported));
          },
          mojo::WrapCallbackWithDefaultInvokeIfNotRun(
              std::move(callback), uint64_t{0},
              std::optional<gpu::ExportedSharedImage>()),
          buffer_id, std::move(exported)));
}

void FrameSinkBroker::SubmitBuffer(const viz::FrameSinkId& frame_sink_id,
                                   uint64_t buffer_id,
                                   const gfx::Rect& damage) {
  BrokeredFrameSink* frame_sink = OwnedFrameSink(frame_sink_id);
  if (frame_sink) {
    VLOG(4) << "domicile: app " << frame_sink->app_id() << " submits buffer "
            << buffer_id << ", damage " << damage.ToString();
    frame_sink->SubmitBuffer(buffer_id, damage);
  }
}

void FrameSinkBroker::FenceBuffer(const viz::FrameSinkId& frame_sink_id,
                                  uint64_t buffer_id,
                                  gfx::GpuFenceHandle fence,
                                  FenceBufferCallback callback) {
  BrokeredFrameSink* frame_sink = OwnedFrameSink(frame_sink_id);
  std::move(callback).Run(
      frame_sink ? frame_sink->FenceBuffer(buffer_id, std::move(fence))
                 : std::nullopt);
}

void FrameSinkBroker::DestroyBuffer(const viz::FrameSinkId& frame_sink_id,
                                    uint64_t buffer_id,
                                    const gpu::SyncToken& read_done) {
  BrokeredFrameSink* frame_sink = OwnedFrameSink(frame_sink_id);
  if (frame_sink) {
    VLOG(3) << "domicile: app " << frame_sink->app_id() << " destroys buffer "
            << buffer_id << " after " << read_done.ToDebugString();
    frame_sink->DestroyBuffer(buffer_id, read_done);
  }
}

void FrameSinkBroker::ConfigureDisplays(
    std::vector<mojom::DisplayLayoutPtr> layout) {
  VLOG(1) << "domicile: the producer lays out " << layout.size() << " displays";
  if (!set_display_layout_) {
    // No CRTC outside a tty. Not an error: the producer cannot know whether a
    // connector backs a display.
    return;
  }
  set_display_layout_.Run(std::move(layout));
}

void FrameSinkBroker::ConfigurePointers(
    std::vector<mojom::PointerTargetPtr> targets) {
  if (!set_pointer_targets_) {
    // No CRTC outside a tty, as for ConfigureDisplays.
    return;
  }
  set_pointer_targets_.Run(std::move(targets));
}

void FrameSinkBroker::ConfigureInput(const std::string& config) {
  if (set_input_config_) {
    set_input_config_.Run(config);
  }
}

void FrameSinkBroker::ConfigureVirtualDisplays(
    std::vector<mojom::VirtualDisplayPtr> displays) {
  VLOG(1) << "domicile: the producer asks for " << displays.size()
          << " virtual displays";
  if (!set_virtual_displays_) {
    // No CRTC outside a tty, so no desk to extend.
    return;
  }
  set_virtual_displays_.Run(std::move(displays));
}

void FrameSinkBroker::SetGamma(int64_t display_id, mojom::GammaRampPtr ramp) {
  if (ramp->red.size() != ramp->green.size() ||
      ramp->red.size() != ramp->blue.size()) {
    receivers_.ReportBadMessage("A gamma ramp's channels differ in length");
    return;
  }
  if (!set_gamma_) {
    // No CRTC outside a tty, as for ConfigureDisplays.
    return;
  }
  set_gamma_.Run(display_id, *ramp);
  // After the ramp, so the frame this asks for is the flip that carries it.
  if (redraw_display_) {
    redraw_display_.Run(display_id);
  }
}

void FrameSinkBroker::SetColorMatrix(int64_t display_id,
                                     const std::vector<float>& matrix) {
  ColorMatrix entries;
  if (matrix.size() != entries.size() ||
      !std::ranges::all_of(matrix, [](float x) { return std::isfinite(x); })) {
    receivers_.ReportBadMessage("A color matrix is nine finite numbers");
    return;
  }
  // The diagonal warms the pointer too (ui::TintedCursorBitmaps).
  if (!std::ranges::all_of(std::array{matrix[0], matrix[4], matrix[8]},
                           [](float x) { return x >= 0.f && x <= 1.f; })) {
    receivers_.ReportBadMessage("A color matrix's diagonal is 0 to 1");
    return;
  }
  if (!set_color_matrix_) {
    // No windows, so no display to draw.
    return;
  }
  std::ranges::copy(matrix, entries.begin());
  set_color_matrix_.Run(display_id, entries);
}

void FrameSinkBroker::InjectInput(mojom::DeskInputPtr input) {
  if (!inject_input_) {
    // Nested, the host session delivers input.
    return;
  }
  inject_input_.Run(*input);
}

void FrameSinkBroker::SetClipboard(mojom::Clipboard clipboard,
                                  const ClipboardContents& contents) {
  if (!set_clipboard_) {
    // No desktop clipboard inside another session. Not an error: the producer
    // cannot know which clipboard the browser reads.
    return;
  }
  set_clipboard_.Run(clipboard, contents);
}

void FrameSinkBroker::ObserveClipboard(
    mojo::PendingRemote<mojom::ClipboardObserver> observer) {
  clipboard_observers_.Add(std::move(observer));
}

void FrameSinkBroker::OnCopied(mojom::Clipboard clipboard,
                               const ClipboardContents& contents) {
  for (auto& observer : clipboard_observers_) {
    observer->OnCopied(clipboard, contents);
  }
}

void FrameSinkBroker::ObserveDisplays(
    mojo::PendingRemote<mojom::DisplayListObserver> observer) {
  const mojo::RemoteSetElementId id =
      display_observers_.Add(std::move(observer));
  if (!displays_.empty()) {
    display_observers_.Get(id)->OnDisplaysChanged(mojo::Clone(displays_));
  }
}

void FrameSinkBroker::OnDisplaysChanged(
    std::vector<mojom::DisplayPtr> displays) {
  if (displays.empty()) {
    return;
  }
  displays_ = std::move(displays);
  for (auto& observer : display_observers_) {
    observer->OnDisplaysChanged(mojo::Clone(displays_));
  }
}

void FrameSinkBroker::ObserveCompositing(
    mojo::PendingRemote<mojom::CompositingObserver> observer) {
  const mojo::RemoteSetElementId id =
      compositing_observers_.Add(std::move(observer));
  if (in_memory_) {
    compositing_observers_.Get(id)->OnCompositingChanged(*in_memory_);
  }
}

void FrameSinkBroker::OnCompositingChanged(bool in_memory) {
  if (in_memory_ == in_memory) {
    return;
  }
  in_memory_ = in_memory;
  for (auto& observer : compositing_observers_) {
    observer->OnCompositingChanged(in_memory);
  }
}

void FrameSinkBroker::ObserveBrowserWindows(
    mojo::PendingRemote<mojom::BrowserWindowListObserver> observer) {
  const mojo::RemoteSetElementId id =
      browser_window_observers_.Add(std::move(observer));
  browser_window_observers_.Get(id)->OnBrowserWindowsChanged(
      mojo::Clone(browser_windows_));
}

void FrameSinkBroker::OnBrowserWindowsChanged(
    std::vector<mojom::ListedBrowserWindowPtr> windows) {
  browser_windows_ = std::move(windows);
  for (auto& observer : browser_window_observers_) {
    observer->OnBrowserWindowsChanged(mojo::Clone(browser_windows_));
  }
}

void FrameSinkBroker::ObserveInputDevices(
    mojo::PendingRemote<mojom::InputDeviceListObserver> observer) {
  const mojo::RemoteSetElementId id =
      input_device_observers_.Add(std::move(observer));
  input_device_observers_.Get(id)->OnInputDevicesChanged(
      mojo::Clone(input_devices_));
}

void FrameSinkBroker::OnInputDevicesChanged(
    std::vector<mojom::ListedInputDevicePtr> devices) {
  input_devices_ = std::move(devices);
  for (auto& observer : input_device_observers_) {
    observer->OnInputDevicesChanged(mojo::Clone(input_devices_));
  }
}

void FrameSinkBroker::CaptureDisplay(
    int64_t display_id,
    const gfx::Size& size,
    uint32_t max_fps,
    mojo::PendingReceiver<mojom::DisplayCapture> capture,
    mojo::PendingRemote<mojom::DisplayCaptureObserver> observer,
    CaptureDisplayCallback callback) {
  if (size.IsEmpty() || max_fps == 0) {
    receivers_.ReportBadMessage("A display capture needs a size and a rate");
    std::move(callback).Run(false);
    return;
  }
  const std::optional<viz::FrameSinkId> target =
      get_display_capture_target_ ? get_display_capture_target_.Run(display_id)
                                  : std::nullopt;
  VLOG(1) << "domicile: a capture of display " << display_id << " at "
          << size.ToString() << ", " << max_fps << " fps: "
          << (target.has_value() ? target->ToString() : "no window yet");
  if (!target.has_value()) {
    // Not a bad message: a display's window opens after the display appears.
    std::move(callback).Run(false);
    return;
  }
  StartCapture(*target, size, max_fps, std::move(capture), std::move(observer));
  std::move(callback).Run(true);
}

void FrameSinkBroker::CaptureBrowserWindow(
    const std::string& window_id,
    uint32_t max_fps,
    mojo::PendingReceiver<mojom::DisplayCapture> capture,
    mojo::PendingRemote<mojom::DisplayCaptureObserver> observer,
    CaptureBrowserWindowCallback callback) {
  if (max_fps == 0) {
    receivers_.ReportBadMessage("A browser window capture needs a rate");
    std::move(callback).Run(false);
    return;
  }
  std::optional<BrowserWindowCaptureTarget> target =
      get_browser_window_capture_target_
          ? get_browser_window_capture_target_.Run(window_id)
          : std::nullopt;
  VLOG(1) << "domicile: a capture of browser window " << window_id << ", " << max_fps
          << " fps: "
          << (target.has_value() ? target->frame_sink_id.ToString()
                                 : "the window is gone");
  if (!target.has_value()) {
    // Not a bad message: the window may have closed since the producer heard
    // of it.
    std::move(callback).Run(false);
    return;
  }
  StartCapture(target->frame_sink_id, target->size_in_pixels, max_fps,
               std::move(capture), std::move(observer),
               std::move(target->drawing));
  std::move(callback).Run(true);
}

void FrameSinkBroker::StartCapture(
    const viz::FrameSinkId& target,
    const gfx::Size& size,
    uint32_t max_fps,
    mojo::PendingReceiver<mojom::DisplayCapture> capture,
    mojo::PendingRemote<mojom::DisplayCaptureObserver> observer,
    base::ScopedClosureRunner held) {
  const bool gpu = get_shared_image_interface_ &&
                   get_shared_image_interface_.Run() != nullptr &&
                   can_capture_into_dmabufs_ && can_capture_into_dmabufs_.Run();
  const uint64_t id = next_capture_++;
  // Unretained: the broker owns every capture and the manager outlives it.
  captures_[id] = std::make_unique<DisplayCapture>(
      base::BindRepeating(
          [](viz::HostFrameSinkManager* manager,
             mojo::PendingReceiver<viz::mojom::FrameSinkVideoCapturer>
                 receiver) {
            manager->CreateVideoCapturer(std::move(receiver));
          },
          base::Unretained(host_frame_sink_manager_.get())),
      target, size, max_fps, gpu, std::move(capture), std::move(observer),
      // `held` lives as long as this callback, which is the capture's life.
      base::BindOnce(
          [](FrameSinkBroker* broker, uint64_t id, base::ScopedClosureRunner) {
            broker->captures_.erase(id);
          },
          base::Unretained(this), id, std::move(held)));
}

BrokeredFrameSink* FrameSinkBroker::SinkForApp(const std::string& app_id) {
  // An empty app id matches nothing, so a page never gets another app's
  // window.
  if (app_id.empty()) {
    return nullptr;
  }
  for (const auto& [id, sink] : frame_sink_map_) {
    if (sink->app_id() == app_id) {
      return sink.get();
    }
  }
  return nullptr;
}

void FrameSinkBroker::OnProducerDisconnected() {
  const mojo::ReceiverId owner = receivers_.current_receiver();
  std::vector<viz::FrameSinkId> owned;
  for (const auto& [id, sink] : frame_sink_map_) {
    if (sink->owner() == owner) {
      owned.push_back(id);
    }
  }
  VLOG(1) << "domicile: a producer went, with " << owned.size() << " frame sinks";
  for (const viz::FrameSinkId& id : owned) {
    EraseFrameSink(frame_sink_map_.find(id),
                   mojom::FrameSinkEnd::kProducerGone);
  }
  if (producer_gone_) {
    producer_gone_.Run();
  }
}

void FrameSinkBroker::EraseFrameSink(
    base::flat_map<viz::FrameSinkId,
                   std::unique_ptr<BrokeredFrameSink>>::iterator iter,
    mojom::FrameSinkEnd end) {
  // Copied: `iter` is invalid after the erase.
  const viz::FrameSinkId frame_sink_id = iter->first;
  VLOG(1) << "domicile: frame sink " << frame_sink_id.ToString() << " of app "
          << iter->second->app_id() << " ended: "
          << (end == mojom::FrameSinkEnd::kProducerGone ? "producer gone"
                                                       : "closed");
  frame_sink_map_.erase(iter);

  auto tokens = embed_tokens_.find(frame_sink_id);
  if (end == mojom::FrameSinkEnd::kProducerGone) {
    disconnected_frame_sinks_.insert(frame_sink_id);
    if (tokens != embed_tokens_.end()) {
      disconnected_embed_tokens_.insert(tokens->second.begin(),
                                        tokens->second.end());
    }
  }
  if (tokens != embed_tokens_.end()) {
    embed_tokens_.erase(tokens);
  }

  auto waiters = end_waiters_.find(frame_sink_id);
  if (waiters == end_waiters_.end()) {
    return;
  }
  std::vector<EndCallback> callbacks = std::move(waiters->second);
  end_waiters_.erase(waiters);
  for (EndCallback& callback : callbacks) {
    std::move(callback).Run(end);
  }
}

}  // namespace domicile
