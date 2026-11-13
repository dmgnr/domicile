// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "third_party/blink/renderer/modules/domicile/domicile_picture_in_picture_video.h"

namespace blink {

DomicilePictureInPictureVideo::DomicilePictureInPictureVideo(
    const domicile::mojom::blink::PictureInPictureVideo& video)
    : id_(video.id),
      window_(video.window),
      width_(video.size.width()),
      height_(video.size.height()),
      playing_(video.playing),
      can_play_(video.can_play),
      can_previous_track_(video.can_previous_track),
      can_next_track_(video.can_next_track),
      duration_(video.duration),
      position_(video.position),
      playback_rate_(video.playback_rate) {}

DomicilePictureInPictureVideo::~DomicilePictureInPictureVideo() = default;

void DomicilePictureInPictureVideo::Trace(Visitor* visitor) const {
  ScriptWrappable::Trace(visitor);
}

}  // namespace blink
