// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/browser/electron_protocol.h"

#include <algorithm>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "base/base64.h"
#include "base/check.h"
#include "base/check_op.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/notreached.h"
#include "base/strings/strcat.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/string_util.h"
#include "base/types/expected.h"
#include "base/types/expected_macros.h"
#include "base/values.h"
#include "net/http/http_util.h"
#include "url/gurl.h"
#include "url/url_constants.h"

namespace domicile {
namespace {

std::string Line(base::DictValue event) {
  std::string line;
  // Events hold only strings and small integers, so a write failure is a bug.
  CHECK(base::JSONWriter::Write(event, &line));
  line.push_back('\n');
  return line;
}

base::DictValue Event(std::string_view type, ElectronWindow window) {
  base::DictValue event;
  event.Set("type", type);
  event.Set("window", window);
  return event;
}

base::expected<ElectronWindow, std::string> WindowIn(
    const base::DictValue& request) {
  const std::optional<int> window = request.FindInt("window");
  if (!window.has_value() || *window < 1) {
    return base::unexpected("\"window\" must be a whole number from 1");
  } else {
    return *window;
  }
}

base::expected<GURL, std::string> UrlIn(const base::DictValue& request) {
  const std::string* text = request.FindString("url");
  if (text == nullptr) {
    return base::unexpected("\"url\" must be a string");
  }
  GURL url(*text);
  if (!url.is_valid()) {
    return base::unexpected(base::StrCat({*text, " is not a URL"}));
  } else if (!IsElectronHandleableScheme(url.scheme())) {
    // Whether the app's session serves the scheme is the app's to say; a
    // scheme no app may handle never opens.
    return base::unexpected(
        base::StrCat({url.scheme(), ": URLs do not open in an app window"}));
  } else {
    return url;
  }
}

base::expected<ElectronRequest, ElectronRefusal> Refuse(
    std::string why,
    std::optional<ElectronWindow> window = std::nullopt) {
  return base::unexpected(
      ElectronRefusal{.why = std::move(why), .window = window});
}

base::expected<ElectronRequest, ElectronRefusal> RefuseRequest(std::string why,
                                                               int request) {
  return base::unexpected(
      ElectronRefusal{.why = std::move(why), .request = request});
}

// An open_window's "node", which `request` has.
base::expected<ElectronNode, std::string> NodeIn(const base::Value& node) {
  if (!node.is_dict()) {
    return base::unexpected(
        "\"node\" must be an object: what the page's Node.js needs");
  }
  const base::DictValue& dict = node.GetDict();
  ElectronNode made;
  for (auto [key, out] :
       {std::pair<const char*, std::string*>{"preload", &made.preload},
        {"app_path", &made.app_path}}) {
    const base::Value* value = dict.Find(key);
    if (value == nullptr) {
      continue;
    }
    if (!value->is_string()) {
      return base::unexpected(
          base::StrCat({"\"node\"'s \"", key, "\" must be a string"}));
    }
    *out = value->GetString();
  }
  for (auto [key, out] :
       {std::pair<const char*, bool*>{"integration", &made.integration},
        {"context_isolation", &made.context_isolation}}) {
    const base::Value* value = dict.Find(key);
    if (value == nullptr) {
      continue;
    }
    if (!value->is_bool()) {
      return base::unexpected(base::StrCat(
          {"\"node\"'s \"", key, "\" must be true or false"}));
    }
    *out = value->GetBool();
  }
  if (!made.preload.empty() &&
      !base::FilePath(made.preload).IsAbsolute()) {
    return base::unexpected(
        "\"node\"'s \"preload\" must be an absolute path");
  }
  if (const base::Value* env = dict.Find("env")) {
    if (!env->is_dict()) {
      return base::unexpected(
          "\"node\"'s \"env\" must be an object of strings");
    }
    for (const auto [name, value] : env->GetDict()) {
      if (!value.is_string()) {
        return base::unexpected(
            "\"node\"'s \"env\" must be an object of strings");
      }
      made.env.emplace_back(name, value.GetString());
    }
  }
  return made;
}

// The "session" a request names: "" when it names none and may leave it out.
base::expected<std::string, std::string> SessionIn(
    const base::DictValue& request,
    bool optional) {
  const base::Value* session = request.Find("session");
  if (session == nullptr && optional) {
    return base::ok(std::string());
  } else if (session == nullptr || !session->is_string()) {
    return base::unexpected("\"session\" must be a string");
  } else {
    return base::ok(session->GetString());
  }
}

base::expected<ElectronRequest, ElectronRefusal> ParseHandleProtocol(
    const base::DictValue& request,
    bool handle) {
  base::expected<std::string, std::string> session =
      SessionIn(request, /*optional=*/false);
  const std::string* scheme = request.FindString("scheme");
  if (!session.has_value()) {
    return Refuse(std::move(session.error()));
  } else if (scheme == nullptr) {
    return Refuse("\"scheme\" must be a string");
  } else if (!IsElectronHandleableScheme(*scheme)) {
    return Refuse(base::StrCat({"an app cannot handle ", *scheme, ":"}));
  }
  return ElectronHandleProtocol{
      .session = std::move(*session), .scheme = *scheme, .handle = handle};
}

base::expected<std::string, std::string> Base64In(
    const base::DictValue& request,
    std::string_view key) {
  const std::string* text = request.FindString(key);
  std::string bytes;
  if (text == nullptr || !base::Base64Decode(*text, &bytes)) {
    return base::unexpected(base::StrCat({"\"", key, "\" must be base64"}));
  }
  return base::ok(std::move(bytes));
}

base::expected<ElectronHeaders, std::string> HeadersIn(
    const base::DictValue& response) {
  const base::ListValue* list = response.FindList("headers");
  if (list == nullptr) {
    return base::unexpected("\"headers\" must be an array");
  }
  ElectronHeaders headers;
  for (const base::Value& pair : *list) {
    const base::ListValue* entry = pair.GetIfList();
    if (entry == nullptr || entry->size() != 2 || !(*entry)[0].is_string() ||
        !(*entry)[1].is_string()) {
      return base::unexpected(
          "each header must be a [name, value] pair of strings");
    }
    const std::string& name = (*entry)[0].GetString();
    const std::string& value = (*entry)[1].GetString();
    if (!net::HttpUtil::IsValidHeaderName(name)) {
      return base::unexpected(
          base::StrCat({"\"", name, "\" is not a header name"}));
    } else if (!net::HttpUtil::IsValidHeaderValue(value)) {
      return base::unexpected(base::StrCat(
          {"header ", name, " has a value no response can carry"}));
    }
    headers.emplace_back(name, value);
  }
  return base::ok(std::move(headers));
}

base::expected<ElectronResponse, std::string> ResponseIn(
    const base::DictValue& request) {
  const std::optional<int> status = request.FindInt("status");
  if (!status.has_value() || *status < 100 || *status > 599) {
    return base::unexpected("\"status\" must be from 100 to 599");
  }
  base::expected<ElectronHeaders, std::string> headers = HeadersIn(request);
  if (!headers.has_value()) {
    return base::unexpected(std::move(headers.error()));
  }
  const int bodies = request.contains("body") + request.contains("file") +
                     request.contains("stream");
  if (bodies != 1) {
    return base::unexpected(
        "a response has one of \"body\", \"file\" and \"stream\"");
  }
  ElectronResponse response{.status = *status,
                            .headers = std::move(*headers),
                            .body = ElectronStreamedBody()};
  if (request.contains("body")) {
    base::expected<std::string, std::string> body = Base64In(request, "body");
    if (!body.has_value()) {
      return base::unexpected(std::move(body.error()));
    }
    response.body = std::move(*body);
  } else if (request.contains("file")) {
    const std::string* file = request.FindString("file");
    if (file == nullptr || !base::FilePath(*file).IsAbsolute()) {
      return base::unexpected("\"file\" must be an absolute path");
    }
    response.body = base::FilePath(*file);
  } else if (request.FindBool("stream") != true) {
    return base::unexpected("\"stream\" must be true");
  }
  return base::ok(std::move(response));
}

// The protocol request a line answers, or why it names none.
base::expected<int, std::string> ProtocolRequestIn(
    const base::DictValue& request) {
  const std::optional<int> number = request.FindInt("request");
  if (!number.has_value() || *number < 1) {
    return base::unexpected("\"request\" must be a whole number from 1");
  }
  return base::ok(*number);
}

base::expected<ElectronRequest, ElectronRefusal> ParseProtocolAnswer(
    std::string_view type,
    const base::DictValue& request) {
  const base::expected<int, std::string> number = ProtocolRequestIn(request);
  if (!number.has_value()) {
    return Refuse(number.error());
  } else if (type == "protocol_response") {
    if (const base::Value* error = request.Find("error")) {
      if (!error->is_string()) {
        return RefuseRequest("\"error\" must be a string", *number);
      }
      return ElectronProtocolResponse{
          .request = *number, .response = base::unexpected(error->GetString())};
    }
    base::expected<ElectronResponse, std::string> response =
        ResponseIn(request);
    if (!response.has_value()) {
      return RefuseRequest(std::move(response.error()), *number);
    }
    return ElectronProtocolResponse{.request = *number,
                                    .response = std::move(*response)};
  } else if (type == "protocol_data") {
    base::expected<std::string, std::string> data = Base64In(request, "data");
    if (!data.has_value()) {
      return RefuseRequest(std::move(data.error()), *number);
    }
    return ElectronProtocolData{.request = *number, .bytes = std::move(*data)};
  } else {
    CHECK_EQ(type, "protocol_end");
    const base::Value* error = request.Find("error");
    if (error != nullptr && !error->is_string()) {
      return RefuseRequest("\"error\" must be a string", *number);
    }
    return ElectronProtocolEnd{
        .request = *number,
        .error = error ? std::optional(error->GetString()) : std::nullopt};
  }
}

// Each webRequest event's name on the wire.
constexpr std::pair<ElectronWebRequestEvent, std::string_view>
    kWebRequestEvents[] = {
        {ElectronWebRequestEvent::kBeforeRequest, "before_request"},
        {ElectronWebRequestEvent::kBeforeSendHeaders, "before_send_headers"},
        {ElectronWebRequestEvent::kSendHeaders, "send_headers"},
        {ElectronWebRequestEvent::kHeadersReceived, "headers_received"},
        {ElectronWebRequestEvent::kResponseStarted, "response_started"},
        {ElectronWebRequestEvent::kBeforeRedirect, "before_redirect"},
        {ElectronWebRequestEvent::kCompleted, "completed"},
        {ElectronWebRequestEvent::kErrorOccurred, "error_occurred"},
};

base::expected<ElectronRequest, ElectronRefusal> ParseWebRequestListen(
    const base::DictValue& request) {
  base::expected<std::string, std::string> session =
      SessionIn(request, /*optional=*/false);
  if (!session.has_value()) {
    return Refuse(std::move(session.error()));
  }
  const base::ListValue* names = request.FindList("events");
  if (names == nullptr) {
    return Refuse("\"events\" must name webRequest events");
  }
  std::set<ElectronWebRequestEvent> events;
  for (const base::Value& name : *names) {
    const auto* found =
        name.is_string()
            ? std::ranges::find(
                  kWebRequestEvents, name.GetString(),
                  &std::pair<ElectronWebRequestEvent, std::string_view>::second)
            : std::end(kWebRequestEvents);
    if (found == std::end(kWebRequestEvents)) {
      return Refuse("\"events\" must name webRequest events");
    }
    events.insert(found->first);
  }
  return ElectronWebRequestListen{.session = std::move(*session),
                                  .events = std::move(events)};
}

// The headers under `key`, when the line has them.
base::expected<std::optional<ElectronHeaders>, std::string> OptionalHeadersIn(
    const base::DictValue& request,
    std::string_view key) {
  if (!request.contains(key)) {
    return std::nullopt;
  } else if (!request.Find(key)->is_list()) {
    return base::unexpected(base::StrCat({"\"", key, "\" must be an array"}));
  }
  base::DictValue only;
  only.Set("headers", request.Find(key)->Clone());
  base::expected<ElectronHeaders, std::string> headers = HeadersIn(only);
  if (!headers.has_value()) {
    return base::unexpected(std::move(headers.error()));
  }
  return std::optional(std::move(*headers));
}

base::expected<ElectronRequest, ElectronRefusal> ParseWebRequestAnswer(
    const base::DictValue& request) {
  const std::optional<int> ask = request.FindInt("ask");
  if (!ask.has_value() || *ask < 1) {
    return Refuse("\"ask\" must be a whole number from 1");
  }
  ElectronWebRequestAnswer answer{.ask = *ask};
  if (const base::Value* cancel = request.Find("cancel")) {
    if (!cancel->is_bool()) {
      return Refuse("\"cancel\" must be true or false");
    }
    answer.cancel = cancel->GetBool();
  }
  if (const base::Value* redirect = request.Find("redirect_url")) {
    GURL url(redirect->is_string() ? redirect->GetString() : "");
    if (!url.is_valid()) {
      return Refuse("\"redirect_url\" must be a URL");
    }
    answer.redirect_url = std::move(url);
  }
  for (auto [key, field] :
       {std::pair("request_headers", &answer.request_headers),
        std::pair("response_headers", &answer.response_headers)}) {
    base::expected<std::optional<ElectronHeaders>, std::string> headers =
        OptionalHeadersIn(request, key);
    if (!headers.has_value()) {
      return Refuse(std::move(headers.error()));
    }
    *field = std::move(*headers);
  }
  if (const base::Value* line = request.Find("status_line")) {
    if (!line->is_string() || !base::StartsWith(line->GetString(), "HTTP/") ||
        !net::HttpUtil::IsValidHeaderValue(line->GetString())) {
      return Refuse("\"status_line\" must be an HTTP status line");
    }
    answer.status_line = line->GetString();
  }
  return answer;
}

base::expected<ElectronRequest, ElectronRefusal> ParsePermissionHandler(
    const base::DictValue& request) {
  base::expected<std::string, std::string> session =
      SessionIn(request, /*optional=*/false);
  const std::optional<bool> handle = request.FindBool("handle");
  if (!session.has_value()) {
    return Refuse(std::move(session.error()));
  } else if (!handle.has_value()) {
    return Refuse("\"handle\" must be true or false");
  }
  return ElectronPermissionHandler{.session = std::move(*session),
                                   .handle = *handle};
}

base::expected<ElectronRequest, ElectronRefusal> ParsePermissionAnswer(
    const base::DictValue& request) {
  const std::optional<int> ask = request.FindInt("ask");
  const std::optional<bool> granted = request.FindBool("granted");
  if (!ask.has_value() || *ask < 1) {
    return Refuse("\"ask\" must be a whole number from 1");
  } else if (!granted.has_value()) {
    return Refuse("\"granted\" must be true or false");
  }
  return ElectronPermissionAnswer{.ask = *ask, .granted = *granted};
}

base::expected<ElectronRequest, ElectronRefusal> ParseDownloadAnswer(
    const base::DictValue& request) {
  const std::optional<int> download = request.FindInt("download");
  const base::Value* path = request.Find("path");
  const base::Value* cancel = request.Find("cancel");
  if (!download.has_value() || *download < 1) {
    return Refuse("\"download\" must be a whole number from 1");
  } else if (path != nullptr &&
             (!path->is_string() ||
              !base::FilePath(path->GetString()).IsAbsolute())) {
    return Refuse("\"path\" must be an absolute path");
  } else if (cancel != nullptr && !cancel->is_bool()) {
    return Refuse("\"cancel\" must be true or false");
  } else if (path != nullptr && cancel != nullptr && cancel->GetBool()) {
    return Refuse("a download_answer cancels or names a path, not both");
  }
  return ElectronDownloadAnswer{
      .download = *download,
      .path = path == nullptr
                  ? std::nullopt
                  : std::optional(base::FilePath(path->GetString())),
      .cancel = cancel != nullptr && cancel->GetBool()};
}

base::expected<ElectronRequest, ElectronRefusal> ParseDownloadControl(
    const base::DictValue& request) {
  const std::optional<int> download = request.FindInt("download");
  const std::string* action = request.FindString("action");
  if (!download.has_value() || *download < 1) {
    return Refuse("\"download\" must be a whole number from 1");
  } else if (action != nullptr && *action == "pause") {
    return ElectronDownloadControlCall{
        .download = *download, .action = ElectronDownloadAction::kPause};
  } else if (action != nullptr && *action == "resume") {
    return ElectronDownloadControlCall{
        .download = *download, .action = ElectronDownloadAction::kResume};
  } else if (action != nullptr && *action == "cancel") {
    return ElectronDownloadControlCall{
        .download = *download, .action = ElectronDownloadAction::kCancel};
  }
  return Refuse("\"action\" must be \"pause\", \"resume\" or \"cancel\"");
}

std::string_view DownloadStateName(ElectronDownloadState state) {
  switch (state) {
    case ElectronDownloadState::kProgressing:
      return "progressing";
    case ElectronDownloadState::kCompleted:
      return "completed";
    case ElectronDownloadState::kCanceled:
      return "canceled";
    case ElectronDownloadState::kInterrupted:
      return "interrupted";
  }
  NOTREACHED();
}

base::ListValue HeadersList(const ElectronHeaders& headers) {
  base::ListValue list;
  for (const auto& [name, value] : headers) {
    base::ListValue pair;
    pair.Append(name);
    pair.Append(value);
    list.Append(std::move(pair));
  }
  return list;
}

base::expected<ElectronRequest, std::string> ParseHello(
    const base::DictValue& request) {
  const std::optional<int> version = request.FindInt("version");
  const std::string* app_id = request.FindString("app_id");
  const std::string* partition = request.FindString("partition");
  const std::string* electron_version = request.FindString("electron_version");
  const std::string* resources_path = request.FindString("resources_path");
  if (version != kElectronProtocolVersion) {
    return base::unexpected(
        base::StrCat({"this engine speaks version ",
                      base::NumberToString(kElectronProtocolVersion)}));
  } else if (app_id == nullptr || app_id->empty()) {
    return base::unexpected("\"app_id\" must be a string that is not empty");
  } else if (partition == nullptr) {
    return base::unexpected("\"partition\" must be a string");
  }
  base::expected<std::optional<WebViewPartition>, std::string> parsed =
      ParseWebViewPartition(*partition);
  if (!parsed.has_value()) {
    return base::unexpected(parsed.error());
  } else if (!parsed->has_value()) {
    return base::unexpected("an app cannot use the profile's own partition");
  } else if (electron_version == nullptr || electron_version->empty()) {
    return base::unexpected(
        "\"electron_version\" must be a string that is not empty: the "
        "Electron the app's pages are told they run on");
  } else if (resources_path == nullptr ||
             !base::FilePath(*resources_path).IsAbsolute()) {
    return base::unexpected("\"resources_path\" must be an absolute path");
  } else {
    return ElectronHello{.app_id = *app_id,
                         .partition = std::move(**parsed),
                         .electron_version = *electron_version,
                         .resources_path = *resources_path};
  }
}

bool IsWindowRequest(std::string_view type) {
  return type == "open_window" || type == "load_url" ||
         type == "focus_window" || type == "go_to_index" ||
         type == "clear_history" || type == "edit" || type == "replace" ||
         type == "find_in_page" || type == "stop_find_in_page" ||
         type == "close_window" || type == "destroy_window" ||
         type == "ipc_send" || type == "ipc_post" || type == "port_post" ||
         type == "port_close" || type == "set_views" ||
         type == "set_menu_bar" || type == "show_message_box" ||
         type == "popup_menu" || type == "close_popup_menu" ||
         type == "execute_javascript" || type == "set_title" ||
         type == "set_hidden" || type == "set_window_state" ||
         type == "remove_history_entry" || type == "navigation_listen";
}

// Entry `entry` of a menu, with only the keys the shell reads, or why it is
// not one. `depth` counts the submenus it is in.
base::expected<base::DictValue, std::string> MenuEntry(const base::Value& entry,
                                                       int depth) {
  // Electron's menus nest a few deep; this keeps a cycle-shaped mistake from
  // recursing without end.
  constexpr int kDeepest = 16;
  const base::DictValue* dict = entry.GetIfDict();
  if (dict == nullptr) {
    return base::unexpected("each menu entry must be an object");
  }
  const std::optional<int> id = dict->FindInt("id");
  const std::string* type = dict->FindString("type");
  const std::string* label = dict->FindString("label");
  const std::optional<bool> enabled = dict->FindBool("enabled");
  const std::optional<bool> visible = dict->FindBool("visible");
  const std::optional<bool> checked = dict->FindBool("checked");
  const base::Value* accelerator = dict->Find("accelerator");
  const base::Value* icon = dict->Find("icon");
  const base::Value* submenu = dict->Find("submenu");
  if (!id.has_value() || *id < 1) {
    return base::unexpected("a menu entry's \"id\" must be a whole number from 1");
  } else if (type == nullptr ||
             (*type != "normal" && *type != "separator" &&
              *type != "submenu" && *type != "checkbox" && *type != "radio")) {
    return base::unexpected(
        "a menu entry's \"type\" must be normal, separator, submenu, "
        "checkbox or radio");
  } else if (label == nullptr) {
    return base::unexpected("a menu entry's \"label\" must be a string");
  } else if (!enabled.has_value() || !visible.has_value() ||
             !checked.has_value()) {
    return base::unexpected(
        "a menu entry's \"enabled\", \"visible\" and \"checked\" must be true "
        "or false");
  } else if (accelerator != nullptr && !accelerator->is_string()) {
    return base::unexpected("a menu entry's \"accelerator\" must be a string");
  } else if (icon != nullptr &&
             (!icon->is_string() ||
              !icon->GetString().starts_with("data:image/png;base64,"))) {
    return base::unexpected("a menu entry's \"icon\" must be a PNG data: URL");
  } else if (submenu != nullptr && !submenu->is_list()) {
    return base::unexpected("a menu entry's \"submenu\" must be a list");
  } else if (submenu != nullptr && depth == kDeepest) {
    return base::unexpected("a menu nests more than 16 submenus deep");
  }
  base::DictValue kept;
  kept.Set("id", *id);
  kept.Set("type", *type);
  kept.Set("label", *label);
  kept.Set("enabled", *enabled);
  kept.Set("visible", *visible);
  kept.Set("checked", *checked);
  if (accelerator != nullptr) {
    kept.Set("accelerator", accelerator->GetString());
  }
  if (icon != nullptr) {
    kept.Set("icon", icon->GetString());
  }
  if (submenu != nullptr) {
    base::ListValue entries;
    for (const base::Value& child : submenu->GetList()) {
      ASSIGN_OR_RETURN(base::DictValue kept_child, MenuEntry(child, depth + 1));
      entries.Append(std::move(kept_child));
    }
    kept.Set("submenu", std::move(entries));
  }
  return kept;
}

// A set_menu_bar request, or why it is not one.
base::expected<ElectronRequest, ElectronRefusal> ParseSetMenuBar(
    const base::DictValue& request,
    ElectronWindow window) {
  const base::Value* menu = request.Find("menu");
  const std::optional<bool> visible = request.FindBool("visible");
  const std::optional<bool> auto_hide = request.FindBool("auto_hide");
  if (menu == nullptr || !(menu->is_none() || menu->is_list())) {
    return Refuse("\"menu\" must be a list of entries, or null for none",
                  window);
  } else if (!visible.has_value() || !auto_hide.has_value()) {
    return Refuse("\"visible\" and \"auto_hide\" must be true or false",
                  window);
  }
  ElectronSetMenuBar set{
      .window = window, .visible = *visible, .auto_hide = *auto_hide};
  if (menu->is_list()) {
    base::expected<std::string, std::string> json =
        ElectronMenuJson(menu->GetList());
    if (!json.has_value()) {
      return Refuse(std::move(json.error()), window);
    }
    set.menu = std::move(*json);
  }
  return set;
}

// The Edit menu's commands, by their names on the wire.
constexpr std::pair<std::string_view, ElectronEditCommand> kEditCommands[] = {
    {"undo", ElectronEditCommand::kUndo},
    {"redo", ElectronEditCommand::kRedo},
    {"cut", ElectronEditCommand::kCut},
    {"copy", ElectronEditCommand::kCopy},
    {"paste", ElectronEditCommand::kPaste},
    {"paste_and_match_style", ElectronEditCommand::kPasteAndMatchStyle},
    {"delete", ElectronEditCommand::kDelete},
    {"select_all", ElectronEditCommand::kSelectAll},
    {"unselect", ElectronEditCommand::kUnselect},
    {"center_selection", ElectronEditCommand::kCenterSelection},
};

// An edit request, or why it is not one.
base::expected<ElectronRequest, ElectronRefusal> ParseEdit(
    const base::DictValue& request,
    ElectronWindow window) {
  const std::string* command = request.FindString("command");
  if (command != nullptr) {
    for (const auto& [name, value] : kEditCommands) {
      if (*command == name) {
        return ElectronEdit{.window = window, .command = value};
      }
    }
  }
  return Refuse(
      "\"command\" must be undo, redo, cut, copy, paste, "
      "paste_and_match_style, delete, select_all, unselect or "
      "center_selection",
      window);
}

// A find_in_page request, or why it is not one.
base::expected<ElectronRequest, ElectronRefusal> ParseFindInPage(
    const base::DictValue& request,
    ElectronWindow window) {
  const std::optional<int> number = request.FindInt("request");
  const std::string* text = request.FindString("text");
  const std::optional<bool> forward = request.FindBool("forward");
  const std::optional<bool> find_next = request.FindBool("find_next");
  const std::optional<bool> match_case = request.FindBool("match_case");
  if (!number.has_value() || *number < 1) {
    return Refuse("\"request\" must be a whole number from 1", window);
  } else if (text == nullptr || text->empty()) {
    return Refuse("\"text\" must be a string that is not empty", window);
  } else if (!forward.has_value() || !find_next.has_value() ||
             !match_case.has_value()) {
    return Refuse(
        "\"forward\", \"find_next\" and \"match_case\" must each be true "
        "or false",
        window);
  }
  return ElectronFindInPage{.window = window,
                            .request = *number,
                            .text = *text,
                            .forward = *forward,
                            .find_next = *find_next,
                            .match_case = *match_case};
}

// A stop_find_in_page request, or why it is not one.
base::expected<ElectronRequest, ElectronRefusal> ParseStopFindInPage(
    const base::DictValue& request,
    ElectronWindow window) {
  const std::string* action = request.FindString("action");
  if (action != nullptr && *action == "clear_selection") {
    return ElectronStopFindInPage{
        .window = window, .action = ElectronStopFindAction::kClearSelection};
  } else if (action != nullptr && *action == "keep_selection") {
    return ElectronStopFindInPage{
        .window = window, .action = ElectronStopFindAction::kKeepSelection};
  } else if (action != nullptr && *action == "activate_selection") {
    return ElectronStopFindInPage{
        .window = window, .action = ElectronStopFindAction::kActivateSelection};
  }
  return Refuse(
      "\"action\" must be clear_selection, keep_selection or "
      "activate_selection",
      window);
}

// A popup_menu request, or why it is not one.
base::expected<ElectronRequest, ElectronRefusal> ParsePopupMenu(
    const base::DictValue& request,
    ElectronWindow window) {
  const std::optional<int> popup = request.FindInt("popup");
  const base::ListValue* menu = request.FindList("menu");
  const base::Value* x = request.Find("x");
  const base::Value* y = request.Find("y");
  if (!popup.has_value() || *popup < 1) {
    return Refuse("\"popup\" must be a whole number from 1", window);
  } else if (menu == nullptr || menu->empty()) {
    return Refuse("\"menu\" must be a list of entries, not empty", window);
  } else if ((x == nullptr) != (y == nullptr) ||
             (x != nullptr && !(x->is_int() && y->is_int()))) {
    return Refuse(
        "\"x\" and \"y\" must both be whole numbers, or both be left out",
        window);
  }
  base::expected<std::string, std::string> json = ElectronMenuJson(*menu);
  if (!json.has_value()) {
    return Refuse(std::move(json.error()), window);
  }
  ElectronPopupMenu popped{
      .window = window, .popup = *popup, .menu = std::move(*json)};
  if (x != nullptr) {
    popped.x = x->GetInt();
    popped.y = y->GetInt();
  }
  return popped;
}

// A show_message_box request, or why it is not one.
base::expected<ElectronRequest, ElectronRefusal> ParseShowMessageBox(
    const base::DictValue& request,
    ElectronWindow window) {
  constexpr size_t kMostButtons = 16;
  const std::optional<int> box = request.FindInt("box");
  const std::string* type = request.FindString("box_type");
  const std::string* title = request.FindString("title");
  const std::string* message = request.FindString("message");
  const std::string* detail = request.FindString("detail");
  const base::ListValue* buttons = request.FindList("buttons");
  const std::optional<int> default_id = request.FindInt("default_id");
  const std::optional<int> cancel_id = request.FindInt("cancel_id");
  const std::string* checkbox_label = request.FindString("checkbox_label");
  const std::optional<bool> checkbox_checked =
      request.FindBool("checkbox_checked");
  if (!box.has_value() || *box < 1) {
    return Refuse("\"box\" must be a whole number from 1", window);
  } else if (type == nullptr ||
             (*type != "none" && *type != "info" && *type != "error" &&
              *type != "question" && *type != "warning")) {
    return Refuse("\"box_type\" must be none, info, error, question or warning",
                  window);
  } else if (title == nullptr || message == nullptr || detail == nullptr ||
             checkbox_label == nullptr) {
    return Refuse(
        "\"title\", \"message\", \"detail\" and \"checkbox_label\" must be "
        "strings",
        window);
  } else if (buttons == nullptr || buttons->empty() ||
             buttons->size() > kMostButtons ||
             !std::ranges::all_of(*buttons, &base::Value::is_string)) {
    return Refuse("\"buttons\" must be a list of 1 to 16 labels", window);
  }
  const int count = static_cast<int>(buttons->size());
  if (!default_id.has_value() || *default_id < -1 || *default_id >= count) {
    return Refuse(
        "\"default_id\" must be a button's index, or -1 for no default",
        window);
  } else if (!cancel_id.has_value() || *cancel_id < 0 || *cancel_id >= count) {
    return Refuse("\"cancel_id\" must be a button's index", window);
  } else if (!checkbox_checked.has_value()) {
    return Refuse("\"checkbox_checked\" must be true or false", window);
  }
  base::DictValue kept;
  kept.Set("type", *type);
  kept.Set("title", *title);
  kept.Set("message", *message);
  kept.Set("detail", *detail);
  kept.Set("buttons", buttons->Clone());
  kept.Set("defaultId", *default_id);
  kept.Set("cancelId", *cancel_id);
  kept.Set("checkboxLabel", *checkbox_label);
  kept.Set("checkboxChecked", *checkbox_checked);
  std::string json;
  CHECK(base::JSONWriter::Write(kept, &json));
  return ElectronShowMessageBox{.window = window,
                                .box = *box,
                                .message_box = std::move(json),
                                .buttons = count,
                                .cancel_id = *cancel_id};
}

// The "views" of a set_views request, or why they are not views.
base::expected<ElectronRequest, ElectronRefusal> ParseSetViews(
    const base::DictValue& request,
    ElectronWindow window) {
  const base::ListValue* views = request.FindList("views");
  if (views == nullptr) {
    return Refuse("\"views\" must be a list", window);
  }
  ElectronSetViews set{.window = window};
  for (const base::Value& entry : *views) {
    const base::DictValue* view = entry.GetIfDict();
    if (view == nullptr) {
      return Refuse("each of \"views\" must be an object", window);
    }
    const base::expected<ElectronWindow, std::string> number = WindowIn(*view);
    const std::optional<int> x = view->FindInt("x");
    const std::optional<int> y = view->FindInt("y");
    const std::optional<int> width = view->FindInt("width");
    const std::optional<int> height = view->FindInt("height");
    const base::Value* hidden = view->Find("hidden");
    if (!number.has_value()) {
      return Refuse(base::StrCat({"a view's ", number.error()}), window);
    } else if (!x.has_value() || !y.has_value()) {
      return Refuse("a view's \"x\" and \"y\" must be whole numbers", window);
    } else if (!width.has_value() || *width < 0 || !height.has_value() ||
               *height < 0) {
      return Refuse(
          "a view's \"width\" and \"height\" must be whole numbers from 0",
          window);
    } else if (hidden != nullptr && !hidden->is_bool()) {
      return Refuse("a view's \"hidden\" must be true or false", window);
    }
    set.views.push_back(ElectronViewPlacement{
        .view = *number,
        .x = *x,
        .y = *y,
        .width = *width,
        .height = *height,
        .hidden = hidden != nullptr && hidden->GetBool()});
  }
  return set;
}

// The "port" a port request names, or why it names none.
base::expected<std::string, std::string> PortIn(
    const base::DictValue& request) {
  const std::string* port = request.FindString("port");
  if (port == nullptr || !IsElectronPortName(*port)) {
    return base::unexpected(
        "\"port\" must name a port: \"m\" or \"r\", then a number");
  }
  return base::ok(*port);
}

base::expected<ElectronRequest, ElectronRefusal> ParsePostToPage(
    base::DictValue& request,
    ElectronWindow window) {
  const std::string* channel = request.FindString("channel");
  const base::ListValue* ports = request.FindList("ports");
  if (channel == nullptr) {
    return Refuse("\"channel\" must be a string", window);
  } else if (!request.contains("message")) {
    return Refuse("\"message\" is missing", window);
  }
  std::vector<std::string> names;
  if (ports != nullptr) {
    for (const base::Value& port : *ports) {
      // The main process posts only ports it made: the page's own are
      // already the page's.
      if (!port.is_string() || !IsElectronPortName(port.GetString()) ||
          port.GetString()[0] != 'm') {
        return Refuse(
            "\"ports\" must name the main process's own ports: \"m\", then "
            "a number",
            window);
      } else if (std::ranges::find(names, port.GetString()) != names.end()) {
        return Refuse("a port is posted once", window);
      }
      names.push_back(port.GetString());
    }
  } else if (request.contains("ports")) {
    return Refuse("\"ports\" must be an array", window);
  }
  return ElectronPostToPage{.window = window,
                            .channel = *channel,
                            .message = *request.Extract("message"),
                            .ports = std::move(names)};
}

base::expected<ElectronRequest, ElectronRefusal> ParsePortPost(
    base::DictValue& request,
    ElectronWindow window) {
  base::expected<std::string, std::string> port = PortIn(request);
  if (!port.has_value()) {
    return Refuse(std::move(port.error()), window);
  } else if (!request.contains("data")) {
    return Refuse("\"data\" is missing", window);
  }
  return ElectronPortPost{.window = window,
                          .port = std::move(*port),
                          .data = *request.Extract("data")};
}

base::expected<ElectronRequest, ElectronRefusal> ParseReply(
    base::DictValue& request) {
  const std::optional<int> invoke = request.FindInt("invoke");
  if (!invoke.has_value() || *invoke < 1) {
    return Refuse("\"invoke\" must be a whole number from 1");
  }
  if (const base::Value* error = request.Find("error")) {
    if (!error->is_string()) {
      return Refuse("\"error\" must be a string");
    } else if (request.contains("result")) {
      return Refuse("a reply has a \"result\" or an \"error\", not both");
    }
    return ElectronReply{.invoke = *invoke,
                         .answer = base::unexpected(error->GetString())};
  }
  // A handler that returns nothing answers null, as JSON has no undefined.
  std::optional<base::Value> result = request.Extract("result");
  return ElectronReply{
      .invoke = *invoke,
      .answer = result.has_value() ? std::move(*result) : base::Value()};
}

base::expected<ElectronRequest, ElectronRefusal> ParseExecuteJavaScript(
    const base::DictValue& request,
    ElectronWindow window) {
  const std::optional<int> call = request.FindInt("call");
  const std::string* code = request.FindString("code");
  const base::Value* user_gesture = request.Find("user_gesture");
  if (!call.has_value() || *call < 1) {
    return Refuse("\"call\" must be a whole number from 1", window);
  } else if (code == nullptr) {
    return Refuse("\"code\" must be a string", window);
  } else if (user_gesture != nullptr && !user_gesture->is_bool()) {
    return Refuse("\"user_gesture\" must be true or false", window);
  }
  return ElectronExecuteJavaScript{
      .window = window,
      .call = *call,
      .code = *code,
      .user_gesture = user_gesture != nullptr && user_gesture->GetBool()};
}

base::expected<ElectronRequest, ElectronRefusal> ParseSendToPage(
    base::DictValue& request,
    ElectronWindow window) {
  const std::string* channel = request.FindString("channel");
  base::ListValue* args = request.FindList("args");
  if (channel == nullptr) {
    return Refuse("\"channel\" must be a string", window);
  } else if (args == nullptr) {
    return Refuse("\"args\" must be an array", window);
  }
  return ElectronSendToPage{
      .window = window, .channel = *channel, .args = std::move(*args)};
}

std::string WithChannel(base::DictValue event,
                        std::string_view channel,
                        const base::ListValue& args) {
  event.Set("channel", channel);
  event.Set("args", args.Clone());
  std::string line;
  // From a page's JSON.stringify, so it writes.
  CHECK(base::JSONWriter::Write(event, &line));
  line.push_back('\n');
  return line;
}

std::string Written(base::DictValue event) {
  std::string line;
  // Its values came from JSON, the page's or the app's, so it writes.
  CHECK(base::JSONWriter::Write(event, &line));
  line.push_back('\n');
  return line;
}

constexpr std::string_view kElectronStorages[] = {
    "cookies",     "filesystem", "indexdb",        "localstorage",
    "shadercache", "websql",     "serviceworkers", "cachestorage",
};

constexpr std::string_view kSameSites[] = {"unspecified", "no_restriction",
                                           "lax", "strict"};

base::expected<ElectronRequest, ElectronRefusal> ParsePageCall(
    base::DictValue& request) {
  const base::expected<ElectronWindow, std::string> window = WindowIn(request);
  if (!window.has_value()) {
    return Refuse(window.error());
  }
  const std::optional<int> call = request.FindInt("call");
  if (!call.has_value() || *call < 1) {
    return Refuse("\"call\" must be a whole number from 1", *window);
  }
  const std::string* name = request.FindString("method");
  if (name == nullptr) {
    return base::unexpected(
        ElectronRefusal{.why = "\"method\" must be a string",
                        .window = *window,
                        .page_call = *call});
  }
  base::expected<ElectronPageMethod, std::string> method =
      ElectronPageMethodIn(*name, request);
  if (!method.has_value()) {
    return base::unexpected(ElectronRefusal{.why = std::move(method.error()),
                                            .window = *window,
                                            .page_call = *call});
  }
  return ElectronPageCall{
      .window = *window, .call = *call, .method = std::move(*method)};
}

base::expected<ElectronRequest, ElectronRefusal> RefuseCall(std::string why,
                                                            int call) {
  return base::unexpected(ElectronRefusal{.why = std::move(why), .call = call});
}

base::expected<std::optional<std::string>, std::string> OptionalStringIn(
    const base::DictValue& dict,
    std::string_view key) {
  const base::Value* value = dict.Find(key);
  if (value == nullptr) {
    return std::nullopt;
  } else if (!value->is_string()) {
    return base::unexpected(base::StrCat({"\"", key, "\" must be a string"}));
  }
  return std::optional(value->GetString());
}

base::expected<std::optional<bool>, std::string> OptionalBoolIn(
    const base::DictValue& dict,
    std::string_view key) {
  const base::Value* value = dict.Find(key);
  if (value == nullptr) {
    return std::nullopt;
  } else if (!value->is_bool()) {
    return base::unexpected(
        base::StrCat({"\"", key, "\" must be true or false"}));
  }
  return std::optional(value->GetBool());
}

base::expected<std::optional<GURL>, std::string> OptionalUrlIn(
    const base::DictValue& dict,
    std::string_view key) {
  ASSIGN_OR_RETURN(std::optional<std::string> text,
                   OptionalStringIn(dict, key));
  if (!text.has_value()) {
    return std::nullopt;
  }
  GURL url(*text);
  if (!url.is_valid()) {
    return base::unexpected(base::StrCat({"\"", key, "\" must be a URL"}));
  }
  return std::optional(std::move(url));
}

base::expected<GURL, std::string> RequiredUrlIn(const base::DictValue& dict) {
  ASSIGN_OR_RETURN(std::optional<GURL> url, OptionalUrlIn(dict, "url"));
  if (!url.has_value()) {
    return base::unexpected("\"url\" must be a string");
  }
  return std::move(*url);
}

base::expected<ElectronSessionMethod, std::string> GetCookiesIn(
    const base::DictValue& request) {
  const base::Value* found = request.Find("filter");
  if (found == nullptr) {
    return ElectronGetCookies{};
  } else if (!found->is_dict()) {
    return base::unexpected("\"filter\" must be an object");
  }
  const base::DictValue& filter = found->GetDict();
  ElectronCookieFilter parsed;
  ASSIGN_OR_RETURN(parsed.url, OptionalUrlIn(filter, "url"));
  ASSIGN_OR_RETURN(parsed.name, OptionalStringIn(filter, "name"));
  ASSIGN_OR_RETURN(parsed.domain, OptionalStringIn(filter, "domain"));
  ASSIGN_OR_RETURN(parsed.path, OptionalStringIn(filter, "path"));
  ASSIGN_OR_RETURN(parsed.secure, OptionalBoolIn(filter, "secure"));
  ASSIGN_OR_RETURN(parsed.session, OptionalBoolIn(filter, "session"));
  ASSIGN_OR_RETURN(parsed.http_only, OptionalBoolIn(filter, "http_only"));
  return ElectronGetCookies{.filter = std::move(parsed)};
}

base::expected<ElectronSessionMethod, std::string> SetCookieIn(
    const base::DictValue& request) {
  const base::DictValue* details = request.FindDict("details");
  if (details == nullptr) {
    return base::unexpected("\"details\" must be an object");
  }
  ElectronCookieDetails parsed;
  ASSIGN_OR_RETURN(parsed.url, RequiredUrlIn(*details));
  ASSIGN_OR_RETURN(std::optional<std::string> name,
                   OptionalStringIn(*details, "name"));
  parsed.name = name.value_or("");
  ASSIGN_OR_RETURN(std::optional<std::string> value,
                   OptionalStringIn(*details, "value"));
  parsed.value = value.value_or("");
  ASSIGN_OR_RETURN(parsed.domain, OptionalStringIn(*details, "domain"));
  ASSIGN_OR_RETURN(parsed.path, OptionalStringIn(*details, "path"));
  ASSIGN_OR_RETURN(std::optional<bool> secure,
                   OptionalBoolIn(*details, "secure"));
  parsed.secure = secure.value_or(false);
  ASSIGN_OR_RETURN(std::optional<bool> http_only,
                   OptionalBoolIn(*details, "http_only"));
  parsed.http_only = http_only.value_or(false);
  if (const base::Value* expires = details->Find("expiration_date")) {
    if (!expires->is_int() && !expires->is_double()) {
      return base::unexpected("\"expiration_date\" must be a number");
    }
    parsed.expiration_date = expires->GetDouble();
  }
  ASSIGN_OR_RETURN(std::optional<std::string> same_site,
                   OptionalStringIn(*details, "same_site"));
  if (same_site.has_value()) {
    if (std::ranges::find(kSameSites, *same_site) == std::end(kSameSites)) {
      return base::unexpected(
          "\"same_site\" must be unspecified, no_restriction, lax or strict");
    }
    parsed.same_site = std::move(*same_site);
  }
  return ElectronSetCookie{.details = std::move(parsed)};
}

base::expected<ElectronSessionMethod, std::string> RemoveCookieIn(
    const base::DictValue& request) {
  ASSIGN_OR_RETURN(GURL url, RequiredUrlIn(request));
  const std::string* name = request.FindString("name");
  if (name == nullptr) {
    return base::unexpected("\"name\" must be a string");
  }
  return ElectronRemoveCookie{.url = std::move(url), .name = *name};
}

base::expected<ElectronSessionMethod, std::string> ClearStorageIn(
    const base::DictValue& request) {
  ElectronClearStorage clear;
  ASSIGN_OR_RETURN(clear.origin, OptionalUrlIn(request, "origin"));
  if (const base::Value* storages = request.Find("storages")) {
    if (!storages->is_list()) {
      return base::unexpected("\"storages\" must be an array");
    }
    for (const base::Value& storage : storages->GetList()) {
      if (!storage.is_string()) {
        return base::unexpected("\"storages\" must hold strings");
      } else if (!IsElectronStorage(storage.GetString())) {
        return base::unexpected(
            base::StrCat({"\"", storage.GetString(),
                          "\" is not a storage clearStorageData knows"}));
      }
      clear.storages.insert(storage.GetString());
    }
  }
  return clear;
}

base::expected<ElectronSessionMethod, std::string> SessionMethodIn(
    std::string_view method,
    const base::DictValue& request) {
  if (method == "cookies_get") {
    return GetCookiesIn(request);
  } else if (method == "cookies_set") {
    return SetCookieIn(request);
  } else if (method == "cookies_remove") {
    return RemoveCookieIn(request);
  } else if (method == "cookies_flush") {
    return ElectronFlushCookies{};
  } else if (method == "cookies_watch") {
    return ElectronWatchCookies{};
  } else if (method == "clear_storage_data") {
    return ClearStorageIn(request);
  } else if (method == "clear_cache") {
    return ElectronClearCache{};
  } else if (method == "set_user_agent") {
    const std::string* agent = request.FindString("user_agent");
    if (agent == nullptr) {
      return base::unexpected("\"user_agent\" must be a string");
    }
    return ElectronSetUserAgent{.user_agent = *agent};
  } else if (method == "service_workers_watch") {
    return ElectronWatchServiceWorkers{};
  } else if (std::optional<base::expected<ElectronNetworkCall, std::string>>
                 network = ParseElectronNetworkCall(method, request)) {
    return std::move(*network).transform(
        [](ElectronNetworkCall call) -> ElectronSessionMethod {
          return call;
        });
  }
  return base::unexpected(base::StrCat({"no session call is named ", method}));
}

base::expected<ElectronRequest, ElectronRefusal> ParseSessionCall(
    const base::DictValue& request) {
  const std::optional<int> call = request.FindInt("call");
  if (!call.has_value() || *call < 1) {
    return Refuse("\"call\" must be a whole number from 1");
  }
  base::expected<std::string, std::string> session =
      SessionIn(request, /*optional=*/false);
  if (!session.has_value()) {
    return RefuseCall(std::move(session.error()), *call);
  }
  const std::string* method = request.FindString("method");
  if (method == nullptr) {
    return RefuseCall("\"method\" must be a string", *call);
  }
  base::expected<ElectronSessionMethod, std::string> parsed =
      SessionMethodIn(*method, request);
  if (!parsed.has_value()) {
    return RefuseCall(std::move(parsed.error()), *call);
  }
  return ElectronSessionCall{.call = *call,
                             .session = std::move(*session),
                             .method = std::move(*parsed)};
}

}  // namespace

base::expected<WebViewPartition, std::string> ElectronSessionPartition(
    const WebViewPartition& app,
    std::string_view session) {
  base::expected<std::optional<WebViewPartition>, std::string> parsed =
      ParseWebViewPartition(session);
  if (!parsed.has_value()) {
    return base::unexpected(std::move(parsed.error()));
  } else if (!parsed->has_value()) {
    return app;
  }
  // ":" keeps a session's name apart from the app's own and from any other
  // app's, whose names never hold one.
  return WebViewPartition{
      .name = base::StrCat({app.name, ":", (*parsed)->name}),
      .persist = (*parsed)->persist};
}

bool IsElectronPortName(std::string_view name) {
  // Short enough that no count reaches it, and a name is never a number
  // that overflows anything that reads it.
  return name.size() >= 2 && name.size() <= 16 &&
         (name[0] == 'm' || name[0] == 'r') &&
         std::ranges::all_of(name.substr(1), base::IsAsciiDigit<char>);
}

namespace {

// The keys of `open_window`, for window `window` at `url`, in `request`: an
// open_window's own, or a window_open_answer that allows the window.
base::expected<ElectronRequest, ElectronRefusal> ParseOpenWindow(
    const base::DictValue& request,
    ElectronWindow window,
    GURL url) {
  const base::Value* preload = request.Find("preload");
  const base::Value* view = request.Find("view");
  const base::Value* title = request.Find("title");
  const base::Value* hidden = request.Find("hidden");
  const base::Value* node = request.Find("node");
  const base::Value* arguments = request.Find("arguments");
  const base::Value* user_agent = request.Find("user_agent");
  base::expected<std::string, std::string> session =
      SessionIn(request, /*optional=*/true);
  std::optional<base::expected<ElectronNode, std::string>> node_in;
  if (node != nullptr) {
    node_in = NodeIn(*node);
  }
  std::vector<std::string> arguments_in;
  if (arguments != nullptr && arguments->is_list()) {
    for (const base::Value& argument : arguments->GetList()) {
      if (!argument.is_string()) {
        return Refuse("\"arguments\" must be a list of strings", window);
      }
      arguments_in.push_back(argument.GetString());
    }
  }
  if (preload != nullptr && !preload->is_string()) {
    return Refuse("\"preload\" must be a string", window);
  } else if (arguments != nullptr && !arguments->is_list()) {
    return Refuse("\"arguments\" must be a list of strings", window);
  } else if (node_in.has_value() && !node_in->has_value()) {
    return Refuse(std::move(node_in->error()), window);
  } else if (node != nullptr && preload != nullptr) {
    return Refuse(
        "a page with Node.js loads its preload from a file, "
        "\"node\"'s \"preload\", not from \"preload\"",
        window);
  } else if (view != nullptr && !view->is_bool()) {
    return Refuse("\"view\" must be true or false", window);
  } else if (title != nullptr && !title->is_string()) {
    return Refuse("\"title\" must be a string", window);
  } else if (hidden != nullptr && !hidden->is_bool()) {
    return Refuse("\"hidden\" must be true or false", window);
  } else if (view != nullptr && view->GetBool() &&
             (title != nullptr || hidden != nullptr)) {
    return Refuse(
        "a view has no title or hidden of its own: its window has them",
        window);
  } else if (user_agent != nullptr && !user_agent->is_string()) {
    return Refuse("\"user_agent\" must be a string", window);
  } else if (!session.has_value()) {
    return Refuse(std::move(session.error()), window);
  }
  return ElectronOpenWindow{
      .window = window,
      .url = std::move(url),
      .preload = preload ? preload->GetString() : std::string(),
      .node = node_in.has_value()
                  ? std::optional<ElectronNode>(std::move(**node_in))
                  : std::nullopt,
      .arguments = std::move(arguments_in),
      .session = std::move(*session),
      .view = view != nullptr && view->GetBool(),
      .title = title ? title->GetString() : std::string(),
      .hidden = hidden != nullptr && hidden->GetBool(),
      .user_agent = user_agent ? user_agent->GetString() : std::string()};
}

// One of electron_page_reports.h's requests of a window's page.
base::expected<ElectronRequest, ElectronRefusal> ParsePageRequest(
    std::string_view type,
    const base::DictValue& request) {
  const base::expected<ElectronWindow, std::string> window = WindowIn(request);
  if (!window.has_value()) {
    return Refuse(window.error());
  }
  base::expected<ElectronPageAction, std::string> action =
      ParseElectronPageAction(type, request);
  if (!action.has_value()) {
    return Refuse(std::move(action.error()), *window);
  }
  return ElectronPageRequest{.window = *window, .action = std::move(*action)};
}

// An open_window's "history", in which the page shows `url`.
base::expected<ElectronHistory, std::string> HistoryIn(
    const base::Value& history,
    const GURL& url) {
  constexpr char kShape[] =
      "\"history\" must be an object with \"entries\", a list of "
      "{\"url\", \"title\"}, and \"index\", the entry shown";
  if (!history.is_dict()) {
    return base::unexpected(std::string(kShape));
  }
  const base::ListValue* entries = history.GetDict().FindList("entries");
  const std::optional<int> index = history.GetDict().FindInt("index");
  if (entries == nullptr || entries->empty() || !index.has_value()) {
    return base::unexpected(std::string(kShape));
  }
  ElectronHistory made{.index = *index};
  for (const base::Value& entry : *entries) {
    if (!entry.is_dict() || entry.GetDict().FindString("title") == nullptr) {
      return base::unexpected(std::string(kShape));
    }
    ASSIGN_OR_RETURN(GURL entry_url, UrlIn(entry.GetDict()));
    made.entries.push_back({.url = std::move(entry_url),
                            .title = *entry.GetDict().FindString("title")});
  }
  if (made.index < 0 || made.index >= static_cast<int>(made.entries.size())) {
    return base::unexpected(
        "\"history\"'s \"index\" must be one of its entries");
  } else if (made.entries[made.index].url != url) {
    return base::unexpected(
        "\"url\" must be the address of the history's entry \"index\"");
  }
  return made;
}

// The app's answer to will_navigate `ask`.
base::expected<ElectronRequest, ElectronRefusal> ParseNavigationAnswer(
    const base::DictValue& request) {
  const std::optional<int> ask = request.FindInt("ask");
  const std::optional<bool> proceed = request.FindBool("proceed");
  if (!ask.has_value() || *ask < 1) {
    return Refuse("\"ask\" must be a whole number from 1");
  } else if (!proceed.has_value()) {
    return Refuse("\"proceed\" must be true or false");
  }
  return ElectronNavigationAnswer{.ask = *ask, .proceed = *proceed};
}

// The app's answer to will_prevent_unload `ask`.
base::expected<ElectronRequest, ElectronRefusal> ParseUnloadAnswer(
    const base::DictValue& request) {
  const std::optional<int> ask = request.FindInt("ask");
  const std::optional<bool> unload = request.FindBool("unload");
  if (!ask.has_value() || *ask < 1) {
    return Refuse("\"ask\" must be a whole number from 1");
  } else if (!unload.has_value()) {
    return Refuse("\"unload\" must be true or false");
  }
  return ElectronUnloadAnswer{.ask = *ask, .unload = *unload};
}

// The app's answer to window_open `ask`: "deny", or "allow" with the window's
// number and open_window's other keys. The window opens at the address the
// page asked for, so the answer names none.
base::expected<ElectronRequest, ElectronRefusal> ParseWindowOpenAnswer(
    const base::DictValue& request) {
  const std::optional<int> ask = request.FindInt("ask");
  const std::string* action = request.FindString("action");
  if (!ask.has_value() || *ask < 1) {
    return Refuse("\"ask\" must be a whole number from 1");
  } else if (action == nullptr || (*action != "allow" && *action != "deny")) {
    return Refuse("\"action\" must be \"allow\" or \"deny\"");
  } else if (*action == "deny") {
    return ElectronWindowOpenAnswer{.ask = *ask};
  } else if (request.Find("url") != nullptr ||
             request.Find("history") != nullptr) {
    return Refuse(
        "a window_open_answer names no \"url\" or \"history\": the window "
        "opens where its page asked");
  }
  const base::expected<ElectronWindow, std::string> window = WindowIn(request);
  if (!window.has_value()) {
    return Refuse(window.error());
  }
  const base::Value* view = request.Find("view");
  if (view != nullptr && view->is_bool() && view->GetBool()) {
    return Refuse("a page's new window is a window, not a view", *window);
  }
  base::expected<ElectronRequest, ElectronRefusal> open =
      ParseOpenWindow(request, *window, GURL());
  if (!open.has_value()) {
    return open;
  }
  return ElectronWindowOpenAnswer{
      .ask = *ask, .open = std::get<ElectronOpenWindow>(std::move(*open))};
}

}  // namespace

base::expected<ElectronRequest, ElectronRefusal> ParseElectronRequest(
    std::string_view line) {
  std::optional<base::DictValue> request =
      base::JSONReader::ReadDict(line, base::JSON_PARSE_RFC);
  if (!request.has_value()) {
    return Refuse("a request must be a JSON object");
  }
  const std::string* type = request->FindString("type");
  if (type == nullptr) {
    return Refuse("a request must have a \"type\"");
  } else if (*type == "hello") {
    return ParseHello(*request).transform_error(
        [](std::string why) { return ElectronRefusal{.why = std::move(why)}; });
  } else if (*type == "ipc_reply") {
    return ParseReply(*request);
  } else if (*type == "handle_protocol" || *type == "unhandle_protocol") {
    return ParseHandleProtocol(*request, *type == "handle_protocol");
  } else if (*type == "protocol_response" || *type == "protocol_data" ||
             *type == "protocol_end") {
    return ParseProtocolAnswer(*type, *request);
  } else if (*type == "web_request_listen") {
    return ParseWebRequestListen(*request);
  } else if (*type == "web_request_answer") {
    return ParseWebRequestAnswer(*request);
  } else if (*type == "session_call") {
    return ParseSessionCall(*request);
  } else if (*type == "page_call") {
    return ParsePageCall(*request);
  } else if (*type == "permission_handler") {
    return ParsePermissionHandler(*request);
  } else if (*type == "permission_answer") {
    return ParsePermissionAnswer(*request);
  } else if (*type == "download_answer") {
    return ParseDownloadAnswer(*request);
  } else if (*type == "download_control") {
    return ParseDownloadControl(*request);
  } else if (*type == "window_open_answer") {
    return ParseWindowOpenAnswer(*request);
  } else if (*type == "navigation_answer") {
    return ParseNavigationAnswer(*request);
  } else if (*type == "unload_answer") {
    return ParseUnloadAnswer(*request);
  } else if (IsElectronSignInReply(*type)) {
    base::expected<ElectronSignInReply, std::string> reply =
        ParseElectronSignInReply(*type, *request);
    if (!reply.has_value()) {
      return Refuse(std::move(reply.error()));
    }
    return std::move(*reply);
  } else if (*type == "set_user_agent_fallback") {
    const std::string* user_agent = request->FindString("user_agent");
    if (user_agent == nullptr) {
      return Refuse("\"user_agent\" must be a string");
    }
    return ElectronSetUserAgentFallback{.user_agent = *user_agent};
  } else if (IsElectronPageRequest(*type)) {
    return ParsePageRequest(*type, *request);
  } else if (!IsWindowRequest(*type)) {
    return Refuse(base::StrCat({"no request is named ", *type}));
  }
  const base::expected<ElectronWindow, std::string> window = WindowIn(*request);
  if (!window.has_value()) {
    return Refuse(window.error());
  } else if (*type == "open_window" || *type == "load_url") {
    base::expected<GURL, std::string> url = UrlIn(*request);
    if (!url.has_value()) {
      return Refuse(std::move(url.error()), *window);
    } else if (*type == "open_window") {
      const base::Value* history = request->Find("history");
      if (history == nullptr) {
        return ParseOpenWindow(*request, *window, std::move(*url));
      }
      base::expected<ElectronHistory, std::string> history_in =
          HistoryIn(*history, *url);
      if (!history_in.has_value()) {
        return Refuse(std::move(history_in.error()), *window);
      }
      base::expected<ElectronRequest, ElectronRefusal> open =
          ParseOpenWindow(*request, *window, std::move(*url));
      if (open.has_value()) {
        std::get<ElectronOpenWindow>(*open).history = std::move(*history_in);
      }
      return open;
    } else {
      return ElectronLoadUrl{.window = *window, .url = std::move(*url)};
    }
  } else if (*type == "set_views") {
    return ParseSetViews(*request, *window);
  } else if (*type == "set_menu_bar") {
    return ParseSetMenuBar(*request, *window);
  } else if (*type == "show_message_box") {
    return ParseShowMessageBox(*request, *window);
  } else if (*type == "popup_menu") {
    return ParsePopupMenu(*request, *window);
  } else if (*type == "close_popup_menu") {
    const std::optional<int> popup = request->FindInt("popup");
    if (!popup.has_value() || *popup < 1) {
      return Refuse("\"popup\" must be a whole number from 1", *window);
    }
    return ElectronClosePopupMenu{.window = *window, .popup = *popup};
  } else if (*type == "focus_window") {
    return ElectronFocusWindow{.window = *window};
  } else if (*type == "go_to_index") {
    const std::optional<int> index = request->FindInt("index");
    if (!index.has_value() || *index < 0) {
      return Refuse("\"index\" must be a whole number from 0", *window);
    }
    return ElectronGoToIndex{.window = *window, .index = *index};
  } else if (*type == "clear_history") {
    return ElectronClearHistory{.window = *window};
  } else if (*type == "remove_history_entry") {
    const std::optional<int> index = request->FindInt("index");
    if (!index.has_value() || *index < 0) {
      return Refuse("\"index\" must be a whole number from 0", *window);
    }
    return ElectronRemoveHistoryEntry{.window = *window, .index = *index};
  } else if (*type == "navigation_listen") {
    const std::optional<bool> listening = request->FindBool("listening");
    if (!listening.has_value()) {
      return Refuse("\"listening\" must be true or false", *window);
    }
    return ElectronNavigationListen{.window = *window, .listening = *listening};
  } else if (*type == "edit") {
    return ParseEdit(*request, *window);
  } else if (*type == "replace") {
    const std::string* text = request->FindString("text");
    const std::optional<bool> misspelling = request->FindBool("misspelling");
    if (text == nullptr) {
      return Refuse("\"text\" must be a string", *window);
    } else if (!misspelling.has_value()) {
      return Refuse("\"misspelling\" must be true or false", *window);
    }
    return ElectronReplace{
        .window = *window, .text = *text, .misspelling = *misspelling};
  } else if (*type == "find_in_page") {
    return ParseFindInPage(*request, *window);
  } else if (*type == "stop_find_in_page") {
    return ParseStopFindInPage(*request, *window);
  } else if (*type == "close_window") {
    return ElectronCloseWindow{.window = *window};
  } else if (*type == "set_title") {
    const std::string* title = request->FindString("title");
    if (title == nullptr) {
      return Refuse("\"title\" must be a string", *window);
    }
    return ElectronSetTitle{.window = *window, .title = *title};
  } else if (*type == "set_hidden") {
    const std::optional<bool> hidden = request->FindBool("hidden");
    if (!hidden.has_value()) {
      return Refuse("\"hidden\" must be true or false", *window);
    }
    return ElectronSetHidden{.window = *window, .hidden = *hidden};
  } else if (*type == "set_window_state") {
    const std::optional<bool> maximized = request->FindBool("maximized");
    const std::optional<bool> minimized = request->FindBool("minimized");
    const std::optional<bool> fullscreen = request->FindBool("fullscreen");
    if (!maximized.has_value() || !minimized.has_value() ||
        !fullscreen.has_value()) {
      return Refuse(
          "\"maximized\", \"minimized\" and \"fullscreen\" must each be "
          "true or false",
          *window);
    }
    return ElectronSetWindowState{.window = *window,
                                  .state = {.maximized = *maximized,
                                            .minimized = *minimized,
                                            .fullscreen = *fullscreen}};
  } else if (*type == "ipc_send") {
    return ParseSendToPage(*request, *window);
  } else if (*type == "execute_javascript") {
    return ParseExecuteJavaScript(*request, *window);
  } else if (*type == "ipc_post") {
    return ParsePostToPage(*request, *window);
  } else if (*type == "port_post") {
    return ParsePortPost(*request, *window);
  } else if (*type == "port_close") {
    base::expected<std::string, std::string> port = PortIn(*request);
    if (!port.has_value()) {
      return Refuse(std::move(port.error()), *window);
    }
    return ElectronPortClose{.window = *window, .port = std::move(*port)};
  } else {
    CHECK_EQ(*type, "destroy_window");
    return ElectronDestroyWindow{.window = *window};
  }
}

std::string_view ElectronWebRequestEventName(ElectronWebRequestEvent event) {
  const auto* found = std::ranges::find(
      kWebRequestEvents, event,
      &std::pair<ElectronWebRequestEvent, std::string_view>::first);
  CHECK(found != std::end(kWebRequestEvents));
  return found->second;
}

bool IsBlockingElectronWebRequestEvent(ElectronWebRequestEvent event) {
  return event == ElectronWebRequestEvent::kBeforeRequest ||
         event == ElectronWebRequestEvent::kBeforeSendHeaders ||
         event == ElectronWebRequestEvent::kHeadersReceived;
}

std::string ElectronWebRequest(ElectronWebRequestEvent event,
                               std::optional<int> ask,
                               std::optional<ElectronWindow> window,
                               std::string_view session,
                               const ElectronWebRequestDetails& details) {
  base::DictValue line;
  line.Set("type", "web_request");
  line.Set("event", ElectronWebRequestEventName(event));
  if (ask.has_value()) {
    line.Set("ask", *ask);
  }
  if (window.has_value()) {
    line.Set("window", *window);
  }
  line.Set("session", session);
  line.Set("id", details.id);
  line.Set("url", details.url.spec());
  line.Set("method", details.method);
  line.Set("resource_type", details.resource_type);
  line.Set("referrer", details.referrer);
  if (details.request_headers.has_value()) {
    line.Set("request_headers", HeadersList(*details.request_headers));
  }
  if (details.response_headers.has_value()) {
    line.Set("response_headers", HeadersList(*details.response_headers));
  }
  if (details.status_code.has_value()) {
    line.Set("status_code", *details.status_code);
  }
  if (details.status_line.has_value()) {
    line.Set("status_line", *details.status_line);
  }
  if (details.redirect_url.has_value()) {
    line.Set("redirect_url", details.redirect_url->spec());
  }
  if (details.error.has_value()) {
    line.Set("error", *details.error);
  }
  if (details.from_cache) {
    line.Set("from_cache", true);
  }
  if (details.ip.has_value()) {
    line.Set("ip", *details.ip);
  }
  // The loader made every string UTF-8.
  return Line(std::move(line));
}

std::string ElectronWindowOpen(int ask,
                               ElectronWindow window,
                               const ElectronWindowOpenDetails& details) {
  base::DictValue line;
  line.Set("type", "window_open");
  line.Set("ask", ask);
  line.Set("window", window);
  line.Set("url", details.url.possibly_invalid_spec());
  line.Set("frame_name", details.frame_name);
  line.Set("features", details.features);
  line.Set("disposition", details.disposition);
  line.Set("referrer", details.referrer.possibly_invalid_spec());
  return Line(std::move(line));
}

namespace {

base::DictValue FrameValue(const ElectronFrame& frame) {
  return base::DictValue()
      .Set("process", frame.process)
      .Set("routing", frame.routing);
}

// `navigation`'s keys, on `event`.
base::DictValue WithNavigation(base::DictValue event,
                               const ElectronNavigation& navigation) {
  event.Set("url", navigation.url.possibly_invalid_spec());
  event.Set("same_document", navigation.same_document);
  event.Set("main_frame", navigation.main_frame);
  if (navigation.frame.has_value()) {
    event.Set("frame", FrameValue(*navigation.frame));
  }
  if (navigation.initiator.has_value()) {
    event.Set("initiator", FrameValue(*navigation.initiator));
  }
  return event;
}

}  // namespace

std::string ElectronNavigationStarted(ElectronWindow window,
                                      const ElectronNavigation& navigation) {
  return Line(WithNavigation(Event("navigation_started", window), navigation));
}

std::string ElectronNavigationRedirected(ElectronWindow window,
                                         const ElectronNavigation& navigation) {
  return Line(
      WithNavigation(Event("navigation_redirected", window), navigation));
}

std::string ElectronNavigationCommitted(
    ElectronWindow window,
    const ElectronNavigationCommit& commit) {
  base::DictValue event =
      WithNavigation(Event("navigation_committed", window), commit.navigation);
  event.Set("http_response_code", commit.http_response_code);
  event.Set("http_status_text", commit.http_status_text);
  return Line(std::move(event));
}

std::string ElectronLoadFailed(ElectronWindow window,
                               const ElectronLoadFailure& failure) {
  base::DictValue event = Event("load_failed", window);
  event.Set("url", failure.url.possibly_invalid_spec());
  event.Set("main_frame", failure.main_frame);
  if (failure.frame.has_value()) {
    event.Set("frame", FrameValue(*failure.frame));
  }
  event.Set("error_code", failure.error_code);
  event.Set("error_description", failure.error_description);
  event.Set("provisional", failure.provisional);
  return Line(std::move(event));
}

std::string ElectronFrameLoaded(ElectronWindow window,
                                const ElectronFrame& frame) {
  base::DictValue event = Event("frame_loaded", window);
  event.Set("frame", FrameValue(frame));
  return Line(std::move(event));
}

std::string ElectronFrameCreated(ElectronWindow window,
                                 const ElectronFrame& frame,
                                 bool main_frame) {
  base::DictValue event = Event("frame_created", window);
  event.Set("frame", FrameValue(frame));
  event.Set("main_frame", main_frame);
  return Line(std::move(event));
}

std::string ElectronWillNavigate(int ask,
                                 ElectronWindow window,
                                 const ElectronNavigation& navigation,
                                 bool redirect) {
  base::DictValue event =
      WithNavigation(Event("will_navigate", window), navigation);
  event.Set("ask", ask);
  event.Set("redirect", redirect);
  return Line(std::move(event));
}

std::string ElectronWillPreventUnload(int ask, ElectronWindow window) {
  base::DictValue event = Event("will_prevent_unload", window);
  event.Set("ask", ask);
  return Line(std::move(event));
}

std::string ElectronPermissionRequest(
    int ask,
    std::optional<ElectronWindow> window,
    std::string_view session,
    const ElectronPermissionDetails& details) {
  base::DictValue line;
  line.Set("type", "permission_request");
  line.Set("ask", ask);
  if (window.has_value()) {
    line.Set("window", *window);
  }
  line.Set("session", session);
  line.Set("permission", details.permission);
  line.Set("requesting_url", details.requesting_url.spec());
  if (!details.media_types.empty()) {
    base::ListValue types;
    for (const std::string& type : details.media_types) {
      types.Append(type);
    }
    line.Set("media_types", std::move(types));
  }
  return Line(std::move(line));
}

std::string ElectronWillDownload(int download,
                                 std::optional<ElectronWindow> window,
                                 std::string_view session,
                                 const ElectronDownloadDetails& details) {
  base::DictValue line;
  line.Set("type", "will_download");
  line.Set("download", download);
  if (window.has_value()) {
    line.Set("window", *window);
  }
  line.Set("session", session);
  line.Set("url", details.url.possibly_invalid_spec());
  base::ListValue chain;
  for (const GURL& url : details.url_chain) {
    chain.Append(url.possibly_invalid_spec());
  }
  line.Set("url_chain", std::move(chain));
  line.Set("filename", details.filename);
  line.Set("mime_type", details.mime_type);
  // A double: a size may not fit an int.
  line.Set("total_bytes", static_cast<double>(details.total_bytes));
  line.Set("content_disposition", details.content_disposition);
  line.Set("has_user_gesture", details.has_user_gesture);
  line.Set("start_time", details.start_time);
  line.Set("etag", details.etag);
  line.Set("last_modified", details.last_modified);
  line.Set("initiator_origin", details.initiator_origin);
  return Line(std::move(line));
}

std::string ElectronDownloadUpdated(int download,
                                    const ElectronDownloadProgress& progress) {
  base::DictValue line;
  line.Set("type", "download_updated");
  line.Set("download", download);
  line.Set("state", DownloadStateName(progress.state));
  line.Set("done", progress.done);
  line.Set("paused", progress.paused);
  line.Set("can_resume", progress.can_resume);
  line.Set("received_bytes", static_cast<double>(progress.received_bytes));
  line.Set("total_bytes", static_cast<double>(progress.total_bytes));
  line.Set("bytes_per_second",
           static_cast<double>(progress.bytes_per_second));
  line.Set("save_path", progress.save_path.AsUTF8Unsafe());
  line.Set("filename", progress.filename);
  line.Set("mime_type", progress.mime_type);
  if (progress.end_time.has_value()) {
    line.Set("end_time", *progress.end_time);
  }
  return Line(std::move(line));
}

bool IsElectronStorage(std::string_view storage) {
  return std::ranges::find(kElectronStorages, storage) !=
         std::end(kElectronStorages);
}

bool ElectronCookieMatches(const ElectronCookie& cookie,
                           const ElectronCookieFilter& filter) {
  // Electron compares domains without a leading dot, and takes a cookie
  // of a domain inside the filter's.
  const std::string_view domain =
      base::TrimString(cookie.domain, ".", base::TRIM_LEADING);
  const std::string_view wanted =
      filter.domain.has_value()
          ? base::TrimString(*filter.domain, ".", base::TRIM_LEADING)
          : std::string_view();
  return (!filter.name.has_value() || cookie.name == *filter.name) &&
         (!filter.domain.has_value() || domain == wanted ||
          domain.ends_with(base::StrCat({".", wanted}))) &&
         (!filter.path.has_value() || cookie.path == *filter.path) &&
         (!filter.secure.has_value() || cookie.secure == *filter.secure) &&
         (!filter.session.has_value() ||
          !cookie.expiration_date.has_value() == *filter.session) &&
         (!filter.http_only.has_value() ||
          cookie.http_only == *filter.http_only);
}

std::string ElectronJavaScriptResult(
    ElectronWindow window,
    int call,
    const base::expected<base::Value, std::string>& result) {
  base::DictValue event = Event("javascript_result", window);
  event.Set("call", call);
  if (result.has_value()) {
    event.Set("result", result->Clone());
    std::string line;
    if (base::JSONWriter::Write(event, &line)) {
      line.push_back('\n');
      return line;
    }
    // A value of the page's that JSON can't carry is the page's to fix,
    // as Electron's structured clone refuses what it can't carry.
    event.Remove("result");
    event.Set("error", "the script's result can't be carried to the app");
    return Line(std::move(event));
  }
  event.Set("error", result.error());
  return Line(std::move(event));
}

std::string ElectronSessionResult(
    int call,
    const base::expected<base::Value, std::string>& result) {
  base::DictValue event;
  event.Set("type", "session_result");
  event.Set("call", call);
  if (result.has_value()) {
    event.Set("result", result->Clone());
  } else {
    event.Set("error", result.error());
  }
  return Line(std::move(event));
}

base::DictValue ElectronCookieValue(const ElectronCookie& cookie) {
  base::DictValue value;
  value.Set("name", cookie.name);
  value.Set("value", cookie.value);
  value.Set("domain", cookie.domain);
  value.Set("hostOnly", cookie.host_only);
  value.Set("path", cookie.path);
  value.Set("secure", cookie.secure);
  value.Set("httpOnly", cookie.http_only);
  value.Set("session", !cookie.expiration_date.has_value());
  if (cookie.expiration_date.has_value()) {
    value.Set("expirationDate", *cookie.expiration_date);
  }
  value.Set("sameSite", cookie.same_site);
  return value;
}

std::string ElectronCookieChanged(std::string_view session,
                                  const ElectronCookieChange& change) {
  base::DictValue event;
  event.Set("type", "cookie_changed");
  event.Set("session", session);
  event.Set("cookie", ElectronCookieValue(change.cookie));
  event.Set("cause", change.cause);
  event.Set("removed", change.removed);
  return Line(std::move(event));
}

std::string ElectronReady(const std::vector<ElectronScheme>& schemes,
                          const ElectronEngineInfo& engine) {
  base::ListValue registered;
  for (const ElectronScheme& scheme : schemes) {
    base::ListValue privileges;
    for (std::string& privilege : ElectronSchemePrivileges(scheme)) {
      privileges.Append(std::move(privilege));
    }
    registered.Append(base::DictValue()
                          .Set("scheme", scheme.scheme)
                          .Set("privileges", std::move(privileges)));
  }
  base::DictValue event;
  event.Set("type", "ready");
  event.Set("schemes", std::move(registered));
  event.Set("user_agent", engine.user_agent);
  event.Set("chrome_version", engine.chrome_version);
  return Line(std::move(event));
}

std::string ElectronRefused(std::string_view why) {
  base::DictValue event;
  event.Set("type", "refused");
  event.Set("why", why);
  return Line(std::move(event));
}

std::string ElectronWindowOpened(ElectronWindow window) {
  return Line(Event("window_opened", window));
}

std::string ElectronWindowRefused(ElectronWindow window, std::string_view why) {
  base::DictValue event = Event("window_refused", window);
  event.Set("why", why);
  return Line(std::move(event));
}

std::string ElectronWindowLoaded(ElectronWindow window) {
  return Line(Event("window_loaded", window));
}

std::string ElectronWindowDomReady(ElectronWindow window) {
  return Line(Event("window_dom_ready", window));
}

std::string ElectronTitleChanged(ElectronWindow window,
                                 std::string_view title) {
  base::DictValue event = Event("title_changed", window);
  event.Set("title", title);
  return Line(std::move(event));
}

std::string ElectronWindowClosed(ElectronWindow window) {
  return Line(Event("window_closed", window));
}

std::string ElectronCloseAsked(ElectronWindow window) {
  return Line(Event("close_asked", window));
}

std::string ElectronPageStateChanged(ElectronWindow window,
                                     const ElectronPageState& state) {
  base::DictValue event = Event("page_state", window);
  base::ListValue entries;
  for (const ElectronPageState::Entry& entry : state.entries) {
    entries.Append(
        base::DictValue().Set("url", entry.url).Set("title", entry.title));
  }
  event.Set("entries", std::move(entries));
  event.Set("index", state.index);
  event.Set("loading", state.loading);
  event.Set("focused", state.focused);
  event.Set("pid", state.pid);
  event.Set("crashed", state.crashed);
  event.Set("process_id", state.process_id);
  event.Set("routing_id", state.routing_id);
  event.Set("frame_token", state.frame_token);
  event.Set("waiting", state.waiting);
  return Line(std::move(event));
}

std::string ElectronFoundInPage(ElectronWindow window,
                                const ElectronFindResult& result) {
  base::DictValue event = Event("found_in_page", window);
  event.Set("request", result.request);
  event.Set("matches", result.matches);
  event.Set("active_match_ordinal", result.active_match_ordinal);
  event.Set("selection", base::DictValue()
                             .Set("x", result.x)
                             .Set("y", result.y)
                             .Set("width", result.width)
                             .Set("height", result.height));
  return Line(std::move(event));
}

std::string ElectronContextMenuAsked(ElectronWindow window,
                                     const ElectronContextMenu& menu) {
  base::DictValue event = Event("context_menu", window);
  event.Set("x", menu.x);
  event.Set("y", menu.y);
  event.Set("link_url", menu.link_url);
  event.Set("link_text", menu.link_text);
  event.Set("page_url", menu.page_url);
  event.Set("frame_url", menu.frame_url);
  event.Set("src_url", menu.src_url);
  event.Set("media_type", menu.media_type);
  event.Set("has_image_contents", menu.has_image_contents);
  event.Set("is_editable", menu.is_editable);
  event.Set("selection_text", menu.selection_text);
  event.Set("title_text", menu.title_text);
  event.Set("alt_text", menu.alt_text);
  event.Set("suggested_filename", menu.suggested_filename);
  event.Set("misspelled_word", menu.misspelled_word);
  base::ListValue suggestions;
  for (const std::string& suggestion : menu.dictionary_suggestions) {
    suggestions.Append(suggestion);
  }
  event.Set("dictionary_suggestions", std::move(suggestions));
  event.Set("spellcheck_enabled", menu.spellcheck_enabled);
  event.Set("frame_charset", menu.frame_charset);
  const ElectronContextMenu::EditFlags& edit = menu.edit_flags;
  event.Set("edit_flags", base::DictValue()
                              .Set("can_undo", edit.can_undo)
                              .Set("can_redo", edit.can_redo)
                              .Set("can_cut", edit.can_cut)
                              .Set("can_copy", edit.can_copy)
                              .Set("can_paste", edit.can_paste)
                              .Set("can_delete", edit.can_delete)
                              .Set("can_select_all", edit.can_select_all)
                              .Set("can_edit_richly", edit.can_edit_richly));
  const ElectronContextMenu::MediaFlags& media = menu.media_flags;
  event.Set(
      "media_flags",
      base::DictValue()
          .Set("in_error", media.in_error)
          .Set("is_paused", media.is_paused)
          .Set("is_muted", media.is_muted)
          .Set("has_audio", media.has_audio)
          .Set("is_looping", media.is_looping)
          .Set("is_controls_visible", media.is_controls_visible)
          .Set("can_toggle_controls", media.can_toggle_controls)
          .Set("can_print", media.can_print)
          .Set("can_save", media.can_save)
          .Set("can_show_picture_in_picture",
               media.can_show_picture_in_picture)
          .Set("is_showing_picture_in_picture",
               media.is_showing_picture_in_picture)
          .Set("can_rotate", media.can_rotate)
          .Set("can_loop", media.can_loop));
  return Line(std::move(event));
}

std::string ElectronWindowResized(ElectronWindow window,
                                  int width,
                                  int height) {
  base::DictValue event = Event("resized", window);
  event.Set("width", width);
  event.Set("height", height);
  return Line(std::move(event));
}

std::string ElectronMenuClicked(ElectronWindow window, int command) {
  base::DictValue event = Event("menu_clicked", window);
  event.Set("command", command);
  return Line(std::move(event));
}

std::string ElectronWindowStateChanged(ElectronWindow window,
                                       const ElectronWindowState& state) {
  base::DictValue event = Event("window_state", window);
  event.Set("maximized", state.maximized);
  event.Set("minimized", state.minimized);
  event.Set("fullscreen", state.fullscreen);
  return Line(std::move(event));
}

std::string ElectronPopupMenuClosed(ElectronWindow window,
                                    int popup,
                                    int command) {
  base::DictValue event = Event("popup_menu_closed", window);
  event.Set("popup", popup);
  event.Set("command", command);
  return Line(std::move(event));
}

std::string ElectronMessageBoxAnswered(ElectronWindow window,
                                       int box,
                                       int response,
                                       bool checkbox_checked) {
  base::DictValue event = Event("message_box_answered", window);
  event.Set("box", box);
  event.Set("response", response);
  event.Set("checkbox_checked", checkbox_checked);
  return Line(std::move(event));
}

base::expected<std::string, std::string> ElectronMenuJson(
    const base::ListValue& menu) {
  base::ListValue entries;
  for (const base::Value& entry : menu) {
    ASSIGN_OR_RETURN(base::DictValue kept, MenuEntry(entry, 0));
    entries.Append(std::move(kept));
  }
  std::string json;
  CHECK(base::JSONWriter::Write(entries, &json));
  return base::ok(std::move(json));
}

std::string ElectronIpcMessage(ElectronWindow window,
                               std::string_view channel,
                               const base::ListValue& args) {
  return WithChannel(Event("ipc_message", window), channel, args);
}

std::string ElectronIpcInvoke(ElectronWindow window,
                              int invoke,
                              std::string_view channel,
                              const base::ListValue& args) {
  base::DictValue event = Event("ipc_invoke", window);
  event.Set("invoke", invoke);
  return WithChannel(std::move(event), channel, args);
}

std::string ElectronIpcSendSync(ElectronWindow window,
                                int invoke,
                                std::string_view channel,
                                const base::ListValue& args) {
  base::DictValue event = Event("ipc_send_sync", window);
  event.Set("invoke", invoke);
  return WithChannel(std::move(event), channel, args);
}

std::string ElectronIpcPost(ElectronWindow window,
                            std::string_view channel,
                            const base::Value& message,
                            const std::vector<std::string>& ports) {
  base::DictValue event = Event("ipc_post", window);
  event.Set("channel", channel);
  event.Set("message", message.Clone());
  base::ListValue names;
  for (const std::string& port : ports) {
    names.Append(port);
  }
  event.Set("ports", std::move(names));
  return Written(std::move(event));
}

std::string ElectronPortMessage(ElectronWindow window,
                                std::string_view port,
                                const base::Value& data) {
  base::DictValue event = Event("port_message", window);
  event.Set("port", port);
  event.Set("data", data.Clone());
  return Written(std::move(event));
}

std::string ElectronPortClosed(ElectronWindow window, std::string_view port) {
  base::DictValue event = Event("port_closed", window);
  event.Set("port", port);
  return Line(std::move(event));
}

std::string ElectronPageGone(ElectronWindow window) {
  return Line(Event("page_gone", window));
}

std::string ElectronProtocolRequest(int request,
                                    std::string_view session,
                                    const ElectronFetch& fetch) {
  base::DictValue event;
  event.Set("type", "protocol_request");
  event.Set("request", request);
  event.Set("session", session);
  event.Set("url", fetch.url.spec());
  event.Set("method", fetch.method);
  event.Set("headers", HeadersList(fetch.headers));
  if (fetch.body.has_value()) {
    event.Set("body", base::Base64Encode(*fetch.body));
  }
  // Strings throughout, so it writes; header bytes that are not UTF-8 were
  // refused by the page's own fetch.
  return Written(std::move(event));
}

}  // namespace domicile
