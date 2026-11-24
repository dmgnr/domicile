// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "chrome/browser/domicile/domicile_electron_web_request.h"

#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <utility>

#include "base/functional/bind.h"
#include "base/memory/scoped_refptr.h"
#include "base/memory/weak_ptr.h"
#include "base/strings/strcat.h"
#include "base/strings/string_util.h"
#include "base/strings/utf_string_conversions.h"
#include "components/domicile/browser/electron_app.h"
#include "components/domicile/browser/electron_protocol.h"
#include "content/public/browser/network_service_instance.h"
#include "mojo/public/cpp/bindings/receiver.h"
#include "mojo/public/cpp/bindings/remote.h"
#include "net/base/net_errors.h"
#include "net/http/http_request_headers.h"
#include "net/http/http_response_headers.h"
#include "net/http/http_status_code.h"
#include "net/http/http_util.h"
#include "net/url_request/redirect_info.h"
#include "services/network/public/cpp/http_request_headers_update_params.h"
#include "services/network/public/cpp/resource_request.h"
#include "services/network/public/cpp/url_loader_completion_status.h"
#include "services/network/public/mojom/early_hints.mojom.h"
#include "services/network/public/mojom/fetch_api.mojom-shared.h"
#include "services/network/public/mojom/network_service.mojom.h"
#include "services/network/public/mojom/parsed_headers.mojom.h"
#include "services/network/public/mojom/url_loader.mojom.h"
#include "services/network/public/mojom/url_loader_factory.mojom.h"
#include "services/network/public/mojom/url_response_head.mojom.h"
#include "url/origin.h"

namespace domicile {
namespace {

using Event = ElectronWebRequestEvent;

// A header value as JavaScript reads it: bytes that are not UTF-8 become
// the characters with their codes, as fetch's Headers shows them.
std::string AsCharacters(std::string_view value) {
  if (base::IsStringUTF8(value)) {
    return std::string(value);
  }
  std::u16string characters;
  for (char byte : value) {
    characters.push_back(static_cast<unsigned char>(byte));
  }
  return base::UTF16ToUTF8(characters);
}

ElectronHeaders RequestHeadersOf(const net::HttpRequestHeaders& headers) {
  ElectronHeaders pairs;
  for (const net::HttpRequestHeaders::HeaderKeyValuePair& header :
       headers.GetHeaderVector()) {
    pairs.emplace_back(header.key, AsCharacters(header.value));
  }
  return pairs;
}

ElectronHeaders ResponseHeadersOf(const net::HttpResponseHeaders& headers) {
  ElectronHeaders pairs;
  size_t iterator = 0;
  std::string name;
  std::string value;
  while (headers.EnumerateHeaderLines(&iterator, &name, &value)) {
    pairs.emplace_back(name, AsCharacters(value));
  }
  return pairs;
}

// Electron's resourceType for what `request` loads.
std::string ResourceTypeOf(const network::ResourceRequest& request) {
  using network::mojom::RequestDestination;
  switch (request.destination) {
    case RequestDestination::kDocument:
      return "mainFrame";
    case RequestDestination::kFrame:
    case RequestDestination::kIframe:
    case RequestDestination::kFencedframe:
      return "subFrame";
    case RequestDestination::kStyle:
      return "stylesheet";
    case RequestDestination::kScript:
    case RequestDestination::kWorker:
    case RequestDestination::kSharedWorker:
    case RequestDestination::kServiceWorker:
    case RequestDestination::kAudioWorklet:
    case RequestDestination::kPaintWorklet:
      return "script";
    case RequestDestination::kImage:
      return "image";
    case RequestDestination::kFont:
      return "font";
    case RequestDestination::kObject:
    case RequestDestination::kEmbed:
      return "object";
    case RequestDestination::kAudio:
    case RequestDestination::kVideo:
    case RequestDestination::kTrack:
      return "media";
    case RequestDestination::kReport:
      return "cspReport";
    case RequestDestination::kEmpty:
      // fetch() and XMLHttpRequest.
      return "xhr";
    default:
      return "other";
  }
}

// The update that turns `before` into `after`.
network::HttpRequestHeadersUpdateParams UpdateBetween(
    const net::HttpRequestHeaders& before,
    const net::HttpRequestHeaders& after) {
  network::HttpRequestHeadersUpdateParams update;
  for (const net::HttpRequestHeaders::HeaderKeyValuePair& header :
       before.GetHeaderVector()) {
    if (!after.HasHeader(header.key)) {
      update.RemoveHeader(header.key);
    }
  }
  for (const net::HttpRequestHeaders::HeaderKeyValuePair& header :
       after.GetHeaderVector()) {
    if (before.GetHeader(header.key) != header.value) {
      update.SetHeader(header.key, header.value);
    }
  }
  return update;
}

// One request of an Electron page that goes to the network, walked through
// its session's webRequest listeners. Owns itself: goes once the page has
// its answer, or stops listening.
class ElectronWebRequestLoader final : public network::mojom::URLLoader,
                                       public network::mojom::URLLoaderClient {
 public:
  ElectronWebRequestLoader(
      base::WeakPtr<ElectronSession> session,
      std::optional<std::string> window,
      mojo::PendingRemote<network::mojom::URLLoaderFactory> network,
      int32_t request_id,
      uint32_t options,
      const network::ResourceRequest& request,
      mojo::PendingReceiver<network::mojom::URLLoader> loader,
      mojo::PendingRemote<network::mojom::URLLoaderClient> client,
      const net::MutableNetworkTrafficAnnotationTag& traffic_annotation)
      : session_(std::move(session)),
        window_(std::move(window)),
        network_(std::move(network)),
        request_id_(request_id),
        options_(options),
        request_(request),
        traffic_annotation_(traffic_annotation),
        loader_receiver_(this, std::move(loader)),
        client_(std::move(client)) {
    // Each request keeps one id through its redirects, as in Electron.
    static int next_id = 1;
    id_ = next_id++;
    loader_receiver_.set_disconnect_handler(
        base::BindOnce(&ElectronWebRequestLoader::Fail, base::Unretained(this),
                       net::ERR_ABORTED));
    client_.set_disconnect_handler(
        base::BindOnce(&ElectronWebRequestLoader::Fail, base::Unretained(this),
                       net::ERR_ABORTED));
  }

  ElectronWebRequestLoader(const ElectronWebRequestLoader&) = delete;
  ElectronWebRequestLoader& operator=(const ElectronWebRequestLoader&) = delete;

  // onBeforeRequest, the first of the request's events, and of each
  // redirect's.
  void BeforeRequest() {
    Ask(Event::kBeforeRequest, Details(),
        base::BindOnce(&ElectronWebRequestLoader::AfterBeforeRequest,
                       weak_factory_.GetWeakPtr()));
  }

  // network::mojom::URLLoader:
  void FollowRedirect(
      network::HttpRequestHeadersUpdateParams headers_update_params,
      const std::optional<GURL>& new_url) override {
    if (!redirect_.has_value()) {
      loader_receiver_.ReportBadMessage(
          "followed a redirect the request was not given");
      delete this;
      return;
    }
    const net::RedirectInfo redirect = *std::exchange(redirect_, std::nullopt);
    headers_before_follow_ = request_.headers;
    headers_update_params.Apply(request_.headers, request_.cors_exempt_headers);
    request_.url = new_url.value_or(redirect.new_url);
    request_.method = redirect.new_method;
    request_.site_for_cookies = redirect.new_site_for_cookies;
    request_.referrer = GURL(redirect.new_referrer);
    request_.referrer_policy = redirect.new_referrer_policy;
    follow_new_url_ = new_url;
    BeforeRequest();
  }
  void SetPriority(net::RequestPriority priority,
                   int32_t intra_priority_value) override {
    if (target_) {
      target_->SetPriority(priority, intra_priority_value);
    }
  }

  // network::mojom::URLLoaderClient:
  void OnReceiveEarlyHints(network::mojom::EarlyHintsPtr early_hints) override {
    client_->OnReceiveEarlyHints(std::move(early_hints));
  }
  void OnReceiveResponse(
      network::mojom::URLResponseHeadPtr head,
      mojo::ScopedDataPipeConsumerHandle body,
      std::optional<mojo_base::BigBuffer> cached_metadata) override {
    response_ = std::move(head);
    body_ = std::move(body);
    cached_metadata_ = std::move(cached_metadata);
    // Nothing more from the network until the listener has answered.
    network_client_.Pause();
    Ask(Event::kHeadersReceived, Details(),
        base::BindOnce(&ElectronWebRequestLoader::AfterHeadersReceived,
                       weak_factory_.GetWeakPtr()));
  }
  void OnReceiveRedirect(const net::RedirectInfo& redirect_info,
                         network::mojom::URLResponseHeadPtr head) override {
    response_ = head.Clone();
    ElectronWebRequestDetails details = Details();
    details.redirect_url = redirect_info.new_url;
    Tell(Event::kBeforeRedirect, std::move(details));
    response_ = nullptr;
    redirect_ = redirect_info;
    client_->OnReceiveRedirect(redirect_info, std::move(head));
  }
  void OnUploadProgress(int64_t current_position,
                        int64_t total_size,
                        OnUploadProgressCallback callback) override {
    client_->OnUploadProgress(current_position, total_size,
                              std::move(callback));
  }
  void OnTransferSizeUpdated(int32_t transfer_size_diff) override {
    client_->OnTransferSizeUpdated(transfer_size_diff);
  }
  void OnComplete(const network::URLLoaderCompletionStatus& status) override {
    ElectronWebRequestDetails details = Details();
    if (status.error_code == net::OK) {
      Tell(Event::kCompleted, std::move(details));
    } else {
      details.error = net::ErrorToString(status.error_code);
      Tell(Event::kErrorOccurred, std::move(details));
    }
    client_->OnComplete(status);
    delete this;
  }

 private:
  ~ElectronWebRequestLoader() override = default;

  ElectronWebRequestDetails Details() const {
    ElectronWebRequestDetails details{.id = id_,
                                      .url = request_.url,
                                      .method = request_.method,
                                      .resource_type = ResourceTypeOf(request_),
                                      .referrer = request_.referrer.is_valid()
                                                      ? request_.referrer.spec()
                                                      : std::string()};
    if (response_ && response_->headers) {
      details.response_headers = ResponseHeadersOf(*response_->headers);
      details.status_code = response_->headers->response_code();
      details.status_line = AsCharacters(response_->headers->GetStatusLine());
      details.from_cache = response_->was_fetched_via_cache;
      if (response_->remote_endpoint.address().IsValid()) {
        details.ip = response_->remote_endpoint.ToStringWithoutPort();
      }
    }
    return details;
  }

  // Asks the session's listener for `event`, or goes straight on when there
  // is none.
  void Ask(Event event,
           ElectronWebRequestDetails details,
           ElectronWebRequestAnswered answered) {
    if (!session_) {
      // The app went: its pages close with it.
      Fail(net::ERR_ABORTED);
      return;
    } else if (!session_->ListensFor(event)) {
      std::move(answered).Run(ElectronWebRequestAnswer());
      return;
    }
    session_->AskWebRequest(event, window_, std::move(details),
                            std::move(answered));
  }

  void Tell(Event event, ElectronWebRequestDetails details) {
    if (session_ && session_->ListensFor(event)) {
      session_->TellWebRequest(event, window_, std::move(details));
    }
  }

  void AfterBeforeRequest(ElectronWebRequestAnswer answer) {
    if (answer.cancel) {
      Fail(net::ERR_BLOCKED_BY_CLIENT);
    } else if (answer.redirect_url.has_value()) {
      RedirectFromTheApp(*answer.redirect_url);
    } else {
      ElectronWebRequestDetails details = Details();
      details.request_headers = RequestHeadersOf(request_.headers);
      Ask(Event::kBeforeSendHeaders, std::move(details),
          base::BindOnce(&ElectronWebRequestLoader::AfterBeforeSendHeaders,
                         weak_factory_.GetWeakPtr()));
    }
  }

  void AfterBeforeSendHeaders(ElectronWebRequestAnswer answer) {
    if (answer.cancel) {
      Fail(net::ERR_BLOCKED_BY_CLIENT);
      return;
    }
    if (answer.request_headers.has_value()) {
      // All of them, as Electron's requestHeaders are.
      request_.headers.Clear();
      for (const auto& [name, value] : *answer.request_headers) {
        request_.headers.SetHeader(name, value);
      }
    }
    ElectronWebRequestDetails details = Details();
    details.request_headers = RequestHeadersOf(request_.headers);
    Tell(Event::kSendHeaders, std::move(details));
    if (target_) {
      // A redirect the network gave: it goes on with the headers as the
      // page and the listener left them.
      target_->FollowRedirect(
          UpdateBetween(*std::exchange(headers_before_follow_, std::nullopt),
                        request_.headers),
          std::exchange(follow_new_url_, std::nullopt));
      return;
    }
    network_->CreateLoaderAndStart(
        target_.BindNewPipeAndPassReceiver(), request_id_, options_, request_,
        network_client_.BindNewPipeAndPassRemote(), traffic_annotation_);
    // The network ends a load through its client, OnComplete; a client
    // that goes without one is a network service that went.
    network_client_.set_disconnect_handler(
        base::BindOnce(&ElectronWebRequestLoader::Fail, base::Unretained(this),
                       net::ERR_FAILED));
  }

  void AfterHeadersReceived(ElectronWebRequestAnswer answer) {
    if (answer.cancel) {
      Fail(net::ERR_BLOCKED_BY_CLIENT);
      return;
    } else if (!answer.response_headers.has_value() &&
               !answer.status_line.has_value()) {
      StartResponse();
      return;
    }
    std::string raw =
        answer.status_line.value_or(response_->headers->GetStatusLine());
    raw.push_back('\n');
    for (const auto& [name, value] : answer.response_headers.value_or(
             ResponseHeadersOf(*response_->headers))) {
      base::StrAppend(&raw, {name, ": ", value, "\n"});
    }
    raw.push_back('\n');
    response_->headers = base::MakeRefCounted<net::HttpResponseHeaders>(
        net::HttpUtil::AssembleRawHeaders(raw));
    const std::string type = ResourceTypeOf(request_);
    if (type != "mainFrame" && type != "subFrame") {
      // Only a document reads the parsed headers.
      StartResponse();
      return;
    }
    // A document's CSP, Permissions-Policy and the rest follow the app's
    // headers, as they do in Electron.
    content::GetNetworkService()->ParseHeaders(
        request_.url, response_->headers,
        base::BindOnce(&ElectronWebRequestLoader::Parsed,
                       weak_factory_.GetWeakPtr()));
  }

  void Parsed(network::mojom::ParsedHeadersPtr parsed) {
    response_->parsed_headers = std::move(parsed);
    StartResponse();
  }

  void StartResponse() {
    Tell(Event::kResponseStarted, Details());
    client_->OnReceiveResponse(response_.Clone(), std::move(body_),
                               std::move(cached_metadata_));
    network_client_.Resume();
  }

  // onBeforeRequest's redirectURL: the page is told of a redirect the
  // network never gave, and follows it to a request that starts again.
  void RedirectFromTheApp(const GURL& url) {
    target_.reset();
    network_client_.reset();
    headers_before_follow_.reset();
    follow_new_url_.reset();
    const net::RedirectInfo redirect = net::RedirectInfo::ComputeRedirectInfo(
        request_.method, request_.url, request_.site_for_cookies,
        request_.update_first_party_url_on_redirect
            ? net::RedirectInfo::FirstPartyURLPolicy::UPDATE_URL_ON_REDIRECT
            : net::RedirectInfo::FirstPartyURLPolicy::NEVER_CHANGE_URL,
        request_.referrer_policy, request_.referrer.spec(),
        request_.request_initiator, net::HTTP_TEMPORARY_REDIRECT, url,
        /*referrer_policy_header=*/std::nullopt,
        /*insecure_scheme_was_upgraded=*/false, /*copy_fragment=*/false,
        /*is_signed_exchange_fallback_redirect=*/false);
    auto head = network::mojom::URLResponseHead::New();
    head->headers = base::MakeRefCounted<net::HttpResponseHeaders>(
        net::HttpUtil::AssembleRawHeaders(base::StrCat(
            {"HTTP/1.1 307 Internal Redirect\nLocation: ", url.spec(),
             "\nNon-Authoritative-Reason: WebRequest API\n\n"})));
    head->encoded_data_length = 0;
    // A cross-origin redirect taints the request's origin, as fetch says.
    if (request_.request_initiator &&
        !url::IsSameOriginWith(url, request_.url) &&
        !request_.request_initiator->IsSameOriginWith(request_.url)) {
      request_.request_initiator = url::Origin();
    }
    response_ = head.Clone();
    ElectronWebRequestDetails details = Details();
    details.redirect_url = url;
    Tell(Event::kBeforeRedirect, std::move(details));
    response_ = nullptr;
    redirect_ = redirect;
    client_->OnReceiveRedirect(redirect, std::move(head));
  }

  // Ends the request with `error`, before the page has a response.
  void Fail(int error) {
    ElectronWebRequestDetails details = Details();
    details.error = net::ErrorToString(error);
    Tell(Event::kErrorOccurred, std::move(details));
    if (client_.is_connected()) {
      client_->OnComplete(network::URLLoaderCompletionStatus(error));
    }
    delete this;
  }

  const base::WeakPtr<ElectronSession> session_;
  const std::optional<std::string> window_;
  mojo::Remote<network::mojom::URLLoaderFactory> network_;
  const int32_t request_id_;
  const uint32_t options_;
  network::ResourceRequest request_;
  const net::MutableNetworkTrafficAnnotationTag traffic_annotation_;
  int id_ = 0;

  // The page's end: what it asks of the load, and where its answer goes.
  mojo::Receiver<network::mojom::URLLoader> loader_receiver_;
  mojo::Remote<network::mojom::URLLoaderClient> client_;
  // The network's end, once the request has started.
  mojo::Remote<network::mojom::URLLoader> target_;
  mojo::Receiver<network::mojom::URLLoaderClient> network_client_{this};

  // The redirect the page was given and has yet to follow.
  std::optional<net::RedirectInfo> redirect_;
  // While following a redirect the network gave: the headers before the
  // page's update, and the URL the page asked for instead.
  std::optional<net::HttpRequestHeaders> headers_before_follow_;
  std::optional<GURL> follow_new_url_;

  // The response, while its listener decides.
  network::mojom::URLResponseHeadPtr response_;
  mojo::ScopedDataPipeConsumerHandle body_;
  std::optional<mojo_base::BigBuffer> cached_metadata_;

  base::WeakPtrFactory<ElectronWebRequestLoader> weak_factory_{this};
};

}  // namespace

void StartElectronWebRequest(
    base::WeakPtr<ElectronSession> session,
    std::optional<std::string> window,
    mojo::PendingRemote<network::mojom::URLLoaderFactory> network,
    int32_t request_id,
    uint32_t options,
    const network::ResourceRequest& request,
    mojo::PendingReceiver<network::mojom::URLLoader> loader,
    mojo::PendingRemote<network::mojom::URLLoaderClient> client,
    const net::MutableNetworkTrafficAnnotationTag& traffic_annotation) {
  // Deletes itself.
  (new ElectronWebRequestLoader(std::move(session), std::move(window),
                                std::move(network), request_id, options,
                                request, std::move(loader), std::move(client),
                                traffic_annotation))
      ->BeforeRequest();
}

}  // namespace domicile
