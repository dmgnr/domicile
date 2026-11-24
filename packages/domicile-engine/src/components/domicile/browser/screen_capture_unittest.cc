// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/browser/screen_capture.h"

#include "content/public/browser/desktop_media_id.h"
#include "content/public/browser/web_contents_media_capture_id.h"
#include "media/mojo/mojom/display_media_information.mojom.h"
#include "testing/gtest/include/gtest/gtest.h"
#include "third_party/blink/public/mojom/mediastream/media_stream.mojom.h"

namespace domicile {
namespace {

using blink::mojom::MediaStreamType;

TEST(ScreenCaptureTest, OnlyGetDisplayMediaIsScreenCapture) {
  EXPECT_TRUE(IsScreenCapture(MediaStreamType::DISPLAY_VIDEO_CAPTURE));
  // `preferCurrentTab`.
  EXPECT_TRUE(IsScreenCapture(MediaStreamType::DISPLAY_VIDEO_CAPTURE_THIS_TAB));
  // `getUserMedia()` with `chromeMediaSource: "desktop"`, as Electron apps
  // ask with a `desktopCapturer` source.
  EXPECT_TRUE(IsScreenCapture(MediaStreamType::GUM_DESKTOP_VIDEO_CAPTURE));
  EXPECT_FALSE(IsScreenCapture(MediaStreamType::DEVICE_VIDEO_CAPTURE));
  EXPECT_FALSE(IsScreenCapture(MediaStreamType::GUM_TAB_VIDEO_CAPTURE));
  EXPECT_FALSE(IsScreenCapture(MediaStreamType::NO_SERVICE));
}

TEST(ScreenCaptureTest, APreferCurrentTabPickIsOfItsRequestsType) {
  const blink::mojom::StreamDevicesSetPtr answer = AsRequested(
      MediaStreamType::DISPLAY_VIDEO_CAPTURE_THIS_TAB,
      MediaStreamType::DISPLAY_AUDIO_CAPTURE,
      PortalScreenCapture(7, PortalPick{.sound = "domicile-sound-desk"},
                          /*audio=*/true));

  EXPECT_EQ(answer->stream_devices[0]->video_device->type,
            MediaStreamType::DISPLAY_VIDEO_CAPTURE_THIS_TAB);
  EXPECT_EQ(answer->stream_devices[0]->audio_device->type,
            MediaStreamType::DISPLAY_AUDIO_CAPTURE);
}

TEST(ScreenCaptureTest, ADesktopGetUserMediaPickIsOfItsRequestsTypes) {
  const blink::mojom::StreamDevicesSetPtr answer = AsRequested(
      MediaStreamType::GUM_DESKTOP_VIDEO_CAPTURE,
      MediaStreamType::GUM_DESKTOP_AUDIO_CAPTURE,
      PortalScreenCapture(7, PortalPick{.sound = "domicile-sound-desk"},
                          /*audio=*/true));

  EXPECT_EQ(answer->stream_devices[0]->video_device->type,
            MediaStreamType::GUM_DESKTOP_VIDEO_CAPTURE);
  EXPECT_EQ(answer->stream_devices[0]->audio_device->type,
            MediaStreamType::GUM_DESKTOP_AUDIO_CAPTURE);
  EXPECT_EQ(answer->stream_devices[0]->audio_device->id, "domicile-sound-desk");
}

TEST(ScreenCaptureTest, ScreenSoundIsAskedEitherWay) {
  EXPECT_TRUE(WantsScreenSound(MediaStreamType::DISPLAY_AUDIO_CAPTURE));
  EXPECT_TRUE(WantsScreenSound(MediaStreamType::GUM_DESKTOP_AUDIO_CAPTURE));
  EXPECT_FALSE(WantsScreenSound(MediaStreamType::NO_SERVICE));
  EXPECT_FALSE(WantsScreenSound(MediaStreamType::DEVICE_AUDIO_CAPTURE));
}

TEST(ScreenCaptureTest, TheAnswerIsOneScreenThePortalPicked) {
  const blink::mojom::StreamDevicesSetPtr answer =
      PortalScreenCapture(7, PortalPick{.source_type = 4}, /*audio=*/false);

  ASSERT_EQ(answer->stream_devices.size(), 1u);
  const blink::mojom::StreamDevices& devices = *answer->stream_devices[0];
  EXPECT_FALSE(devices.audio_device.has_value());
  ASSERT_TRUE(devices.video_device.has_value());
  EXPECT_EQ(devices.video_device->type, MediaStreamType::DISPLAY_VIDEO_CAPTURE);
  // The source the picker's restore token is kept under, so the capture's
  // own portal session restores the pick.
  EXPECT_EQ(content::DesktopMediaID::Parse(devices.video_device->id),
            content::DesktopMediaID(content::DesktopMediaID::TYPE_SCREEN, 7));
  ASSERT_TRUE(devices.video_device->display_media_info);
  // A region is part of a monitor.
  EXPECT_EQ(devices.video_device->display_media_info->display_surface,
            media::mojom::DisplayCaptureSurfaceType::MONITOR);
}

TEST(ScreenCaptureTest, TheSoundIsThePicksNodeWhenThePageAsks) {
  const PortalPick desk{.source_type = 1, .sound = "domicile-sound-desk"};

  const blink::mojom::StreamDevicesSetPtr heard =
      PortalScreenCapture(7, desk, /*audio=*/true);
  ASSERT_TRUE(heard->stream_devices[0]->audio_device.has_value());
  EXPECT_EQ(heard->stream_devices[0]->audio_device->type,
            MediaStreamType::DISPLAY_AUDIO_CAPTURE);
  EXPECT_EQ(heard->stream_devices[0]->audio_device->id, "domicile-sound-desk");

  EXPECT_FALSE(PortalScreenCapture(7, desk, /*audio=*/false)
                   ->stream_devices[0]
                   ->audio_device.has_value());
  // A window whose sound the compositor cannot tell.
  EXPECT_FALSE(PortalScreenCapture(7, PortalPick{.source_type = 2},
                                   /*audio=*/true)
                   ->stream_devices[0]
                   ->audio_device.has_value());
}

TEST(ScreenCaptureTest, ABrowserWindowIsATabWithTheTabsSound) {
  content::WebContentsMediaCaptureId tab(3, 4);
  tab.disable_local_echo = true;

  const blink::mojom::StreamDevicesSetPtr answer =
      TabCapture(tab, /*handle=*/nullptr, /*audio=*/true);

  const blink::mojom::StreamDevices& devices = *answer->stream_devices[0];
  EXPECT_EQ(content::DesktopMediaID::Parse(devices.video_device->id),
            content::DesktopMediaID(content::DesktopMediaID::TYPE_WEB_CONTENTS,
                                    content::DesktopMediaID::kNullId, tab));
  EXPECT_EQ(devices.video_device->display_media_info->display_surface,
            media::mojom::DisplayCaptureSurfaceType::BROWSER);
  ASSERT_TRUE(devices.audio_device.has_value());
  EXPECT_EQ(devices.audio_device->type, MediaStreamType::DISPLAY_AUDIO_CAPTURE);
  // Muted while captured, as the page asked.
  EXPECT_EQ(devices.audio_device->id, tab.ToString());
}

}  // namespace
}  // namespace domicile
