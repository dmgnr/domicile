// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/browser/picture_in_picture_videos.h"

#include <memory>
#include <string>
#include <utility>
#include <vector>

#include "base/functional/bind.h"
#include "base/functional/callback_helpers.h"
#include "base/run_loop.h"
#include "base/test/task_environment.h"
#include "base/unguessable_token.h"
#include "components/domicile/mojom/picture_in_picture.mojom.h"
#include "components/viz/common/surfaces/frame_sink_id.h"
#include "components/viz/common/surfaces/local_surface_id.h"
#include "components/viz/common/surfaces/surface_id.h"
#include "mojo/public/cpp/bindings/receiver.h"
#include "mojo/public/cpp/bindings/remote.h"
#include "mojo/public/cpp/test_support/test_utils.h"
#include "testing/gmock/include/gmock/gmock.h"
#include "testing/gtest/include/gtest/gtest.h"
#include "ui/gfx/geometry/size.h"

namespace domicile {
namespace {

using Action = mojom::PictureInPictureAction;

// The shell's frame sink, in its renderer's namespace.
constexpr viz::FrameSinkId kShell(7, 1);

viz::SurfaceId Surface(uint32_t client, uint32_t sequence) {
  return viz::SurfaceId(
      viz::FrameSinkId(client, 3),
      viz::LocalSurfaceId(
          sequence, 1,
          base::UnguessableToken::CreateForTesting(client, sequence)));
}

class RecordingControls : public PictureInPictureVideos::Controls {
 public:
  void Act(Action action) override { acts.push_back(action); }
  void Resized(const gfx::Size& size) override { sizes.push_back(size); }

  std::vector<Action> acts;
  std::vector<gfx::Size> sizes;
};

class RecordingClient : public mojom::PictureInPictureVideosClient {
 public:
  void VideosChanged(
      std::vector<mojom::PictureInPictureVideoPtr> videos) override {
    heard.push_back(std::move(videos));
  }

  // The ids each list held, in order.
  std::vector<std::vector<std::string>> Ids() const {
    std::vector<std::vector<std::string>> ids;
    for (const auto& list : heard) {
      std::vector<std::string>& one = ids.emplace_back();
      for (const auto& video : list) {
        one.push_back(video->id);
      }
    }
    return ids;
  }

  std::vector<std::vector<mojom::PictureInPictureVideoPtr>> heard;
  mojo::Receiver<mojom::PictureInPictureVideosClient> receiver{this};
};

class RecordingSurface : public mojom::PictureInPictureVideoSurface {
 public:
  void SurfaceChanged(const viz::SurfaceId& surface_id) override {
    heard.push_back(surface_id);
  }

  std::vector<viz::SurfaceId> heard;
  mojo::Receiver<mojom::PictureInPictureVideoSurface> receiver{this};
};

class PictureInPictureVideosTest : public testing::Test {
 protected:
  // A shell document in the renderer that owns `kShell`.
  mojo::Remote<mojom::PictureInPictureVideos> Shell() {
    mojo::Remote<mojom::PictureInPictureVideos> shell;
    videos_.Bind(shell.BindNewPipeAndPassReceiver(), kShell.client_id());
    return shell;
  }

  // The (parent, child) frame sinks made children and not yet undone.
  std::vector<std::pair<viz::FrameSinkId, viz::FrameSinkId>> children_;

  void RunUntilIdle() { base::RunLoop().RunUntilIdle(); }

  base::test::SingleThreadTaskEnvironment task_environment_;
  RecordingControls controls_;
  PictureInPictureVideos videos_{base::BindRepeating(
      [](std::vector<std::pair<viz::FrameSinkId, viz::FrameSinkId>>* children,
         const viz::FrameSinkId& parent,
         const viz::FrameSinkId& child) {
        children->emplace_back(parent, child);
        return base::ScopedClosureRunner(base::BindOnce(
            [](std::vector<std::pair<viz::FrameSinkId, viz::FrameSinkId>>*
                   children,
               std::pair<viz::FrameSinkId, viz::FrameSinkId> pair) {
              std::erase(*children, pair);
            },
            children, std::make_pair(parent, child)));
      },
      &children_)};
};

TEST_F(PictureInPictureVideosTest, AShellHearsTheVideosThenEachChange) {
  std::unique_ptr<PictureInPictureVideos::Listing> listing =
      videos_.List("4", &controls_);
  listing->SetSize(gfx::Size(640, 360));
  listing->SetPlaying(true);
  listing->SetControls(/*can_play=*/true, /*can_previous_track=*/false,
                       /*can_next_track=*/true);

  mojo::Remote<mojom::PictureInPictureVideos> shell = Shell();
  RecordingClient client;
  shell->SetClient(client.receiver.BindNewPipeAndPassRemote());
  RunUntilIdle();

  ASSERT_EQ(client.heard.size(), 1u);
  ASSERT_EQ(client.heard[0].size(), 1u);
  const mojom::PictureInPictureVideo& video = *client.heard[0][0];
  EXPECT_EQ(video.id, "1");
  EXPECT_EQ(video.window, "4");
  EXPECT_EQ(video.size, gfx::Size(640, 360));
  EXPECT_TRUE(video.playing);
  EXPECT_TRUE(video.can_play);
  EXPECT_FALSE(video.can_previous_track);
  EXPECT_TRUE(video.can_next_track);

  listing->SetPlaying(false);
  RunUntilIdle();
  ASSERT_EQ(client.heard.size(), 2u);
  EXPECT_FALSE(client.heard[1][0]->playing);
}

TEST_F(PictureInPictureVideosTest, AnUnchangedVideoSendsNoList) {
  std::unique_ptr<PictureInPictureVideos::Listing> listing =
      videos_.List("4", &controls_);
  listing->SetPlaying(true);
  mojo::Remote<mojom::PictureInPictureVideos> shell = Shell();
  RecordingClient client;
  shell->SetClient(client.receiver.BindNewPipeAndPassRemote());
  RunUntilIdle();

  listing->SetPlaying(true);
  RunUntilIdle();

  EXPECT_EQ(client.heard.size(), 1u);
}

TEST_F(PictureInPictureVideosTest, AShellHearsWhereTheVideoIs) {
  std::unique_ptr<PictureInPictureVideos::Listing> listing =
      videos_.List("4", &controls_);
  mojo::Remote<mojom::PictureInPictureVideos> shell = Shell();
  RecordingClient client;
  shell->SetClient(client.receiver.BindNewPipeAndPassRemote());
  RunUntilIdle();

  listing->SetPosition(/*duration=*/270, /*position=*/102, /*rate=*/1);
  listing->SetPosition(/*duration=*/270, /*position=*/102, /*rate=*/1);
  RunUntilIdle();

  ASSERT_EQ(client.heard.size(), 2u);
  const mojom::PictureInPictureVideo& video = *client.heard[1][0];
  EXPECT_EQ(video.duration, 270);
  EXPECT_EQ(video.position, 102);
  EXPECT_EQ(video.playback_rate, 1);
}

TEST_F(PictureInPictureVideosTest, AVideoLeavesTheListWithItsListing) {
  mojo::Remote<mojom::PictureInPictureVideos> shell = Shell();
  RecordingClient client;
  shell->SetClient(client.receiver.BindNewPipeAndPassRemote());
  RunUntilIdle();

  std::unique_ptr<PictureInPictureVideos::Listing> first =
      videos_.List("4", &controls_);
  std::unique_ptr<PictureInPictureVideos::Listing> second =
      videos_.List("5", &controls_);
  first.reset();
  RunUntilIdle();

  EXPECT_THAT(client.Ids(),
              testing::ElementsAre(std::vector<std::string>{},
                                   std::vector<std::string>{"1"},
                                   std::vector<std::string>{"1", "2"},
                                   std::vector<std::string>{"2"}));
}

TEST_F(PictureInPictureVideosTest, AnIdIsNeverReused) {
  videos_.List("4", &controls_).reset();

  EXPECT_EQ(videos_.List("4", &controls_)->id(), "2");
}

TEST_F(PictureInPictureVideosTest, TheShellsControlsReachTheVideosPage) {
  RecordingControls other;
  std::unique_ptr<PictureInPictureVideos::Listing> listing =
      videos_.List("4", &controls_);
  std::unique_ptr<PictureInPictureVideos::Listing> other_listing =
      videos_.List("5", &other);
  mojo::Remote<mojom::PictureInPictureVideos> shell = Shell();

  shell->Act("1", Action::kPause);
  shell->Act("1", Action::kBackToPage);
  shell->Resize("1", gfx::Size(320, 180));
  // A video that left raced the act, which does nothing.
  shell->Act("9", Action::kClose);
  shell->Resize("9", gfx::Size(1, 1));
  RunUntilIdle();

  EXPECT_THAT(controls_.acts,
              testing::ElementsAre(Action::kPause, Action::kBackToPage));
  EXPECT_THAT(controls_.sizes, testing::ElementsAre(gfx::Size(320, 180)));
  EXPECT_TRUE(other.acts.empty());
  EXPECT_TRUE(other.sizes.empty());
}

TEST_F(PictureInPictureVideosTest, AShownVideoDrawsUnderTheShellsFrameSink) {
  std::unique_ptr<PictureInPictureVideos::Listing> listing =
      videos_.List("4", &controls_);
  listing->SetSurface(Surface(9, 1));
  mojo::Remote<mojom::PictureInPictureVideos> shell = Shell();

  RecordingSurface surface;
  shell->Show("1", kShell, surface.receiver.BindNewPipeAndPassRemote());
  RunUntilIdle();

  EXPECT_THAT(surface.heard, testing::ElementsAre(Surface(9, 1)));
  EXPECT_THAT(children_, testing::ElementsAre(std::make_pair(
                             kShell, Surface(9, 1).frame_sink_id())));
}

TEST_F(PictureInPictureVideosTest, AShownVideoHearsEachNewSurface) {
  std::unique_ptr<PictureInPictureVideos::Listing> listing =
      videos_.List("4", &controls_);
  mojo::Remote<mojom::PictureInPictureVideos> shell = Shell();
  RecordingSurface surface;
  // Shown before the player gave a surface: it hears the first.
  shell->Show("1", kShell, surface.receiver.BindNewPipeAndPassRemote());
  RunUntilIdle();
  EXPECT_TRUE(surface.heard.empty());
  EXPECT_TRUE(children_.empty());

  listing->SetSurface(Surface(9, 1));
  // Resized: the same frame sink, which stays a child once.
  listing->SetSurface(Surface(9, 2));
  RunUntilIdle();
  EXPECT_THAT(surface.heard,
              testing::ElementsAre(Surface(9, 1), Surface(9, 2)));
  EXPECT_THAT(children_, testing::ElementsAre(std::make_pair(
                             kShell, Surface(9, 1).frame_sink_id())));

  // Another player of the page took over: its sink is the child now.
  listing->SetSurface(Surface(11, 1));
  RunUntilIdle();
  EXPECT_THAT(children_, testing::ElementsAre(std::make_pair(
                             kShell, Surface(11, 1).frame_sink_id())));
}

TEST_F(PictureInPictureVideosTest, AVideoThatLeavesDropsItsShownSurfaces) {
  std::unique_ptr<PictureInPictureVideos::Listing> listing =
      videos_.List("4", &controls_);
  listing->SetSurface(Surface(9, 1));
  mojo::Remote<mojom::PictureInPictureVideos> shell = Shell();
  RecordingSurface surface;
  shell->Show("1", kShell, surface.receiver.BindNewPipeAndPassRemote());
  RunUntilIdle();
  base::RunLoop dropped;
  surface.receiver.set_disconnect_handler(dropped.QuitClosure());

  listing.reset();
  dropped.Run();

  EXPECT_TRUE(children_.empty());
}

TEST_F(PictureInPictureVideosTest, AnElementThatGoesUndoesItsChild) {
  std::unique_ptr<PictureInPictureVideos::Listing> listing =
      videos_.List("4", &controls_);
  listing->SetSurface(Surface(9, 1));
  mojo::Remote<mojom::PictureInPictureVideos> shell = Shell();
  auto surface = std::make_unique<RecordingSurface>();
  shell->Show("1", kShell, surface->receiver.BindNewPipeAndPassRemote());
  RunUntilIdle();
  ASSERT_EQ(children_.size(), 1u);

  surface.reset();
  RunUntilIdle();

  EXPECT_TRUE(children_.empty());
}

// Viz refuses one child twice under a parent.
TEST_F(PictureInPictureVideosTest, TwoElementsShowingAVideoShareItsChild) {
  std::unique_ptr<PictureInPictureVideos::Listing> listing =
      videos_.List("4", &controls_);
  listing->SetSurface(Surface(9, 1));
  mojo::Remote<mojom::PictureInPictureVideos> shell = Shell();
  auto first = std::make_unique<RecordingSurface>();
  RecordingSurface second;
  shell->Show("1", kShell, first->receiver.BindNewPipeAndPassRemote());
  shell->Show("1", kShell, second.receiver.BindNewPipeAndPassRemote());
  RunUntilIdle();
  EXPECT_THAT(second.heard, testing::ElementsAre(Surface(9, 1)));
  ASSERT_EQ(children_.size(), 1u);

  first.reset();
  RunUntilIdle();

  EXPECT_THAT(children_, testing::ElementsAre(std::make_pair(
                             kShell, Surface(9, 1).frame_sink_id())));
}

TEST_F(PictureInPictureVideosTest, ShowingAnUnknownVideoDropsTheSurface) {
  mojo::Remote<mojom::PictureInPictureVideos> shell = Shell();
  RecordingSurface surface;
  mojo::PendingRemote<mojom::PictureInPictureVideoSurface> remote =
      surface.receiver.BindNewPipeAndPassRemote();
  // A receiver takes a disconnect handler only once it is bound.
  base::RunLoop dropped;
  surface.receiver.set_disconnect_handler(dropped.QuitClosure());

  shell->Show("9", kShell, std::move(remote));
  dropped.Run();

  EXPECT_TRUE(surface.heard.empty());
}

// content::EmbeddedFrameSinkProviderImpl reports one, and so does
// ExternalSurfaceProvider.
TEST_F(PictureInPictureVideosTest, AParentOutsideTheRendererIsABadMessage) {
  std::unique_ptr<PictureInPictureVideos::Listing> listing =
      videos_.List("4", &controls_);
  listing->SetSurface(Surface(9, 1));
  mojo::Remote<mojom::PictureInPictureVideos> shell = Shell();
  RecordingSurface surface;

  mojo::test::BadMessageObserver bad_message;
  shell->Show("1", viz::FrameSinkId(kShell.client_id() + 1, 1),
              surface.receiver.BindNewPipeAndPassRemote());

  EXPECT_THAT(bad_message.WaitForBadMessage(),
              testing::HasSubstr("parent frame sink is not the renderer's"));
  EXPECT_TRUE(children_.empty());
}

}  // namespace
}  // namespace domicile
