// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "content/browser/domicile/domicile_frame_sink_broker.h"

#include <algorithm>
#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "base/callback_list.h"
#include "base/command_line.h"
#include "base/functional/bind.h"
#include "base/logging.h"
#include "base/memory/raw_ptr.h"
#include "base/no_destructor.h"
#include "base/numerics/safe_conversions.h"
#include "base/process/process_handle.h"
#include "base/task/thread_pool.h"
#include "components/domicile/browser/browser_window_capture_target.h"
#include "components/domicile/browser/browser_window_listing.h"
#include "components/domicile/browser/display_capture_target.h"
#include "components/domicile/browser/display_list.h"
#include "components/domicile/browser/external_surface_provider.h"
#include "components/domicile/browser/frame_sink_broker.h"
#include "components/domicile/browser/shell_origin.h"
#include "components/domicile/mojom/frame_sink_broker.mojom.h"
#include "content/browser/compositor/surface_utils.h"
#include "content/browser/domicile/domicile_desk.h"
#include "content/browser/domicile/domicile_spike_probe.h"
#include "content/browser/gpu/gpu_data_manager_impl.h"
#include "components/viz/common/gpu/raster_context_provider.h"
#include "components/viz/common/resources/shared_image_format.h"
#include "content/public/browser/browser_thread.h"
#include "content/public/browser/gpu_data_manager_observer.h"
#include "content/public/browser/gpu_utils.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/render_process_host.h"
#include "gpu/command_buffer/client/context_support.h"
#include "gpu/command_buffer/client/shared_image_interface.h"
#include "gpu/ipc/client/gpu_channel_host.h"
#include "ui/aura/env.h"
#include "ui/aura/window_tree_host.h"
#include "ui/compositor/compositor.h"
#include "ui/display/display.h"
#include "ui/display/display_observer.h"
#include "ui/base/clipboard/clipboard_buffer.h"
#include "ui/display/screen.h"
#include "ui/gfx/buffer_types.h"
#include "ui/events/devices/device_data_manager.h"
#include "ui/events/devices/input_device.h"
#include "ui/events/devices/input_device_event_observer.h"
#include "ui/ozone/public/ozone_platform.h"
#include "third_party/skia/include/core/SkM44.h"
#include "mojo/public/cpp/bindings/message.h"
#include "mojo/public/cpp/platform/named_platform_channel.h"
#include "mojo/public/cpp/platform/platform_channel_server_endpoint.h"
#include "mojo/public/cpp/system/invitation.h"

namespace content {
namespace {

// Must match components/domicile/spike/solid_color_submitter.cc.
constexpr char kSocketSwitch[] = "domicile-broker-socket";

// Integers, not strings: ipcz indexes an invitation attachment by the first
// four bytes of its name, and maps any name not 4 or 8 bytes long to index 0
// (mojo/core/ipcz_driver/invitation.cc, GetAttachmentIndex), so two string
// names collide. At most Invitation::kMaxAttachments (7).
constexpr uint64_t kBrokerPipeName = 0;
constexpr uint64_t kProbePipeName = 1;

// The GPU interface that imports dmabufs, as components/exo/buffer.cc does.
// Lives in the browser because only it has aura::Env. Null without a GPU
// (--disable-gpu, --ozone-platform=headless).
gpu::SharedImageInterface* GetSharedImageInterface() {
  ui::ContextFactory* context_factory =
      aura::Env::GetInstance()->context_factory();
  if (!context_factory) {
    return nullptr;
  }
  scoped_refptr<viz::RasterContextProvider> context_provider =
      context_factory->SharedMainThreadRasterContextProvider();
  if (!context_provider) {
    return nullptr;
  }
  return context_provider->SharedImageInterface();
}

// Runs `done` once the GPU channel GetSharedImageInterface's images are made
// on passes `sync_token`. The same channel carries the images' creation, so
// the wait is ordered after it. Drops `done` if the context is gone or lost
// first.
void SignalSyncToken(const gpu::SyncToken& sync_token,
                     base::OnceClosure done) {
  ui::ContextFactory* context_factory =
      aura::Env::GetInstance()->context_factory();
  CHECK(context_factory) << "domicile: a GPU import without a context factory";
  scoped_refptr<viz::RasterContextProvider> context_provider =
      context_factory->SharedMainThreadRasterContextProvider();
  if (!context_provider) {
    LOG(ERROR) << "domicile: the GPU context went before an imported buffer "
                  "was made; the import is refused";
    return;
  }
  context_provider->ContextSupport()->SignalSyncToken(sync_token,
                                                      std::move(done));
}

// Whether the GPU can make the dmabufs viz captures a display into: BGRA, for
// scanout, as media::RenderableMappableSharedImageVideoFramePool asks for
// without CPU access. Nested on Wayland it cannot without a render node or
// the session's dmabuf formats, and viz then fails the capture's first frame.
bool CanCaptureIntoDmabufs() {
  return ui::OzonePlatform::GetInstance()->IsNativePixmapConfigSupported(
      viz::SinglePlaneFormat::kBGRA_8888, gfx::BufferUsage::SCANOUT);
}

// The interface that makes a window in shared memory a software image, while
// the browser composites in software: 2D virtio-gpu, simpledrm, vkms,
// --disable-gpu. Null while it composites on the GPU, where viz draws no
// software image. Made on the GPU channel, as VizProcessTransportFactory makes
// a compositor's, and again after the channel is lost.
gpu::SharedImageInterface* GetSoftwareSharedImageInterface() {
  if (!content::GpuDataManagerImpl::GetInstance()->IsGpuCompositingDisabled()) {
    return nullptr;
  }
  static base::NoDestructor<scoped_refptr<gpu::GpuChannelHost>> channel;
  static base::NoDestructor<scoped_refptr<gpu::SharedImageInterface>> sii;
  if (!*channel || (*channel)->IsLost()) {
    *channel =
        content::GetGpuChannelEstablishFactory()->EstablishGpuChannelSync();
    if (!*channel) {
      LOG(ERROR) << "domicile: no GPU channel to make a window's software "
                    "image on";
      *sii = nullptr;
      return nullptr;
    }
    *sii = (*channel)->CreateClientSharedImageInterface();
  }
  return sii->get();
}

// The ozone platform whose displays are the machine's monitors. With the
// headless desk switch, ozone headless shows the compositor's virtual
// monitors instead (ui/ozone/platform/headless/domicile/headless_desk.h,
// whose string this copies). Anywhere else Domicile runs nested, and its
// desktop is a window in another session.
constexpr char kScanoutPlatform[] = "drm";
constexpr char kHeadlessDeskSwitch[] = "domicile-headless-desk";

// Must match ui/ozone/public/ozone_switches.cc. Copied to avoid a dependency
// for one string.
constexpr char kOzonePlatformSwitch[] = "ozone-platform";

// Forwards the screen's display list to the broker.
//
// On DRM, DrmScreen builds its DisplayList from the same snapshots that
// configure the CRTCs, so a hotplug already reaches this observer.
//
// Each notification re-reads the whole list: it is small, and the producer
// receives the whole list anyway.
class DomicileDisplayWatcher : public display::DisplayObserver {
 public:
  explicit DomicileDisplayWatcher(domicile::FrameSinkBroker* broker)
      : broker_(broker) {
    // BrowserMainRunnerImpl::Initialize builds the screen in
    // InitializeToolkit() before CreateStartupTasks(), which leads here. Crash
    // with a message if that order changes.
    CHECK(display::Screen::Get())
        << "domicile: no screen to read the displays off";
    display::Screen::Get()->AddObserver(this);
    Read();
  }

  DomicileDisplayWatcher(const DomicileDisplayWatcher&) = delete;
  DomicileDisplayWatcher& operator=(const DomicileDisplayWatcher&) = delete;

  ~DomicileDisplayWatcher() override {
    display::Screen::Get()->RemoveObserver(this);
  }

  // display::DisplayObserver implementation.
  void OnDisplayAdded(const display::Display& added) override { Read(); }
  void OnDisplaysRemoved(const display::Displays& removed) override { Read(); }
  void OnDisplayMetricsChanged(const display::Display& changed,
                               uint32_t changed_metrics) override {
    Read();
  }

 private:
  void Read() {
    ui::OzonePlatform* const platform = ui::OzonePlatform::GetInstance();
    base::flat_map<int64_t, domicile::DisplayPanel> panels;
    for (const auto& [id, panel] : platform->GetDomicilePanels()) {
      domicile::DisplayPanel& crossing = panels[id];
      for (const ui::DomicileDisplayMode& mode : panel.modes) {
        crossing.modes.push_back(
            {.size = mode.size, .refresh_mhz = mode.refresh_mhz});
      }
      crossing.refresh_mhz = panel.refresh_mhz;
      crossing.physical_size_mm = panel.physical_size_mm;
      crossing.adaptive_sync = AdaptiveSyncOf(panel.adaptive_sync);
      crossing.hdr = HdrOf(panel.hdr);
      crossing.max_luminance = panel.max_luminance;
      crossing.max_average_luminance = panel.max_average_luminance;
      crossing.min_luminance = panel.min_luminance;
      crossing.sdr_white_nits = panel.sdr_white_nits;
    }
    broker_->OnDisplaysChanged(domicile::DisplayListFor(
        display::Screen::Get()->GetAllDisplays(),
        platform->GetDomicileConnectors(), platform->GetDomicileGammaSizes(),
        panels));
  }

  // A switch rather than a cast, so a new state is a compile error here.
  static domicile::mojom::AdaptiveSync AdaptiveSyncOf(
      ui::DomicileAdaptiveSync adaptive_sync) {
    switch (adaptive_sync) {
      case ui::DomicileAdaptiveSync::kUnsupported:
        return domicile::mojom::AdaptiveSync::kUnsupported;
      case ui::DomicileAdaptiveSync::kOff:
        return domicile::mojom::AdaptiveSync::kOff;
      case ui::DomicileAdaptiveSync::kOn:
        return domicile::mojom::AdaptiveSync::kOn;
    }
  }

  // A switch rather than a cast, so a new state is a compile error here.
  static domicile::mojom::Hdr HdrOf(ui::DomicileHdr hdr) {
    switch (hdr) {
      case ui::DomicileHdr::kUnsupported:
        return domicile::mojom::Hdr::kUnsupported;
      case ui::DomicileHdr::kOff:
        return domicile::mojom::Hdr::kOff;
      case ui::DomicileHdr::kOn:
        return domicile::mojom::Hdr::kOn;
    }
  }

  const raw_ptr<domicile::FrameSinkBroker> broker_;
};

// Maps the mojom clipboard to ui's. A switch rather than a cast, because the
// owners of either enum may reorder it, and a copy on the wrong clipboard
// would paste unexpected text.
ui::ClipboardBuffer BufferOf(domicile::mojom::Clipboard clipboard) {
  switch (clipboard) {
    case domicile::mojom::Clipboard::kCopy:
      return ui::ClipboardBuffer::kCopyPaste;
    case domicile::mojom::Clipboard::kPrimary:
      return ui::ClipboardBuffer::kSelection;
  }
}

// The reverse. Returns `std::nullopt` for buffers with no desktop clipboard,
// such as `kDrag`, since a drag is not a copy.
std::optional<domicile::mojom::Clipboard> ClipboardOf(
    ui::ClipboardBuffer buffer) {
  switch (buffer) {
    case ui::ClipboardBuffer::kCopyPaste:
      return domicile::mojom::Clipboard::kCopy;
    case ui::ClipboardBuffer::kSelection:
      return domicile::mojom::Clipboard::kPrimary;
    default:
      return std::nullopt;
  }
}

// A switch rather than a cast, so a new transform is a compile error here.
ui::DomicileDisplayLayout::Transform TransformOf(
    domicile::mojom::DisplayTransform transform) {
  switch (transform) {
    case domicile::mojom::DisplayTransform::kNormal:
      return ui::DomicileDisplayLayout::Transform::kNormal;
    case domicile::mojom::DisplayTransform::kRotate90:
      return ui::DomicileDisplayLayout::Transform::kRotate90;
    case domicile::mojom::DisplayTransform::kRotate180:
      return ui::DomicileDisplayLayout::Transform::kRotate180;
    case domicile::mojom::DisplayTransform::kRotate270:
      return ui::DomicileDisplayLayout::Transform::kRotate270;
  }
}

// Applies the producer's display layout. Every ozone platform but DRM and a
// headless desk ignores it, and //components/domicile/browser cannot depend on //ui/ozone, so this
// lives here.
void SetDisplayLayout(std::vector<domicile::mojom::DisplayLayoutPtr> layout) {
  std::vector<ui::DomicileDisplayLayout> wanted;
  wanted.reserve(layout.size());
  for (const domicile::mojom::DisplayLayoutPtr& display : layout) {
    wanted.push_back({.id = display->id,
                      .enabled = display->enabled,
                      .origin = display->origin,
                      .transform = TransformOf(display->transform),
                      .scale = display->scale,
                      .desk = display->desk,
                      .mode = display->mode,
                      .refresh_mhz = display->refresh_mhz,
                      .adaptive_sync = display->adaptive_sync,
                      .hdr = display->hdr,
                      .sdr_white_nits = display->sdr_white_nits});
  }
  ui::OzonePlatform::GetInstance()->SetDomicileDisplayLayout(wanted);
  // Update the desk after requesting the modeset, so a page moved onto a
  // display finds it lit.
  if (wanted.empty()) {
    // The hardware places every display. A blank is a list of disabled
    // displays, never an empty one.
    DomicileDeskLaidOut(std::nullopt);
    return;
  }
  // A dark display with a place on the desk sleeps: it keeps that place.
  std::vector<DomicileDeskDisplay> lit;
  for (const ui::DomicileDisplayLayout& display : wanted) {
    if (display.enabled || !display.desk.IsEmpty()) {
      lit.push_back({.id = display.id,
                     .desk = display.desk,
                     .scale = static_cast<float>(display.scale),
                     .lit = display.enabled});
    }
  }
  DomicileDeskLaidOut(std::move(lit));
}

// Binds the producer's tablets and touchscreens to displays. Lives here for
// SetDisplayLayout's reason; every platform but DRM ignores it.
void SetPointerTargets(std::vector<domicile::mojom::PointerTargetPtr> targets) {
  std::vector<ui::DomicilePointerTarget> wanted;
  wanted.reserve(targets.size());
  for (const domicile::mojom::PointerTargetPtr& target : targets) {
    wanted.push_back(
        {.device = target->device, .display_id = target->display_id});
  }
  ui::OzonePlatform::GetInstance()->SetDomicilePointerTargets(
      std::move(wanted));
}

void SetInputConfig(const std::string& config) {
  ui::OzonePlatform::GetInstance()->SetDomicileInputConfig(config);
}

// Sets the producer's virtual displays. Lives here for SetDisplayLayout's
// reason; every platform but DRM and a headless desk ignores it.
void SetVirtualDisplays(
    std::vector<domicile::mojom::VirtualDisplayPtr> displays) {
  std::vector<ui::DomicileVirtualDisplay> wanted;
  wanted.reserve(displays.size());
  for (const domicile::mojom::VirtualDisplayPtr& display : displays) {
    wanted.push_back({.id = display->id,
                      .mode = display->mode,
                      .refresh_mhz = display->refresh_mhz,
                      .name = display->name});
  }
  ui::OzonePlatform::GetInstance()->SetDomicileVirtualDisplays(
      std::move(wanted));
}

// Sets one display's gamma ramp. Lives here for SetDisplayLayout's reason;
// every platform but DRM ignores it.
void SetGamma(int64_t display_id, const domicile::mojom::GammaRamp& ramp) {
  ui::OzonePlatform::GetInstance()->SetDomicileGamma(
      display_id,
      {.red = ramp.red, .green = ramp.green, .blue = ramp.blue});
}

// Delivers emulated input to the desk. Lives here for SetDisplayLayout's
// reason; a nested desktop's platform ignores it.
void InjectInput(const domicile::mojom::DeskInput& input) {
  ui::DomicileDeskInput::Kind kind = ui::DomicileDeskInput::Kind::kPointer;
  switch (input.kind) {
    case domicile::mojom::DeskInputKind::kPointer:
      kind = ui::DomicileDeskInput::Kind::kPointer;
      break;
    case domicile::mojom::DeskInputKind::kButton:
      kind = ui::DomicileDeskInput::Kind::kButton;
      break;
    case domicile::mojom::DeskInputKind::kScroll:
      kind = ui::DomicileDeskInput::Kind::kScroll;
      break;
    case domicile::mojom::DeskInputKind::kKey:
      kind = ui::DomicileDeskInput::Kind::kKey;
      break;
  }
  ui::OzonePlatform::GetInstance()->InjectDomicileInput({.kind = kind,
                                                         .x = input.x,
                                                         .y = input.y,
                                                         .code = input.code,
                                                         .pressed =
                                                             input.pressed});
}

// Sets the clipboard this process pastes from.
//
// Lives here because //components/domicile/browser cannot depend on //ui/ozone.
// Every platform but DRM ignores it: a nested run uses the host session's
// clipboard.
void SetClipboard(
    domicile::mojom::Clipboard clipboard,
    const domicile::FrameSinkBroker::ClipboardContents& contents) {
  ui::OzonePlatform::GetInstance()->SetDomicileClipboard(BufferOf(clipboard),
                                                         contents);
}

// The root frame sink of the browser window showing `display_id`, for a
// display capture. See domicile::CaptureTargetFor for the matching.
std::optional<viz::FrameSinkId> DisplayCaptureTarget(int64_t display_id) {
  std::vector<domicile::CaptureRoot> windows;
  for (aura::WindowTreeHost* host :
       aura::Env::GetInstance()->window_tree_hosts()) {
    windows.push_back({.bounds_in_pixels = host->GetBoundsInPixels(),
                       .frame_sink_id = host->compositor()->frame_sink_id()});
  }
  return domicile::CaptureTargetFor(
      display_id, display::Screen::Get()->GetAllDisplays(), windows);
}

// Redraws the browser window showing `display_id`, so its CRTC page flips
// with the gamma ramp just set even when nothing on it is changing. A display
// no window shows has no flip to wait for.
void RedrawDisplay(int64_t display_id) {
  const std::optional<viz::FrameSinkId> target =
      DisplayCaptureTarget(display_id);
  if (!target) {
    return;
  }
  for (aura::WindowTreeHost* host :
       aura::Env::GetInstance()->window_tree_hosts()) {
    if (host->compositor()->frame_sink_id() == *target) {
      host->compositor()->ScheduleFullRedraw();
    }
  }
}

// Has viz draw display `display_id` through `matrix`, 3x3 and row-major, in
// linear light (patch 0217), and redraws it so a still screen shows it. A
// display no window shows has nothing to draw.
//
// The cursor plane skips that matrix, so the pointer on the display is warmed
// by its gains too. The night light's matrix is diagonal.
void SetColorMatrix(int64_t display_id,
                    const domicile::FrameSinkBroker::ColorMatrix& m) {
  const std::vector<display::Display> displays =
      display::Screen::Get()->GetAllDisplays();
  const auto display =
      std::ranges::find(displays, display_id, &display::Display::id);
  if (display != displays.end()) {
    ui::OzonePlatform::GetInstance()->SetDomicileCursorTint(
        display_id, display->bounds(), {m[0], m[4], m[8]});
  }
  const std::optional<viz::FrameSinkId> target =
      DisplayCaptureTarget(display_id);
  if (!target) {
    return;
  }
  // SkM44's sixteen-number constructor takes rows.
  const SkM44 matrix(m[0], m[1], m[2], 0,  //
                     m[3], m[4], m[5], 0,  //
                     m[6], m[7], m[8], 0,  //
                     0, 0, 0, 1);
  for (aura::WindowTreeHost* host :
       aura::Env::GetInstance()->window_tree_hosts()) {
    if (host->compositor()->frame_sink_id() == *target) {
      host->compositor()->SetDisplayColorMatrix(matrix);
      host->compositor()->ScheduleFullRedraw();
    }
  }
}

// The browser's frame sink broker and the socket producers reach it over.
//
// The socket path is the only access control. A FrameSinkBroker pipe can
// allocate any frame sink in viz. Renderers cannot get the invitation, and the
// ExternalSurfaceProvider they do get cannot allocate.
// How `device` is attached, for the producer.
domicile::mojom::InputDeviceConnection ConnectionOf(
    const ui::InputDevice& device) {
  switch (device.type) {
    case ui::INPUT_DEVICE_INTERNAL:
      return domicile::mojom::InputDeviceConnection::kInternal;
    case ui::INPUT_DEVICE_USB:
      return domicile::mojom::InputDeviceConnection::kUsb;
    case ui::INPUT_DEVICE_BLUETOOTH:
      return domicile::mojom::InputDeviceConnection::kBluetooth;
    case ui::INPUT_DEVICE_UNKNOWN:
      return domicile::mojom::InputDeviceConnection::kUnknown;
  }
}

// Every input device the browser reads, kind by kind, each in the order the
// browser found it.
std::vector<domicile::mojom::ListedInputDevicePtr> ListedInputDevices() {
  const ui::DeviceDataManager* manager = ui::DeviceDataManager::GetInstance();
  std::vector<domicile::mojom::ListedInputDevicePtr> listed;
  // Each list holds its own subclass of ui::InputDevice.
  const auto add = [&listed](const auto& devices,
                             domicile::mojom::InputDeviceKind kind) {
    for (const ui::InputDevice& device : devices) {
      listed.push_back(domicile::mojom::ListedInputDevice::New(
          device.id, device.name, kind, ConnectionOf(device),
          device.sys_path.value(), device.vendor_id, device.product_id));
    }
  };
  using Kind = domicile::mojom::InputDeviceKind;
  add(manager->GetKeyboardDevices(), Kind::kKeyboard);
  add(manager->GetMouseDevices(), Kind::kMouse);
  add(manager->GetTouchpadDevices(), Kind::kTouchpad);
  add(manager->GetTouchscreenDevices(), Kind::kTouchscreen);
  add(manager->GetPointingStickDevices(), Kind::kPointingStick);
  add(manager->GetGraphicsTabletDevices(), Kind::kGraphicsTablet);
  add(manager->GetUncategorizedDevices(), Kind::kOther);
  return listed;
}

class DomicileBrowserService : public content::GpuDataManagerObserver,
                               public ui::InputDeviceEventObserver {
 public:
  DomicileBrowserService()
      : broker_(GetHostFrameSinkManager(),
                base::BindRepeating(&AllocateFrameSinkId),
                base::BindRepeating(&GetSharedImageInterface),
                base::BindRepeating(&SetDisplayLayout),
                base::BindRepeating(&SetClipboard),
                base::BindRepeating(&DisplayCaptureTarget),
                base::BindRepeating(&domicile::FindBrowserWindowCaptureTarget),
                base::BindRepeating(&SetPointerTargets),
                base::BindRepeating(&GetSoftwareSharedImageInterface),
                base::BindRepeating(&SetVirtualDisplays),
                base::BindRepeating(&SetGamma),
                base::BindRepeating(&InjectInput),
                base::BindRepeating(&SetInputConfig),
                base::BindRepeating(&RedrawDisplay),
                base::BindRepeating(&SetColorMatrix),
                base::BindRepeating(&CanCaptureIntoDmabufs),
                base::BindRepeating(&SignalSyncToken)),
        provider_(&broker_) {
    // Registered on every platform so copies made in a page reach the producer.
    // `SetClipboard` handles copies made outside. Unretained is safe: this is a
    // NoDestructor on the UI thread.
    ui::OzonePlatform::GetInstance()->SetDomicileCopiedCallback(
        base::BindRepeating(&DomicileBrowserService::Copied,
                            base::Unretained(this)));
    // A GPU process that falls back to software disables GPU compositing
    // after the producer may have connected, so the producer hears each
    // change. Never removed: this is a NoDestructor.
    content::GpuDataManagerImpl::GetInstance()->AddObserver(this);
    OnGpuInfoUpdate();
    // Capture tools list the browser windows beside the producer's own.
    // Unretained for Copied's reason.
    browser_windows_ = domicile::WatchBrowserWindowListing(base::BindRepeating(
        &DomicileBrowserService::BrowserWindowsChanged,
        base::Unretained(this)));
    BrowserWindowsChanged();
    // `domicile list-inputs` lists the devices. Never removed: this is a
    // NoDestructor.
    ui::DeviceDataManager::GetInstance()->AddObserver(this);
    InputDevicesChanged();
    const base::CommandLine& command_line =
        *base::CommandLine::ForCurrentProcess();
    // Only on DRM or a headless desk. A nested run's screen is the host's
    // monitors, which are not the producer's desktop.
    if (command_line.GetSwitchValueASCII(kOzonePlatformSwitch) ==
            kScanoutPlatform ||
        command_line.HasSwitch(kHeadlessDeskSwitch)) {
      displays_ = std::make_unique<DomicileDisplayWatcher>(&broker_);
    }
    if (!command_line.HasSwitch(kSocketSwitch)) {
      return;
    }
    const std::string socket_path =
        command_line.GetSwitchValueASCII(kSocketSwitch);
    // An invitation is accepted once, so a compositor restarted under this
    // browser needs a new one. Binding again replaces the dead compositor's
    // socket file. See "A compositor restart" in
    // docs/architecture/ENGINE-FORK.md. Unretained for Copied's reason.
    broker_.SetProducerGoneCallback(base::BindRepeating(
        &DomicileBrowserService::Listen, base::Unretained(this), socket_path));
    Listen(socket_path);
  }

  DomicileBrowserService(const DomicileBrowserService&) = delete;
  DomicileBrowserService& operator=(const DomicileBrowserService&) = delete;

  ~DomicileBrowserService() override = default;

  // content::GpuDataManagerObserver implementation.
  void OnGpuInfoUpdate() override {
    broker_.OnCompositingChanged(
        content::GpuDataManagerImpl::GetInstance()->IsGpuCompositingDisabled());
  }

  // ui::InputDeviceEventObserver implementation.
  void OnInputDeviceConfigurationChanged(uint8_t input_device_types) override {
    InputDevicesChanged();
  }
  void OnDeviceListsComplete() override { InputDevicesChanged(); }

  void Bind(
      mojo::PendingReceiver<domicile::mojom::ExternalSurfaceProvider> receiver,
      uint32_t renderer_client_id) {
    provider_.Bind(std::move(receiver), renderer_client_id);
  }

 private:
  // Forwards a copy made in this browser to the producer.
  void Copied(ui::ClipboardBuffer buffer,
              const ui::OzonePlatform::DomicileClipboardContents& contents) {
    std::optional<domicile::mojom::Clipboard> clipboard = ClipboardOf(buffer);
    if (clipboard.has_value()) {
      broker_.OnCopied(*clipboard, contents);
    }
  }

  // Forwards the browser windows a capture tool lists to the producer, each
  // with the views it holds and shows.
  void BrowserWindowsChanged() {
    broker_.OnBrowserWindowsChanged(
        domicile::ForCaptureTools(domicile::ListedBrowserWindows()));
  }

  // Forwards the input devices the browser reads to the producer.
  void InputDevicesChanged() {
    broker_.OnInputDevicesChanged(ListedInputDevices());
  }

  // Binding the socket does blocking I/O, so it runs off the UI thread.
  //
  // Nothing waits for the result. A producer connects once the socket exists,
  // and a page that embeds first waits in the broker.
  void Listen(const std::string& socket_path) {
    base::ThreadPool::PostTaskAndReplyWithResult(
        FROM_HERE, {base::MayBlock()},
        base::BindOnce(&DomicileBrowserService::BindSocket, socket_path),
        base::BindOnce(&DomicileBrowserService::SendInvitation,
                       base::Unretained(this), socket_path));
  }

  static mojo::PlatformChannelServerEndpoint BindSocket(
      const std::string& socket_path) {
    mojo::NamedPlatformChannel::Options options;
    options.server_name =
        mojo::NamedPlatformChannel::ServerNameFromUTF8(socket_path);
    return mojo::NamedPlatformChannel(options).TakeServerEndpoint();
  }

  void SendInvitation(const std::string& socket_path,
                      mojo::PlatformChannelServerEndpoint endpoint) {
    // Crash rather than log: the switch asked for a socket, and a browser
    // without one looks like a page that never embedded, which misleads
    // debugging.
    CHECK(endpoint.is_valid())
        << "domicile: could not listen on " << socket_path;

    mojo::OutgoingInvitation invitation;
    broker_.Bind(mojo::PendingReceiver<domicile::mojom::FrameSinkBroker>(
        invitation.AttachMessagePipe(kBrokerPipeName)));
    BindDomicileSpikeProbe(
        mojo::PendingReceiver<domicile::mojom::SpikeProbe>(
            invitation.AttachMessagePipe(kProbePipeName)));

    // An invitation, not mojo::IsolatedConnection, because the broker forwards
    // the producer's CompositorFrameSink receiver to the viz process and an
    // isolated connection cannot carry that handle. See
    // docs/architecture/ENGINE-FORK.md#how-the-producer-reaches-the-broker.
    //
    // The producer is not a child process, so there is no process handle. POSIX
    // does not need one.
    mojo::OutgoingInvitation::Send(std::move(invitation),
                                   base::kNullProcessHandle,
                                   std::move(endpoint));
    LOG(INFO) << "domicile: frame sink broker listening on " << socket_path;
  }

  domicile::FrameSinkBroker broker_;
  domicile::ExternalSurfaceProvider provider_;
  // Null unless on DRM or a headless desk.
  std::unique_ptr<DomicileDisplayWatcher> displays_;
  base::CallbackListSubscription browser_windows_;
};

DomicileBrowserService& GetDomicileBrowserService() {
  CHECK_CURRENTLY_ON(BrowserThread::UI);
  static base::NoDestructor<DomicileBrowserService> service;
  return *service;
}

}  // namespace

void StartDomicileFrameSinkBroker() {
  // Constructing the service opens the socket if the switch is set.
  GetDomicileBrowserService();
}

void BindDomicileExternalSurfaceProvider(
    RenderFrameHost* frame,
    mojo::PendingReceiver<domicile::mojom::ExternalSurfaceProvider> receiver) {
  // Checked at bind time: the binder map is built before a document commits.
  if (!domicile::IsShellOrigin(frame->GetLastCommittedOrigin())) {
    mojo::ReportBadMessage("domicile: only the shell may embed a window.");
  } else {
    // A frame sink's client id is its renderer's process id; see
    // RenderProcessHostImpl::CreateEmbeddedFrameSinkProvider.
    GetDomicileBrowserService().Bind(
        std::move(receiver),
        base::checked_cast<uint32_t>(frame->GetProcess()->GetDeprecatedID()));
  }
}

}  // namespace content
