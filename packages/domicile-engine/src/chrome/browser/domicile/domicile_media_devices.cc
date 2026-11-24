// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "chrome/browser/domicile/domicile_media_devices.h"

#include <algorithm>
#include <string>
#include <utility>
#include <vector>

#include "base/check.h"
#include "base/functional/bind.h"
#include "base/functional/callback.h"
#include "base/location.h"
#include "base/logging.h"
#include "base/no_destructor.h"
#include "base/strings/strcat.h"
#include "base/time/time.h"
#include "base/timer/timer.h"
#include "base/types/expected.h"
#include "chrome/browser/media/prefs/capture_device_ranking.h"
#include "chrome/browser/media/webrtc/media_capture_devices_dispatcher.h"
#include "components/domicile/browser/command_protocol.h"
#include "components/prefs/pref_service.h"
#include "content/public/browser/browser_thread.h"
#include "third_party/blink/public/common/mediastream/media_stream_request.h"

namespace domicile {
namespace {

std::vector<MediaDevice> Listed(const blink::MediaStreamDevices& devices) {
  std::vector<MediaDevice> listed;
  for (const blink::MediaStreamDevice& device : devices) {
    listed.push_back({.id = device.id, .name = device.name});
  }
  return listed;
}

// How long a first list may take before the engine says so. Chrome lists
// devices in well under a second; one that never comes is a bug.
constexpr base::TimeDelta kListDeadline = base::Seconds(10);

// Whether Chrome has listed each kind, and who waits for both. Chrome sends a
// first list of each kind once it starts listing, whoever started it.
class DeviceLists : public MediaCaptureDevicesDispatcher::Observer {
 public:
  static DeviceLists& Get() {
    static base::NoDestructor<DeviceLists> lists;
    return *lists;
  }

  void Hear() {
    CHECK(!hearing_) << "domicile: the engine heard device lists twice";
    hearing_ = true;
    MediaCaptureDevicesDispatcher::GetInstance()->AddObserver(this);
  }

  void WhenListed(base::OnceClosure listed) {
    CHECK(hearing_) << "domicile: devices were asked for before the engine "
                       "heard device lists, so their list could be missed";
    if (Listed()) {
      std::move(listed).Run();
      return;
    }
    waiting_.push_back(std::move(listed));
    if (!deadline_.IsRunning()) {
      deadline_.Start(
          FROM_HERE, kListDeadline,
          base::BindOnce(&DeviceLists::Overdue, base::Unretained(this)));
    }
    // Starts Chrome listing both kinds, or does nothing if it has started.
    MediaCaptureDevicesDispatcher::GetInstance()->GetVideoCaptureDevices();
  }

  // MediaCaptureDevicesDispatcher::Observer:
  void OnUpdateAudioDevices(const blink::MediaStreamDevices&) override {
    microphones_listed_ = true;
    RunIfListed();
  }
  void OnUpdateVideoDevices(const blink::MediaStreamDevices&) override {
    cameras_listed_ = true;
    RunIfListed();
  }

 private:
  bool Listed() const { return microphones_listed_ && cameras_listed_; }

  void RunIfListed() {
    if (Listed()) {
      deadline_.Stop();
      RunWaiting();
    }
  }

  void Overdue() {
    LOG(ERROR) << "domicile: Chrome listed " << (cameras_listed_ ? "the" : "no")
               << " cameras and " << (microphones_listed_ ? "the" : "no")
               << " microphones within " << kListDeadline
               << " of being asked; answering with what it has";
    RunWaiting();
  }

  void RunWaiting() {
    std::vector<base::OnceClosure> waiting = std::move(waiting_);
    waiting_.clear();
    for (base::OnceClosure& listed : waiting) {
      std::move(listed).Run();
    }
  }

  bool hearing_ = false;
  bool cameras_listed_ = false;
  bool microphones_listed_ = false;
  std::vector<base::OnceClosure> waiting_;
  base::OneShotTimer deadline_;
};

}  // namespace

MediaDeviceList RankedMediaDevices(PrefService& prefs) {
  CHECK_CURRENTLY_ON(content::BrowserThread::UI);
  MediaCaptureDevicesDispatcher* dispatcher =
      MediaCaptureDevicesDispatcher::GetInstance();
  blink::MediaStreamDevices cameras = dispatcher->GetVideoCaptureDevices();
  media_prefs::PreferenceRankVideoDeviceInfos(prefs, cameras);
  blink::MediaStreamDevices microphones = dispatcher->GetAudioCaptureDevices();
  media_prefs::PreferenceRankAudioDeviceInfos(prefs, microphones);
  MediaDeviceList list;
  list.cameras = Listed(cameras);
  list.microphones = Listed(microphones);
  return list;
}

base::expected<void, std::string> PreferMediaDevice(PrefService& prefs,
                                                    MediaDeviceKind kind,
                                                    const std::string& id) {
  CHECK_CURRENTLY_ON(content::BrowserThread::UI);
  MediaCaptureDevicesDispatcher* dispatcher =
      MediaCaptureDevicesDispatcher::GetInstance();
  const blink::MediaStreamDevices& devices =
      kind == MediaDeviceKind::kCamera ? dispatcher->GetVideoCaptureDevices()
                                       : dispatcher->GetAudioCaptureDevices();
  const auto found =
      std::ranges::find(devices, id, &blink::MediaStreamDevice::id);
  if (found == devices.end()) {
    return base::unexpected(base::StrCat(
        {"no connected ",
         kind == MediaDeviceKind::kCamera ? "camera" : "microphone",
         " has the id \"", id, "\""}));
  }
  switch (kind) {
    case MediaDeviceKind::kCamera:
      media_prefs::UpdateVideoDevicePreferenceRanking(prefs, found, devices);
      break;
    case MediaDeviceKind::kMicrophone:
      media_prefs::UpdateAudioDevicePreferenceRanking(prefs, found, devices);
      break;
  }
  return base::ok();
}

void HearMediaDeviceLists() {
  CHECK_CURRENTLY_ON(content::BrowserThread::UI);
  DeviceLists::Get().Hear();
}

void WhenMediaDevicesListed(base::OnceClosure listed) {
  CHECK_CURRENTLY_ON(content::BrowserThread::UI);
  DeviceLists::Get().WhenListed(std::move(listed));
}

}  // namespace domicile
