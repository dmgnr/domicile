// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "chrome/browser/domicile/domicile_electron_loader.h"

#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <variant>
#include <vector>

#include "base/byte_size.h"
#include "base/containers/circular_deque.h"
#include "base/containers/span.h"
#include "base/functional/bind.h"
#include "base/logging.h"
#include "base/memory/self_deleting.h"
#include "base/memory/weak_ptr.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/string_util.h"
#include "base/strings/string_view_util.h"
#include "base/strings/utf_string_conversions.h"
#include "chrome/browser/domicile/domicile_electron_page.h"
#include "chrome/browser/domicile/domicile_electron_web_request.h"
#include "components/domicile/browser/electron_app.h"
#include "components/domicile/browser/electron_protocol.h"
#include "components/domicile/browser/web_view_guest.h"
#include "content/public/browser/file_url_loader.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
#include "mojo/public/cpp/bindings/receiver.h"
#include "mojo/public/cpp/bindings/remote.h"
#include "mojo/public/cpp/system/data_pipe.h"
#include "mojo/public/cpp/system/data_pipe_drainer.h"
#include "mojo/public/cpp/system/data_pipe_producer.h"
#include "mojo/public/cpp/system/string_data_source.h"
#include "net/base/filename_util.h"
#include "net/base/mime_util.h"
#include "net/base/net_errors.h"
#include "net/http/http_request_headers.h"
#include "net/http/http_response_headers.h"
#include "net/http/http_util.h"
#include "net/http/http_version.h"
#include "services/network/public/cpp/data_element.h"
#include "services/network/public/cpp/resource_request.h"
#include "services/network/public/cpp/resource_request_body.h"
#include "services/network/public/cpp/self_deleting_url_loader_factory.h"
#include "services/network/public/cpp/url_loader_completion_status.h"
#include "services/network/public/cpp/url_loader_factory_builder.h"
#include "services/network/public/mojom/data_pipe_getter.mojom.h"
#include "services/network/public/mojom/url_loader.mojom.h"
#include "services/network/public/mojom/url_loader_factory.mojom.h"
#include "services/network/public/mojom/url_response_head.mojom.h"
#include "url/url_constants.h"

namespace domicile {
namespace {

// A header value as a page's Headers reads it: bytes, each a character.
// Header values need not be UTF-8, and the app reads them as JavaScript
// strings, so each byte becomes the character with its code, as fetch does.
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

ElectronHeaders RequestHeaders(const network::ResourceRequest& request) {
  ElectronHeaders headers;
  for (const net::HttpRequestHeaders::HeaderKeyValuePair& header :
       request.headers.GetHeaderVector()) {
    headers.emplace_back(base::ToLowerASCII(header.key),
                         AsCharacters(header.value));
  }
  if (request.referrer.is_valid()) {
    headers.emplace_back("referer", request.referrer.spec());
  }
  return headers;
}

// A page's request to a scheme its session handles, answered by the app.
// Owns itself: goes when the page stops listening, or once its answer is
// all sent.
class ElectronURLLoader final : public network::mojom::URLLoader,
                                public mojo::DataPipeDrainer::Client {
 public:
  static void Start(
      base::WeakPtr<ElectronSession> session,
      const network::ResourceRequest& request,
      mojo::PendingReceiver<network::mojom::URLLoader> loader,
      mojo::PendingRemote<network::mojom::URLLoaderClient> client) {
    // Deletes itself.
    (new ElectronURLLoader(std::move(session), request, std::move(loader),
                           std::move(client)))
        ->ReadBody();
  }

  // Reads the request's body, then asks the app.
  void ReadBody();

  ElectronURLLoader(const ElectronURLLoader&) = delete;
  ElectronURLLoader& operator=(const ElectronURLLoader&) = delete;

  // network::mojom::URLLoader:
  void FollowRedirect(
      network::HttpRequestHeadersUpdateParams headers_update_params,
      const std::optional<GURL>& new_url) override {
    // It never redirects, so a page that asks to follow one is not ours.
    receiver_.ReportBadMessage("an Electron protocol load never redirects");
    delete this;
  }
  void SetPriority(net::RequestPriority priority,
                   int32_t intra_priority_value) override {}

  // The app's answer, while this loader is still wanted.
  void Respond(ElectronResponse response);
  void Fail(const std::string& why);
  void Data(std::string bytes);
  void End(const std::optional<std::string>& error);
  // The app's answer will never come: it went, or dropped the request.
  void Abandoned();

  base::WeakPtr<ElectronURLLoader> GetWeakPtr() {
    return weak_factory_.GetWeakPtr();
  }

 private:
  ElectronURLLoader(
      base::WeakPtr<ElectronSession> session,
      const network::ResourceRequest& request,
      mojo::PendingReceiver<network::mojom::URLLoader> loader,
      mojo::PendingRemote<network::mojom::URLLoaderClient> client);
  ~ElectronURLLoader() override = default;

  void Ask();

  // mojo::DataPipeDrainer::Client, for a body in a data pipe:
  void OnDataAvailable(base::span<const uint8_t> data) override;
  void OnDataComplete() override;

  // Writes the next waiting piece of the body, or completes once it ended.
  void WriteNext();
  void Wrote(MojoResult result);
  void Complete(int error);

  const base::WeakPtr<ElectronSession> session_;
  network::ResourceRequest request_;
  mojo::Receiver<network::mojom::URLLoader> receiver_;
  mojo::Remote<network::mojom::URLLoaderClient> client_;

  // The request's body as read so far, and what is left to read of it.
  std::string body_;
  size_t next_element_ = 0;
  std::unique_ptr<mojo::DataPipeDrainer> drainer_;
  mojo::Remote<network::mojom::DataPipeGetter> body_getter_;

  // The response's body: pieces waiting to be written, the writer, and how
  // it ended once it has.
  base::circular_deque<std::string> waiting_;
  std::unique_ptr<mojo::DataPipeProducer> producer_;
  bool writing_ = false;
  std::optional<int> ended_;
  uint64_t body_length_ = 0;

  base::WeakPtrFactory<ElectronURLLoader> weak_factory_{this};
};

// The app's side of one request: hands what the app says to the loader, if
// it is still there.
class LoaderResponder final : public ElectronResponder {
 public:
  explicit LoaderResponder(base::WeakPtr<ElectronURLLoader> loader)
      : loader_(std::move(loader)) {}
  ~LoaderResponder() override {
    if (!finished_ && loader_) {
      loader_->Abandoned();
    }
  }

  void Respond(ElectronResponse response) override {
    finished_ = !std::holds_alternative<ElectronStreamedBody>(response.body);
    if (loader_) {
      loader_->Respond(std::move(response));
    }
  }
  void Fail(const std::string& why) override {
    finished_ = true;
    if (loader_) {
      loader_->Fail(why);
    }
  }
  void Data(std::string bytes) override {
    if (loader_) {
      loader_->Data(std::move(bytes));
    }
  }
  void End(const std::optional<std::string>& error) override {
    finished_ = true;
    if (loader_) {
      loader_->End(error);
    }
  }

 private:
  const base::WeakPtr<ElectronURLLoader> loader_;
  bool finished_ = false;
};

ElectronURLLoader::ElectronURLLoader(
    base::WeakPtr<ElectronSession> session,
    const network::ResourceRequest& request,
    mojo::PendingReceiver<network::mojom::URLLoader> loader,
    mojo::PendingRemote<network::mojom::URLLoaderClient> client)
    : session_(std::move(session)),
      request_(request),
      receiver_(this, std::move(loader)),
      client_(std::move(client)) {
  // A page that stops listening cancels its request; the app's answer then
  // goes nowhere.
  receiver_.set_disconnect_handler(base::BindOnce(
      [](ElectronURLLoader* self) { delete self; }, base::Unretained(this)));
}

void ElectronURLLoader::ReadBody() {
  if (!request_.request_body) {
    Ask();
    return;
  }
  const std::vector<network::DataElement>& elements =
      *request_.request_body->elements();
  while (next_element_ < elements.size()) {
    const network::DataElement& element = elements[next_element_++];
    switch (element.type()) {
      case network::DataElement::Tag::kBytes:
        body_.append(element.As<network::DataElementBytes>().AsStringPiece());
        break;
      case network::DataElement::Tag::kDataPipe: {
        // A Blob or a FormData with files: read it all, then go on.
        mojo::ScopedDataPipeProducerHandle producer;
        mojo::ScopedDataPipeConsumerHandle consumer;
        if (mojo::CreateDataPipe(nullptr, producer, consumer) !=
            MOJO_RESULT_OK) {
          Complete(net::ERR_INSUFFICIENT_RESOURCES);
          return;
        }
        body_getter_.Bind(
            element.As<network::DataElementDataPipe>().CloneDataPipeGetter());
        body_getter_->Read(
            std::move(producer),
            base::BindOnce([](network::mojom::DataPipeGetter::ReadResult) {
              // The drainer sees the pipe close; the size adds nothing.
            }));
        drainer_ =
            std::make_unique<mojo::DataPipeDrainer>(this, std::move(consumer));
        return;
      }
      default:
        // A file the page picked, or a stream: Electron gives a handler
        // those as a stream too, which this does not yet.
        LOG(ERROR) << "domicile: an Electron protocol handler cannot yet "
                      "be given a request body that is a file or a "
                      "stream; "
                   << request_.url.possibly_invalid_spec() << " fails.";
        Complete(net::ERR_NOT_IMPLEMENTED);
        return;
    }
  }
  Ask();
}

void ElectronURLLoader::OnDataAvailable(base::span<const uint8_t> data) {
  body_.append(base::as_string_view(data));
}

void ElectronURLLoader::OnDataComplete() {
  drainer_.reset();
  body_getter_.reset();
  ReadBody();
}

void ElectronURLLoader::Ask() {
  if (!session_) {
    Complete(net::ERR_CONNECTION_CLOSED);
    return;
  }
  ElectronFetch fetch{.url = request_.url,
                      .method = request_.method,
                      .headers = RequestHeaders(request_),
                      .body = request_.request_body
                                  ? std::optional(std::move(body_))
                                  : std::nullopt};
  session_->Fetch(std::move(fetch),
                  std::make_unique<LoaderResponder>(GetWeakPtr()));
}

void ElectronURLLoader::Respond(ElectronResponse response) {
  net::HttpResponseHeaders::Builder builder(
      net::HttpVersion(1, 1), base::NumberToString(response.status));
  for (const auto& [name, value] : response.headers) {
    builder.AddHeader(name, value);
  }
  scoped_refptr<net::HttpResponseHeaders> headers = builder.Build();
  if (headers->IsRedirect(nullptr)) {
    // Electron follows a handler's redirect; content's loaders would have
    // to start over in whatever scheme it names. Loudly unsupported until
    // an app needs it.
    LOG(ERROR) << "domicile: an Electron protocol handler redirected "
               << request_.url.possibly_invalid_spec()
               << ", which the engine cannot follow yet.";
    Complete(net::ERR_NOT_IMPLEMENTED);
    return;
  }

  if (const auto* file = std::get_if<base::FilePath>(&response.body)) {
    // The file loader reads it and answers ranges, and its own status
    // stands. Bypassing file: policy is safe: the app named the file, and
    // the app reads any file it likes.
    network::ResourceRequest file_request = request_;
    file_request.url = net::FilePathToFileURL(*file);
    headers->RemoveHeader("content-length");
    content::CreateFileURLLoaderBypassingSecurityChecks(
        file_request, receiver_.Unbind(), client_.Unbind(),
        /*observer=*/nullptr, /*allow_directory_listing=*/false,
        std::move(headers));
    delete this;
    return;
  }

  auto head = network::mojom::URLResponseHead::New();
  std::string mime_type;
  std::string charset;
  headers->GetMimeTypeAndCharset(&mime_type, &charset);
  if (!mime_type.empty()) {
    head->mime_type = mime_type;
    head->charset = charset;
  } else if (!net::GetWellKnownMimeTypeFromFile(
                 base::FilePath::FromUTF8Unsafe(request_.url.path()),
                 &head->mime_type)) {
    // As content does for a response that names none.
    head->mime_type = "text/plain";
  }
  head->headers = std::move(headers);

  mojo::ScopedDataPipeProducerHandle producer;
  mojo::ScopedDataPipeConsumerHandle consumer;
  if (mojo::CreateDataPipe(nullptr, producer, consumer) != MOJO_RESULT_OK) {
    Complete(net::ERR_INSUFFICIENT_RESOURCES);
    return;
  }
  producer_ = std::make_unique<mojo::DataPipeProducer>(std::move(producer));
  client_->OnReceiveResponse(std::move(head), std::move(consumer),
                             std::nullopt);
  if (auto* whole = std::get_if<std::string>(&response.body)) {
    Data(std::move(*whole));
    End(std::nullopt);
  }
}

void ElectronURLLoader::Fail(const std::string& why) {
  LOG(WARNING) << "domicile: an Electron app's protocol handler failed "
               << request_.url.possibly_invalid_spec() << ": " << why;
  Complete(net::ERR_FAILED);
}

void ElectronURLLoader::Data(std::string bytes) {
  // ElectronApp sends pieces only after a streamed response.
  CHECK(producer_);
  if (!bytes.empty()) {
    waiting_.push_back(std::move(bytes));
    WriteNext();
  }
}

void ElectronURLLoader::End(const std::optional<std::string>& error) {
  CHECK(producer_);
  if (error.has_value()) {
    LOG(WARNING) << "domicile: an Electron app's response to "
                 << request_.url.possibly_invalid_spec()
                 << " broke off: " << *error;
  }
  ended_ = error.has_value() ? net::ERR_FAILED : net::OK;
  WriteNext();
}

void ElectronURLLoader::Abandoned() {
  Complete(net::ERR_CONNECTION_CLOSED);
}

void ElectronURLLoader::WriteNext() {
  if (writing_) {
    return;
  } else if (waiting_.empty()) {
    if (ended_.has_value()) {
      Complete(*ended_);
    }
    return;
  }
  writing_ = true;
  body_length_ += waiting_.front().size();
  producer_->Write(
      std::make_unique<mojo::StringDataSource>(
          waiting_.front(), mojo::StringDataSource::AsyncWritingMode::
                                STRING_STAYS_VALID_UNTIL_COMPLETION),
      base::BindOnce(&ElectronURLLoader::Wrote, GetWeakPtr()));
}

void ElectronURLLoader::Wrote(MojoResult result) {
  writing_ = false;
  waiting_.pop_front();
  if (result != MOJO_RESULT_OK) {
    // The page closed its end of the body: it wants no more.
    Complete(net::ERR_FAILED);
    return;
  }
  WriteNext();
}

void ElectronURLLoader::Complete(int error) {
  network::URLLoaderCompletionStatus status(error);
  status.decoded_body_length = base::ByteSize(body_length_);
  status.encoded_body_length = base::ByteSize(body_length_);
  client_->OnComplete(status);
  delete this;
}

// The loaders of one session's page: the app's for the schemes the session
// handles, and the network's, when it fronts the network, for the rest.
class ElectronURLLoaderFactory final
    : public network::SelfDeletingURLLoaderFactory {
 public:
  ElectronURLLoaderFactory(
      mojo::PendingReceiver<network::mojom::URLLoaderFactory> receiver,
      base::WeakPtr<ElectronSession> session,
      mojo::PendingRemote<network::mojom::URLLoaderFactory> network,
      std::optional<std::string> window,
      base::SelfDeletingPassKey key)
      : network::SelfDeletingURLLoaderFactory(std::move(receiver), key),
        session_(std::move(session)),
        window_(std::move(window)) {
    if (network) {
      network_.Bind(std::move(network));
    }
  }

  // network::mojom::URLLoaderFactory:
  void CreateLoaderAndStart(
      mojo::PendingReceiver<network::mojom::URLLoader> loader,
      int32_t request_id,
      uint32_t options,
      const network::ResourceRequest& request,
      mojo::PendingRemote<network::mojom::URLLoaderClient> client,
      const net::MutableNetworkTrafficAnnotationTag& traffic_annotation)
      override {
    // Looked up per request: an app handles schemes while it runs.
    if (session_ && session_->Handles(request.url.scheme())) {
      ElectronURLLoader::Start(session_, request, std::move(loader),
                               std::move(client));
    } else if (network_ && session_ && session_->ListensForWebRequests()) {
      mojo::PendingRemote<network::mojom::URLLoaderFactory> network;
      network_->Clone(network.InitWithNewPipeAndPassReceiver());
      StartElectronWebRequest(session_, window_, std::move(network), request_id,
                              options, request, std::move(loader),
                              std::move(client), traffic_annotation);
    } else if (network_) {
      network_->CreateLoaderAndStart(std::move(loader), request_id, options,
                                     request, std::move(client),
                                     traffic_annotation);
    } else {
      // The app unhandled the scheme after this page started, or went.
      mojo::Remote<network::mojom::URLLoaderClient>(std::move(client))
          ->OnComplete(network::URLLoaderCompletionStatus(
              session_ ? net::ERR_UNKNOWN_URL_SCHEME
                       : net::ERR_CONNECTION_CLOSED));
    }
  }

 private:
  ~ElectronURLLoaderFactory() override = default;

  const base::WeakPtr<ElectronSession> session_;
  mojo::Remote<network::mojom::URLLoaderFactory> network_;
  // The desk window whose page loads through this, for webRequest's
  // listeners.
  const std::optional<std::string> window_;
};

mojo::PendingRemote<network::mojom::URLLoaderFactory> MakeFactory(
    base::WeakPtr<ElectronSession> session) {
  mojo::PendingRemote<network::mojom::URLLoaderFactory> remote;
  base::MakeSelfDeleting<ElectronURLLoaderFactory>(
      remote.InitWithNewPipeAndPassReceiver(), std::move(session),
      mojo::PendingRemote<network::mojom::URLLoaderFactory>(), std::nullopt);
  return remote;
}

base::WeakPtr<ElectronSession> SessionOf(content::WebContents* contents) {
  if (contents == nullptr) {
    return nullptr;
  }
  return ElectronPage::SessionOf(*contents);
}

}  // namespace

mojo::PendingRemote<network::mojom::URLLoaderFactory>
ElectronNavigationLoaderFactory(const std::string& scheme,
                                content::FrameTreeNodeId frame) {
  base::WeakPtr<ElectronSession> session =
      SessionOf(content::WebContents::FromFrameTreeNodeId(frame));
  if (!session || !session->Handles(scheme)) {
    return {};
  }
  return MakeFactory(std::move(session));
}

void AddElectronSubresourceLoaderFactories(
    int render_process_id,
    int render_frame_id,
    content::ContentBrowserClient::NonNetworkURLLoaderFactoryMap* factories) {
  base::WeakPtr<ElectronSession> session =
      SessionOf(content::WebContents::FromRenderFrameHost(
          content::RenderFrameHost::FromID(render_process_id,
                                           render_frame_id)));
  if (!session) {
    return;
  }
  for (const std::string& scheme : session->LocalSchemes()) {
    // Replaces content's file: loader, which reads any file.
    (*factories)[scheme] = MakeFactory(session);
  }
}

void ProxyElectronNetworkLoads(content::RenderFrameHost* frame,
                               network::URLLoaderFactoryBuilder& builder) {
  // A worker's loads have no frame. An Electron page's workers load from
  // the network for now: see "Requests" in ELECTRON-APPS.md.
  if (frame == nullptr) {
    return;
  }
  base::WeakPtr<ElectronSession> session =
      SessionOf(content::WebContents::FromRenderFrameHost(frame));
  if (!session) {
    return;
  }
  // Every load of the page, whether or not the app handles http or https
  // or listens for its requests yet: it may start to.
  const WebViewGuest* guest = WebViewGuest::FromWebContents(
      content::WebContents::FromRenderFrameHost(frame));
  auto [receiver, network] = builder.Append();
  base::MakeSelfDeleting<ElectronURLLoaderFactory>(
      std::move(receiver), std::move(session), std::move(network),
      guest ? std::optional(guest->window_id()) : std::nullopt);
}

bool MayElectronPageLoad(content::WebContents* guest, const GURL& url) {
  base::WeakPtr<ElectronSession> session = SessionOf(guest);
  return session && session->Handles(url.scheme());
}

}  // namespace domicile
