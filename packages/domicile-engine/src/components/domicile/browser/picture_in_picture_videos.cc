// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/browser/picture_in_picture_videos.h"

#include <algorithm>
#include <utility>

#include "base/check.h"
#include "base/functional/bind.h"
#include "base/memory/ptr_util.h"
#include "base/strings/string_number_conversions.h"

namespace domicile {

PictureInPictureVideos::Shown::Shown() = default;
PictureInPictureVideos::Shown::Shown(Shown&&) = default;
PictureInPictureVideos::Shown& PictureInPictureVideos::Shown::operator=(
    Shown&&) = default;
PictureInPictureVideos::Shown::~Shown() = default;

PictureInPictureVideos::Video::Video() = default;
PictureInPictureVideos::Video::Video(Video&&) = default;
PictureInPictureVideos::Video& PictureInPictureVideos::Video::operator=(
    Video&&) = default;
PictureInPictureVideos::Video::~Video() = default;

PictureInPictureVideos::Listing::Listing(
    base::WeakPtr<PictureInPictureVideos> videos,
    std::string id)
    : videos_(std::move(videos)), id_(std::move(id)) {}

PictureInPictureVideos::Listing::~Listing() {
  if (videos_) {
    videos_->Unlist(id_);
  }
}

void PictureInPictureVideos::Listing::SetSize(const gfx::Size& size) {
  Video* video = videos_->Find(id_);
  CHECK(video);
  if (video->listed.size != size) {
    video->listed.size = size;
    videos_->Changed();
  }
}

void PictureInPictureVideos::Listing::SetPlaying(bool playing) {
  Video* video = videos_->Find(id_);
  CHECK(video);
  if (video->listed.playing != playing) {
    video->listed.playing = playing;
    videos_->Changed();
  }
}

void PictureInPictureVideos::Listing::SetControls(bool can_play,
                                                  bool can_previous_track,
                                                  bool can_next_track) {
  Video* video = videos_->Find(id_);
  CHECK(video);
  if (video->listed.can_play != can_play ||
      video->listed.can_previous_track != can_previous_track ||
      video->listed.can_next_track != can_next_track) {
    video->listed.can_play = can_play;
    video->listed.can_previous_track = can_previous_track;
    video->listed.can_next_track = can_next_track;
    videos_->Changed();
  }
}

void PictureInPictureVideos::Listing::SetPosition(double duration,
                                                  double position,
                                                  double rate) {
  Video* video = videos_->Find(id_);
  CHECK(video);
  if (video->listed.duration != duration ||
      video->listed.position != position ||
      video->listed.playback_rate != rate) {
    video->listed.duration = duration;
    video->listed.position = position;
    video->listed.playback_rate = rate;
    videos_->Changed();
  }
}

void PictureInPictureVideos::Listing::SetSurface(
    const viz::SurfaceId& surface_id) {
  Video* video = videos_->Find(id_);
  CHECK(video);
  video->surface = surface_id;
  for (Shown& shown : video->shown) {
    videos_->Embed(*video, shown);
  }
}

PictureInPictureVideos::PictureInPictureVideos(
    AddFrameSinkChild add_frame_sink_child)
    : add_frame_sink_child_(std::move(add_frame_sink_child)) {}

PictureInPictureVideos::~PictureInPictureVideos() = default;

std::unique_ptr<PictureInPictureVideos::Listing> PictureInPictureVideos::List(
    const std::string& window,
    Controls* controls) {
  CHECK(controls);
  const std::string id = base::NumberToString(next_id_++);
  Video video;
  video.listed.id = id;
  video.listed.window = window;
  video.controls = controls;
  videos_.emplace_back(id, std::move(video));
  Changed();
  return base::WrapUnique(new Listing(weak_factory_.GetWeakPtr(), id));
}

void PictureInPictureVideos::Bind(
    mojo::PendingReceiver<mojom::PictureInPictureVideos> receiver,
    uint32_t renderer_client_id) {
  receivers_.Add(this, std::move(receiver), renderer_client_id);
}

void PictureInPictureVideos::SetClient(
    mojo::PendingRemote<mojom::PictureInPictureVideosClient> client) {
  const mojo::RemoteSetElementId added = clients_.Add(std::move(client));
  Send(*clients_.Get(added));
}

void PictureInPictureVideos::Act(const std::string& id,
                                 mojom::PictureInPictureAction action) {
  if (Video* video = Find(id)) {
    video->controls->Act(action);
  }
}

void PictureInPictureVideos::Resize(const std::string& id,
                                    const gfx::Size& size) {
  if (Video* video = Find(id)) {
    video->controls->Resized(size);
  }
}

// The page names its own frame sink as the parent, as for
// ExternalSurfaceProvider::Embed; it must be in the calling renderer's
// namespace, as content::EmbeddedFrameSinkProviderImpl requires.
void PictureInPictureVideos::Show(
    const std::string& id,
    const viz::FrameSinkId& parent_frame_sink_id,
    mojo::PendingRemote<mojom::PictureInPictureVideoSurface> surface) {
  if (parent_frame_sink_id.client_id() != receivers_.current_context()) {
    receivers_.ReportBadMessage("parent frame sink is not the renderer's");
    return;
  }
  Video* video = Find(id);
  if (!video) {
    // Dropping `surface` tells the element the video is gone.
    return;
  }
  Shown& shown = video->shown.emplace_back();
  shown.parent = parent_frame_sink_id;
  shown.surface.Bind(std::move(surface));
  // Unretained: the video owns `shown`, and this owns the video. Its list
  // never moves an element, so the address stays good until it is erased.
  shown.surface.set_disconnect_handler(base::BindOnce(
      [](PictureInPictureVideos* videos, std::string id, Shown* gone) {
        if (Video* video = videos->Find(id)) {
          std::erase_if(video->shown,
                        [gone](const Shown& shown) { return &shown == gone; });
        }
      },
      base::Unretained(this), id, base::Unretained(&shown)));
  Embed(*video, shown);
}

PictureInPictureVideos::Video* PictureInPictureVideos::Find(
    const std::string& id) {
  auto it =
      std::ranges::find(videos_, id, &std::pair<std::string, Video>::first);
  return it == videos_.end() ? nullptr : &it->second;
}

void PictureInPictureVideos::Embed(const Video& video, Shown& shown) {
  if (!video.surface.is_valid()) {
    // The player has drawn nothing yet; SetSurface comes back here.
    return;
  }
  const viz::FrameSinkId& child = video.surface.frame_sink_id();
  // A resize keeps the same sink, which stays a child once. Another player
  // of the page draws to another: it becomes a child before the old one is
  // undone, so neither misses a BeginFrame.
  if (shown.child_sink != child) {
    base::ScopedClosureRunner old = std::move(shown.child);
    shown.child = HoldChild(shown.parent, child);
    shown.child_sink = child;
  }
  shown.surface->SurfaceChanged(video.surface);
}

base::ScopedClosureRunner PictureInPictureVideos::HoldChild(
    const viz::FrameSinkId& parent,
    const viz::FrameSinkId& child) {
  auto& [holders, undo] = children_[{parent, child}];
  if (holders++ == 0) {
    undo = add_frame_sink_child_.Run(parent, child);
  }
  return base::ScopedClosureRunner(
      base::BindOnce(&PictureInPictureVideos::ReleaseChild,
                     weak_factory_.GetWeakPtr(), parent, child));
}

void PictureInPictureVideos::ReleaseChild(const viz::FrameSinkId& parent,
                                          const viz::FrameSinkId& child) {
  auto it = children_.find({parent, child});
  CHECK(it != children_.end());
  if (--it->second.first == 0) {
    children_.erase(it);
  }
}

void PictureInPictureVideos::Unlist(const std::string& id) {
  // The video's shown surfaces go with it, which undoes each child and tells
  // each element.
  std::erase_if(videos_, [&id](const std::pair<std::string, Video>& video) {
    return video.first == id;
  });
  Changed();
}

void PictureInPictureVideos::Changed() {
  for (const mojo::Remote<mojom::PictureInPictureVideosClient>& client :
       clients_) {
    Send(*client);
  }
}

void PictureInPictureVideos::Send(
    mojom::PictureInPictureVideosClient& client) const {
  std::vector<mojom::PictureInPictureVideoPtr> videos;
  for (const auto& [id, video] : videos_) {
    videos.push_back(video.listed.Clone());
  }
  client.VideosChanged(std::move(videos));
}

}  // namespace domicile
