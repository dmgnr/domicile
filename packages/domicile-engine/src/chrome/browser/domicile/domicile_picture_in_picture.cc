// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "chrome/browser/domicile/domicile_picture_in_picture.h"

#include <memory>
#include <string>
#include <utility>
#include <vector>

#include "base/check.h"
#include "base/functional/bind.h"
#include "base/memory/raw_ptr.h"
#include "base/no_destructor.h"
#include "base/numerics/safe_conversions.h"
#include "base/time/time.h"
#include "components/domicile/browser/picture_in_picture_videos.h"
#include "components/domicile/browser/web_view_guest.h"
#include "components/viz/common/surfaces/surface_id.h"
#include "content/public/browser/domicile_desk.h"
#include "content/public/browser/overlay_window.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/render_process_host.h"
#include "content/public/browser/video_picture_in_picture_window_controller.h"
#include "content/public/browser/web_contents.h"
#include "services/media_session/public/cpp/media_position.h"
#include "ui/gfx/geometry/rect.h"
#include "ui/gfx/geometry/size.h"

namespace domicile {
namespace {

PictureInPictureVideos& Videos() {
  static base::NoDestructor<PictureInPictureVideos> videos(
      base::BindRepeating(&content::AddDomicileFrameSinkChild));
  return *videos;
}

// The browser window whose page `contents` is, or empty for a page in a
// <webview> that is none, and for the shell's own.
std::string WindowOf(content::WebContents* contents) {
  WebViewGuest* guest = WebViewGuest::FromWebContents(contents);
  return guest ? guest->window_id() : std::string();
}

// Chrome's VideoOverlayWindowViews is a widget of its own, with its own
// controls. This one is listed while it is shown, and the shell draws it.
//
// The controller keeps it across sessions: a hidden window is shown again for
// the next video of its page, which the shell hears as a new video.
class ShellVideoOverlayWindow : public content::VideoOverlayWindow,
                                public PictureInPictureVideos::Controls {
 public:
  explicit ShellVideoOverlayWindow(
      content::VideoPictureInPictureWindowController* controller)
      : controller_(controller) {
    CHECK(controller_);
  }

  ShellVideoOverlayWindow(const ShellVideoOverlayWindow&) = delete;
  ShellVideoOverlayWindow& operator=(const ShellVideoOverlayWindow&) = delete;

  ~ShellVideoOverlayWindow() override = default;

  // content::VideoOverlayWindow:
  // The shell's float never takes the keyboard.
  bool IsActive() const override { return false; }
  // The controller's page is being destroyed: only leave the list.
  void Close() override { listing_.reset(); }
  void ShowInactive() override {
    if (listing_) {
      return;
    }
    listing_ = Videos().List(WindowOf(controller_->GetWebContents()), this);
    listing_->SetSize(natural_size_);
    listing_->SetPlaying(playing_);
    listing_->SetControls(can_play_, can_previous_track_, can_next_track_);
    listing_->SetPosition(duration_, position_, rate_);
    listing_->SetSurface(surface_id_);
  }
  void Hide() override { listing_.reset(); }
  bool IsVisible() const override { return !!listing_; }
  // Its size where the shell shows it, or the video's own until the shell
  // says. The page reads it as its PictureInPictureWindow's.
  gfx::Rect GetBounds() override {
    return gfx::Rect(shown_size_.IsEmpty() ? natural_size_ : shown_size_);
  }
  void UpdateNaturalSize(const gfx::Size& natural_size) override {
    natural_size_ = natural_size;
    if (listing_) {
      listing_->SetSize(natural_size_);
    }
  }
  void SetPlaybackState(PlaybackState playback_state) override {
    playing_ = playback_state == PlaybackState::kPlaying;
    if (listing_) {
      listing_->SetPlaying(playing_);
    }
  }
  void SetPlayPauseButtonVisibility(bool is_visible) override {
    can_play_ = is_visible;
    ControlsChanged();
  }
  void SetNextTrackButtonVisibility(bool is_visible) override {
    can_next_track_ = is_visible;
    ControlsChanged();
  }
  void SetPreviousTrackButtonVisibility(bool is_visible) override {
    can_previous_track_ = is_visible;
    ControlsChanged();
  }
  void SetSurfaceId(const viz::SurfaceId& surface_id) override {
    surface_id_ = surface_id;
    if (listing_) {
      listing_->SetSurface(surface_id_);
    }
  }
  // Controls the shell does not draw: skipping an ad, a call's microphone,
  // camera and hang-up, slides, muting, and the page's title and icon, which
  // the shell reads off the video's window.
  void SetSkipAdButtonVisibility(bool is_visible) override {}
  void SetHidePictureInPictureButtonVisibility(bool is_visible) override {}
  void SetMicrophoneMuted(bool muted) override {}
  void SetCameraState(bool turned_on) override {}
  void SetMediaMuted(bool muted) override {}
  void SetToggleMicrophoneButtonVisibility(bool is_visible) override {}
  void SetToggleCameraButtonVisibility(bool is_visible) override {}
  void SetHangUpButtonVisibility(bool is_visible) override {}
  void SetNextSlideButtonVisibility(bool is_visible) override {}
  void SetPreviousSlideButtonVisibility(bool is_visible) override {}
  void SetMediaPosition(const media_session::MediaPosition& position) override {
    // A live stream's length is infinite, which the shell shows as none.
    const base::TimeDelta duration = position.duration();
    duration_ = duration.is_inf() ? 0 : duration.InSecondsF();
    position_ = position.GetPosition().InSecondsF();
    rate_ = position.playback_rate();
    if (listing_) {
      listing_->SetPosition(duration_, position_, rate_);
    }
  }
  void SetSourceTitle(const std::u16string& source_title) override {}
  void SetFaviconImages(
      const std::vector<media_session::MediaImage>& images) override {}
  void SetPlaybackControlsVisibility(bool is_visible) override {}
  // Android XR's alone; content never asks for it here.
  void SetImmersiveVideoOptions(
      const content::ImmersiveOptions& options) override {}

  // PictureInPictureVideos::Controls:
  // As Chrome's window's buttons do: see VideoOverlayWindowViews.
  void Act(mojom::PictureInPictureAction action) override {
    switch (action) {
      case mojom::PictureInPictureAction::kPlay:
        controller_->Play();
        return;
      case mojom::PictureInPictureAction::kPause:
        controller_->Pause();
        return;
      case mojom::PictureInPictureAction::kPreviousTrack:
        controller_->PreviousTrack();
        return;
      case mojom::PictureInPictureAction::kNextTrack:
        controller_->NextTrack();
        return;
      case mojom::PictureInPictureAction::kBackToPage:
        controller_->CloseAndFocusInitiator();
        return;
      case mojom::PictureInPictureAction::kClose:
        controller_->Close(/*should_pause_video=*/true);
        return;
    }
  }
  void Resized(const gfx::Size& size) override {
    shown_size_ = size;
    controller_->UpdateLayerBounds();
  }

 private:
  void ControlsChanged() {
    if (listing_) {
      listing_->SetControls(can_play_, can_previous_track_, can_next_track_);
    }
  }

  // Owns this.
  const raw_ptr<content::VideoPictureInPictureWindowController> controller_;

  // The video, as the controller last said. Kept while hidden, since the
  // controller sets it before it shows the window.
  gfx::Size natural_size_;
  bool playing_ = false;
  bool can_play_ = false;
  bool can_previous_track_ = false;
  bool can_next_track_ = false;
  double duration_ = 0;
  double position_ = 0;
  double rate_ = 0;
  viz::SurfaceId surface_id_;

  // Where the shell last said it shows the video; empty before it said.
  gfx::Size shown_size_;

  // Present while shown.
  std::unique_ptr<PictureInPictureVideos::Listing> listing_;
};

}  // namespace

std::unique_ptr<content::VideoOverlayWindow> CreateVideoPictureInPictureWindow(
    content::VideoPictureInPictureWindowController* controller) {
  return std::make_unique<ShellVideoOverlayWindow>(controller);
}

void BindPictureInPictureVideos(
    content::RenderFrameHost* frame,
    mojo::PendingReceiver<mojom::PictureInPictureVideos> receiver) {
  // A frame sink's client id is its renderer's process id; see
  // RenderProcessHostImpl::CreateEmbeddedFrameSinkProvider.
  Videos().Bind(
      std::move(receiver),
      base::checked_cast<uint32_t>(frame->GetProcess()->GetDeprecatedID()));
}

}  // namespace domicile
