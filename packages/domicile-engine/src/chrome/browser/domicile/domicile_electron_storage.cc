// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "chrome/browser/domicile/domicile_electron_storage.h"

#include <cstdint>
#include <memory>
#include <optional>
#include <set>
#include <string>
#include <utility>
#include <vector>

#include "base/check_op.h"
#include "base/functional/bind.h"
#include "base/notreached.h"
#include "base/time/time.h"
#include "chrome/browser/domicile/domicile_browser_windows.h"
#include "content/public/browser/browser_context.h"
#include "content/public/browser/storage_partition.h"
#include "content/public/browser/storage_partition_config.h"
#include "content/public/browser/web_contents.h"
#include "mojo/public/cpp/bindings/receiver.h"
#include "net/cookies/canonical_cookie.h"
#include "net/cookies/cookie_access_result.h"
#include "net/cookies/cookie_change_dispatcher.h"
#include "net/cookies/cookie_constants.h"
#include "net/cookies/cookie_inclusion_status.h"
#include "net/cookies/cookie_options.h"
#include "net/cookies/cookie_partition_key_collection.h"
#include "services/network/public/mojom/clear_data_filter.mojom.h"
#include "services/network/public/mojom/cookie_manager.mojom.h"
#include "services/network/public/mojom/network_context.mojom.h"

namespace domicile {

content::StoragePartition* StorageOf(const WebViewPartition& partition) {
  content::WebContents* shell = DeskShellContents();
  if (shell == nullptr) {
    return nullptr;
  }
  content::BrowserContext* context = shell->GetBrowserContext();
  return context->GetStoragePartition(content::StoragePartitionConfig::Create(
      context, kWebViewPartitionDomain, partition.name, !partition.persist));
}

namespace {

std::string SameSiteName(net::CookieSameSite same_site) {
  switch (same_site) {
    case net::CookieSameSite::NO_RESTRICTION:
      return "no_restriction";
    case net::CookieSameSite::LAX_MODE:
      return "lax";
    case net::CookieSameSite::STRICT_MODE:
      return "strict";
    default:
      return "unspecified";
  }
}

net::CookieSameSite SameSiteNamed(const std::string& name) {
  if (name == "no_restriction") {
    return net::CookieSameSite::NO_RESTRICTION;
  } else if (name == "lax") {
    return net::CookieSameSite::LAX_MODE;
  } else if (name == "strict") {
    return net::CookieSameSite::STRICT_MODE;
  }
  return net::CookieSameSite::UNSPECIFIED;
}

ElectronCookie CookieOf(const net::CanonicalCookie& cookie) {
  return ElectronCookie{
      .name = cookie.Name(),
      .value = cookie.Value(),
      .domain = cookie.Domain(),
      .host_only = cookie.IsHostCookie(),
      .path = cookie.Path(),
      .secure = cookie.SecureAttribute(),
      .http_only = cookie.IsHttpOnly(),
      .expiration_date =
          cookie.IsPersistent()
              ? std::optional(cookie.ExpiryDate().InSecondsFSinceUnixEpoch())
              : std::nullopt,
      .same_site = SameSiteName(cookie.SameSite())};
}

// Electron's name for why a cookie changed, as session.cookies' `changed`
// gives it.
std::string CauseName(net::CookieChangeCause cause) {
  switch (cause) {
    case net::CookieChangeCause::INSERTED:
      return "inserted";
    case net::CookieChangeCause::INSERTED_NO_CHANGE_OVERWRITE:
      return "inserted-no-change-overwrite";
    case net::CookieChangeCause::INSERTED_NO_VALUE_CHANGE_OVERWRITE:
      return "inserted-no-value-change-overwrite";
    case net::CookieChangeCause::EXPLICIT:
    // Electron has no name of its own for a deletion it knows nothing about.
    case net::CookieChangeCause::UNKNOWN_DELETION:
      return "explicit";
    case net::CookieChangeCause::OVERWRITE:
      return "overwrite";
    case net::CookieChangeCause::EXPIRED:
      return "expired";
    case net::CookieChangeCause::EVICTED:
      return "evicted";
    case net::CookieChangeCause::EXPIRED_OVERWRITE:
      return "expired-overwrite";
  }
  NOTREACHED();
}

// A watch on a partition's cookies: the network service's listener for
// every change, which ends when this closes its pipe.
class CookieWatch final : public ElectronCookieWatch,
                          public network::mojom::CookieChangeListener {
 public:
  CookieWatch(
      network::mojom::CookieManager* cookies,
      base::RepeatingCallback<void(const ElectronCookieChange&)> changed)
      : changed_(std::move(changed)) {
    cookies->AddGlobalChangeListener(receiver_.BindNewPipeAndPassRemote());
  }
  ~CookieWatch() override = default;

  // network::mojom::CookieChangeListener:
  void OnCookieChange(const net::CookieChangeInfo& change) override {
    changed_.Run(ElectronCookieChange{
        .cookie = CookieOf(change.cookie),
        .cause = CauseName(change.cause),
        .removed = net::CookieChangeCauseIsDeletion(change.cause)});
  }

 private:
  base::RepeatingCallback<void(const ElectronCookieChange&)> changed_;
  mojo::Receiver<network::mojom::CookieChangeListener> receiver_{this};
};

// Electron's names for clearStorageData's storages, as content's.
uint32_t RemoveMaskOf(const std::set<std::string>& storages) {
  using Partition = content::StoragePartition;
  if (storages.empty()) {
    return Partition::REMOVE_DATA_MASK_ALL;
  }
  uint32_t mask = 0;
  for (const std::string& storage : storages) {
    if (storage == "cookies") {
      mask |= Partition::REMOVE_DATA_MASK_COOKIES;
    } else if (storage == "filesystem") {
      mask |= Partition::REMOVE_DATA_MASK_FILE_SYSTEMS;
    } else if (storage == "indexdb") {
      mask |= Partition::REMOVE_DATA_MASK_INDEXEDDB;
    } else if (storage == "localstorage") {
      mask |= Partition::REMOVE_DATA_MASK_LOCAL_STORAGE;
    } else if (storage == "shadercache") {
      mask |= Partition::REMOVE_DATA_MASK_SHADER_CACHE;
    } else if (storage == "websql") {
      mask |= Partition::REMOVE_DATA_MASK_WEBSQL_DEPRECATED;
    } else if (storage == "serviceworkers") {
      mask |= Partition::REMOVE_DATA_MASK_SERVICE_WORKERS;
    } else {
      // The protocol takes only the names IsElectronStorage knows.
      CHECK_EQ(storage, "cachestorage");
      mask |= Partition::REMOVE_DATA_MASK_CACHE_STORAGE;
    }
  }
  return mask;
}

}  // namespace

void GetElectronCookies(
    const WebViewPartition& partition,
    const std::optional<GURL>& url,
    base::OnceCallback<void(std::vector<ElectronCookie>)> done) {
  content::StoragePartition* storage = StorageOf(partition);
  if (storage == nullptr) {
    std::move(done).Run({});
    return;
  }
  network::mojom::CookieManager* cookies =
      storage->GetCookieManagerForBrowserProcess();
  if (!url.has_value()) {
    cookies->GetAllCookies(base::BindOnce(
        [](base::OnceCallback<void(std::vector<ElectronCookie>)> done,
           const std::vector<net::CanonicalCookie>& found) {
          std::vector<ElectronCookie> all;
          for (const net::CanonicalCookie& cookie : found) {
            all.push_back(CookieOf(cookie));
          }
          std::move(done).Run(std::move(all));
        },
        std::move(done)));
    return;
  }
  // Every cookie a request to `url` could carry, as Electron gives: same-site
  // or not, HTTP-only or not.
  cookies->GetCookieList(
      *url, net::CookieOptions::MakeAllInclusive(),
      net::CookiePartitionKeyCollection::ContainsAll(),
      base::BindOnce(
          [](base::OnceCallback<void(std::vector<ElectronCookie>)> done,
             const std::vector<net::CookieWithAccessResult>& included,
             const std::vector<net::CookieWithAccessResult>& excluded) {
            std::vector<ElectronCookie> sent;
            for (const net::CookieWithAccessResult& cookie : included) {
              sent.push_back(CookieOf(cookie.cookie));
            }
            std::move(done).Run(std::move(sent));
          },
          std::move(done)));
}

void SetElectronCookie(
    const WebViewPartition& partition,
    const ElectronCookieDetails& details,
    base::OnceCallback<void(std::optional<std::string> why)> done) {
  content::StoragePartition* storage = StorageOf(partition);
  if (storage == nullptr) {
    std::move(done).Run("there is no shell to keep it");
    return;
  }
  const base::Time now = base::Time::Now();
  net::CookieInclusionStatus status;
  std::unique_ptr<net::CanonicalCookie> cookie =
      net::CanonicalCookie::CreateSanitizedCookie(
          details.url, details.name, details.value, details.domain.value_or(""),
          details.path.value_or(""), now,
          details.expiration_date.has_value()
              ? base::Time::FromSecondsSinceUnixEpoch(*details.expiration_date)
              : base::Time(),
          now, details.secure, details.http_only,
          SameSiteNamed(details.same_site), net::COOKIE_PRIORITY_DEFAULT,
          /*partition_key=*/std::nullopt, &status);
  if (!cookie) {
    std::move(done).Run(status.GetDebugString());
    return;
  }
  storage->GetCookieManagerForBrowserProcess()->SetCanonicalCookie(
      *cookie, details.url, net::CookieOptions::MakeAllInclusive(),
      base::BindOnce(
          [](base::OnceCallback<void(std::optional<std::string>)> done,
             net::CookieAccessResult result) {
            std::move(done).Run(
                result.status.IsInclude()
                    ? std::nullopt
                    : std::optional(result.status.GetDebugString()));
          },
          std::move(done)));
}

void RemoveElectronCookie(const WebViewPartition& partition,
                          const GURL& url,
                          const std::string& name,
                          base::OnceClosure done) {
  content::StoragePartition* storage = StorageOf(partition);
  if (storage == nullptr) {
    std::move(done).Run();
    return;
  }
  auto filter = network::mojom::CookieDeletionFilter::New();
  filter->url = url;
  filter->cookie_name = name;
  storage->GetCookieManagerForBrowserProcess()->DeleteCookies(
      std::move(filter),
      base::BindOnce([](base::OnceClosure done,
                        uint32_t deleted) { std::move(done).Run(); },
                     std::move(done)));
}

void FlushElectronCookies(const WebViewPartition& partition,
                          base::OnceClosure done) {
  content::StoragePartition* storage = StorageOf(partition);
  if (storage == nullptr) {
    std::move(done).Run();
    return;
  }
  storage->GetCookieManagerForBrowserProcess()->FlushCookieStore(
      std::move(done));
}

std::unique_ptr<ElectronCookieWatch> WatchElectronCookies(
    const WebViewPartition& partition,
    base::RepeatingCallback<void(const ElectronCookieChange&)> changed) {
  content::StoragePartition* storage = StorageOf(partition);
  if (storage == nullptr) {
    return std::make_unique<ElectronCookieWatch>();
  }
  return std::make_unique<CookieWatch>(
      storage->GetCookieManagerForBrowserProcess(), std::move(changed));
}

void ClearElectronStorage(const WebViewPartition& partition,
                          const ElectronClearStorage& clear,
                          base::OnceClosure done) {
  content::StoragePartition* storage = StorageOf(partition);
  if (storage == nullptr) {
    std::move(done).Run();
    return;
  }
  const uint32_t mask = RemoveMaskOf(clear.storages);
  if (clear.origin.has_value()) {
    storage->ClearDataForOrigin(mask, *clear.origin, std::move(done));
    return;
  }
  storage->ClearData(mask, /*filter_builder=*/nullptr,
                     /*storage_key_policy_matcher=*/base::NullCallback(),
                     network::mojom::CookieDeletionFilter::New(),
                     /*perform_storage_cleanup=*/false, base::Time(),
                     base::Time::Max(), std::move(done));
}

void ClearElectronCache(const WebViewPartition& partition,
                        base::OnceClosure done) {
  content::StoragePartition* storage = StorageOf(partition);
  if (storage == nullptr) {
    std::move(done).Run();
    return;
  }
  storage->GetNetworkContext()->ClearHttpCache(base::Time(), base::Time::Max(),
                                               /*filter=*/nullptr,
                                               std::move(done));
}

}  // namespace domicile
