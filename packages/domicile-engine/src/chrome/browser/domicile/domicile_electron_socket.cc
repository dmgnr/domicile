// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "chrome/browser/domicile/domicile_electron_socket.h"

#include <unistd.h>

#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "base/callback_list.h"
#include "base/check.h"
#include "base/check_op.h"
#include "base/command_line.h"
#include "base/containers/circular_deque.h"
#include "base/containers/flat_set.h"
#include "base/containers/unique_ptr_adapters.h"
#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/strings/strcat.h"
#include "base/logging.h"
#include "base/memory/scoped_refptr.h"
#include "base/memory/weak_ptr.h"
#include "base/no_destructor.h"
#include "base/task/bind_post_task.h"
#include "base/threading/sequence_bound.h"
#include "base/types/expected.h"
#include "base/values.h"
#include "chrome/browser/domicile/domicile_browser_windows.h"
#include "chrome/browser/domicile/domicile_electron_network.h"
#include "chrome/browser/domicile/domicile_electron_page.h"
#include "chrome/browser/domicile/domicile_electron_page_control.h"
#include "chrome/browser/domicile/domicile_electron_page_events.h"
#include "chrome/browser/domicile/domicile_electron_storage.h"
#include "chrome/browser/domicile/domicile_spellcheck.h"
#include "components/domicile/browser/browser_window_listing.h"
#include "components/domicile/browser/electron_app.h"
#include "components/domicile/browser/electron_protocol.h"
#include "components/domicile/browser/line_framer.h"
#include "components/domicile/common/domicile_scheme.h"
#include "components/domicile/common/electron_schemes.h"
#include "components/embedder_support/user_agent_utils.h"
#include "components/version_info/version_info.h"
#include "content/public/browser/browser_task_traits.h"
#include "content/public/browser/browser_thread.h"
#include "content/public/browser/gpu_data_manager.h"
#include "content/public/browser/gpu_data_manager_observer.h"
#include "net/base/io_buffer.h"
#include "net/base/net_errors.h"
#include "net/socket/stream_socket.h"
#include "net/socket/unix_domain_server_socket_posix.h"
#include "net/traffic_annotation/network_traffic_annotation.h"
#include "url/gurl.h"

namespace domicile {
namespace {

// Apps dial at login together, so let several wait.
constexpr int kBacklog = 16;

constexpr int kReadBufferSize = 16 * 1024;

// A line's `type` and `id`, for the log: never what it carries, which can be
// a page's IPC, a cookie or a file.
std::string Described(std::string_view line) {
  const std::optional<base::DictValue> parsed =
      base::JSONReader::ReadDict(line, base::JSON_PARSE_RFC);
  if (!parsed) {
    return "a line that is not JSON";
  }
  const std::string* type = parsed->FindString("type");
  const std::string* id = parsed->FindString("id");
  return base::StrCat({type ? *type : "no type", id ? " for window " : "",
                       id ? *id : ""});
}

// Accepts only peers running as this user. The socket's directory already
// limits access; this is a second check.
bool ConnectedByUs(const net::UnixDomainServerSocket::Credentials& peer) {
  return peer.user_id == getuid();
}

// The desk as an Electron app sees it: the shell profile's browser windows.
class ChromeElectronDesk final : public ElectronDesk {
 public:
  std::optional<std::string> Open(const GURL& url,
                                  const std::optional<ElectronHistory>& history,
                                  const std::string& app_id,
                                  const WebViewPartition& partition,
                                  const std::string& preload,
                                  const std::vector<std::string>& arguments,
                                  const std::optional<ElectronNode>& node,
                                  ElectronPageCalls calls,
                                  base::WeakPtr<ElectronSession> session,
                                  bool view,
                                  const std::string& title,
                                  bool hidden,
                                  const std::string& user_agent) override {
    return OpenElectronWindow(url, history, app_id, partition, preload,
                              arguments, node, std::move(calls),
                              std::move(session), view, title, hidden,
                              user_agent);
  }
  std::optional<std::string> Adopt(std::unique_ptr<ElectronHeldPage> page,
                                   const std::string& app_id,
                                   const std::string& preload,
                                   const std::vector<std::string>& arguments,
                                   const std::optional<ElectronNode>& node,
                                   ElectronPageCalls calls,
                                   base::WeakPtr<ElectronSession> session,
                                   const std::string& title,
                                   bool hidden,
                                   const std::string& user_agent) override {
    return AdoptElectronWindow(std::move(page), app_id, preload, arguments,
                               node, std::move(calls), std::move(session),
                               title, hidden, user_agent);
  }
  void SetViews(const std::string& id,
                std::vector<ElectronDeskView> views) override {
    SetElectronViews(id, std::move(views));
  }
  void SetMenuBar(const std::string& id, ElectronDeskMenuBar bar) override {
    SetElectronMenuBar(id, std::move(bar));
  }
  void ShowMessageBox(const std::string& id,
                      ElectronDeskMessageBox box,
                      base::OnceCallback<void(int, bool)> answered) override {
    ShowElectronMessageBox(id, std::move(box), std::move(answered));
  }
  void ShowPopupMenu(const std::string& id,
                     ElectronDeskPopupMenu menu,
                     base::OnceCallback<void(int)> closed) override {
    ShowElectronPopupMenu(id, std::move(menu), std::move(closed));
  }
  void ClosePopupMenu(const std::string& id) override {
    CloseElectronPopupMenu(id);
  }
  void Load(const std::string& id, const GURL& url) override {
    LoadBrowserWindow(id, url);
  }
  void Focus(const std::string& id) override { FocusBrowserWindow(id); }
  void GoToIndex(const std::string& id, int index) override {
    if (ElectronPage* page = ElectronPageOf(id)) {
      page->GoToIndex(index);
    }
  }
  void ClearHistory(const std::string& id) override {
    if (ElectronPage* page = ElectronPageOf(id)) {
      page->ClearHistory();
    }
  }
  void RemoveHistoryEntry(const std::string& id, int index) override {
    if (ElectronPage* page = ElectronPageOf(id)) {
      page->RemoveHistoryEntry(index);
    }
  }
  void Edit(const std::string& id, ElectronEditCommand command) override {
    if (ElectronPage* page = ElectronPageOf(id)) {
      page->Edit(command);
    }
  }
  void Replace(const std::string& id,
               const std::string& text,
               bool misspelling) override {
    if (ElectronPage* page = ElectronPageOf(id)) {
      page->Replace(text, misspelling);
    }
  }
  void FindInPage(const std::string& id,
                  const ElectronFindInPage& find) override {
    if (ElectronPage* page = ElectronPageOf(id)) {
      page->FindInPage(find);
    }
  }
  void StopFindInPage(const std::string& id,
                      ElectronStopFindAction action) override {
    if (ElectronPage* page = ElectronPageOf(id)) {
      page->StopFindInPage(action);
    }
  }
  void SetTitle(const std::string& id, const std::string& title) override {
    SetElectronTitle(id, title);
  }
  void SetHidden(const std::string& id, bool hidden) override {
    SetElectronHidden(id, hidden);
  }
  void SetWindowState(const std::string& id,
                      ElectronWindowState state) override {
    SetElectronWindowState(id, state);
  }
  void AskToClose(const std::string& id) override {
    AskToCloseBrowserWindow(id);
  }
  void Close(const std::string& id) override { CloseBrowserWindow(id); }
  void SendToPage(const std::string& id,
                  const std::string& channel,
                  const std::string& args_json) override {
    if (ElectronPage* page = ElectronPageOf(id)) {
      page->Deliver(channel, args_json);
    }
  }
  void ExecuteJavaScript(
      const std::string& id,
      const std::string& code,
      bool user_gesture,
      base::OnceCallback<void(base::expected<base::Value, std::string>)> done)
      override {
    if (ElectronPage* page = ElectronPageOf(id)) {
      page->ExecuteJavaScript(code, user_gesture, std::move(done));
    } else {
      std::move(done).Run(base::unexpected("the window's page is gone"));
    }
  }
  void PostToPage(const std::string& id,
                  const std::string& channel,
                  const std::string& message_json,
                  const std::vector<std::string>& ports) override {
    if (ElectronPage* page = ElectronPageOf(id)) {
      page->DeliverPost(channel, message_json, ports);
    }
  }
  void PostToPort(const std::string& id,
                  const std::string& port,
                  const std::string& data_json) override {
    if (ElectronPage* page = ElectronPageOf(id)) {
      page->DeliverToPort(port, data_json);
    }
  }
  void ClosePort(const std::string& id, const std::string& port) override {
    if (ElectronPage* page = ElectronPageOf(id)) {
      page->ClosePort(port);
    }
  }
  void SetUserAgent(const std::string& id,
                    const std::string& user_agent) override {
    SetBrowserWindowUserAgent(id, user_agent);
  }
  void CallPage(const std::string& id,
                ElectronPageMethod method,
                ElectronAnswer done) override {
    if (ElectronPage* page = ElectronPageOf(id)) {
      CallElectronPage(*page, std::move(method), std::move(done));
    } else {
      std::move(done).Run(base::unexpected("the window's page is gone"));
    }
  }
  std::optional<std::string> AskPage(const std::string& id,
                                     ElectronPageAction action) override {
    content::WebContents* contents = BrowserWindowContents(id);
    if (contents == nullptr) {
      return "the window's page is gone";
    }
    // Every Electron window's page has them; see OpenElectronWindow.
    ElectronPageEvents* events = ElectronPageEvents::FromWebContents(contents);
    CHECK(events) << "browser window " << id << " is no Electron app's";
    return events->Ask(std::move(action));
  }
  void GetCookies(
      const WebViewPartition& partition,
      const std::optional<GURL>& url,
      base::OnceCallback<void(std::vector<ElectronCookie>)> done) override {
    GetElectronCookies(partition, url, std::move(done));
  }
  void SetCookie(
      const WebViewPartition& partition,
      const ElectronCookieDetails& details,
      base::OnceCallback<void(std::optional<std::string>)> done) override {
    SetElectronCookie(partition, details, std::move(done));
  }
  void RemoveCookie(const WebViewPartition& partition,
                    const GURL& url,
                    const std::string& name,
                    base::OnceClosure done) override {
    RemoveElectronCookie(partition, url, name, std::move(done));
  }
  void FlushCookies(const WebViewPartition& partition,
                    base::OnceClosure done) override {
    FlushElectronCookies(partition, std::move(done));
  }
  std::unique_ptr<ElectronCookieWatch> WatchCookies(
      const WebViewPartition& partition,
      base::RepeatingCallback<void(const ElectronCookieChange&)> changed)
      override {
    return WatchElectronCookies(partition, std::move(changed));
  }
  void ClearStorage(const WebViewPartition& partition,
                    const ElectronClearStorage& clear,
                    base::OnceClosure done) override {
    ClearElectronStorage(partition, clear, std::move(done));
  }
  void ClearCache(const WebViewPartition& partition,
                  base::OnceClosure done) override {
    ClearElectronCache(partition, std::move(done));
  }
  void RunNetworkCall(
      const WebViewPartition& partition,
      const ElectronNetworkCall& call,
      base::OnceCallback<void(base::expected<base::Value, std::string>)> done)
      override {
    RunElectronNetworkCall(partition, call, std::move(done));
  }
  std::unique_ptr<ElectronServiceWorkerWatch> WatchServiceWorkers(
      const WebViewPartition& partition,
      base::RepeatingCallback<void(const ElectronServiceWorkerChange&)> changed)
      override {
    return WatchElectronServiceWorkers(partition, std::move(changed));
  }
};

// One app on the UI thread: its ElectronApp, told of the desk's windows, the
// engine's dictionaries and its GPU.
class AppOnUIThread : public content::GpuDataManagerObserver {
 public:
  explicit AppOnUIThread(ElectronApp::Send send)
      : app_(desk_,
             std::move(send),
             ElectronEngineInfo{
                 .user_agent = embedder_support::GetUserAgent(),
                 .chrome_version = std::string(version_info::GetVersionNumber())},
             ElectronSchemesIn(*base::CommandLine::ForCurrentProcess())),
        listing_(WatchBrowserWindowListing(
            base::BindRepeating(&AppOnUIThread::Listed,
                                base::Unretained(this)))),
        loads_(WatchBrowserWindowLoads(
            base::BindRepeating(&ElectronApp::Loaded,
                                base::Unretained(&app_)))),
        dom_readies_(WatchBrowserWindowDomReadies(
            base::BindRepeating(&ElectronApp::DomReady,
                                base::Unretained(&app_)))),
        dictionaries_(WatchShellSpellcheckDictionaries(
            base::BindRepeating(&ElectronApp::SpellcheckDictionaryInitialized,
                                base::Unretained(&app_)))) {
    CHECK_CURRENTLY_ON(content::BrowserThread::UI);
    content::GpuDataManager::GetInstance()->AddObserver(this);
  }

  ~AppOnUIThread() override {
    content::GpuDataManager::GetInstance()->RemoveObserver(this);
  }

  void Take(const std::string& line) { app_.Take(line); }

  // content::GpuDataManagerObserver:
  void OnGpuInfoUpdate() override { app_.GpuInfoUpdated(); }

 private:
  void Listed() { app_.Listed(ListedBrowserWindows()); }

  ChromeElectronDesk desk_;
  ElectronApp app_;
  base::CallbackListSubscription listing_;
  base::CallbackListSubscription loads_;
  base::CallbackListSubscription dom_readies_;
  base::CallbackListSubscription dictionaries_;
};

// One connection on the IO thread: reads its lines, writes its events, and
// keeps its app on the UI thread for as long as it is open.
class Connection {
 public:
  Connection(std::unique_ptr<net::StreamSocket> socket,
             base::OnceCallback<void(Connection*)> closed)
      : socket_(std::move(socket)),
        closed_(std::move(closed)),
        read_buffer_(
            base::MakeRefCounted<net::IOBufferWithSize>(kReadBufferSize)) {
    app_ = base::SequenceBound<AppOnUIThread>(
        content::GetUIThreadTaskRunner({}),
        base::BindPostTask(content::GetIOThreadTaskRunner({}),
                           base::BindRepeating(&Connection::Send,
                                               weak_factory_.GetWeakPtr())));
  }
  Connection(const Connection&) = delete;
  Connection& operator=(const Connection&) = delete;
  // Destroys its app on the UI thread, which closes the app's windows.
  ~Connection() = default;

  // Starts reading. Not in the constructor: a read that ends at once closes
  // the connection, which its socket must own by then.
  void Start() { Read(); }

 private:
  void Read() {
    const int result = socket_->Read(
        read_buffer_.get(), kReadBufferSize,
        base::BindOnce(&Connection::OnRead, weak_factory_.GetWeakPtr()));
    if (result != net::ERR_IO_PENDING) {
      OnRead(result);
    }
  }

  void OnRead(int result) {
    if (result <= 0) {
      // The app's main process ended, or its socket failed.
      if (result < 0) {
        LOG(ERROR) << "domicile: lost an Electron app: "
                   << net::ErrorToString(result);
      } else {
        VLOG(1) << "domicile: an Electron app closed its connection";
      }
      Close();
      return;
    }
    for (std::string& line : framer_.Take(std::string_view(
             read_buffer_->data(), static_cast<size_t>(result)))) {
      VLOG(2) << "domicile: an Electron app asks " << Described(line);
      app_.AsyncCall(&AppOnUIThread::Take).WithArgs(std::move(line));
    }
    Read();
  }

  void Send(std::string line) {
    VLOG(3) << "domicile: an Electron app hears " << Described(line);
    pending_.push_back(std::move(line));
    if (!writing_) {
      Write();
    }
  }

  void Write() {
    if (pending_.empty()) {
      writing_ = false;
      return;
    }
    writing_ = true;
    std::string line = std::move(pending_.front());
    pending_.pop_front();
    const size_t size = line.size();
    auto buffer = base::MakeRefCounted<net::DrainableIOBuffer>(
        base::MakeRefCounted<net::StringIOBuffer>(std::move(line)), size);
    WriteSome(std::move(buffer));
  }

  void WriteSome(scoped_refptr<net::DrainableIOBuffer> buffer) {
    const int result =
        socket_->Write(buffer.get(), buffer->BytesRemaining(),
                       base::BindOnce(&Connection::OnWrite,
                                      weak_factory_.GetWeakPtr(), buffer),
                       MISSING_TRAFFIC_ANNOTATION);
    if (result != net::ERR_IO_PENDING) {
      OnWrite(std::move(buffer), result);
    }
  }

  void OnWrite(scoped_refptr<net::DrainableIOBuffer> buffer, int result) {
    if (result < 0) {
      LOG(ERROR) << "domicile: could not write to an Electron app: "
                 << net::ErrorToString(result);
      Close();
      return;
    }
    buffer->DidConsume(result);
    if (buffer->BytesRemaining() > 0) {
      WriteSome(std::move(buffer));
    } else {
      Write();
    }
  }

  // Ends this connection. Destroys it, so nothing may follow.
  void Close() { std::move(closed_).Run(this); }

  std::unique_ptr<net::StreamSocket> socket_;
  base::OnceCallback<void(Connection*)> closed_;
  scoped_refptr<net::IOBufferWithSize> read_buffer_;
  LineFramer framer_;
  base::circular_deque<std::string> pending_;
  bool writing_ = false;
  base::SequenceBound<AppOnUIThread> app_;
  base::WeakPtrFactory<Connection> weak_factory_{this};
};

// The listening socket and its open connections, on the IO thread.
class ElectronSocket {
 public:
  ElectronSocket()
      : listener_(base::BindRepeating(&ConnectedByUs),
                  /*use_abstract_namespace=*/false) {}
  ElectronSocket(const ElectronSocket&) = delete;
  ElectronSocket& operator=(const ElectronSocket&) = delete;

  void Listen(const std::string& path) {
    CHECK_CURRENTLY_ON(content::BrowserThread::IO);
    const int result = listener_.BindAndListen(path, kBacklog);
    CHECK_EQ(result, net::OK) << "domicile: could not listen on " << path
                              << ": " << net::ErrorToString(result);
    LOG(INFO) << "domicile: taking Electron apps on " << path;
    Accept();
  }

 private:
  void Accept() {
    const int result = listener_.Accept(
        &accepted_,
        base::BindOnce(&ElectronSocket::OnAccept, base::Unretained(this)));
    if (result != net::ERR_IO_PENDING) {
      OnAccept(result);
    }
  }

  void OnAccept(int result) {
    if (result != net::OK) {
      LOG(ERROR) << "domicile: the Electron socket stopped accepting: "
                 << net::ErrorToString(result)
                 << ". No further Electron apps will open.";
      return;
    }
    auto connection = std::make_unique<Connection>(
        std::move(accepted_),
        base::BindOnce(&ElectronSocket::Closed, base::Unretained(this)));
    Connection& started = *connection;
    connections_.insert(std::move(connection));
    started.Start();
    Accept();
  }

  void Closed(Connection* connection) {
    connections_.erase(connections_.find(connection));
  }

  net::UnixDomainServerSocket listener_;
  std::unique_ptr<net::StreamSocket> accepted_;
  base::flat_set<std::unique_ptr<Connection>, base::UniquePtrComparator>
      connections_;
};

void ListenOnIOThread(const std::string& path) {
  static base::NoDestructor<ElectronSocket> socket;
  socket->Listen(path);
}

}  // namespace

void StartElectronSocket() {
  CHECK_CURRENTLY_ON(content::BrowserThread::UI);
  const base::CommandLine& command_line =
      *base::CommandLine::ForCurrentProcess();
  if (!command_line.HasSwitch(kDomicileElectronSocketSwitch)) {
    return;
  }
  content::GetIOThreadTaskRunner({})->PostTask(
      FROM_HERE,
      base::BindOnce(&ListenOnIOThread, command_line.GetSwitchValueASCII(
                                            kDomicileElectronSocketSwitch)));
}

}  // namespace domicile
