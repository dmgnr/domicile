// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/browser/electron_page_call.h"

#include <string>
#include <string_view>
#include <utility>
#include <variant>

#include "base/check.h"
#include "base/types/expected.h"
#include "base/values.h"
#include "components/domicile/browser/electron_protocol.h"
#include "testing/gtest/include/gtest/gtest.h"

namespace domicile {
namespace {

// The page call on `line`, which must be one.
ElectronPageCall CallOn(std::string_view line) {
  base::expected<ElectronRequest, ElectronRefusal> request =
      ParseElectronRequest(line);
  CHECK(request.has_value()) << request.error().why;
  return std::get<ElectronPageCall>(std::move(*request));
}

// Why the page call on `line` is refused.
std::string RefusalOf(std::string_view line) {
  base::expected<ElectronRequest, ElectronRefusal> request =
      ParseElectronRequest(line);
  CHECK(!request.has_value());
  return request.error().why;
}

TEST(ElectronPageCallTest, EachMethodTakesWhatItNeeds) {
  EXPECT_EQ(
      CallOn(R"({"type":"page_call","window":2,"call":5,)"
             R"("method":"reload_ignoring_cache"})"),
      (ElectronPageCall{
          .window = 2, .call = 5, .method = ElectronReloadIgnoringCache{}}));
  EXPECT_EQ(CallOn(R"({"type":"page_call","window":1,"call":1,)"
                   R"("method":"remove_inserted_css","key":"k","user":false})")
                .method,
            ElectronPageMethod(ElectronRemoveInsertedCss{.key = "k"}));
  EXPECT_EQ(
      CallOn(R"({"type":"page_call","window":1,"call":1,)"
             R"("method":"execute_in_isolated_world","world":999,)"
             R"("user_gesture":true,"scripts":[{"code":"1"},)"
             R"({"code":"2","url":"app://a/b.js"}]})")
          .method,
      ElectronPageMethod(ElectronExecuteInIsolatedWorld{
          .world = kElectronPreloadWorld,
          .scripts = {{.code = "1"}, {.code = "2", .url = "app://a/b.js"}},
          .user_gesture = true}));
  EXPECT_EQ(CallOn(R"({"type":"page_call","window":1,"call":1,)"
                   R"("method":"copy_video_frame_at","x":3,"y":4})")
                .method,
            ElectronPageMethod(ElectronCopyVideoFrameAt{.x = 3, .y = 4}));
  EXPECT_EQ(CallOn(R"({"type":"page_call","window":1,"call":1,)"
                   R"("method":"adjust_selection","start":-1,"end":2})")
                .method,
            ElectronPageMethod(ElectronAdjustSelection{.start = -1, .end = 2}));
  EXPECT_EQ(CallOn(R"({"type":"page_call","window":1,"call":1,)"
                   R"("method":"set_webrtc_ip_policy",)"
                   R"("policy":"disable_non_proxied_udp"})")
                .method,
            ElectronPageMethod(ElectronSetWebRtcIpPolicy{
                .policy = ElectronWebRtcIpPolicy::kDisableNonProxiedUdp}));
  EXPECT_EQ(CallOn(R"({"type":"page_call","window":1,"call":1,)"
                   R"("method":"set_ignore_input","ignore":true})")
                .method,
            ElectronPageMethod(ElectronSetIgnoreInput{.ignore = true}));
  EXPECT_EQ(CallOn(R"({"type":"page_call","window":1,"call":1,)"
                   R"("method":"devtools",)"
                   R"("devtools_method":"Page.captureScreenshot",)"
                   R"("params":{"format":"png"}})")
                .method,
            ElectronPageMethod(ElectronDevToolsMethod{
                .method = "Page.captureScreenshot",
                .params = base::DictValue().Set("format", "png")}));
  // session.enableNetworkEmulation, in each of the session's pages.
  EXPECT_EQ(CallOn(R"({"type":"page_call","window":1,"call":1,)"
                   R"("method":"devtools",)"
                   R"("devtools_method":"Network.emulateNetworkConditions",)"
                   R"("params":{"offline":true}})")
                .method,
            ElectronPageMethod(ElectronDevToolsMethod{
                .method = "Network.emulateNetworkConditions",
                .params = base::DictValue().Set("offline", true)}));
}

TEST(ElectronPageCallTest, AMethodMissingWhatItNeedsIsRefusedAsThatCall) {
  base::expected<ElectronRequest, ElectronRefusal> request =
      ParseElectronRequest(R"({"type":"page_call","window":2,"call":5,)"
                           R"("method":"insert_css","css":"a{}"})");

  ASSERT_FALSE(request.has_value());
  EXPECT_EQ(request.error(),
            (ElectronRefusal{.why = "\"user\" must be true or false",
                             .window = 2,
                             .page_call = 5}));
  EXPECT_EQ(RefusalOf(R"({"type":"page_call","window":1,"call":1,)"
                      R"("method":"execute_in_isolated_world","world":-1,)"
                      R"("user_gesture":false,"scripts":[{"code":"1"}]})"),
            "\"world\" must be from 0 to 1048576");
  EXPECT_EQ(RefusalOf(R"({"type":"page_call","window":1,"call":1,)"
                      R"("method":"execute_in_isolated_world","world":1,)"
                      R"("user_gesture":false,"scripts":[]})"),
            "\"scripts\" must be a list of scripts");
  EXPECT_EQ(RefusalOf(R"({"type":"page_call","window":1,"call":1,)"
                      R"("method":"set_webrtc_ip_policy","policy":"all"})"),
            "no WebRTC IP handling policy is named all");
  EXPECT_EQ(RefusalOf(R"({"type":"page_call","window":1,"call":1,)"
                      R"("method":"devtools",)"
                      R"("devtools_method":"Page.navigate",)"
                      R"("params":{"url":"chrome://settings"}})"),
            "an app has no DevTools method Page.navigate");
  EXPECT_EQ(RefusalOf(R"({"type":"page_call","window":1,"call":0,)"
                      R"("method":"reload_ignoring_cache"})"),
            "\"call\" must be a whole number from 1");
}

TEST(ElectronPageCallTest, ResultsAndDevToolsEventsAreLines) {
  EXPECT_EQ(ElectronPageResult(2, 5, base::Value()),
            "{\"call\":5,\"result\":null,\"type\":\"page_result\","
            "\"window\":2}\n");
  EXPECT_EQ(ElectronPageResult(2, 6, base::unexpected("gone")),
            "{\"call\":6,\"error\":\"gone\",\"type\":\"page_result\","
            "\"window\":2}\n");
  EXPECT_EQ(ElectronDevToolsEvent(3, "Page.screencastFrame",
                                  base::DictValue().Set("sessionId", 1)),
            "{\"method\":\"Page.screencastFrame\",\"params\":{\"sessionId\":1},"
            "\"type\":\"devtools_event\",\"window\":3}\n");
}

}  // namespace
}  // namespace domicile
