// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/browser/shell_url_loader_factory.h"

#include <string>
#include <string_view>
#include <utility>

#include "base/containers/span.h"
#include "base/files/file_util.h"
#include "base/functional/bind.h"
#include "base/location.h"
#include "base/logging.h"
#include "base/strings/escape.h"
#include "base/strings/strcat.h"
#include "base/strings/string_number_conversions.h"
#include "mojo/public/cpp/system/data_pipe.h"
#include "components/domicile/browser/app_roots.h"
#include "components/domicile/browser/desk_lock.h"
#include "components/domicile/browser/shell_dev_server.h"
#include "components/domicile/browser/shell_source.h"
#include "components/domicile/common/domicile_scheme.h"
#include "content/public/browser/browser_task_traits.h"
#include "content/public/browser/browser_thread.h"
#include "content/public/browser/file_url_loader.h"
#include "mojo/public/cpp/bindings/remote.h"
#include "net/base/filename_util.h"
#include "net/http/http_response_headers.h"
#include "net/http/http_version.h"
#include "services/network/public/cpp/resource_request.h"
#include "services/network/public/mojom/url_response_head.mojom.h"
#include "url/gurl.h"

namespace domicile {

namespace {

// Only scripts from the shell root run, so markup the shell renders from a
// notification body, window title or file name cannot run with the desktop.
// WebAssembly may compile: only a script from the shell root can ask for it,
// so shells written in Rust and other wasm languages run.
// Styles stay open: shells inline their CSS. See docs/SHELL-PACKAGING.md.
constexpr char kShellContentSecurityPolicy[] =
    "script-src 'self' 'wasm-unsafe-eval'";

// A shell is loaded by a navigation, not a cache-bypassing reload, and Blink
// keeps non-HTTP responses in its memory cache without limit. A rebuilt shell
// keeps its file names, so without this the shell before would run again.
constexpr char kShellCacheControl[] = "no-store";

// Resolves a domicile:// URL for `host` to a file under `root`. Returns false
// if the URL does not resolve inside `root`. Shared by the shell and home
// hosts.
bool ResolveUnder(const base::FilePath& root,
                  std::string_view host,
                  bool refuse_dotfiles,
                  const GURL& url,
                  base::FilePath* out_path) {
  // Empty when the engine started without --domicile-shell-root or a home.
  if (root.empty()) {
    return false;
  }
  if (!url.is_valid() || !url.SchemeIs(kDomicileScheme)) {
    return false;
  }
  // Each root serves only its own host.
  if (url.host() != host) {
    return false;
  }

  // Decode fully before the checks below, so "%2e%2e%2f" is seen as "../" and
  // "%00" as NUL. UnescapeBinaryURLComponent leaves nothing escaped.
  std::string path = base::UnescapeBinaryURLComponent(
      url.path(), base::UnescapeRule::NORMAL);

  // A NUL would truncate the filename, so "index.html%00.png" could open a
  // different file than it names.
  if (path.find('\0') != std::string::npos) {
    return false;
  }

  // Strip the leading separator so the path appends to the root instead of
  // replacing it.
  while (!path.empty() && path.front() == '/') {
    path.erase(0, 1);
  }
  // No index fallback: CreateLoaderAndStart serves the bare root itself.
  if (path.empty()) {
    return false;
  }

  base::FilePath relative = base::FilePath::FromUTF8Unsafe(path);
  if (relative.IsAbsolute() || relative.ReferencesParent()) {
    return false;
  }
  // Runs after decoding, so `%2essh` is seen as `.ssh`.
  if (refuse_dotfiles) {
    for (const std::string& component : relative.GetComponents()) {
      if (!component.empty() && component.front() == '.') {
        return false;
      }
    }
  }

  base::FilePath candidate = root.Append(relative);

  // Final check on the result, independent of the checks above.
  if (!root.IsParent(candidate)) {
    return false;
  }

  *out_path = std::move(candidate);
  return true;
}

// A document that names `module` in a `meta_name` meta element and runs no
// script of its own, with `head` added to its head and `style` to its style.
//
// The module name comes from disk. EscapeAllExceptUnreserved makes it safe in
// a quoted attribute and encodes `#`, `?` and `%` so they stay part of the
// filename.
std::string ModuleDocument(std::string_view module,
                           std::string_view meta_name,
                           std::string_view head,
                           std::string_view style) {
  const std::string escaped = base::EscapeAllExceptUnreserved(module);
  return base::StrCat({
      "<!doctype html>\n"
      "<html lang=\"en\">\n"
      "  <head>\n"
      "    <meta charset=\"utf-8\" />\n"
      "    <meta content=\"width=device-width, initial-scale=1\" "
      "name=\"viewport\" />\n"
      "    <meta content=\"./",
      escaped, "\" name=\"", meta_name, "\" />\n", head,
      "    <style>\n"
      "      html,\n"
      "      body {\n"
      "        block-size: 100%;\n"
      "        inline-size: 100%;\n"
      "        margin: 0;\n"
      "        overflow: hidden;\n"
      "        padding: 0;\n"
      "      }\n",
      style,
      "    </style>\n"
      "  </head>\n"
      "  <body></body>\n"
      "</html>\n"});
}

}  // namespace

// static
bool ShellURLLoaderFactory::ResolveShellPath(const base::FilePath& shell_root,
                                            const GURL& url,
                                            base::FilePath* out_path) {
  return ResolveUnder(shell_root, kDomicileShellHost,
                      /*refuse_dotfiles=*/false, url, out_path);
}

// static
bool ShellURLLoaderFactory::ResolveAppPath(const base::FilePath& app_root,
                                          std::string_view host,
                                          const GURL& url,
                                          base::FilePath* out_path) {
  return ResolveUnder(app_root, host, /*refuse_dotfiles=*/false, url,
                      out_path);
}

// static
bool ShellURLLoaderFactory::ResolveHomePath(const base::FilePath& home,
                                           const GURL& url,
                                           base::FilePath* out_path) {
  return ResolveUnder(home, kDomicileHomeHost, /*refuse_dotfiles=*/true, url,
                      out_path);
}

// static
bool ShellURLLoaderFactory::MayReadHome(
    const std::optional<url::Origin>& initiator,
    bool desk_locked) {
  return !desk_locked && initiator.has_value() &&
         initiator->scheme() == kDomicileScheme &&
         initiator->host() == kDomicileShellHost;
}

// static
bool ShellURLLoaderFactory::MayReadFiles(
    network::mojom::RequestMode mode,
    const std::optional<url::Origin>& initiator,
    const GURL& url) {
  return mode == network::mojom::RequestMode::kNavigate ||
         (initiator.has_value() && initiator->IsSameOriginWith(url));
}

// static
std::string ShellURLLoaderFactory::ShellDocument(const std::string& module,
                                                uint64_t serial) {
  // The fixed document every shell loads into. It holds only what a desktop
  // needs:
  //
  //   - a charset
  //   - a viewport, so layout and compositor coordinates share a scale
  //   - a full-window root with no margin, so the page and compositor agree on
  //     where windows are
  //   - a cross-document view transition, so `load_shell` crossfades the shell
  //     before, such as the splash, into this one. The new side is live, so
  //     the shell draws during the fade. A shell's CSS can restyle it.
  //
  // The shell's CSS comes from its module. Blink's DomicileShell holds the
  // document's first frame until the shell has run, so the fade is into the
  // shell rather than an empty page.
  //
  // The module is named in a `domicile-shell-module` meta element. Blink's
  // DomicileShell loads it after the body is parsed and calls its `Shell`
  // export; see DomicileShell, which also reports load failures.
  //
  // The serial goes back to the browser with whether the module ran, so
  // ShellSwap hears only the document it served (DomicileShell).
  //
  // The body stays empty with no ids: every name in this document is in the
  // shell's namespace and could collide with the shell's own lookups.
  const std::string head =
      base::StrCat({"    <meta content=\"", base::NumberToString(serial),
                    "\" name=\"domicile-shell-serial\" />\n",
                    "    <title>Domicile</title>\n"});
  return ModuleDocument(module, "domicile-shell-module", head,
                        "      @view-transition {\n"
                        "        navigation: auto;\n"
                        "      }\n"
                        "      ::view-transition-group(root) {\n"
                        "        animation-duration: 600ms;\n"
                        "      }\n");
}

// static
std::string ShellURLLoaderFactory::AppDocument(const std::string& module) {
  // The shell's document without its title or view transition, which are the
  // app's to choose. Blink's DomicileApp loads the module named in the
  // `domicile-app-module` meta and calls its `main` export.
  return ModuleDocument(module, "domicile-app-module", "", "");
}

// static
network::mojom::URLResponseHeadPtr ShellURLLoaderFactory::AppDocumentHead() {
  // No Content-Security-Policy: an app may load code from anywhere, as a
  // native program may. See docs/architecture/APP-MODULES.md.
  auto head = network::mojom::URLResponseHead::New();
  head->mime_type = "text/html";
  head->charset = "utf-8";
  head->headers =
      net::HttpResponseHeaders::Builder(net::HttpVersion(1, 1), "200 OK")
          .AddHeader("Cache-Control", kShellCacheControl)
          .Build();
  return head;
}

// static
network::mojom::URLResponseHeadPtr ShellURLLoaderFactory::ShellDocumentHead() {
  auto head = network::mojom::URLResponseHead::New();
  head->mime_type = "text/html";
  head->charset = "utf-8";
  head->headers =
      net::HttpResponseHeaders::Builder(net::HttpVersion(1, 1), "200 OK")
          .AddHeader("Content-Security-Policy", kShellContentSecurityPolicy)
          .AddHeader("Cache-Control", kShellCacheControl)
          .Build();
  return head;
}

// static
scoped_refptr<net::HttpResponseHeaders>
ShellURLLoaderFactory::ShellFileHeaders() {
  return net::HttpResponseHeaders::Builder(net::HttpVersion(1, 1), "200 OK")
      .AddHeader("Cache-Control", kShellCacheControl)
      .Build();
}

void ShellURLLoaderFactory::ServeShellDocument(
    mojo::PendingRemote<network::mojom::URLLoaderClient> client) {
  // Read per request so each load serves whatever `domicile load-shell` last
  // set. ShellSource starts with the command-line values.
  const std::string module = ShellSource::Get().Module();
  const uint64_t serial = ShellSource::Get().Serial();
  if (module.empty()) {
    // Fail instead of serving an empty page that looks like a broken shell.
    LOG(ERROR) << "domicile: the engine was started without --"
               << kDomicileShellModuleSwitch
               << ", so there is no shell to load.";
    mojo::Remote<network::mojom::URLLoaderClient>(std::move(client))
        ->OnComplete(
            network::URLLoaderCompletionStatus(net::ERR_INVALID_ARGUMENT));
    return;
  }
  SendDocument(std::move(client), ShellDocument(module, serial),
               ShellDocumentHead());
}

void ShellURLLoaderFactory::ServeApp(
    std::string_view host,
    bool bare,
    const network::ResourceRequest& request,
    mojo::PendingReceiver<network::mojom::URLLoader> loader,
    mojo::PendingRemote<network::mojom::URLLoaderClient> client) {
  // Looked up per request: `run_app` adds apps while the engine runs.
  const AppRoots::App* app = AppRoots::Get().Find(host);
  base::FilePath path;
  if (app != nullptr && bare) {
    SendDocument(std::move(client), AppDocument(app->module),
                 AppDocumentHead());
  } else if (app != nullptr &&
             ResolveAppPath(app->root, host, request.url, &path)) {
    // A rebuilt app keeps its file names, as a shell does.
    ServeFile(request, path, std::move(loader), std::move(client),
              ShellFileHeaders());
  } else {
    mojo::Remote<network::mojom::URLLoaderClient>(std::move(client))
        ->OnComplete(network::URLLoaderCompletionStatus(net::ERR_INVALID_URL));
  }
}

// static
void ShellURLLoaderFactory::SendDocument(
    mojo::PendingRemote<network::mojom::URLLoaderClient> client,
    const std::string& document,
    network::mojom::URLResponseHeadPtr response) {
  mojo::Remote<network::mojom::URLLoaderClient> client_remote(
      std::move(client));

  mojo::ScopedDataPipeProducerHandle producer;
  mojo::ScopedDataPipeConsumerHandle consumer;
  if (mojo::CreateDataPipe(document.size(), producer, consumer) !=
      MOJO_RESULT_OK) {
    client_remote->OnComplete(
        network::URLLoaderCompletionStatus(net::ERR_INSUFFICIENT_RESOURCES));
    return;
  }

  size_t written = 0;
  const MojoResult result =
      producer->WriteData(base::as_byte_span(document),
                          MOJO_WRITE_DATA_FLAG_NONE, written);
  if (result != MOJO_RESULT_OK || written != document.size()) {
    client_remote->OnComplete(
        network::URLLoaderCompletionStatus(net::ERR_FAILED));
    return;
  }
  producer.reset();

  client_remote->OnReceiveResponse(std::move(response), std::move(consumer),
                                   std::nullopt);
  client_remote->OnComplete(network::URLLoaderCompletionStatus(net::OK));
}

// static
void ShellURLLoaderFactory::ServeFile(
    const network::ResourceRequest& request,
    const base::FilePath& path,
    mojo::PendingReceiver<network::mojom::URLLoader> loader,
    mojo::PendingRemote<network::mojom::URLLoaderClient> client,
    scoped_refptr<net::HttpResponseHeaders> headers) {
  // Skipping file: URL policy is safe: this was never a file: URL, and the
  // caller already confined it to a root.
  network::ResourceRequest file_request = request;
  file_request.url = net::FilePathToFileURL(path);
  content::CreateFileURLLoaderBypassingSecurityChecks(
      file_request, std::move(loader), std::move(client),
      /*observer=*/nullptr,
      // A listing would expose the tree's layout.
      /*allow_directory_listing=*/false, std::move(headers));
}

ShellURLLoaderFactory::ShellURLLoaderFactory(
    mojo::PendingReceiver<network::mojom::URLLoaderFactory> factory_receiver,
    const base::FilePath& shell_root,
    const base::FilePath& home,
    base::SelfDeletingPassKey key)
    : network::SelfDeletingURLLoaderFactory(std::move(factory_receiver), key),
      shell_root_(shell_root),
      home_(home) {}

ShellURLLoaderFactory::~ShellURLLoaderFactory() = default;

void ShellURLLoaderFactory::CreateLoaderAndStart(
    mojo::PendingReceiver<network::mojom::URLLoader> loader,
    int32_t request_id,
    uint32_t options,
    const network::ResourceRequest& request,
    mojo::PendingRemote<network::mojom::URLLoaderClient> client,
    const net::MutableNetworkTrafficAnnotationTag& traffic_annotation) {
  const std::string host(request.url.host());
  const bool home = host == kDomicileHomeHost;
  // Home has its own rule, MayReadHome, below.
  if (!home && !MayReadFiles(request.mode, request.request_initiator,
                             request.url)) {
    mojo::Remote<network::mojom::URLLoaderClient>(std::move(client))
        ->OnComplete(
            network::URLLoaderCompletionStatus(net::ERR_ACCESS_DENIED));
    return;
  }

  // The bare root is the generated document; only the module and its imports
  // come from disk.
  const bool bare = request.url.path() == "/" || request.url.path().empty();
  if (IsAppHost(host)) {
    ServeApp(host, bare, request, std::move(loader), std::move(client));
    return;
  }

  if (!home && bare) {
    ServeShellDocument(std::move(client));
    return;
  }

  // `domicile dev`: the dev server answers, from the IO thread, which watches
  // its socket. Read per request, as the document is.
  if (!home && ShellSource::Get().Files() == ShellFiles::kDevServer) {
    content::GetIOThreadTaskRunner({})->PostTask(
        FROM_HERE,
        base::BindOnce(&LoadFromDevServer, ShellSource::Get().Root(), request,
                       std::move(loader), std::move(client)));
    return;
  }

  base::FilePath path;
  const bool resolved =
      home ? MayReadHome(request.request_initiator, DeskLock::IsLocked()) &&
                 ResolveHomePath(home_, request.url, &path)
           : ResolveShellPath(shell_root_, request.url, &path);
  if (!resolved) {
    mojo::Remote<network::mojom::URLLoaderClient> client_remote(
        std::move(client));
    client_remote->OnComplete(
        network::URLLoaderCompletionStatus(net::ERR_INVALID_URL));
    return;
  }

  // Home files are not the shell's, and a rebuild does not change them.
  ServeFile(request, path, std::move(loader), std::move(client),
            home ? nullptr : ShellFileHeaders());
}

// static
mojo::PendingRemote<network::mojom::URLLoaderFactory>
ShellURLLoaderFactory::Create(const base::FilePath& shell_root) {
  mojo::PendingRemote<network::mojom::URLLoaderFactory> pending_remote;
  base::MakeSelfDeleting<ShellURLLoaderFactory>(
      pending_remote.InitWithNewPipeAndPassReceiver(), shell_root,
      base::GetHomeDir());
  return pending_remote;
}

}  // namespace domicile
