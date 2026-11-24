// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/browser/unfocused_web_views.h"

#include <set>
#include <vector>

#include "base/functional/bind.h"
#include "base/time/time.h"
#include "content/public/browser/global_routing_id.h"
#include "testing/gtest/include/gtest/gtest.h"

namespace domicile {
namespace {

using Frames = std::set<content::GlobalRenderFrameHostId>;

// One ThrottleFrames call.
struct Throttled {
  Frames frames;
  base::TimeDelta interval;

  friend bool operator==(const Throttled&, const Throttled&) = default;
};

constexpr base::TimeDelta kInterval = base::Hertz(30);

class UnfocusedWebViewsTest : public testing::Test {
 protected:
  UnfocusedWebViewsTest()
      : web_views_(base::BindRepeating(
            [](std::vector<Throttled>* calls, const Frames& frames,
               base::TimeDelta interval) {
              calls->push_back({frames, interval});
            },
            &calls_)) {}

  // The frames the last call throttled.
  Frames Last() const { return calls_.back().frames; }

  // Three <webview>s, by address, and their main frames.
  int a_ = 0;
  int b_ = 0;
  int c_ = 0;
  const content::GlobalRenderFrameHostId frame_a_{1, 1};
  const content::GlobalRenderFrameHostId frame_b_{2, 1};
  const content::GlobalRenderFrameHostId frame_c_{3, 1};

  std::vector<Throttled> calls_;
  UnfocusedWebViews web_views_;
};

TEST_F(UnfocusedWebViewsTest, EnergySaverSlowsEveryWebViewButTheFocusedOne) {
  web_views_.Track(&a_, frame_a_);
  web_views_.Track(&b_, frame_b_);
  web_views_.Track(&c_, frame_c_);
  web_views_.Focus(&b_);
  web_views_.Start(kInterval);
  EXPECT_EQ(calls_,
            (std::vector<Throttled>{{{frame_a_, frame_c_}, kInterval}}));
}

TEST_F(UnfocusedWebViewsTest, NothingIsThrottledWithoutEnergySaver) {
  web_views_.Track(&a_, frame_a_);
  web_views_.Track(&b_, frame_b_);
  web_views_.Focus(&a_);
  web_views_.Untrack(&b_);
  EXPECT_TRUE(calls_.empty());
}

TEST_F(UnfocusedWebViewsTest, FocusMovesTheFullRate) {
  web_views_.Track(&a_, frame_a_);
  web_views_.Track(&b_, frame_b_);
  web_views_.Focus(&a_);
  web_views_.Start(kInterval);
  web_views_.Focus(&b_);
  EXPECT_EQ(Last(), Frames({frame_a_}));
}

TEST_F(UnfocusedWebViewsTest, FocusOnAnUntrackedWindowSlowsTheLastWebView) {
  // An Electron window is never tracked; focusing it unfocuses the page.
  int electron = 0;
  web_views_.Track(&a_, frame_a_);
  web_views_.Focus(&a_);
  web_views_.Start(kInterval);
  web_views_.Focus(&electron);
  EXPECT_EQ(Last(), Frames({frame_a_}));
}

TEST_F(UnfocusedWebViewsTest, ANewOrClosedWebViewUpdatesTheThrottle) {
  web_views_.Start(kInterval);
  web_views_.Track(&a_, frame_a_);
  EXPECT_EQ(Last(), Frames({frame_a_}));
  web_views_.Untrack(&a_);
  EXPECT_EQ(Last(), Frames());
}

TEST_F(UnfocusedWebViewsTest, ANavigationMovesTheThrottleToTheNewMainFrame) {
  web_views_.Start(kInterval);
  web_views_.Track(&a_, frame_a_);
  web_views_.Track(&a_, frame_b_);
  EXPECT_EQ(Last(), Frames({frame_b_}));
}

TEST_F(UnfocusedWebViewsTest, StoppingEnergySaverThrottlesNothing) {
  web_views_.Track(&a_, frame_a_);
  web_views_.Start(kInterval);
  web_views_.Stop();
  EXPECT_EQ(Last(), Frames());
  web_views_.Track(&b_, frame_b_);
  EXPECT_EQ(calls_.size(), 2u);
}

}  // namespace
}  // namespace domicile
