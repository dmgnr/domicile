// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef THIRD_PARTY_BLINK_RENDERER_MODULES_DOMICILE_DOMICILE_PICTURE_IN_PICTURE_VIDEO_H_
#define THIRD_PARTY_BLINK_RENDERER_MODULES_DOMICILE_DOMICILE_PICTURE_IN_PICTURE_VIDEO_H_

#include "components/domicile/mojom/picture_in_picture.mojom-blink.h"
#include "third_party/blink/renderer/modules/modules_export.h"
#include "third_party/blink/renderer/platform/bindings/script_wrappable.h"
#include "third_party/blink/renderer/platform/wtf/text/wtf_string.h"

namespace blink {

// A video in picture-in-picture, as the browser listed it.
//
// Immutable, like DomicileBrowserWindow, and for its reason.
class MODULES_EXPORT DomicilePictureInPictureVideo final
    : public ScriptWrappable {
  DEFINE_WRAPPERTYPEINFO();

 public:
  explicit DomicilePictureInPictureVideo(
      const domicile::mojom::blink::PictureInPictureVideo& video);
  ~DomicilePictureInPictureVideo() override;

  const String& id() const { return id_; }
  const String& window() const { return window_; }
  int32_t width() const { return width_; }
  int32_t height() const { return height_; }
  bool playing() const { return playing_; }
  bool canPlay() const { return can_play_; }
  bool canPreviousTrack() const { return can_previous_track_; }
  bool canNextTrack() const { return can_next_track_; }
  double duration() const { return duration_; }
  double position() const { return position_; }
  double playbackRate() const { return playback_rate_; }

  void Trace(Visitor*) const override;

 private:
  String id_;
  String window_;
  int32_t width_;
  int32_t height_;
  bool playing_;
  bool can_play_;
  bool can_previous_track_;
  bool can_next_track_;
  double duration_;
  double position_;
  double playback_rate_;
};

}  // namespace blink

#endif  // THIRD_PARTY_BLINK_RENDERER_MODULES_DOMICILE_DOMICILE_PICTURE_IN_PICTURE_VIDEO_H_
