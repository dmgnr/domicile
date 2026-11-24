// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/browser/shell_dev_server.h"

#include <memory>
#include <optional>
#include <string>
#include <utility>

#include "base/files/scoped_temp_dir.h"
#include "base/functional/bind.h"
#include "base/memory/scoped_refptr.h"
#include "base/test/task_environment.h"
#include "base/test/test_future.h"
#include "base/types/expected.h"
#include "mojo/public/cpp/bindings/remote.h"
#include "mojo/public/cpp/system/data_pipe_utils.h"
#include "net/base/io_buffer.h"
#include "net/base/net_errors.h"
#include "net/http/http_request_headers.h"
#include "net/socket/stream_socket.h"
#include "net/socket/unix_domain_server_socket_posix.h"
#include "net/traffic_annotation/network_traffic_annotation.h"
#include "services/network/public/cpp/resource_request.h"
#include "services/network/public/cpp/resource_request_body.h"
#include "services/network/public/mojom/url_loader.mojom.h"
#include "services/network/test/test_url_loader_client.h"
#include "testing/gmock/include/gmock/gmock.h"
#include "testing/gtest/include/gtest/gtest.h"
#include "url/gurl.h"

namespace domicile {
namespace {

using ::testing::HasSubstr;

network::ResourceRequest Asking(const std::string& url) {
  network::ResourceRequest request;
  request.method = "GET";
  request.url = GURL(url);
  return request;
}

TEST(ShellDevServerTest, AsksForThePathAndQueryWithTheHeadersViteReads) {
  network::ResourceRequest request =
      Asking("domicile://shell/src/label.ts?t=17&import");
  request.headers.SetHeader(net::HttpRequestHeaders::kAccept, "*/*");
  // The rest are the page's, not the dev server's.
  request.headers.SetHeader(net::HttpRequestHeaders::kUserAgent, "Domicile");

  EXPECT_EQ(DevServerRequest(request, ""),
            "GET /src/label.ts?t=17&import HTTP/1.0\r\n"
            "Host: shell\r\n"
            "Connection: close\r\n"
            "Accept: */*\r\n"
            "\r\n");
}

TEST(ShellDevServerTest, SendsThePagesMessageAsTheBody) {
  network::ResourceRequest request =
      Asking("domicile://shell/@domicile/hmr?client=1");
  request.method = "POST";

  EXPECT_EQ(DevServerRequest(request, R"({"type":"custom"})"),
            "POST /@domicile/hmr?client=1 HTTP/1.0\r\n"
            "Host: shell\r\n"
            "Connection: close\r\n"
            "Content-Length: 17\r\n"
            "\r\n"
            R"({"type":"custom"})");
}

TEST(ShellDevServerTest, WaitsForTheWholeHead) {
  const auto parsed =
      ParseDevServerHead("HTTP/1.1 200 OK\r\nContent-Type: text/javascript");
  ASSERT_TRUE(parsed.has_value());
  EXPECT_FALSE(parsed->has_value());
}

TEST(ShellDevServerTest, ReadsTheTypeAndWhereTheBodyStarts) {
  const std::string head =
      "HTTP/1.1 200 OK\r\n"
      "Content-Type: text/javascript; charset=utf-8\r\n"
      "Cache-Control: no-cache\r\n"
      "\r\n";
  const auto parsed = ParseDevServerHead(head + "export {};");
  ASSERT_TRUE(parsed.has_value());
  ASSERT_TRUE(parsed->has_value());
  const DevServerHead& read = **parsed;

  EXPECT_EQ(read.length, head.size());
  EXPECT_EQ(read.head->mime_type, "text/javascript");
  EXPECT_EQ(read.head->charset, "utf-8");
  EXPECT_EQ(read.head->headers->response_code(), 200);
  // Read fresh every time, like a shell's files from a directory.
  EXPECT_TRUE(read.head->headers->HasHeaderValue("Cache-Control", "no-store"));
  EXPECT_FALSE(read.head->headers->HasHeaderValue("Cache-Control", "no-cache"));
}

TEST(ShellDevServerTest, KeepsTheDevServersStatus) {
  // A module Vite cannot find fails to load in the page, with its status.
  const auto parsed = ParseDevServerHead("HTTP/1.1 404 Not Found\r\n\r\n");
  ASSERT_TRUE(parsed.has_value() && parsed->has_value());
  EXPECT_EQ((*parsed)->head->headers->response_code(), 404);
}

TEST(ShellDevServerTest, RefusesWhatIsNotHttp) {
  const auto parsed = ParseDevServerHead("{\"step\":\"serving\"}\n");
  ASSERT_FALSE(parsed.has_value());
  EXPECT_THAT(parsed.error(), HasSubstr("{\"step\""));
}

TEST(ShellDevServerTest, GivesUpOnAHeadThatNeverEnds) {
  const auto parsed = ParseDevServerHead(
      "HTTP/1.1 200 OK\r\nX: " + std::string(128 * 1024, 'x'));
  ASSERT_FALSE(parsed.has_value());
  EXPECT_THAT(parsed.error(), HasSubstr("still going"));
}

// The result of a net call that may finish now or later.
int Settle(int result, base::test::TestFuture<int>& later) {
  return result == net::ERR_IO_PENDING ? later.Get() : result;
}

// A dev server on a socket, driven by hand, and a page's request to it.
class ShellDevServerLoadTest : public testing::Test {
 protected:
  void SetUp() override {
    ASSERT_TRUE(dir_.CreateUniqueTempDir());
    socket_ = dir_.GetPath().Append("dev.sock");
    ASSERT_EQ(server_.BindAndListen(socket_.value(), /*backlog=*/1), net::OK);
  }

  // Asks for `url` and takes the dev server's end of the connection.
  void Load(const std::string& url) {
    LoadFromDevServer(socket_, Asking(url),
                      loader_.BindNewPipeAndPassReceiver(),
                      client_.CreateRemote());
    base::test::TestFuture<int> accepted;
    ASSERT_EQ(
        Settle(server_.Accept(&connection_, accepted.GetCallback()), accepted),
        net::OK);
  }

  // The request the engine wrote, through its blank line.
  std::string Asked() {
    std::string asked;
    while (asked.find("\r\n\r\n") == std::string::npos) {
      auto buffer = base::MakeRefCounted<net::IOBufferWithSize>(4096);
      base::test::TestFuture<int> read;
      const int got = Settle(
          connection_->Read(buffer.get(), buffer->size(), read.GetCallback()),
          read);
      EXPECT_GT(got, 0);
      if (got <= 0) {
        return asked;
      }
      asked.append(buffer->data(), static_cast<size_t>(got));
    }
    return asked;
  }

  // Writes `bytes` as the dev server.
  void Answer(const std::string& bytes) {
    auto buffer = base::MakeRefCounted<net::StringIOBuffer>(bytes);
    base::test::TestFuture<int> written;
    ASSERT_EQ(Settle(connection_->Write(buffer.get(), buffer->size(),
                                        written.GetCallback(),
                                        MISSING_TRAFFIC_ANNOTATION),
                     written),
              buffer->size());
  }

  // Ends the body, as the dev server does by closing.
  void HangUp() { connection_.reset(); }

  // The body the page read, once the load completed.
  std::string Body() {
    std::string body;
    EXPECT_TRUE(
        mojo::BlockingCopyToString(client_.response_body_release(), &body));
    return body;
  }

  // A full one, not single-threaded: mojo::DataPipeProducer reads what it
  // writes on the thread pool, as the browser's IO thread has one.
  base::test::TaskEnvironment task_environment_{
      base::test::TaskEnvironment::MainThreadType::IO};
  base::ScopedTempDir dir_;
  base::FilePath socket_;
  net::UnixDomainServerSocket server_{
      base::BindRepeating(
          [](const net::UnixDomainServerSocket::Credentials&) { return true; }),
      /*use_abstract_namespace=*/false};
  std::unique_ptr<net::StreamSocket> connection_;
  mojo::Remote<network::mojom::URLLoader> loader_;
  network::TestURLLoaderClient client_;
};

TEST_F(ShellDevServerLoadTest, ServesAModuleTheDevServerAnswers) {
  Load("domicile://shell/src/shell.ts");
  EXPECT_THAT(Asked(), HasSubstr("GET /src/shell.ts HTTP/1.0\r\n"));

  Answer(
      "HTTP/1.1 200 OK\r\nContent-Type: text/javascript\r\n\r\n"
      "export const Shell = () => {};");
  HangUp();
  client_.RunUntilComplete();

  EXPECT_EQ(client_.completion_status().error_code, net::OK);
  EXPECT_EQ(client_.response_head()->mime_type, "text/javascript");
  EXPECT_EQ(Body(), "export const Shell = () => {};");
}

TEST_F(ShellDevServerLoadTest, HandsOverEachPieceOfABodyThatKeepsComing) {
  // Vite's updates: one line at a time, on a body that stays open.
  Load("domicile://shell/@domicile/hmr");
  Asked();
  Answer(
      "HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\n\r\n"
      "{\"type\":\"connected\"}\n");
  // The page has the head while the body is still coming.
  client_.RunUntilResponseReceived();
  EXPECT_EQ(client_.response_head()->mime_type, "application/x-ndjson");

  Answer("{\"type\":\"update\"}\n");
  HangUp();
  client_.RunUntilComplete();

  EXPECT_EQ(Body(), "{\"type\":\"connected\"}\n{\"type\":\"update\"}\n");
}

TEST_F(ShellDevServerLoadTest, FailsWhenTheDevServerHangsUpWithoutAnswering) {
  Load("domicile://shell/src/shell.ts");
  Asked();
  HangUp();
  client_.RunUntilComplete();

  EXPECT_EQ(client_.completion_status().error_code, net::ERR_EMPTY_RESPONSE);
}

TEST_F(ShellDevServerLoadTest, FailsWhenTheAnswerIsNotHttp) {
  Load("domicile://shell/src/shell.ts");
  Asked();
  Answer("export {};\n\n\n");
  HangUp();
  client_.RunUntilComplete();

  EXPECT_EQ(client_.completion_status().error_code,
            net::ERR_INVALID_HTTP_RESPONSE);
}

TEST(ShellDevServerGoneTest, FailsWhenNoDevServerListens) {
  // `domicile dev` was stopped: the page's import fails rather than waits.
  base::test::TaskEnvironment task_environment{
      base::test::TaskEnvironment::MainThreadType::IO};
  base::ScopedTempDir dir;
  ASSERT_TRUE(dir.CreateUniqueTempDir());
  mojo::Remote<network::mojom::URLLoader> loader;
  network::TestURLLoaderClient client;

  LoadFromDevServer(dir.GetPath().Append("gone.sock"),
                    Asking("domicile://shell/src/shell.ts"),
                    loader.BindNewPipeAndPassReceiver(), client.CreateRemote());
  client.RunUntilComplete();

  EXPECT_NE(client.completion_status().error_code, net::OK);
}

}  // namespace
}  // namespace domicile
