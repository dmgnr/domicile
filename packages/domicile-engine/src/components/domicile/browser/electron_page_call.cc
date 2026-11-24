// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/browser/electron_page_call.h"

#include <algorithm>
#include <array>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "base/check.h"
#include "base/json/json_writer.h"
#include "base/strings/strcat.h"
#include "base/strings/string_number_conversions.h"
#include "base/types/expected.h"
#include "base/values.h"

namespace domicile {
namespace {

constexpr std::array<std::pair<std::string_view, ElectronWebRtcIpPolicy>, 4>
    kWebRtcIpPolicies = {{
        {"default", ElectronWebRtcIpPolicy::kDefault},
        {"default_public_interface_only",
         ElectronWebRtcIpPolicy::kDefaultPublicInterfaceOnly},
        {"default_public_and_private_interfaces",
         ElectronWebRtcIpPolicy::kDefaultPublicAndPrivateInterfaces},
        {"disable_non_proxied_udp",
         ElectronWebRtcIpPolicy::kDisableNonProxiedUdp},
    }};

// The DevTools methods the host's members need, and all an app may send: a
// method past these could take the page where the app can't, or read what
// it shouldn't.
constexpr std::array<std::string_view, 9> kAppDevToolsMethods = {
    "Emulation.clearDeviceMetricsOverride",
    "Emulation.setDeviceMetricsOverride",
    "Network.emulateNetworkConditions",
    "Page.captureScreenshot",
    "Page.getLayoutMetrics",
    "Page.printToPDF",
    "Page.screencastFrameAck",
    "Page.startScreencast",
    "Page.stopScreencast",
};

base::expected<bool, std::string> BoolIn(const base::DictValue& request,
                                         std::string_view key) {
  const std::optional<bool> value = request.FindBool(key);
  if (!value.has_value()) {
    return base::unexpected(
        base::StrCat({"\"", key, "\" must be true or false"}));
  }
  return *value;
}

base::expected<int, std::string> IntIn(const base::DictValue& request,
                                       std::string_view key) {
  const std::optional<int> value = request.FindInt(key);
  if (!value.has_value()) {
    return base::unexpected(
        base::StrCat({"\"", key, "\" must be a whole number"}));
  }
  return *value;
}

base::expected<std::string, std::string> StringIn(
    const base::DictValue& request,
    std::string_view key) {
  const std::string* value = request.FindString(key);
  if (value == nullptr) {
    return base::unexpected(base::StrCat({"\"", key, "\" must be a string"}));
  }
  return base::ok(*value);
}

// A point in the page, as copy_image_at and copy_video_frame_at take it.
base::expected<std::pair<int, int>, std::string> PointIn(
    const base::DictValue& request) {
  const base::expected<int, std::string> x = IntIn(request, "x");
  const base::expected<int, std::string> y = IntIn(request, "y");
  if (!x.has_value()) {
    return base::unexpected(x.error());
  } else if (!y.has_value()) {
    return base::unexpected(y.error());
  }
  return std::pair(*x, *y);
}

base::expected<ElectronPageMethod, std::string> ExecuteInIsolatedWorldIn(
    const base::DictValue& request) {
  const base::expected<int, std::string> world = IntIn(request, "world");
  const base::expected<bool, std::string> user_gesture =
      BoolIn(request, "user_gesture");
  const base::ListValue* scripts = request.FindList("scripts");
  if (!world.has_value()) {
    return base::unexpected(world.error());
  } else if (*world < 0 || *world > kElectronMostWorlds) {
    return base::unexpected(
        base::StrCat({"\"world\" must be from 0 to ",
                      base::NumberToString(kElectronMostWorlds)}));
  } else if (!user_gesture.has_value()) {
    return base::unexpected(user_gesture.error());
  } else if (scripts == nullptr || scripts->empty()) {
    return base::unexpected("\"scripts\" must be a list of scripts");
  }
  ElectronExecuteInIsolatedWorld execute{.world = *world,
                                         .user_gesture = *user_gesture};
  for (const base::Value& script : *scripts) {
    const base::DictValue* dict = script.GetIfDict();
    const std::string* code = dict ? dict->FindString("code") : nullptr;
    const base::Value* url = dict ? dict->Find("url") : nullptr;
    if (code == nullptr) {
      return base::unexpected("each script must have its \"code\"");
    } else if (url != nullptr && !url->is_string()) {
      return base::unexpected("a script's \"url\" must be a string");
    }
    execute.scripts.push_back(
        {.code = *code, .url = url ? url->GetString() : std::string()});
  }
  return execute;
}

base::expected<ElectronPageMethod, std::string> WebRtcIpPolicyIn(
    const base::DictValue& request) {
  const base::expected<std::string, std::string> policy =
      StringIn(request, "policy");
  if (!policy.has_value()) {
    return base::unexpected(policy.error());
  }
  const auto found = std::ranges::find(
      kWebRtcIpPolicies, *policy,
      &std::pair<std::string_view, ElectronWebRtcIpPolicy>::first);
  if (found == kWebRtcIpPolicies.end()) {
    return base::unexpected(
        base::StrCat({"no WebRTC IP handling policy is named ", *policy}));
  }
  return ElectronSetWebRtcIpPolicy{.policy = found->second};
}

base::expected<ElectronPageMethod, std::string> DevToolsMethodIn(
    base::DictValue& request) {
  const base::expected<std::string, std::string> method =
      StringIn(request, "devtools_method");
  base::DictValue* params = request.FindDict("params");
  if (!method.has_value()) {
    return base::unexpected(method.error());
  } else if (std::ranges::find(kAppDevToolsMethods, *method) ==
             kAppDevToolsMethods.end()) {
    return base::unexpected(
        base::StrCat({"an app has no DevTools method ", *method}));
  } else if (params == nullptr) {
    return base::unexpected("\"params\" must be an object");
  }
  return ElectronDevToolsMethod{.method = *method,
                                .params = std::move(*params)};
}

std::string Line(base::DictValue event) {
  std::string line;
  // The engine's own values, which JSON carries.
  CHECK(base::JSONWriter::Write(event, &line));
  line.push_back('\n');
  return line;
}

}  // namespace

base::expected<ElectronPageMethod, std::string> ElectronPageMethodIn(
    std::string_view name,
    base::DictValue& request) {
  if (name == "reload_ignoring_cache") {
    return ElectronReloadIgnoringCache{};
  } else if (name == "insert_css" || name == "remove_inserted_css") {
    const base::expected<std::string, std::string> text =
        StringIn(request, name == "insert_css" ? "css" : "key");
    const base::expected<bool, std::string> user = BoolIn(request, "user");
    if (!text.has_value()) {
      return base::unexpected(text.error());
    } else if (!user.has_value()) {
      return base::unexpected(user.error());
    }
    return name == "insert_css" ? ElectronPageMethod(ElectronInsertCss{
                                      .css = *text, .user = *user})
                                : ElectronPageMethod(ElectronRemoveInsertedCss{
                                      .key = *text, .user = *user});
  } else if (name == "execute_in_isolated_world") {
    return ExecuteInIsolatedWorldIn(request);
  } else if (name == "copy_image_at" || name == "copy_video_frame_at") {
    const base::expected<std::pair<int, int>, std::string> point =
        PointIn(request);
    if (!point.has_value()) {
      return base::unexpected(point.error());
    }
    return name == "copy_image_at"
               ? ElectronPageMethod(
                     ElectronCopyImageAt{.x = point->first, .y = point->second})
               : ElectronPageMethod(ElectronCopyVideoFrameAt{
                     .x = point->first, .y = point->second});
  } else if (name == "adjust_selection") {
    const base::expected<int, std::string> start = IntIn(request, "start");
    const base::expected<int, std::string> end = IntIn(request, "end");
    if (!start.has_value()) {
      return base::unexpected(start.error());
    } else if (!end.has_value()) {
      return base::unexpected(end.error());
    }
    return ElectronAdjustSelection{.start = *start, .end = *end};
  } else if (name == "set_caret_browsing") {
    const base::expected<bool, std::string> enabled =
        BoolIn(request, "enabled");
    if (!enabled.has_value()) {
      return base::unexpected(enabled.error());
    }
    return ElectronSetCaretBrowsing{.enabled = *enabled};
  } else if (name == "set_webrtc_ip_policy") {
    return WebRtcIpPolicyIn(request);
  } else if (name == "set_ignore_input") {
    const base::expected<bool, std::string> ignore = BoolIn(request, "ignore");
    if (!ignore.has_value()) {
      return base::unexpected(ignore.error());
    }
    return ElectronSetIgnoreInput{.ignore = *ignore};
  } else if (name == "devtools") {
    return DevToolsMethodIn(request);
  }
  return base::unexpected(base::StrCat({"no page call is named ", name}));
}

std::string ElectronPageResult(
    int window,
    int call,
    const base::expected<base::Value, std::string>& result) {
  base::DictValue event;
  event.Set("type", "page_result");
  event.Set("window", window);
  event.Set("call", call);
  if (result.has_value()) {
    event.Set("result", result->Clone());
    std::string line;
    if (base::JSONWriter::Write(event, &line)) {
      line.push_back('\n');
      return line;
    }
    // A script's result JSON can't carry is the page's to fix, as
    // Electron's structured clone refuses what it can't carry.
    event.Remove("result");
    event.Set("error", "the result can't be carried to the app");
    return Line(std::move(event));
  }
  event.Set("error", result.error());
  return Line(std::move(event));
}

std::string ElectronDevToolsEvent(int window,
                                  std::string_view method,
                                  base::DictValue params) {
  base::DictValue event;
  event.Set("type", "devtools_event");
  event.Set("window", window);
  event.Set("method", method);
  event.Set("params", std::move(params));
  return Line(std::move(event));
}

}  // namespace domicile
