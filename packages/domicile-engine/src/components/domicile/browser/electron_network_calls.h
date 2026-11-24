// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef COMPONENTS_DOMICILE_BROWSER_ELECTRON_NETWORK_CALLS_H_
#define COMPONENTS_DOMICILE_BROWSER_ELECTRON_NETWORK_CALLS_H_

#include <cstdint>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <variant>
#include <vector>

#include "base/files/file_path.h"
#include "base/types/expected.h"
#include "base/values.h"
#include "url/gurl.h"

namespace domicile {

// The session calls on a session's network and the rest of its storage
// (session_call, answered by session_result as the others are), by method:
//
//   "clear_data", with optional "data_types" (Electron's: backgroundFetch,
//     cache, cookies, downloads, fileSystems, indexedDB, localStorage,
//     serviceWorkers, webSQL; none is all), "origins" or "exclude_origins",
//     "avoid_closing_connections" and "origin_matching_mode"
//     ("third-parties-included" or "origin-in-all-contexts")
//   "clear_auth_cache"
//   "clear_code_caches", with optional "urls"
//   "resolve_host", with "host" and optional "query_type" (A, AAAA),
//     "source" (any, system, dns, mdns, localOnly), "cache_usage" (allowed,
//     staleAllowed, disallowed) and "secure_dns_policy" (allow, disable)
//     -> {"endpoints":[{"address":"::1","family":"ipv6"}]}
//   "preconnect_sockets", with "url" and "sockets" (1 to 6)
//   "storage_path" -> "/abs/dir"
//   "set_code_cache_path", with "path", absolute
//   "clear_shared_dictionary_cache", "get_shared_dictionary_usage_info"
//   "clear_shared_dictionary_cache_for_isolation_key" and
//     "get_shared_dictionary_info", with "frame_origin" and "top_frame_site"
//   "service_workers_watch" -> the workers running now; from then on each
//     change comes as a service_worker event:
//
//   -> {"type":"service_worker","session":"","event":"running_status",
//       "version_id":2,"running_status":"running",
//       "worker":{"version_id":2,"scope":"https://a.test/",
//                 "script_url":"https://a.test/sw.js",
//                 "render_process_id":7}}    ("worker" with "running" only)
//   -> {"type":"service_worker","session":"",
//       "event":"registration_completed","scope":"https://a.test/"}
//   -> {"type":"service_worker","session":"","event":"console_message",
//       "version_id":2,"message":"hi","source":"console-api","level":1,
//       "source_url":"https://a.test/sw.js","line_number":3}

struct ElectronClearData {
  // Electron's names; empty is every type.
  std::set<std::string> data_types;
  // Only these, or all but `exclude_origins`; never both.
  std::vector<GURL> origins;
  std::vector<GURL> exclude_origins;
  bool avoid_closing_connections = false;
  // Matched on origin in every context, rather than also as third parties
  // under a top-level site.
  bool origin_in_all_contexts = false;

  friend bool operator==(const ElectronClearData&,
                         const ElectronClearData&) = default;
};
struct ElectronClearAuthCache {
  friend bool operator==(const ElectronClearAuthCache&,
                         const ElectronClearAuthCache&) = default;
};
struct ElectronClearCodeCaches {
  // Only these scripts' caches; empty is all.
  std::set<GURL> urls;

  friend bool operator==(const ElectronClearCodeCaches&,
                         const ElectronClearCodeCaches&) = default;
};
struct ElectronResolveHost {
  std::string host;
  // "A", "AAAA", or empty for either.
  std::string query_type;
  std::string source = "any";
  std::string cache_usage = "allowed";
  std::string secure_dns_policy = "allow";

  friend bool operator==(const ElectronResolveHost&,
                         const ElectronResolveHost&) = default;
};
struct ElectronPreconnect {
  GURL url;
  int sockets = 1;

  friend bool operator==(const ElectronPreconnect&,
                         const ElectronPreconnect&) = default;
};
struct ElectronStoragePath {
  friend bool operator==(const ElectronStoragePath&,
                         const ElectronStoragePath&) = default;
};
struct ElectronSetCodeCachePath {
  base::FilePath path;

  friend bool operator==(const ElectronSetCodeCachePath&,
                         const ElectronSetCodeCachePath&) = default;
};
// Where a shared dictionary is kept: the frame's origin under its top-level
// site.
struct ElectronSharedDictionaryKey {
  GURL frame_origin;
  GURL top_frame_site;

  friend bool operator==(const ElectronSharedDictionaryKey&,
                         const ElectronSharedDictionaryKey&) = default;
};
// Every shared dictionary, or the ones under `key`.
struct ElectronClearSharedDictionaries {
  std::optional<ElectronSharedDictionaryKey> key;

  friend bool operator==(const ElectronClearSharedDictionaries&,
                         const ElectronClearSharedDictionaries&) = default;
};
struct ElectronGetSharedDictionaryInfo {
  ElectronSharedDictionaryKey key;

  friend bool operator==(const ElectronGetSharedDictionaryInfo&,
                         const ElectronGetSharedDictionaryInfo&) = default;
};
struct ElectronGetSharedDictionaryUsage {
  friend bool operator==(const ElectronGetSharedDictionaryUsage&,
                         const ElectronGetSharedDictionaryUsage&) = default;
};

// The calls the desk answers whole (ElectronDesk::RunNetworkCall).
using ElectronNetworkCall = std::variant<ElectronClearData,
                                         ElectronClearAuthCache,
                                         ElectronClearCodeCaches,
                                         ElectronResolveHost,
                                         ElectronPreconnect,
                                         ElectronStoragePath,
                                         ElectronSetCodeCachePath,
                                         ElectronClearSharedDictionaries,
                                         ElectronGetSharedDictionaryInfo,
                                         ElectronGetSharedDictionaryUsage>;

// Report each change to the session's service workers from now on, as
// service_worker events. Watching twice is watching once.
struct ElectronWatchServiceWorkers {
  friend bool operator==(const ElectronWatchServiceWorkers&,
                         const ElectronWatchServiceWorkers&) = default;
};

// The network call `method` names, with its arguments from `request`; or
// why they are not its; or nothing when `method` names none of these.
std::optional<base::expected<ElectronNetworkCall, std::string>>
ParseElectronNetworkCall(std::string_view method,
                         const base::DictValue& request);

struct ElectronRunningServiceWorker {
  int64_t version_id = 0;
  GURL scope;
  GURL script_url;
  int render_process_id = 0;

  friend bool operator==(const ElectronRunningServiceWorker&,
                         const ElectronRunningServiceWorker&) = default;
};
struct ElectronServiceWorkerStatus {
  int64_t version_id = 0;
  // "starting", "running", "stopping" or "stopped".
  std::string running_status;
  // With "running".
  std::optional<ElectronRunningServiceWorker> worker;

  friend bool operator==(const ElectronServiceWorkerStatus&,
                         const ElectronServiceWorkerStatus&) = default;
};
struct ElectronServiceWorkerRegistered {
  GURL scope;

  friend bool operator==(const ElectronServiceWorkerRegistered&,
                         const ElectronServiceWorkerRegistered&) = default;
};
struct ElectronServiceWorkerConsole {
  int64_t version_id = 0;
  std::string message;
  // Electron's name for where it came from: "javascript", "console-api"...
  std::string source;
  // 0 verbose, 1 info, 2 warning, 3 error.
  int level = 0;
  GURL source_url;
  int line_number = 0;

  friend bool operator==(const ElectronServiceWorkerConsole&,
                         const ElectronServiceWorkerConsole&) = default;
};
using ElectronServiceWorkerChange =
    std::variant<ElectronServiceWorkerStatus,
                 ElectronServiceWorkerRegistered,
                 ElectronServiceWorkerConsole>;

// A watch on a session's service workers, which ElectronDesk's
// WatchServiceWorkers starts. Destroying it ends the watch. With no shell
// there are none.
class ElectronServiceWorkerWatch {
 public:
  virtual ~ElectronServiceWorkerWatch() = default;
  // The workers running now.
  virtual std::vector<ElectronRunningServiceWorker> Running() const;
};

// `workers`, as service_workers_watch's result.
base::Value ElectronRunningServiceWorkersValue(
    const std::vector<ElectronRunningServiceWorker>& workers);
// A change to session `session`'s service workers.
std::string ElectronServiceWorkerChanged(
    std::string_view session,
    const ElectronServiceWorkerChange& change);

}  // namespace domicile

#endif  // COMPONENTS_DOMICILE_BROWSER_ELECTRON_NETWORK_CALLS_H_
