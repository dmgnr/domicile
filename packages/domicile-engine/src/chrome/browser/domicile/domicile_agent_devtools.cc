// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "chrome/browser/domicile/domicile_agent_devtools.h"

#include <algorithm>
#include <optional>
#include <string>
#include <string_view>
#include <utility>

#include "base/check.h"
#include "base/containers/span.h"
#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/memory/scoped_refptr.h"
#include "base/strings/strcat.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/string_view_util.h"
#include "base/task/sequenced_task_runner.h"
#include "base/time/time.h"
#include "base/timer/timer.h"
#include "base/types/expected.h"
#include "chrome/browser/domicile/domicile_browser_windows.h"
#include "content/public/browser/browser_context.h"
#include "content/public/browser/browser_thread.h"
#include "content/public/browser/devtools_agent_host.h"
#include "content/public/browser/devtools_agent_host_client.h"
#include "content/public/browser/web_contents.h"

namespace domicile {
namespace {

// The window an agent names to reach the shell's own page: its bars, panels
// and dialogs.
constexpr char kShellWindow[] = "shell";

// What an agent may not send the shell's page: it reads and clicks the shell,
// and never takes the desk away from it.
constexpr std::string_view kShellKeeps[] = {
    "Page.navigate", "Page.navigateToHistoryEntry", "Page.reload"};

// The id of the one method a client sends.
constexpr int kMethodId = 1;

// How long a page has to answer. The command socket serves one request at a
// time, so a page that never answers must not hold it.
constexpr base::TimeDelta kPatience = base::Seconds(10);

// A DevTools client that sends one method, answers with its result, then
// detaches and deletes itself.
class OneMethod : public content::DevToolsAgentHostClient {
 public:
  OneMethod(scoped_refptr<content::DevToolsAgentHost> host,
            DevToolsAnswered answered)
      : host_(std::move(host)), answered_(std::move(answered)) {}

  OneMethod(const OneMethod&) = delete;
  OneMethod& operator=(const OneMethod&) = delete;

  ~OneMethod() override = default;

  void Send(const std::string& method, base::DictValue params) {
    if (!host_->AttachClient(this)) {
      Finish(base::unexpected(
          "DevTools could not attach to the window's page"));
      return;
    }
    attached_ = true;
    base::DictValue message;
    message.Set("id", kMethodId);
    message.Set("method", method);
    message.Set("params", std::move(params));
    std::string json;
    // The message holds only what a JSON line parsed into, so a write failure
    // is a bug.
    CHECK(base::JSONWriter::Write(message, &json));
    timeout_.Start(FROM_HERE, kPatience,
                   base::BindOnce(&OneMethod::TimedOut, base::Unretained(this),
                                  method));
    host_->DispatchProtocolMessage(this, base::as_byte_span(json));
  }

  // content::DevToolsAgentHostClient:
  void DispatchProtocolMessage(content::DevToolsAgentHost* host,
                               base::span<const uint8_t> message) override {
    const std::string_view text = base::as_string_view(message);
    std::optional<base::DictValue> parsed =
        base::JSONReader::ReadDict(text, base::JSON_PARSE_RFC);
    if (!parsed) {
      Finish(base::unexpected(base::StrCat(
          {"DevTools sent a message that is not a JSON object: ", text})));
      return;
    }
    if (parsed->FindInt("id") != kMethodId) {
      // An event the method set off; only its answer matters.
      return;
    }
    if (const base::DictValue* error = parsed->FindDict("error")) {
      const std::string* why = error->FindString("message");
      Finish(base::unexpected(
          why != nullptr ? *why : std::string("the method failed")));
      return;
    }
    base::DictValue* result = parsed->FindDict("result");
    Finish(base::ok(result != nullptr ? std::move(*result)
                                      : base::DictValue()));
  }

  void AgentHostClosed(content::DevToolsAgentHost* host) override {
    attached_ = false;
    Finish(base::unexpected("the window's page closed before it answered"));
  }

  // An agent drives the page and nothing past it.
  bool MayReadLocalFiles() override { return false; }
  bool MayWriteLocalFiles() override { return false; }
  bool IsTrusted() override { return false; }
  bool AllowUnsafeOperations() override { return false; }

 private:
  void TimedOut(const std::string& method) {
    Finish(base::unexpected(base::StrCat(
        {"the page did not answer ", method, " within ",
         base::NumberToString(kPatience.InSeconds()), " seconds"})));
  }

  void Finish(base::expected<base::DictValue, std::string> answer) {
    if (answered_.is_null()) {
      return;
    }
    timeout_.Stop();
    std::move(answered_).Run(std::move(answer));
    // Not now: the host may be dispatching to this client.
    base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE,
        base::BindOnce(&OneMethod::DetachAndDelete, base::Unretained(this)));
  }

  void DetachAndDelete() {
    if (attached_) {
      host_->DetachClient(this);
    }
    delete this;
  }

  const scoped_refptr<content::DevToolsAgentHost> host_;
  DevToolsAnswered answered_;
  bool attached_ = false;
  base::OneShotTimer timeout_;
};

}  // namespace

void SendDevToolsToBrowserWindow(const std::string& window,
                                 const std::string& method,
                                 base::DictValue params,
                                 DevToolsAnswered answered) {
  CHECK_CURRENTLY_ON(content::BrowserThread::UI);
  content::WebContents* page = window == kShellWindow
                                   ? DeskShellContents()
                                   : BrowserWindowContents(window);
  if (page == nullptr) {
    std::move(answered).Run(base::unexpected(
        base::StrCat({"no browser window ", window, " is open"})));
    return;
  }
  if (window == kShellWindow && std::ranges::contains(kShellKeeps, method)) {
    std::move(answered).Run(base::unexpected(
        base::StrCat({method, " is refused on the shell's page"})));
    return;
  }
  if (page->GetBrowserContext()->IsOffTheRecord()) {
    std::move(answered).Run(base::unexpected(base::StrCat(
        {"browser window ", window,
         " is private, and agents do not drive private windows"})));
    return;
  }
  // Owns itself until answered.
  (new OneMethod(content::DevToolsAgentHost::GetOrCreateFor(page),
                 std::move(answered)))
      ->Send(method, std::move(params));
}

}  // namespace domicile
