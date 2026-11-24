// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/browser/shell_dev_server.h"

#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <utility>

#include "base/functional/bind.h"
#include "base/logging.h"
#include "base/memory/scoped_refptr.h"
#include "base/memory/weak_ptr.h"
#include "base/strings/strcat.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/string_util.h"
#include "base/types/expected.h"
#include "mojo/public/cpp/bindings/receiver.h"
#include "mojo/public/cpp/bindings/remote.h"
#include "mojo/public/cpp/system/data_pipe.h"
#include "mojo/public/cpp/system/data_pipe_producer.h"
#include "mojo/public/cpp/system/string_data_source.h"
#include "net/base/io_buffer.h"
#include "net/base/net_errors.h"
#include "net/http/http_request_headers.h"
#include "net/http/http_response_headers.h"
#include "net/http/http_util.h"
#include "net/socket/unix_domain_client_socket_posix.h"
#include "net/traffic_annotation/network_traffic_annotation.h"
#include "services/network/public/cpp/data_element.h"
#include "services/network/public/cpp/resource_request_body.h"
#include "services/network/public/cpp/url_loader_completion_status.h"

namespace domicile {

namespace {

// The most the engine reads at once.
constexpr int kReadSize = 64 * 1024;

// A head longer than this is not Vite's. Without a bound, a server that never
// ends its head would grow the buffer forever.
constexpr size_t kMostHead = 64 * 1024;

// The request headers passed on: Vite tells a module import from a plain
// fetch by Accept, and a page's message is JSON.
constexpr std::string_view kPassedHeaders[] = {
    net::HttpRequestHeaders::kAccept,
    net::HttpRequestHeaders::kContentType,
};

// The page's request for a file, answered by the dev server. Owns itself:
// goes once the answer is all sent, or when the page stops listening.
class DevServerURLLoader final : public network::mojom::URLLoader {
 public:
  DevServerURLLoader(
      const base::FilePath& socket,
      const network::ResourceRequest& request,
      mojo::PendingReceiver<network::mojom::URLLoader> loader,
      mojo::PendingRemote<network::mojom::URLLoaderClient> client)
      : socket_path_(socket),
        url_(request.url),
        receiver_(this, std::move(loader)),
        client_(std::move(client)) {
    // A page that stops listening cancels its request, and with it the
    // connection: the dev server's update stream for that page ends.
    receiver_.set_disconnect_handler(base::BindOnce(
        [](DevServerURLLoader* self) { delete self; }, base::Unretained(this)));
  }

  DevServerURLLoader(const DevServerURLLoader&) = delete;
  DevServerURLLoader& operator=(const DevServerURLLoader&) = delete;

  // Sends `request` to the dev server.
  void Start(const network::ResourceRequest& request);

  // network::mojom::URLLoader:
  void FollowRedirect(
      network::HttpRequestHeadersUpdateParams headers_update_params,
      const std::optional<GURL>& new_url) override {
    // A redirect from the dev server is failed, not given to the page.
    receiver_.ReportBadMessage("a dev server load never redirects");
    delete this;
  }
  void SetPriority(net::RequestPriority priority,
                   int32_t intra_priority_value) override {}

 private:
  ~DevServerURLLoader() override = default;

  void OnConnect(int result);
  void OnWrite(int result);
  void ReadMore();
  void OnRead(int result);
  // Hands the page `bytes` of the body, then reads on.
  void WriteBody(std::string bytes);
  void OnWroteBody(MojoResult result);
  // Ends the request with `error` and deletes this.
  void Complete(int error);

  const base::FilePath socket_path_;
  const GURL url_;
  mojo::Receiver<network::mojom::URLLoader> receiver_;
  mojo::Remote<network::mojom::URLLoaderClient> client_;

  std::unique_ptr<net::UnixDomainClientSocket> socket_;
  scoped_refptr<net::DrainableIOBuffer> write_buffer_;
  scoped_refptr<net::IOBufferWithSize> read_buffer_;

  // What arrived before the head ended, then the piece of the body being
  // written to the page.
  std::string received_;
  std::unique_ptr<mojo::DataPipeProducer> producer_;

  base::WeakPtrFactory<DevServerURLLoader> weak_factory_{this};
};

void DevServerURLLoader::Start(const network::ResourceRequest& request) {
  std::string body;
  if (request.request_body) {
    for (const network::DataElement& element :
         *request.request_body->elements()) {
      if (element.type() != network::DataElement::Tag::kBytes) {
        // Vite's client sends its messages as strings. A file or a stream
        // would need reading first, which nothing asks for yet.
        LOG(ERROR) << "domicile: the shell's dev server is sent only bodies "
                      "of bytes; "
                   << url_.possibly_invalid_spec()
                   << " has a file or a stream, so it fails.";
        Complete(net::ERR_NOT_IMPLEMENTED);
        return;
      }
      body.append(element.As<network::DataElementBytes>().AsStringPiece());
    }
  }
  std::string written = DevServerRequest(request, body);
  const size_t size = written.size();
  write_buffer_ = base::MakeRefCounted<net::DrainableIOBuffer>(
      base::MakeRefCounted<net::StringIOBuffer>(std::move(written)), size);
  read_buffer_ = base::MakeRefCounted<net::IOBufferWithSize>(kReadSize);

  socket_ = std::make_unique<net::UnixDomainClientSocket>(
      socket_path_.value(), /*use_abstract_namespace=*/false);
  const int result = socket_->Connect(base::BindOnce(
      &DevServerURLLoader::OnConnect, weak_factory_.GetWeakPtr()));
  if (result != net::ERR_IO_PENDING) {
    OnConnect(result);
  }
}

void DevServerURLLoader::OnConnect(int result) {
  if (result != net::OK) {
    LOG(ERROR) << "domicile: the shell's dev server at "
               << socket_path_.value() << " did not answer for "
               << url_.possibly_invalid_spec() << " ("
               << net::ErrorToString(result)
               << "). Is `domicile dev` still running?";
    Complete(result);
    return;
  }
  OnWrite(0);
}

void DevServerURLLoader::OnWrite(int result) {
  if (result < 0) {
    LOG(ERROR) << "domicile: asking the shell's dev server for "
               << url_.possibly_invalid_spec()
               << " failed: " << net::ErrorToString(result);
    Complete(result);
    return;
  }
  write_buffer_->DidConsume(result);
  if (write_buffer_->BytesRemaining() == 0) {
    ReadMore();
    return;
  }
  const int written = socket_->Write(
      write_buffer_.get(), write_buffer_->BytesRemaining(),
      base::BindOnce(&DevServerURLLoader::OnWrite, weak_factory_.GetWeakPtr()),
      MISSING_TRAFFIC_ANNOTATION);
  if (written != net::ERR_IO_PENDING) {
    OnWrite(written);
  }
}

void DevServerURLLoader::ReadMore() {
  const int result = socket_->Read(
      read_buffer_.get(), kReadSize,
      base::BindOnce(&DevServerURLLoader::OnRead, weak_factory_.GetWeakPtr()));
  if (result != net::ERR_IO_PENDING) {
    OnRead(result);
  }
}

void DevServerURLLoader::OnRead(int result) {
  if (result < 0) {
    LOG(ERROR) << "domicile: reading " << url_.possibly_invalid_spec()
               << " from the shell's dev server failed: "
               << net::ErrorToString(result);
    Complete(result);
    return;
  }
  if (result == 0) {
    // The server closes the connection to end the body.
    if (!producer_) {
      LOG(ERROR) << "domicile: the shell's dev server hung up without "
                    "answering for "
                 << url_.possibly_invalid_spec();
      Complete(net::ERR_EMPTY_RESPONSE);
      return;
    }
    Complete(net::OK);
    return;
  }

  const std::string_view bytes(read_buffer_->data(),
                               static_cast<size_t>(result));
  if (producer_) {
    WriteBody(std::string(bytes));
    return;
  }

  received_.append(bytes);
  base::expected<std::optional<DevServerHead>, std::string> parsed =
      ParseDevServerHead(received_);
  if (!parsed.has_value()) {
    LOG(ERROR) << "domicile: the shell's dev server answered "
               << url_.possibly_invalid_spec()
               << " with something that is not HTTP: " << parsed.error();
    Complete(net::ERR_INVALID_HTTP_RESPONSE);
    return;
  }
  if (!parsed->has_value()) {
    ReadMore();
    return;
  }

  mojo::ScopedDataPipeProducerHandle producer;
  mojo::ScopedDataPipeConsumerHandle consumer;
  if (mojo::CreateDataPipe(nullptr, producer, consumer) != MOJO_RESULT_OK) {
    Complete(net::ERR_INSUFFICIENT_RESOURCES);
    return;
  }
  producer_ = std::make_unique<mojo::DataPipeProducer>(std::move(producer));
  std::string body = received_.substr((*parsed)->length);
  received_.clear();
  client_->OnReceiveResponse(std::move((*parsed)->head), std::move(consumer),
                             std::nullopt);
  WriteBody(std::move(body));
}

void DevServerURLLoader::WriteBody(std::string bytes) {
  if (bytes.empty()) {
    ReadMore();
    return;
  }
  // Held until written, and nothing more is read until then, so a page that
  // reads slowly slows the server rather than growing a buffer.
  received_ = std::move(bytes);
  producer_->Write(
      std::make_unique<mojo::StringDataSource>(
          received_, mojo::StringDataSource::AsyncWritingMode::
                         STRING_STAYS_VALID_UNTIL_COMPLETION),
      base::BindOnce(&DevServerURLLoader::OnWroteBody,
                     weak_factory_.GetWeakPtr()));
}

void DevServerURLLoader::OnWroteBody(MojoResult result) {
  received_.clear();
  if (result != MOJO_RESULT_OK) {
    // The page closed its end of the body: it wants no more.
    Complete(net::ERR_FAILED);
    return;
  }
  ReadMore();
}

void DevServerURLLoader::Complete(int error) {
  client_->OnComplete(network::URLLoaderCompletionStatus(error));
  delete this;
}

}  // namespace

std::string DevServerRequest(const network::ResourceRequest& request,
                             std::string_view body) {
  // HTTP/1.0, so the server sends the body as it is and ends it by closing,
  // rather than in chunks this would have to undo.
  std::string written = base::StrCat(
      {request.method, " ", request.url.path(),
       request.url.has_query() ? "?" : "", request.url.query(),
       " HTTP/1.0\r\nHost: shell\r\nConnection: close\r\n"});
  for (const net::HttpRequestHeaders::HeaderKeyValuePair& header :
       request.headers.GetHeaderVector()) {
    for (std::string_view passed : kPassedHeaders) {
      if (base::EqualsCaseInsensitiveASCII(header.key, passed)) {
        base::StrAppend(&written, {header.key, ": ", header.value, "\r\n"});
      }
    }
  }
  if (!body.empty()) {
    base::StrAppend(&written, {"Content-Length: ",
                               base::NumberToString(body.size()), "\r\n"});
  }
  base::StrAppend(&written, {"\r\n", body});
  return written;
}

base::expected<std::optional<DevServerHead>, std::string> ParseDevServerHead(
    std::string_view received) {
  // HttpResponseHeaders takes anything for a status line, so check it here.
  constexpr std::string_view kVersion = "HTTP/1.";
  if (!kVersion.starts_with(received.substr(0, kVersion.size()))) {
    return base::unexpected(
        base::StrCat({"it starts \"", received.substr(0, 32), "\""}));
  }
  const size_t end = received.find("\r\n\r\n");
  if (end == std::string_view::npos) {
    if (received.size() > kMostHead) {
      return base::unexpected(base::StrCat(
          {"its head is still going after ", base::NumberToString(kMostHead),
           " bytes"}));
    }
    return std::nullopt;
  }
  const size_t length = end + 4;

  auto headers = base::MakeRefCounted<net::HttpResponseHeaders>(
      net::HttpUtil::AssembleRawHeaders(received.substr(0, length)));
  // Read fresh every time, as files from a directory are: Blink keeps
  // non-HTTP responses in its memory cache, and an updated module keeps its
  // URL until Vite adds a timestamp to it.
  headers->RemoveHeader("cache-control");
  headers->AddHeader("Cache-Control", "no-store");

  auto head = network::mojom::URLResponseHead::New();
  headers->GetMimeTypeAndCharset(&head->mime_type, &head->charset);
  head->headers = std::move(headers);
  return DevServerHead{.head = std::move(head), .length = length};
}

void LoadFromDevServer(
    const base::FilePath& socket,
    const network::ResourceRequest& request,
    mojo::PendingReceiver<network::mojom::URLLoader> loader,
    mojo::PendingRemote<network::mojom::URLLoaderClient> client) {
  // Deletes itself.
  (new DevServerURLLoader(socket, request, std::move(loader),
                          std::move(client)))
      ->Start(request);
}

}  // namespace domicile
