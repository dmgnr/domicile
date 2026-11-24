// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/browser/electron_protocol.h"

#include <optional>
#include <string>
#include <utility>
#include <variant>
#include <vector>

#include "base/files/file_path.h"
#include "base/json/json_writer.h"
#include "base/strings/strcat.h"
#include "base/types/expected.h"
#include "base/values.h"

#include "testing/gtest/include/gtest/gtest.h"
#include "url/gurl.h"

namespace domicile {
namespace {

std::string WhyRefused(std::string_view line) {
  const auto request = ParseElectronRequest(line);
  EXPECT_FALSE(request.has_value()) << line;
  return request.has_value() ? "" : request.error().why;
}

TEST(ElectronProtocolTest, HelloNamesTheAppAndItsPartition) {
  const auto request = ParseElectronRequest(
      R"({"type":"hello","version":1,"app_id":"com.anthropic.Claude",)"
      R"("partition":"persist:electron-claude","electron_version":"45.2.1",)"
      R"("resources_path":"/opt/Claude/resources"})");

  ASSERT_TRUE(request.has_value()) << request.error().why;
  const auto* hello = std::get_if<ElectronHello>(&*request);
  ASSERT_NE(hello, nullptr);
  EXPECT_EQ(hello->app_id, "com.anthropic.Claude");
  EXPECT_EQ(hello->partition,
            (WebViewPartition{.name = "electron-claude", .persist = true}));
  EXPECT_EQ(hello->electron_version, "45.2.1");
  EXPECT_EQ(hello->resources_path, "/opt/Claude/resources");
}

TEST(ElectronProtocolTest, HelloNamesTheElectronAndResourcesItsPagesAreTold) {
  EXPECT_EQ(WhyRefused(R"({"type":"hello","version":1,"app_id":"a",)"
                       R"("partition":"persist:a","resources_path":"/r"})"),
            "\"electron_version\" must be a string that is not empty: the "
            "Electron the app's pages are told they run on");
  EXPECT_EQ(WhyRefused(R"({"type":"hello","version":1,"app_id":"a",)"
                       R"("partition":"persist:a","electron_version":"",)"
                       R"("resources_path":"/r"})"),
            "\"electron_version\" must be a string that is not empty: the "
            "Electron the app's pages are told they run on");
  EXPECT_EQ(WhyRefused(R"({"type":"hello","version":1,"app_id":"a",)"
                       R"("partition":"persist:a","electron_version":"45.2.1"})"),
            "\"resources_path\" must be an absolute path");
  EXPECT_EQ(WhyRefused(R"({"type":"hello","version":1,"app_id":"a",)"
                       R"("partition":"persist:a","electron_version":"45.2.1",)"
                       R"("resources_path":"resources"})"),
            "\"resources_path\" must be an absolute path");
}

TEST(ElectronProtocolTest, HelloFromAnotherVersionIsRefusedWithOurs) {
  EXPECT_EQ(WhyRefused(R"({"type":"hello","version":2,"app_id":"a",)"
                       R"("partition":"persist:a"})"),
            "this engine speaks version 1");
}

TEST(ElectronProtocolTest, HelloNeedsAnAppId) {
  EXPECT_EQ(WhyRefused(R"({"type":"hello","version":1,"app_id":"",)"
                       R"("partition":"persist:a"})"),
            "\"app_id\" must be a string that is not empty");
}

TEST(ElectronProtocolTest, AnAppNeverSharesTheProfilesPartition) {
  // The profile's partition holds the person's own browsing.
  EXPECT_EQ(WhyRefused(R"({"type":"hello","version":1,"app_id":"a",)"
                       R"("partition":""})"),
            "an app cannot use the profile's own partition");
}

TEST(ElectronProtocolTest, OpenWindowCarriesTheHostsNumberAndUrl) {
  const auto request = ParseElectronRequest(
      R"({"type":"open_window","window":3,"url":"https://claude.ai/"})");

  ASSERT_TRUE(request.has_value()) << request.error().why;
  const auto* open = std::get_if<ElectronOpenWindow>(&*request);
  ASSERT_NE(open, nullptr);
  EXPECT_EQ(open->window, 3);
  EXPECT_EQ(open->url, GURL("https://claude.ai/"));
}

TEST(ElectronProtocolTest, AFileUrlParsesForTheAppToServe) {
  // Whether it opens is the app's: its session serves file: or nothing does.
  const auto request = ParseElectronRequest(
      R"({"type":"load_url","window":1,"url":"file:///opt/app/index.html"})");

  ASSERT_TRUE(request.has_value()) << request.error().why;
  EXPECT_EQ(std::get<ElectronLoadUrl>(*request).url,
            GURL("file:///opt/app/index.html"));
}

TEST(ElectronProtocolTest, OtherSchemesDoNotOpenAndTheRefusalIsTheWindows) {
  const auto request = ParseElectronRequest(
      R"({"type":"open_window","window":2,"url":"chrome://settings"})");

  ASSERT_FALSE(request.has_value());
  EXPECT_EQ(request.error(),
            (ElectronRefusal{.why = "chrome: URLs do not open in an app window",
                             .window = 2}));
}

TEST(ElectronProtocolTest, OpenWindowNamesItsSession) {
  const auto own = ParseElectronRequest(
      R"({"type":"open_window","window":1,"url":"https://a.test/"})");
  const auto named = ParseElectronRequest(
      R"({"type":"open_window","window":2,"url":"https://a.test/",)"
      R"("session":"persist:cowork"})");

  ASSERT_TRUE(own.has_value() && named.has_value());
  EXPECT_EQ(std::get<ElectronOpenWindow>(*own).session, "");
  EXPECT_EQ(std::get<ElectronOpenWindow>(*named).session, "persist:cowork");
  EXPECT_EQ(WhyRefused(R"({"type":"open_window","window":1,)"
                       R"("url":"https://a.test/","session":1})"),
            "\"session\" must be a string");
}

TEST(ElectronProtocolTest, ASessionIsAPartitionInsideTheApps) {
  const WebViewPartition app{.name = "electron-claude", .persist = true};

  EXPECT_EQ(ElectronSessionPartition(app, ""), app);
  EXPECT_EQ(
      ElectronSessionPartition(app, "persist:cowork"),
      (WebViewPartition{.name = "electron-claude:cowork", .persist = true}));
  EXPECT_EQ(
      ElectronSessionPartition(app, "cache"),
      (WebViewPartition{.name = "electron-claude:cache", .persist = false}));
  EXPECT_FALSE(ElectronSessionPartition(app, "persist:").has_value());
}

TEST(ElectronProtocolTest, HandleProtocolNamesASessionAndAScheme) {
  const auto handle = ParseElectronRequest(
      R"({"type":"handle_protocol","session":"persist:x","scheme":"app"})");
  const auto unhandle = ParseElectronRequest(
      R"({"type":"unhandle_protocol","session":"","scheme":"file"})");

  ASSERT_TRUE(handle.has_value() && unhandle.has_value());
  const auto& handled = std::get<ElectronHandleProtocol>(*handle);
  EXPECT_EQ(handled.session, "persist:x");
  EXPECT_EQ(handled.scheme, "app");
  EXPECT_TRUE(handled.handle);
  EXPECT_FALSE(std::get<ElectronHandleProtocol>(*unhandle).handle);
  EXPECT_EQ(
      WhyRefused(R"({"type":"handle_protocol","session":"","scheme":"data"})"),
      "an app cannot handle data:");
  EXPECT_EQ(WhyRefused(R"({"type":"handle_protocol","scheme":"app"})"),
            "\"session\" must be a string");
}

TEST(ElectronProtocolTest, AResponseIsABodyAFileOrAStream) {
  const auto body = ParseElectronRequest(
      R"({"type":"protocol_response","request":4,"status":201,)"
      R"("headers":[["content-type","text/plain"],["x-a","1"],["x-a","2"]],)"
      R"("body":"aGk="})");
  const auto file = ParseElectronRequest(
      R"({"type":"protocol_response","request":5,"status":200,"headers":[],)"
      R"("file":"/opt/app/index.html"})");
  const auto stream = ParseElectronRequest(
      R"({"type":"protocol_response","request":6,"status":200,"headers":[],)"
      R"("stream":true})");
  const auto failed = ParseElectronRequest(
      R"({"type":"protocol_response","request":7,"error":"no such file"})");

  ASSERT_TRUE(body.has_value()) << body.error().why;
  const auto& whole = std::get<ElectronProtocolResponse>(*body);
  EXPECT_EQ(whole.request, 4);
  ASSERT_TRUE(whole.response.has_value());
  EXPECT_EQ(whole.response->status, 201);
  EXPECT_EQ(whole.response->headers,
            (ElectronHeaders{
                {"content-type", "text/plain"}, {"x-a", "1"}, {"x-a", "2"}}));
  EXPECT_EQ(std::get<std::string>(whole.response->body), "hi");
  ASSERT_TRUE(file.has_value() && stream.has_value() && failed.has_value());
  EXPECT_EQ(std::get<base::FilePath>(
                std::get<ElectronProtocolResponse>(*file).response->body),
            base::FilePath("/opt/app/index.html"));
  EXPECT_TRUE(std::holds_alternative<ElectronStreamedBody>(
      std::get<ElectronProtocolResponse>(*stream).response->body));
  EXPECT_EQ(std::get<ElectronProtocolResponse>(*failed).response,
            base::unexpected("no such file"));
}

TEST(ElectronProtocolTest, ABadResponseIsRefusedAsItsRequests) {
  const auto refusal = [](std::string_view line) {
    const auto request = ParseElectronRequest(line);
    EXPECT_FALSE(request.has_value()) << line;
    return request.has_value() ? ElectronRefusal() : request.error();
  };

  EXPECT_EQ(refusal(R"({"type":"protocol_response","request":4,"status":700,)"
                    R"("headers":[],"body":""})"),
            (ElectronRefusal{.why = "\"status\" must be from 100 to 599",
                             .request = 4}));
  EXPECT_EQ(refusal(R"({"type":"protocol_response","request":4,"status":200,)"
                    R"("headers":[["bad name","x"]],"body":""})"),
            (ElectronRefusal{.why = "\"bad name\" is not a header name",
                             .request = 4}));
  EXPECT_EQ(
      refusal(R"({"type":"protocol_response","request":4,"status":200,)"
              R"("headers":[["x","a\r\nb"]],"body":""})"),
      (ElectronRefusal{.why = "header x has a value no response can carry",
                       .request = 4}));
  EXPECT_EQ(refusal(R"({"type":"protocol_response","request":4,"status":200,)"
                    R"("headers":[],"body":"!!"})"),
            (ElectronRefusal{.why = "\"body\" must be base64", .request = 4}));
  EXPECT_EQ(
      refusal(R"({"type":"protocol_response","request":4,"status":200,)"
              R"("headers":[],"body":"","file":"/a"})"),
      (ElectronRefusal{
          .why = "a response has one of \"body\", \"file\" and \"stream\"",
          .request = 4}));
  EXPECT_EQ(refusal(R"({"type":"protocol_response","request":4,"status":200,)"
                    R"("headers":[],"file":"relative/a"})"),
            (ElectronRefusal{.why = "\"file\" must be an absolute path",
                             .request = 4}));
  EXPECT_EQ(
      refusal(R"({"type":"protocol_response","request":0})"),
      (ElectronRefusal{.why = "\"request\" must be a whole number from 1"}));
}

TEST(ElectronProtocolTest, AStreamedBodyComesInPiecesThenEnds) {
  const auto data = ParseElectronRequest(
      R"({"type":"protocol_data","request":6,"data":"aGk="})");
  const auto end =
      ParseElectronRequest(R"({"type":"protocol_end","request":6})");
  const auto broken = ParseElectronRequest(
      R"({"type":"protocol_end","request":6,"error":"disk"})");

  ASSERT_TRUE(data.has_value() && end.has_value() && broken.has_value());
  EXPECT_EQ(std::get<ElectronProtocolData>(*data).bytes, "hi");
  EXPECT_EQ(std::get<ElectronProtocolEnd>(*end).error, std::nullopt);
  EXPECT_EQ(std::get<ElectronProtocolEnd>(*broken).error, "disk");
}

TEST(ElectronProtocolTest, AProtocolRequestIsOneLine) {
  EXPECT_EQ(
      ElectronProtocolRequest(5, "persist:x",
                              ElectronFetch{.url = GURL("app://localhost/a"),
                                            .method = "POST",
                                            .headers = {{"accept", "*/*"}},
                                            .body = "hi"}),
      R"({"body":"aGk=","headers":[["accept","*/*"]],"method":"POST",)"
      R"("request":5,"session":"persist:x","type":"protocol_request",)"
      R"("url":"app://localhost/a"})"
      "\n");
  EXPECT_EQ(ElectronProtocolRequest(6, "",
                                    ElectronFetch{.url = GURL("file:///a"),
                                                  .method = "GET",
                                                  .headers = {},
                                                  .body = std::nullopt}),
            R"({"headers":[],"method":"GET","request":6,"session":"",)"
            R"("type":"protocol_request","url":"file:///a"})"
            "\n");
}

TEST(ElectronProtocolTest, AWindowNumberIsAWholeNumberFromOne) {
  constexpr char kWhy[] = "\"window\" must be a whole number from 1";
  EXPECT_EQ(WhyRefused(R"({"type":"focus_window","window":0})"), kWhy);
  EXPECT_EQ(WhyRefused(R"({"type":"focus_window","window":1.5})"), kWhy);
  EXPECT_EQ(WhyRefused(R"({"type":"focus_window"})"), kWhy);
}

TEST(ElectronProtocolTest, EachWindowRequestIsItsOwnKind) {
  const auto focus =
      ParseElectronRequest(R"({"type":"focus_window","window":2})");
  const auto close =
      ParseElectronRequest(R"({"type":"close_window","window":2})");
  const auto destroy =
      ParseElectronRequest(R"({"type":"destroy_window","window":2})");

  ASSERT_TRUE(focus.has_value() && close.has_value() && destroy.has_value());
  EXPECT_TRUE(std::holds_alternative<ElectronFocusWindow>(*focus));
  EXPECT_TRUE(std::holds_alternative<ElectronCloseWindow>(*close));
  EXPECT_TRUE(std::holds_alternative<ElectronDestroyWindow>(*destroy));
}

TEST(ElectronProtocolTest, AWindowsHistoryMovesToAnIndexOrIsCleared) {
  const auto go =
      ParseElectronRequest(R"({"type":"go_to_index","window":2,"index":1})");
  const auto clear =
      ParseElectronRequest(R"({"type":"clear_history","window":2})");

  ASSERT_TRUE(go.has_value() && clear.has_value());
  EXPECT_EQ(std::get<ElectronGoToIndex>(*go).window, 2);
  EXPECT_EQ(std::get<ElectronGoToIndex>(*go).index, 1);
  EXPECT_EQ(std::get<ElectronClearHistory>(*clear).window, 2);
  for (const char* line :
       {R"({"type":"go_to_index","window":2})",
        R"({"type":"go_to_index","window":2,"index":-1})",
        R"({"type":"go_to_index","window":2,"index":"1"})"}) {
    EXPECT_EQ(WhyRefused(line), "\"index\" must be a whole number from 0");
  }
}

TEST(ElectronProtocolTest, AHistoryEntryIsRemovedByItsIndex) {
  const auto remove = ParseElectronRequest(
      R"({"type":"remove_history_entry","window":2,"index":1})");

  ASSERT_TRUE(remove.has_value()) << remove.error().why;
  EXPECT_EQ(std::get<ElectronRemoveHistoryEntry>(*remove).window, 2);
  EXPECT_EQ(std::get<ElectronRemoveHistoryEntry>(*remove).index, 1);
  EXPECT_EQ(
      WhyRefused(R"({"type":"remove_history_entry","window":2,"index":-1})"),
      "\"index\" must be a whole number from 0");
}

TEST(ElectronProtocolTest, AWindowSaysWhetherItsAppListensToNavigations) {
  const auto listen = ParseElectronRequest(
      R"({"type":"navigation_listen","window":2,"listening":true})");

  ASSERT_TRUE(listen.has_value()) << listen.error().why;
  EXPECT_EQ(std::get<ElectronNavigationListen>(*listen).window, 2);
  EXPECT_TRUE(std::get<ElectronNavigationListen>(*listen).listening);
  EXPECT_EQ(WhyRefused(R"({"type":"navigation_listen","window":2})"),
            "\"listening\" must be true or false");
}

TEST(ElectronProtocolTest, OpenWindowMayRestoreAHistory) {
  const auto request = ParseElectronRequest(
      R"({"type":"open_window","window":3,"url":"https://a.test/2",)"
      R"("history":{"entries":[{"url":"https://a.test/1","title":"1"},)"
      R"({"url":"https://a.test/2","title":"2"}],"index":1}})");

  ASSERT_TRUE(request.has_value()) << request.error().why;
  EXPECT_EQ(std::get<ElectronOpenWindow>(*request).history,
            (ElectronHistory{
                .entries = {{.url = GURL("https://a.test/1"), .title = "1"},
                            {.url = GURL("https://a.test/2"), .title = "2"}},
                .index = 1}));
  const auto plain = ParseElectronRequest(
      R"({"type":"open_window","window":3,"url":"https://a/"})");
  ASSERT_TRUE(plain.has_value()) << plain.error().why;
  EXPECT_FALSE(std::get<ElectronOpenWindow>(*plain).history.has_value());
}

TEST(ElectronProtocolTest, ABadHistoryIsRefusedAsItsWindows) {
  constexpr char kShape[] =
      "\"history\" must be an object with \"entries\", a list of "
      "{\"url\", \"title\"}, and \"index\", the entry shown";
  for (const char* line :
       {R"({"type":"open_window","window":3,"url":"https://a/","history":1})",
        R"({"type":"open_window","window":3,"url":"https://a/",)"
        R"("history":{"entries":[],"index":0}})",
        R"({"type":"open_window","window":3,"url":"https://a/",)"
        R"("history":{"entries":[{"url":"https://a/"}],"index":0}})"}) {
    const auto request = ParseElectronRequest(line);
    ASSERT_FALSE(request.has_value()) << line;
    EXPECT_EQ(request.error(), (ElectronRefusal{.why = kShape, .window = 3}));
  }
  EXPECT_EQ(WhyRefused(R"({"type":"open_window","window":3,"url":"https://a/",)"
                       R"("history":{"entries":[{"url":"https://a/",)"
                       R"("title":""}],"index":1}})"),
            "\"history\"'s \"index\" must be one of its entries");
  EXPECT_EQ(WhyRefused(R"({"type":"open_window","window":3,"url":"https://a/",)"
                       R"("history":{"entries":[{"url":"https://b/",)"
                       R"("title":""}],"index":0}})"),
            "\"url\" must be the address of the history's entry \"index\"");
  EXPECT_EQ(WhyRefused(R"({"type":"open_window","window":3,"url":"https://a/",)"
                       R"("history":{"entries":[{"url":"chrome://a/",)"
                       R"("title":""}],"index":0}})"),
            "chrome: URLs do not open in an app window");
}

TEST(ElectronProtocolTest, AnEditIsOneOfTheEditMenusCommands) {
  for (const auto& [name, command] :
       std::vector<std::pair<std::string, ElectronEditCommand>>{
           {"undo", ElectronEditCommand::kUndo},
           {"redo", ElectronEditCommand::kRedo},
           {"cut", ElectronEditCommand::kCut},
           {"copy", ElectronEditCommand::kCopy},
           {"paste", ElectronEditCommand::kPaste},
           {"paste_and_match_style", ElectronEditCommand::kPasteAndMatchStyle},
           {"delete", ElectronEditCommand::kDelete},
           {"select_all", ElectronEditCommand::kSelectAll},
           {"unselect", ElectronEditCommand::kUnselect},
           {"center_selection", ElectronEditCommand::kCenterSelection}}) {
    const auto edit = ParseElectronRequest(
        R"({"type":"edit","window":3,"command":")" + name + R"("})");
    ASSERT_TRUE(edit.has_value()) << name;
    EXPECT_EQ(std::get<ElectronEdit>(*edit).window, 3);
    EXPECT_EQ(std::get<ElectronEdit>(*edit).command, command) << name;
  }
  for (const char* line : {R"({"type":"edit","window":3})",
                           R"({"type":"edit","window":3,"command":"Undo"})",
                           R"({"type":"edit","window":3,"command":"fly"})"}) {
    EXPECT_EQ(WhyRefused(line),
              "\"command\" must be undo, redo, cut, copy, paste, "
              "paste_and_match_style, delete, select_all, unselect or "
              "center_selection");
  }
}

TEST(ElectronProtocolTest, AReplaceNamesItsTextAndWhetherItIsASpelling) {
  const auto replace = ParseElectronRequest(
      R"({"type":"replace","window":3,"text":"word","misspelling":true})");

  ASSERT_TRUE(replace.has_value());
  EXPECT_EQ(std::get<ElectronReplace>(*replace).text, "word");
  EXPECT_TRUE(std::get<ElectronReplace>(*replace).misspelling);
  EXPECT_EQ(WhyRefused(R"({"type":"replace","window":3,"misspelling":false})"),
            "\"text\" must be a string");
  EXPECT_EQ(WhyRefused(R"({"type":"replace","window":3,"text":"w"})"),
            "\"misspelling\" must be true or false");
}

TEST(ElectronProtocolTest, AFindIsNumberedAndSaysHowItSearches) {
  const auto find = ParseElectronRequest(
      R"({"type":"find_in_page","window":3,"request":4,"text":"cat",)"
      R"("forward":false,"find_next":true,"match_case":true})");

  ASSERT_TRUE(find.has_value());
  const auto& found = std::get<ElectronFindInPage>(*find);
  EXPECT_EQ(found.window, 3);
  EXPECT_EQ(found.request, 4);
  EXPECT_EQ(found.text, "cat");
  EXPECT_FALSE(found.forward);
  EXPECT_TRUE(found.find_next);
  EXPECT_TRUE(found.match_case);
  constexpr char kHow[] =
      R"("forward":true,"find_next":false,"match_case":false})";
  for (const std::string& line :
       {std::string(R"({"type":"find_in_page","window":3,"text":"a",)") + kHow,
        std::string(
            R"({"type":"find_in_page","window":3,"request":0,"text":"a",)") +
            kHow}) {
    EXPECT_EQ(WhyRefused(line), "\"request\" must be a whole number from 1");
  }
  EXPECT_EQ(
      WhyRefused(
          std::string(
              R"({"type":"find_in_page","window":3,"request":1,"text":"",)") +
          kHow),
      "\"text\" must be a string that is not empty");
  EXPECT_EQ(
      WhyRefused(R"({"type":"find_in_page","window":3,"request":1,"text":"a",)"
                 R"("forward":true,"match_case":false})"),
      "\"forward\", \"find_next\" and \"match_case\" must each be true or "
      "false");
}

TEST(ElectronProtocolTest, AStopFindSaysWhatBecomesOfTheMatch) {
  for (const auto& [name, action] :
       std::vector<std::pair<std::string, ElectronStopFindAction>>{
           {"clear_selection", ElectronStopFindAction::kClearSelection},
           {"keep_selection", ElectronStopFindAction::kKeepSelection},
           {"activate_selection",
            ElectronStopFindAction::kActivateSelection}}) {
    const auto stop = ParseElectronRequest(
        R"({"type":"stop_find_in_page","window":3,"action":")" + name +
        R"("})");
    ASSERT_TRUE(stop.has_value()) << name;
    EXPECT_EQ(std::get<ElectronStopFindInPage>(*stop).action, action);
  }
  EXPECT_EQ(WhyRefused(R"({"type":"stop_find_in_page","window":3})"),
            "\"action\" must be clear_selection, keep_selection or "
            "activate_selection");
}

TEST(ElectronProtocolTest, AnUnknownRequestIsNamed) {
  EXPECT_EQ(WhyRefused(R"({"type":"fly"})"), "no request is named fly");
}

TEST(ElectronProtocolTest, ALineThatIsNotAnObjectIsRefused) {
  EXPECT_EQ(WhyRefused("[1]"), "a request must be a JSON object");
  EXPECT_EQ(WhyRefused("{}"), "a request must have a \"type\"");
}

TEST(ElectronProtocolTest, ReadySaysWhichSchemesTheEngineRegistered) {
  EXPECT_EQ(ElectronReady({{.scheme = "app", .standard = true, .secure = true},
                           {.scheme = "claude-media"}},
                          {}),
            "{\"chrome_version\":\"\",\"schemes\":[{\"privileges\":"
            "[\"standard\",\"secure\"],\"scheme\":\"app\"},"
            "{\"privileges\":[],\"scheme\":\"claude-media\"}],"
            "\"type\":\"ready\",\"user_agent\":\"\"}\n");
}

TEST(ElectronProtocolTest, ReadySaysTheEnginesUserAgentAndChromeVersion) {
  EXPECT_EQ(ElectronReady({}, {.user_agent = "Mozilla/5.0 Chrome/160.0.0.0",
                               .chrome_version = "160.0.8155.0"}),
            "{\"chrome_version\":\"160.0.8155.0\",\"schemes\":[],"
            "\"type\":\"ready\",\"user_agent\":\"Mozilla/5.0 "
            "Chrome/160.0.0.0\"}\n");
}

TEST(ElectronProtocolTest, SetUserAgentFallbackCarriesTheAgent) {
  const auto request = ParseElectronRequest(
      R"({"type":"set_user_agent_fallback","user_agent":"Slack/4 Electron/45"})");

  ASSERT_TRUE(request.has_value());
  EXPECT_EQ(std::get<ElectronSetUserAgentFallback>(*request).user_agent,
            "Slack/4 Electron/45");
  EXPECT_EQ(WhyRefused(R"({"type":"set_user_agent_fallback"})"),
            "\"user_agent\" must be a string");
}

TEST(ElectronProtocolTest, OpenWindowMayOpenAView) {
  const auto window = ParseElectronRequest(
      R"({"type":"open_window","window":1,"url":"https://a.test/"})");
  const auto view = ParseElectronRequest(
      R"({"type":"open_window","window":2,"url":"https://a.test/",)"
      R"("view":true})");

  ASSERT_TRUE(window.has_value() && view.has_value());
  EXPECT_FALSE(std::get<ElectronOpenWindow>(*window).view);
  EXPECT_TRUE(std::get<ElectronOpenWindow>(*view).view);
  EXPECT_EQ(WhyRefused(R"({"type":"open_window","window":1,)"
                       R"("url":"https://a.test/","view":1})"),
            "\"view\" must be true or false");
}

TEST(ElectronProtocolTest, OpenWindowMayGiveATitleAndOpenHidden) {
  const auto plain = ParseElectronRequest(
      R"({"type":"open_window","window":1,"url":"https://a.test/"})");
  const auto set = ParseElectronRequest(
      R"({"type":"open_window","window":1,"url":"https://a.test/",)"
      R"("title":"Claude","hidden":true})");

  ASSERT_TRUE(plain.has_value() && set.has_value());
  EXPECT_EQ(std::get<ElectronOpenWindow>(*plain).title, "");
  EXPECT_FALSE(std::get<ElectronOpenWindow>(*plain).hidden);
  EXPECT_EQ(std::get<ElectronOpenWindow>(*set).title, "Claude");
  EXPECT_TRUE(std::get<ElectronOpenWindow>(*set).hidden);
  EXPECT_EQ(WhyRefused(R"({"type":"open_window","window":1,)"
                       R"("url":"https://a.test/","title":1})"),
            "\"title\" must be a string");
  EXPECT_EQ(WhyRefused(R"({"type":"open_window","window":1,)"
                       R"("url":"https://a.test/","hidden":"yes"})"),
            "\"hidden\" must be true or false");
  EXPECT_EQ(WhyRefused(R"({"type":"open_window","window":1,)"
                       R"("url":"https://a.test/","view":true,"hidden":true})"),
            "a view has no title or hidden of its own: its window has them");
}

TEST(ElectronProtocolTest, OpenWindowMayGiveItsPageNode) {
  const auto plain = ParseElectronRequest(
      R"({"type":"open_window","window":1,"url":"file:///app/index.html"})");
  const auto node = ParseElectronRequest(
      R"({"type":"open_window","window":1,"url":"file:///app/index.html",)"
      R"("node":{"preload":"/app/preload.js","integration":true,)"
      R"("context_isolation":false,"app_path":"/res/app",)"
      R"("env":{"HOME":"/home/a"}}})");
  const auto bare = ParseElectronRequest(
      R"({"type":"open_window","window":1,"url":"file:///app/index.html",)"
      R"("node":{}})");

  ASSERT_TRUE(plain.has_value() && node.has_value() && bare.has_value());
  EXPECT_FALSE(std::get<ElectronOpenWindow>(*plain).node.has_value());
  EXPECT_EQ(std::get<ElectronOpenWindow>(*node).node,
            (ElectronNode{.preload = "/app/preload.js",
                          .integration = true,
                          .context_isolation = false,
                          .app_path = "/res/app",
                          .env = {{"HOME", "/home/a"}}}));
  // Electron's defaults: no nodeIntegration, and context isolation.
  EXPECT_EQ(std::get<ElectronOpenWindow>(*bare).node, ElectronNode{});
  EXPECT_EQ(WhyRefused(R"({"type":"open_window","window":1,)"
                       R"("url":"file:///a/","node":true})"),
            "\"node\" must be an object: what the page's Node.js needs");
  EXPECT_EQ(WhyRefused(R"({"type":"open_window","window":1,)"
                       R"("url":"file:///a/","node":{"integration":1}})"),
            "\"node\"'s \"integration\" must be true or false");
  EXPECT_EQ(WhyRefused(R"({"type":"open_window","window":1,)"
                       R"("url":"file:///a/","node":{"preload":"p.js"}})"),
            "\"node\"'s \"preload\" must be an absolute path");
  EXPECT_EQ(WhyRefused(R"({"type":"open_window","window":1,)"
                       R"("url":"file:///a/","node":{"env":{"A":1}}})"),
            "\"node\"'s \"env\" must be an object of strings");
  EXPECT_EQ(WhyRefused(R"({"type":"open_window","window":1,)"
                       R"("url":"file:///a/","preload":"x","node":{}})"),
            "a page with Node.js loads its preload from a file, "
            "\"node\"'s \"preload\", not from \"preload\"");
}

TEST(ElectronProtocolTest, OpenWindowMayGiveItsRendererArguments) {
  const auto plain = ParseElectronRequest(
      R"({"type":"open_window","window":1,"url":"https://a.test/"})");
  const auto given = ParseElectronRequest(
      R"({"type":"open_window","window":1,"url":"https://a.test/",)"
      R"("arguments":["--desktop-features={}","--x"]})");

  ASSERT_TRUE(plain.has_value() && given.has_value());
  EXPECT_TRUE(std::get<ElectronOpenWindow>(*plain).arguments.empty());
  EXPECT_EQ(std::get<ElectronOpenWindow>(*given).arguments,
            (std::vector<std::string>{"--desktop-features={}", "--x"}));
  EXPECT_EQ(WhyRefused(R"({"type":"open_window","window":1,)"
                       R"("url":"https://a.test/","arguments":"--x"})"),
            "\"arguments\" must be a list of strings");
  EXPECT_EQ(WhyRefused(R"({"type":"open_window","window":1,)"
                       R"("url":"https://a.test/","arguments":[1]})"),
            "\"arguments\" must be a list of strings");
}

TEST(ElectronProtocolTest, SetTitleAndSetHiddenNameTheirWindow) {
  const auto title = ParseElectronRequest(
      R"({"type":"set_title","window":2,"title":"Slack"})");
  const auto hidden =
      ParseElectronRequest(R"({"type":"set_hidden","window":3,"hidden":true})");

  ASSERT_TRUE(title.has_value() && hidden.has_value());
  EXPECT_EQ(std::get<ElectronSetTitle>(*title).window, 2);
  EXPECT_EQ(std::get<ElectronSetTitle>(*title).title, "Slack");
  EXPECT_EQ(std::get<ElectronSetHidden>(*hidden).window, 3);
  EXPECT_TRUE(std::get<ElectronSetHidden>(*hidden).hidden);
  EXPECT_EQ(WhyRefused(R"({"type":"set_title","window":2})"),
            "\"title\" must be a string");
  EXPECT_EQ(WhyRefused(R"({"type":"set_hidden","window":2,"hidden":1})"),
            "\"hidden\" must be true or false");
}

TEST(ElectronProtocolTest, SetWindowStateKeepsEachStateTheAppAsks) {
  const auto asked = ParseElectronRequest(
      R"({"type":"set_window_state","window":4,"maximized":true,)"
      R"("minimized":false,"fullscreen":true})");

  ASSERT_TRUE(asked.has_value()) << asked.error().why;
  const auto& set = std::get<ElectronSetWindowState>(*asked);
  EXPECT_EQ(set.window, 4);
  EXPECT_EQ(set.state,
            (ElectronWindowState{
                .maximized = true, .minimized = false, .fullscreen = true}));
  EXPECT_EQ(
      WhyRefused(R"({"type":"set_window_state","window":4,"maximized":true,)"
                 R"("minimized":false})"),
      "\"maximized\", \"minimized\" and \"fullscreen\" must each be true or "
      "false");
}

TEST(ElectronProtocolTest, SetViewsPlacesEachViewBottomFirst) {
  const auto request = ParseElectronRequest(
      R"({"type":"set_views","window":1,"views":[)"
      R"({"window":2,"x":0,"y":40,"width":800,"height":560},)"
      R"({"window":3,"x":-5,"y":0,"width":0,"height":0,"hidden":true}]})");

  ASSERT_TRUE(request.has_value()) << request.error().why;
  const auto& set = std::get<ElectronSetViews>(*request);
  EXPECT_EQ(set.window, 1);
  EXPECT_EQ(set.views,
            (std::vector<ElectronViewPlacement>{
                {.view = 2, .x = 0, .y = 40, .width = 800, .height = 560},
                {.view = 3, .x = -5, .hidden = true}}));
  EXPECT_TRUE(std::get<ElectronSetViews>(
                  *ParseElectronRequest(
                      R"({"type":"set_views","window":1,"views":[]})"))
                  .views.empty());
}

TEST(ElectronProtocolTest, ABadSetViewsIsRefusedAsTheWindows) {
  EXPECT_EQ(ParseElectronRequest(R"({"type":"set_views","window":4})").error(),
            (ElectronRefusal{.why = "\"views\" must be a list", .window = 4}));
  EXPECT_EQ(WhyRefused(R"({"type":"set_views","window":1,"views":[2]})"),
            "each of \"views\" must be an object");
  EXPECT_EQ(WhyRefused(R"({"type":"set_views","window":1,"views":[)"
                       R"({"x":0,"y":0,"width":1,"height":1}]})"),
            "a view's \"window\" must be a whole number from 1");
  EXPECT_EQ(WhyRefused(R"({"type":"set_views","window":1,"views":[)"
                       R"({"window":2,"y":0,"width":1,"height":1}]})"),
            "a view's \"x\" and \"y\" must be whole numbers");
  EXPECT_EQ(WhyRefused(R"({"type":"set_views","window":1,"views":[)"
                       R"({"window":2,"x":0,"y":0,"width":-1,"height":1}]})"),
            "a view's \"width\" and \"height\" must be whole numbers from 0");
  EXPECT_EQ(WhyRefused(R"({"type":"set_views","window":1,"views":[)"
                       R"({"window":2,"x":0,"y":0,"width":1,"height":1,)"
                       R"("hidden":"yes"}]})"),
            "a view's \"hidden\" must be true or false");
}

TEST(ElectronProtocolTest, ASetMenuBarKeepsTheMenusEntries) {
  base::expected<ElectronRequest, ElectronRefusal> request =
      ParseElectronRequest(
          R"({"type":"set_menu_bar","window":1,"visible":true,)"
          R"("auto_hide":false,"menu":[{"id":1,"type":"submenu",)"
          R"("label":"&File","enabled":true,"visible":true,"checked":false,)"
          R"("sublabel":"dropped","submenu":[{"id":2,"type":"normal",)"
          R"("label":"Quit","enabled":true,"visible":true,"checked":false,)"
          R"("accelerator":"CmdOrCtrl+Q",)"
          R"("icon":"data:image/png;base64,AA=="}]}]})");

  ASSERT_TRUE(request.has_value()) << request.error().why;
  const auto& bar = std::get<ElectronSetMenuBar>(*request);
  EXPECT_EQ(bar.window, 1);
  EXPECT_TRUE(bar.visible);
  EXPECT_FALSE(bar.auto_hide);
  EXPECT_EQ(bar.menu,
            R"([{"checked":false,"enabled":true,"id":1,"label":"&File",)"
            R"("submenu":[{"accelerator":"CmdOrCtrl+Q","checked":false,)"
            R"("enabled":true,"icon":"data:image/png;base64,AA==","id":2,)"
            R"("label":"Quit","type":"normal","visible":true}],)"
            R"("type":"submenu","visible":true}])");
  EXPECT_EQ(std::get<ElectronSetMenuBar>(
                *ParseElectronRequest(
                    R"({"type":"set_menu_bar","window":1,"menu":null,)"
                    R"("visible":false,"auto_hide":true})"))
                .menu,
            "");
}

TEST(ElectronProtocolTest, APopupMenuKeepsItsEntriesAndWhereItGoes) {
  constexpr char kEntry[] =
      R"({"id":3,"type":"normal","label":"Settings","enabled":true,)"
      R"("visible":true,"checked":false})";
  const auto at = ParseElectronRequest(
      std::string(R"({"type":"popup_menu","window":2,"popup":5,"menu":[)") +
      kEntry + R"(],"x":10,"y":-4})");
  const auto pointer = ParseElectronRequest(
      std::string(R"({"type":"popup_menu","window":2,"popup":6,"menu":[)") +
      kEntry + "]}");
  const auto close = ParseElectronRequest(
      R"({"type":"close_popup_menu","window":2,"popup":5})");

  ASSERT_TRUE(at.has_value()) << at.error().why;
  const auto& popped = std::get<ElectronPopupMenu>(*at);
  EXPECT_EQ(popped.window, 2);
  EXPECT_EQ(popped.popup, 5);
  EXPECT_EQ(popped.menu,
            R"([{"checked":false,"enabled":true,"id":3,"label":"Settings",)"
            R"("type":"normal","visible":true}])");
  EXPECT_EQ(popped.x, 10);
  EXPECT_EQ(popped.y, -4);
  ASSERT_TRUE(pointer.has_value()) << pointer.error().why;
  EXPECT_EQ(std::get<ElectronPopupMenu>(*pointer).x, std::nullopt);
  EXPECT_EQ(std::get<ElectronPopupMenu>(*pointer).y, std::nullopt);
  ASSERT_TRUE(close.has_value());
  EXPECT_EQ(std::get<ElectronClosePopupMenu>(*close).popup, 5);
}

TEST(ElectronProtocolTest, ABadPopupMenuIsRefusedAsTheWindows) {
  constexpr char kEntry[] =
      R"({"id":3,"type":"normal","label":"Settings","enabled":true,)"
      R"("visible":true,"checked":false})";
  const std::string menu = std::string(R"("menu":[)") + kEntry + "]";
  EXPECT_EQ(
      ParseElectronRequest(R"({"type":"popup_menu","window":2,)" + menu + "}")
          .error(),
      (ElectronRefusal{.why = "\"popup\" must be a whole number from 1",
                       .window = 2}));
  EXPECT_EQ(
      WhyRefused(R"({"type":"popup_menu","window":2,"popup":1,"menu":[]})"),
      "\"menu\" must be a list of entries, not empty");
  for (const std::string& where :
       {std::string(R"(,"x":1)"), std::string(R"(,"x":1,"y":"2")"),
        std::string(R"(,"y":1.5,"x":1)")}) {
    EXPECT_EQ(WhyRefused(R"({"type":"popup_menu","window":2,"popup":1,)" +
                         menu + where + "}"),
              "\"x\" and \"y\" must both be whole numbers, or both be left "
              "out");
  }
  EXPECT_EQ(WhyRefused(R"({"type":"popup_menu","window":2,"popup":1,)"
                       R"("menu":[1]})"),
            "each menu entry must be an object");
  EXPECT_EQ(WhyRefused(R"({"type":"close_popup_menu","window":2})"),
            "\"popup\" must be a whole number from 1");
}

TEST(ElectronProtocolTest, ABadSetMenuBarIsRefusedAsTheWindows) {
  const std::string flags = R"("visible":true,"auto_hide":false)";
  const std::string entry =
      R"("enabled":true,"visible":true,"checked":false)";
  EXPECT_EQ(ParseElectronRequest(
                R"({"type":"set_menu_bar","window":4,)" + flags + "}")
                .error(),
            (ElectronRefusal{
                .why = "\"menu\" must be a list of entries, or null for none",
                .window = 4}));
  EXPECT_EQ(WhyRefused(R"({"type":"set_menu_bar","window":1,"menu":[]})"),
            "\"visible\" and \"auto_hide\" must be true or false");
  EXPECT_EQ(WhyRefused(R"({"type":"set_menu_bar","window":1,"menu":[1],)" +
                       flags + "}"),
            "each menu entry must be an object");
  EXPECT_EQ(WhyRefused(R"({"type":"set_menu_bar","window":1,"menu":[{"id":0,)"
                       R"("type":"normal","label":"",)" +
                       entry + "}]," + flags + "}"),
            "a menu entry's \"id\" must be a whole number from 1");
  EXPECT_EQ(WhyRefused(R"({"type":"set_menu_bar","window":1,"menu":[{"id":1,)"
                       R"("type":"button","label":"",)" +
                       entry + "}]," + flags + "}"),
            "a menu entry's \"type\" must be normal, separator, submenu, "
            "checkbox or radio");
  EXPECT_EQ(WhyRefused(R"({"type":"set_menu_bar","window":1,"menu":[{"id":1,)"
                       R"("type":"normal","label":"","icon":"x.png",)" +
                       entry + "}]," + flags + "}"),
            "a menu entry's \"icon\" must be a PNG data: URL");
  EXPECT_EQ(WhyRefused(R"({"type":"set_menu_bar","window":1,"menu":[{"id":1,)"
                       R"("type":"submenu","label":"","submenu":[{"id":2}],)" +
                       entry + "}]," + flags + "}"),
            "a menu entry's \"type\" must be normal, separator, submenu, "
            "checkbox or radio");
}

TEST(ElectronProtocolTest, AShowMessageBoxKeepsWhatTheShellShows) {
  base::expected<ElectronRequest, ElectronRefusal> request =
      ParseElectronRequest(
          R"({"type":"show_message_box","window":2,"box":7,)"
          R"("box_type":"question","title":"Notes","message":"Quit Notes?",)"
          R"("detail":"Unsaved notes are kept.","buttons":["Cancel","Quit"],)"
          R"("default_id":1,"cancel_id":0,"checkbox_label":"Don't ask again",)"
          R"("checkbox_checked":false,"no_link":true})");

  ASSERT_TRUE(request.has_value()) << request.error().why;
  const auto& box = std::get<ElectronShowMessageBox>(*request);
  EXPECT_EQ(box.window, 2);
  EXPECT_EQ(box.box, 7);
  EXPECT_EQ(box.buttons, 2);
  EXPECT_EQ(box.cancel_id, 0);
  EXPECT_EQ(box.message_box,
            R"({"buttons":["Cancel","Quit"],"cancelId":0,)"
            R"("checkboxChecked":false,"checkboxLabel":"Don't ask again",)"
            R"("defaultId":1,"detail":"Unsaved notes are kept.",)"
            R"("message":"Quit Notes?","title":"Notes","type":"question"})");
}

TEST(ElectronProtocolTest, ABadShowMessageBoxIsRefusedAsTheWindows) {
  const std::string rest =
      R"("box_type":"info","title":"","message":"Hi","detail":"",)"
      R"("checkbox_label":"","checkbox_checked":false)";
  const auto box = [&](const std::string& fields) {
    return WhyRefused(R"({"type":"show_message_box","window":1,)" + fields +
                      "," + rest + "}");
  };
  EXPECT_EQ(
      ParseElectronRequest(R"({"type":"show_message_box","window":4,"box":0,)"
                           R"("buttons":["OK"],"default_id":0,"cancel_id":0,)" +
                           rest + "}")
          .error(),
      (ElectronRefusal{.why = "\"box\" must be a whole number from 1",
                       .window = 4}));
  EXPECT_EQ(box(R"("box":1,"buttons":[],"default_id":0,"cancel_id":0)"),
            "\"buttons\" must be a list of 1 to 16 labels");
  EXPECT_EQ(box(R"("box":1,"buttons":[1],"default_id":0,"cancel_id":0)"),
            "\"buttons\" must be a list of 1 to 16 labels");
  EXPECT_EQ(box(R"("box":1,"buttons":["OK"],"default_id":1,"cancel_id":0)"),
            "\"default_id\" must be a button's index, or -1 for no default");
  EXPECT_EQ(box(R"("box":1,"buttons":["OK"],"default_id":-1,"cancel_id":1)"),
            "\"cancel_id\" must be a button's index");
  EXPECT_EQ(WhyRefused(R"({"type":"show_message_box","window":1,"box":1,)"
                       R"("box_type":"alert","title":"","message":"",)"
                       R"("detail":"","checkbox_label":"",)"
                       R"("checkbox_checked":false,"buttons":["OK"],)"
                       R"("default_id":0,"cancel_id":0})"),
            "\"box_type\" must be none, info, error, question or warning");
}

TEST(ElectronProtocolTest, EventsAreOneLineEach) {
  EXPECT_EQ(ElectronReady({}, {}),
            "{\"chrome_version\":\"\",\"schemes\":[],\"type\":\"ready\","
            "\"user_agent\":\"\"}\n");
  EXPECT_EQ(ElectronRefused("no"), "{\"type\":\"refused\",\"why\":\"no\"}\n");
  EXPECT_EQ(ElectronWindowOpened(1),
            "{\"type\":\"window_opened\",\"window\":1}\n");
  EXPECT_EQ(ElectronWindowRefused(2, "gone"),
            "{\"type\":\"window_refused\",\"why\":\"gone\",\"window\":2}\n");
  EXPECT_EQ(ElectronWindowLoaded(3),
            "{\"type\":\"window_loaded\",\"window\":3}\n");
  EXPECT_EQ(ElectronWindowDomReady(3),
            "{\"type\":\"window_dom_ready\",\"window\":3}\n");
  EXPECT_EQ(ElectronTitleChanged(4, "Claude"),
            "{\"title\":\"Claude\",\"type\":\"title_changed\",\"window\":4}\n");
  EXPECT_EQ(ElectronWindowClosed(5),
            "{\"type\":\"window_closed\",\"window\":5}\n");
  EXPECT_EQ(ElectronCloseAsked(6), "{\"type\":\"close_asked\",\"window\":6}\n");
  EXPECT_EQ(
      ElectronPageStateChanged(
          2,
          ElectronPageState{
              .entries = {{.url = "https://a.test/", .title = "A"},
                          {.url = "https://b.test/", .title = ""}},
              .index = 1,
              .loading = true,
              .focused = true,
              .pid = 77,
              .crashed = false,
              .process_id = 9,
              .routing_id = 3,
              .frame_token = "ABC",
              .waiting = true}),
      "{\"crashed\":false,\"entries\":[{\"title\":\"A\",\"url\":"
      "\"https://a.test/\"},{\"title\":\"\",\"url\":\"https://b.test/\"}],"
      "\"focused\":true,\"frame_token\":\"ABC\",\"index\":1,"
      "\"loading\":true,\"pid\":77,\"process_id\":9,\"routing_id\":3,"
      "\"type\":\"page_state\",\"waiting\":true,\"window\":2}\n");
  EXPECT_EQ(ElectronFoundInPage(2, ElectronFindResult{.request = 4,
                                                      .matches = 3,
                                                      .active_match_ordinal = 1,
                                                      .x = 5,
                                                      .y = 6,
                                                      .width = 7,
                                                      .height = 8}),
            "{\"active_match_ordinal\":1,\"matches\":3,\"request\":4,"
            "\"selection\":{\"height\":8,\"width\":7,\"x\":5,\"y\":6},"
            "\"type\":\"found_in_page\",\"window\":2}\n");
  EXPECT_EQ(
      ElectronContextMenuAsked(
          2, ElectronContextMenu{
                 .x = 10,
                 .y = 20,
                 .page_url = "https://a.test/",
                 .is_editable = true,
                 .misspelled_word = "teh",
                 .dictionary_suggestions = {"the", "ten"},
                 .spellcheck_enabled = true,
                 .edit_flags = {.can_paste = true, .can_select_all = true},
                 .media_flags = {.can_save = true}}),
      "{\"alt_text\":\"\",\"dictionary_suggestions\":[\"the\",\"ten\"],"
      "\"edit_flags\":{\"can_copy\":false,\"can_cut\":false,"
      "\"can_delete\":false,\"can_edit_richly\":false,\"can_paste\":true,"
      "\"can_redo\":false,\"can_select_all\":true,\"can_undo\":false},"
      "\"frame_charset\":\"\",\"frame_url\":\"\",\"has_image_contents\":false,"
      "\"is_editable\":true,\"link_text\":\"\",\"link_url\":\"\","
      "\"media_flags\":{\"can_loop\":false,\"can_print\":false,"
      "\"can_rotate\":false,\"can_save\":true,"
      "\"can_show_picture_in_picture\":false,\"can_toggle_controls\":false,"
      "\"has_audio\":false,\"in_error\":false,\"is_controls_visible\":false,"
      "\"is_looping\":false,\"is_muted\":false,\"is_paused\":false,"
      "\"is_showing_picture_in_picture\":false},\"media_type\":\"none\","
      "\"misspelled_word\":\"teh\",\"page_url\":\"https://a.test/\","
      "\"selection_text\":\"\",\"spellcheck_enabled\":true,\"src_url\":\"\","
      "\"suggested_filename\":\"\",\"title_text\":\"\",\"type\":\"context_menu\","
      "\"window\":2,\"x\":10,\"y\":20}\n");
  EXPECT_EQ(ElectronMenuClicked(7, 12),
            "{\"command\":12,\"type\":\"menu_clicked\",\"window\":7}\n");
  EXPECT_EQ(
      ElectronWindowStateChanged(
          3, {.maximized = false, .minimized = true, .fullscreen = false}),
      "{\"fullscreen\":false,\"maximized\":false,\"minimized\":true,"
      "\"type\":\"window_state\",\"window\":3}\n");
  EXPECT_EQ(ElectronCookieChanged("persist:x", {.cookie = {.name = "lc",
                                                           .value = "1",
                                                           .domain = ".a.test",
                                                           .path = "/"},
                                                .cause = "inserted"}),
            "{\"cause\":\"inserted\",\"cookie\":{\"domain\":\".a.test\","
            "\"hostOnly\":false,\"httpOnly\":false,\"name\":\"lc\","
            "\"path\":\"/\",\"sameSite\":\"unspecified\",\"secure\":false,"
            "\"session\":true,\"value\":\"1\"},\"removed\":false,"
            "\"session\":\"persist:x\",\"type\":\"cookie_changed\"}\n");
  EXPECT_EQ(ElectronPopupMenuClosed(3, 5, 0),
            "{\"command\":0,\"popup\":5,\"type\":\"popup_menu_closed\","
            "\"window\":3}\n");
  EXPECT_EQ(ElectronMessageBoxAnswered(3, 9, 1, true),
            "{\"box\":9,\"checkbox_checked\":true,\"response\":1,"
            "\"type\":\"message_box_answered\",\"window\":3}\n");
  EXPECT_EQ(ElectronWindowResized(6, 800, 600),
            "{\"height\":600,\"type\":\"resized\",\"width\":800,"
            "\"window\":6}\n");
}

TEST(ElectronProtocolTest, OpenWindowCarriesItsPreload) {
  const auto request = ParseElectronRequest(
      R"({"type":"open_window","window":1,"url":"https://a.test/",)"
      R"("preload":"window.x = 1"})");

  ASSERT_TRUE(request.has_value()) << request.error().why;
  EXPECT_EQ(std::get<ElectronOpenWindow>(*request).preload, "window.x = 1");
  EXPECT_EQ(WhyRefused(R"({"type":"open_window","window":1,)"
                       R"("url":"https://a.test/","preload":3})"),
            "\"preload\" must be a string");
}

TEST(ElectronProtocolTest, IpcSendCarriesItsChannelAndArguments) {
  const auto request = ParseElectronRequest(
      R"({"type":"ipc_send","window":2,"channel":"ping","args":[1,"a"]})");

  ASSERT_TRUE(request.has_value()) << request.error().why;
  const auto& send = std::get<ElectronSendToPage>(*request);
  EXPECT_EQ(send.window, 2);
  EXPECT_EQ(send.channel, "ping");
  EXPECT_EQ(base::WriteJson(send.args), R"([1,"a"])");

  const auto refused = ParseElectronRequest(
      R"({"type":"ipc_send","window":2,"channel":"ping"})");
  ASSERT_FALSE(refused.has_value());
  EXPECT_EQ(refused.error(),
            (ElectronRefusal{.why = "\"args\" must be an array", .window = 2}));
}

TEST(ElectronProtocolTest, ExecuteJavaScriptCarriesItsCodeAndGesture) {
  const auto request = ParseElectronRequest(
      R"({"type":"execute_javascript","window":2,"call":5,"code":"1 + 1",)"
      R"("user_gesture":true})");

  ASSERT_TRUE(request.has_value()) << request.error().why;
  EXPECT_EQ(
      std::get<ElectronExecuteJavaScript>(*request),
      (ElectronExecuteJavaScript{
          .window = 2, .call = 5, .code = "1 + 1", .user_gesture = true}));

  const auto without_gesture = ParseElectronRequest(
      R"({"type":"execute_javascript","window":2,"call":6,"code":"x"})");
  ASSERT_TRUE(without_gesture.has_value()) << without_gesture.error().why;
  EXPECT_FALSE(
      std::get<ElectronExecuteJavaScript>(*without_gesture).user_gesture);

  const auto refused = ParseElectronRequest(
      R"({"type":"execute_javascript","window":2,"call":7})");
  ASSERT_FALSE(refused.has_value());
  EXPECT_EQ(refused.error(),
            (ElectronRefusal{.why = "\"code\" must be a string", .window = 2}));
  const auto no_call = ParseElectronRequest(
      R"({"type":"execute_javascript","window":2,"code":"x"})");
  ASSERT_FALSE(no_call.has_value());
  EXPECT_EQ(no_call.error().window, 2);
}

TEST(ElectronProtocolTest, AJavaScriptResultIsTheWindowsOneLine) {
  EXPECT_EQ(ElectronJavaScriptResult(2, 5, base::Value(2)),
            "{\"call\":5,\"result\":2,\"type\":\"javascript_result\","
            "\"window\":2}\n");
  EXPECT_EQ(ElectronJavaScriptResult(2, 6, base::unexpected("it threw")),
            "{\"call\":6,\"error\":\"it threw\",\"type\":"
            "\"javascript_result\",\"window\":2}\n");
  // Bytes have no JSON, so the app hears why instead of nothing.
  EXPECT_EQ(
      ElectronJavaScriptResult(2, 7, base::Value(base::Value::BlobStorage{1})),
      "{\"call\":7,\"error\":\"the script's result can't be carried to the "
      "app\",\"type\":\"javascript_result\",\"window\":2}\n");
}

TEST(ElectronProtocolTest, IpcReplyCarriesAResultOrWhyItFailed) {
  const auto result = ParseElectronRequest(
      R"({"type":"ipc_reply","invoke":3,"result":{"ok":true}})");
  ASSERT_TRUE(result.has_value()) << result.error().why;
  const auto& reply = std::get<ElectronReply>(*result);
  EXPECT_EQ(reply.invoke, 3);
  ASSERT_TRUE(reply.answer.has_value());
  EXPECT_EQ(base::WriteJson(*reply.answer), R"({"ok":true})");

  const auto nothing =
      ParseElectronRequest(R"({"type":"ipc_reply","invoke":4})");
  ASSERT_TRUE(nothing.has_value()) << nothing.error().why;
  EXPECT_TRUE(std::get<ElectronReply>(*nothing).answer->is_none());

  const auto failed = ParseElectronRequest(
      R"({"type":"ipc_reply","invoke":5,"error":"no handler"})");
  ASSERT_TRUE(failed.has_value()) << failed.error().why;
  EXPECT_EQ(std::get<ElectronReply>(*failed).answer,
            base::unexpected("no handler"));
}

TEST(ElectronProtocolTest, IpcReplyIsOneOrTheOther) {
  EXPECT_EQ(WhyRefused(R"({"type":"ipc_reply","invoke":1,"result":1,)"
                       R"("error":"x"})"),
            "a reply has a \"result\" or an \"error\", not both");
  EXPECT_EQ(WhyRefused(R"({"type":"ipc_reply","invoke":0})"),
            "\"invoke\" must be a whole number from 1");
  EXPECT_EQ(WhyRefused(R"({"type":"ipc_reply","invoke":1,"error":2})"),
            "\"error\" must be a string");
}

TEST(ElectronProtocolTest, IpcEventsAreOneLineEach) {
  base::ListValue args;
  args.Append(1);
  args.Append("a");
  EXPECT_EQ(ElectronIpcMessage(1, "ping", args),
            R"({"args":[1,"a"],"channel":"ping","type":"ipc_message",)"
            R"("window":1})"
            "\n");
  EXPECT_EQ(ElectronIpcInvoke(2, 7, "get", args),
            R"({"args":[1,"a"],"channel":"get","invoke":7,)"
            R"("type":"ipc_invoke","window":2})"
            "\n");
}

TEST(ElectronProtocolTest, APortIsNamedByWhoMadeItAndANumber) {
  EXPECT_TRUE(IsElectronPortName("m1"));
  EXPECT_TRUE(IsElectronPortName("r42"));
  EXPECT_FALSE(IsElectronPortName("m"));
  EXPECT_FALSE(IsElectronPortName("x1"));
  EXPECT_FALSE(IsElectronPortName("m1a"));
  EXPECT_FALSE(IsElectronPortName("m-1"));
  EXPECT_FALSE(IsElectronPortName("m12345678901234567"));
}

TEST(ElectronProtocolTest, IpcPostCarriesItsMessageAndTheMainProcesssPorts) {
  const auto posted =
      ParseElectronRequest(R"({"type":"ipc_post","window":2,"channel":"port",)"
                           R"("message":{"a":1},"ports":["m1","m2"]})");
  ASSERT_TRUE(posted.has_value()) << posted.error().why;
  const auto& post = std::get<ElectronPostToPage>(*posted);
  EXPECT_EQ(post.window, 2);
  EXPECT_EQ(post.channel, "port");
  EXPECT_EQ(base::WriteJson(post.message), R"({"a":1})");
  EXPECT_EQ(post.ports, (std::vector<std::string>{"m1", "m2"}));

  const auto bare = ParseElectronRequest(
      R"({"type":"ipc_post","window":2,"channel":"c","message":null})");
  ASSERT_TRUE(bare.has_value()) << bare.error().why;
  EXPECT_TRUE(std::get<ElectronPostToPage>(*bare).ports.empty());
}

TEST(ElectronProtocolTest, IpcPostRefusesThePagesPortsAndRepeats) {
  const auto pages = ParseElectronRequest(
      R"({"type":"ipc_post","window":2,"channel":"c","message":1,)"
      R"("ports":["r1"]})");
  ASSERT_FALSE(pages.has_value());
  EXPECT_EQ(pages.error().window, 2);
  EXPECT_EQ(pages.error().why,
            "\"ports\" must name the main process's own ports: \"m\", then a "
            "number");
  EXPECT_EQ(WhyRefused(R"({"type":"ipc_post","window":2,"channel":"c",)"
                       R"("message":1,"ports":["m1","m1"]})"),
            "a port is posted once");
  EXPECT_EQ(WhyRefused(R"({"type":"ipc_post","window":2,"channel":"c"})"),
            "\"message\" is missing");
  EXPECT_EQ(WhyRefused(R"({"type":"ipc_post","window":2,"channel":"c",)"
                       R"("message":1,"ports":"m1"})"),
            "\"ports\" must be an array");
}

TEST(ElectronProtocolTest, PortRequestsNameTheirPort) {
  const auto posted = ParseElectronRequest(
      R"({"type":"port_post","window":1,"port":"r3","data":[1]})");
  ASSERT_TRUE(posted.has_value()) << posted.error().why;
  const auto& post = std::get<ElectronPortPost>(*posted);
  EXPECT_EQ(post.window, 1);
  EXPECT_EQ(post.port, "r3");
  EXPECT_EQ(base::WriteJson(post.data), "[1]");

  const auto closed =
      ParseElectronRequest(R"({"type":"port_close","window":1,"port":"m2"})");
  ASSERT_TRUE(closed.has_value()) << closed.error().why;
  EXPECT_EQ(std::get<ElectronPortClose>(*closed).port, "m2");

  EXPECT_EQ(WhyRefused(R"({"type":"port_close","window":1,"port":"2"})"),
            "\"port\" must name a port: \"m\" or \"r\", then a number");
  EXPECT_EQ(WhyRefused(R"({"type":"port_post","window":1,"port":"m2"})"),
            "\"data\" is missing");
}

TEST(ElectronProtocolTest, SyncPortAndPageEventsAreOneLineEach) {
  base::ListValue args;
  args.Append(1);
  EXPECT_EQ(ElectronIpcSendSync(1, 3, "get", args),
            R"({"args":[1],"channel":"get","invoke":3,)"
            R"("type":"ipc_send_sync","window":1})"
            "\n");
  EXPECT_EQ(ElectronIpcPost(1, "port", base::Value("hi"), {"r1"}),
            R"({"channel":"port","message":"hi","ports":["r1"],)"
            R"("type":"ipc_post","window":1})"
            "\n");
  EXPECT_EQ(ElectronPortMessage(1, "m1", base::Value(2)),
            R"({"data":2,"port":"m1","type":"port_message","window":1})"
            "\n");
  EXPECT_EQ(ElectronPortClosed(1, "r1"),
            R"({"port":"r1","type":"port_closed","window":1})"
            "\n");
  EXPECT_EQ(ElectronPageGone(1), R"({"type":"page_gone","window":1})"
                                 "\n");
}

TEST(ElectronProtocolTest, WebRequestListenNamesTheSessionsEvents) {
  const auto request = ParseElectronRequest(
      R"({"type":"web_request_listen","session":"persist:x",)"
      R"("events":["before_request","completed","headers_received"]})");

  ASSERT_TRUE(request.has_value()) << request.error().why;
  EXPECT_EQ(std::get<ElectronWebRequestListen>(*request),
            (ElectronWebRequestListen{
                .session = "persist:x",
                .events = {ElectronWebRequestEvent::kBeforeRequest,
                           ElectronWebRequestEvent::kHeadersReceived,
                           ElectronWebRequestEvent::kCompleted}}));
  EXPECT_EQ(WhyRefused(R"({"type":"web_request_listen","session":"",)"
                       R"("events":["before_flying"]})"),
            "\"events\" must name webRequest events");
  EXPECT_EQ(WhyRefused(R"({"type":"web_request_listen","session":""})"),
            "\"events\" must name webRequest events");
}

TEST(ElectronProtocolTest, AWebRequestAnswerSaysWhatToChange) {
  const auto request = ParseElectronRequest(
      R"({"type":"web_request_answer","ask":3,"cancel":false,)"
      R"("redirect_url":"https://b.test/","request_headers":[["a","1"]],)"
      R"("response_headers":[["b","2"],["b","3"]],)"
      R"("status_line":"HTTP/1.1 200 OK"})");

  ASSERT_TRUE(request.has_value()) << request.error().why;
  EXPECT_EQ(std::get<ElectronWebRequestAnswer>(*request),
            (ElectronWebRequestAnswer{
                .ask = 3,
                .redirect_url = GURL("https://b.test/"),
                .request_headers = ElectronHeaders{{"a", "1"}},
                .response_headers = ElectronHeaders{{"b", "2"}, {"b", "3"}},
                .status_line = "HTTP/1.1 200 OK"}));
}

TEST(ElectronProtocolTest, AnEmptyWebRequestAnswerChangesNothing) {
  const auto request =
      ParseElectronRequest(R"({"type":"web_request_answer","ask":4})");

  ASSERT_TRUE(request.has_value()) << request.error().why;
  EXPECT_EQ(std::get<ElectronWebRequestAnswer>(*request),
            ElectronWebRequestAnswer{.ask = 4});
}

TEST(ElectronProtocolTest, ABadWebRequestAnswerIsRefused) {
  EXPECT_EQ(WhyRefused(R"({"type":"web_request_answer"})"),
            "\"ask\" must be a whole number from 1");
  EXPECT_EQ(WhyRefused(R"({"type":"web_request_answer","ask":1,)"
                       R"("redirect_url":"nowhere"})"),
            "\"redirect_url\" must be a URL");
  EXPECT_EQ(WhyRefused(R"({"type":"web_request_answer","ask":1,)"
                       R"("cancel":"yes"})"),
            "\"cancel\" must be true or false");
  EXPECT_EQ(WhyRefused(R"({"type":"web_request_answer","ask":1,)"
                       R"("request_headers":[["a b","1"]]})"),
            "\"a b\" is not a header name");
  EXPECT_EQ(WhyRefused(R"({"type":"web_request_answer","ask":1,)"
                       R"("status_line":"200 OK"})"),
            "\"status_line\" must be an HTTP status line");
}

TEST(ElectronProtocolTest, AWebRequestEventIsOneLine) {
  EXPECT_EQ(ElectronWebRequest(
                ElectronWebRequestEvent::kBeforeSendHeaders, 3, 1, "persist:x",
                ElectronWebRequestDetails{
                    .id = 7,
                    .url = GURL("https://a.test/"),
                    .method = "GET",
                    .resource_type = "mainFrame",
                    .referrer = "",
                    .request_headers = ElectronHeaders{{"a", "1"}}}),
            R"({"ask":3,"event":"before_send_headers","id":7,"method":"GET",)"
            R"("referrer":"","request_headers":[["a","1"]],)"
            R"("resource_type":"mainFrame","session":"persist:x",)"
            R"("type":"web_request","url":"https://a.test/","window":1})"
            "\n");
  EXPECT_EQ(ElectronWebRequest(ElectronWebRequestEvent::kErrorOccurred,
                               std::nullopt, std::nullopt, "",
                               ElectronWebRequestDetails{
                                   .id = 8,
                                   .url = GURL("https://a.test/x.js"),
                                   .method = "GET",
                                   .resource_type = "script",
                                   .referrer = "https://a.test/",
                                   .status_code = 404,
                                   .status_line = "HTTP/1.1 404 Not Found",
                                   .error = "net::ERR_ABORTED",
                                   .from_cache = true,
                                   .ip = "192.0.2.1"}),
            R"({"error":"net::ERR_ABORTED","event":"error_occurred",)"
            R"("from_cache":true,"id":8,"ip":"192.0.2.1","method":"GET",)"
            R"("referrer":"https://a.test/","resource_type":"script",)"
            R"("session":"","status_code":404,)"
            R"("status_line":"HTTP/1.1 404 Not Found","type":"web_request",)"
            R"("url":"https://a.test/x.js"})"
            "\n");
}

TEST(ElectronProtocolTest, APermissionHandlerIsSetOrCleared) {
  const auto set = ParseElectronRequest(
      R"({"type":"permission_handler","session":"persist:x","handle":true})");
  const auto cleared = ParseElectronRequest(
      R"({"type":"permission_handler","session":"","handle":false})");

  ASSERT_TRUE(set.has_value()) << set.error().why;
  ASSERT_TRUE(cleared.has_value()) << cleared.error().why;
  EXPECT_EQ(
      std::get<ElectronPermissionHandler>(*set),
      (ElectronPermissionHandler{.session = "persist:x", .handle = true}));
  EXPECT_EQ(std::get<ElectronPermissionHandler>(*cleared),
            (ElectronPermissionHandler{.session = "", .handle = false}));
  EXPECT_EQ(WhyRefused(R"({"type":"permission_handler","handle":true})"),
            "\"session\" must be a string");
  EXPECT_EQ(WhyRefused(R"({"type":"permission_handler","session":""})"),
            "\"handle\" must be true or false");
}

TEST(ElectronProtocolTest, APermissionAnswerGrantsOrDenies) {
  const auto request = ParseElectronRequest(
      R"({"type":"permission_answer","ask":2,"granted":true})");

  ASSERT_TRUE(request.has_value()) << request.error().why;
  EXPECT_EQ(std::get<ElectronPermissionAnswer>(*request),
            (ElectronPermissionAnswer{.ask = 2, .granted = true}));
  EXPECT_EQ(WhyRefused(R"({"type":"permission_answer","granted":true})"),
            "\"ask\" must be a whole number from 1");
  // No answer is not a denial: the app's bug is refused.
  EXPECT_EQ(WhyRefused(R"({"type":"permission_answer","ask":2})"),
            "\"granted\" must be true or false");
}

TEST(ElectronProtocolTest, AWindowOpenIsOneLine) {
  EXPECT_EQ(ElectronWindowOpen(
                7, 1,
                ElectronWindowOpenDetails{.url = GURL("https://b.test/"),
                                          .frame_name = "",
                                          .features = "width=500,height=600",
                                          .disposition = "foreground-tab",
                                          .referrer = GURL()}),
            R"({"ask":7,"disposition":"foreground-tab",)"
            R"("features":"width=500,height=600","frame_name":"",)"
            R"("referrer":"","type":"window_open","url":"https://b.test/",)"
            R"("window":1})"
            "\n");
}

TEST(ElectronProtocolTest, AWindowOpenAnswerDeniesOrAllowsAWindow) {
  const auto denied = ParseElectronRequest(
      R"({"type":"window_open_answer","ask":7,"action":"deny"})");
  ASSERT_TRUE(denied.has_value()) << denied.error().why;
  EXPECT_EQ(std::get<ElectronWindowOpenAnswer>(*denied).ask, 7);
  EXPECT_FALSE(std::get<ElectronWindowOpenAnswer>(*denied).open.has_value());

  const auto allowed = ParseElectronRequest(
      R"({"type":"window_open_answer","ask":7,"action":"allow","window":2,)"
      R"("title":"B","arguments":["--a"]})");
  ASSERT_TRUE(allowed.has_value()) << allowed.error().why;
  const ElectronWindowOpenAnswer& answer =
      std::get<ElectronWindowOpenAnswer>(*allowed);
  ASSERT_TRUE(answer.open.has_value());
  EXPECT_EQ(answer.open->window, 2);
  EXPECT_EQ(answer.open->title, "B");
  EXPECT_EQ(answer.open->arguments, std::vector<std::string>{"--a"});
  EXPECT_TRUE(answer.open->url.is_empty());
}

TEST(ElectronProtocolTest, AWindowOpenAnswerNamesNoAddressAndNoView) {
  EXPECT_EQ(WhyRefused(R"({"type":"window_open_answer","ask":7})"),
            "\"action\" must be \"allow\" or \"deny\"");
  EXPECT_EQ(WhyRefused(R"({"type":"window_open_answer","action":"deny"})"),
            "\"ask\" must be a whole number from 1");
  EXPECT_EQ(WhyRefused(R"({"type":"window_open_answer","ask":7,)"
                       R"("action":"allow"})"),
            "\"window\" must be a whole number from 1");
  EXPECT_EQ(
      WhyRefused(R"({"type":"window_open_answer","ask":7,"action":"allow",)"
                 R"("window":2,"url":"https://c.test/"})"),
      "a window_open_answer names no \"url\" or \"history\": the window "
      "opens where its page asked");
  EXPECT_EQ(
      WhyRefused(R"({"type":"window_open_answer","ask":7,"action":"allow",)"
                 R"("window":2,"view":true})"),
      "a page's new window is a window, not a view");
}

TEST(ElectronProtocolTest, ANavigationOrUnloadAnswerSaysWhetherItGoesOn) {
  const auto navigation = ParseElectronRequest(
      R"({"type":"navigation_answer","ask":3,"proceed":false})");
  const auto unload =
      ParseElectronRequest(R"({"type":"unload_answer","ask":4,"unload":true})");

  ASSERT_TRUE(navigation.has_value()) << navigation.error().why;
  ASSERT_TRUE(unload.has_value()) << unload.error().why;
  EXPECT_EQ(std::get<ElectronNavigationAnswer>(*navigation),
            (ElectronNavigationAnswer{.ask = 3, .proceed = false}));
  EXPECT_EQ(std::get<ElectronUnloadAnswer>(*unload),
            (ElectronUnloadAnswer{.ask = 4, .unload = true}));
  EXPECT_EQ(WhyRefused(R"({"type":"navigation_answer","proceed":true})"),
            "\"ask\" must be a whole number from 1");
  // No answer is not a yes: the app's bug is refused.
  EXPECT_EQ(WhyRefused(R"({"type":"navigation_answer","ask":3})"),
            "\"proceed\" must be true or false");
  EXPECT_EQ(WhyRefused(R"({"type":"unload_answer","ask":4})"),
            "\"unload\" must be true or false");
}

TEST(ElectronProtocolTest, NavigationEventsAreOneLineEach) {
  const ElectronNavigation navigation{
      .url = GURL("https://a.test/"),
      .main_frame = true,
      .frame = ElectronFrame{.process = 4, .routing = 1},
      .initiator = ElectronFrame{.process = 4, .routing = 2}};
  constexpr char kNavigation[] =
      R"("frame":{"process":4,"routing":1},)"
      R"("initiator":{"process":4,"routing":2},"main_frame":true,)"
      R"("same_document":false,)";

  EXPECT_EQ(ElectronNavigationStarted(1, navigation),
            base::StrCat({"{", kNavigation,
                          R"("type":"navigation_started",)"
                          R"("url":"https://a.test/","window":1})"
                          "\n"}));
  EXPECT_EQ(ElectronNavigationRedirected(1, navigation),
            base::StrCat({"{", kNavigation,
                          R"("type":"navigation_redirected",)"
                          R"("url":"https://a.test/","window":1})"
                          "\n"}));
  EXPECT_EQ(ElectronWillNavigate(3, 1, navigation, /*redirect=*/true),
            R"({"ask":3,"frame":{"process":4,"routing":1},)"
            R"("initiator":{"process":4,"routing":2},"main_frame":true,)"
            R"("redirect":true,"same_document":false,"type":"will_navigate",)"
            R"("url":"https://a.test/","window":1})"
            "\n");
  // A same-document navigation has no frame Chromium names, nor initiator.
  EXPECT_EQ(ElectronNavigationCommitted(
                2,
                ElectronNavigationCommit{
                    .navigation = {.url = GURL("https://a.test/#b"),
                                   .same_document = true},
                    .http_response_code = 200,
                    .http_status_text = "OK"}),
            R"({"http_response_code":200,"http_status_text":"OK",)"
            R"("main_frame":false,"same_document":true,)"
            R"("type":"navigation_committed","url":"https://a.test/#b",)"
            R"("window":2})"
            "\n");
  EXPECT_EQ(
      ElectronLoadFailed(2,
                         ElectronLoadFailure{
                             .url = GURL("https://a.test/"),
                             .main_frame = true,
                             .frame = ElectronFrame{.process = 4, .routing = 1},
                             .error_code = -105,
                             .error_description = "ERR_NAME_NOT_RESOLVED",
                             .provisional = true}),
      R"({"error_code":-105,"error_description":"ERR_NAME_NOT_RESOLVED",)"
      R"("frame":{"process":4,"routing":1},"main_frame":true,)"
      R"("provisional":true,"type":"load_failed","url":"https://a.test/",)"
      R"("window":2})"
      "\n");
  EXPECT_EQ(ElectronFrameLoaded(2, ElectronFrame{.process = 5, .routing = 6}),
            R"({"frame":{"process":5,"routing":6},"type":"frame_loaded",)"
            R"("window":2})"
            "\n");
  EXPECT_EQ(ElectronFrameCreated(2, ElectronFrame{.process = 5, .routing = 6},
                                 /*main_frame=*/false),
            R"({"frame":{"process":5,"routing":6},"main_frame":false,)"
            R"("type":"frame_created","window":2})"
            "\n");
  EXPECT_EQ(ElectronWillPreventUnload(4, 2),
            R"({"ask":4,"type":"will_prevent_unload","window":2})"
            "\n");
}

TEST(ElectronProtocolTest, APermissionRequestIsOneLine) {
  EXPECT_EQ(
      ElectronPermissionRequest(
          3, 1, "persist:x",
          ElectronPermissionDetails{.permission = "media",
                                    .requesting_url = GURL("https://a.test/"),
                                    .media_types = {"video", "audio"}}),
      R"({"ask":3,"media_types":["video","audio"],)"
      R"("permission":"media","requesting_url":"https://a.test/",)"
      R"("session":"persist:x","type":"permission_request","window":1})"
      "\n");
  EXPECT_EQ(
      ElectronPermissionRequest(
          4, std::nullopt, "",
          ElectronPermissionDetails{.permission = "notifications",
                                    .requesting_url = GURL("https://a.test/")}),
      R"({"ask":4,"permission":"notifications",)"
      R"("requesting_url":"https://a.test/","session":"",)"
      R"("type":"permission_request"})"
      "\n");
}

TEST(ElectronProtocolTest, ADownloadAnswerSavesCancelsOrAsksTheUser) {
  const auto save = ParseElectronRequest(
      R"({"type":"download_answer","download":2,"path":"/home/me/a.csv"})");
  const auto cancel = ParseElectronRequest(
      R"({"type":"download_answer","download":2,"cancel":true})");
  const auto ask =
      ParseElectronRequest(R"({"type":"download_answer","download":2})");

  ASSERT_TRUE(save.has_value()) << save.error().why;
  ASSERT_TRUE(cancel.has_value()) << cancel.error().why;
  ASSERT_TRUE(ask.has_value()) << ask.error().why;
  EXPECT_EQ(std::get<ElectronDownloadAnswer>(*save),
            (ElectronDownloadAnswer{.download = 2,
                                    .path = base::FilePath("/home/me/a.csv")}));
  EXPECT_EQ(std::get<ElectronDownloadAnswer>(*cancel),
            (ElectronDownloadAnswer{.download = 2, .cancel = true}));
  EXPECT_EQ(std::get<ElectronDownloadAnswer>(*ask),
            (ElectronDownloadAnswer{.download = 2}));
}

TEST(ElectronProtocolTest, ABadDownloadAnswerIsRefused) {
  EXPECT_EQ(WhyRefused(R"({"type":"download_answer"})"),
            "\"download\" must be a whole number from 1");
  // Electron's save path is absolute; a relative one would land wherever
  // the engine runs.
  EXPECT_EQ(WhyRefused(R"({"type":"download_answer","download":2,)"
                       R"("path":"a.csv"})"),
            "\"path\" must be an absolute path");
  EXPECT_EQ(WhyRefused(R"({"type":"download_answer","download":2,)"
                       R"("cancel":"yes"})"),
            "\"cancel\" must be true or false");
  EXPECT_EQ(WhyRefused(R"({"type":"download_answer","download":2,)"
                       R"("path":"/a.csv","cancel":true})"),
            "a download_answer cancels or names a path, not both");
}

TEST(ElectronProtocolTest, ADownloadControlPausesResumesOrCancels) {
  const auto pause = ParseElectronRequest(
      R"({"type":"download_control","download":3,"action":"pause"})");
  const auto resume = ParseElectronRequest(
      R"({"type":"download_control","download":3,"action":"resume"})");
  const auto cancel = ParseElectronRequest(
      R"({"type":"download_control","download":3,"action":"cancel"})");

  ASSERT_TRUE(pause.has_value()) << pause.error().why;
  ASSERT_TRUE(resume.has_value()) << resume.error().why;
  ASSERT_TRUE(cancel.has_value()) << cancel.error().why;
  EXPECT_EQ(std::get<ElectronDownloadControlCall>(*pause).action,
            ElectronDownloadAction::kPause);
  EXPECT_EQ(std::get<ElectronDownloadControlCall>(*resume).action,
            ElectronDownloadAction::kResume);
  EXPECT_EQ(std::get<ElectronDownloadControlCall>(*cancel),
            (ElectronDownloadControlCall{
                .download = 3, .action = ElectronDownloadAction::kCancel}));
  EXPECT_EQ(WhyRefused(R"({"type":"download_control","action":"pause"})"),
            "\"download\" must be a whole number from 1");
  EXPECT_EQ(WhyRefused(R"({"type":"download_control","download":3,)"
                       R"("action":"open"})"),
            "\"action\" must be \"pause\", \"resume\" or \"cancel\"");
}

TEST(ElectronProtocolTest, AWillDownloadIsOneLine) {
  EXPECT_EQ(
      ElectronWillDownload(
          2, 1, "",
          ElectronDownloadDetails{
              .url = GURL("https://files.test/a.csv"),
              .url_chain = {GURL("https://a.test/f"),
                            GURL("https://files.test/a.csv")},
              .filename = "a.csv",
              .mime_type = "text/csv",
              .total_bytes = 34498,
              .content_disposition = "attachment",
              .has_user_gesture = true,
              .start_time = 1.5,
              .etag = "\"e\"",
              .last_modified = "Mon, 23 Nov 2026 23:00:00 GMT",
              .initiator_origin = "https://a.test"}),
      R"({"content_disposition":"attachment","download":2,"etag":"\"e\"",)"
      R"("filename":"a.csv","has_user_gesture":true,)"
      R"("initiator_origin":"https://a.test",)"
      R"("last_modified":"Mon, 23 Nov 2026 23:00:00 GMT",)"
      R"("mime_type":"text/csv","session":"","start_time":1.5,)"
      R"("total_bytes":34498.0,"type":"will_download",)"
      R"("url":"https://files.test/a.csv","url_chain":["https://a.test/f",)"
      R"("https://files.test/a.csv"],"window":1})"
      "\n");
}

TEST(ElectronProtocolTest, ADownloadUpdateIsOneLine) {
  EXPECT_EQ(
      ElectronDownloadUpdated(2,
                              ElectronDownloadProgress{
                                  .state = ElectronDownloadState::kProgressing,
                                  .received_bytes = 100,
                                  .total_bytes = 34498,
                                  .bytes_per_second = 50,
                                  .save_path = base::FilePath("/home/me/a.csv"),
                                  .filename = "a.csv",
                                  .mime_type = "text/csv"}),
      R"({"bytes_per_second":50.0,"can_resume":false,"done":false,)"
      R"("download":2,"filename":"a.csv",)"
      R"("mime_type":"text/csv","paused":false,"received_bytes":100.0,)"
      R"("save_path":"/home/me/a.csv","state":"progressing",)"
      R"("total_bytes":34498.0,"type":"download_updated"})"
      "\n");
  EXPECT_EQ(
      ElectronDownloadUpdated(
          2, ElectronDownloadProgress{.state = ElectronDownloadState::kCanceled,
                                      .done = true,
                                      .end_time = 2.5}),
      R"({"bytes_per_second":0.0,"can_resume":false,"done":true,)"
      R"("download":2,"end_time":2.5,"filename":"","mime_type":"","paused":false,)"
      R"("received_bytes":0.0,"save_path":"","state":"canceled",)"
      R"("total_bytes":0.0,"type":"download_updated"})"
      "\n");
}

TEST(ElectronProtocolTest, OnlyBeforeRequestSendHeadersAndHeadersReceivedWait) {
  EXPECT_TRUE(IsBlockingElectronWebRequestEvent(
      ElectronWebRequestEvent::kBeforeRequest));
  EXPECT_TRUE(IsBlockingElectronWebRequestEvent(
      ElectronWebRequestEvent::kBeforeSendHeaders));
  EXPECT_TRUE(IsBlockingElectronWebRequestEvent(
      ElectronWebRequestEvent::kHeadersReceived));
  for (ElectronWebRequestEvent event :
       {ElectronWebRequestEvent::kSendHeaders,
        ElectronWebRequestEvent::kResponseStarted,
        ElectronWebRequestEvent::kBeforeRedirect,
        ElectronWebRequestEvent::kCompleted,
        ElectronWebRequestEvent::kErrorOccurred}) {
    EXPECT_FALSE(IsBlockingElectronWebRequestEvent(event));
  }
}

TEST(ElectronProtocolTest, ASessionCallNamesItsSessionAndMethod) {
  const auto get = ParseElectronRequest(
      R"({"type":"session_call","call":1,"session":"persist:a",)"
      R"("method":"cookies_get","filter":{"url":"https://a.test/x",)"
      R"("name":"n","domain":"a.test","path":"/","secure":true,)"
      R"("session":false,"http_only":true}})");
  ASSERT_TRUE(get.has_value()) << get.error().why;
  EXPECT_EQ(std::get<ElectronSessionCall>(*get),
            (ElectronSessionCall{.call = 1,
                                 .session = "persist:a",
                                 .method = ElectronGetCookies{
                                     .filter = {.url = GURL("https://a.test/x"),
                                                .name = "n",
                                                .domain = "a.test",
                                                .path = "/",
                                                .secure = true,
                                                .session = false,
                                                .http_only = true}}}));

  const auto all = ParseElectronRequest(
      R"({"type":"session_call","call":2,"session":"","method":"cookies_get"})");
  ASSERT_TRUE(all.has_value()) << all.error().why;
  EXPECT_EQ(std::get<ElectronSessionCall>(*all),
            (ElectronSessionCall{.call = 2, .method = ElectronGetCookies{}}));
}

TEST(ElectronProtocolTest, ASessionCallSetsAndRemovesCookies) {
  const auto set = ParseElectronRequest(
      R"({"type":"session_call","call":3,"session":"","method":"cookies_set",)"
      R"("details":{"url":"https://a.test/","name":"n","value":"v",)"
      R"("domain":".a.test","path":"/p","secure":true,"http_only":true,)"
      R"("expiration_date":1900000000.5,"same_site":"strict"}})");
  ASSERT_TRUE(set.has_value()) << set.error().why;
  EXPECT_EQ(std::get<ElectronSessionCall>(*set).method,
            ElectronSessionMethod(
                ElectronSetCookie{.details = {.url = GURL("https://a.test/"),
                                              .name = "n",
                                              .value = "v",
                                              .domain = ".a.test",
                                              .path = "/p",
                                              .secure = true,
                                              .http_only = true,
                                              .expiration_date = 1900000000.5,
                                              .same_site = "strict"}}));

  const auto bare = ParseElectronRequest(
      R"({"type":"session_call","call":4,"session":"","method":"cookies_set",)"
      R"("details":{"url":"https://a.test/"}})");
  ASSERT_TRUE(bare.has_value()) << bare.error().why;
  EXPECT_EQ(std::get<ElectronSessionCall>(*bare).method,
            ElectronSessionMethod(ElectronSetCookie{
                .details = {.url = GURL("https://a.test/")}}));

  const auto remove = ParseElectronRequest(
      R"({"type":"session_call","call":5,"session":"","method":"cookies_remove",)"
      R"("url":"https://a.test/","name":"n"})");
  ASSERT_TRUE(remove.has_value()) << remove.error().why;
  EXPECT_EQ(std::get<ElectronSessionCall>(*remove).method,
            ElectronSessionMethod(ElectronRemoveCookie{
                .url = GURL("https://a.test/"), .name = "n"}));
}

TEST(ElectronProtocolTest, ASessionCallClearsStorageAndSetsTheUserAgent) {
  const auto clear = ParseElectronRequest(
      R"({"type":"session_call","call":6,"session":"","method":"clear_storage_data",)"
      R"("origin":"https://a.test","storages":["cookies","localstorage"]})");
  ASSERT_TRUE(clear.has_value()) << clear.error().why;
  EXPECT_EQ(std::get<ElectronSessionCall>(*clear).method,
            ElectronSessionMethod(
                ElectronClearStorage{.origin = GURL("https://a.test"),
                                     .storages = {"cookies", "localstorage"}}));

  const auto everything = ParseElectronRequest(
      R"({"type":"session_call","call":7,"session":"","method":"clear_storage_data"})");
  ASSERT_TRUE(everything.has_value()) << everything.error().why;
  EXPECT_EQ(std::get<ElectronSessionCall>(*everything).method,
            ElectronSessionMethod(ElectronClearStorage{}));

  const auto agent = ParseElectronRequest(
      R"({"type":"session_call","call":8,"session":"","method":"set_user_agent",)"
      R"("user_agent":"Claude/1"})");
  ASSERT_TRUE(agent.has_value()) << agent.error().why;
  EXPECT_EQ(
      std::get<ElectronSessionCall>(*agent).method,
      ElectronSessionMethod(ElectronSetUserAgent{.user_agent = "Claude/1"}));

  for (const auto& [method, expected] :
       {std::pair<std::string, ElectronSessionMethod>{"clear_cache",
                                                      ElectronClearCache{}},
        {"cookies_flush", ElectronFlushCookies{}},
        {"cookies_watch", ElectronWatchCookies{}}}) {
    const auto call = ParseElectronRequest(base::StrCat(
        {R"({"type":"session_call","call":9,"session":"","method":")", method,
         R"("})"}));
    ASSERT_TRUE(call.has_value()) << call.error().why;
    EXPECT_EQ(std::get<ElectronSessionCall>(*call).method, expected);
  }
}

TEST(ElectronProtocolTest, ABadSessionCallIsRefused) {
  EXPECT_EQ(
      WhyRefused(
          R"({"type":"session_call","session":"","method":"clear_cache"})"),
      "\"call\" must be a whole number from 1");
  EXPECT_EQ(
      WhyRefused(R"({"type":"session_call","call":1,"method":"clear_cache"})"),
      "\"session\" must be a string");
  EXPECT_EQ(
      WhyRefused(
          R"({"type":"session_call","call":1,"session":"","method":"x"})"),
      "no session call is named x");
  EXPECT_EQ(WhyRefused(R"({"type":"session_call","call":1,"session":"",)"
                       R"("method":"cookies_set","details":{}})"),
            "\"url\" must be a string");
  EXPECT_EQ(
      WhyRefused(R"({"type":"session_call","call":1,"session":"",)"
                 R"("method":"cookies_set","details":{"url":"https://a.test/",)"
                 R"("same_site":"sometimes"}})"),
      "\"same_site\" must be unspecified, no_restriction, lax or strict");
  EXPECT_EQ(WhyRefused(R"({"type":"session_call","call":1,"session":"",)"
                       R"("method":"cookies_get","filter":{"secure":"yes"}})"),
            "\"secure\" must be true or false");
  EXPECT_EQ(WhyRefused(R"({"type":"session_call","call":1,"session":"",)"
                       R"("method":"clear_storage_data","storages":["disk"]})"),
            "\"disk\" is not a storage clearStorageData knows");
  EXPECT_EQ(WhyRefused(R"({"type":"session_call","call":1,"session":"",)"
                       R"("method":"set_user_agent"})"),
            "\"user_agent\" must be a string");
}

TEST(ElectronProtocolTest, ASessionResultIsOneLine) {
  EXPECT_EQ(ElectronSessionResult(1, base::Value()),
            "{\"call\":1,\"result\":null,\"type\":\"session_result\"}\n");
  EXPECT_EQ(ElectronSessionResult(2, base::unexpected("no")),
            "{\"call\":2,\"error\":\"no\",\"type\":\"session_result\"}\n");
  std::string json;
  base::JSONWriter::Write(ElectronCookieValue({.name = "n",
                                               .value = "v",
                                               .domain = "a.test",
                                               .host_only = true,
                                               .path = "/",
                                               .secure = true,
                                               .http_only = false,
                                               .expiration_date = 2.5,
                                               .same_site = "lax"}),
                          &json);
  EXPECT_EQ(json, R"({"domain":"a.test","expirationDate":2.5,"hostOnly":true,)"
                  R"("httpOnly":false,"name":"n","path":"/","sameSite":"lax",)"
                  R"("secure":true,"session":false,"value":"v"})");
}

TEST(ElectronProtocolTest, ACookieFilterMatchesAsElectronsDoes) {
  const ElectronCookie cookie{.name = "n",
                              .value = "v",
                              .domain = ".a.test",
                              .path = "/p",
                              .secure = true,
                              .http_only = true};
  EXPECT_TRUE(ElectronCookieMatches(cookie, {}));
  EXPECT_TRUE(ElectronCookieMatches(cookie, {.name = "n"}));
  EXPECT_FALSE(ElectronCookieMatches(cookie, {.name = "m"}));
  EXPECT_TRUE(ElectronCookieMatches(cookie, {.domain = "a.test"}));
  EXPECT_TRUE(ElectronCookieMatches({.name = "n", .domain = "b.a.test"},
                                    {.domain = "a.test"}));
  EXPECT_FALSE(ElectronCookieMatches({.name = "n", .domain = "ba.test"},
                                     {.domain = "a.test"}));
  EXPECT_FALSE(ElectronCookieMatches(cookie, {.domain = "b.a.test"}));
  EXPECT_TRUE(ElectronCookieMatches(cookie, {.path = "/p"}));
  EXPECT_FALSE(ElectronCookieMatches(cookie, {.path = "/"}));
  EXPECT_FALSE(ElectronCookieMatches(cookie, {.secure = false}));
  EXPECT_TRUE(ElectronCookieMatches(cookie, {.session = true}));
  EXPECT_FALSE(ElectronCookieMatches({.name = "n", .expiration_date = 1},
                                     {.session = true}));
  EXPECT_FALSE(ElectronCookieMatches(cookie, {.http_only = false}));
}

TEST(ElectronProtocolTest, ASignInAnswerSignsInCancelsOrLeavesItToTheShell) {
  const auto sign_in = ParseElectronRequest(
      R"({"type":"login_answer","ask":1,"action":"sign_in",)"
      R"("username":"me","password":"secret"})");
  ASSERT_TRUE(sign_in.has_value()) << sign_in.error().why;
  EXPECT_EQ(std::get<ElectronSignInReply>(*sign_in),
            ElectronSignInReply(ElectronLoginReply{
                .ask = 1,
                .answer = {.action = ElectronLoginAction::kSignIn,
                           .username = u"me",
                           .password = u"secret"}}));
  const auto by_default = ParseElectronRequest(
      R"({"type":"login_answer","ask":2,"action":"default"})");
  ASSERT_TRUE(by_default.has_value()) << by_default.error().why;
  EXPECT_EQ(std::get<ElectronSignInReply>(*by_default),
            ElectronSignInReply(ElectronLoginReply{
                .ask = 2, .answer = {.action = ElectronLoginAction::kDefault}}));

  EXPECT_EQ(WhyRefused(R"({"type":"login_answer","ask":1,"action":"sign_in"})"),
            "a sign-in's \"username\" and \"password\" must be strings");
  EXPECT_EQ(WhyRefused(R"({"type":"login_answer","action":"cancel"})"),
            "\"ask\" must be a whole number from 1");
}

TEST(ElectronProtocolTest, ACertificateAnswerAllowsOrPicksOneOrNone) {
  const auto allow = ParseElectronRequest(
      R"({"type":"certificate_answer","ask":3,"allow":true})");
  ASSERT_TRUE(allow.has_value()) << allow.error().why;
  EXPECT_EQ(std::get<ElectronSignInReply>(*allow),
            ElectronSignInReply(ElectronCertificateReply{.ask = 3, .allow = true}));
  const auto picked = ParseElectronRequest(
      R"({"type":"client_certificate_answer","ask":4,"certificate":1})");
  ASSERT_TRUE(picked.has_value()) << picked.error().why;
  EXPECT_EQ(std::get<ElectronSignInReply>(*picked),
            ElectronSignInReply(
                ElectronClientCertificateReply{.ask = 4, .certificate = 1}));
  const auto none = ParseElectronRequest(
      R"({"type":"client_certificate_answer","ask":5})");
  ASSERT_TRUE(none.has_value()) << none.error().why;
  EXPECT_EQ(std::get<ElectronSignInReply>(*none),
            ElectronSignInReply(ElectronClientCertificateReply{.ask = 5}));

  EXPECT_EQ(WhyRefused(R"({"type":"certificate_answer","ask":3})"),
            "\"allow\" must be true or false");
  EXPECT_EQ(WhyRefused(
                R"({"type":"client_certificate_answer","ask":5,"certificate":-1})"),
            "\"certificate\" must be the index of one the engine offered");
}

TEST(ElectronProtocolTest, ALoginAskNamesItsChallenge) {
  EXPECT_EQ(
      ElectronLoginAsked(1, 2, "persist:a",
                         {.url = GURL("https://a.test/"),
                          .is_proxy = true,
                          .scheme = "basic",
                          .host = "proxy.test",
                          .port = 3128,
                          .realm = "office"}),
      R"({"ask":1,"auth_info":{"host":"proxy.test","is_proxy":true,)"
      R"("port":3128,"realm":"office","scheme":"basic"},)"
      R"("session":"persist:a","type":"login","url":"https://a.test/",)"
      R"("window":2})"
      "\n");
}

TEST(ElectronProtocolTest, ANetworkSessionCallCarriesElectronsOptions) {
  const auto clear = ParseElectronRequest(
      R"({"type":"session_call","call":1,"session":"","method":"clear_data",)"
      R"("data_types":["cookies","cache"],"exclude_origins":["https://b.test"],)"
      R"("avoid_closing_connections":true,)"
      R"("origin_matching_mode":"origin-in-all-contexts"})");
  ASSERT_TRUE(clear.has_value()) << clear.error().why;
  EXPECT_EQ(std::get<ElectronSessionCall>(*clear).method,
            ElectronSessionMethod(ElectronNetworkCall(ElectronClearData{
                .data_types = {"cookies", "cache"},
                .exclude_origins = {GURL("https://b.test")},
                .avoid_closing_connections = true,
                .origin_in_all_contexts = true})));

  const auto resolve = ParseElectronRequest(
      R"({"type":"session_call","call":2,"session":"","method":"resolve_host",)"
      R"("host":"a.test","query_type":"AAAA"})");
  ASSERT_TRUE(resolve.has_value()) << resolve.error().why;
  EXPECT_EQ(std::get<ElectronSessionCall>(*resolve).method,
            ElectronSessionMethod(ElectronNetworkCall(
                ElectronResolveHost{.host = "a.test", .query_type = "AAAA"})));

  const auto key = ParseElectronRequest(
      R"({"type":"session_call","call":3,"session":"",)"
      R"("method":"get_shared_dictionary_info",)"
      R"("frame_origin":"https://a.test","top_frame_site":"https://a.test"})");
  ASSERT_TRUE(key.has_value()) << key.error().why;
  EXPECT_EQ(std::get<ElectronSessionCall>(*key).method,
            ElectronSessionMethod(ElectronNetworkCall(
                ElectronGetSharedDictionaryInfo{
                    .key = {.frame_origin = GURL("https://a.test"),
                            .top_frame_site = GURL("https://a.test")}})));

  const auto watch = ParseElectronRequest(
      R"({"type":"session_call","call":4,"session":"",)"
      R"("method":"service_workers_watch"})");
  ASSERT_TRUE(watch.has_value()) << watch.error().why;
  EXPECT_EQ(std::get<ElectronSessionCall>(*watch).method,
            ElectronSessionMethod(ElectronWatchServiceWorkers{}));

  const auto code_cache = ParseElectronRequest(
      R"({"type":"session_call","call":5,"session":"",)"
      R"("method":"set_code_cache_path","path":"/home/a/code"})");
  ASSERT_TRUE(code_cache.has_value()) << code_cache.error().why;
  EXPECT_EQ(std::get<ElectronSessionCall>(*code_cache).method,
            ElectronSessionMethod(ElectronNetworkCall(ElectronSetCodeCachePath{
                .path = base::FilePath("/home/a/code")})));
}

TEST(ElectronProtocolTest, ABadNetworkSessionCallIsRefusedAsTheCalls) {
  const auto both = ParseElectronRequest(
      R"({"type":"session_call","call":1,"session":"","method":"clear_data",)"
      R"("origins":["https://a.test"],"exclude_origins":["https://b.test"]})");
  ASSERT_FALSE(both.has_value());
  EXPECT_EQ(both.error(),
            (ElectronRefusal{
                .why = "clearData takes \"origins\" or \"exclude_origins\", "
                       "not both",
                .call = 1}));
  EXPECT_EQ(
      WhyRefused(R"({"type":"session_call","call":2,"session":"",)"
                 R"("method":"preconnect_sockets","url":"https://a.test/",)"
                 R"("sockets":7})"),
      "\"sockets\" must be a whole number from 1 to 6");
  EXPECT_EQ(
      WhyRefused(R"({"type":"session_call","call":3,"session":"",)"
                 R"("method":"clear_data","data_types":["everything"]})"),
      "\"everything\" is not a type clearData knows");
  EXPECT_EQ(WhyRefused(R"({"type":"session_call","call":4,"session":"",)"
                       R"("method":"set_code_cache_path","path":"code"})"),
            "\"path\" must be an absolute path");
}

TEST(ElectronProtocolTest, AServiceWorkerChangeIsOneLine) {
  EXPECT_EQ(
      ElectronServiceWorkerChanged(
          "", ElectronServiceWorkerStatus{
                  .version_id = 2,
                  .running_status = "running",
                  .worker = ElectronRunningServiceWorker{
                      .version_id = 2,
                      .scope = GURL("https://a.test/"),
                      .script_url = GURL("https://a.test/sw.js"),
                      .render_process_id = 7}}),
      R"({"event":"running_status","running_status":"running","session":"",)"
      R"("type":"service_worker","version_id":2.0,"worker":{)"
      R"("render_process_id":7,"scope":"https://a.test/",)"
      R"("script_url":"https://a.test/sw.js","version_id":2.0}})"
      "\n");
}

}  // namespace
}  // namespace domicile
