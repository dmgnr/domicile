// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/browser/screen_capture.h"

#include <optional>
#include <utility>

#include "base/check.h"
#include "media/mojo/mojom/display_media_information.mojom.h"
#include "third_party/blink/public/common/mediastream/media_stream_request.h"

namespace domicile {

bool IsScreenCapture(blink::mojom::MediaStreamType video) {
  return video == blink::mojom::MediaStreamType::DISPLAY_VIDEO_CAPTURE ||
         video ==
             blink::mojom::MediaStreamType::DISPLAY_VIDEO_CAPTURE_THIS_TAB ||
         video == blink::mojom::MediaStreamType::GUM_DESKTOP_VIDEO_CAPTURE;
}

bool WantsScreenSound(blink::mojom::MediaStreamType audio) {
  return audio == blink::mojom::MediaStreamType::DISPLAY_AUDIO_CAPTURE ||
         audio == blink::mojom::MediaStreamType::GUM_DESKTOP_AUDIO_CAPTURE;
}

blink::mojom::StreamDevicesSetPtr AsRequested(
    blink::mojom::MediaStreamType video,
    blink::mojom::MediaStreamType audio,
    blink::mojom::StreamDevicesSetPtr answer) {
  for (blink::mojom::StreamDevicesPtr& devices : answer->stream_devices) {
    if (devices->video_device.has_value()) {
      devices->video_device->type = video;
    }
    // A pick carries sound only when the request asked for it.
    if (devices->audio_device.has_value()) {
      CHECK(WantsScreenSound(audio));
      devices->audio_device->type = audio;
    }
  }
  return answer;
}

namespace {

blink::mojom::StreamDevicesSetPtr OneStream(
    std::optional<blink::MediaStreamDevice> audio,
    blink::MediaStreamDevice video) {
  blink::mojom::StreamDevicesSetPtr answer =
      blink::mojom::StreamDevicesSet::New();
  answer->stream_devices.push_back(
      blink::mojom::StreamDevices::New(std::move(audio), std::move(video)));
  return answer;
}

}  // namespace

blink::mojom::StreamDevicesSetPtr PortalScreenCapture(
    content::DesktopMediaID::Id source,
    const PortalPick& pick,
    bool audio) {
  const content::DesktopMediaID screen(content::DesktopMediaID::TYPE_SCREEN,
                                       source);
  blink::MediaStreamDevice device(
      blink::mojom::MediaStreamType::DISPLAY_VIDEO_CAPTURE, screen.ToString(),
      "Screen");
  // The portal draws the pointer into the frames. A region is part of a
  // monitor, and so is captured as one.
  device.display_media_info = media::mojom::DisplayMediaInformation::New(
      pick.source_type == 2 ? media::mojom::DisplayCaptureSurfaceType::WINDOW
                            : media::mojom::DisplayCaptureSurfaceType::MONITOR,
      /*logical_surface=*/true, media::mojom::CursorCaptureType::ALWAYS,
      /*capture_handle=*/nullptr, /*initial_zoom_level=*/100);

  std::optional<blink::MediaStreamDevice> sound;
  if (audio && !pick.sound.empty()) {
    sound.emplace(blink::mojom::MediaStreamType::DISPLAY_AUDIO_CAPTURE,
                  pick.sound,
                  pick.source_type == 2 ? "Window audio" : "System audio");
  }
  return OneStream(std::move(sound), std::move(device));
}

blink::mojom::StreamDevicesSetPtr TabCapture(
    const content::WebContentsMediaCaptureId& tab,
    media::mojom::CaptureHandlePtr handle,
    bool audio) {
  const content::DesktopMediaID page(content::DesktopMediaID::TYPE_WEB_CONTENTS,
                                     content::DesktopMediaID::kNullId, tab);
  blink::MediaStreamDevice device(
      blink::mojom::MediaStreamType::DISPLAY_VIDEO_CAPTURE, page.ToString(),
      "Tab");
  // As Chrome's own tab capture (desktop_capture_devices_util.cc).
  device.display_media_info = media::mojom::DisplayMediaInformation::New(
      media::mojom::DisplayCaptureSurfaceType::BROWSER,
      /*logical_surface=*/true, media::mojom::CursorCaptureType::MOTION,
      std::move(handle), /*initial_zoom_level=*/100);

  std::optional<blink::MediaStreamDevice> sound;
  if (audio) {
    // `disable_local_echo` mutes the tab while it is captured.
    sound.emplace(blink::mojom::MediaStreamType::DISPLAY_AUDIO_CAPTURE,
                  tab.ToString(), "Tab audio");
  }
  return OneStream(std::move(sound), std::move(device));
}

}  // namespace domicile
