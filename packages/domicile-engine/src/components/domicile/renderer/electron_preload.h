// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef COMPONENTS_DOMICILE_RENDERER_ELECTRON_PRELOAD_H_
#define COMPONENTS_DOMICILE_RENDERER_ELECTRON_PRELOAD_H_

#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "base/containers/span.h"
#include "base/memory/weak_ptr.h"
#include "components/domicile/mojom/electron_frame.mojom.h"
#include "content/public/renderer/render_frame_observer.h"
#include "content/public/renderer/render_frame_observer_tracker.h"
#include "mojo/public/cpp/bindings/associated_receiver.h"
#include "mojo/public/cpp/bindings/associated_remote.h"
#include "mojo/public/cpp/bindings/pending_associated_remote.h"
#include "v8/include/v8-forward.h"
#include "v8/include/v8-persistent-handle.h"

namespace domicile {

class ElectronNodeEnvironment;

// An Electron app window's preload, in the renderer. The browser sends the
// preload before each navigation commits; this runs it in an isolated world
// once the new document has its element, before any of the page's scripts,
// with `require("electron")` giving it contextBridge and ipcRenderer. See
// docs/architecture/ELECTRON-APPS.md.
//
// A window that isn't sandboxed has Node.js in its page instead: Node loads
// the preload from its file, in the isolated world or, without context
// isolation, in the page's own. See electron_node.h.
//
// Every main frame has one; only those the browser sends a preload to do
// anything.
class ElectronPreload final
    : public content::RenderFrameObserver,
      public content::RenderFrameObserverTracker<ElectronPreload>,
      public mojom::ElectronFrame {
 public:
  // Gives `frame` one when it is a main frame. The frame owns it.
  static void Attach(content::RenderFrame* frame);

  // Runs `frame`'s preload, if the browser sent one for the document just
  // committed. ContentRendererClient::RunScriptsAtDocumentStart calls this:
  // DidCreateDocumentElement is too early, as Blink forbids script there.
  // False when the preload ended the frame, which must then not be touched.
  [[nodiscard]] static bool RunAtDocumentStart(content::RenderFrame* frame);

  // Tells `frame`'s preload's process document-end, as Electron's does.
  // ContentRendererClient::RunScriptsAtDocumentEnd calls this: Blink forbids
  // script in RenderFrameObserver::DidDispatchDOMContentLoadedEvent. False
  // when a listener ended the frame, which must then not be touched.
  [[nodiscard]] static bool RunAtDocumentEnd(content::RenderFrame* frame);

  ElectronPreload(const ElectronPreload&) = delete;
  ElectronPreload& operator=(const ElectronPreload&) = delete;
  ~ElectronPreload() override;

  // content::RenderFrameObserver:
  void ReadyToCommitNavigation(
      blink::WebDocumentLoader* document_loader) override;
  void WillReleaseScriptContext(v8::Local<v8::Context> context,
                                int32_t world_id) override;
  void OnDestruct() override;

  // mojom::ElectronFrame:
  void Preload(
      const std::string& source,
      const std::vector<std::string>& arguments,
      mojom::ElectronAppFactsPtr app,
      mojom::ElectronNodePtr node,
      mojo::PendingAssociatedRemote<mojom::ElectronFrameHost> host) override;
  void Deliver(const std::string& channel,
               const std::string& args_json) override;
  void DeliverPost(const std::string& channel,
                   const std::string& message_json,
                   const std::vector<std::string>& ports) override;
  void DeliverToPort(const std::string& port,
                     const std::string& data_json) override;
  void ClosePort(const std::string& port) override;
  void ExecuteJavaScript(const std::string& code,
                         bool user_gesture,
                         ExecuteJavaScriptCallback callback) override;
  void InsertCSS(const std::string& css,
                 bool user,
                 InsertCSSCallback callback) override;
  void RemoveInsertedCSS(const std::string& key, bool user) override;
  void ExecuteJavaScriptInWorld(
      int32_t world,
      std::vector<mojom::ElectronScriptPtr> scripts,
      bool user_gesture,
      ExecuteJavaScriptInWorldCallback callback) override;

 private:
  // A preload for a document.
  struct ToRun {
    std::string source;
    // webPreferences.additionalArguments, for process.argv.
    std::vector<std::string> arguments;
    // What the app said of itself, for process.
    mojom::ElectronAppFactsPtr app;
    // Node in the page, which then loads the preload from its file.
    mojom::ElectronNodePtr node;
  };
  struct Next {
    ToRun preload;
    mojo::PendingAssociatedRemote<mojom::ElectronFrameHost> host;
  };

  explicit ElectronPreload(content::RenderFrame* frame);

  void Bind(mojo::PendingAssociatedReceiver<mojom::ElectronFrame> receiver);
  // False when the preload ended the frame, and this with it.
  [[nodiscard]] bool Run(ToRun preload);
  // The context of the preload's world in the current document.
  v8::Local<v8::Context> WorldContext(v8::Isolate* isolate);
  // Calls the bootstrap's `name`, in the preload's world.
  void Call(const char* name, base::span<v8::Local<v8::Value>> argv);
  void Answered(uint64_t document,
                double id,
                bool ok,
                const std::string& answer);

  // The preload's natives, which the bootstrap wraps.
  static ElectronPreload* Of(v8::Isolate* isolate);
  static void Send(const v8::FunctionCallbackInfo<v8::Value>& info);
  static void Invoke(const v8::FunctionCallbackInfo<v8::Value>& info);
  static void Expose(const v8::FunctionCallbackInfo<v8::Value>& info);
  static void SendSync(const v8::FunctionCallbackInfo<v8::Value>& info);
  static void Post(const v8::FunctionCallbackInfo<v8::Value>& info);
  static void PortPost(const v8::FunctionCallbackInfo<v8::Value>& info);
  static void PortClose(const v8::FunctionCallbackInfo<v8::Value>& info);
  static void PreloadFailed(const v8::FunctionCallbackInfo<v8::Value>& info);
  static void InsertCss(const v8::FunctionCallbackInfo<v8::Value>& info);
  static void RemoveInsertedCss(
      const v8::FunctionCallbackInfo<v8::Value>& info);
  static void DeviceScale(const v8::FunctionCallbackInfo<v8::Value>& info);
  static void SetPageScaleLimits(
      const v8::FunctionCallbackInfo<v8::Value>& info);

  // webFrame.routingId: this frame's number in its renderer.
  const int routing_id_;

  mojo::AssociatedReceiver<mojom::ElectronFrame> receiver_{this};
  // The preload for the navigation about to commit.
  std::optional<Next> next_;
  // The committed document's preload, until it runs.
  std::optional<ToRun> to_run_;
  // The world the preload runs in: its own, or the page's without context
  // isolation.
  int32_t world_ = 0;
  // Node in the current document, for a window that isn't sandboxed.
  std::unique_ptr<ElectronNodeEnvironment> node_;
  // Counts documents, so an answer for one that went is dropped.
  uint64_t document_ = 0;
  mojo::AssociatedRemote<mojom::ElectronFrameHost> host_;
  // What the bootstrap gave back: the calls the browser's messages make.
  v8::Global<v8::Object> bootstrap_;
  base::WeakPtrFactory<ElectronPreload> weak_factory_{this};
};

}  // namespace domicile

#endif  // COMPONENTS_DOMICILE_RENDERER_ELECTRON_PRELOAD_H_
