// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/browser/electron_app.h"

#include <map>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <variant>
#include <vector>

#include "base/files/file_path.h"
#include "base/functional/bind.h"
#include "base/json/json_writer.h"
#include "base/memory/raw_ref.h"
#include "base/memory/weak_ptr.h"
#include "base/strings/strcat.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/string_util.h"
#include "base/test/bind.h"
#include "base/types/expected.h"
#include "base/values.h"
#include "testing/gtest/include/gtest/gtest.h"
#include "url/gurl.h"

namespace domicile {
namespace {

constexpr char kHello[] =
    R"({"type":"hello","version":1,"app_id":"com.anthropic.Claude",)"
    R"("partition":"persist:electron-claude","electron_version":"45.2.1",)"
    R"("resources_path":"/opt/Claude/resources"})";

// A held page that says when it is destroyed, as a denied window closes.
class FakeHeldPage final : public ElectronHeldPage {
 public:
  explicit FakeHeldPage(std::string name, std::vector<std::string>& calls)
      : name_(std::move(name)), calls_(calls) {}
  ~FakeHeldPage() override { calls_->push_back("destroy held " + name_); }
  const std::string& name() const { return name_; }

 private:
  const std::string name_;
  const raw_ref<std::vector<std::string>> calls_;
};

// A watch whose workers are the ones it was made with.
class FakeServiceWorkerWatch final : public ElectronServiceWorkerWatch {
 public:
  explicit FakeServiceWorkerWatch(
      std::vector<ElectronRunningServiceWorker> running)
      : running_(std::move(running)) {}
  std::vector<ElectronRunningServiceWorker> Running() const override {
    return running_;
  }

 private:
  const std::vector<ElectronRunningServiceWorker> running_;
};

// A desk that numbers its windows from 10 and writes down each call.
class FakeDesk final : public ElectronDesk {
 public:
  std::optional<std::string> Adopt(std::unique_ptr<ElectronHeldPage> page,
                                   const std::string& app_id,
                                   const std::string& preload,
                                   const std::vector<std::string>& arguments,
                                   const std::optional<ElectronNode>& node,
                                   ElectronPageCalls page_calls,
                                   base::WeakPtr<ElectronSession> session,
                                   const std::string& title,
                                   bool hidden,
                                   const std::string& user_agent) override {
    if (!has_shell) {
      return std::nullopt;
    }
    calls.push_back(
        "adopt " + static_cast<FakeHeldPage&>(*page).name() + " as " + app_id +
        (preload.empty() ? "" : " with " + preload) +
        (title.empty() ? "" : " titled " + title) + (hidden ? " hidden" : "") +
        (user_agent.empty() ? "" : " as agent " + user_agent));
    adopted.push_back(std::move(page));
    const std::string id = base::NumberToString(next_id++);
    pages.emplace(id, std::move(page_calls));
    sessions.emplace(id, std::move(session));
    return id;
  }
  std::optional<std::string> Open(const GURL& url,
                                  const std::optional<ElectronHistory>& history,
                                  const std::string& app_id,
                                  const WebViewPartition& partition,
                                  const std::string& preload,
                                  const std::vector<std::string>& arguments,
                                  const std::optional<ElectronNode>& node,
                                  ElectronPageCalls page_calls,
                                  base::WeakPtr<ElectronSession> session,
                                  bool view,
                                  const std::string& title,
                                  bool hidden,
                                  const std::string& user_agent) override {
    if (!has_shell) {
      return std::nullopt;
    }
    calls.push_back(
        std::string(view ? "open view " : "open ") + url.spec() + " as " +
        app_id + (preload.empty() ? "" : " with " + preload) +
        (arguments.empty()
             ? ""
             : " with arguments " + base::JoinString(arguments, " ")) +
        (node.has_value() ? " with node" : "") +
        (title.empty() ? "" : " titled " + title) + (hidden ? " hidden" : "") +
        (history.has_value()
             ? " restoring " + base::NumberToString(history->entries.size()) +
                   " entries at " + base::NumberToString(history->index)
             : "") +
        (user_agent.empty() ? "" : " as agent " + user_agent));
    const std::string id = base::NumberToString(next_id++);
    pages.emplace(id, std::move(page_calls));
    partitions.emplace(id, partition);
    sessions.emplace(id, std::move(session));
    return id;
  }
  void Load(const std::string& id, const GURL& url) override {
    calls.push_back("load " + id + " " + url.spec());
  }
  void Focus(const std::string& id) override { calls.push_back("focus " + id); }
  void GoToIndex(const std::string& id, int index) override {
    calls.push_back("go " + id + " " + base::NumberToString(index));
  }
  void ClearHistory(const std::string& id) override {
    calls.push_back("clear history " + id);
  }
  void RemoveHistoryEntry(const std::string& id, int index) override {
    calls.push_back("remove entry " + id + " " + base::NumberToString(index));
  }
  void Edit(const std::string& id, ElectronEditCommand command) override {
    calls.push_back("edit " + id + " " +
                    base::NumberToString(static_cast<int>(command)));
  }
  void Replace(const std::string& id,
               const std::string& text,
               bool misspelling) override {
    calls.push_back(
        std::string(misspelling ? "replace misspelling " : "replace ") + id +
        " " + text);
  }
  void FindInPage(const std::string& id,
                  const ElectronFindInPage& find) override {
    calls.push_back("find " + id + " " + base::NumberToString(find.request) +
                    " " + find.text);
  }
  void StopFindInPage(const std::string& id,
                      ElectronStopFindAction action) override {
    calls.push_back("stop find " + id + " " +
                    base::NumberToString(static_cast<int>(action)));
  }
  void SetTitle(const std::string& id, const std::string& title) override {
    calls.push_back("title " + id + " " + title);
  }
  void SetHidden(const std::string& id, bool hidden) override {
    calls.push_back(std::string(hidden ? "hide " : "show ") + id);
  }
  void SetWindowState(const std::string& id,
                      ElectronWindowState state) override {
    calls.push_back(base::StrCat(
        {"state of ", id, state.maximized ? " max" : "",
         state.minimized ? " min" : "", state.fullscreen ? " full" : ""}));
  }
  void AskToClose(const std::string& id) override {
    calls.push_back("ask to close " + id);
  }
  void Close(const std::string& id) override { calls.push_back("close " + id); }
  void SetViews(const std::string& id,
                std::vector<ElectronDeskView> views) override {
    calls.push_back("set views of " + id);
    held[id] = std::move(views);
  }
  void SetMenuBar(const std::string& id, ElectronDeskMenuBar bar) override {
    calls.push_back("set menu bar of " + id);
    menu_bars[id] = std::move(bar);
  }
  void ShowMessageBox(
      const std::string& id,
      ElectronDeskMessageBox box,
      base::OnceCallback<void(int response, bool checkbox_checked)> answered)
      override {
    calls.push_back("show message box over " + id);
    message_boxes.push_back(
        {.id = id, .box = std::move(box), .answered = std::move(answered)});
  }
  void ShowPopupMenu(const std::string& id,
                     ElectronDeskPopupMenu menu,
                     base::OnceCallback<void(int)> closed) override {
    calls.push_back("popup over " + id);
    popups.push_back(
        {.id = id, .menu = std::move(menu), .closed = std::move(closed)});
  }
  void ClosePopupMenu(const std::string& id) override {
    calls.push_back("close popup over " + id);
  }
  void SendToPage(const std::string& id,
                  const std::string& channel,
                  const std::string& args_json) override {
    calls.push_back("send " + id + " " + channel + " " + args_json);
  }
  void ExecuteJavaScript(
      const std::string& id,
      const std::string& code,
      bool user_gesture,
      base::OnceCallback<void(base::expected<base::Value, std::string>)> done)
      override {
    calls.push_back("run " + id + " " + code +
                    (user_gesture ? " with a gesture" : ""));
    ran.push_back(std::move(done));
  }
  void PostToPage(const std::string& id,
                  const std::string& channel,
                  const std::string& message_json,
                  const std::vector<std::string>& ports) override {
    std::string line = "post " + id + " " + channel + " " + message_json;
    for (const std::string& port : ports) {
      line += " " + port;
    }
    calls.push_back(line);
  }
  void PostToPort(const std::string& id,
                  const std::string& port,
                  const std::string& data_json) override {
    calls.push_back("port " + id + " " + port + " " + data_json);
  }
  void ClosePort(const std::string& id, const std::string& port) override {
    calls.push_back("close port " + id + " " + port);
  }
  void SetUserAgent(const std::string& id,
                    const std::string& user_agent) override {
    calls.push_back("user agent " + id + " " + user_agent);
  }
  void CallPage(const std::string& id,
                ElectronPageMethod method,
                ElectronAnswer done) override {
    calls.push_back("page call " + id);
    page_methods.push_back(std::move(method));
    page_answers.push_back(std::move(done));
  }
  std::optional<std::string> AskPage(const std::string& id,
                                     ElectronPageAction action) override {
    asked.emplace_back(id, std::move(action));
    return page_refusal;
  }
  void GetCookies(
      const WebViewPartition& partition,
      const std::optional<GURL>& url,
      base::OnceCallback<void(std::vector<ElectronCookie>)> done) override {
    calls.push_back("get cookies in " + partition.name +
                    (url.has_value() ? " for " + url->spec() : ""));
    std::move(done).Run(cookies);
  }
  void SetCookie(
      const WebViewPartition& partition,
      const ElectronCookieDetails& details,
      base::OnceCallback<void(std::optional<std::string>)> done) override {
    calls.push_back("set cookie " + details.name + " in " + partition.name);
    std::move(done).Run(cookie_refusal);
  }
  void RemoveCookie(const WebViewPartition& partition,
                    const GURL& url,
                    const std::string& name,
                    base::OnceClosure done) override {
    calls.push_back("remove cookie " + name + " for " + url.spec());
    std::move(done).Run();
  }
  void FlushCookies(const WebViewPartition& partition,
                    base::OnceClosure done) override {
    calls.push_back("flush cookies in " + partition.name);
    std::move(done).Run();
  }
  std::unique_ptr<ElectronCookieWatch> WatchCookies(
      const WebViewPartition& partition,
      base::RepeatingCallback<void(const ElectronCookieChange& change)> changed)
      override {
    calls.push_back("watch cookies in " + partition.name);
    cookie_changed = std::move(changed);
    return std::make_unique<ElectronCookieWatch>();
  }
  void ClearStorage(const WebViewPartition& partition,
                    const ElectronClearStorage& clear,
                    base::OnceClosure done) override {
    calls.push_back("clear storage in " + partition.name);
    waiting = std::move(done);
  }
  void ClearCache(const WebViewPartition& partition,
                  base::OnceClosure done) override {
    calls.push_back("clear cache in " + partition.name);
    std::move(done).Run();
  }
  void RunNetworkCall(
      const WebViewPartition& partition,
      const ElectronNetworkCall& call,
      base::OnceCallback<void(base::expected<base::Value, std::string>)> done)
      override {
    calls.push_back("network call " + base::NumberToString(call.index()) +
                    " in " + partition.name);
    std::move(done).Run(base::Value("done"));
  }
  std::unique_ptr<ElectronServiceWorkerWatch> WatchServiceWorkers(
      const WebViewPartition& partition,
      base::RepeatingCallback<void(const ElectronServiceWorkerChange& change)>
          changed) override {
    calls.push_back("watch service workers in " + partition.name);
    service_worker_changed = std::move(changed);
    return std::make_unique<FakeServiceWorkerWatch>(running_workers);
  }

  bool has_shell = true;
  // What AskPage was asked, by window id, oldest first, and why it refuses.
  std::vector<std::pair<std::string, ElectronPageAction>> asked;
  std::optional<std::string> page_refusal;
  // What each window's page may call, by id.
  std::map<std::string, ElectronPageCalls> pages;
  // What the last WatchCookies was told to call.
  base::RepeatingCallback<void(const ElectronCookieChange& change)>
      cookie_changed;
  // What the last WatchServiceWorkers was told to call, and the workers its
  // watches say are running.
  base::RepeatingCallback<void(const ElectronServiceWorkerChange& change)>
      service_worker_changed;
  std::vector<ElectronRunningServiceWorker> running_workers;
  // Each window's partition and session, by id.
  std::map<std::string, WebViewPartition> partitions;
  std::map<std::string, base::WeakPtr<ElectronSession>> sessions;
  int next_id = 10;
  std::vector<std::string> calls;
  // The views each window holds, by id, as SetViews last set them.
  std::map<std::string, std::vector<ElectronDeskView>> held;
  std::map<std::string, ElectronDeskMenuBar> menu_bars;
  // The message boxes asked, oldest first, each with its answer.
  struct AskedBox {
    std::string id;
    ElectronDeskMessageBox box;
    base::OnceCallback<void(int, bool)> answered;
  };
  std::vector<AskedBox> message_boxes;
  struct ShownPopup {
    std::string id;
    ElectronDeskPopupMenu menu;
    base::OnceCallback<void(int)> closed;
  };
  std::vector<ShownPopup> popups;
  // What GetCookies finds and why SetCookie fails, when it does.
  std::vector<ElectronCookie> cookies;
  std::optional<std::string> cookie_refusal;
  // Each ExecuteJavaScript's answer, oldest first.
  std::vector<
      base::OnceCallback<void(base::expected<base::Value, std::string>)>>
      ran;
  // Each CallPage's method and answer, oldest first.
  std::vector<ElectronPageMethod> page_methods;
  std::vector<ElectronAnswer> page_answers;
  // A ClearStorage that has not finished.
  base::OnceClosure waiting;
  // The held pages Adopt made windows of. Last, as each writes to `calls` as
  // it goes.
  std::vector<std::unique_ptr<ElectronHeldPage>> adopted;
};

class ElectronAppTest : public testing::Test {
 protected:
  ElectronAppTest()
      : app_(std::in_place,
             desk_,
             base::BindRepeating(
                 [](std::vector<std::string>* sent, std::string line) {
                   sent->push_back(std::move(line));
                 },
                 &sent_),
             ElectronEngineInfo{.user_agent = "Mozilla/5.0 Chrome/160.0.0.0",
                                .chrome_version = "160.0.8155.0"}) {}

  // Says hello and forgets the reply.
  void Hello() {
    app_->Take(kHello);
    sent_.clear();
  }

  FakeDesk desk_;
  std::vector<std::string> sent_;
  std::optional<ElectronApp> app_;
};

using Lines = std::vector<std::string>;

TEST_F(ElectronAppTest, HelloIsAnsweredReady) {
  app_->Take(kHello);

  EXPECT_EQ(sent_, Lines{"{\"chrome_version\":\"160.0.8155.0\","
                         "\"schemes\":[],\"type\":\"ready\",\"user_agent\":"
                         "\"Mozilla/5.0 Chrome/160.0.0.0\"}\n"});
}

TEST_F(ElectronAppTest, ReadySaysWhichSchemesTheEngineRegistered) {
  app_.emplace(desk_,
               base::BindRepeating(
                   [](std::vector<std::string>* sent, std::string line) {
                     sent->push_back(std::move(line));
                   },
                   &sent_),
               ElectronEngineInfo{},
               std::vector<ElectronScheme>{{.scheme = "app", .secure = true}});

  app_->Take(kHello);

  EXPECT_EQ(sent_, Lines{"{\"chrome_version\":\"\",\"schemes\":[{"
                         "\"privileges\":[\"secure\"],\"scheme\":\"app\"}],"
                         "\"type\":\"ready\",\"user_agent\":\"\"}\n"});
}

TEST_F(ElectronAppTest, NothingOpensBeforeHello) {
  app_->Take(R"({"type":"open_window","window":1,"url":"https://a.test/"})");

  EXPECT_EQ(sent_, Lines{"{\"type\":\"refused\","
                         "\"why\":\"an app says hello first\"}\n"});
  EXPECT_TRUE(desk_.calls.empty());
}

TEST_F(ElectronAppTest, AppSaysHelloOnce) {
  Hello();

  app_->Take(kHello);

  EXPECT_EQ(sent_, Lines{"{\"type\":\"refused\","
                         "\"why\":\"this app already said hello\"}\n"});
}

TEST_F(ElectronAppTest, ABadLineIsRefusedAndTheAppKeepsGoing) {
  Hello();

  app_->Take("nonsense");
  app_->Take(R"({"type":"open_window","window":1,"url":"https://a.test/"})");

  EXPECT_EQ(sent_, (Lines{"{\"type\":\"refused\","
                          "\"why\":\"a request must be a JSON object\"}\n",
                          "{\"type\":\"window_opened\",\"window\":1}\n"}));
}

TEST_F(ElectronAppTest, AWindowOpensAsAnAppWindowOfTheApp) {
  Hello();

  app_->Take(R"({"type":"open_window","window":1,"url":"https://a.test/"})");

  EXPECT_EQ(desk_.calls, Lines{"open https://a.test/ as com.anthropic.Claude"});
  EXPECT_EQ(sent_, Lines{"{\"type\":\"window_opened\",\"window\":1}\n"});
}

TEST_F(ElectronAppTest, AnUnsafeUrlIsRefusedAsItsWindows) {
  Hello();

  app_->Take(R"({"type":"open_window","window":2,"url":"chrome://x"})");

  EXPECT_EQ(sent_,
            Lines{"{\"type\":\"window_refused\",\"why\":\"chrome: "
                  "URLs do not open in an app window\",\"window\":2}\n"});
  EXPECT_TRUE(desk_.calls.empty());
}

TEST_F(ElectronAppTest, WithNoShellAWindowIsRefused) {
  Hello();
  desk_.has_shell = false;

  app_->Take(R"({"type":"open_window","window":1,"url":"https://a.test/"})");

  EXPECT_EQ(sent_, Lines{"{\"type\":\"window_refused\",\"why\":\"there is "
                         "no shell to open it in\",\"window\":1}\n"});
}

TEST_F(ElectronAppTest, ANumberInUseIsRefused) {
  Hello();
  app_->Take(R"({"type":"open_window","window":1,"url":"https://a.test/"})");
  sent_.clear();

  app_->Take(R"({"type":"open_window","window":1,"url":"https://b.test/"})");

  EXPECT_EQ(sent_, Lines{"{\"type\":\"window_refused\",\"why\":\"window 1 "
                         "is already open\",\"window\":1}\n"});
}

TEST_F(ElectronAppTest, RequestsReachTheDesksWindow) {
  Hello();
  app_->Take(R"({"type":"open_window","window":1,"url":"https://a.test/"})");
  desk_.calls.clear();

  app_->Take(R"({"type":"load_url","window":1,"url":"https://a.test/x"})");
  app_->Take(R"({"type":"focus_window","window":1})");
  app_->Take(R"({"type":"close_window","window":1})");
  app_->Take(R"({"type":"destroy_window","window":1})");

  EXPECT_EQ(desk_.calls, (Lines{"load 10 https://a.test/x", "focus 10",
                                "ask to close 10", "close 10"}));
}

TEST_F(ElectronAppTest, ARequestForAWindowNotOpenIsRefused) {
  Hello();

  app_->Take(R"({"type":"focus_window","window":4})");

  EXPECT_EQ(sent_, Lines{"{\"type\":\"window_refused\",\"why\":\"window 4 "
                         "is not open\",\"window\":4}\n"});
  EXPECT_TRUE(desk_.calls.empty());
}

TEST_F(ElectronAppTest, TitlesAreReportedWhenTheyChange) {
  Hello();
  app_->Take(R"({"type":"open_window","window":1,"url":"https://a.test/"})");
  sent_.clear();

  app_->Listed({{.id = "10", .title = "Claude"}, {.id = "3", .title = "x"}});
  app_->Listed({{.id = "10", .title = "Claude"}});

  EXPECT_EQ(sent_, Lines{"{\"title\":\"Claude\",\"type\":\"title_changed\","
                         "\"window\":1}\n"});
}

TEST_F(ElectronAppTest, AWindowGoneFromTheListIsClosed) {
  Hello();
  app_->Take(R"({"type":"open_window","window":1,"url":"https://a.test/"})");
  sent_.clear();

  app_->Listed({});
  app_->Take(R"({"type":"focus_window","window":1})");

  EXPECT_EQ(sent_,
            (Lines{"{\"type\":\"window_closed\",\"window\":1}\n",
                   "{\"type\":\"window_refused\",\"why\":\"window 1 is not "
                   "open\",\"window\":1}\n"}));
}

TEST_F(ElectronAppTest, OnlyItsOwnWindowsLoadsAreReported) {
  Hello();
  app_->Take(R"({"type":"open_window","window":2,"url":"https://a.test/"})");
  sent_.clear();

  app_->Loaded("10");
  app_->Loaded("11");

  EXPECT_EQ(sent_, Lines{"{\"type\":\"window_loaded\",\"window\":2}\n"});
}

TEST_F(ElectronAppTest, OnlyItsOwnWindowsDomReadiesAreReported) {
  Hello();
  app_->Take(R"({"type":"open_window","window":2,"url":"https://a.test/"})");
  sent_.clear();

  app_->DomReady("10");
  app_->DomReady("11");

  EXPECT_EQ(sent_,
            Lines{"{\"type\":\"window_dom_ready\",\"window\":2}\n"});
}

TEST_F(ElectronAppTest, AnAppThatGoesClosesItsWindows) {
  Hello();
  app_->Take(R"({"type":"open_window","window":1,"url":"https://a.test/"})");
  app_->Take(R"({"type":"open_window","window":2,"url":"https://b.test/"})");
  desk_.calls.clear();

  app_.reset();

  EXPECT_EQ(desk_.calls, (Lines{"close 10", "close 11"}));
}

TEST_F(ElectronAppTest, AWindowsPreloadReachesTheDesk) {
  Hello();

  app_->Take(R"({"type":"open_window","window":1,"url":"https://a.test/",)"
             R"("preload":"window.x = 1"})");

  EXPECT_EQ(desk_.calls, Lines{"open https://a.test/ as com.anthropic.Claude "
                               "with window.x = 1"});
}

TEST_F(ElectronAppTest, AWindowsArgumentsReachTheDesk) {
  Hello();

  app_->Take(R"({"type":"open_window","window":1,"url":"https://a.test/",)"
             R"("arguments":["--a=1","--b"]})");

  EXPECT_EQ(desk_.calls, Lines{"open https://a.test/ as com.anthropic.Claude "
                               "with arguments --a=1 --b"});
}

TEST_F(ElectronAppTest, AWindowsNodeReachesTheDesk) {
  Hello();

  app_->Take(R"({"type":"open_window","window":1,"url":"https://a.test/",)"
             R"("node":{"preload":"/a/preload.js"}})");

  EXPECT_EQ(desk_.calls,
            Lines{"open https://a.test/ as com.anthropic.Claude with node"});
}

using Answer = std::optional<base::expected<base::Value, std::string>>;

// Writes an invoke's answer to `answer`.
ElectronAnswer Into(Answer& answer) {
  return base::BindOnce(
      [](Answer* answer, base::expected<base::Value, std::string> given) {
        *answer = std::move(given);
      },
      &answer);
}

base::ListValue OneAndA() {
  base::ListValue args;
  args.Append(1);
  args.Append("a");
  return args;
}

TEST_F(ElectronAppTest, AViewOpensAsAViewOfTheApp) {
  Hello();

  app_->Take(R"({"type":"open_window","window":1,"url":"https://a.test/",)"
             R"("view":true})");

  EXPECT_EQ(desk_.calls,
            Lines{"open view https://a.test/ as com.anthropic.Claude"});
  EXPECT_EQ(sent_, Lines{"{\"type\":\"window_opened\",\"window\":1}\n"});
}

TEST_F(ElectronAppTest, AWindowHoldsTheViewsTheAppPlaces) {
  Hello();
  app_->Take(R"({"type":"open_window","window":1,"url":"https://a.test/"})");
  app_->Take(R"({"type":"open_window","window":2,"url":"https://a.test/",)"
             R"("view":true})");
  app_->Take(R"({"type":"open_window","window":3,"url":"https://a.test/",)"
             R"("view":true})");
  sent_.clear();

  app_->Take(
      R"({"type":"set_views","window":1,"views":[)"
      R"({"window":3,"x":0,"y":40,"width":800,"height":560},)"
      R"({"window":2,"x":1,"y":2,"width":3,"height":4,"hidden":true}]})");

  EXPECT_TRUE(sent_.empty());
  EXPECT_EQ(desk_.held.at("10"),
            (std::vector<ElectronDeskView>{
                {.id = "12", .x = 0, .y = 40, .width = 800, .height = 560},
                {.id = "11",
                 .x = 1,
                 .y = 2,
                 .width = 3,
                 .height = 4,
                 .hidden = true}}));
}

TEST_F(ElectronAppTest, AWindowHasTheMenuBarTheAppSets) {
  Hello();
  app_->Take(R"({"type":"open_window","window":1,"url":"https://a.test/"})");
  app_->Take(R"({"type":"open_window","window":2,"url":"https://a.test/",)"
             R"("view":true})");
  sent_.clear();

  app_->Take(R"({"type":"set_menu_bar","window":1,"visible":false,)"
             R"("auto_hide":true,"menu":[{"id":1,"type":"normal",)"
             R"("label":"Quit","enabled":true,"visible":true,)"
             R"("checked":false}]})");
  app_->Take(R"({"type":"set_menu_bar","window":2,"visible":true,)"
             R"("auto_hide":false,"menu":null})");
  app_->Take(R"({"type":"set_menu_bar","window":9,"visible":true,)"
             R"("auto_hide":false,"menu":null})");

  EXPECT_EQ(desk_.menu_bars.at("10"),
            (ElectronDeskMenuBar{
                .menu = R"([{"checked":false,"enabled":true,"id":1,)"
                        R"("label":"Quit","type":"normal","visible":true}])",
                .visible = false,
                .auto_hide = true}));
  EXPECT_FALSE(desk_.menu_bars.contains("11"));
  EXPECT_EQ(sent_,
            (Lines{"{\"type\":\"window_refused\",\"why\":\"window 2 is a "
                   "view, and only a window has a menu bar\",\"window\":2}\n",
                   "{\"type\":\"window_refused\",\"why\":\"window 9 is not "
                   "open\",\"window\":9}\n"}));
}

TEST_F(ElectronAppTest, AClickOnTheMenuBarReachesTheApp) {
  Hello();
  app_->Take(R"({"type":"open_window","window":3,"url":"https://a.test/"})");
  ElectronPageCalls page = desk_.pages.at("10");
  sent_.clear();

  page.menu_clicked.Run(7);
  EXPECT_EQ(sent_, Lines{"{\"command\":7,\"type\":\"menu_clicked\","
                         "\"window\":3}\n"});

  // A click that raced the window closing says nothing.
  app_->Listed({});
  sent_.clear();
  page.menu_clicked.Run(8);
  EXPECT_TRUE(sent_.empty());
}

TEST_F(ElectronAppTest, AWindowStateGoesToTheDeskAndTheShellsBackToTheApp) {
  Hello();
  app_->Take(R"({"type":"open_window","window":3,"url":"https://a.test/"})");
  app_->Take(R"({"type":"open_window","window":4,"url":"https://a.test/",)"
             R"("view":true})");
  ElectronPageCalls page = desk_.pages.at("10");
  sent_.clear();
  desk_.calls.clear();

  app_->Take(R"({"type":"set_window_state","window":3,"maximized":true,)"
             R"("minimized":false,"fullscreen":true})");
  app_->Take(R"({"type":"set_window_state","window":4,"maximized":true,)"
             R"("minimized":false,"fullscreen":false})");
  page.window_state.Run({.fullscreen = true});

  EXPECT_EQ(desk_.calls, Lines{"state of 10 max full"});
  EXPECT_EQ(sent_,
            (Lines{"{\"type\":\"window_refused\",\"why\":\"window 4 is a "
                   "view, and only a window has a window state\","
                   "\"window\":4}\n",
                   "{\"fullscreen\":true,\"maximized\":false,"
                   "\"minimized\":false,\"type\":\"window_state\","
                   "\"window\":3}\n"}));

  // A change that raced the window closing says nothing.
  app_->Listed({});
  sent_.clear();
  page.window_state.Run({});
  EXPECT_TRUE(sent_.empty());
}

TEST_F(ElectronAppTest, TheUserClosingAWindowAsksTheApp) {
  Hello();
  app_->Take(R"({"type":"open_window","window":3,"url":"https://a.test/"})");
  ElectronPageCalls page = desk_.pages.at("10");
  sent_.clear();
  desk_.calls.clear();

  page.close_asked.Run();
  EXPECT_EQ(sent_, Lines{"{\"type\":\"close_asked\",\"window\":3}\n"});
  // Only the app closes it.
  EXPECT_TRUE(desk_.calls.empty());

  // A close that raced the window closing says nothing.
  app_->Listed({});
  sent_.clear();
  page.close_asked.Run();
  EXPECT_TRUE(sent_.empty());
}

TEST_F(ElectronAppTest, APagesStateReachesTheAppAndItsHistoryMoves) {
  Hello();
  app_->Take(R"({"type":"open_window","window":3,"url":"https://a.test/"})");
  ElectronPageCalls page = desk_.pages.at("10");
  sent_.clear();
  desk_.calls.clear();

  page.state.Run(
      ElectronPageState{.entries = {{.url = "https://a.test/", .title = "A"}},
                        .index = 0,
                        .focused = true,
                        .pid = 5});
  EXPECT_EQ(sent_,
            Lines{"{\"crashed\":false,\"entries\":[{\"title\":"
                  "\"A\",\"url\":\"https://a.test/\"}],\"focused\":"
                  "true,\"frame_token\":\"\",\"index\":0,"
                  "\"loading\":false,\"pid\":5,\"process_id\":0,"
                  "\"routing_id\":0,\"type\":\"page_state\","
                  "\"waiting\":false,\"window\":3}\n"});

  app_->Take(R"({"type":"go_to_index","window":3,"index":0})");
  app_->Take(R"({"type":"clear_history","window":3})");
  EXPECT_EQ(desk_.calls, (Lines{"go 10 0", "clear history 10"}));

  // A change that raced the window closing says nothing.
  app_->Listed({});
  sent_.clear();
  page.state.Run(ElectronPageState{});
  EXPECT_TRUE(sent_.empty());
}

TEST_F(ElectronAppTest, AHistoryEntryIsRemovedAndAHistoryRestored) {
  Hello();
  app_->Take(R"({"type":"open_window","window":3,"url":"https://a.test/2",)"
             R"("history":{"entries":[{"url":"https://a.test/1","title":"1"},)"
             R"({"url":"https://a.test/2","title":"2"}],"index":1}})");
  app_->Take(R"({"type":"remove_history_entry","window":3,"index":0})");

  EXPECT_EQ(desk_.calls,
            (Lines{"open https://a.test/2 as com.anthropic.Claude restoring 2 "
                   "entries at 1",
                   "remove entry 10 0"}));
}

TEST_F(ElectronAppTest, ARestoredHistoryOpensOnlyWhatItsSessionOpens) {
  Hello();
  app_->Take(R"({"type":"open_window","window":3,"url":"https://a.test/",)"
             R"("history":{"entries":[{"url":"file:///a","title":""},)"
             R"({"url":"https://a.test/","title":""}],"index":1}})");

  EXPECT_TRUE(desk_.calls.empty());
  ASSERT_EQ(sent_.size(), 1u);
  EXPECT_TRUE(base::StartsWith(sent_[0], R"({"type":"window_refused")"))
      << sent_[0];
}

TEST_F(ElectronAppTest, APagesNavigationsReachTheApp) {
  Hello();
  app_->Take(R"({"type":"open_window","window":3,"url":"https://a.test/"})");
  ElectronPageCalls page = desk_.pages.at("10");
  sent_.clear();
  const ElectronNavigation navigation{
      .url = GURL("https://a.test/b"),
      .main_frame = true,
      .frame = ElectronFrame{.process = 4, .routing = 1}};
  const ElectronNavigationCommit commit{.navigation = navigation,
                                        .http_response_code = 200,
                                        .http_status_text = "OK"};
  const ElectronLoadFailure failure{
      .url = GURL("https://a.test/b"),
      .error_code = -105,
      .error_description = "ERR_NAME_NOT_RESOLVED"};
  const ElectronFrame frame{.process = 4, .routing = 2};

  page.navigation_started.Run(navigation);
  page.navigation_redirected.Run(navigation);
  page.navigation_committed.Run(commit);
  page.load_failed.Run(failure);
  page.frame_loaded.Run(frame);
  page.frame_created.Run(frame, false);
  EXPECT_EQ(sent_, (Lines{ElectronNavigationStarted(3, navigation),
                          ElectronNavigationRedirected(3, navigation),
                          ElectronNavigationCommitted(3, commit),
                          ElectronLoadFailed(3, failure),
                          ElectronFrameLoaded(3, frame),
                          ElectronFrameCreated(3, frame, false)}));

  // What raced the window closing says nothing.
  app_->Listed({});
  sent_.clear();
  page.navigation_started.Run(navigation);
  page.load_failed.Run(failure);
  EXPECT_TRUE(sent_.empty());
}

TEST_F(ElectronAppTest, APagesNavigationWaitsForTheApp) {
  Hello();
  app_->Take(R"({"type":"open_window","window":3,"url":"https://a.test/"})");
  app_->Take(R"({"type":"navigation_listen","window":3,"listening":true})");
  ElectronPageCalls page = desk_.pages.at("10");
  sent_.clear();
  const ElectronNavigation navigation{.url = GURL("https://b.test/"),
                                      .main_frame = true};
  std::vector<bool> answers;
  const auto answer = [&answers](bool proceed) { answers.push_back(proceed); };

  page.will_navigate.Run(navigation, false, base::BindLambdaForTesting(answer));
  page.will_navigate.Run(navigation, true, base::BindLambdaForTesting(answer));
  EXPECT_EQ(sent_, (Lines{ElectronWillNavigate(1, 3, navigation, false),
                          ElectronWillNavigate(2, 3, navigation, true)}));
  EXPECT_TRUE(answers.empty());

  app_->Take(R"({"type":"navigation_answer","ask":2,"proceed":true})");
  app_->Take(R"({"type":"navigation_answer","ask":1,"proceed":false})");
  EXPECT_EQ(answers, (std::vector<bool>{true, false}));
}

TEST_F(ElectronAppTest, APagesNavigationGoesAtOnceWhenTheAppDoesNotListen) {
  Hello();
  app_->Take(R"({"type":"open_window","window":3,"url":"https://a.test/"})");
  app_->Take(R"({"type":"navigation_listen","window":3,"listening":true})");
  app_->Take(R"({"type":"navigation_listen","window":3,"listening":false})");
  ElectronPageCalls page = desk_.pages.at("10");
  sent_.clear();
  std::optional<bool> proceed;

  page.will_navigate.Run(
      ElectronNavigation{.url = GURL("https://b.test/"), .main_frame = true},
      false, base::BindLambdaForTesting([&proceed](bool go) { proceed = go; }));

  EXPECT_EQ(proceed, true);
  EXPECT_TRUE(sent_.empty());
}

TEST_F(ElectronAppTest, APagesBeforeUnloadAsksTheApp) {
  Hello();
  app_->Take(R"({"type":"open_window","window":3,"url":"https://a.test/"})");
  ElectronPageCalls page = desk_.pages.at("10");
  sent_.clear();
  std::optional<bool> unload;

  page.will_prevent_unload.Run(
      base::BindLambdaForTesting([&unload](bool leave) { unload = leave; }));
  EXPECT_EQ(sent_, Lines{ElectronWillPreventUnload(1, 3)});
  app_->Take(R"({"type":"unload_answer","ask":1,"unload":true})");
  EXPECT_EQ(unload, true);
}

TEST_F(ElectronAppTest, ANavigationOrUnloadAnswerNobodyWaitsForIsRefused) {
  Hello();

  app_->Take(R"({"type":"navigation_answer","ask":4,"proceed":true})");
  app_->Take(R"({"type":"unload_answer","ask":5,"unload":true})");

  EXPECT_EQ(sent_, (Lines{R"({"type":"refused","why":"no navigation is )"
                          R"(waiting for answer 4"})"
                          "\n",
                          R"({"type":"refused","why":"no page's )"
                          R"(beforeunload is waiting for answer 5"})"
                          "\n"}));
}

TEST_F(ElectronAppTest, AClosedWindowsPageNeitherNavigatesNorStays) {
  Hello();
  app_->Take(R"({"type":"open_window","window":3,"url":"https://a.test/"})");
  ElectronPageCalls page = desk_.pages.at("10");
  app_->Listed({});
  sent_.clear();
  std::optional<bool> proceed;
  std::optional<bool> unload;

  page.will_navigate.Run(
      ElectronNavigation{.url = GURL("https://b.test/")}, false,
      base::BindLambdaForTesting([&proceed](bool go) { proceed = go; }));
  page.will_prevent_unload.Run(
      base::BindLambdaForTesting([&unload](bool leave) { unload = leave; }));

  EXPECT_TRUE(sent_.empty());
  EXPECT_EQ(proceed, false);
  EXPECT_EQ(unload, true);
}

TEST_F(ElectronAppTest, AnAppThatGoesStopsItsPagesNavigationsAndLetsThemLeave) {
  Hello();
  app_->Take(R"({"type":"open_window","window":3,"url":"https://a.test/"})");
  app_->Take(R"({"type":"navigation_listen","window":3,"listening":true})");
  ElectronPageCalls page = desk_.pages.at("10");
  std::optional<bool> proceed;
  std::optional<bool> unload;
  page.will_navigate.Run(
      ElectronNavigation{.url = GURL("https://b.test/")}, false,
      base::BindLambdaForTesting([&proceed](bool go) { proceed = go; }));
  page.will_prevent_unload.Run(
      base::BindLambdaForTesting([&unload](bool leave) { unload = leave; }));

  app_.reset();

  EXPECT_EQ(proceed, false);
  EXPECT_EQ(unload, true);
}

TEST_F(ElectronAppTest, APageEditsAndFindsAsTheAppAsks) {
  Hello();
  app_->Take(R"({"type":"open_window","window":3,"url":"https://a.test/"})");
  ElectronPageCalls page = desk_.pages.at("10");
  sent_.clear();
  desk_.calls.clear();

  app_->Take(R"({"type":"edit","window":3,"command":"select_all"})");
  app_->Take(R"({"type":"replace","window":3,"text":"cat",)"
             R"("misspelling":true})");
  app_->Take(R"({"type":"find_in_page","window":3,"request":2,"text":"dog",)"
             R"("forward":true,"find_next":false,"match_case":false})");
  app_->Take(
      R"({"type":"stop_find_in_page","window":3,"action":"keep_selection"})");
  EXPECT_EQ(
      desk_.calls,
      (Lines{"edit 10 " + base::NumberToString(static_cast<int>(
                              ElectronEditCommand::kSelectAll)),
             "replace misspelling 10 cat", "find 10 2 dog",
             "stop find 10 " + base::NumberToString(static_cast<int>(
                                   ElectronStopFindAction::kKeepSelection))}));

  page.found.Run(ElectronFindResult{
      .request = 2, .matches = 1, .active_match_ordinal = 1, .width = 4});
  EXPECT_EQ(sent_,
            Lines{"{\"active_match_ordinal\":1,\"matches\":1,\"request\":2,"
                  "\"selection\":{\"height\":0,\"width\":4,\"x\":0,\"y\":0},"
                  "\"type\":\"found_in_page\",\"window\":3}\n"});

  // An answer that raced the window closing says nothing.
  app_->Listed({});
  sent_.clear();
  page.found.Run(ElectronFindResult{.request = 3});
  EXPECT_TRUE(sent_.empty());
}

TEST_F(ElectronAppTest, APagesContextMenuGoesToTheApp) {
  Hello();
  app_->Take(R"({"type":"open_window","window":3,"url":"https://a.test/"})");
  ElectronPageCalls page = desk_.pages.at("10");
  sent_.clear();

  const ElectronContextMenu menu{.x = 4, .y = 5, .selection_text = "cat"};
  page.context_menu.Run(menu);
  EXPECT_EQ(sent_, Lines{ElectronContextMenuAsked(3, menu)});

  // A menu that raced the window closing says nothing.
  app_->Listed({});
  sent_.clear();
  page.context_menu.Run(menu);
  EXPECT_TRUE(sent_.empty());
}

TEST_F(ElectronAppTest, AWindowHasItsOwnTitleAndMayHide) {
  Hello();
  app_->Take(R"({"type":"open_window","window":1,"url":"https://a.test/",)"
             R"("title":"Claude","hidden":true})");
  app_->Take(R"({"type":"open_window","window":2,"url":"https://a.test/",)"
             R"("view":true})");
  sent_.clear();

  app_->Take(R"({"type":"set_title","window":1,"title":"Claude 2"})");
  app_->Take(R"({"type":"set_hidden","window":1,"hidden":false})");
  app_->Take(R"({"type":"set_hidden","window":1,"hidden":true})");
  app_->Take(R"({"type":"set_title","window":2,"title":"no"})");
  app_->Take(R"({"type":"set_hidden","window":2,"hidden":true})");
  app_->Take(R"({"type":"set_hidden","window":9,"hidden":true})");

  EXPECT_EQ(desk_.calls,
            (Lines{"open https://a.test/ as com.anthropic.Claude titled Claude "
                   "hidden",
                   "open view https://a.test/ as com.anthropic.Claude",
                   "title 10 Claude 2", "show 10", "hide 10"}));
  EXPECT_EQ(sent_,
            (Lines{"{\"type\":\"window_refused\",\"why\":\"window 2 is a "
                   "view, and only a window has a title\",\"window\":2}\n",
                   "{\"type\":\"window_refused\",\"why\":\"window 2 is a "
                   "view, and only a window has hiding\",\"window\":2}\n",
                   "{\"type\":\"window_refused\",\"why\":\"window 9 is not "
                   "open\",\"window\":9}\n"}));
}

TEST_F(ElectronAppTest, AMessageBoxGoesOverItsWindowAndItsAnswerBack) {
  Hello();
  app_->Take(R"({"type":"open_window","window":1,"url":"https://a.test/"})");
  app_->Take(R"({"type":"open_window","window":2,"url":"https://a.test/",)"
             R"("view":true})");
  sent_.clear();
  const std::string box =
      R"("box_type":"none","title":"","message":"Quit?","detail":"",)"
      R"("buttons":["Cancel","Quit"],"default_id":1,"cancel_id":0,)"
      R"("checkbox_label":"","checkbox_checked":false)";

  app_->Take(R"({"type":"show_message_box","window":1,"box":5,)" + box + "}");
  app_->Take(R"({"type":"show_message_box","window":2,"box":6,)" + box + "}");

  ASSERT_EQ(desk_.message_boxes.size(), 1u);
  EXPECT_EQ(desk_.message_boxes[0].id, "10");
  EXPECT_EQ(desk_.message_boxes[0].box.buttons, 2);
  EXPECT_EQ(desk_.message_boxes[0].box.cancel_id, 0);
  EXPECT_EQ(sent_, (Lines{"{\"type\":\"window_refused\",\"why\":\"window 2 is "
                          "a view: a message box goes over a window\","
                          "\"window\":2}\n"}));

  // Answered even after the window closed, as the app waits on every box.
  app_->Listed({});
  sent_.clear();
  std::move(desk_.message_boxes[0].answered).Run(1, true);
  EXPECT_EQ(sent_, Lines{"{\"box\":5,\"checkbox_checked\":true,"
                         "\"response\":1,\"type\":\"message_box_answered\","
                         "\"window\":1}\n"});
}

TEST_F(ElectronAppTest, APopupMenuGoesOverItsWindowAndItsChoiceBack) {
  Hello();
  app_->Take(R"({"type":"open_window","window":1,"url":"https://a.test/"})");
  app_->Take(R"({"type":"open_window","window":2,"url":"https://a.test/",)"
             R"("view":true})");
  sent_.clear();
  desk_.calls.clear();
  const std::string menu =
      R"("menu":[{"id":3,"type":"normal","label":"Settings",)"
      R"("enabled":true,"visible":true,"checked":false}])";

  app_->Take(R"({"type":"popup_menu","window":1,"popup":4,)" + menu +
             R"(,"x":5,"y":6})");
  app_->Take(R"({"type":"popup_menu","window":2,"popup":5,)" + menu + "}");
  // An old popup's number closes nothing; the shown one's closes it.
  app_->Take(R"({"type":"close_popup_menu","window":1,"popup":3})");
  app_->Take(R"({"type":"close_popup_menu","window":1,"popup":4})");

  ASSERT_EQ(desk_.popups.size(), 1u);
  EXPECT_EQ(desk_.popups[0].id, "10");
  EXPECT_EQ(desk_.popups[0].menu.menu,
            R"([{"checked":false,"enabled":true,"id":3,"label":"Settings",)"
            R"("type":"normal","visible":true}])");
  EXPECT_EQ(desk_.popups[0].menu.x, 5);
  EXPECT_EQ(desk_.popups[0].menu.y, 6);
  EXPECT_EQ(desk_.calls, (Lines{"popup over 10", "close popup over 10"}));
  EXPECT_EQ(sent_,
            (Lines{"{\"type\":\"window_refused\",\"why\":\"window 2 is a "
                   "view, and only a window has a popup menu\","
                   "\"window\":2}\n",
                   "{\"command\":0,\"popup\":5,\"type\":\"popup_menu_closed\","
                   "\"window\":2}\n"}));

  // Heard even after the window closed, as the app waits on every popup.
  app_->Listed({});
  sent_.clear();
  std::move(desk_.popups[0].closed).Run(3);
  EXPECT_EQ(sent_, Lines{"{\"command\":3,\"popup\":4,"
                         "\"type\":\"popup_menu_closed\",\"window\":1}\n"});
}

TEST_F(ElectronAppTest, OnlyAWindowHoldsViewsAndOnlyViews) {
  Hello();
  app_->Take(R"({"type":"open_window","window":1,"url":"https://a.test/"})");
  app_->Take(R"({"type":"open_window","window":2,"url":"https://a.test/",)"
             R"("view":true})");
  app_->Take(R"({"type":"open_window","window":3,"url":"https://a.test/"})");
  sent_.clear();
  const std::string place = R"("x":0,"y":0,"width":1,"height":1})";

  app_->Take(R"({"type":"set_views","window":2,"views":[]})");
  app_->Take(R"({"type":"set_views","window":1,"views":[{"window":3,)" + place +
             "]}");
  app_->Take(R"({"type":"set_views","window":1,"views":[{"window":9,)" + place +
             "]}");
  app_->Take(R"({"type":"set_views","window":1,"views":[{"window":2,)" + place +
             R"(,{"window":2,)" + place + "]}");

  EXPECT_EQ(sent_,
            (Lines{"{\"type\":\"window_refused\",\"why\":\"window 2 is a "
                   "view, and only a window holds views\",\"window\":2}\n",
                   "{\"type\":\"window_refused\",\"why\":\"window 3 is a "
                   "window, not a view\",\"window\":1}\n",
                   "{\"type\":\"window_refused\",\"why\":\"view 9 is not "
                   "open\",\"window\":1}\n",
                   "{\"type\":\"window_refused\",\"why\":\"view 2 is listed "
                   "twice\",\"window\":1}\n"}));
  EXPECT_TRUE(desk_.held.empty());
}

TEST_F(ElectronAppTest, APagesNewSizeReachesTheApp) {
  Hello();
  app_->Take(R"({"type":"open_window","window":2,"url":"https://a.test/"})");
  sent_.clear();

  desk_.pages.at("10").resized.Run(800, 600);
  app_->Listed({});
  desk_.pages.at("10").resized.Run(1, 1);

  EXPECT_EQ(sent_, (Lines{"{\"height\":600,\"type\":\"resized\","
                          "\"width\":800,\"window\":2}\n",
                          "{\"type\":\"window_closed\",\"window\":2}\n"}));
}

TEST_F(ElectronAppTest, APagesSendReachesTheApp) {
  Hello();
  app_->Take(R"({"type":"open_window","window":2,"url":"https://a.test/"})");
  sent_.clear();

  desk_.pages.at("10").sent.Run("ping", OneAndA());

  EXPECT_EQ(sent_, Lines{R"({"args":[1,"a"],"channel":"ping",)"
                         R"("type":"ipc_message","window":2})"
                         "\n"});
}

TEST_F(ElectronAppTest, APagesInvokeIsAnsweredByTheAppsReply) {
  Hello();
  app_->Take(R"({"type":"open_window","window":2,"url":"https://a.test/"})");
  sent_.clear();
  Answer first;
  Answer second;

  desk_.pages.at("10").invoked.Run("get", OneAndA(), Into(first));
  desk_.pages.at("10").invoked.Run("get", base::ListValue(), Into(second));
  app_->Take(R"({"type":"ipc_reply","invoke":2,"error":"no handler"})");
  app_->Take(R"({"type":"ipc_reply","invoke":1,"result":{"v":7}})");

  EXPECT_EQ(sent_, (Lines{R"({"args":[1,"a"],"channel":"get","invoke":1,)"
                          R"("type":"ipc_invoke","window":2})"
                          "\n",
                          R"({"args":[],"channel":"get","invoke":2,)"
                          R"("type":"ipc_invoke","window":2})"
                          "\n"}));
  ASSERT_TRUE(first.has_value() && first->has_value());
  EXPECT_EQ(base::WriteJson(**first), R"({"v":7})");
  ASSERT_TRUE(second.has_value());
  EXPECT_EQ(*second, base::unexpected("no handler"));
}

TEST_F(ElectronAppTest, AReplyNobodyWaitsOnIsRefused) {
  Hello();

  app_->Take(R"({"type":"ipc_reply","invoke":9,"result":1})");

  EXPECT_EQ(sent_, Lines{"{\"type\":\"refused\","
                         "\"why\":\"no invoke 9 is waiting\"}\n"});
}

TEST_F(ElectronAppTest, AnInvokeFromAClosedWindowFails) {
  Hello();
  app_->Take(R"({"type":"open_window","window":2,"url":"https://a.test/"})");
  ElectronPageCalls page = desk_.pages.at("10");
  app_->Listed({});
  sent_.clear();
  Answer answer;

  page.invoked.Run("get", base::ListValue(), Into(answer));
  page.sent.Run("ping", base::ListValue());

  ASSERT_TRUE(answer.has_value());
  EXPECT_EQ(*answer, base::unexpected("the window is closed"));
  EXPECT_TRUE(sent_.empty());
}

TEST_F(ElectronAppTest, TheAppsSendReachesItsWindowsPage) {
  Hello();
  app_->Take(R"({"type":"open_window","window":2,"url":"https://a.test/"})");
  desk_.calls.clear();

  app_->Take(R"({"type":"ipc_send","window":2,"channel":"ping",)"
             R"("args":[1,"a"]})");

  EXPECT_EQ(desk_.calls, Lines{R"(send 10 ping [1,"a"])"});
}

TEST_F(ElectronAppTest, TheAppsJavaScriptRunsInItsWindowsPageAndAnswers) {
  Hello();
  app_->Take(R"({"type":"open_window","window":2,"url":"https://a.test/"})");
  desk_.calls.clear();
  sent_.clear();

  app_->Take(R"({"type":"execute_javascript","window":2,"call":1,)"
             R"("code":"document.title","user_gesture":true})");
  app_->Take(R"({"type":"execute_javascript","window":2,"call":2,)"
             R"("code":"throw 1"})");
  ASSERT_EQ(desk_.calls,
            (Lines{"run 10 document.title with a gesture", "run 10 throw 1"}));
  std::move(desk_.ran[1]).Run(base::unexpected("Uncaught 1"));
  std::move(desk_.ran[0]).Run(base::Value("A"));

  EXPECT_EQ(sent_, (Lines{R"({"call":2,"error":"Uncaught 1",)"
                          R"("type":"javascript_result","window":2})"
                          "\n",
                          R"({"call":1,"result":"A",)"
                          R"("type":"javascript_result","window":2})"
                          "\n"}));
}

TEST_F(ElectronAppTest, APagesSendSyncIsAnsweredByTheAppsReply) {
  Hello();
  app_->Take(R"({"type":"open_window","window":2,"url":"https://a.test/"})");
  sent_.clear();
  Answer answer;

  desk_.pages.at("10").sent_sync.Run("get", OneAndA(), Into(answer));
  app_->Take(R"({"type":"ipc_reply","invoke":1,"result":"v"})");

  EXPECT_EQ(sent_, Lines{R"({"args":[1,"a"],"channel":"get","invoke":1,)"
                         R"("type":"ipc_send_sync","window":2})"
                         "\n"});
  ASSERT_TRUE(answer.has_value() && answer->has_value());
  EXPECT_EQ(base::WriteJson(**answer), R"("v")");
}

TEST_F(ElectronAppTest, APagesPortsReachTheApp) {
  Hello();
  app_->Take(R"({"type":"open_window","window":2,"url":"https://a.test/"})");
  sent_.clear();
  const ElectronPageCalls& page = desk_.pages.at("10");

  page.posted.Run("port", base::Value("hi"), {"r1"});
  page.port_posted.Run("r1", base::Value(3));
  page.port_closed.Run("r1");
  page.gone.Run();

  EXPECT_EQ(sent_,
            (Lines{R"({"channel":"port","message":"hi","ports":["r1"],)"
                   R"("type":"ipc_post","window":2})"
                   "\n",
                   R"({"data":3,"port":"r1","type":"port_message","window":2})"
                   "\n",
                   R"({"port":"r1","type":"port_closed","window":2})"
                   "\n",
                   R"({"type":"page_gone","window":2})"
                   "\n"}));
}

TEST_F(ElectronAppTest, AClosedWindowsPortsSayNothing) {
  Hello();
  app_->Take(R"({"type":"open_window","window":2,"url":"https://a.test/"})");
  ElectronPageCalls page = desk_.pages.at("10");
  app_->Listed({});
  sent_.clear();
  Answer answer;

  page.sent_sync.Run("get", base::ListValue(), Into(answer));
  page.posted.Run("port", base::Value(), {});
  page.port_posted.Run("r1", base::Value());
  page.port_closed.Run("r1");
  page.gone.Run();

  ASSERT_TRUE(answer.has_value());
  EXPECT_EQ(*answer, base::unexpected("the window is closed"));
  EXPECT_TRUE(sent_.empty());
}

TEST_F(ElectronAppTest, TheAppsPortsReachItsWindowsPage) {
  Hello();
  app_->Take(R"({"type":"open_window","window":2,"url":"https://a.test/"})");
  desk_.calls.clear();
  sent_.clear();

  app_->Take(R"({"type":"ipc_post","window":2,"channel":"port",)"
             R"("message":{"a":1},"ports":["m1","m2"]})");
  app_->Take(R"({"type":"port_post","window":2,"port":"r1","data":[2]})");
  app_->Take(R"({"type":"port_close","window":2,"port":"m1"})");
  app_->Take(R"({"type":"port_close","window":3,"port":"m1"})");

  EXPECT_EQ(desk_.calls, (Lines{R"(post 10 port {"a":1} m1 m2)",
                                "port 10 r1 [2]", "close port 10 m1"}));
  EXPECT_EQ(sent_, Lines{R"({"type":"window_refused","why":"window 3 is not )"
                         R"(open","window":3})"
                         "\n"});
}

// A page's loader that writes down what the app answers.
class FakeResponder final : public ElectronResponder {
 public:
  explicit FakeResponder(std::vector<std::string>& log) : log_(log) {}
  ~FakeResponder() override { log_->push_back("gone"); }

  void Respond(ElectronResponse response) override {
    std::string line = "respond " + base::NumberToString(response.status);
    for (const auto& [name, value] : response.headers) {
      line += " " + name + "=" + value;
    }
    if (const auto* body = std::get_if<std::string>(&response.body)) {
      line += " body " + *body;
    } else if (const auto* file = std::get_if<base::FilePath>(&response.body)) {
      line += " file " + file->value();
    } else {
      line += " streamed";
    }
    log_->push_back(line);
  }
  void Fail(const std::string& why) override { log_->push_back("fail " + why); }
  void Data(std::string bytes) override { log_->push_back("data " + bytes); }
  void End(const std::optional<std::string>& error) override {
    log_->push_back(error.has_value() ? "end " + *error : "end");
  }

 private:
  const raw_ref<std::vector<std::string>> log_;
};

ElectronFetch Get(std::string_view url) {
  return ElectronFetch{.url = GURL(url),
                       .method = "GET",
                       .headers = {{"accept", "*/*"}},
                       .body = std::nullopt};
}

constexpr char kOpenOwn[] =
    R"({"type":"open_window","window":1,"url":"https://a.test/"})";

TEST_F(ElectronAppTest, AWindowOpensInItsSessionsPartition) {
  Hello();

  app_->Take(kOpenOwn);
  app_->Take(R"({"type":"open_window","window":2,"url":"https://a.test/",)"
             R"("session":"persist:cowork"})");

  EXPECT_EQ(desk_.partitions.at("10"),
            (WebViewPartition{.name = "electron-claude", .persist = true}));
  EXPECT_EQ(
      desk_.partitions.at("11"),
      (WebViewPartition{.name = "electron-claude:cowork", .persist = true}));
  ASSERT_TRUE(desk_.sessions.at("10") && desk_.sessions.at("11"));
  EXPECT_EQ(desk_.sessions.at("10")->name(), "");
  EXPECT_EQ(desk_.sessions.at("11")->name(), "persist:cowork");
}

TEST_F(ElectronAppTest, APagesPreconnectIsItsSessions) {
  Hello();
  app_->Take(R"({"type":"open_window","window":2,"url":"https://a.test/",)"
             R"("session":"persist:cowork"})");
  sent_.clear();

  desk_.sessions.at("10")->TellPreconnect(GURL("https://b.test/"), true);

  EXPECT_EQ(sent_, Lines{"{\"allow_credentials\":true,"
                         "\"session\":\"persist:cowork\","
                         "\"type\":\"preconnect\","
                         "\"url\":\"https://b.test/\"}\n"});
}

TEST_F(ElectronAppTest, DictionariesAndTheGpuAreToldOnlyAfterHello) {
  app_->SpellcheckDictionaryInitialized("en-US");
  app_->GpuInfoUpdated();
  EXPECT_TRUE(sent_.empty());

  app_->Take(kHello);
  app_->SpellcheckDictionaryInitialized("en-US");
  app_->SpellcheckDictionaryInitialized("de-DE");
  app_->GpuInfoUpdated();

  ASSERT_EQ(sent_.size(), 4u);
  EXPECT_EQ(sent_[1],
            "{\"language\":\"en-US\","
            "\"type\":\"spellcheck_dictionary_initialized\"}\n");
  EXPECT_EQ(sent_[2],
            "{\"language\":\"de-DE\","
            "\"type\":\"spellcheck_dictionary_initialized\"}\n");
  EXPECT_EQ(sent_[3], "{\"type\":\"gpu_info_update\"}\n");
}

TEST_F(ElectronAppTest, ASessionThatNamesNoPartitionRefusesItsWindow) {
  Hello();

  app_->Take(R"({"type":"open_window","window":2,"url":"https://a.test/",)"
             R"("session":"persist:"})");

  EXPECT_EQ(sent_, Lines{R"({"type":"window_refused","why":"a partition of )"
                         R"(\"persist:\" names no partition to keep",)"
                         R"("window":2})"
                         "\n"});
  EXPECT_TRUE(desk_.calls.empty());
}

TEST_F(ElectronAppTest, AFileOpensOnceItsSessionHandlesFile) {
  Hello();

  app_->Take(R"({"type":"open_window","window":1,"url":"file:///opt/a.html"})");
  app_->Take(R"({"type":"handle_protocol","session":"","scheme":"file"})");
  app_->Take(R"({"type":"open_window","window":2,"url":"file:///opt/a.html"})");
  app_->Take(R"({"type":"open_window","window":3,"url":"file:///opt/a.html",)"
             R"("session":"other"})");

  EXPECT_EQ(sent_,
            (Lines{R"({"type":"window_refused","why":"file: URLs open once )"
                   R"(the app handles file:","window":1})"
                   "\n",
                   "{\"type\":\"window_opened\",\"window\":2}\n",
                   R"({"type":"window_refused","why":"file: URLs open once )"
                   R"(the app handles file:","window":3})"
                   "\n"}));
  EXPECT_EQ(desk_.calls,
            Lines{"open file:///opt/a.html as com.anthropic.Claude"});
}

TEST_F(ElectronAppTest, ALoadIsCheckedAgainstItsWindowsSession) {
  Hello();
  app_->Take(kOpenOwn);
  sent_.clear();
  desk_.calls.clear();

  app_->Take(R"({"type":"load_url","window":1,"url":"app://localhost/"})");
  app_->Take(R"({"type":"handle_protocol","session":"","scheme":"app"})");
  app_->Take(R"({"type":"load_url","window":1,"url":"app://localhost/"})");

  EXPECT_EQ(sent_, Lines{R"({"type":"window_refused","why":"app: URLs open )"
                         R"(once the app handles app:","window":1})"
                         "\n"});
  EXPECT_EQ(desk_.calls, Lines{"load 10 app://localhost/"});
}

TEST_F(ElectronAppTest, ASessionHandlesWhatTheAppHandlesThere) {
  Hello();
  app_->Take(kOpenOwn);
  app_->Take(R"({"type":"open_window","window":2,"url":"https://a.test/",)"
             R"("session":"other"})");

  app_->Take(R"({"type":"handle_protocol","session":"","scheme":"https"})");
  app_->Take(R"({"type":"handle_protocol","session":"","scheme":"file"})");
  app_->Take(R"({"type":"handle_protocol","session":"","scheme":"app"})");
  app_->Take(R"({"type":"unhandle_protocol","session":"","scheme":"app"})");

  const ElectronSession& own = *desk_.sessions.at("10");
  const ElectronSession& other = *desk_.sessions.at("11");
  EXPECT_TRUE(own.Handles("https"));
  EXPECT_TRUE(own.Handles("file"));
  EXPECT_FALSE(own.Handles("app"));
  EXPECT_FALSE(own.Handles("http"));
  EXPECT_EQ(own.LocalSchemes(), std::vector<std::string>{"file"});
  EXPECT_FALSE(other.Handles("https"));
  EXPECT_TRUE(other.LocalSchemes().empty());
}

TEST_F(ElectronAppTest, AFetchIsAnsweredByTheAppsResponse) {
  Hello();
  app_->Take(kOpenOwn);
  app_->Take(R"({"type":"handle_protocol","session":"","scheme":"file"})");
  sent_.clear();
  std::vector<std::string> log;

  desk_.sessions.at("10")->Fetch(Get("file:///opt/a.html"),
                                 std::make_unique<FakeResponder>(log));
  app_->Take(R"({"type":"protocol_response","request":1,"status":200,)"
             R"("headers":[["content-type","text/html"]],"body":"aGk="})");

  EXPECT_EQ(sent_, Lines{R"({"headers":[["accept","*/*"]],"method":"GET",)"
                         R"("request":1,"session":"",)"
                         R"("type":"protocol_request",)"
                         R"("url":"file:///opt/a.html"})"
                         "\n"});
  EXPECT_EQ(log, (Lines{"respond 200 content-type=text/html body hi", "gone"}));
}

TEST_F(ElectronAppTest, AStreamedBodyComesInPiecesUntilItEnds) {
  Hello();
  app_->Take(kOpenOwn);
  std::vector<std::string> log;
  desk_.sessions.at("10")->Fetch(Get("file:///a"),
                                 std::make_unique<FakeResponder>(log));
  sent_.clear();

  app_->Take(R"({"type":"protocol_response","request":1,"status":206,)"
             R"("headers":[],"stream":true})");
  app_->Take(R"({"type":"protocol_data","request":1,"data":"aGk="})");
  app_->Take(R"({"type":"protocol_data","request":1,"data":"IQ=="})");
  app_->Take(R"({"type":"protocol_end","request":1})");
  app_->Take(R"({"type":"protocol_data","request":1,"data":"IQ=="})");

  EXPECT_EQ(
      log, (Lines{"respond 206 streamed", "data hi", "data !", "end", "gone"}));
  EXPECT_EQ(sent_, Lines{R"({"type":"refused","why":"no protocol request 1 )"
                         R"(is waiting"})"
                         "\n"});
}

TEST_F(ElectronAppTest, AFailedHandlerFailsTheRequest) {
  Hello();
  std::vector<std::string> log;
  app_->Take(kOpenOwn);
  desk_.sessions.at("10")->Fetch(Get("app://localhost/"),
                                 std::make_unique<FakeResponder>(log));

  app_->Take(
      R"({"type":"protocol_response","request":1,"error":"no such page"})");

  EXPECT_EQ(log, (Lines{"fail no such page", "gone"}));
}

TEST_F(ElectronAppTest, ABadResponseFailsItsRequestAndIsRefused) {
  Hello();
  std::vector<std::string> log;
  app_->Take(kOpenOwn);
  desk_.sessions.at("10")->Fetch(Get("app://localhost/"),
                                 std::make_unique<FakeResponder>(log));
  sent_.clear();

  app_->Take(R"({"type":"protocol_response","request":1,"status":99,)"
             R"("headers":[],"body":""})");

  EXPECT_EQ(log, (Lines{R"(fail "status" must be from 100 to 599)", "gone"}));
  EXPECT_EQ(sent_, Lines{R"({"type":"refused","why":"\"status\" must be )"
                         R"(from 100 to 599"})"
                         "\n"});
}

TEST_F(ElectronAppTest, PiecesOfABodyNotStreamedAreRefused) {
  Hello();
  std::vector<std::string> log;
  app_->Take(kOpenOwn);
  desk_.sessions.at("10")->Fetch(Get("app://localhost/"),
                                 std::make_unique<FakeResponder>(log));
  sent_.clear();

  app_->Take(R"({"type":"protocol_data","request":1,"data":"aGk="})");

  EXPECT_EQ(log, (Lines{"fail the app sent a body's piece before a streamed "
                        "response",
                        "gone"}));
  EXPECT_EQ(sent_, Lines{R"({"type":"refused","why":"the app sent a body's )"
                         R"(piece before a streamed response"})"
                         "\n"});
}

TEST_F(ElectronAppTest, AnAppThatGoesDropsItsPagesRequests) {
  Hello();
  std::vector<std::string> log;
  app_->Take(kOpenOwn);
  base::WeakPtr<ElectronSession> session = desk_.sessions.at("10");
  session->Fetch(Get("app://localhost/"), std::make_unique<FakeResponder>(log));

  app_.reset();

  EXPECT_EQ(log, Lines{"gone"});
  EXPECT_FALSE(session);
}

ElectronWebRequestDetails Details(std::string_view url) {
  return ElectronWebRequestDetails{.id = 4,
                                   .url = GURL(url),
                                   .method = "GET",
                                   .resource_type = "mainFrame",
                                   .referrer = ""};
}

// Writes down the answer a waiting request got.
ElectronWebRequestAnswered Into(std::optional<ElectronWebRequestAnswer>& got) {
  return base::BindOnce(
      [](std::optional<ElectronWebRequestAnswer>* got,
         ElectronWebRequestAnswer answer) { *got = std::move(answer); },
      &got);
}

TEST_F(ElectronAppTest, ASessionListensForTheEventsTheAppNames) {
  Hello();
  app_->Take(kOpenOwn);
  const ElectronSession& own = *desk_.sessions.at("10");

  EXPECT_FALSE(own.ListensForWebRequests());
  app_->Take(R"({"type":"web_request_listen","session":"",)"
             R"("events":["before_request","completed"]})");
  EXPECT_TRUE(own.ListensForWebRequests());
  EXPECT_TRUE(own.ListensFor(ElectronWebRequestEvent::kBeforeRequest));
  EXPECT_TRUE(own.ListensFor(ElectronWebRequestEvent::kCompleted));
  EXPECT_FALSE(own.ListensFor(ElectronWebRequestEvent::kHeadersReceived));

  // Each line names them all.
  app_->Take(R"({"type":"web_request_listen","session":"",)"
             R"("events":["headers_received"]})");
  EXPECT_FALSE(own.ListensFor(ElectronWebRequestEvent::kBeforeRequest));
  EXPECT_TRUE(own.ListensFor(ElectronWebRequestEvent::kHeadersReceived));
}

TEST_F(ElectronAppTest, AWaitingRequestIsAnsweredByTheApp) {
  Hello();
  app_->Take(kOpenOwn);
  sent_.clear();
  std::optional<ElectronWebRequestAnswer> got;

  desk_.sessions.at("10")->AskWebRequest(
      ElectronWebRequestEvent::kBeforeRequest, "10", Details("https://a.test/"),
      Into(got));
  EXPECT_EQ(got, std::nullopt);
  app_->Take(R"({"type":"web_request_answer","ask":1,)"
             R"("redirect_url":"https://b.test/"})");

  EXPECT_EQ(sent_, Lines{R"({"ask":1,"event":"before_request","id":4,)"
                         R"("method":"GET","referrer":"",)"
                         R"("resource_type":"mainFrame","session":"",)"
                         R"("type":"web_request","url":"https://a.test/",)"
                         R"("window":1})"
                         "\n"});
  EXPECT_EQ(got, (ElectronWebRequestAnswer{
                     .ask = 1, .redirect_url = GURL("https://b.test/")}));
}

TEST_F(ElectronAppTest, ARequestNoWindowMadeNamesNone) {
  Hello();
  app_->Take(kOpenOwn);
  sent_.clear();

  desk_.sessions.at("10")->TellWebRequest(ElectronWebRequestEvent::kCompleted,
                                          std::nullopt,
                                          Details("https://a.test/"));

  EXPECT_EQ(sent_, Lines{R"({"event":"completed","id":4,"method":"GET",)"
                         R"("referrer":"","resource_type":"mainFrame",)"
                         R"("session":"","type":"web_request",)"
                         R"("url":"https://a.test/"})"
                         "\n"});
}

TEST_F(ElectronAppTest, AnAnswerChangesOnlyWhatItsEventCan) {
  Hello();
  app_->Take(kOpenOwn);
  std::optional<ElectronWebRequestAnswer> got;
  desk_.sessions.at("10")->AskWebRequest(
      ElectronWebRequestEvent::kBeforeRequest, "10", Details("https://a.test/"),
      Into(got));
  sent_.clear();

  app_->Take(R"({"type":"web_request_answer","ask":1,)"
             R"("request_headers":[["a","1"]]})");

  // The app's bug fails the request rather than letting it through as if
  // the app had not asked for a change.
  EXPECT_EQ(got, (ElectronWebRequestAnswer{.ask = 1, .cancel = true}));
  EXPECT_EQ(sent_, Lines{R"({"type":"refused","why":"an answer to )"
                         R"(before_request cannot set request_headers"})"
                         "\n"});
}

TEST_F(ElectronAppTest, AnAnswerNobodyWaitsForIsRefused) {
  Hello();
  sent_.clear();

  app_->Take(R"({"type":"web_request_answer","ask":7})");

  EXPECT_EQ(sent_, Lines{R"({"type":"refused","why":"no web request is )"
                         R"(waiting for answer 7"})"
                         "\n"});
}

TEST_F(ElectronAppTest, AnAppThatGoesCancelsItsWaitingRequests) {
  Hello();
  app_->Take(kOpenOwn);
  std::optional<ElectronWebRequestAnswer> got;
  desk_.sessions.at("10")->AskWebRequest(
      ElectronWebRequestEvent::kHeadersReceived, "10",
      Details("https://a.test/"), Into(got));

  app_.reset();

  EXPECT_EQ(got, (ElectronWebRequestAnswer{.ask = 1, .cancel = true}));
}

// Writes down whether a permission request was granted.
base::OnceCallback<void(bool)> Into(std::optional<bool>& got) {
  return base::BindOnce(
      [](std::optional<bool>* got, bool granted) { *got = granted; }, &got);
}

TEST(ElectronPermissionForTest, NamesEachKindAsElectronDoes) {
  const GURL origin("https://a.test/");
  const auto name = [&](mojom::WebViewPermission permission) {
    const std::optional<ElectronPermissionDetails> details =
        ElectronPermissionFor({permission}, origin);
    return details.has_value() ? details->permission : "(shell)";
  };

  EXPECT_EQ(name(mojom::WebViewPermission::kLocation), "geolocation");
  EXPECT_EQ(name(mojom::WebViewPermission::kNotifications), "notifications");
  EXPECT_EQ(name(mojom::WebViewPermission::kClipboard), "clipboard-read");
  EXPECT_EQ(name(mojom::WebViewPermission::kMidi), "midiSysex");
  EXPECT_EQ(name(mojom::WebViewPermission::kWindowManagement),
            "window-management");
  EXPECT_EQ(name(mojom::WebViewPermission::kIdleDetection), "idle-detection");
  EXPECT_EQ(name(mojom::WebViewPermission::kLocalFonts), "unknown");
  // Electron never asks about downloads.
  EXPECT_EQ(name(mojom::WebViewPermission::kAutomaticDownloads), "(shell)");
}

TEST(ElectronPermissionForTest, CameraAndMicrophoneAreOneMediaRequest) {
  EXPECT_EQ(
      ElectronPermissionFor({mojom::WebViewPermission::kCamera,
                             mojom::WebViewPermission::kMicrophone},
                            GURL("https://a.test/")),
      (ElectronPermissionDetails{.permission = "media",
                                 .requesting_url = GURL("https://a.test/"),
                                 .media_types = {"video", "audio"}}));
  // Electron asks about each other kind on its own.
  EXPECT_EQ(ElectronPermissionFor({mojom::WebViewPermission::kCamera,
                                   mojom::WebViewPermission::kLocation},
                                  GURL("https://a.test/")),
            std::nullopt);
  EXPECT_EQ(ElectronPermissionFor({}, GURL("https://a.test/")), std::nullopt);
}

TEST_F(ElectronAppTest, ASessionHandlesPermissionsWhileTheAppSaysSo) {
  Hello();
  app_->Take(kOpenOwn);
  const ElectronSession& own = *desk_.sessions.at("10");

  EXPECT_FALSE(own.HandlesPermissions());
  app_->Take(R"({"type":"permission_handler","session":"","handle":true})");
  EXPECT_TRUE(own.HandlesPermissions());
  app_->Take(R"({"type":"permission_handler","session":"","handle":false})");
  EXPECT_FALSE(own.HandlesPermissions());
}

TEST_F(ElectronAppTest, APermissionRequestIsAnsweredByTheAppsHandler) {
  Hello();
  app_->Take(kOpenOwn);
  app_->Take(R"({"type":"permission_handler","session":"","handle":true})");
  sent_.clear();
  std::optional<bool> granted;
  std::optional<bool> denied;

  desk_.sessions.at("10")->AskPermission(
      "10",
      {.permission = "notifications",
       .requesting_url = GURL("https://a.test/")},
      Into(granted));
  desk_.sessions.at("10")->AskPermission(
      "10",
      {.permission = "geolocation", .requesting_url = GURL("https://a.test/")},
      Into(denied));
  EXPECT_EQ(granted, std::nullopt);
  app_->Take(R"({"type":"permission_answer","ask":2,"granted":false})");
  app_->Take(R"({"type":"permission_answer","ask":1,"granted":true})");

  EXPECT_EQ(sent_, (Lines{R"({"ask":1,"permission":"notifications",)"
                          R"("requesting_url":"https://a.test/","session":"",)"
                          R"("type":"permission_request","window":1})"
                          "\n",
                          R"({"ask":2,"permission":"geolocation",)"
                          R"("requesting_url":"https://a.test/","session":"",)"
                          R"("type":"permission_request","window":1})"
                          "\n"}));
  EXPECT_EQ(granted, true);
  EXPECT_EQ(denied, false);
}

TEST_F(ElectronAppTest, APermissionAnswerNobodyWaitsForIsRefused) {
  Hello();
  sent_.clear();

  app_->Take(R"({"type":"permission_answer","ask":5,"granted":true})");

  EXPECT_EQ(sent_, Lines{R"({"type":"refused","why":"no permission request )"
                         R"(is waiting for answer 5"})"
                         "\n"});
}

TEST_F(ElectronAppTest, AnAppThatGoesDeniesItsWaitingPermissions) {
  Hello();
  app_->Take(kOpenOwn);
  app_->Take(R"({"type":"permission_handler","session":"","handle":true})");
  std::optional<bool> got;
  desk_.sessions.at("10")->AskPermission(
      "10", {.permission = "media", .requesting_url = GURL("https://a.test/")},
      Into(got));

  app_.reset();

  EXPECT_EQ(got, false);
}

// A download's control that records what the app did to it.
class FakeDownloadControl final : public ElectronDownloadControl {
 public:
  void Pause() override { done.push_back("pause"); }
  void Resume() override { done.push_back("resume"); }
  void Cancel() override { done.push_back("cancel"); }

  base::WeakPtr<ElectronDownloadControl> GetWeakPtr() {
    return weak_factory_.GetWeakPtr();
  }

  std::vector<std::string> done;

 private:
  base::WeakPtrFactory<FakeDownloadControl> weak_factory_{this};
};

base::OnceCallback<void(ElectronDownloadAnswer)> Into(
    std::optional<ElectronDownloadAnswer>& got) {
  return base::BindOnce(
      [](std::optional<ElectronDownloadAnswer>* got,
         ElectronDownloadAnswer answer) { *got = std::move(answer); },
      &got);
}

ElectronDownloadDetails Csv() {
  return {.url = GURL("https://files.test/a.csv"),
          .url_chain = {GURL("https://files.test/a.csv")},
          .filename = "a.csv",
          .mime_type = "text/csv"};
}

TEST_F(ElectronAppTest, AnAppsWillDownloadSaysWhereADownloadGoes) {
  Hello();
  app_->Take(kOpenOwn);
  sent_.clear();
  FakeDownloadControl control;
  std::optional<ElectronDownloadAnswer> answer;

  const int number = desk_.sessions.at("10")->AskDownload(
      "10", Csv(), control.GetWeakPtr(), Into(answer));
  // Before the answer the download has no item in the app to hear of it.
  desk_.sessions.at("10")->DownloadUpdated(number, {});
  EXPECT_EQ(answer, std::nullopt);
  app_->Take(R"({"type":"download_answer","download":1,"path":"/a.csv"})");

  EXPECT_EQ(number, 1);
  EXPECT_EQ(answer, (ElectronDownloadAnswer{.download = 1,
                                            .path = base::FilePath("/a.csv")}));
  EXPECT_EQ(sent_, Lines{R"({"content_disposition":"","download":1,)"
                         R"("etag":"","filename":"a.csv",)"
                         R"("has_user_gesture":false,"initiator_origin":"",)"
                         R"("last_modified":"",)"
                         R"("mime_type":"text/csv","session":"",)"
                         R"("start_time":0.0,"total_bytes":0.0,)"
                         R"("type":"will_download",)"
                         R"("url":"https://files.test/a.csv",)"
                         R"("url_chain":["https://files.test/a.csv"],)"
                         R"("window":1})"
                         "\n"});
}

TEST_F(ElectronAppTest, AnAppHearsHowItsDownloadGoesUntilItIsDone) {
  Hello();
  app_->Take(kOpenOwn);
  FakeDownloadControl control;
  std::optional<ElectronDownloadAnswer> answer;
  ElectronSession& session = *desk_.sessions.at("10");
  const int number =
      session.AskDownload("10", Csv(), control.GetWeakPtr(), Into(answer));
  app_->Take(R"({"type":"download_answer","download":1,"path":"/a.csv"})");
  sent_.clear();

  session.DownloadUpdated(number, {.received_bytes = 5});
  session.DownloadUpdated(
      number, {.state = ElectronDownloadState::kCompleted, .done = true});
  // Chromium may update a finished item; Electron's has said `done`.
  session.DownloadUpdated(
      number, {.state = ElectronDownloadState::kCompleted, .done = true});

  EXPECT_EQ(sent_, (Lines{ElectronDownloadUpdated(1, {.received_bytes = 5}),
                          ElectronDownloadUpdated(
                              1, {.state = ElectronDownloadState::kCompleted,
                                  .done = true})}));
}

TEST_F(ElectronAppTest, AnAppPausesResumesAndCancelsItsDownload) {
  Hello();
  app_->Take(kOpenOwn);
  FakeDownloadControl control;
  std::optional<ElectronDownloadAnswer> answer;
  ElectronSession& session = *desk_.sessions.at("10");
  const int number =
      session.AskDownload("10", Csv(), control.GetWeakPtr(), Into(answer));
  app_->Take(R"({"type":"download_answer","download":1})");
  sent_.clear();

  app_->Take(R"({"type":"download_control","download":1,"action":"pause"})");
  app_->Take(R"({"type":"download_control","download":1,"action":"resume"})");
  app_->Take(R"({"type":"download_control","download":1,"action":"cancel"})");
  session.DownloadUpdated(
      number, {.state = ElectronDownloadState::kCanceled, .done = true});
  // A download that is done ignores the app, as Electron's does.
  app_->Take(R"({"type":"download_control","download":1,"action":"resume"})");

  EXPECT_EQ(control.done,
            (std::vector<std::string>{"pause", "resume", "cancel"}));
  EXPECT_EQ(sent_.size(), 1u);
}

TEST_F(ElectronAppTest, ADownloadThatIsGoneIgnoresTheApp) {
  Hello();
  app_->Take(kOpenOwn);
  std::optional<ElectronDownloadAnswer> answer;
  {
    FakeDownloadControl control;
    desk_.sessions.at("10")->AskDownload("10", Csv(), control.GetWeakPtr(),
                                         Into(answer));
  }
  sent_.clear();

  app_->Take(R"({"type":"download_control","download":1,"action":"cancel"})");

  EXPECT_EQ(sent_, Lines{});
}

TEST_F(ElectronAppTest, ADownloadAnswerOrControlForNoDownloadIsRefused) {
  Hello();
  app_->Take(kOpenOwn);
  FakeDownloadControl control;
  std::optional<ElectronDownloadAnswer> answer;
  desk_.sessions.at("10")->AskDownload("10", Csv(), control.GetWeakPtr(),
                                       Into(answer));
  app_->Take(R"({"type":"download_answer","download":1})");
  sent_.clear();

  // Answered once already.
  app_->Take(R"({"type":"download_answer","download":1,"cancel":true})");
  app_->Take(R"({"type":"download_control","download":4,"action":"pause"})");

  EXPECT_EQ(sent_, (Lines{R"({"type":"refused","why":"no download is )"
                          R"(waiting for answer 1"})"
                          "\n",
                          R"({"type":"refused","why":"no download is )"
                          R"(numbered 4"})"
                          "\n"}));
}

TEST_F(ElectronAppTest, AnAppThatGoesCancelsTheDownloadsItNeverPlaced) {
  Hello();
  app_->Take(kOpenOwn);
  FakeDownloadControl control;
  std::optional<ElectronDownloadAnswer> answer;
  desk_.sessions.at("10")->AskDownload("10", Csv(), control.GetWeakPtr(),
                                       Into(answer));

  app_.reset();

  EXPECT_EQ(answer, (ElectronDownloadAnswer{.download = 1, .cancel = true}));
}

TEST_F(ElectronAppTest, ASessionCallGetsTheCookiesItsFilterMatches) {
  Hello();
  desk_.cookies = {{.name = "a", .value = "1", .domain = "a.test"},
                   {.name = "b", .value = "2", .domain = "b.test"}};

  app_->Take(R"({"type":"session_call","call":1,"session":"persist:work",)"
             R"("method":"cookies_get","filter":{"url":"https://a.test/",)"
             R"("domain":"a.test"}})");

  EXPECT_EQ(desk_.calls,
            Lines{"get cookies in electron-claude:work for https://a.test/"});
  EXPECT_EQ(sent_, Lines{"{\"call\":1,\"result\":[{\"domain\":\"a.test\","
                         "\"hostOnly\":false,\"httpOnly\":false,\"name\":\"a\","
                         "\"path\":\"\",\"sameSite\":\"unspecified\","
                         "\"secure\":false,\"session\":true,\"value\":\"1\"}],"
                         "\"type\":\"session_result\"}\n"});
}

TEST_F(ElectronAppTest, AWatchedSessionsCookieChangesReachTheApp) {
  Hello();

  app_->Take(R"({"type":"session_call","call":1,"session":"persist:work",)"
             R"("method":"cookies_watch"})");
  app_->Take(R"({"type":"session_call","call":2,"session":"persist:work",)"
             R"("method":"cookies_watch"})");
  desk_.cookie_changed.Run(
      {.cookie = {.name = "lc", .value = "1", .domain = ".a.test"},
       .cause = "inserted"});

  // Watching twice is watching once.
  EXPECT_EQ(desk_.calls, Lines{"watch cookies in electron-claude:work"});
  EXPECT_EQ(sent_,
            (Lines{"{\"call\":1,\"result\":null,\"type\":\"session_result\"}\n",
                   "{\"call\":2,\"result\":null,\"type\":\"session_result\"}\n",
                   "{\"cause\":\"inserted\",\"cookie\":{\"domain\":\".a.test\","
                   "\"hostOnly\":false,\"httpOnly\":false,\"name\":\"lc\","
                   "\"path\":\"\",\"sameSite\":\"unspecified\","
                   "\"secure\":false,\"session\":true,\"value\":\"1\"},"
                   "\"removed\":false,\"session\":\"persist:work\","
                   "\"type\":\"cookie_changed\"}\n"}));
}

TEST_F(ElectronAppTest, ASessionCallSaysWhyACookieWasNotSet) {
  Hello();
  desk_.cookie_refusal = "the cookie's domain is not the URL's";

  app_->Take(
      R"({"type":"session_call","call":2,"session":"","method":"cookies_set",)"
      R"("details":{"url":"https://a.test/","name":"n"}})");
  desk_.cookie_refusal.reset();
  app_->Take(
      R"({"type":"session_call","call":3,"session":"","method":"cookies_set",)"
      R"("details":{"url":"https://a.test/","name":"m"}})");

  EXPECT_EQ(desk_.calls, (Lines{"set cookie n in electron-claude",
                                "set cookie m in electron-claude"}));
  EXPECT_EQ(sent_, (Lines{"{\"call\":2,\"error\":\"the cookie's domain is not "
                          "the URL's\",\"type\":\"session_result\"}\n",
                          "{\"call\":3,\"result\":null,"
                          "\"type\":\"session_result\"}\n"}));
}

TEST_F(ElectronAppTest, ASessionCallIsAnsweredOnceTheDeskIsDone) {
  Hello();

  app_->Take(R"({"type":"session_call","call":4,"session":"",)"
             R"("method":"clear_storage_data"})");
  EXPECT_EQ(sent_, Lines{});
  std::move(desk_.waiting).Run();

  EXPECT_EQ(desk_.calls, Lines{"clear storage in electron-claude"});
  EXPECT_EQ(
      sent_,
      Lines{"{\"call\":4,\"result\":null,\"type\":\"session_result\"}\n"});
}

TEST_F(ElectronAppTest, AUserAgentReachesTheSessionsWindowsAndItsNewOnes) {
  Hello();
  app_->Take(R"({"type":"open_window","window":1,"url":"https://a.test/",)"
             R"("session":"persist:work"})");
  app_->Take(R"({"type":"open_window","window":2,"url":"https://a.test/"})");
  desk_.calls.clear();
  sent_.clear();

  app_->Take(R"({"type":"session_call","call":5,"session":"persist:work",)"
             R"("method":"set_user_agent","user_agent":"Claude/1"})");

  EXPECT_EQ(desk_.calls, Lines{"user agent 10 Claude/1"});
  EXPECT_EQ(
      sent_,
      Lines{"{\"call\":5,\"result\":null,\"type\":\"session_result\"}\n"});
  // A window opened later finds it on its session, before it loads.
  EXPECT_EQ(desk_.sessions.at("10")->user_agent(), "Claude/1");
  EXPECT_EQ(desk_.sessions.at("11")->user_agent(), "");
}

TEST_F(ElectronAppTest, TheFallbackReachesSessionsWithoutTheirOwnUserAgent) {
  Hello();
  app_->Take(R"({"type":"open_window","window":1,"url":"https://a.test/",)"
             R"("session":"persist:work"})");
  app_->Take(R"({"type":"open_window","window":2,"url":"https://a.test/"})");
  app_->Take(R"({"type":"session_call","call":5,"session":"persist:work",)"
             R"("method":"set_user_agent","user_agent":"Claude/1"})");
  desk_.calls.clear();
  sent_.clear();

  app_->Take(
      R"({"type":"set_user_agent_fallback","user_agent":"Slack/4 Electron/45"})");

  EXPECT_EQ(desk_.calls, Lines{"user agent 11 Slack/4 Electron/45"});
  EXPECT_EQ(sent_, Lines{});
  EXPECT_EQ(desk_.sessions.at("10")->user_agent(), "Claude/1");
  EXPECT_EQ(desk_.sessions.at("11")->user_agent(), "Slack/4 Electron/45");
}

TEST_F(ElectronAppTest, ASessionsEmptyUserAgentGivesItsWindowsTheFallback) {
  Hello();
  app_->Take(
      R"({"type":"set_user_agent_fallback","user_agent":"Slack/4 Electron/45"})");
  app_->Take(R"({"type":"open_window","window":1,"url":"https://a.test/",)"
             R"("session":"persist:work"})");
  app_->Take(R"({"type":"session_call","call":5,"session":"persist:work",)"
             R"("method":"set_user_agent","user_agent":"Claude/1"})");
  desk_.calls.clear();

  app_->Take(R"({"type":"session_call","call":6,"session":"persist:work",)"
             R"("method":"set_user_agent","user_agent":""})");

  // As a window opened now would.
  EXPECT_EQ(desk_.calls, Lines{"user agent 10 Slack/4 Electron/45"});
  EXPECT_EQ(desk_.sessions.at("10")->user_agent(), "Slack/4 Electron/45");
}

TEST_F(ElectronAppTest, ABadSessionCallIsAnsweredWithWhy) {
  Hello();

  app_->Take(R"({"type":"session_call","call":6,"session":"",)"
             R"("method":"cookies_remove"})");
  app_->Take(R"({"type":"session_call","call":7,"session":"persist:",)"
             R"("method":"clear_cache"})");

  EXPECT_EQ(desk_.calls, Lines{});
  EXPECT_EQ(
      sent_,
      (Lines{"{\"call\":6,\"error\":\"\\\"url\\\" must be a string\","
             "\"type\":\"session_result\"}\n",
             "{\"call\":7,\"error\":\"a partition of \\\"persist:\\\" "
             "names no partition to keep\",\"type\":\"session_result\"}\n"}));
}

// window.open in window 1's page, which keeps a handle on it.
constexpr char kAskedLine[] =
    R"({"ask":1,"disposition":"new-window","features":"width=500",)"
    R"("frame_name":"popup","referrer":"https://a.test/",)"
    R"("type":"window_open","url":"https://b.test/","window":1})"
    "\n";

ElectronWindowOpenDetails AskedDetails() {
  return {.url = GURL("https://b.test/"),
          .frame_name = "popup",
          .features = "width=500",
          .disposition = "new-window",
          .referrer = GURL("https://a.test/")};
}

TEST_F(ElectronAppTest, APagesNewWindowAsksTheApp) {
  Hello();
  app_->Take(kOpenOwn);
  sent_.clear();

  desk_.pages.at("10").window_opening.Run(AskedDetails(), nullptr);

  EXPECT_EQ(sent_, Lines{kAskedLine});
}

TEST_F(ElectronAppTest, ADeniedWindowClosesAndNothingOpens) {
  Hello();
  app_->Take(kOpenOwn);
  desk_.pages.at("10").window_opening.Run(
      AskedDetails(), std::make_unique<FakeHeldPage>("popup", desk_.calls));
  desk_.calls.clear();
  sent_.clear();

  app_->Take(R"({"type":"window_open_answer","ask":1,"action":"deny"})");

  EXPECT_EQ(desk_.calls, Lines{"destroy held popup"});
  EXPECT_TRUE(sent_.empty());
}

TEST_F(ElectronAppTest, AnAllowedNoopenerWindowOpensWhereThePageAsked) {
  Hello();
  app_->Take(kOpenOwn);
  desk_.pages.at("10").window_opening.Run(AskedDetails(), nullptr);
  desk_.calls.clear();
  sent_.clear();

  app_->Take(
      R"({"type":"window_open_answer","ask":1,"action":"allow","window":2,)"
      R"("title":"B"})");

  EXPECT_EQ(desk_.calls,
            Lines{"open https://b.test/ as com.anthropic.Claude titled B"});
  EXPECT_EQ(sent_, Lines{"{\"type\":\"window_opened\",\"window\":2}\n"});
}

TEST_F(ElectronAppTest, AnAllowedHeldWindowBecomesTheAppsWindow) {
  Hello();
  app_->Take(kOpenOwn);
  desk_.pages.at("10").window_opening.Run(
      AskedDetails(), std::make_unique<FakeHeldPage>("popup", desk_.calls));
  desk_.calls.clear();
  sent_.clear();

  app_->Take(
      R"({"type":"window_open_answer","ask":1,"action":"allow","window":2,)"
      R"json("preload":"p()","hidden":true})json");
  app_->Take(R"({"type":"focus_window","window":2})");

  EXPECT_EQ(desk_.calls,
            (Lines{"adopt popup as com.anthropic.Claude with p() hidden",
                   "focus 11"}));
  EXPECT_EQ(sent_, Lines{"{\"type\":\"window_opened\",\"window\":2}\n"});
}

TEST_F(ElectronAppTest, AHeldWindowStaysInItsOpenersSession) {
  Hello();
  app_->Take(kOpenOwn);
  desk_.pages.at("10").window_opening.Run(
      AskedDetails(), std::make_unique<FakeHeldPage>("popup", desk_.calls));
  desk_.calls.clear();
  sent_.clear();

  app_->Take(
      R"({"type":"window_open_answer","ask":1,"action":"allow","window":2,)"
      R"("session":"persist:other"})");

  EXPECT_EQ(sent_, Lines{R"({"type":"window_refused","why":"a window its )"
                         R"(opener keeps a handle on is in the opener's )"
                         R"(session, \"\", not \"persist:other\"",)"
                         R"("window":2})"
                         "\n"});
  EXPECT_EQ(desk_.calls, Lines{"destroy held popup"});
}

TEST_F(ElectronAppTest, AWindowOpenAnswerNobodyWaitsForIsRefused) {
  Hello();

  app_->Take(R"({"type":"window_open_answer","ask":4,"action":"deny"})");

  EXPECT_EQ(sent_, Lines{R"({"type":"refused","why":"no new window is )"
                         R"(waiting for answer 4"})"
                         "\n"});
}

TEST_F(ElectronAppTest, AnAppThatGoesClosesTheWindowsItWasAskedAbout) {
  Hello();
  app_->Take(kOpenOwn);
  desk_.pages.at("10").window_opening.Run(
      AskedDetails(), std::make_unique<FakeHeldPage>("popup", desk_.calls));
  desk_.calls.clear();

  app_.reset();

  EXPECT_EQ(desk_.calls, (Lines{"close 10", "destroy held popup"}));
}


TEST_F(ElectronAppTest, APageRequestReachesItsWindowsPage) {
  Hello();
  app_->Take(R"({"type":"open_window","window":1,"url":"https://a.test/"})");
  sent_.clear();

  app_->Take(R"({"type":"set_audio_muted","window":1,"muted":true})");

  ASSERT_EQ(desk_.asked.size(), 1u);
  EXPECT_EQ(desk_.asked[0].first, "10");
  EXPECT_EQ(desk_.asked[0].second,
            ElectronPageAction(ElectronSetAudioMuted{.muted = true}));
  EXPECT_EQ(sent_, Lines{});
}

TEST_F(ElectronAppTest, APageThatRefusesARequestSaysWhy) {
  Hello();
  app_->Take(R"({"type":"open_window","window":1,"url":"https://a.test/"})");
  sent_.clear();
  desk_.page_refusal = "no key waits for answer 3";

  app_->Take(R"({"type":"input_answer","window":1,"ask":3,"prevent":false})");

  EXPECT_EQ(sent_, Lines{"{\"type\":\"window_refused\",\"why\":\"no key "
                         "waits for answer 3\",\"window\":1}\n"});
}

TEST_F(ElectronAppTest, APageReportReachesTheApp) {
  Hello();
  app_->Take(R"({"type":"open_window","window":1,"url":"https://a.test/"})");
  sent_.clear();

  desk_.pages.at("10").reported.Run(ElectronAudible{.audible = true});

  EXPECT_EQ(sent_, Lines{"{\"audible\":true,\"type\":\"audible\","
                         "\"window\":1}\n"});
}

TEST_F(ElectronAppTest, APagesOwnUserAgentOutlastsItsSessionsAndTheFallback) {
  Hello();
  app_->Take(R"({"type":"open_window","window":1,"url":"https://a.test/",)"
             R"("user_agent":"Mine/1"})");
  app_->Take(R"({"type":"open_window","window":2,"url":"https://a.test/"})");
  EXPECT_EQ(desk_.calls,
            (Lines{"open https://a.test/ as com.anthropic.Claude as agent Mine/1",
                   "open https://a.test/ as com.anthropic.Claude"}));
  desk_.calls.clear();

  app_->Take(R"({"type":"session_call","call":5,"session":"",)"
             R"("method":"set_user_agent","user_agent":"Claude/1"})");
  app_->Take(
      R"({"type":"set_user_agent_fallback","user_agent":"Slack/4 Electron/45"})");

  EXPECT_EQ(desk_.calls, Lines{"user agent 11 Claude/1"});
}

TEST_F(ElectronAppTest, APagesUserAgentGoesBackToItsSessionsWhenEmptied) {
  Hello();
  app_->Take(R"({"type":"session_call","call":5,"session":"",)"
             R"("method":"set_user_agent","user_agent":"Claude/1"})");
  app_->Take(R"({"type":"open_window","window":1,"url":"https://a.test/"})");
  desk_.calls.clear();

  app_->Take(
      R"({"type":"set_page_user_agent","window":1,"user_agent":"Mine/1"})");
  app_->Take(R"({"type":"set_page_user_agent","window":1,"user_agent":""})");

  EXPECT_EQ(desk_.calls,
            (Lines{"user agent 10 Mine/1", "user agent 10 Claude/1"}));
  EXPECT_TRUE(desk_.asked.empty());
}

template <typename T>
base::OnceCallback<void(T)> IntoAny(std::optional<T>& got) {
  return base::BindOnce([](std::optional<T>* into, T value) { *into = value; },
                        &got);
}

TEST_F(ElectronAppTest, ASignInIsAnsweredByTheAppsListeners) {
  Hello();
  app_->Take(kOpenOwn);
  sent_.clear();
  std::optional<ElectronLoginAnswer> page;
  std::optional<ElectronLoginAnswer> proxy;

  desk_.sessions.at("10")->AskToSignIn(
      "10",
      {.url = GURL("https://a.test/"),
       .scheme = "basic",
       .host = "a.test",
       .port = 443,
       .realm = "r"},
      IntoAny(page));
  desk_.sessions.at("10")->AskToSignIn(
      std::nullopt,
      {.url = GURL("https://b.test/"),
       .is_proxy = true,
       .scheme = "basic",
       .host = "proxy.test",
       .port = 3128},
      IntoAny(proxy));
  app_->Take(R"({"type":"login_answer","ask":2,"action":"default"})");
  app_->Take(R"({"type":"login_answer","ask":1,"action":"sign_in",)"
             R"("username":"me","password":"pw"})");

  ASSERT_EQ(sent_.size(), 2u);
  EXPECT_TRUE(sent_[0].contains(R"("window":1)")) << sent_[0];
  EXPECT_FALSE(sent_[1].contains(R"("window")")) << sent_[1];
  EXPECT_EQ(page, (ElectronLoginAnswer{.action = ElectronLoginAction::kSignIn,
                                       .username = u"me",
                                       .password = u"pw"}));
  EXPECT_EQ(proxy,
            (ElectronLoginAnswer{.action = ElectronLoginAction::kDefault}));
}

TEST_F(ElectronAppTest, AnAnswerOfTheWrongKindOrForNothingIsRefused) {
  Hello();
  app_->Take(kOpenOwn);
  std::optional<bool> allowed;
  desk_.sessions.at("10")->AskAboutCertificateError(
      "10", {.url = GURL("https://a.test/"), .error = "net::ERR_CERT_DATE_INVALID"},
      IntoAny(allowed));
  sent_.clear();

  app_->Take(R"({"type":"login_answer","ask":1,"action":"cancel"})");
  app_->Take(R"({"type":"certificate_answer","ask":9,"allow":true})");
  app_->Take(R"({"type":"certificate_answer","ask":1,"allow":true})");

  EXPECT_EQ(sent_, (Lines{R"({"type":"refused","why":"answer 1 is for )"
                          R"(another kind of question"})"
                          "\n",
                          R"({"type":"refused","why":"no sign-in or )"
                          R"(certificate question is waiting for answer 9"})"
                          "\n"}));
  EXPECT_EQ(allowed, true);
}

TEST_F(ElectronAppTest, AClientCertificateNeverOfferedGoesOnWithNone) {
  Hello();
  app_->Take(kOpenOwn);
  std::optional<std::optional<int>> chosen;
  base::ListValue offered;
  offered.Append(base::DictValue().Set("subjectName", "one"));
  desk_.sessions.at("10")->AskForClientCertificate(
      "10", {.host_and_port = "a.test:443", .certificates = std::move(offered)},
      IntoAny(chosen));
  sent_.clear();

  app_->Take(R"({"type":"client_certificate_answer","ask":1,"certificate":1})");

  EXPECT_EQ(sent_, Lines{R"({"type":"refused","why":"answer 1 chose )"
                         R"(certificate 1 of 1 offered"})"
                         "\n"});
  EXPECT_EQ(chosen, std::optional<std::optional<int>>(std::in_place, std::nullopt));
}

TEST_F(ElectronAppTest, AnAppThatGoesCancelsItsSignInsAndRefusesCertificates) {
  Hello();
  app_->Take(kOpenOwn);
  ElectronSession& session = *desk_.sessions.at("10");
  std::optional<ElectronLoginAnswer> login;
  std::optional<bool> allowed;
  std::optional<std::optional<int>> chosen;
  session.AskToSignIn("10", {.url = GURL("https://a.test/")}, IntoAny(login));
  session.AskAboutCertificateError("10", {.url = GURL("https://a.test/")},
                                   IntoAny(allowed));
  session.AskForClientCertificate("10", {.host_and_port = "a.test:443"},
                                  IntoAny(chosen));

  app_.reset();

  EXPECT_EQ(login,
            (ElectronLoginAnswer{.action = ElectronLoginAction::kCancel}));
  EXPECT_EQ(allowed, false);
  EXPECT_EQ(chosen, std::optional<std::optional<int>>(std::in_place, std::nullopt));
}

TEST_F(ElectronAppTest, ANetworkSessionCallIsTheDesksToAnswer) {
  Hello();

  app_->Take(R"({"type":"session_call","call":3,"session":"persist:work",)"
             R"("method":"clear_auth_cache"})");

  EXPECT_EQ(desk_.calls, Lines{"network call 1 in electron-claude:work"});
  EXPECT_EQ(sent_, Lines{R"({"call":3,"result":"done",)"
                         R"("type":"session_result"})"
                         "\n"});
}

TEST_F(ElectronAppTest, AWatchOnServiceWorkersGivesTheRunningOnesThenEachChange) {
  Hello();
  desk_.running_workers = {{.version_id = 2,
                            .scope = GURL("https://a.test/"),
                            .script_url = GURL("https://a.test/sw.js"),
                            .render_process_id = 7}};

  app_->Take(R"({"type":"session_call","call":1,"session":"",)"
             R"("method":"service_workers_watch"})");
  app_->Take(R"({"type":"session_call","call":2,"session":"",)"
             R"("method":"service_workers_watch"})");
  desk_.service_worker_changed.Run(
      ElectronServiceWorkerRegistered{.scope = GURL("https://a.test/")});

  EXPECT_EQ(desk_.calls, Lines{"watch service workers in electron-claude"});
  const std::string running =
      R"([{"render_process_id":7,"scope":"https://a.test/",)"
      R"("script_url":"https://a.test/sw.js","version_id":2.0}])";
  EXPECT_EQ(sent_,
            (Lines{base::StrCat({R"({"call":1,"result":)", running,
                                 R"(,"type":"session_result"})", "\n"}),
                   base::StrCat({R"({"call":2,"result":)", running,
                                 R"(,"type":"session_result"})", "\n"}),
                   R"({"event":"registration_completed",)"
                   R"("scope":"https://a.test/","session":"",)"
                   R"("type":"service_worker"})"
                   "\n"}));
}

}  // namespace

TEST_F(ElectronAppTest, APageCallReachesTheDeskAndItsAnswerTheApp) {
  Hello();
  app_->Take(R"({"type":"open_window","window":3,"url":"https://a.test/"})");
  sent_.clear();
  desk_.calls.clear();

  app_->Take(
      R"({"type":"page_call","window":3,"call":1,"method":"insert_css",)"
      R"("css":"a{}","user":true})");
  app_->Take(R"({"type":"page_call","window":3,"call":2,)"
             R"("method":"reload_ignoring_cache"})");
  ASSERT_EQ(desk_.calls, (Lines{"page call 10", "page call 10"}));
  // A method is move-only, so the list is checked one by one.
  ASSERT_EQ(desk_.page_methods.size(), 2u);
  EXPECT_EQ(desk_.page_methods[0],
            ElectronPageMethod(ElectronInsertCss{.css = "a{}", .user = true}));
  EXPECT_EQ(desk_.page_methods[1],
            ElectronPageMethod(ElectronReloadIgnoringCache{}));
  std::move(desk_.page_answers[1]).Run(base::unexpected("no"));
  std::move(desk_.page_answers[0]).Run(base::Value("key"));

  EXPECT_EQ(sent_,
            (Lines{"{\"call\":2,\"error\":\"no\",\"type\":\"page_result\","
                   "\"window\":3}\n",
                   "{\"call\":1,\"result\":\"key\",\"type\":\"page_result\","
                   "\"window\":3}\n"}));
}

TEST_F(ElectronAppTest, APageCallTheEngineCantMakeFailsAsThatCall) {
  Hello();
  app_->Take(R"({"type":"open_window","window":3,"url":"https://a.test/"})");
  sent_.clear();
  desk_.calls.clear();

  app_->Take(R"({"type":"page_call","window":3,"call":1,"method":"fly"})");
  app_->Take(R"({"type":"page_call","window":4,"call":2,)"
             R"("method":"reload_ignoring_cache"})");

  EXPECT_TRUE(desk_.calls.empty());
  EXPECT_EQ(sent_,
            (Lines{"{\"call\":1,\"error\":\"no page call is named fly\","
                   "\"type\":\"page_result\",\"window\":3}\n",
                   "{\"call\":2,\"error\":\"window 4 is not open\","
                   "\"type\":\"page_result\",\"window\":4}\n"}));
}

TEST_F(ElectronAppTest, APagesDevToolsEventsReachTheApp) {
  Hello();
  app_->Take(R"({"type":"open_window","window":3,"url":"https://a.test/"})");
  ElectronPageCalls page = desk_.pages.at("10");
  sent_.clear();

  page.devtools_event.Run("Page.screencastFrame",
                          base::DictValue().Set("sessionId", 1));
  EXPECT_EQ(sent_, Lines{"{\"method\":\"Page.screencastFrame\",\"params\":"
                         "{\"sessionId\":1},\"type\":\"devtools_event\","
                         "\"window\":3}\n"});
  // A window that closed says nothing more.
  app_->Listed({});
  sent_.clear();
  page.devtools_event.Run("Page.screencastFrame", base::DictValue());

  EXPECT_TRUE(sent_.empty());
}

}  // namespace domicile
