// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/browser/frame_sink_broker.h"

#include <cstdint>
#include <limits>
#include <memory>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "base/check.h"
#include "base/check_op.h"
#include "base/files/file_util.h"
#include "base/files/scoped_file.h"
#include "base/functional/bind.h"
#include "base/functional/callback_helpers.h"
#include "base/memory/raw_ptr.h"
#include "base/memory/scoped_refptr.h"
#include "base/memory/unsafe_shared_memory_region.h"
#include "base/run_loop.h"
#include "base/strings/string_number_conversions.h"
#include "base/test/task_environment.h"
#include "base/test/test_future.h"
#include "base/unguessable_token.h"
#include "components/domicile/browser/browser_window_capture_target.h"
#include "components/domicile/browser/external_surface_provider.h"
#include "components/viz/common/frame_sinks/begin_frame_args.h"
#include "components/viz/common/resources/shared_image_format.h"
#include "components/viz/common/surfaces/frame_sink_id.h"
#include "components/viz/common/surfaces/frame_sink_id_allocator.h"
#include "components/viz/common/surfaces/local_surface_id.h"
#include "components/viz/common/surfaces/parent_local_surface_id_allocator.h"
#include "components/viz/host/host_frame_sink_manager.h"
#include "components/viz/service/frame_sinks/compositor_frame_sink_support.h"
#include "components/viz/service/frame_sinks/frame_sink_manager_impl.h"
#include "components/viz/service/surfaces/surface.h"
#include "components/viz/service/surfaces/surface_manager.h"
#include "components/viz/test/compositor_frame_helpers.h"
#include "components/viz/test/fake_external_begin_frame_source.h"
#include "components/viz/test/fake_host_frame_sink_client.h"
#include "components/viz/test/mock_compositor_frame_sink_client.h"
#include "gpu/command_buffer/client/client_shared_image.h"
#include "gpu/command_buffer/client/test_shared_image_interface.h"
#include "gpu/command_buffer/common/mailbox.h"
#include "gpu/command_buffer/common/shared_image_info.h"
#include "gpu/command_buffer/common/sync_token.h"
#include "mojo/public/cpp/bindings/pending_receiver.h"
#include "mojo/public/cpp/bindings/pending_remote.h"
#include "mojo/public/cpp/bindings/receiver.h"
#include "mojo/public/cpp/bindings/remote.h"
#include "mojo/public/cpp/test_support/test_utils.h"
#include "testing/gmock/include/gmock/gmock.h"
#include "testing/gtest/include/gtest/gtest.h"
#include "ui/gfx/color_space.h"
#include "third_party/skia/include/core/SkAlphaType.h"
#include "ui/gfx/geometry/point.h"
#include "ui/gfx/geometry/rect.h"
#include "ui/gfx/geometry/size.h"
#include "ui/gfx/gpu_fence.h"
#include "ui/gfx/gpu_fence_handle.h"
#include "ui/gfx/gpu_memory_buffer_handle.h"
#include "ui/gfx/native_pixmap_handle.h"

namespace domicile {
namespace {

// The browser's own frame sink client id. Renderer ids start at 1. See
// content::AllocateFrameSinkId and
// content/browser/compositor/viz_process_transport_factory.cc.
constexpr uint32_t kBrowserClientId = 0u;

// The embedding page's renderer frame sink, the parent BeginFrames come from.
constexpr viz::FrameSinkId kPageFrameSinkId(1u, 1u);


// The app id `BrokerASink` passes to CreateFrameSink.
constexpr char kTestApp[] = "test-app";
constexpr gfx::Size kEmbeddedSize(320, 240);
// The page's device scale factor.
constexpr double kEmbeddedScale = 1.5;
// The <app> element's CSS `zoom`.
constexpr double kEmbeddedZoom = 1.25;

// The DRM fourcc of the buffers tests import, and its viz format.
constexpr uint32_t kArgb8888 = 0x34325241;
constexpr gfx::Size kBufferSize(64, 48);

// The browser's SharedImageInterface, recording the images it is told to read
// only after an acquire fence.
class FenceRecordingSharedImageInterface : public gpu::TestSharedImageInterface {
 public:
  FenceRecordingSharedImageInterface();

  using gpu::TestSharedImageInterface::UpdateSharedImage;
  void UpdateSharedImage(const gpu::SyncToken& sync_token,
                         std::unique_ptr<gfx::GpuFence> acquire_fence,
                         const gpu::Mailbox& mailbox) override;

  // Every image given a fence, in order.
  const std::vector<gpu::Mailbox>& fenced() const { return fenced_; }

 private:
  ~FenceRecordingSharedImageInterface() override;

  std::vector<gpu::Mailbox> fenced_;
};

FenceRecordingSharedImageInterface::FenceRecordingSharedImageInterface() =
    default;
FenceRecordingSharedImageInterface::~FenceRecordingSharedImageInterface() =
    default;

void FenceRecordingSharedImageInterface::UpdateSharedImage(
    const gpu::SyncToken& sync_token,
    std::unique_ptr<gfx::GpuFence> acquire_fence,
    const gpu::Mailbox& mailbox) {
  CHECK(acquire_fence);
  CHECK(!acquire_fence->GetGpuFenceHandle().is_null());
  fenced_.push_back(mailbox);
  gpu::TestSharedImageInterface::UpdateSharedImage(
      sync_token, std::move(acquire_fence), mailbox);
}

// The browser's SharedImageInterface while it composites in software,
// recording the shared memory each window's image is made over.
class SoftwareSharedImageInterface : public gpu::TestSharedImageInterface {
 public:
  SoftwareSharedImageInterface();

  scoped_refptr<gpu::ClientSharedImage>
  DomicileCreateSharedImageForSoftwareCompositor(
      const gpu::SharedImageInfo& si_info,
      base::UnsafeSharedMemoryRegion region,
      uint32_t stride) override;

  // Each image's region and row stride, in order.
  const std::vector<std::pair<base::UnguessableToken, uint32_t>>& made_over()
      const {
    return made_over_;
  }

 private:
  ~SoftwareSharedImageInterface() override;

  std::vector<std::pair<base::UnguessableToken, uint32_t>> made_over_;
};

SoftwareSharedImageInterface::SoftwareSharedImageInterface() = default;
SoftwareSharedImageInterface::~SoftwareSharedImageInterface() = default;

scoped_refptr<gpu::ClientSharedImage>
SoftwareSharedImageInterface::DomicileCreateSharedImageForSoftwareCompositor(
    const gpu::SharedImageInfo& si_info,
    base::UnsafeSharedMemoryRegion region,
    uint32_t stride) {
  made_over_.emplace_back(region.GetGUID(), stride);
  // The test interface's own software image: what it is made over does not
  // reach viz here.
  return CreateSharedImageForSoftwareCompositor(si_info);
}

// A window's dmabuf of `size`, four bytes a pixel. Any fd crosses mojo as one.
gfx::GpuMemoryBufferHandle ADmabuf(const gfx::Size& size) {
  base::ScopedFD read_end;
  base::ScopedFD write_end;
  CHECK(base::CreatePipe(&read_end, &write_end));
  gfx::NativePixmapHandle pixmap;
  pixmap.planes.emplace_back(4 * size.width(), /*offset=*/0, /*size=*/0,
                             std::move(read_end));
  return gfx::GpuMemoryBufferHandle(std::move(pixmap));
}

// A fence for the producer's draw. Any fd crosses mojo as one.
gfx::GpuFenceHandle AFence() {
  base::ScopedFD read_end;
  base::ScopedFD write_end;
  CHECK(base::CreatePipe(&read_end, &write_end));
  gfx::GpuFenceHandle fence;
  fence.Adopt(std::move(read_end));
  return fence;
}

// Fake producer observer, told which surface the embedder chose.
class FakeSurfaceObserver : public mojom::SurfaceObserver {
 public:
  mojo::PendingRemote<mojom::SurfaceObserver> BindRemote() {
    return receiver_.BindNewPipeAndPassRemote();
  }

  // mojom::SurfaceObserver implementation.
  void OnSurfaceEmbedded(const viz::LocalSurfaceId& local_surface_id,
                         const gfx::Size& size,
                         double scale,
                         double zoom) override {
    told_.push_back(local_surface_id);
    if (!embedded_.IsReady()) {
      embedded_.SetValue(local_surface_id, size, scale, zoom);
    }
  }

  // Unused here: these tests need no GPU.
  void OnBufferReleased(uint64_t buffer_id) override {
    released_.push_back(buffer_id);
  }

  // The first embed.
  base::test::TestFuture<viz::LocalSurfaceId, gfx::Size, double, double>
      embedded_;
  // Every LocalSurfaceId sent, in order. The producer submits to the last.
  std::vector<viz::LocalSurfaceId> told_;
  std::vector<uint64_t> released_;

 private:
  mojo::Receiver<mojom::SurfaceObserver> receiver_{this};
};

// Fake producer display observer.
class FakeDisplayListObserver : public mojom::DisplayListObserver {
 public:
  mojo::PendingRemote<mojom::DisplayListObserver> BindRemote() {
    return receiver_.BindNewPipeAndPassRemote();
  }

  // mojom::DisplayListObserver implementation.
  void OnDisplaysChanged(std::vector<mojom::DisplayPtr> displays) override {
    lists_.push_back(std::move(displays));
  }

  // Every list sent, in order. A list so tests can detect duplicates.
  std::vector<std::vector<mojom::DisplayPtr>> lists_;

 private:
  mojo::Receiver<mojom::DisplayListObserver> receiver_{this};
};

// Clipboard contents holding `text` alone, keyed as the producer sends text.
FrameSinkBroker::ClipboardContents Text(const std::string& text) {
  return {{"text/plain;charset=utf-8",
           std::vector<uint8_t>(text.begin(), text.end())}};
}

// Fake producer clipboard observer.
class FakeClipboardObserver : public mojom::ClipboardObserver {
 public:
  mojo::PendingRemote<mojom::ClipboardObserver> BindRemote() {
    return receiver_.BindNewPipeAndPassRemote();
  }

  // mojom::ClipboardObserver implementation.
  void OnCopied(mojom::Clipboard clipboard,
                const FrameSinkBroker::ClipboardContents& contents) override {
    copies_.emplace_back(clipboard, contents);
  }

  // Every copy sent, in order. A list so tests can detect duplicates.
  std::vector<std::pair<mojom::Clipboard, FrameSinkBroker::ClipboardContents>>
      copies_;

 private:
  mojo::Receiver<mojom::ClipboardObserver> receiver_{this};
};

// Fake producer compositing observer.
class FakeCompositingObserver : public mojom::CompositingObserver {
 public:
  mojo::PendingRemote<mojom::CompositingObserver> BindRemote() {
    return receiver_.BindNewPipeAndPassRemote();
  }

  // mojom::CompositingObserver implementation.
  void OnCompositingChanged(bool in_memory) override {
    modes_.push_back(in_memory);
  }

  // Every mode sent, in order. A list so tests can detect duplicates.
  std::vector<bool> modes_;

 private:
  mojo::Receiver<mojom::CompositingObserver> receiver_{this};
};

// Fake producer browser window list observer.
class FakeBrowserWindowListObserver : public mojom::BrowserWindowListObserver {
 public:
  mojo::PendingRemote<mojom::BrowserWindowListObserver> BindRemote() {
    return receiver_.BindNewPipeAndPassRemote();
  }

  // mojom::BrowserWindowListObserver implementation.
  void OnBrowserWindowsChanged(
      std::vector<mojom::ListedBrowserWindowPtr> windows) override {
    std::vector<std::string> titles;
    for (const mojom::ListedBrowserWindowPtr& window : windows) {
      titles.push_back(window->id + " " + window->title + " " + window->url +
                       (window->off_the_record ? " private" : ""));
    }
    lists_.push_back(std::move(titles));
  }

  // Every list sent, in order, each as "<id> <title>".
  std::vector<std::vector<std::string>> lists_;

 private:
  mojo::Receiver<mojom::BrowserWindowListObserver> receiver_{this};
};

// Fake producer input device list observer.
class FakeInputDeviceListObserver : public mojom::InputDeviceListObserver {
 public:
  mojo::PendingRemote<mojom::InputDeviceListObserver> BindRemote() {
    return receiver_.BindNewPipeAndPassRemote();
  }

  // mojom::InputDeviceListObserver implementation.
  void OnInputDevicesChanged(
      std::vector<mojom::ListedInputDevicePtr> devices) override {
    std::vector<std::string> names;
    for (const mojom::ListedInputDevicePtr& device : devices) {
      names.push_back(base::NumberToString(device->id) + " " + device->name);
    }
    lists_.push_back(std::move(names));
  }

  // Every list sent, in order, each as "<id> <name>".
  std::vector<std::vector<std::string>> lists_;

 private:
  mojo::Receiver<mojom::InputDeviceListObserver> receiver_{this};
};

// Fake producer display capture observer. These tests send no frames.
class FakeDisplayCaptureObserver : public mojom::DisplayCaptureObserver {
 public:
  mojo::PendingRemote<mojom::DisplayCaptureObserver> BindRemote() {
    return receiver_.BindNewPipeAndPassRemote();
  }

  // mojom::DisplayCaptureObserver implementation.
  void OnFrameCaptured(
      mojom::CapturedFramePtr frame,
      mojo::PendingRemote<mojom::CapturedFrameHold> hold) override {}

 private:
  mojo::Receiver<mojom::DisplayCaptureObserver> receiver_{this};
};

// One named 597x336mm panel on eDP-1 at the origin, at just under 60Hz.
//
// Every field is nonzero so tests catch a field dropped in transit.
std::vector<mojom::DisplayPtr> OneDisplay(int64_t id, const gfx::Size& size) {
  std::vector<mojom::DisplayPtr> displays;
  std::vector<mojom::DisplayModePtr> modes;
  modes.push_back(mojom::DisplayMode::New(size, 59997));
  displays.push_back(mojom::Display::New(id, gfx::Rect(size),
                                         gfx::Size(597, 336),
                                         "DEL DELL U3219Q 2ZLS413", 59997,
                                         "eDP-1", 4096, std::move(modes),
                                         mojom::AdaptiveSync::kOn,
                                         mojom::Hdr::kOn, 600.f, 350.f, 0.05f,
                                         240.f));
  return displays;
}

TEST(ForCaptureToolsTest, ListsShownWindowsWithTheViewsTheyHoldBottomFirst) {
  std::vector<mojom::ListedBrowserWindowPtr> listed = ForCaptureTools({
      ListedBrowserWindow{.id = "1",
                          .title = "Claude",
                          .app_title = "Claude",
                          .app_id = "claude-desktop"},
      ListedBrowserWindow{.id = "2",
                          .title = "Chat",
                          .view = true,
                          .parent = "1",
                          .x = 0,
                          .y = 40,
                          .width = 800,
                          .height = 560,
                          .stack = 1},
      ListedBrowserWindow{.id = "3",
                          .title = "Sidebar",
                          .view = true,
                          .parent = "1",
                          .width = 200,
                          .height = 600},
      // Neither a view no window shows, a view with no area nor a hidden
      // window is listed.
      ListedBrowserWindow{.id = "4", .view = true},
      ListedBrowserWindow{
          .id = "7", .view = true, .parent = "1", .width = 800, .height = 0},
      ListedBrowserWindow{.id = "5", .title = "Tray", .hidden = true},
      ListedBrowserWindow{.id = "6", .title = "Mail", .off_the_record = true},
  });

  ASSERT_EQ(listed.size(), 2u);
  EXPECT_EQ(listed[0]->id, "1");
  EXPECT_EQ(listed[0]->title, "Claude");
  ASSERT_EQ(listed[0]->views.size(), 2u);
  EXPECT_EQ(listed[0]->views[0],
            mojom::ListedBrowserView::New("3", 0, 0, 200, 600));
  EXPECT_EQ(listed[0]->views[1],
            mojom::ListedBrowserView::New("2", 0, 40, 800, 560));
  EXPECT_EQ(listed[1]->id, "6");
  EXPECT_TRUE(listed[1]->off_the_record);
  EXPECT_TRUE(listed[1]->views.empty());
}

TEST(ForCaptureToolsTest, AWindowIsTitledByItsAppOverItsPage) {
  std::vector<mojom::ListedBrowserWindowPtr> listed =
      ForCaptureTools({ListedBrowserWindow{
          .id = "1", .title = "claude.ai", .app_title = "Claude"}});

  ASSERT_EQ(listed.size(), 1u);
  EXPECT_EQ(listed[0]->title, "Claude");
}

}  // namespace

class FrameSinkBrokerTest : public testing::Test {
 public:
  FrameSinkBroker* broker() { return broker_.get(); }

  // Whether viz has a CompositorFrameSink for `frame_sink_id`.
  bool VizHasFrameSink(const viz::FrameSinkId& frame_sink_id) {
    return frame_sink_manager_->GetFrameSinkForId(frame_sink_id) != nullptr;
  }

  void RunUntilIdle() { base::RunLoop().RunUntilIdle(); }

  // Whether viz has `child` registered under `parent`. The hierarchy delivers
  // BeginFrames.
  bool VizHasHierarchy(const viz::FrameSinkId& parent,
                       const viz::FrameSinkId& child) {
    return frame_sink_manager_->GetChildrenByParent(parent).contains(child);
  }

  // Allocates a LocalSurfaceId as the embedding page does. The producer never
  // allocates one.
  viz::LocalSurfaceId AllocateLocalSurfaceId() {
    local_surface_id_allocator_.GenerateId();
    return local_surface_id_allocator_.GetCurrentLocalSurfaceId();
  }

  // Brokers a sink to `observer` and returns its id, leaving `sink` bound.
  viz::FrameSinkId BrokerASink(
      mojo::Remote<mojom::FrameSinkBroker>& remote,
      viz::MockCompositorFrameSinkClient& sink_client,
      mojo::Remote<viz::mojom::CompositorFrameSink>& sink,
      mojo::PendingRemote<mojom::SurfaceObserver> observer) {
    base::test::TestFuture<const viz::FrameSinkId&> future;
    remote->CreateFrameSink(
        sink_client.BindInterfaceRemote(), sink.BindNewPipeAndPassReceiver(),
        std::move(observer), kTestApp, future.GetCallback());
    return future.Get();
  }

  // Imports a buffer into `frame_sink_id` and returns its id and the mailbox
  // of its SharedImage.
  std::pair<uint64_t, gpu::Mailbox> ImportABuffer(
      mojo::Remote<mojom::FrameSinkBroker>& remote,
      const viz::FrameSinkId& frame_sink_id) {
    base::test::TestFuture<uint64_t, std::optional<gpu::ExportedSharedImage>>
        future;
    remote->ImportBuffer(frame_sink_id, ADmabuf(kBufferSize), kBufferSize,
                         kArgb8888, gfx::ColorSpace::CreateSRGB(),
                         future.GetCallback());
    auto [buffer_id, exported] = future.Take();
    CHECK_NE(buffer_id, 0u);
    CHECK(exported.has_value());
    return {buffer_id,
            gpu::ClientSharedImage::ImportUnowned(std::move(exported).value())
                ->mailbox()};
  }

  // Imports a dmabuf of `fourcc` into `frame_sink_id` and returns its
  // SharedImage, or nullptr if the import was refused.
  scoped_refptr<gpu::ClientSharedImage> ImportAs(
      mojo::Remote<mojom::FrameSinkBroker>& remote,
      const viz::FrameSinkId& frame_sink_id,
      uint32_t fourcc,
      const gfx::ColorSpace& color_space = gfx::ColorSpace::CreateSRGB()) {
    base::test::TestFuture<uint64_t, std::optional<gpu::ExportedSharedImage>>
        future;
    remote->ImportBuffer(frame_sink_id, ADmabuf(kBufferSize), kBufferSize,
                         fourcc, color_space, future.GetCallback());
    auto [buffer_id, exported] = future.Take();
    if (!exported.has_value()) {
      return nullptr;
    }
    return gpu::ClientSharedImage::ImportUnowned(std::move(exported).value());
  }

  // Imports `region` into `frame_sink_id` as an ARGB8888 window of
  // kBufferSize with rows `stride` apart.
  std::pair<uint64_t, std::optional<gpu::ExportedSharedImage>> ImportShm(
      mojo::Remote<mojom::FrameSinkBroker>& remote,
      const viz::FrameSinkId& frame_sink_id,
      base::UnsafeSharedMemoryRegion region,
      uint32_t stride) {
    gfx::GpuMemoryBufferHandle handle(std::move(region));
    handle.stride = stride;
    base::test::TestFuture<uint64_t, std::optional<gpu::ExportedSharedImage>>
        future;
    remote->ImportBuffer(frame_sink_id, std::move(handle), kBufferSize,
                         kArgb8888, gfx::ColorSpace::CreateSRGB(),
                         future.GetCallback());
    return future.Take();
  }

  // Brokers a sink the browser holds, as a producer with only dmabufs asks
  // for, and returns its id.
  viz::FrameSinkId BrokerABrowserHeldSink(
      mojo::Remote<mojom::FrameSinkBroker>& remote,
      mojo::PendingRemote<mojom::SurfaceObserver> observer) {
    base::test::TestFuture<const viz::FrameSinkId&> future;
    remote->CreateFrameSink(mojo::NullRemote(), mojo::NullReceiver(),
                            std::move(observer), kTestApp,
                            future.GetCallback());
    return future.Get();
  }

  // Sends BeginFrames to the page's frame sink and every sink under it, as the
  // page's display does. Ticks only when a test calls TestOnBeginFrame.
  viz::FakeExternalBeginFrameSource& DriveBeginFrames() {
    begin_frame_source_.emplace(/*refresh_rate=*/60.0,
                                /*tick_automatically=*/false);
    frame_sink_manager_->RegisterBeginFrameSource(&*begin_frame_source_,
                                                  kPageFrameSinkId);
    return *begin_frame_source_;
  }

 protected:
  void SetUp() override {
    host_frame_sink_manager_ = std::make_unique<viz::HostFrameSinkManager>();

    // The viz service side, in-process as in
    // embedded_frame_sink_provider_impl_unittest.cc.
    frame_sink_manager_ = std::make_unique<viz::FrameSinkManagerImpl>(
        viz::FrameSinkManagerImpl::InitParams());
    host_frame_sink_manager_->SetLocalManager(frame_sink_manager_.get());
    frame_sink_manager_->SetLocalClient(host_frame_sink_manager_.get());

    // The page's frame sink, the parent for the hierarchy. The browser
    // registers it in production.
    host_frame_sink_manager_->RegisterFrameSinkId(
        kPageFrameSinkId, &page_frame_sink_client_,
        viz::ReportFirstSurfaceActivation::kNo);

    broker_ = std::make_unique<FrameSinkBroker>(
        host_frame_sink_manager_.get(),
        base::BindRepeating(
            [](viz::FrameSinkIdAllocator* allocator) {
              return allocator->NextFrameSinkId();
            },
            &allocator_),
        base::BindRepeating(&FrameSinkBrokerTest::SharedImageInterface,
                            base::Unretained(this)),
        base::BindRepeating(&FrameSinkBrokerTest::RecordLayout,
                            base::Unretained(this)),
        base::BindRepeating(&FrameSinkBrokerTest::RecordClipboard,
                            base::Unretained(this)),
        base::BindRepeating(&FrameSinkBrokerTest::CaptureTarget),
        base::BindRepeating(&FrameSinkBrokerTest::BrowserWindowTarget,
                            base::Unretained(this)),
        base::BindRepeating(&FrameSinkBrokerTest::RecordPointers,
                            base::Unretained(this)),
        base::BindRepeating(&FrameSinkBrokerTest::SoftwareInterface,
                            base::Unretained(this)),
        FrameSinkBroker::VirtualDisplaysSetter(),
        base::BindRepeating(&FrameSinkBrokerTest::RecordGamma,
                            base::Unretained(this)),
        base::BindRepeating(&FrameSinkBrokerTest::RecordInput,
                            base::Unretained(this)),
        base::BindRepeating(&FrameSinkBrokerTest::RecordInputConfig,
                            base::Unretained(this)),
        base::BindRepeating(&FrameSinkBrokerTest::RecordRedraw,
                            base::Unretained(this)),
        base::BindRepeating(&FrameSinkBrokerTest::RecordColorMatrix,
                            base::Unretained(this)),
        FrameSinkBroker::DmabufCaptureChecker(),
        base::BindRepeating(&FrameSinkBrokerTest::SignalSyncToken,
                            base::Unretained(this)));
    page_ = broker_->NewEmbedRequester();
  }

  // Fake for the browser's windows: display 7's window is the page's.
  static std::optional<viz::FrameSinkId> CaptureTarget(int64_t display_id) {
    return display_id == 7 ? std::optional(kPageFrameSinkId) : std::nullopt;
  }

  // Fake for //chrome's browser windows: window "1" is open, drawn by the
  // page's frame sink. Counts the holds that keep it drawing.
  std::optional<BrowserWindowCaptureTarget> BrowserWindowTarget(
      const std::string& window_id) {
    std::optional<BrowserWindowCaptureTarget> target =
        window_id == "1" ? BrowserWindowCaptureTargetOf(
                               kPageFrameSinkId, gfx::Size(800, 600), 1.0f)
                         : std::nullopt;
    if (target.has_value()) {
      ++drawing_holds_;
      target->drawing = base::ScopedClosureRunner(base::BindOnce(
          [](int* holds) { --*holds; }, base::Unretained(&drawing_holds_)));
    }
    return target;
  }

  // Fake for aura::Env's GPU: none, as when headless, unless a test gives
  // the broker `sii_`. With one, a display capture takes its GPU path, which
  // these tests do not set up.
  gpu::SharedImageInterface* SharedImageInterface() { return gpu_; }

  // Gives the broker a GPU.
  void UseTheGpu() { gpu_ = sii_.get(); }

  // Fake for the browser's GPU channel: passes each token at once, unless a
  // test holds them.
  void SignalSyncToken(const gpu::SyncToken& sync_token,
                       base::OnceClosure done) {
    if (!hold_signals_) {
      std::move(done).Run();
      return;
    }
    held_signals_.emplace_back(sync_token, std::move(done));
  }

  // Makes the fake GPU channel hold each token until the test passes it.
  void HoldSignals() { hold_signals_ = true; }

  // Fake for the browser's software compositing: off, unless a test turns it
  // on.
  gpu::SharedImageInterface* SoftwareInterface() { return software_; }

  // Makes the browser composite in software.
  void CompositeInSoftware() { software_ = software_sii_.get(); }

  // Fake for the ozone platform that owns the CRTCs.
  void RecordLayout(std::vector<mojom::DisplayLayoutPtr> layout) {
    layouts_.push_back(std::move(layout));
  }

  // Fake for the ozone platform that owns the input devices.
  void RecordPointers(std::vector<mojom::PointerTargetPtr> targets) {
    pointers_.push_back(std::move(targets));
  }

  // Fake for the ozone platform that owns the CRTCs' gamma ramps.
  void RecordInputConfig(const std::string& config) {
    input_configs_.push_back(config);
  }

  void RecordInput(const mojom::DeskInput& input) {
    inputs_.push_back(input.Clone());
  }

  void RecordGamma(int64_t display_id, const mojom::GammaRamp& ramp) {
    gamma_.emplace_back(display_id, ramp.Clone());
  }

  // Fake for the browser's windows: each redraw, with how many ramps had been
  // set by then.
  void RecordRedraw(int64_t display_id) {
    redraws_.emplace_back(display_id, gamma_.size());
  }

  // Fake for the browser's windows' compositors.
  void RecordColorMatrix(int64_t display_id,
                         const FrameSinkBroker::ColorMatrix& matrix) {
    color_matrices_.emplace_back(display_id, matrix);
  }

  // Fake for the ozone platform that owns the clipboard.
  void RecordClipboard(mojom::Clipboard clipboard,
                       const FrameSinkBroker::ClipboardContents& contents) {
    clipboards_.emplace_back(clipboard, contents);
  }

  void TearDown() override {
    broker_.reset();
    RunUntilIdle();
    if (begin_frame_source_) {
      frame_sink_manager_->UnregisterBeginFrameSource(&*begin_frame_source_);
    }
    host_frame_sink_manager_->InvalidateFrameSinkId(
        kPageFrameSinkId, &page_frame_sink_client_, {});
    frame_sink_manager_->SetLocalClient(nullptr);
    host_frame_sink_manager_.reset();
    frame_sink_manager_.reset();
  }

  // Every layout the producer sent, in order.
  std::vector<std::vector<mojom::DisplayLayoutPtr>> layouts_;

  // Every list of pointer targets the producer sent, in order.
  std::vector<std::vector<mojom::PointerTargetPtr>> pointers_;

  // Every white point the producer sent, in order.
  std::vector<std::pair<int64_t, mojom::GammaRampPtr>> gamma_;
  // Every display redrawn, in order, with the count of ramps set before it.
  std::vector<std::pair<int64_t, size_t>> redraws_;
  // Every color matrix the producer set, in order.
  std::vector<std::pair<int64_t, FrameSinkBroker::ColorMatrix>>
      color_matrices_;
  std::vector<mojom::DeskInputPtr> inputs_;
  std::vector<std::string> input_configs_;

  // Every clipboard the producer sent, in order.
  std::vector<std::pair<mojom::Clipboard, FrameSinkBroker::ClipboardContents>>
      clipboards_;

  // How many browser window captures keep their page drawing.
  int drawing_holds_ = 0;

  // Set by HoldSignals. The tokens the broker waits on, in order, with what
  // runs once each passes.
  bool hold_signals_ = false;
  std::vector<std::pair<gpu::SyncToken, base::OnceClosure>> held_signals_;

  // Fake for the browser's frame sink id allocator.
  viz::FrameSinkIdAllocator allocator_{kBrowserClientId};
  viz::ParentLocalSurfaceIdAllocator local_surface_id_allocator_;
  viz::FakeHostFrameSinkClient page_frame_sink_client_;

  base::test::SingleThreadTaskEnvironment task_environment_;
  scoped_refptr<FenceRecordingSharedImageInterface> sii_ =
      base::MakeRefCounted<FenceRecordingSharedImageInterface>();
  raw_ptr<gpu::SharedImageInterface> gpu_ = nullptr;
  scoped_refptr<SoftwareSharedImageInterface> software_sii_ =
      base::MakeRefCounted<SoftwareSharedImageInterface>();
  raw_ptr<gpu::SharedImageInterface> software_ = nullptr;
  std::unique_ptr<viz::HostFrameSinkManager> host_frame_sink_manager_;
  std::unique_ptr<viz::FrameSinkManagerImpl> frame_sink_manager_;
  std::unique_ptr<FrameSinkBroker> broker_;
  // The page whose embeds tests send to the broker directly.
  uint64_t page_ = 0;
  // Set by DriveBeginFrames.
  std::optional<viz::FakeExternalBeginFrameSource> begin_frame_source_;
};

// A non-renderer caller gets an allocated FrameSinkId and a live
// CompositorFrameSink.
TEST_F(FrameSinkBrokerTest, BrokersASinkToACallerThatIsNotARenderer) {
  mojo::Remote<mojom::FrameSinkBroker> remote;
  broker()->Bind(remote.BindNewPipeAndPassReceiver());

  viz::MockCompositorFrameSinkClient sink_client;
  mojo::Remote<viz::mojom::CompositorFrameSink> sink;

  base::test::TestFuture<const viz::FrameSinkId&> future;
  remote->CreateFrameSink(sink_client.BindInterfaceRemote(),
                          sink.BindNewPipeAndPassReceiver(), mojo::NullRemote(),
                          "test-app", future.GetCallback());

  const viz::FrameSinkId frame_sink_id = future.Get();
  EXPECT_TRUE(frame_sink_id.is_valid());
  EXPECT_EQ(kBrowserClientId, frame_sink_id.client_id());

  RunUntilIdle();
  EXPECT_TRUE(VizHasFrameSink(frame_sink_id));
  EXPECT_TRUE(sink.is_connected());
}

// Ids come from the injected allocator, so they cannot collide with browser
// sinks.
TEST_F(FrameSinkBrokerTest, AllocatesADistinctIdPerSink) {
  mojo::Remote<mojom::FrameSinkBroker> remote;
  broker()->Bind(remote.BindNewPipeAndPassReceiver());

  viz::MockCompositorFrameSinkClient first_client;
  mojo::Remote<viz::mojom::CompositorFrameSink> first_sink;
  base::test::TestFuture<const viz::FrameSinkId&> first;
  remote->CreateFrameSink(first_client.BindInterfaceRemote(),
                          first_sink.BindNewPipeAndPassReceiver(),
                          mojo::NullRemote(), "test-app", first.GetCallback());

  viz::MockCompositorFrameSinkClient second_client;
  mojo::Remote<viz::mojom::CompositorFrameSink> second_sink;
  base::test::TestFuture<const viz::FrameSinkId&> second;
  remote->CreateFrameSink(second_client.BindInterfaceRemote(),
                          second_sink.BindNewPipeAndPassReceiver(),
                          mojo::NullRemote(), "test-app", second.GetCallback());

  EXPECT_NE(first.Get(), second.Get());

  // The browser's next id differs from both.
  const viz::FrameSinkId browser_own = allocator_.NextFrameSinkId();
  EXPECT_NE(first.Get(), browser_own);
  EXPECT_NE(second.Get(), browser_own);

  RunUntilIdle();
  EXPECT_TRUE(VizHasFrameSink(first.Get()));
  EXPECT_TRUE(VizHasFrameSink(second.Get()));
}

// DestroyFrameSink removes the sink from viz.
TEST_F(FrameSinkBrokerTest, DestroyFrameSinkRemovesTheSinkFromViz) {
  mojo::Remote<mojom::FrameSinkBroker> remote;
  broker()->Bind(remote.BindNewPipeAndPassReceiver());

  viz::MockCompositorFrameSinkClient sink_client;
  mojo::Remote<viz::mojom::CompositorFrameSink> sink;
  base::test::TestFuture<const viz::FrameSinkId&> future;
  remote->CreateFrameSink(sink_client.BindInterfaceRemote(),
                          sink.BindNewPipeAndPassReceiver(), mojo::NullRemote(),
                          "test-app", future.GetCallback());
  const viz::FrameSinkId frame_sink_id = future.Get();
  RunUntilIdle();
  ASSERT_TRUE(VizHasFrameSink(frame_sink_id));

  remote->DestroyFrameSink(frame_sink_id);
  RunUntilIdle();

  EXPECT_FALSE(VizHasFrameSink(frame_sink_id));
}

// A disconnect destroys all the producer's sinks. Nothing else unregisters
// their ids.
TEST_F(FrameSinkBrokerTest, DroppingTheConnectionDestroysEverySink) {
  auto remote = std::make_unique<mojo::Remote<mojom::FrameSinkBroker>>();
  broker()->Bind((*remote).BindNewPipeAndPassReceiver());

  viz::MockCompositorFrameSinkClient sink_client;
  mojo::Remote<viz::mojom::CompositorFrameSink> sink;
  base::test::TestFuture<const viz::FrameSinkId&> future;
  (*remote)->CreateFrameSink(
      sink_client.BindInterfaceRemote(), sink.BindNewPipeAndPassReceiver(),
      mojo::NullRemote(), "test-app", future.GetCallback());
  const viz::FrameSinkId frame_sink_id = future.Get();
  RunUntilIdle();
  ASSERT_TRUE(VizHasFrameSink(frame_sink_id));

  remote.reset();
  RunUntilIdle();

  EXPECT_FALSE(VizHasFrameSink(frame_sink_id));
}

// A producer that disconnects is said to have gone, after its sinks are, so the
// embedder can listen for the next one. See "A compositor restart" in
// docs/architecture/ENGINE-FORK.md.
TEST_F(FrameSinkBrokerTest, AProducerThatDisconnectsIsSaidToHaveGone) {
  base::test::TestFuture<void> gone;
  broker()->SetProducerGoneCallback(gone.GetRepeatingCallback());
  mojo::Remote<mojom::FrameSinkBroker> remote;
  broker()->Bind(remote.BindNewPipeAndPassReceiver());
  viz::MockCompositorFrameSinkClient sink_client;
  mojo::Remote<viz::mojom::CompositorFrameSink> sink;
  base::test::TestFuture<const viz::FrameSinkId&> future;
  remote->CreateFrameSink(sink_client.BindInterfaceRemote(),
                          sink.BindNewPipeAndPassReceiver(), mojo::NullRemote(),
                          "test-app", future.GetCallback());
  const viz::FrameSinkId frame_sink_id = future.Get();
  RunUntilIdle();
  EXPECT_FALSE(gone.IsReady());

  remote.reset();

  EXPECT_TRUE(gone.Wait());
  EXPECT_FALSE(VizHasFrameSink(frame_sink_id));
}

// The page supplies the LocalSurfaceId and gets back the FrameSinkId, as with
// RemoteFrame.
TEST_F(FrameSinkBrokerTest, EmbedAnswersWithTheBrokeredFrameSinkId) {
  mojo::Remote<mojom::FrameSinkBroker> remote;
  broker()->Bind(remote.BindNewPipeAndPassReceiver());

  viz::MockCompositorFrameSinkClient sink_client;
  mojo::Remote<viz::mojom::CompositorFrameSink> sink;
  const viz::FrameSinkId frame_sink_id =
      BrokerASink(remote, sink_client, sink, mojo::NullRemote());
  RunUntilIdle();

  base::test::TestFuture<const std::optional<viz::FrameSinkId>&> embedded;
  broker()->Embed(page_, kTestApp, kPageFrameSinkId, AllocateLocalSurfaceId(),
                  kEmbeddedSize, kEmbeddedScale, kEmbeddedZoom,
                  embedded.GetCallback());

  EXPECT_EQ(frame_sink_id, embedded.Get());
}

// An embed before its producer connects waits and is answered on connect.
TEST_F(FrameSinkBrokerTest, EmbedWaitsForAProducer) {
  mojo::Remote<mojom::FrameSinkBroker> remote;
  broker()->Bind(remote.BindNewPipeAndPassReceiver());

  base::test::TestFuture<const std::optional<viz::FrameSinkId>&> embedded;
  broker()->Embed(page_, kTestApp, kPageFrameSinkId, AllocateLocalSurfaceId(),
                  kEmbeddedSize, kEmbeddedScale, kEmbeddedZoom,
                  embedded.GetCallback());
  RunUntilIdle();
  EXPECT_FALSE(embedded.IsReady());

  viz::MockCompositorFrameSinkClient sink_client;
  mojo::Remote<viz::mojom::CompositorFrameSink> sink;
  const viz::FrameSinkId frame_sink_id =
      BrokerASink(remote, sink_client, sink, mojo::NullRemote());

  EXPECT_EQ(frame_sink_id, embedded.Get());
}

// A renderer embeds under its own frame sink through the provider.
TEST_F(FrameSinkBrokerTest, ARendererEmbedsUnderItsOwnFrameSink) {
  mojo::Remote<mojom::FrameSinkBroker> remote;
  broker()->Bind(remote.BindNewPipeAndPassReceiver());
  viz::MockCompositorFrameSinkClient sink_client;
  mojo::Remote<viz::mojom::CompositorFrameSink> sink;
  const viz::FrameSinkId frame_sink_id =
      BrokerASink(remote, sink_client, sink, mojo::NullRemote());

  ExternalSurfaceProvider provider(broker());
  mojo::Remote<mojom::ExternalSurfaceProvider> page;
  provider.Bind(page.BindNewPipeAndPassReceiver(),
                kPageFrameSinkId.client_id());

  base::test::TestFuture<const std::optional<viz::FrameSinkId>&> embedded;
  page->Embed(kTestApp, kPageFrameSinkId, AllocateLocalSurfaceId(),
              kEmbeddedSize, kEmbeddedScale, kEmbeddedZoom,
              embedded.GetCallback());

  EXPECT_EQ(frame_sink_id, embedded.Get());
}

// A renderer that names another renderer's frame sink is reported, as
// content::EmbeddedFrameSinkProviderImpl reports one.
TEST_F(FrameSinkBrokerTest, ARendererNamingAnotherRenderersFrameSinkIsBad) {
  ExternalSurfaceProvider provider(broker());
  mojo::Remote<mojom::ExternalSurfaceProvider> page;
  provider.Bind(page.BindNewPipeAndPassReceiver(),
                kPageFrameSinkId.client_id() + 1);

  mojo::test::BadMessageObserver bad_message;
  page->Embed(kTestApp, kPageFrameSinkId, AllocateLocalSurfaceId(),
              kEmbeddedSize, kEmbeddedScale, kEmbeddedZoom, base::DoNothing());

  // A substring: mojo prefixes the error when the message crossed processes.
  EXPECT_THAT(bad_message.WaitForBadMessage(),
              testing::HasSubstr("parent frame sink is not the renderer's"));
}

// A zoom that is not a positive number is reported: the compositor configures
// the client at the box over it.
TEST_F(FrameSinkBrokerTest, ARendererSendingANonsenseZoomIsBad) {
  ExternalSurfaceProvider provider(broker());
  mojo::Remote<mojom::ExternalSurfaceProvider> page;
  provider.Bind(page.BindNewPipeAndPassReceiver(),
                kPageFrameSinkId.client_id());

  mojo::test::BadMessageObserver bad_message;
  page->Embed(kTestApp, kPageFrameSinkId, AllocateLocalSurfaceId(),
              kEmbeddedSize, kEmbeddedScale, /*zoom=*/0, base::DoNothing());

  EXPECT_THAT(bad_message.WaitForBadMessage(),
              testing::HasSubstr("zoom is not a positive number"));
}

// A renderer hears when the producer of a surface it embeds disconnects, and
// hears nothing of another producer's. A restarted compositor reuses app ids,
// so the page must drop its embed token before it embeds again.
TEST_F(FrameSinkBrokerTest, ARendererHearsWhenItsProducerDisconnects) {
  mojo::Remote<mojom::FrameSinkBroker> lost_producer;
  broker()->Bind(lost_producer.BindNewPipeAndPassReceiver());
  viz::MockCompositorFrameSinkClient lost_client;
  mojo::Remote<viz::mojom::CompositorFrameSink> lost_sink;
  const viz::FrameSinkId lost_id =
      BrokerASink(lost_producer, lost_client, lost_sink, mojo::NullRemote());

  mojo::Remote<mojom::FrameSinkBroker> kept_producer;
  broker()->Bind(kept_producer.BindNewPipeAndPassReceiver());
  viz::MockCompositorFrameSinkClient kept_client;
  mojo::Remote<viz::mojom::CompositorFrameSink> kept_sink;
  const viz::FrameSinkId kept_id =
      BrokerASink(kept_producer, kept_client, kept_sink, mojo::NullRemote());

  ExternalSurfaceProvider provider(broker());
  mojo::Remote<mojom::ExternalSurfaceProvider> page;
  provider.Bind(page.BindNewPipeAndPassReceiver(),
                kPageFrameSinkId.client_id());
  base::test::TestFuture<mojom::FrameSinkEnd> lost;
  page->WaitForEnd(lost_id, lost.GetCallback());
  base::test::TestFuture<mojom::FrameSinkEnd> kept;
  page->WaitForEnd(kept_id, kept.GetCallback());
  RunUntilIdle();
  ASSERT_FALSE(lost.IsReady());

  lost_producer.reset();

  EXPECT_EQ(mojom::FrameSinkEnd::kProducerGone, lost.Get());
  RunUntilIdle();
  EXPECT_FALSE(kept.IsReady());
}

// A window closing ends its sink as closed, so the page does not embed it
// again and leave a request waiting for an app that never returns.
TEST_F(FrameSinkBrokerTest, DestroyingASinkEndsItAsClosed) {
  mojo::Remote<mojom::FrameSinkBroker> remote;
  broker()->Bind(remote.BindNewPipeAndPassReceiver());
  viz::MockCompositorFrameSinkClient sink_client;
  mojo::Remote<viz::mojom::CompositorFrameSink> sink;
  const viz::FrameSinkId frame_sink_id =
      BrokerASink(remote, sink_client, sink, mojo::NullRemote());

  base::test::TestFuture<mojom::FrameSinkEnd> ended;
  broker()->WaitForEnd(frame_sink_id, ended.GetCallback());
  ASSERT_FALSE(ended.IsReady());

  remote->DestroyFrameSink(frame_sink_id);

  EXPECT_EQ(mojom::FrameSinkEnd::kClosed, ended.Get());
}

// The producer can disconnect while the embed reply naming its sink is on the
// way, so a wait on a sink already lost that way is answered at once, and
// says so.
TEST_F(FrameSinkBrokerTest, WaitingOnASinkAlreadyDisconnectedSaysSo) {
  auto remote = std::make_unique<mojo::Remote<mojom::FrameSinkBroker>>();
  broker()->Bind(remote->BindNewPipeAndPassReceiver());
  viz::MockCompositorFrameSinkClient sink_client;
  mojo::Remote<viz::mojom::CompositorFrameSink> sink;
  const viz::FrameSinkId frame_sink_id =
      BrokerASink(*remote, sink_client, sink, mojo::NullRemote());
  remote.reset();
  RunUntilIdle();

  base::test::TestFuture<mojom::FrameSinkEnd> ended;
  broker()->WaitForEnd(frame_sink_id, ended.GetCallback());

  ASSERT_TRUE(ended.IsReady());
  EXPECT_EQ(mojom::FrameSinkEnd::kProducerGone, ended.Get());
}

// Any other sink not brokered, closed or never brokered, is answered at once
// as closed.
TEST_F(FrameSinkBrokerTest, WaitingOnASinkNeverBrokeredIsClosed) {
  base::test::TestFuture<mojom::FrameSinkEnd> ended;
  broker()->WaitForEnd(allocator_.NextFrameSinkId(), ended.GetCallback());

  ASSERT_TRUE(ended.IsReady());
  EXPECT_EQ(mojom::FrameSinkEnd::kClosed, ended.Get());
}

// An embed sent before the page heard of the disconnect carries the old embed
// token. Viz would refuse it on the new compositor's sink, so it is answered
// null and never reaches the new producer.
TEST_F(FrameSinkBrokerTest, AnEmbedWithATokenFromADisconnectedSinkIsRefused) {
  auto old_producer = std::make_unique<mojo::Remote<mojom::FrameSinkBroker>>();
  broker()->Bind(old_producer->BindNewPipeAndPassReceiver());
  viz::MockCompositorFrameSinkClient old_client;
  mojo::Remote<viz::mojom::CompositorFrameSink> old_sink;
  BrokerASink(*old_producer, old_client, old_sink, mojo::NullRemote());
  base::test::TestFuture<const std::optional<viz::FrameSinkId>&> first;
  broker()->Embed(page_, kTestApp, kPageFrameSinkId, AllocateLocalSurfaceId(),
                  kEmbeddedSize, kEmbeddedScale, kEmbeddedZoom,
                  first.GetCallback());
  ASSERT_TRUE(first.Get().has_value());
  old_producer.reset();
  RunUntilIdle();

  mojo::Remote<mojom::FrameSinkBroker> new_producer;
  broker()->Bind(new_producer.BindNewPipeAndPassReceiver());
  viz::MockCompositorFrameSinkClient new_client;
  mojo::Remote<viz::mojom::CompositorFrameSink> new_sink;
  FakeSurfaceObserver observer;
  BrokerASink(new_producer, new_client, new_sink, observer.BindRemote());

  // The same allocator, so the same embed token.
  base::test::TestFuture<const std::optional<viz::FrameSinkId>&> stale;
  broker()->Embed(page_, kTestApp, kPageFrameSinkId, AllocateLocalSurfaceId(),
                  kEmbeddedSize, kEmbeddedScale, kEmbeddedZoom,
                  stale.GetCallback());

  ASSERT_TRUE(stale.IsReady());
  EXPECT_EQ(std::nullopt, stale.Get());
  RunUntilIdle();
  EXPECT_TRUE(observer.told_.empty());
}

// Each <app> element gets the surface for its own app id.
TEST_F(FrameSinkBrokerTest, EachAppEmbedsItsOwnSurface) {
  mojo::Remote<mojom::FrameSinkBroker> remote;
  broker()->Bind(remote.BindNewPipeAndPassReceiver());

  viz::MockCompositorFrameSinkClient terminal_client;
  mojo::Remote<viz::mojom::CompositorFrameSink> terminal_sink;
  base::test::TestFuture<const viz::FrameSinkId&> terminal;
  remote->CreateFrameSink(terminal_client.BindInterfaceRemote(),
                          terminal_sink.BindNewPipeAndPassReceiver(),
                          mojo::NullRemote(), "terminal",
                          terminal.GetCallback());

  viz::MockCompositorFrameSinkClient editor_client;
  mojo::Remote<viz::mojom::CompositorFrameSink> editor_sink;
  base::test::TestFuture<const viz::FrameSinkId&> editor;
  remote->CreateFrameSink(editor_client.BindInterfaceRemote(),
                          editor_sink.BindNewPipeAndPassReceiver(),
                          mojo::NullRemote(), "editor", editor.GetCallback());
  RunUntilIdle();

  base::test::TestFuture<const std::optional<viz::FrameSinkId>&> for_terminal;
  broker()->Embed(page_, "terminal", kPageFrameSinkId, AllocateLocalSurfaceId(),
                  kEmbeddedSize, kEmbeddedScale, kEmbeddedZoom,
                  for_terminal.GetCallback());
  base::test::TestFuture<const std::optional<viz::FrameSinkId>&> for_editor;
  broker()->Embed(page_, "editor", kPageFrameSinkId, AllocateLocalSurfaceId(),
                  kEmbeddedSize, kEmbeddedScale, kEmbeddedZoom,
                  for_editor.GetCallback());

  EXPECT_EQ(terminal.Get(), for_terminal.Get());
  EXPECT_EQ(editor.Get(), for_editor.Get());
  // The assertions above would also pass if both ids were equal.
  EXPECT_NE(for_terminal.Get(), for_editor.Get());
}

// A waiting embed is answered only by its own app's producer. On shell reload,
// several embeds wait while producers reconnect one at a time.
TEST_F(FrameSinkBrokerTest, AWaitingEmbedTakesOnlyItsOwnApp) {
  mojo::Remote<mojom::FrameSinkBroker> remote;
  broker()->Bind(remote.BindNewPipeAndPassReceiver());

  base::test::TestFuture<const std::optional<viz::FrameSinkId>&> for_editor;
  broker()->Embed(page_, "editor", kPageFrameSinkId, AllocateLocalSurfaceId(),
                  kEmbeddedSize, kEmbeddedScale, kEmbeddedZoom,
                  for_editor.GetCallback());
  RunUntilIdle();

  // The terminal connects first. The editor's element is still waiting.
  viz::MockCompositorFrameSinkClient terminal_client;
  mojo::Remote<viz::mojom::CompositorFrameSink> terminal_sink;
  base::test::TestFuture<const viz::FrameSinkId&> terminal;
  remote->CreateFrameSink(terminal_client.BindInterfaceRemote(),
                          terminal_sink.BindNewPipeAndPassReceiver(),
                          mojo::NullRemote(), "terminal",
                          terminal.GetCallback());
  RunUntilIdle();
  EXPECT_FALSE(for_editor.IsReady())
      << "the editor's element was handed the terminal's surface";

  viz::MockCompositorFrameSinkClient editor_client;
  mojo::Remote<viz::mojom::CompositorFrameSink> editor_sink;
  base::test::TestFuture<const viz::FrameSinkId&> editor;
  remote->CreateFrameSink(editor_client.BindInterfaceRemote(),
                          editor_sink.BindNewPipeAndPassReceiver(),
                          mojo::NullRemote(), "editor", editor.GetCallback());

  EXPECT_EQ(editor.Get(), for_editor.Get());
}

// A waiting embed is dropped when its page disconnects, as when the renderer
// goes away. Its app may never connect, and if it does, the embed must not
// reach the producer. Another page's embed of the same app still waits.
TEST_F(FrameSinkBrokerTest, AWaitingEmbedIsDroppedWithItsPage) {
  ExternalSurfaceProvider provider(broker());
  mojo::Remote<mojom::ExternalSurfaceProvider> gone_page;
  provider.Bind(gone_page.BindNewPipeAndPassReceiver(),
                kPageFrameSinkId.client_id());
  mojo::Remote<mojom::ExternalSurfaceProvider> kept_page;
  provider.Bind(kept_page.BindNewPipeAndPassReceiver(),
                kPageFrameSinkId.client_id());

  gone_page->Embed(kTestApp, kPageFrameSinkId, AllocateLocalSurfaceId(),
                   kEmbeddedSize, kEmbeddedScale, kEmbeddedZoom,
                   base::DoNothing());
  const viz::LocalSurfaceId kept_surface = AllocateLocalSurfaceId();
  base::test::TestFuture<const std::optional<viz::FrameSinkId>&> kept;
  kept_page->Embed(kTestApp, kPageFrameSinkId, kept_surface, kEmbeddedSize,
                   kEmbeddedScale, kEmbeddedZoom, kept.GetCallback());
  RunUntilIdle();
  gone_page.reset();
  RunUntilIdle();

  mojo::Remote<mojom::FrameSinkBroker> remote;
  broker()->Bind(remote.BindNewPipeAndPassReceiver());
  viz::MockCompositorFrameSinkClient sink_client;
  mojo::Remote<viz::mojom::CompositorFrameSink> sink;
  FakeSurfaceObserver observer;
  const viz::FrameSinkId frame_sink_id =
      BrokerASink(remote, sink_client, sink, observer.BindRemote());

  EXPECT_EQ(frame_sink_id, kept.Get());
  RunUntilIdle();
  EXPECT_THAT(observer.told_, testing::ElementsAre(kept_surface));
}

// The producer learns the embedder's LocalSurfaceId, since only the embedder
// can mint its embed_token.
TEST_F(FrameSinkBrokerTest, EmbedTellsTheProducerWhichSurfaceToSubmitTo) {
  mojo::Remote<mojom::FrameSinkBroker> remote;
  broker()->Bind(remote.BindNewPipeAndPassReceiver());

  FakeSurfaceObserver observer;
  viz::MockCompositorFrameSinkClient sink_client;
  mojo::Remote<viz::mojom::CompositorFrameSink> sink;
  BrokerASink(remote, sink_client, sink, observer.BindRemote());
  RunUntilIdle();

  const viz::LocalSurfaceId local_surface_id = AllocateLocalSurfaceId();
  base::test::TestFuture<const std::optional<viz::FrameSinkId>&> embedded;
  broker()->Embed(page_, kTestApp, kPageFrameSinkId, local_surface_id,
                  kEmbeddedSize, kEmbeddedScale, kEmbeddedZoom,
                  embedded.GetCallback());

  EXPECT_EQ(local_surface_id, observer.embedded_.Get<viz::LocalSurfaceId>());
  EXPECT_EQ(kEmbeddedSize, observer.embedded_.Get<gfx::Size>());
  // Each monitor's page has its own scale, and each element its own zoom.
  EXPECT_EQ(kEmbeddedScale, observer.embedded_.Get<2>());
  EXPECT_EQ(kEmbeddedZoom, observer.embedded_.Get<3>());
}

// Two <app> elements showing one window share its allocator but use separate
// pipes, so an older LocalSurfaceId can arrive late. Submitting to it would
// make viz close the sink, and the window would stop drawing.
TEST_F(FrameSinkBrokerTest, AnOlderSurfaceArrivingLateIsNotPassedOn) {
  mojo::Remote<mojom::FrameSinkBroker> remote;
  broker()->Bind(remote.BindNewPipeAndPassReceiver());

  FakeSurfaceObserver observer;
  testing::NiceMock<viz::MockCompositorFrameSinkClient> sink_client;
  mojo::Remote<viz::mojom::CompositorFrameSink> sink;
  BrokerASink(remote, sink_client, sink, observer.BindRemote());
  RunUntilIdle();

  const viz::LocalSurfaceId older = AllocateLocalSurfaceId();
  const viz::LocalSurfaceId newer = AllocateLocalSurfaceId();

  base::test::TestFuture<const std::optional<viz::FrameSinkId>&> for_newer;
  broker()->Embed(page_, kTestApp, kPageFrameSinkId, newer, kEmbeddedSize,
                  kEmbeddedScale, kEmbeddedZoom, for_newer.GetCallback());
  ASSERT_TRUE(for_newer.Wait());
  RunUntilIdle();
  sink->SubmitCompositorFrame(observer.told_.back(),
                              viz::MakeDefaultCompositorFrame(), std::nullopt,
                              0);

  // The late embed is still answered: the element needs a FrameSinkId.
  base::test::TestFuture<const std::optional<viz::FrameSinkId>&> for_older;
  broker()->Embed(page_, kTestApp, kPageFrameSinkId, older, kEmbeddedSize,
                  kEmbeddedScale, kEmbeddedZoom, for_older.GetCallback());
  ASSERT_TRUE(for_older.Wait());
  RunUntilIdle();
  sink->SubmitCompositorFrame(observer.told_.back(),
                              viz::MakeDefaultCompositorFrame(), std::nullopt,
                              0);
  RunUntilIdle();

  EXPECT_EQ(newer, observer.told_.back());
  EXPECT_TRUE(sink.is_connected());
}

// Embedding registers the producer under the page so BeginFrames arrive.
// Before an embed, there is no parent.
TEST_F(FrameSinkBrokerTest, EmbedRegistersTheHierarchyUnderThePage) {
  mojo::Remote<mojom::FrameSinkBroker> remote;
  broker()->Bind(remote.BindNewPipeAndPassReceiver());

  viz::MockCompositorFrameSinkClient sink_client;
  mojo::Remote<viz::mojom::CompositorFrameSink> sink;
  const viz::FrameSinkId frame_sink_id =
      BrokerASink(remote, sink_client, sink, mojo::NullRemote());
  RunUntilIdle();
  ASSERT_FALSE(VizHasHierarchy(kPageFrameSinkId, frame_sink_id));

  base::test::TestFuture<const std::optional<viz::FrameSinkId>&> embedded;
  broker()->Embed(page_, kTestApp, kPageFrameSinkId, AllocateLocalSurfaceId(),
                  kEmbeddedSize, kEmbeddedScale, kEmbeddedZoom,
                  embedded.GetCallback());
  ASSERT_TRUE(embedded.Wait());
  RunUntilIdle();

  EXPECT_TRUE(VizHasHierarchy(kPageFrameSinkId, frame_sink_id));
}

// An embedded window asks viz for no BeginFrames. Its producer submits when
// its client commits, so a BeginFrame every vsync would only wake it.
TEST_F(FrameSinkBrokerTest, AnEmbeddedWindowAsksForNoBeginFrames) {
  viz::FakeExternalBeginFrameSource& begin_frames = DriveBeginFrames();
  mojo::Remote<mojom::FrameSinkBroker> remote;
  broker()->Bind(remote.BindNewPipeAndPassReceiver());
  FakeSurfaceObserver observer;
  BrokerABrowserHeldSink(remote, observer.BindRemote());

  base::test::TestFuture<const std::optional<viz::FrameSinkId>&> embedded;
  broker()->Embed(page_, kTestApp, kPageFrameSinkId, AllocateLocalSurfaceId(),
                  kEmbeddedSize, kEmbeddedScale, kEmbeddedZoom,
                  embedded.GetCallback());
  ASSERT_TRUE(embedded.Wait());
  RunUntilIdle();

  EXPECT_EQ(0u, begin_frames.num_observers());
}

// A BeginFrame viz sends anyway, such as the one carrying a frame's
// presentation timing, is answered with DidNotProduceFrame. Unanswered, viz
// expects damage from the surface and the display waits for the window until
// each frame's deadline.
TEST_F(FrameSinkBrokerTest, ABeginFrameWithNothingToDrawIsAnswered) {
  viz::FakeExternalBeginFrameSource& begin_frames = DriveBeginFrames();
  mojo::Remote<mojom::FrameSinkBroker> remote;
  broker()->Bind(remote.BindNewPipeAndPassReceiver());
  FakeSurfaceObserver observer;
  const viz::FrameSinkId frame_sink_id =
      BrokerABrowserHeldSink(remote, observer.BindRemote());
  base::test::TestFuture<const std::optional<viz::FrameSinkId>&> embedded;
  broker()->Embed(page_, kTestApp, kPageFrameSinkId, AllocateLocalSurfaceId(),
                  kEmbeddedSize, kEmbeddedScale, kEmbeddedZoom,
                  embedded.GetCallback());
  ASSERT_TRUE(embedded.Wait());
  RunUntilIdle();

  // Viz wanting to send one. With no active surface, the sink forwards it to
  // its client rather than finishing it itself.
  frame_sink_manager_->GetFrameSinkForId(frame_sink_id)
      ->SetNeedsBeginFrame(true);
  ASSERT_EQ(1u, begin_frames.num_observers());
  begin_frames.TestOnBeginFrame(
      begin_frames.CreateBeginFrameArgs(BEGINFRAME_FROM_HERE));
  RunUntilIdle();

  EXPECT_TRUE(begin_frames.AllFramesDidFinish());
}

// A window the page does not draw still submits now and then, and each frame
// goes undrawn. Throttled for that, viz would hold back the BeginFrames that
// carry the frames' failed presentation timing, and the sink would observe the
// BeginFrameSource for good: the display would tick at its refresh rate for a
// window nobody sees.
TEST_F(FrameSinkBrokerTest, AnUndrawnWindowsFramesMayNotBeThrottled) {
  UseTheGpu();
  mojo::Remote<mojom::FrameSinkBroker> remote;
  broker()->Bind(remote.BindNewPipeAndPassReceiver());
  FakeSurfaceObserver observer;
  const viz::FrameSinkId frame_sink_id =
      BrokerABrowserHeldSink(remote, observer.BindRemote());
  const viz::LocalSurfaceId local_surface_id = AllocateLocalSurfaceId();
  base::test::TestFuture<const std::optional<viz::FrameSinkId>&> embedded;
  broker()->Embed(page_, kTestApp, kPageFrameSinkId, local_surface_id,
                  kEmbeddedSize, kEmbeddedScale, kEmbeddedZoom,
                  embedded.GetCallback());
  ASSERT_TRUE(embedded.Wait());
  const auto [buffer_id, mailbox] = ImportABuffer(remote, frame_sink_id);

  remote->SubmitBuffer(frame_sink_id, buffer_id, gfx::Rect());
  RunUntilIdle();

  viz::Surface* surface =
      frame_sink_manager_->surface_manager()->GetSurfaceForId(
          viz::SurfaceId(frame_sink_id, local_surface_id));
  ASSERT_TRUE(surface);
  ASSERT_TRUE(surface->HasActiveFrame());
  EXPECT_FALSE(
      surface->GetActiveFrameMetadata().may_throttle_if_undrawn_frames);
}

// Destroying a sink also unregisters it from the hierarchy.
TEST_F(FrameSinkBrokerTest, DestroyingTheSinkUnregistersTheHierarchy) {
  mojo::Remote<mojom::FrameSinkBroker> remote;
  broker()->Bind(remote.BindNewPipeAndPassReceiver());

  viz::MockCompositorFrameSinkClient sink_client;
  mojo::Remote<viz::mojom::CompositorFrameSink> sink;
  const viz::FrameSinkId frame_sink_id =
      BrokerASink(remote, sink_client, sink, mojo::NullRemote());
  base::test::TestFuture<const std::optional<viz::FrameSinkId>&> embedded;
  broker()->Embed(page_, kTestApp, kPageFrameSinkId, AllocateLocalSurfaceId(),
                  kEmbeddedSize, kEmbeddedScale, kEmbeddedZoom,
                  embedded.GetCallback());
  ASSERT_TRUE(embedded.Wait());
  RunUntilIdle();
  ASSERT_TRUE(VizHasHierarchy(kPageFrameSinkId, frame_sink_id));

  remote->DestroyFrameSink(frame_sink_id);
  RunUntilIdle();

  EXPECT_FALSE(VizHasHierarchy(kPageFrameSinkId, frame_sink_id));
}

// A window's subsurface is drawn in the window's own frames: the producer
// embeds its sink under the window's, so it learns its surface and gets
// BeginFrames, as a window embedded by a page does.
TEST_F(FrameSinkBrokerTest, AProducerEmbedsOneOfItsSinksInAnother) {
  mojo::Remote<mojom::FrameSinkBroker> remote;
  broker()->Bind(remote.BindNewPipeAndPassReceiver());

  testing::NiceMock<viz::MockCompositorFrameSinkClient> window_client;
  mojo::Remote<viz::mojom::CompositorFrameSink> window_sink;
  const viz::FrameSinkId window =
      BrokerASink(remote, window_client, window_sink, mojo::NullRemote());
  FakeSurfaceObserver observer;
  testing::NiceMock<viz::MockCompositorFrameSinkClient> child_client;
  mojo::Remote<viz::mojom::CompositorFrameSink> child_sink;
  const viz::FrameSinkId child =
      BrokerASink(remote, child_client, child_sink, observer.BindRemote());

  const viz::LocalSurfaceId local_surface_id = AllocateLocalSurfaceId();
  remote->EmbedFrameSink(child, window, local_surface_id, kEmbeddedSize,
                         kEmbeddedScale);

  EXPECT_EQ(local_surface_id, observer.embedded_.Get<viz::LocalSurfaceId>());
  EXPECT_EQ(kEmbeddedSize, observer.embedded_.Get<gfx::Size>());
  // The scale given already carries the window's zoom.
  EXPECT_EQ(1.0, observer.embedded_.Get<3>());
  RunUntilIdle();
  EXPECT_TRUE(VizHasHierarchy(window, child));
}

TEST_F(FrameSinkBrokerTest, EmbeddingInASinkNeverBrokeredIsABadMessage) {
  mojo::Remote<mojom::FrameSinkBroker> remote;
  broker()->Bind(remote.BindNewPipeAndPassReceiver());
  testing::NiceMock<viz::MockCompositorFrameSinkClient> sink_client;
  mojo::Remote<viz::mojom::CompositorFrameSink> sink;
  const viz::FrameSinkId child =
      BrokerASink(remote, sink_client, sink, mojo::NullRemote());
  mojo::test::BadMessageObserver bad_message;

  remote->EmbedFrameSink(child, kPageFrameSinkId, AllocateLocalSurfaceId(),
                         kEmbeddedSize, kEmbeddedScale);

  EXPECT_THAT(bad_message.WaitForBadMessage(),
              testing::HasSubstr("No brokered frame sink"));
}

TEST_F(FrameSinkBrokerTest, AnObserverIsToldTheDisplaysAlreadyRead) {
  // On a tty the browser reads displays before the compositor connects.
  // Without this, the compositor would wait for a hotplug.
  broker()->OnDisplaysChanged(OneDisplay(7, gfx::Size(2880, 1920)));

  mojo::Remote<mojom::FrameSinkBroker> remote;
  broker()->Bind(remote.BindNewPipeAndPassReceiver());
  FakeDisplayListObserver observer;
  remote->ObserveDisplays(observer.BindRemote());
  RunUntilIdle();

  ASSERT_EQ(observer.lists_.size(), 1u);
  ASSERT_EQ(observer.lists_[0].size(), 1u);
  EXPECT_EQ(observer.lists_[0][0]->id, 7);
  EXPECT_EQ(observer.lists_[0][0]->bounds, gfx::Rect(2880, 1920));
  EXPECT_EQ(observer.lists_[0][0]->physical_size_mm, gfx::Size(597, 336));
  EXPECT_EQ(observer.lists_[0][0]->name, "DEL DELL U3219Q 2ZLS413");
  EXPECT_EQ(observer.lists_[0][0]->refresh_mhz, 59997);
  EXPECT_EQ(observer.lists_[0][0]->connector, "eDP-1");
  EXPECT_EQ(observer.lists_[0][0]->gamma_size, 4096u);
  ASSERT_EQ(observer.lists_[0][0]->modes.size(), 1u);
  EXPECT_EQ(observer.lists_[0][0]->modes[0]->refresh_mhz, 59997);
  EXPECT_EQ(observer.lists_[0][0]->adaptive_sync, mojom::AdaptiveSync::kOn);
  EXPECT_EQ(observer.lists_[0][0]->hdr, mojom::Hdr::kOn);
  EXPECT_FLOAT_EQ(observer.lists_[0][0]->max_luminance, 600.f);
  EXPECT_FLOAT_EQ(observer.lists_[0][0]->max_average_luminance, 350.f);
  EXPECT_FLOAT_EQ(observer.lists_[0][0]->min_luminance, 0.05f);
  EXPECT_FLOAT_EQ(observer.lists_[0][0]->sdr_white_nits, 240.f);
}

TEST_F(FrameSinkBrokerTest, AProducerSaysWhichConnectorsToLight) {
  // The browser reads displays from DRM; only the producer has the config
  // that says how to lay them out.
  mojo::Remote<mojom::FrameSinkBroker> remote;
  broker()->Bind(remote.BindNewPipeAndPassReceiver());

  std::vector<mojom::DisplayLayoutPtr> layout;
  layout.push_back(mojom::DisplayLayout::New(
      7, true, gfx::Point(1920, 0), mojom::DisplayTransform::kRotate270, 1.2,
      gfx::Rect(1920, 0, 1800, 3200), gfx::Size(3840, 2160), 120000, true,
      true, 240.f));
  layout.push_back(mojom::DisplayLayout::New(
      9, false, gfx::Point(), mojom::DisplayTransform::kNormal, 1.0,
      gfx::Rect(), std::nullopt, 0, false, false, 203.f));
  remote->ConfigureDisplays(std::move(layout));
  RunUntilIdle();

  ASSERT_EQ(layouts_.size(), 1u);
  ASSERT_EQ(layouts_[0].size(), 2u);
  EXPECT_EQ(layouts_[0][0]->id, 7);
  EXPECT_TRUE(layouts_[0][0]->enabled);
  EXPECT_EQ(layouts_[0][0]->origin, gfx::Point(1920, 0));
  // The rotation and scale the window is drawn at.
  EXPECT_EQ(layouts_[0][0]->transform, mojom::DisplayTransform::kRotate270);
  EXPECT_EQ(layouts_[0][0]->scale, 1.2);
  // The position in the desk layout, used for pointer movement.
  EXPECT_EQ(layouts_[0][0]->desk, gfx::Rect(1920, 0, 1800, 3200));
  // The mode and rate the profile asks for.
  EXPECT_EQ(layouts_[0][0]->mode, gfx::Size(3840, 2160));
  EXPECT_EQ(layouts_[0][0]->refresh_mhz, 120000);
  EXPECT_TRUE(layouts_[0][0]->adaptive_sync);
  EXPECT_TRUE(layouts_[0][0]->hdr);
  EXPECT_FLOAT_EQ(layouts_[0][0]->sdr_white_nits, 240.f);
  EXPECT_EQ(layouts_[0][1]->id, 9);
  EXPECT_FALSE(layouts_[0][1]->enabled);
  EXPECT_FALSE(layouts_[0][1]->mode.has_value());
}

TEST_F(FrameSinkBrokerTest, AProducerWithNoOpinionSaysSoRatherThanNothing) {
  // An empty layout means "no profile matched" and must be forwarded: it
  // restores panels that a previous profile turned off.
  mojo::Remote<mojom::FrameSinkBroker> remote;
  broker()->Bind(remote.BindNewPipeAndPassReceiver());

  remote->ConfigureDisplays({});
  RunUntilIdle();

  ASSERT_EQ(layouts_.size(), 1u);
  EXPECT_TRUE(layouts_[0].empty());
}

TEST_F(FrameSinkBrokerTest, AnEmbedderWithNoCrtcDropsTheLayout) {
  // Outside a tty there are no connectors. The producer cannot tell, so it
  // sends a layout anyway.
  FrameSinkBroker unwired(host_frame_sink_manager_.get(),
                          base::BindRepeating(
                              [](viz::FrameSinkIdAllocator* allocator) {
                                return allocator->NextFrameSinkId();
                              },
                              &allocator_));
  mojo::Remote<mojom::FrameSinkBroker> remote;
  unwired.Bind(remote.BindNewPipeAndPassReceiver());

  std::vector<mojom::DisplayLayoutPtr> layout;
  layout.push_back(mojom::DisplayLayout::New(
      7, true, gfx::Point(), mojom::DisplayTransform::kNormal, 1.0,
      gfx::Rect(), std::nullopt, 0, false, false, 203.f));
  remote->ConfigureDisplays(std::move(layout));
  RunUntilIdle();

  EXPECT_TRUE(layouts_.empty()) << "the fixture's own broker heard nothing";
}

TEST_F(FrameSinkBrokerTest, AProducerSaysWhichDisplayEachTabletCovers) {
  mojo::Remote<mojom::FrameSinkBroker> remote;
  broker()->Bind(remote.BindNewPipeAndPassReceiver());

  std::vector<mojom::PointerTargetPtr> targets;
  targets.push_back(
      mojom::PointerTarget::New("usb-0000:00:04.0-1/input0", 7));
  remote->ConfigurePointers(std::move(targets));
  RunUntilIdle();

  ASSERT_EQ(pointers_.size(), 1u);
  ASSERT_EQ(pointers_[0].size(), 1u);
  EXPECT_EQ(pointers_[0][0]->device, "usb-0000:00:04.0-1/input0");
  EXPECT_EQ(pointers_[0][0]->display_id, 7);
}

TEST_F(FrameSinkBrokerTest,
       InputSettingsCrossMojoWithoutChangingTheConfiguration) {
  mojo::Remote<mojom::FrameSinkBroker> remote;
  broker()->Bind(remote.BindNewPipeAndPassReceiver());
  const std::string config = R"({"touchpad":{"click_method":"clickfinger"}})";
  remote->ConfigureInput(config);
  remote->ConfigureInput("{}");
  RunUntilIdle();
  EXPECT_EQ(input_configs_, (std::vector<std::string>{config, "{}"}));
}

TEST_F(FrameSinkBrokerTest, AProducerSetsADisplaysGamma) {
  // A night light or a gamma-control client: only the producer knows what
  // each display should draw with, and only the browser holds the CRTCs.
  mojo::Remote<mojom::FrameSinkBroker> remote;
  broker()->Bind(remote.BindNewPipeAndPassReceiver());

  remote->SetGamma(7, mojom::GammaRamp::New(std::vector<uint16_t>{0, 65535},
                                            std::vector<uint16_t>{0, 32768},
                                            std::vector<uint16_t>{0, 16384}));
  RunUntilIdle();

  ASSERT_EQ(gamma_.size(), 1u);
  EXPECT_EQ(gamma_[0].first, 7);
  EXPECT_EQ(gamma_[0].second->green, (std::vector<uint16_t>{0, 32768}));
}

TEST_F(FrameSinkBrokerTest, ARampWhoseChannelsDifferIsABadMessage) {
  mojo::Remote<mojom::FrameSinkBroker> remote;
  broker()->Bind(remote.BindNewPipeAndPassReceiver());

  mojo::test::BadMessageObserver bad_message;
  remote->SetGamma(7, mojom::GammaRamp::New(std::vector<uint16_t>{0, 65535},
                                            std::vector<uint16_t>{0},
                                            std::vector<uint16_t>{0, 16384}));

  // A substring, as above.
  EXPECT_THAT(bad_message.WaitForBadMessage(),
              testing::HasSubstr("channels differ in length"));
  EXPECT_TRUE(gamma_.empty());
  EXPECT_TRUE(redraws_.empty());
}

TEST_F(FrameSinkBrokerTest, ARampRedrawsItsDisplayOnceItIsSet) {
  // A lit CRTC takes a ramp with its next page flip. On a still screen there
  // would be none until something changed, so the night light would wait.
  mojo::Remote<mojom::FrameSinkBroker> remote;
  broker()->Bind(remote.BindNewPipeAndPassReceiver());

  remote->SetGamma(7, mojom::GammaRamp::New(std::vector<uint16_t>{0, 65535},
                                            std::vector<uint16_t>{0, 32768},
                                            std::vector<uint16_t>{0, 16384}));
  RunUntilIdle();

  // After the ramp, so the frame it asks for carries it.
  EXPECT_EQ(redraws_, (std::vector<std::pair<int64_t, size_t>>{{7, 1u}}));
}

TEST_F(FrameSinkBrokerTest, AProducersColorMatrixReachesItsDisplay) {
  // A night light on a display driven in HDR: less blue and green, in linear
  // light.
  mojo::Remote<mojom::FrameSinkBroker> remote;
  broker()->Bind(remote.BindNewPipeAndPassReceiver());

  remote->SetColorMatrix(7, {1, 0, 0, 0, 0.8f, 0, 0, 0, 0.5f});
  RunUntilIdle();

  ASSERT_EQ(color_matrices_.size(), 1u);
  EXPECT_EQ(color_matrices_[0].first, 7);
  EXPECT_EQ(color_matrices_[0].second,
            (FrameSinkBroker::ColorMatrix{1, 0, 0, 0, 0.8f, 0, 0, 0, 0.5f}));
}

TEST_F(FrameSinkBrokerTest, AColorMatrixOfTheWrongSizeIsABadMessage) {
  mojo::Remote<mojom::FrameSinkBroker> remote;
  broker()->Bind(remote.BindNewPipeAndPassReceiver());

  mojo::test::BadMessageObserver bad_message;
  remote->SetColorMatrix(7, {1, 0, 0, 0, 1, 0, 0, 0});

  EXPECT_THAT(bad_message.WaitForBadMessage(),
              testing::HasSubstr("nine finite numbers"));
  EXPECT_TRUE(color_matrices_.empty());
}

TEST_F(FrameSinkBrokerTest, AColorMatrixThatIsNotFiniteIsABadMessage) {
  mojo::Remote<mojom::FrameSinkBroker> remote;
  broker()->Bind(remote.BindNewPipeAndPassReceiver());

  mojo::test::BadMessageObserver bad_message;
  remote->SetColorMatrix(
      7, {1, 0, 0, 0, std::numeric_limits<float>::quiet_NaN(), 0, 0, 0, 1});

  EXPECT_THAT(bad_message.WaitForBadMessage(),
              testing::HasSubstr("nine finite numbers"));
  EXPECT_TRUE(color_matrices_.empty());
}

TEST_F(FrameSinkBrokerTest, AColorMatrixThatBrightensIsABadMessage) {
  // Its diagonal warms the pointer too, which takes gains of 0 to 1.
  mojo::Remote<mojom::FrameSinkBroker> remote;
  broker()->Bind(remote.BindNewPipeAndPassReceiver());

  mojo::test::BadMessageObserver bad_message;
  remote->SetColorMatrix(7, {1, 0, 0, 0, 1.5f, 0, 0, 0, 1});

  EXPECT_THAT(bad_message.WaitForBadMessage(),
              testing::HasSubstr("diagonal is 0 to 1"));
  EXPECT_TRUE(color_matrices_.empty());
}

TEST_F(FrameSinkBrokerTest, AProducersEmulatedInputReachesTheDesk) {
  // An EIS client's click, which only the engine can deliver to the shell.
  mojo::Remote<mojom::FrameSinkBroker> remote;
  broker()->Bind(remote.BindNewPipeAndPassReceiver());

  remote->InjectInput(mojom::DeskInput::New(mojom::DeskInputKind::kButton,
                                            /*x=*/0, /*y=*/0,
                                            /*code=*/0x110, /*pressed=*/true));
  RunUntilIdle();

  ASSERT_EQ(inputs_.size(), 1u);
  EXPECT_EQ(inputs_[0]->kind, mojom::DeskInputKind::kButton);
  EXPECT_EQ(inputs_[0]->code, 0x110u);
  EXPECT_TRUE(inputs_[0]->pressed);
}

TEST_F(FrameSinkBrokerTest, AProducerSaysWhatIsOnEachClipboard) {
  // Lets a copy in a Wayland client be pasted in a page. The copy and primary
  // clipboards must stay separate.
  mojo::Remote<mojom::FrameSinkBroker> remote;
  broker()->Bind(remote.BindNewPipeAndPassReceiver());

  // The copy holds an image as well as text, as a screenshot with a file
  // name does: both cross.
  FrameSinkBroker::ClipboardContents copy = Text("an explicit copy");
  copy.emplace("image/png", std::vector<uint8_t>{0x89, 'P', 'N', 'G'});
  remote->SetClipboard(mojom::Clipboard::kCopy, copy);
  remote->SetClipboard(mojom::Clipboard::kPrimary, Text("brushed past"));
  RunUntilIdle();

  ASSERT_EQ(clipboards_.size(), 2u);
  EXPECT_EQ(clipboards_[0].first, mojom::Clipboard::kCopy);
  EXPECT_EQ(clipboards_[0].second, copy);
  EXPECT_EQ(clipboards_[1].first, mojom::Clipboard::kPrimary);
  EXPECT_EQ(clipboards_[1].second, Text("brushed past"));
}

TEST_F(FrameSinkBrokerTest, AnEmptyClipboardIsSaidRatherThanSwallowed) {
  // Forwarded so the browser stops pasting cleared content.
  mojo::Remote<mojom::FrameSinkBroker> remote;
  broker()->Bind(remote.BindNewPipeAndPassReceiver());

  remote->SetClipboard(mojom::Clipboard::kCopy, {});
  RunUntilIdle();

  ASSERT_EQ(clipboards_.size(), 1u);
  EXPECT_TRUE(clipboards_[0].second.empty());
}

TEST_F(FrameSinkBrokerTest, AnEmbedderWithNoClipboardDropsWhatWasSaid) {
  // Inside another session, the browser reads that session's clipboard. The
  // producer cannot tell, so it sends its clipboard anyway.
  FrameSinkBroker unwired(host_frame_sink_manager_.get(),
                          base::BindRepeating(
                              [](viz::FrameSinkIdAllocator* allocator) {
                                return allocator->NextFrameSinkId();
                              },
                              &allocator_));
  mojo::Remote<mojom::FrameSinkBroker> remote;
  unwired.Bind(remote.BindNewPipeAndPassReceiver());

  remote->SetClipboard(mojom::Clipboard::kCopy, Text("an explicit copy"));
  RunUntilIdle();

  EXPECT_TRUE(clipboards_.empty()) << "the fixture's own broker heard nothing";
}

TEST_F(FrameSinkBrokerTest, ACopyMadeInTheBrowserReachesEveryObserver) {
  // The browser is not a Wayland client of the producer, so this is the only
  // way a copy in a page reaches the seat.
  mojo::Remote<mojom::FrameSinkBroker> first_remote;
  mojo::Remote<mojom::FrameSinkBroker> second_remote;
  broker()->Bind(first_remote.BindNewPipeAndPassReceiver());
  broker()->Bind(second_remote.BindNewPipeAndPassReceiver());
  FakeClipboardObserver first;
  FakeClipboardObserver second;
  first_remote->ObserveClipboard(first.BindRemote());
  second_remote->ObserveClipboard(second.BindRemote());
  RunUntilIdle();

  broker()->OnCopied(mojom::Clipboard::kPrimary, Text("copied in a page"));
  RunUntilIdle();

  ASSERT_EQ(first.copies_.size(), 1u);
  EXPECT_EQ(first.copies_[0].first, mojom::Clipboard::kPrimary);
  EXPECT_EQ(first.copies_[0].second, Text("copied in a page"));
  EXPECT_EQ(second.copies_, first.copies_);
}

TEST_F(FrameSinkBrokerTest, AnObserverIsNotCaughtUpOnCopiesItMissed) {
  // Unlike displays, copies are not replayed: the producer owns the clipboard
  // state and sets it with SetClipboard.
  mojo::Remote<mojom::FrameSinkBroker> remote;
  broker()->Bind(remote.BindNewPipeAndPassReceiver());
  broker()->OnCopied(mojom::Clipboard::kCopy,
                     Text("copied before it connected"));

  FakeClipboardObserver observer;
  remote->ObserveClipboard(observer.BindRemote());
  RunUntilIdle();

  EXPECT_TRUE(observer.copies_.empty());
}

TEST_F(FrameSinkBrokerTest, AnObserverHearsNothingUntilTheDisplaysAreRead) {
  // An empty list means the screen is unread, so nothing is sent.
  mojo::Remote<mojom::FrameSinkBroker> remote;
  broker()->Bind(remote.BindNewPipeAndPassReceiver());
  FakeDisplayListObserver observer;
  remote->ObserveDisplays(observer.BindRemote());
  RunUntilIdle();

  EXPECT_TRUE(observer.lists_.empty());

  broker()->OnDisplaysChanged(OneDisplay(7, gfx::Size(2880, 1920)));
  RunUntilIdle();

  ASSERT_EQ(observer.lists_.size(), 1u);
  EXPECT_EQ(observer.lists_[0][0]->bounds, gfx::Rect(2880, 1920));
}

TEST_F(FrameSinkBrokerTest, AHotplugReachesEveryObserver) {
  mojo::Remote<mojom::FrameSinkBroker> first_remote;
  broker()->Bind(first_remote.BindNewPipeAndPassReceiver());
  FakeDisplayListObserver first;
  first_remote->ObserveDisplays(first.BindRemote());

  mojo::Remote<mojom::FrameSinkBroker> second_remote;
  broker()->Bind(second_remote.BindNewPipeAndPassReceiver());
  FakeDisplayListObserver second;
  second_remote->ObserveDisplays(second.BindRemote());
  RunUntilIdle();

  broker()->OnDisplaysChanged(OneDisplay(7, gfx::Size(1920, 1080)));
  RunUntilIdle();

  ASSERT_EQ(first.lists_.size(), 1u);
  ASSERT_EQ(second.lists_.size(), 1u);
  EXPECT_EQ(first.lists_[0][0]->bounds, gfx::Rect(1920, 1080));
  EXPECT_EQ(second.lists_[0][0]->bounds, gfx::Rect(1920, 1080));
}

TEST_F(FrameSinkBrokerTest, AnObserverIsToldHowTheBrowserComposites) {
  // A GPU process that fell back to software before the producer connected.
  broker()->OnCompositingChanged(/*in_memory=*/true);

  mojo::Remote<mojom::FrameSinkBroker> remote;
  broker()->Bind(remote.BindNewPipeAndPassReceiver());
  FakeCompositingObserver observer;
  remote->ObserveCompositing(observer.BindRemote());
  RunUntilIdle();

  EXPECT_EQ(observer.modes_, std::vector<bool>{true});
}

TEST_F(FrameSinkBrokerTest, AFallBackToSoftwareReachesEveryObserver) {
  broker()->OnCompositingChanged(/*in_memory=*/false);
  mojo::Remote<mojom::FrameSinkBroker> remote;
  broker()->Bind(remote.BindNewPipeAndPassReceiver());
  FakeCompositingObserver observer;
  remote->ObserveCompositing(observer.BindRemote());
  RunUntilIdle();

  broker()->OnCompositingChanged(/*in_memory=*/true);
  RunUntilIdle();

  EXPECT_EQ(observer.modes_, (std::vector<bool>{false, true}));
}

TEST_F(FrameSinkBrokerTest, AnUnchangedCompositingModeIsNotSentAgain) {
  // GPU info updates arrive for many reasons; only a change is news.
  mojo::Remote<mojom::FrameSinkBroker> remote;
  broker()->Bind(remote.BindNewPipeAndPassReceiver());
  FakeCompositingObserver observer;
  remote->ObserveCompositing(observer.BindRemote());
  RunUntilIdle();
  EXPECT_TRUE(observer.modes_.empty());

  broker()->OnCompositingChanged(/*in_memory=*/true);
  broker()->OnCompositingChanged(/*in_memory=*/true);
  RunUntilIdle();

  EXPECT_EQ(observer.modes_, std::vector<bool>{true});
}

TEST_F(FrameSinkBrokerTest, AnObserverHearsTheBrowserWindowsThenEachChange) {
  std::vector<mojom::ListedBrowserWindowPtr> windows;
  windows.push_back(mojom::ListedBrowserWindow::New(
      "1", "Mail", "", "https://mail.example/", true,
      std::vector<mojom::ListedBrowserViewPtr>()));
  broker()->OnBrowserWindowsChanged(std::move(windows));

  mojo::Remote<mojom::FrameSinkBroker> remote;
  broker()->Bind(remote.BindNewPipeAndPassReceiver());
  FakeBrowserWindowListObserver observer;
  remote->ObserveBrowserWindows(observer.BindRemote());
  RunUntilIdle();

  broker()->OnBrowserWindowsChanged({});
  RunUntilIdle();

  EXPECT_EQ(observer.lists_, (std::vector<std::vector<std::string>>{
                                 {"1 Mail https://mail.example/ private"},
                                 {}}));
}

TEST_F(FrameSinkBrokerTest, AnObserverHearsTheInputDevicesThenEachChange) {
  std::vector<mojom::ListedInputDevicePtr> devices;
  devices.push_back(mojom::ListedInputDevice::New(
      4, "Keyboard", mojom::InputDeviceKind::kKeyboard,
      mojom::InputDeviceConnection::kUsb, "/sys/devices/input4", 0x046d,
      0xc31c));
  broker()->OnInputDevicesChanged(std::move(devices));

  mojo::Remote<mojom::FrameSinkBroker> remote;
  broker()->Bind(remote.BindNewPipeAndPassReceiver());
  FakeInputDeviceListObserver observer;
  remote->ObserveInputDevices(observer.BindRemote());
  RunUntilIdle();

  broker()->OnInputDevicesChanged({});
  RunUntilIdle();

  EXPECT_EQ(observer.lists_,
            (std::vector<std::vector<std::string>>{{"4 Keyboard"}, {}}));
}

TEST_F(FrameSinkBrokerTest, ADisplayWithAWindowIsCaptured) {
  mojo::Remote<mojom::FrameSinkBroker> remote;
  broker()->Bind(remote.BindNewPipeAndPassReceiver());
  FakeDisplayCaptureObserver observer;
  mojo::Remote<mojom::DisplayCapture> capture;

  base::test::TestFuture<bool> started;
  remote->CaptureDisplay(7, gfx::Size(1920, 1080), 30,
                         capture.BindNewPipeAndPassReceiver(),
                         observer.BindRemote(), started.GetCallback());

  EXPECT_TRUE(started.Get());
  RunUntilIdle();
  EXPECT_TRUE(capture.is_connected());
}

TEST_F(FrameSinkBrokerTest, ADisplayWithNoWindowIsRefused) {
  // As while a new monitor's window opens.
  mojo::Remote<mojom::FrameSinkBroker> remote;
  broker()->Bind(remote.BindNewPipeAndPassReceiver());
  FakeDisplayCaptureObserver observer;
  mojo::Remote<mojom::DisplayCapture> capture;

  base::test::TestFuture<bool> started;
  remote->CaptureDisplay(8, gfx::Size(1920, 1080), 30,
                         capture.BindNewPipeAndPassReceiver(),
                         observer.BindRemote(), started.GetCallback());

  EXPECT_FALSE(started.Get());
  RunUntilIdle();
  EXPECT_FALSE(capture.is_connected());
}

TEST_F(FrameSinkBrokerTest, AnOpenBrowserWindowIsCapturedAlone) {
  mojo::Remote<mojom::FrameSinkBroker> remote;
  broker()->Bind(remote.BindNewPipeAndPassReceiver());
  FakeDisplayCaptureObserver observer;
  mojo::Remote<mojom::DisplayCapture> capture;

  base::test::TestFuture<bool> started;
  remote->CaptureBrowserWindow("1", 30, capture.BindNewPipeAndPassReceiver(),
                               observer.BindRemote(), started.GetCallback());

  EXPECT_TRUE(started.Get());
  RunUntilIdle();
  EXPECT_TRUE(capture.is_connected());
}

// A hidden page draws no frames, so the capture keeps it drawing until the
// producer closes it.
TEST_F(FrameSinkBrokerTest, ABrowserWindowDrawsWhileItIsCaptured) {
  mojo::Remote<mojom::FrameSinkBroker> remote;
  broker()->Bind(remote.BindNewPipeAndPassReceiver());
  FakeDisplayCaptureObserver observer;
  mojo::Remote<mojom::DisplayCapture> capture;

  base::test::TestFuture<bool> started;
  remote->CaptureBrowserWindow("1", 30, capture.BindNewPipeAndPassReceiver(),
                               observer.BindRemote(), started.GetCallback());
  ASSERT_TRUE(started.Get());
  EXPECT_EQ(drawing_holds_, 1);

  capture.reset();
  RunUntilIdle();
  EXPECT_EQ(drawing_holds_, 0);
}

TEST_F(FrameSinkBrokerTest, ABrowserWindowThatIsNotOpenIsRefused) {
  // As when the window closed after the producer heard of it.
  mojo::Remote<mojom::FrameSinkBroker> remote;
  broker()->Bind(remote.BindNewPipeAndPassReceiver());
  FakeDisplayCaptureObserver observer;
  mojo::Remote<mojom::DisplayCapture> capture;

  base::test::TestFuture<bool> started;
  remote->CaptureBrowserWindow("2", 30, capture.BindNewPipeAndPassReceiver(),
                               observer.BindRemote(), started.GetCallback());

  EXPECT_FALSE(started.Get());
  RunUntilIdle();
  EXPECT_FALSE(capture.is_connected());
}

// The producer's frames reach viz on another pipe than the one the browser
// made the image on. An import answers only once the GPU has made the image,
// or viz can draw a frame naming an image that is not there yet and leave the
// window blank.
TEST_F(FrameSinkBrokerTest, AnImportAnswersOnceTheGpuHasMadeItsImage) {
  UseTheGpu();
  HoldSignals();
  mojo::Remote<mojom::FrameSinkBroker> remote;
  broker()->Bind(remote.BindNewPipeAndPassReceiver());
  viz::MockCompositorFrameSinkClient sink_client;
  mojo::Remote<viz::mojom::CompositorFrameSink> sink;
  const viz::FrameSinkId frame_sink_id =
      BrokerASink(remote, sink_client, sink, mojo::NullRemote());
  base::test::TestFuture<uint64_t, std::optional<gpu::ExportedSharedImage>>
      imported;

  remote->ImportBuffer(frame_sink_id, ADmabuf(kBufferSize), kBufferSize,
                       kArgb8888, gfx::ColorSpace::CreateSRGB(),
                       imported.GetCallback());
  remote.FlushForTesting();

  EXPECT_FALSE(imported.IsReady());
  ASSERT_EQ(held_signals_.size(), 1u);
  std::move(held_signals_[0].second).Run();
  auto [buffer_id, exported] = imported.Take();
  EXPECT_NE(buffer_id, 0u);
  ASSERT_TRUE(exported.has_value());
  EXPECT_EQ(held_signals_[0].first,
            gpu::ClientSharedImage::ImportUnowned(std::move(exported).value())
                ->creation_sync_token());
}

// A GPU channel lost before the image is made drops the wait. The image may
// never exist, so the import is refused rather than left unanswered, which
// would hang a producer waiting on it.
TEST_F(FrameSinkBrokerTest, AnImportIsRefusedIfTheGpuGoesBeforeItsImage) {
  UseTheGpu();
  HoldSignals();
  mojo::Remote<mojom::FrameSinkBroker> remote;
  broker()->Bind(remote.BindNewPipeAndPassReceiver());
  viz::MockCompositorFrameSinkClient sink_client;
  mojo::Remote<viz::mojom::CompositorFrameSink> sink;
  const viz::FrameSinkId frame_sink_id =
      BrokerASink(remote, sink_client, sink, mojo::NullRemote());
  base::test::TestFuture<uint64_t, std::optional<gpu::ExportedSharedImage>>
      imported;
  remote->ImportBuffer(frame_sink_id, ADmabuf(kBufferSize), kBufferSize,
                       kArgb8888, gfx::ColorSpace::CreateSRGB(),
                       imported.GetCallback());
  remote.FlushForTesting();

  held_signals_.clear();

  auto [buffer_id, exported] = imported.Take();
  EXPECT_EQ(buffer_id, 0u);
  EXPECT_FALSE(exported.has_value());
}

// The producer submits without waiting for its draw. The GPU waits for the
// draw's fence before reading the buffer, and the token orders viz's read
// after the fence is in place.
TEST_F(FrameSinkBrokerTest, AFencedBufferIsReadOnlyAfterItsFence) {
  UseTheGpu();
  mojo::Remote<mojom::FrameSinkBroker> remote;
  broker()->Bind(remote.BindNewPipeAndPassReceiver());
  viz::MockCompositorFrameSinkClient sink_client;
  mojo::Remote<viz::mojom::CompositorFrameSink> sink;
  const viz::FrameSinkId frame_sink_id =
      BrokerASink(remote, sink_client, sink, mojo::NullRemote());
  const auto [buffer_id, mailbox] = ImportABuffer(remote, frame_sink_id);

  base::test::TestFuture<const std::optional<gpu::SyncToken>&> fenced;
  remote->FenceBuffer(frame_sink_id, buffer_id, AFence(),
                      fenced.GetCallback());

  ASSERT_TRUE(fenced.Get().has_value());
  EXPECT_EQ(*fenced.Get(), sii_->MostRecentGeneratedToken());
  // The producer has no GPU channel to verify it with.
  EXPECT_TRUE(fenced.Get()->verified_flush());
  EXPECT_EQ(sii_->fenced(), std::vector<gpu::Mailbox>{mailbox});
}

// Viz returns a buffer before its GPU is done reading it. The image goes only
// after that read, or the read finds no image and viz draws its fallback over
// the window until the client draws again.
TEST_F(FrameSinkBrokerTest, ADestroyedBufferGoesAfterVizsLastReadOfIt) {
  UseTheGpu();
  mojo::Remote<mojom::FrameSinkBroker> remote;
  broker()->Bind(remote.BindNewPipeAndPassReceiver());
  viz::MockCompositorFrameSinkClient sink_client;
  mojo::Remote<viz::mojom::CompositorFrameSink> sink;
  const viz::FrameSinkId frame_sink_id =
      BrokerASink(remote, sink_client, sink, mojo::NullRemote());
  const auto [buffer_id, mailbox] = ImportABuffer(remote, frame_sink_id);
  gpu::SyncToken read_done(gpu::CommandBufferNamespace::GPU_IO,
                           gpu::CommandBufferId::FromUnsafeValue(7),
                           /*release_count=*/42);
  read_done.SetVerifyFlush();

  remote->DestroyBuffer(frame_sink_id, buffer_id, read_done);
  remote.FlushForTesting();

  EXPECT_FALSE(sii_->CheckSharedImageExists(mailbox));
  EXPECT_EQ(sii_->MostRecentDestroyTokens(),
            std::vector<gpu::SyncToken>{read_done});
}

TEST_F(FrameSinkBrokerTest, FencingABufferNeverImportedIsRefused) {
  UseTheGpu();
  mojo::Remote<mojom::FrameSinkBroker> remote;
  broker()->Bind(remote.BindNewPipeAndPassReceiver());
  viz::MockCompositorFrameSinkClient sink_client;
  mojo::Remote<viz::mojom::CompositorFrameSink> sink;
  const viz::FrameSinkId frame_sink_id =
      BrokerASink(remote, sink_client, sink, mojo::NullRemote());

  base::test::TestFuture<const std::optional<gpu::SyncToken>&> fenced;
  remote->FenceBuffer(frame_sink_id, /*buffer_id=*/1, AFence(),
                      fenced.GetCallback());

  EXPECT_FALSE(fenced.Get().has_value());
  EXPECT_TRUE(sii_->fenced().empty());
}

// Each fourcc a client may draw in, as the SharedImage viz samples. DRM names
// channels from the most significant bit and viz in memory order. A format
// with no alpha channel is opaque, whatever its padding bits hold.
TEST_F(FrameSinkBrokerTest, EachFourccIsImportedInItsOwnFormat) {
  struct Expected {
    uint32_t fourcc;
    viz::SharedImageFormat format;
    SkAlphaType alpha;
  };
  const Expected kExpected[] = {
      {0x34325241, viz::SinglePlaneFormat::kBGRA_8888, kPremul_SkAlphaType},
      {0x34325258, viz::SinglePlaneFormat::kBGRX_8888, kOpaque_SkAlphaType},
      {0x34324241, viz::SinglePlaneFormat::kRGBA_8888, kPremul_SkAlphaType},
      {0x34324258, viz::SinglePlaneFormat::kRGBX_8888, kOpaque_SkAlphaType},
      {0x30335241, viz::SinglePlaneFormat::kBGRA_1010102, kPremul_SkAlphaType},
      {0x30334241, viz::SinglePlaneFormat::kRGBA_1010102, kPremul_SkAlphaType},
      {0x48344241, viz::SinglePlaneFormat::kRGBA_F16, kPremul_SkAlphaType},
  };
  UseTheGpu();
  mojo::Remote<mojom::FrameSinkBroker> remote;
  broker()->Bind(remote.BindNewPipeAndPassReceiver());
  viz::MockCompositorFrameSinkClient sink_client;
  mojo::Remote<viz::mojom::CompositorFrameSink> sink;
  const viz::FrameSinkId frame_sink_id =
      BrokerASink(remote, sink_client, sink, mojo::NullRemote());

  for (const Expected& expected : kExpected) {
    SCOPED_TRACE(testing::Message() << "fourcc 0x" << std::hex
                                    << expected.fourcc);
    const scoped_refptr<gpu::ClientSharedImage> image =
        ImportAs(remote, frame_sink_id, expected.fourcc);
    ASSERT_TRUE(image);
    EXPECT_EQ(image->format(), expected.format);
    EXPECT_EQ(image->alpha_type(), expected.alpha);
  }
}

// A format the engine does not list would draw with permuted channels.
TEST_F(FrameSinkBrokerTest, AnUnlistedFourccIsRefused) {
  UseTheGpu();
  mojo::Remote<mojom::FrameSinkBroker> remote;
  broker()->Bind(remote.BindNewPipeAndPassReceiver());
  viz::MockCompositorFrameSinkClient sink_client;
  mojo::Remote<viz::mojom::CompositorFrameSink> sink;
  const viz::FrameSinkId frame_sink_id =
      BrokerASink(remote, sink_client, sink, mojo::NullRemote());

  // DRM_FORMAT_RGB565.
  EXPECT_FALSE(ImportAs(remote, frame_sink_id, 0x36314752));
}

// Viz has no 10-bit or half-float format without alpha. Its twin with alpha
// draws the padding bits as alpha, even marked opaque, so a window whose
// padding is zero would draw transparent.
TEST_F(FrameSinkBrokerTest, ADeepFourccWithoutAlphaIsRefused) {
  UseTheGpu();
  mojo::Remote<mojom::FrameSinkBroker> remote;
  broker()->Bind(remote.BindNewPipeAndPassReceiver());
  viz::MockCompositorFrameSinkClient sink_client;
  mojo::Remote<viz::mojom::CompositorFrameSink> sink;
  const viz::FrameSinkId frame_sink_id =
      BrokerASink(remote, sink_client, sink, mojo::NullRemote());

  // DRM_FORMAT_XRGB2101010, XBGR2101010 and XBGR16161616F.
  for (const uint32_t fourcc : {0x30335258u, 0x30334258u, 0x48344258u}) {
    SCOPED_TRACE(testing::Message() << "fourcc 0x" << std::hex << fourcc);
    EXPECT_FALSE(ImportAs(remote, frame_sink_id, fourcc));
  }
}

// A client that described its pixels (wp_color_management_v1) is drawn in
// that color space, which viz converts from to each display's.
TEST_F(FrameSinkBrokerTest, ABufferIsImportedInTheColorSpaceAskedFor) {
  UseTheGpu();
  mojo::Remote<mojom::FrameSinkBroker> remote;
  broker()->Bind(remote.BindNewPipeAndPassReceiver());
  viz::MockCompositorFrameSinkClient sink_client;
  mojo::Remote<viz::mojom::CompositorFrameSink> sink;
  const viz::FrameSinkId frame_sink_id =
      BrokerASink(remote, sink_client, sink, mojo::NullRemote());
  const gfx::ColorSpace pq(gfx::ColorSpace::PrimaryID::BT2020,
                           gfx::ColorSpace::TransferID::PQ);

  // DRM_FORMAT_ABGR2101010.
  scoped_refptr<gpu::ClientSharedImage> shared_image =
      ImportAs(remote, frame_sink_id, 0x30334241, pq);

  ASSERT_TRUE(shared_image);
  EXPECT_EQ(shared_image->color_space(), pq);
}

// The GPU does not make an image over shared memory, so its import has
// nothing to wait for.
TEST_F(FrameSinkBrokerTest, AnImportInSharedMemoryAnswersAtOnce) {
  CompositeInSoftware();
  HoldSignals();
  mojo::Remote<mojom::FrameSinkBroker> remote;
  broker()->Bind(remote.BindNewPipeAndPassReceiver());
  viz::MockCompositorFrameSinkClient sink_client;
  mojo::Remote<viz::mojom::CompositorFrameSink> sink;
  const viz::FrameSinkId frame_sink_id =
      BrokerASink(remote, sink_client, sink, mojo::NullRemote());
  constexpr uint32_t kStride = 4 * 64;

  auto [buffer_id, exported] = ImportShm(
      remote, frame_sink_id,
      base::UnsafeSharedMemoryRegion::Create(kStride * 48), kStride);

  EXPECT_NE(buffer_id, 0u);
  EXPECT_TRUE(exported.has_value());
  EXPECT_TRUE(held_signals_.empty());
}

// A window drawn into shared memory, on a browser that composites in
// software: the memory itself becomes the image viz draws, uncopied.
TEST_F(FrameSinkBrokerTest, AWindowInSharedMemoryIsASoftwareImageOverIt) {
  CompositeInSoftware();
  mojo::Remote<mojom::FrameSinkBroker> remote;
  broker()->Bind(remote.BindNewPipeAndPassReceiver());
  viz::MockCompositorFrameSinkClient sink_client;
  mojo::Remote<viz::mojom::CompositorFrameSink> sink;
  const viz::FrameSinkId frame_sink_id =
      BrokerASink(remote, sink_client, sink, mojo::NullRemote());
  constexpr uint32_t kStride = 4 * 64 + 16;
  base::UnsafeSharedMemoryRegion region =
      base::UnsafeSharedMemoryRegion::Create(kStride * 48);
  const base::UnguessableToken guid = region.GetGUID();

  auto [buffer_id, exported] =
      ImportShm(remote, frame_sink_id, std::move(region), kStride);

  EXPECT_NE(buffer_id, 0u);
  ASSERT_TRUE(exported.has_value());
  EXPECT_TRUE(gpu::ClientSharedImage::ImportUnowned(std::move(exported).value())
                  ->is_software());
  EXPECT_EQ(software_sii_->made_over(),
            (std::vector<std::pair<base::UnguessableToken, uint32_t>>{
                {guid, kStride}}));
}

// Viz composited on the GPU drops a software image, so the window would be
// blank with nothing said.
TEST_F(FrameSinkBrokerTest, AWindowInSharedMemoryIsRefusedOnTheGpu) {
  UseTheGpu();
  mojo::Remote<mojom::FrameSinkBroker> remote;
  broker()->Bind(remote.BindNewPipeAndPassReceiver());
  viz::MockCompositorFrameSinkClient sink_client;
  mojo::Remote<viz::mojom::CompositorFrameSink> sink;
  const viz::FrameSinkId frame_sink_id =
      BrokerASink(remote, sink_client, sink, mojo::NullRemote());

  auto [buffer_id, exported] =
      ImportShm(remote, frame_sink_id,
                base::UnsafeSharedMemoryRegion::Create(4 * 64 * 48), 4 * 64);

  EXPECT_EQ(buffer_id, 0u);
  EXPECT_FALSE(exported.has_value());
  EXPECT_TRUE(software_sii_->made_over().empty());
}

}  // namespace domicile
