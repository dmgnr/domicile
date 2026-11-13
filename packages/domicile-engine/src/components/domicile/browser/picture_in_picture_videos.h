// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef COMPONENTS_DOMICILE_BROWSER_PICTURE_IN_PICTURE_VIDEOS_H_
#define COMPONENTS_DOMICILE_BROWSER_PICTURE_IN_PICTURE_VIDEOS_H_

#include <cstdint>
#include <list>
#include <map>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include "base/functional/callback.h"
#include "base/functional/callback_helpers.h"
#include "base/memory/raw_ptr.h"
#include "base/memory/weak_ptr.h"
#include "components/domicile/mojom/picture_in_picture.mojom.h"
#include "components/viz/common/surfaces/frame_sink_id.h"
#include "components/viz/common/surfaces/surface_id.h"
#include "mojo/public/cpp/bindings/pending_receiver.h"
#include "mojo/public/cpp/bindings/pending_remote.h"
#include "mojo/public/cpp/bindings/receiver_set.h"
#include "mojo/public/cpp/bindings/remote.h"
#include "mojo/public/cpp/bindings/remote_set.h"
#include "ui/gfx/geometry/size.h"

namespace domicile {

// The videos in picture-in-picture, as the shell lists and shows them. See
// components/domicile/mojom/picture_in_picture.mojom.
//
// //chrome lists a video for each picture-in-picture window Chrome would have
// floated (chrome/browser/domicile/domicile_picture_in_picture.h), and serves
// the shell's documents from here. Nothing here needs a browser, so tests
// drive it directly. UI thread only.
class PictureInPictureVideos : public mojom::PictureInPictureVideos {
 public:
  // What a listed video's page does for the shell's controls.
  class Controls {
   public:
    virtual ~Controls() = default;
    virtual void Act(mojom::PictureInPictureAction action) = 0;
    // The shell shows the video `size` big, in CSS pixels.
    virtual void Resized(const gfx::Size& size) = 0;
  };

  // A video's place in the list. Destroying it takes the video out, and drops
  // every surface the shell shows of it.
  class Listing {
   public:
    Listing(const Listing&) = delete;
    Listing& operator=(const Listing&) = delete;
    ~Listing();

    const std::string& id() const { return id_; }

    void SetSize(const gfx::Size& size);
    void SetPlaying(bool playing);
    void SetControls(bool can_play,
                     bool can_previous_track,
                     bool can_next_track);
    // Its length and position in seconds, and its playback rate.
    void SetPosition(double duration, double position, double rate);
    // The surface the video's player draws to now.
    void SetSurface(const viz::SurfaceId& surface_id);

   private:
    friend class PictureInPictureVideos;
    Listing(base::WeakPtr<PictureInPictureVideos> videos, std::string id);

    const base::WeakPtr<PictureInPictureVideos> videos_;
    const std::string id_;
  };

  // Makes the video's frame sink `child` a child of the page's `parent`, and
  // returns what undoes it. Injected: the HostFrameSinkManager is //content's.
  using AddFrameSinkChild = base::RepeatingCallback<base::ScopedClosureRunner(
      const viz::FrameSinkId& parent,
      const viz::FrameSinkId& child)>;

  explicit PictureInPictureVideos(AddFrameSinkChild add_frame_sink_child);

  PictureInPictureVideos(const PictureInPictureVideos&) = delete;
  PictureInPictureVideos& operator=(const PictureInPictureVideos&) = delete;

  ~PictureInPictureVideos() override;

  // Lists a video of browser window `window`'s page, whose controls are
  // `controls` until the listing goes. Its id is the next unused one.
  std::unique_ptr<Listing> List(const std::string& window, Controls* controls);

  // Binds a document in the renderer whose frame sinks have client id
  // `renderer_client_id`.
  void Bind(mojo::PendingReceiver<mojom::PictureInPictureVideos> receiver,
            uint32_t renderer_client_id);

  // mojom::PictureInPictureVideos:
  void SetClient(
      mojo::PendingRemote<mojom::PictureInPictureVideosClient> client) override;
  void Act(const std::string& id,
           mojom::PictureInPictureAction action) override;
  void Resize(const std::string& id, const gfx::Size& size) override;
  void Show(const std::string& id,
            const viz::FrameSinkId& parent_frame_sink_id,
            mojo::PendingRemote<mojom::PictureInPictureVideoSurface> surface)
      override;

 private:
  // One shell element showing a video.
  struct Shown {
    Shown();
    Shown(Shown&&);
    Shown& operator=(Shown&&);
    ~Shown();

    viz::FrameSinkId parent;
    mojo::Remote<mojom::PictureInPictureVideoSurface> surface;
    // The video's frame sink made a child of `parent`, and what releases it.
    // Invalid, and empty, before the video has a surface.
    viz::FrameSinkId child_sink;
    base::ScopedClosureRunner child;
  };

  // One listed video.
  struct Video {
    Video();
    Video(Video&&);
    Video& operator=(Video&&);
    ~Video();

    mojom::PictureInPictureVideo listed;
    raw_ptr<Controls> controls;
    viz::SurfaceId surface;
    std::list<Shown> shown;
  };

  // The video named `id`, or null.
  Video* Find(const std::string& id);

  // Tells `shown` about the video's surface, under the page's frame sink.
  void Embed(const Video& video, Shown& shown);

  // Makes `child` a child of `parent` while any element holds what this
  // returns. Viz refuses one child twice under a parent, and two elements may
  // show one video.
  base::ScopedClosureRunner HoldChild(const viz::FrameSinkId& parent,
                                      const viz::FrameSinkId& child);
  void ReleaseChild(const viz::FrameSinkId& parent,
                    const viz::FrameSinkId& child);

  void Unlist(const std::string& id);
  void Changed();
  void Send(mojom::PictureInPictureVideosClient& client) const;

  const AddFrameSinkChild add_frame_sink_child_;
  // Each (parent, child) made a child: how many elements hold it, and what
  // undoes it.
  std::map<std::pair<viz::FrameSinkId, viz::FrameSinkId>,
           std::pair<int, base::ScopedClosureRunner>>
      children_;
  uint64_t next_id_ = 1;
  // By id; listed oldest first, which is id order once ids are numbers.
  std::vector<std::pair<std::string, Video>> videos_;

  mojo::ReceiverSet<mojom::PictureInPictureVideos, uint32_t> receivers_;
  mojo::RemoteSet<mojom::PictureInPictureVideosClient> clients_;

  base::WeakPtrFactory<PictureInPictureVideos> weak_factory_{this};
};

}  // namespace domicile

#endif  // COMPONENTS_DOMICILE_BROWSER_PICTURE_IN_PICTURE_VIDEOS_H_
