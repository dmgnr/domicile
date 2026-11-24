// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef COMPONENTS_DOMICILE_BROWSER_SCREEN_CAPTURE_H_
#define COMPONENTS_DOMICILE_BROWSER_SCREEN_CAPTURE_H_

#include <cstdint>
#include <string>

#include "content/public/browser/desktop_media_id.h"
#include "content/public/browser/web_contents_media_capture_id.h"
#include "media/mojo/mojom/capture_handle.mojom.h"
#include "third_party/blink/public/mojom/mediastream/media_stream.mojom.h"

namespace domicile {

// Whether a media request asking for `video` is a page's `getDisplayMedia()`,
// with or without `preferCurrentTab`, or a `getUserMedia()` with
// `chromeMediaSource: "desktop"`, as Electron apps ask with a
// `desktopCapturer` source. All open the desktop's picker, whose browser
// windows include the page's own: the picker, not the source's id, says what
// is captured.
bool IsScreenCapture(blink::mojom::MediaStreamType video);

// Whether a screen capture asking for `audio` wants the source's sound:
// `getDisplayMedia()`'s `audio`, or a desktop `getUserMedia()`'s.
bool WantsScreenSound(blink::mojom::MediaStreamType audio);

// `answer`, its video and sound as the request's `video` and `audio` types
// ask: content opens a `preferCurrentTab` or desktop `getUserMedia()`
// request's pick as its own types.
blink::mojom::StreamDevicesSetPtr AsRequested(
    blink::mojom::MediaStreamType video,
    blink::mojom::MediaStreamType audio,
    blink::mojom::StreamDevicesSetPtr answer);

// What the desktop says a ScreenCast portal pick shows: the compositor's
// `org.domicile.ScreenCast.Pick` (see AskWhatThePortalPicked).
struct PortalPick {
  // The ScreenCast portal's source type: 1 a monitor, 2 a window, 4 a region.
  uint32_t source_type = 1;
  // The browser window it is, by the desk's id, or empty for any other
  // source.
  std::string browser_window;
  // The PipeWire node carrying its sound, or empty when it carries none.
  std::string sound;

  friend bool operator==(const PortalPick&, const PortalPick&) = default;
};

// The answer to a page's `getDisplayMedia()` once the desktop's ScreenCast
// portal picked a window, a monitor or a region (see ScreenChoice): one screen,
// of the surface `pick` names, and its sound when `audio` is asked for and the
// pick carries any.
//
// `source` is the webrtc source id the pick's restore token is kept under.
// The capture selects it, so its own portal session restores the pick rather
// than asking again. See content::desktop_capture::CreateScreenCapturer.
//
// The sound is the pick's PipeWire node, which the audio service's PulseAudio
// input opens by name, as PipeWire's PulseAudio server lists it.
blink::mojom::StreamDevicesSetPtr PortalScreenCapture(
    content::DesktopMediaID::Id source,
    const PortalPick& pick,
    bool audio);

// The answer to a page's `getDisplayMedia()` once the user picked a browser
// window: its page, captured as Chrome captures a tab, so the page gets the
// tab's sound, `cropTo()` and the captured page's `handle`. The page's
// `suppressLocalAudioPlayback` is `tab.disable_local_echo`.
blink::mojom::StreamDevicesSetPtr TabCapture(
    const content::WebContentsMediaCaptureId& tab,
    media::mojom::CaptureHandlePtr handle,
    bool audio);

}  // namespace domicile

#endif  // COMPONENTS_DOMICILE_BROWSER_SCREEN_CAPTURE_H_
