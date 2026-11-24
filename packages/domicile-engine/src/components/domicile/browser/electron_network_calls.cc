// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/browser/electron_network_calls.h"

#include <algorithm>
#include <iterator>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <variant>
#include <vector>

#include "base/check.h"
#include "base/files/file_path.h"
#include "base/json/json_writer.h"
#include "base/strings/strcat.h"
#include "base/types/expected.h"
#include "base/types/expected_macros.h"
#include "base/values.h"
#include "url/gurl.h"

namespace domicile {
namespace {

constexpr std::string_view kDataTypes[] = {
    "backgroundFetch", "cache",          "cookies",
    "downloads",       "fileSystems",    "indexedDB",
    "localStorage",    "serviceWorkers", "webSQL"};
constexpr std::string_view kQueryTypes[] = {"A", "AAAA"};
constexpr std::string_view kSources[] = {"any", "system", "dns", "mdns",
                                         "localOnly"};
constexpr std::string_view kCacheUsages[] = {"allowed", "staleAllowed",
                                             "disallowed"};
constexpr std::string_view kSecureDnsPolicies[] = {"allow", "disable"};

template <size_t N>
bool OneOf(const std::string_view (&names)[N], std::string_view name) {
  return std::ranges::find(names, name) != std::end(names);
}

// The strings under `key`, none when it is left out.
base::expected<std::vector<std::string>, std::string> StringsIn(
    const base::DictValue& request,
    std::string_view key) {
  std::vector<std::string> strings;
  const base::Value* value = request.Find(key);
  if (value == nullptr) {
    return strings;
  } else if (!value->is_list()) {
    return base::unexpected(base::StrCat({"\"", key, "\" must be an array"}));
  }
  for (const base::Value& each : value->GetList()) {
    if (!each.is_string()) {
      return base::unexpected(
          base::StrCat({"\"", key, "\" must hold strings"}));
    }
    strings.push_back(each.GetString());
  }
  return strings;
}

base::expected<std::vector<GURL>, std::string> UrlsIn(
    const base::DictValue& request,
    std::string_view key) {
  ASSIGN_OR_RETURN(std::vector<std::string> strings, StringsIn(request, key));
  std::vector<GURL> urls;
  for (const std::string& each : strings) {
    GURL url(each);
    if (!url.is_valid()) {
      return base::unexpected(
          base::StrCat({"\"", key, "\" holds \"", each, "\", not a URL"}));
    }
    urls.push_back(std::move(url));
  }
  return urls;
}

base::expected<GURL, std::string> UrlIn(const base::DictValue& request,
                                        std::string_view key) {
  const std::string* text = request.FindString(key);
  GURL url(text == nullptr ? "" : *text);
  if (!url.is_valid()) {
    return base::unexpected(base::StrCat({"\"", key, "\" must be a URL"}));
  }
  return url;
}

// `key`'s string, one of `names`, or `fallback` when it is left out.
template <size_t N>
base::expected<std::string, std::string> NameIn(
    const base::DictValue& request,
    std::string_view key,
    const std::string_view (&names)[N],
    std::string_view fallback) {
  const base::Value* value = request.Find(key);
  if (value == nullptr) {
    return base::ok(std::string(fallback));
  } else if (!value->is_string() || !OneOf(names, value->GetString())) {
    std::string why = base::StrCat({"\"", key, "\" must be one of"});
    for (std::string_view name : names) {
      base::StrAppend(&why, {" ", name});
    }
    return base::unexpected(std::move(why));
  }
  return base::ok(value->GetString());
}

base::expected<ElectronNetworkCall, std::string> ClearDataIn(
    const base::DictValue& request) {
  ElectronClearData clear;
  ASSIGN_OR_RETURN(std::vector<std::string> types,
                   StringsIn(request, "data_types"));
  for (const std::string& type : types) {
    if (!OneOf(kDataTypes, type)) {
      return base::unexpected(
          base::StrCat({"\"", type, "\" is not a type clearData knows"}));
    }
    clear.data_types.insert(type);
  }
  ASSIGN_OR_RETURN(clear.origins, UrlsIn(request, "origins"));
  ASSIGN_OR_RETURN(clear.exclude_origins, UrlsIn(request, "exclude_origins"));
  if (!clear.origins.empty() && !clear.exclude_origins.empty()) {
    return base::unexpected(
        "clearData takes \"origins\" or \"exclude_origins\", not both");
  }
  clear.avoid_closing_connections =
      request.FindBool("avoid_closing_connections").value_or(false);
  constexpr std::string_view kModes[] = {"third-parties-included",
                                         "origin-in-all-contexts"};
  ASSIGN_OR_RETURN(std::string mode, NameIn(request, "origin_matching_mode",
                                            kModes, "third-parties-included"));
  clear.origin_in_all_contexts = mode == "origin-in-all-contexts";
  return clear;
}

base::expected<ElectronNetworkCall, std::string> ResolveHostIn(
    const base::DictValue& request) {
  const std::string* host = request.FindString("host");
  if (host == nullptr || host->empty()) {
    return base::unexpected("\"host\" must be a host name");
  }
  ElectronResolveHost resolve{.host = *host};
  ASSIGN_OR_RETURN(resolve.query_type,
                   NameIn(request, "query_type", kQueryTypes, ""));
  ASSIGN_OR_RETURN(resolve.source, NameIn(request, "source", kSources, "any"));
  ASSIGN_OR_RETURN(resolve.cache_usage,
                   NameIn(request, "cache_usage", kCacheUsages, "allowed"));
  ASSIGN_OR_RETURN(
      resolve.secure_dns_policy,
      NameIn(request, "secure_dns_policy", kSecureDnsPolicies, "allow"));
  return resolve;
}

base::expected<ElectronNetworkCall, std::string> PreconnectIn(
    const base::DictValue& request) {
  ASSIGN_OR_RETURN(GURL url, UrlIn(request, "url"));
  const std::optional<int> sockets = request.FindInt("sockets");
  if (!sockets.has_value() || *sockets < 1 || *sockets > 6) {
    return base::unexpected("\"sockets\" must be a whole number from 1 to 6");
  }
  return ElectronPreconnect{.url = std::move(url), .sockets = *sockets};
}

base::expected<ElectronSharedDictionaryKey, std::string> KeyIn(
    const base::DictValue& request) {
  ASSIGN_OR_RETURN(GURL frame_origin, UrlIn(request, "frame_origin"));
  ASSIGN_OR_RETURN(GURL top_frame_site, UrlIn(request, "top_frame_site"));
  return ElectronSharedDictionaryKey{
      .frame_origin = std::move(frame_origin),
      .top_frame_site = std::move(top_frame_site)};
}

base::DictValue WorkerValue(const ElectronRunningServiceWorker& worker) {
  return base::DictValue()
      .Set("version_id", static_cast<double>(worker.version_id))
      .Set("scope", worker.scope.spec())
      .Set("script_url", worker.script_url.spec())
      .Set("render_process_id", worker.render_process_id);
}

}  // namespace

std::vector<ElectronRunningServiceWorker> ElectronServiceWorkerWatch::Running()
    const {
  return {};
}

std::optional<base::expected<ElectronNetworkCall, std::string>>
ParseElectronNetworkCall(std::string_view method,
                         const base::DictValue& request) {
  if (method == "clear_data") {
    return ClearDataIn(request);
  } else if (method == "clear_auth_cache") {
    return ElectronClearAuthCache{};
  } else if (method == "clear_code_caches") {
    base::expected<std::vector<GURL>, std::string> urls =
        UrlsIn(request, "urls");
    if (!urls.has_value()) {
      return base::unexpected(std::move(urls.error()));
    }
    return ElectronClearCodeCaches{
        .urls = std::set<GURL>(urls->begin(), urls->end())};
  } else if (method == "resolve_host") {
    return ResolveHostIn(request);
  } else if (method == "preconnect_sockets") {
    return PreconnectIn(request);
  } else if (method == "storage_path") {
    return ElectronStoragePath{};
  } else if (method == "set_code_cache_path") {
    const std::string* path = request.FindString("path");
    if (path == nullptr || !base::FilePath(*path).IsAbsolute()) {
      return base::unexpected("\"path\" must be an absolute path");
    }
    return ElectronSetCodeCachePath{.path = base::FilePath(*path)};
  } else if (method == "clear_shared_dictionary_cache") {
    return ElectronClearSharedDictionaries{};
  } else if (method == "clear_shared_dictionary_cache_for_isolation_key") {
    return KeyIn(request).transform(
        [](ElectronSharedDictionaryKey key) -> ElectronNetworkCall {
          return ElectronClearSharedDictionaries{.key = std::move(key)};
        });
  } else if (method == "get_shared_dictionary_info") {
    return KeyIn(request).transform(
        [](ElectronSharedDictionaryKey key) -> ElectronNetworkCall {
          return ElectronGetSharedDictionaryInfo{.key = std::move(key)};
        });
  } else if (method == "get_shared_dictionary_usage_info") {
    return ElectronGetSharedDictionaryUsage{};
  }
  return std::nullopt;
}

base::Value ElectronRunningServiceWorkersValue(
    const std::vector<ElectronRunningServiceWorker>& workers) {
  base::ListValue list;
  for (const ElectronRunningServiceWorker& worker : workers) {
    list.Append(WorkerValue(worker));
  }
  return base::Value(std::move(list));
}

std::string ElectronServiceWorkerChanged(
    std::string_view session,
    const ElectronServiceWorkerChange& change) {
  base::DictValue line;
  line.Set("type", "service_worker");
  line.Set("session", session);
  if (const auto* status = std::get_if<ElectronServiceWorkerStatus>(&change)) {
    line.Set("event", "running_status");
    line.Set("version_id", static_cast<double>(status->version_id));
    line.Set("running_status", status->running_status);
    if (status->worker.has_value()) {
      line.Set("worker", WorkerValue(*status->worker));
    }
  } else if (const auto* registered =
                 std::get_if<ElectronServiceWorkerRegistered>(&change)) {
    line.Set("event", "registration_completed");
    line.Set("scope", registered->scope.spec());
  } else {
    const auto& console = std::get<ElectronServiceWorkerConsole>(change);
    line.Set("event", "console_message");
    line.Set("version_id", static_cast<double>(console.version_id));
    line.Set("message", console.message);
    line.Set("source", console.source);
    line.Set("level", console.level);
    line.Set("source_url", console.source_url.spec());
    line.Set("line_number", console.line_number);
  }
  std::string text;
  // A change holds strings and numbers: a write failure is a bug.
  CHECK(base::JSONWriter::Write(line, &text));
  text.push_back('\n');
  return text;
}

}  // namespace domicile
