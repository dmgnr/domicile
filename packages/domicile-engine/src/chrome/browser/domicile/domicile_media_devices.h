// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef CHROME_BROWSER_DOMICILE_DOMICILE_MEDIA_DEVICES_H_
#define CHROME_BROWSER_DOMICILE_DOMICILE_MEDIA_DEVICES_H_

#include <string>

#include "base/functional/callback_forward.h"
#include "base/types/expected.h"
#include "components/domicile/browser/command_protocol.h"

class PrefService;

namespace domicile {

// The camera and microphone a page gets when it names none: Chrome's device
// ranking in a profile's prefs. The Settings app reaches it through the
// command socket, and the shell through a <webview>.

// The cameras and microphones, ranked by `prefs` as Chrome ranks them for a
// page that names no device
// (MediaCaptureDevicesDispatcher::GetPreferredVideoDeviceForBrowserContext).
MediaDeviceList RankedMediaDevices(PrefService& prefs);

// Ranks device `id` above every other connected device of its kind, as
// Chrome's own camera and microphone settings do, or says why not.
base::expected<void, std::string> PreferMediaDevice(PrefService& prefs,
                                                    MediaDeviceKind kind,
                                                    const std::string& id);

// Hears every device list Chrome makes from now on. Lists nothing itself:
// listing starts Chrome's audio service, which then stays up for the session.
// Called once, at startup.
void HearMediaDeviceLists();

// Runs `listed` once Chrome has listed the cameras and the microphones: at
// once if it has, else when its first list of each arrives. The first call
// starts Chrome listing them. Needs HearMediaDeviceLists first.
void WhenMediaDevicesListed(base::OnceClosure listed);

}  // namespace domicile

#endif  // CHROME_BROWSER_DOMICILE_DOMICILE_MEDIA_DEVICES_H_
