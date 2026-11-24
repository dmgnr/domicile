// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "chrome/browser/domicile/domicile_electron_network.h"

#include <cstdint>
#include <memory>
#include <optional>
#include <set>
#include <string>
#include <utility>
#include <variant>
#include <vector>

#include "base/barrier_closure.h"
#include "base/check.h"
#include "base/files/file_path.h"
#include "base/functional/bind.h"
#include "base/functional/callback_helpers.h"
#include "base/memory/raw_ptr.h"
#include "base/notreached.h"
#include "base/scoped_observation.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/utf_string_conversions.h"
#include "base/time/time.h"
#include "base/unguessable_token.h"
#include "chrome/browser/domicile/domicile_browser_windows.h"
#include "chrome/browser/domicile/domicile_electron_storage.h"
#include "components/download/public/common/download_item.h"
#include "content/public/browser/browser_context.h"
#include "content/public/browser/browsing_data_filter_builder.h"
#include "content/public/browser/console_message.h"
#include "content/public/browser/domicile_code_cache.h"
#include "content/public/browser/download_manager.h"
#include "content/public/browser/service_worker_context.h"
#include "content/public/browser/service_worker_context_observer.h"
#include "content/public/browser/service_worker_running_info.h"
#include "content/public/browser/storage_partition.h"
#include "content/public/browser/storage_partition_config.h"
#include "content/public/browser/web_contents.h"
#include "mojo/public/cpp/bindings/receiver.h"
#include "mojo/public/cpp/bindings/remote.h"
#include "net/base/address_family.h"
#include "net/base/address_list.h"
#include "net/base/host_port_pair.h"
#include "net/base/ip_endpoint.h"
#include "net/base/net_errors.h"
#include "net/base/network_anonymization_key.h"
#include "net/base/registry_controlled_domains/registry_controlled_domain.h"
#include "net/base/schemeful_site.h"
#include "net/dns/public/host_resolver_results.h"
#include "net/dns/public/resolve_error_info.h"
#include "net/extras/shared_dictionary/shared_dictionary_usage_info.h"
#include "net/shared_dictionary/shared_dictionary_isolation_key.h"
#include "net/traffic_annotation/network_traffic_annotation.h"
#include "services/network/public/cpp/request_destination.h"
#include "services/network/public/cpp/resolve_host_client_base.h"
#include "services/network/public/mojom/clear_data_filter.mojom.h"
#include "services/network/public/mojom/cookie_manager.mojom.h"
#include "services/network/public/mojom/host_resolver.mojom.h"
#include "services/network/public/mojom/network_context.mojom.h"
#include "url/gurl.h"
#include "url/origin.h"

namespace domicile {
namespace {

using Done = base::OnceCallback<void(base::expected<base::Value, std::string>)>;

constexpr net::NetworkTrafficAnnotationTag kPreconnectAnnotation =
    net::DefineNetworkTrafficAnnotation("domicile_electron_preconnect", R"(
      semantics {
        sender: "Domicile Electron session"
        description:
          "An Electron app's session.preconnect: sockets opened ahead of the "
          "app's own requests to a site."
        trigger: "The Electron app calls session.preconnect."
        data: "None: the sockets are opened, nothing is sent on them."
        destination: WEBSITE
      }
      policy {
        cookies_allowed: NO
        setting: "None: the Electron app asks for it."
        policy_exception_justification: "The app's own request."
      })");

void Cleared(Done done) {
  std::move(done).Run(base::Value());
}

void Answer(Done done, base::Value value) {
  std::move(done).Run(std::move(value));
}

// Electron's data types, as content's storage. "cache" and "downloads" are
// not storage: they are cleared apart.
uint32_t StorageMaskOf(const std::set<std::string>& types) {
  using Partition = content::StoragePartition;
  if (types.empty()) {
    return Partition::REMOVE_DATA_MASK_ALL;
  }
  uint32_t mask = 0;
  for (const std::string& type : types) {
    if (type == "backgroundFetch") {
      mask |= Partition::REMOVE_DATA_MASK_BACKGROUND_FETCH;
    } else if (type == "cache") {
      // The Cache API's caches, as Electron's "cache" clears with the HTTP
      // cache.
      mask |= Partition::REMOVE_DATA_MASK_CACHE_STORAGE;
    } else if (type == "cookies") {
      mask |= Partition::REMOVE_DATA_MASK_COOKIES;
    } else if (type == "fileSystems") {
      mask |= Partition::REMOVE_DATA_MASK_FILE_SYSTEMS;
    } else if (type == "indexedDB") {
      mask |= Partition::REMOVE_DATA_MASK_INDEXEDDB;
    } else if (type == "localStorage") {
      mask |= Partition::REMOVE_DATA_MASK_LOCAL_STORAGE;
    } else if (type == "serviceWorkers") {
      mask |= Partition::REMOVE_DATA_MASK_SERVICE_WORKERS;
    } else if (type == "webSQL") {
      mask |= Partition::REMOVE_DATA_MASK_WEBSQL_DEPRECATED;
    } else {
      // ParseElectronNetworkCall takes only Electron's names.
      CHECK_EQ(type, "downloads");
    }
  }
  return mask;
}

bool Clears(const ElectronClearData& clear, const std::string& type) {
  return clear.data_types.empty() || clear.data_types.contains(type);
}

// The origins `clear` names, for everything but cookies; none for all.
std::unique_ptr<content::BrowsingDataFilterBuilder> OriginFilterOf(
    const ElectronClearData& clear) {
  using Builder = content::BrowsingDataFilterBuilder;
  if (clear.origins.empty() && clear.exclude_origins.empty()) {
    return nullptr;
  }
  std::unique_ptr<Builder> builder = Builder::Create(
      clear.origins.empty() ? Builder::Mode::kPreserve : Builder::Mode::kDelete,
      clear.origin_in_all_contexts
          ? Builder::OriginMatchingMode::kOriginInAllContexts
          : Builder::OriginMatchingMode::kThirdPartiesIncluded);
  for (const GURL& url :
       clear.origins.empty() ? clear.exclude_origins : clear.origins) {
    builder->AddOrigin(url::Origin::Create(url));
  }
  return builder;
}

// Cookies go by their sites' registrable domains, as Electron documents:
// an origin clears the cookies of its whole site.
std::unique_ptr<content::BrowsingDataFilterBuilder> CookieFilterOf(
    const ElectronClearData& clear) {
  using Builder = content::BrowsingDataFilterBuilder;
  if (clear.origins.empty() && clear.exclude_origins.empty()) {
    return nullptr;
  }
  std::unique_ptr<Builder> builder =
      Builder::Create(clear.origins.empty() ? Builder::Mode::kPreserve
                                            : Builder::Mode::kDelete);
  for (const GURL& url :
       clear.origins.empty() ? clear.exclude_origins : clear.origins) {
    std::string domain = net::registry_controlled_domains::GetDomainAndRegistry(
        url, net::registry_controlled_domains::INCLUDE_PRIVATE_REGISTRIES);
    // An IP address or a host with no registry is its own site.
    builder->AddRegisterableDomain(domain.empty() ? std::string(url.host())
                                                   : domain);
  }
  return builder;
}

// Removes the downloads made in `partition` that `filter` keeps.
void RemoveDownloads(content::BrowserContext& context,
                     const content::StoragePartitionConfig& partition,
                     const base::RepeatingCallback<bool(const GURL&)>& filter) {
  content::DownloadManager* downloads = context.GetDownloadManager();
  content::DownloadManager::DownloadVector all;
  downloads->GetAllDownloads(&all);
  for (download::DownloadItem* item : all) {
    if (downloads->SerializedEmbedderDownloadDataToStoragePartitionConfig(
            item->GetSerializedEmbedderDownloadData()) == partition &&
        (filter.is_null() || filter.Run(item->GetURL()))) {
      item->Remove();
    }
  }
}

void ClearData(const WebViewPartition& partition,
               const ElectronClearData& clear,
               Done done) {
  content::StoragePartition* storage = StorageOf(partition);
  if (storage == nullptr) {
    Cleared(std::move(done));
    return;
  }
  const uint32_t mask = StorageMaskOf(clear.data_types);
  const uint32_t cookies =
      mask & content::StoragePartition::REMOVE_DATA_MASK_COOKIES;
  const bool cache = Clears(clear, "cache");
  // Storage, cookies, the HTTP cache and code caches.
  base::RepeatingClosure each = base::BarrierClosure(
      2 + (cache ? 2 : 0),
      base::BindOnce(
          [](network::mojom::NetworkContext* network, bool close, Done done) {
            if (!close) {
              Cleared(std::move(done));
              return;
            }
            // Clearing cookies or the cache leaves connections that carry
            // what was cleared: Electron closes them unless asked not to.
            network->CloseAllConnections(
                base::BindOnce(&Cleared, std::move(done)));
          },
          base::Unretained(storage->GetNetworkContext()),
          !clear.avoid_closing_connections && (cookies != 0 || cache),
          std::move(done)));

  std::unique_ptr<content::BrowsingDataFilterBuilder> origins =
      OriginFilterOf(clear);
  storage->ClearData(mask & ~cookies, origins.get(),
                     /*storage_key_policy_matcher=*/base::NullCallback(),
                     network::mojom::CookieDeletionFilter::New(),
                     /*perform_storage_cleanup=*/false, base::Time(),
                     base::Time::Max(), each);
  if (cookies != 0) {
    std::unique_ptr<content::BrowsingDataFilterBuilder> sites =
        CookieFilterOf(clear);
    storage->ClearData(cookies, /*filter_builder=*/nullptr,
                       /*storage_key_policy_matcher=*/base::NullCallback(),
                       sites ? sites->BuildCookieDeletionFilter()
                             : network::mojom::CookieDeletionFilter::New(),
                       /*perform_storage_cleanup=*/false, base::Time(),
                       base::Time::Max(), each);
  } else {
    each.Run();
  }
  if (cache) {
    storage->GetNetworkContext()->ClearHttpCache(
        base::Time(), base::Time::Max(),
        origins ? origins->BuildNetworkServiceFilter() : nullptr, each);
    storage->ClearCodeCaches(base::Time(), base::Time::Max(),
                             origins
                                 ? origins->BuildUrlFilter()
                                 : base::RepeatingCallback<bool(const GURL&)>(),
                             each);
  }
  if (Clears(clear, "downloads")) {
    // The shell's profile holds the partition, so the shell is up.
    RemoveDownloads(*DeskShellContents()->GetBrowserContext(),
                    storage->GetConfig(),
                    origins ? origins->BuildUrlFilter()
                            : base::RepeatingCallback<bool(const GURL&)>());
  }
}

void ClearCodeCaches(const WebViewPartition& partition,
                     const ElectronClearCodeCaches& clear,
                     Done done) {
  content::StoragePartition* storage = StorageOf(partition);
  if (storage == nullptr) {
    Cleared(std::move(done));
    return;
  }
  base::RepeatingCallback<bool(const GURL&)> matcher;
  if (!clear.urls.empty()) {
    matcher =
        base::BindRepeating([](const std::set<GURL>& urls,
                               const GURL& url) { return urls.contains(url); },
                            clear.urls);
  }
  storage->ClearCodeCaches(base::Time(), base::Time::Max(), matcher,
                           base::BindOnce(&Cleared, std::move(done)));
}

// One resolveHost, answering once and going.
class HostResolution final : public network::ResolveHostClientBase {
 public:
  HostResolution(network::mojom::NetworkContext& network,
                 const ElectronResolveHost& resolve,
                 Done done)
      : done_(std::move(done)) {
    auto parameters = network::mojom::ResolveHostParameters::New();
    if (resolve.query_type == "A") {
      parameters->dns_query_type = net::DnsQueryType::A;
    } else if (resolve.query_type == "AAAA") {
      parameters->dns_query_type = net::DnsQueryType::AAAA;
    }
    if (resolve.source == "system") {
      parameters->source = net::HostResolverSource::SYSTEM;
    } else if (resolve.source == "dns") {
      parameters->source = net::HostResolverSource::DNS;
    } else if (resolve.source == "mdns") {
      parameters->source = net::HostResolverSource::MULTICAST_DNS;
    } else if (resolve.source == "localOnly") {
      parameters->source = net::HostResolverSource::LOCAL_ONLY;
    }
    using CacheUsage = network::mojom::ResolveHostParameters::CacheUsage;
    if (resolve.cache_usage == "staleAllowed") {
      parameters->cache_usage = CacheUsage::STALE_ALLOWED;
    } else if (resolve.cache_usage == "disallowed") {
      parameters->cache_usage = CacheUsage::DISALLOWED;
    }
    if (resolve.secure_dns_policy == "disable") {
      parameters->secure_dns_policy = network::mojom::SecureDnsPolicy::DISABLE;
    }
    network.ResolveHost(network::mojom::HostResolverHost::NewHostPortPair(
                            net::HostPortPair(resolve.host, 0)),
                        net::NetworkAnonymizationKey(), std::move(parameters),
                        receiver_.BindNewPipeAndPassRemote());
    // The network service going is an answer too.
    receiver_.set_disconnect_handler(
        base::BindOnce(&HostResolution::Gone, base::Unretained(this)));
  }

  // network::mojom::ResolveHostClient.
  void OnComplete(
      int32_t result,
      const net::ResolveErrorInfo& resolve_error_info,
      const net::AddressList& resolved_addresses,
      const net::HostResolverEndpointResults& endpoint_results) override {
    if (result != net::OK) {
      Finish(base::unexpected(net::ErrorToString(resolve_error_info.error)));
      return;
    }
    base::ListValue endpoints;
    for (const net::IPEndPoint& endpoint : resolved_addresses.endpoints()) {
      const net::AddressFamily family = endpoint.GetFamily();
      endpoints.Append(
          base::DictValue()
              .Set("address", endpoint.ToStringWithoutPort())
              .Set("family", family == net::ADDRESS_FAMILY_IPV4   ? "ipv4"
                             : family == net::ADDRESS_FAMILY_IPV6 ? "ipv6"
                                                                  : "unspec"));
    }
    Finish(
        base::Value(base::DictValue().Set("endpoints", std::move(endpoints))));
  }

 private:
  void Gone() { Finish(base::unexpected("net::ERR_FAILED")); }

  void Finish(base::expected<base::Value, std::string> result) {
    std::move(done_).Run(std::move(result));
    delete this;
  }

  Done done_;
  mojo::Receiver<network::mojom::ResolveHostClient> receiver_{this};
};

void Preconnect(network::mojom::NetworkContext& network,
                const ElectronPreconnect& preconnect) {
  network.PreconnectSockets(
      preconnect.sockets, preconnect.url,
      network::mojom::CredentialsMode::kInclude,
      net::NetworkAnonymizationKey::CreateSameSite(
          net::SchemefulSite(preconnect.url)),
      // No fenced frame restricts these.
      base::UnguessableToken::Create(),
      net::MutableNetworkTrafficAnnotationTag(kPreconnectAnnotation),
      /*keepalive_config=*/std::nullopt,
      /*observer_client=*/mojo::NullRemote());
}

base::expected<net::SharedDictionaryIsolationKey, std::string> IsolationKeyOf(
    const ElectronSharedDictionaryKey& key) {
  const url::Origin frame_origin = url::Origin::Create(key.frame_origin);
  const net::SchemefulSite top_frame_site(key.top_frame_site);
  if (frame_origin.opaque() || top_frame_site.opaque()) {
    return base::unexpected(
        "a shared dictionary's frameOrigin and topFrameSite must not be "
        "opaque");
  }
  return net::SharedDictionaryIsolationKey(frame_origin, top_frame_site);
}

double Milliseconds(base::Time time) {
  return time.InMillisecondsFSinceUnixEpoch();
}

base::Value DictionariesValue(
    std::vector<network::mojom::SharedDictionaryInfoPtr> dictionaries) {
  base::ListValue list;
  for (const network::mojom::SharedDictionaryInfoPtr& each : dictionaries) {
    base::ListValue destinations;
    for (const network::mojom::RequestDestination& destination :
         each->match_dest) {
      destinations.Append(network::RequestDestinationToString(
          destination,
          network::EmptyRequestDestinationOption::kUseTheEmptyString));
    }
    list.Append(
        base::DictValue()
            .Set("match", each->match)
            .Set("matchDestinations", std::move(destinations))
            .Set("id", each->id)
            .Set("dictionaryUrl", each->dictionary_url.spec())
            .Set("lastFetchTime", Milliseconds(each->last_fetch_time))
            .Set("responseTime", Milliseconds(each->response_time))
            .Set("expirationDuration", each->expiration.InMillisecondsF())
            .Set("lastUsedTime", Milliseconds(each->last_used_time))
            .Set("size", static_cast<double>(each->size))
            .Set("hash", base::HexEncode(each->hash)));
  }
  return base::Value(std::move(list));
}

base::Value UsageValue(
    const std::vector<net::SharedDictionaryUsageInfo>& usage) {
  base::ListValue list;
  for (const net::SharedDictionaryUsageInfo& each : usage) {
    list.Append(
        base::DictValue()
            .Set("frameOrigin", each.isolation_key.frame_origin().Serialize())
            .Set("topFrameSite",
                 each.isolation_key.top_frame_site().Serialize())
            .Set("totalSizeBytes", static_cast<double>(each.total_size_bytes)));
  }
  return base::Value(std::move(list));
}

std::string SourceName(blink::mojom::ConsoleMessageSource source) {
  using Source = blink::mojom::ConsoleMessageSource;
  switch (source) {
    case Source::kXml:
      return "xml";
    case Source::kJavaScript:
      return "javascript";
    case Source::kNetwork:
      return "network";
    case Source::kConsoleApi:
      return "console-api";
    case Source::kStorage:
      return "storage";
    case Source::kRendering:
      return "rendering";
    case Source::kSecurity:
      return "security";
    case Source::kDeprecation:
      return "deprecation";
    case Source::kWorker:
      return "worker";
    case Source::kViolation:
      return "violation";
    case Source::kIntervention:
      return "intervention";
    case Source::kRecommendation:
      return "recommendation";
    case Source::kOther:
      return "other";
  }
  NOTREACHED();
}

ElectronRunningServiceWorker WorkerOf(
    int64_t version_id,
    const content::ServiceWorkerRunningInfo& info) {
  return {.version_id = version_id,
          .scope = info.scope,
          .script_url = info.script_url,
          .render_process_id = info.render_process_id.GetUnsafeValue()};
}

// A session's service workers, watched for as long as this lives.
class ServiceWorkerWatch final : public ElectronServiceWorkerWatch,
                                 public content::ServiceWorkerContextObserver {
 public:
  ServiceWorkerWatch(
      content::ServiceWorkerContext& context,
      base::RepeatingCallback<void(const ElectronServiceWorkerChange&)> changed)
      : context_(&context), changed_(std::move(changed)) {
    observation_.Observe(&context);
  }

  // ElectronServiceWorkerWatch.
  std::vector<ElectronRunningServiceWorker> Running() const override {
    std::vector<ElectronRunningServiceWorker> running;
    if (context_ == nullptr) {
      return running;
    }
    for (const auto& [version_id, info] :
         context_->GetRunningServiceWorkerInfos()) {
      running.push_back(WorkerOf(version_id, info));
    }
    return running;
  }

  // content::ServiceWorkerContextObserver.
  void OnRegistrationCompleted(const GURL& scope) override {
    changed_.Run(ElectronServiceWorkerRegistered{.scope = scope});
  }
  void OnVersionStartingRunning(int64_t version_id) override {
    Status(version_id, "starting");
  }
  void OnVersionStartedRunning(
      int64_t version_id,
      const content::ServiceWorkerRunningInfo& running_info) override {
    changed_.Run(ElectronServiceWorkerStatus{
        .version_id = version_id,
        .running_status = "running",
        .worker = WorkerOf(version_id, running_info)});
  }
  void OnVersionStoppingRunning(int64_t version_id) override {
    Status(version_id, "stopping");
  }
  void OnVersionStoppedRunning(int64_t version_id) override {
    Status(version_id, "stopped");
  }
  void OnReportConsoleMessage(int64_t version_id,
                              const GURL& scope,
                              const content::ConsoleMessage& message) override {
    changed_.Run(ElectronServiceWorkerConsole{
        .version_id = version_id,
        .message = base::UTF16ToUTF8(message.message),
        .source = SourceName(message.source),
        .level = static_cast<int>(message.message_level),
        .source_url = message.source_url,
        .line_number = message.line_number});
  }
  void OnDestruct(content::ServiceWorkerContext* context) override {
    observation_.Reset();
    context_ = nullptr;
  }

 private:
  void Status(int64_t version_id, std::string status) {
    changed_.Run(ElectronServiceWorkerStatus{
        .version_id = version_id, .running_status = std::move(status)});
  }

  raw_ptr<content::ServiceWorkerContext> context_;
  const base::RepeatingCallback<void(const ElectronServiceWorkerChange&)>
      changed_;
  base::ScopedObservation<content::ServiceWorkerContext,
                          content::ServiceWorkerContextObserver>
      observation_{this};
};

}  // namespace

void RunElectronNetworkCall(const WebViewPartition& partition,
                            const ElectronNetworkCall& call,
                            Done done) {
  if (const auto* clear = std::get_if<ElectronClearData>(&call)) {
    ClearData(partition, *clear, std::move(done));
    return;
  } else if (const auto* code = std::get_if<ElectronClearCodeCaches>(&call)) {
    ClearCodeCaches(partition, *code, std::move(done));
    return;
  }
  content::StoragePartition* storage = StorageOf(partition);
  if (storage == nullptr) {
    // Nothing to clear, and nothing to ask.
    if (std::holds_alternative<ElectronClearAuthCache>(call) ||
        std::holds_alternative<ElectronPreconnect>(call) ||
        std::holds_alternative<ElectronClearSharedDictionaries>(call)) {
      Cleared(std::move(done));
    } else {
      std::move(done).Run(
          base::unexpected("there is no shell, so no session to ask"));
    }
    return;
  }
  network::mojom::NetworkContext& network = *storage->GetNetworkContext();
  if (std::holds_alternative<ElectronClearAuthCache>(call)) {
    network.ClearHttpAuthCache(base::Time(), base::Time::Max(),
                               /*filter=*/nullptr,
                               base::BindOnce(&Cleared, std::move(done)));
  } else if (const auto* resolve = std::get_if<ElectronResolveHost>(&call)) {
    // Deletes itself once answered.
    new HostResolution(network, *resolve, std::move(done));
  } else if (const auto* preconnect = std::get_if<ElectronPreconnect>(&call)) {
    Preconnect(network, *preconnect);
    Cleared(std::move(done));
  } else if (const auto* code_cache =
                 std::get_if<ElectronSetCodeCachePath>(&call)) {
    content::SetDomicileCodeCachePath(*storage, code_cache->path);
    Cleared(std::move(done));
  } else if (std::holds_alternative<ElectronStoragePath>(call)) {
    // An in-memory session keeps nothing on disk.
    const base::FilePath& path = storage->GetPath();
    std::move(done).Run(partition.persist && !path.empty()
                            ? base::Value(path.value())
                            : base::Value());
  } else if (const auto* clear =
                 std::get_if<ElectronClearSharedDictionaries>(&call)) {
    if (!clear->key.has_value()) {
      network.ClearSharedDictionaryCache(
          base::Time(), base::Time::Max(), /*filter=*/nullptr,
          base::BindOnce(&Cleared, std::move(done)));
      return;
    }
    base::expected<net::SharedDictionaryIsolationKey, std::string> key =
        IsolationKeyOf(*clear->key);
    if (!key.has_value()) {
      std::move(done).Run(base::unexpected(std::move(key.error())));
      return;
    }
    network.ClearSharedDictionaryCacheForIsolationKey(
        *key, base::BindOnce(&Cleared, std::move(done)));
  } else if (const auto* get =
                 std::get_if<ElectronGetSharedDictionaryInfo>(&call)) {
    base::expected<net::SharedDictionaryIsolationKey, std::string> key =
        IsolationKeyOf(get->key);
    if (!key.has_value()) {
      std::move(done).Run(base::unexpected(std::move(key.error())));
      return;
    }
    network.GetSharedDictionaryInfo(
        *key, base::BindOnce(&DictionariesValue)
                  .Then(base::BindOnce(&Answer, std::move(done))));
  } else {
    CHECK(std::holds_alternative<ElectronGetSharedDictionaryUsage>(call));
    network.GetSharedDictionaryUsageInfo(
        base::BindOnce(&UsageValue)
            .Then(base::BindOnce(&Answer, std::move(done))));
  }
}

std::unique_ptr<ElectronServiceWorkerWatch> WatchElectronServiceWorkers(
    const WebViewPartition& partition,
    base::RepeatingCallback<void(const ElectronServiceWorkerChange&)> changed) {
  content::StoragePartition* storage = StorageOf(partition);
  if (storage == nullptr) {
    return std::make_unique<ElectronServiceWorkerWatch>();
  }
  return std::make_unique<ServiceWorkerWatch>(
      *storage->GetServiceWorkerContext(), std::move(changed));
}

}  // namespace domicile
