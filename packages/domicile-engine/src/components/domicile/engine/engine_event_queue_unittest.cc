// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/engine/engine_event_queue.h"

#include <fcntl.h>
#include <poll.h>
#include <unistd.h>

#include <memory>
#include <utility>
#include <vector>

#include "base/files/scoped_file.h"
#include "base/threading/simple_thread.h"
#include "testing/gtest/include/gtest/gtest.h"

namespace domicile {
namespace {

// Whether a caller that put fd() in its own poll loop would be woken right now.
bool Readable(int fd) {
  pollfd descriptor = {.fd = fd, .events = POLLIN, .revents = 0};
  return poll(&descriptor, 1, /*timeout=*/0) == 1;
}

// Whether `fd` is an open descriptor.
bool IsOpen(int fd) {
  return fcntl(fd, F_GETFD) != -1;
}

TEST(EngineEventQueueTest, ACapturedFrameKeepsItsFdsUntilTheDrainIsDone) {
  // The C ABI lends the compositor these fds for the callback, so the queue
  // must keep them open until the drained event is gone.
  EngineEventQueue queue;
  int ends[2];
  ASSERT_EQ(pipe(ends), 0);
  base::ScopedFD kept(ends[1]);
  const int lent = ends[0];
  {
    std::vector<base::ScopedFD> fds;
    fds.emplace_back(lent);
    EngineEvent pushed{.type = EngineEvent::Type::kCaptured, .capture = 3};
    pushed.captured.fds =
        std::make_shared<const std::vector<base::ScopedFD>>(std::move(fds));
    queue.Push(pushed);
  }
  EXPECT_TRUE(IsOpen(lent));

  {
    const std::vector<EngineEvent> drained = queue.Drain();
    ASSERT_EQ(drained.size(), 1u);
    EXPECT_EQ(drained[0].capture, 3u);
    EXPECT_TRUE(IsOpen(lent));
  }

  EXPECT_FALSE(IsOpen(lent));
}

TEST(EngineEventQueueTest, AnIdleQueueDoesNotWakeThePollingThread) {
  EngineEventQueue queue;

  ASSERT_GE(queue.fd(), 0);
  EXPECT_FALSE(Readable(queue.fd()));
  EXPECT_TRUE(queue.Drain().empty());
}

TEST(EngineEventQueueTest, PushingWakesThePollingThreadAndCarriesTheEvent) {
  EngineEventQueue queue;

  queue.Push({.type = EngineEvent::Type::kConfigure,
              .surface = 7,
              .width = 180,
              .height = 130,
              .scale = 1.5});

  EXPECT_TRUE(Readable(queue.fd()));
  const std::vector<EngineEvent> drained = queue.Drain();
  ASSERT_EQ(drained.size(), 1u);
  EXPECT_EQ(drained[0].type, EngineEvent::Type::kConfigure);
  EXPECT_EQ(drained[0].surface, 7u);
  EXPECT_EQ(drained[0].width, 180u);
  EXPECT_EQ(drained[0].height, 130u);
  EXPECT_EQ(drained[0].scale, 1.5);
}

// The display list is the only variable-length payload.
TEST(EngineEventQueueTest, ADisplayListArrivesWholeAcrossTheQueue) {
  EngineEventQueue queue;

  EngineEvent pushed{.type = EngineEvent::Type::kDisplays};
  pushed.displays.push_back(EngineDisplay{.id = 7,
                                          .name = "DEL DELL U3219Q 2ZLS413",
                                          .x = 0,
                                          .y = 0,
                                          .width = 2880,
                                          .height = 1920,
                                          .physical_width_mm = 597,
                                          .physical_height_mm = 336,
                                          .refresh_mhz = 59997,
                                          .connector = "eDP-1",
                                          .gamma_size = 4096,
                                          .modes = {{.width = 2880,
                                                     .height = 1920,
                                                     .refresh_mhz = 59997}}});
  pushed.displays.push_back(EngineDisplay{.id = 9,
                                          .x = 2880,
                                          .y = 0,
                                          .width = 1920,
                                          .height = 1080,
                                          .connector = "HDMI-A-1"});
  queue.Push(pushed);

  const std::vector<EngineEvent> drained = queue.Drain();
  ASSERT_EQ(drained.size(), 1u);
  EXPECT_EQ(drained[0].type, EngineEvent::Type::kDisplays);
  ASSERT_EQ(drained[0].displays.size(), 2u);
  EXPECT_EQ(drained[0].displays[0].id, 7);
  EXPECT_EQ(drained[0].displays[0].width, 2880);
  EXPECT_EQ(drained[0].displays[0].gamma_size, 4096u);
  ASSERT_EQ(drained[0].displays[0].modes.size(), 1u);
  EXPECT_EQ(drained[0].displays[0].modes[0].refresh_mhz, 59997);
  EXPECT_TRUE(drained[0].displays[1].modes.empty());
  EXPECT_EQ(drained[0].displays[0].physical_width_mm, 597);
  EXPECT_EQ(drained[0].displays[0].physical_height_mm, 336);
  EXPECT_EQ(drained[0].displays[0].refresh_mhz, 59997);
  // The C ABI points into this string, so the queue must keep it.
  EXPECT_EQ(drained[0].displays[0].name, "DEL DELL U3219Q 2ZLS413");
  EXPECT_EQ(drained[0].displays[1].name, "");
  EXPECT_EQ(drained[0].displays[0].connector, "eDP-1");
  EXPECT_EQ(drained[0].displays[1].connector, "HDMI-A-1");
  EXPECT_EQ(drained[0].displays[1].id, 9);
  EXPECT_EQ(drained[0].displays[1].x, 2880);
}

TEST(EngineEventQueueTest, TheBrowserWindowsArriveWholeAcrossTheQueue) {
  EngineEventQueue queue;
  EngineEvent pushed{.type = EngineEvent::Type::kBrowserWindows};
  pushed.browser_windows.push_back(
      EngineBrowserWindow{.id = "3",
                          .title = "Inbox",
                          .app_id = "mail",
                          .url = "https://mail.example/",
                          .off_the_record = true});
  pushed.browser_windows.push_back(EngineBrowserWindow{
      .id = "5",
      .views = {EngineBrowserView{
          .id = "6", .x = 0, .y = 40, .width = 800, .height = 560}}});
  queue.Push(pushed);

  const std::vector<EngineEvent> drained = queue.Drain();
  ASSERT_EQ(drained.size(), 1u);
  EXPECT_EQ(drained[0].type, EngineEvent::Type::kBrowserWindows);
  ASSERT_EQ(drained[0].browser_windows.size(), 2u);
  // The C ABI points into these strings, so the queue must keep them.
  EXPECT_EQ(drained[0].browser_windows[0].id, "3");
  EXPECT_EQ(drained[0].browser_windows[0].title, "Inbox");
  EXPECT_EQ(drained[0].browser_windows[0].app_id, "mail");
  EXPECT_EQ(drained[0].browser_windows[0].url, "https://mail.example/");
  EXPECT_TRUE(drained[0].browser_windows[0].off_the_record);
  EXPECT_FALSE(drained[0].browser_windows[1].off_the_record);
  EXPECT_EQ(drained[0].browser_windows[1].id, "5");
  EXPECT_EQ(drained[0].browser_windows[1].title, "");
  EXPECT_TRUE(drained[0].browser_windows[0].views.empty());
  EXPECT_EQ(drained[0].browser_windows[1].views,
            (std::vector<EngineBrowserView>{EngineBrowserView{
                .id = "6", .x = 0, .y = 40, .width = 800, .height = 560}}));
}

TEST(EngineEventQueueTest, TheInputDevicesArriveWholeAcrossTheQueue) {
  EngineEventQueue queue;
  EngineEvent pushed{.type = EngineEvent::Type::kInputDevices};
  pushed.input_devices.push_back(EngineInputDevice{
      .name = "Logitech MX Master 3",
      .sys_path = "/sys/devices/input9",
      .id = 9,
      .vendor_id = 0x046d,
      .product_id = 0x4082,
      // DOMICILE_INPUT_DEVICE_MOUSE and DOMICILE_INPUT_CONNECTION_BLUETOOTH.
      .kind = 1,
      .connection = 3});
  queue.Push(pushed);

  const std::vector<EngineEvent> drained = queue.Drain();
  ASSERT_EQ(drained.size(), 1u);
  EXPECT_EQ(drained[0].type, EngineEvent::Type::kInputDevices);
  ASSERT_EQ(drained[0].input_devices.size(), 1u);
  // The C ABI points into these strings, so the queue must keep them.
  EXPECT_EQ(drained[0].input_devices[0].name, "Logitech MX Master 3");
  EXPECT_EQ(drained[0].input_devices[0].sys_path, "/sys/devices/input9");
  EXPECT_EQ(drained[0].input_devices[0].id, 9);
  EXPECT_EQ(drained[0].input_devices[0].vendor_id, 0x046d);
  EXPECT_EQ(drained[0].input_devices[0].kind, 1);
  EXPECT_EQ(drained[0].input_devices[0].connection, 3);
}

// The compositor dispatches once per wakeup, so a drain must return every
// queued event or the rest wait for an unrelated wakeup.
TEST(EngineEventQueueTest, DrainTakesEverythingQueuedAndThenSleeps) {
  EngineEventQueue queue;

  queue.Push({.type = EngineEvent::Type::kConfigure, .surface = 1});
  queue.Push({.type = EngineEvent::Type::kReleased, .surface = 1, .buffer = 9});
  queue.Push({.type = EngineEvent::Type::kConfigure, .surface = 2});

  EXPECT_EQ(queue.Drain().size(), 3u);
  EXPECT_FALSE(Readable(queue.fd()));
  EXPECT_TRUE(queue.Drain().empty());
}

// A push after a drain must still wake the poller.
TEST(EngineEventQueueTest, AnEventPushedAfterADrainStillWakesThePoller) {
  EngineEventQueue queue;

  queue.Push({.type = EngineEvent::Type::kReleased, .surface = 1});
  EXPECT_EQ(queue.Drain().size(), 1u);

  queue.Push({.type = EngineEvent::Type::kReleased, .surface = 2});

  EXPECT_TRUE(Readable(queue.fd()));
  ASSERT_EQ(queue.Drain().size(), 1u);
}

// Pushes from one thread and drains from another must not lose events.
class Pusher : public base::DelegateSimpleThread::Delegate {
 public:
  Pusher(EngineEventQueue* queue, int count) : queue_(queue), count_(count) {}

  void Run() override {
    for (int i = 0; i < count_; ++i) {
      queue_->Push({.type = EngineEvent::Type::kReleased,
                    .surface = static_cast<uint32_t>(i)});
    }
  }

 private:
  const raw_ptr<EngineEventQueue> queue_;
  const int count_;
};

TEST(EngineEventQueueTest, EveryEventPushedFromAnotherThreadArrives) {
  constexpr int kEvents = 500;
  EngineEventQueue queue;
  Pusher pusher(&queue, kEvents);
  base::DelegateSimpleThread thread(&pusher, "pusher");

  thread.Start();
  std::vector<EngineEvent> seen;
  while (static_cast<int>(seen.size()) < kEvents) {
    for (const EngineEvent& event : queue.Drain()) {
      seen.push_back(event);
    }
  }
  thread.Join();

  ASSERT_EQ(seen.size(), static_cast<size_t>(kEvents));
  for (int i = 0; i < kEvents; ++i) {
    EXPECT_EQ(seen[i].surface, static_cast<uint32_t>(i)) << "at " << i;
  }
}

}  // namespace
}  // namespace domicile
