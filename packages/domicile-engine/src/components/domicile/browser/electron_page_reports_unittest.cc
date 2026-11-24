// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/browser/electron_page_reports.h"

#include <string>
#include <string_view>
#include <utility>
#include <variant>

#include "base/values.h"
#include "components/domicile/browser/electron_protocol.h"
#include "testing/gtest/include/gtest/gtest.h"

namespace domicile {
namespace {

// The action `line` asks of its window's page, which must be window 1's.
ElectronPageAction ActionIn(std::string_view line) {
  auto request = ParseElectronRequest(line);
  EXPECT_TRUE(request.has_value()) << line;
  auto* page = std::get_if<ElectronPageRequest>(&*request);
  EXPECT_NE(page, nullptr) << line;
  if (page == nullptr) {
    return ElectronPageAction();
  }
  EXPECT_EQ(page->window, 1);
  return std::move(page->action);
}

ElectronRefusal RefusalOf(std::string_view line) {
  const auto request = ParseElectronRequest(line);
  EXPECT_FALSE(request.has_value()) << line;
  return request.has_value() ? ElectronRefusal() : request.error();
}

TEST(ElectronPageReportsTest, AReportIsALineForItsWindow) {
  EXPECT_EQ(ElectronPageReported(
                3, ElectronConsoleMessage{.level = "warning",
                                          .message = "careful",
                                          .line = 7,
                                          .source = "https://a.test/app.js"}),
            "{\"level\":\"warning\",\"line\":7,\"message\":\"careful\","
            "\"source\":\"https://a.test/app.js\",\"type\":\"console_message\","
            "\"window\":3}\n");
}

TEST(ElectronPageReportsTest, ANoneThemeColorHasNoColor) {
  EXPECT_EQ(ElectronPageReported(1, ElectronThemeColor{}),
            "{\"type\":\"theme_color\",\"window\":1}\n");
}

TEST(ElectronPageReportsTest, ACustomCursorCarriesItsPicture) {
  EXPECT_EQ(
      ElectronPageReported(
          1, ElectronCursor{.cursor = "custom",
                            .custom = ElectronCursor::Custom{
                                .image = "data:image/png;base64,AA==",
                                .scale = 2,
                                .width = 4,
                                .height = 6,
                                .hotspot_x = 1,
                                .hotspot_y = 2}}),
      "{\"cursor\":\"custom\",\"height\":6,\"hotspot_x\":1,\"hotspot_y\":2,"
      "\"image\":\"data:image/png;base64,AA==\",\"scale\":2.0,"
      "\"type\":\"cursor_changed\",\"width\":4,\"window\":1}\n");
}

TEST(ElectronPageReportsTest, AHeldKeyNamesItsAsk) {
  EXPECT_EQ(ElectronPageReported(
                1, ElectronBeforeInput{
                       .ask = 4, .input = base::DictValue().Set("key", "a")}),
            "{\"ask\":4,\"input\":{\"key\":\"a\"},\"type\":\"before_input\","
            "\"window\":1}\n");
}

TEST(ElectronPageReportsTest, ListenInputSaysWhichListenersTheAppHas) {
  EXPECT_EQ(ActionIn(R"({"type":"listen_input","window":1,"keys":true,)"
                     R"("mouse":false,"events":true})"),
            ElectronPageAction(ElectronListenInput{
                .keys = true, .mouse = false, .events = true}));
  EXPECT_EQ(RefusalOf(R"({"type":"listen_input","window":1,"keys":true})"),
            (ElectronRefusal{.why = "\"mouse\" must be true or false",
                             .window = 1}));
}

TEST(ElectronPageReportsTest, AnInputAnswerNamesItsAsk) {
  EXPECT_EQ(ActionIn(R"({"type":"input_answer","window":1,"ask":4,)"
                     R"("prevent":true})"),
            ElectronPageAction(ElectronInputAnswer{.ask = 4, .prevent = true}));
  EXPECT_EQ(RefusalOf(R"({"type":"input_answer","window":1,"ask":0,)"
                      R"("prevent":true})")
                .why,
            "\"ask\" must be a whole number from 1");
}

TEST(ElectronPageReportsTest, ASentKeyNeedsItsKeyCode) {
  EXPECT_EQ(
      ActionIn(R"({"type":"send_input_event","window":1,"event":{)"
               R"("type":"keyDown","key_code":"Enter","modifiers":["Shift"]}})"),
      ElectronPageAction(ElectronSendInputEvent{
          .event = {.type = "keyDown",
                    .modifiers = {"shift"},
                    .key_code = "Enter"}}));
  EXPECT_EQ(RefusalOf(R"({"type":"send_input_event","window":1,"event":{)"
                      R"("type":"keyUp"}})")
                .why,
            "a key's \"key_code\" must name a key");
}

TEST(ElectronPageReportsTest, ASentMouseEventKeepsWhatItLeftOut) {
  EXPECT_EQ(
      ActionIn(R"({"type":"send_input_event","window":1,"event":{)"
               R"("type":"mouseWheel","x":10,"y":20.5,"delta_y":-120,)"
               R"("button":"right","can_scroll":false}})"),
      ElectronPageAction(ElectronSendInputEvent{.event = {.type = "mouseWheel",
                                                          .x = 10,
                                                          .y = 20.5,
                                                          .button = "right",
                                                          .delta_y = -120,
                                                          .can_scroll = false}}));
}

TEST(ElectronPageReportsTest, ASentEventIsOneOfElectronsKinds) {
  EXPECT_EQ(RefusalOf(R"({"type":"send_input_event","window":1,"event":{)"
                      R"("type":"keyPress","key_code":"a"}})")
                .window,
            1);
  EXPECT_EQ(RefusalOf(R"({"type":"send_input_event","window":1,"event":{)"
                      R"("type":"mouseDown","modifiers":["hyper"]}})")
                .why,
            "an input event's \"modifiers\" must each be one of Electron's");
  EXPECT_EQ(RefusalOf(R"({"type":"send_input_event","window":1,"event":{)"
                      R"("type":"mouseDown","x":"left"}})")
                .why,
            "an input event's \"x\" must be a number");
}

TEST(ElectronPageReportsTest, ThePagesSoundMenuAndSizeRequests) {
  EXPECT_EQ(ActionIn(R"({"type":"set_audio_muted","window":1,"muted":true})"),
            ElectronPageAction(ElectronSetAudioMuted{.muted = true}));
  EXPECT_EQ(ActionIn(R"({"type":"set_ignore_menu_shortcuts","window":1,)"
                     R"("ignore":true})"),
            ElectronPageAction(ElectronSetIgnoreMenuShortcuts{.ignore = true}));
  EXPECT_EQ(ActionIn(R"({"type":"enable_preferred_size_mode","window":1})"),
            ElectronPageAction(ElectronEnablePreferredSizeMode{}));
  EXPECT_EQ(ActionIn(R"({"type":"set_page_user_agent","window":1,)"
                     R"("user_agent":"Mine/1"})"),
            ElectronPageAction(ElectronSetPageUserAgent{.user_agent = "Mine/1"}));
}

TEST(ElectronPageReportsTest, APageRequestNamesItsWindow) {
  EXPECT_EQ(RefusalOf(R"({"type":"set_audio_muted","muted":true})"),
            ElectronRefusal{.why = "\"window\" must be a whole number from 1"});
}

TEST(ElectronPageReportsTest, OpenWindowTakesThePagesOwnUserAgent) {
  const auto request = ParseElectronRequest(
      R"({"type":"open_window","window":1,"url":"https://a.test/",)"
      R"("user_agent":"Mine/1"})");

  ASSERT_TRUE(request.has_value()) << request.error().why;
  EXPECT_EQ(std::get<ElectronOpenWindow>(*request).user_agent, "Mine/1");
  EXPECT_EQ(RefusalOf(R"({"type":"open_window","window":1,)"
                      R"("url":"https://a.test/","user_agent":1})")
                .why,
            "\"user_agent\" must be a string");
}

}  // namespace
}  // namespace domicile
