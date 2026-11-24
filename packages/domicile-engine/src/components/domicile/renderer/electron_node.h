// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef COMPONENTS_DOMICILE_RENDERER_ELECTRON_NODE_H_
#define COMPONENTS_DOMICILE_RENDERER_ELECTRON_NODE_H_

#include <atomic>
#include <memory>
#include <string>
#include <vector>

#include "base/memory/raw_ptr.h"
#include "base/memory/scoped_refptr.h"
#include "base/memory/weak_ptr.h"
#include "base/task/single_thread_task_runner.h"
#include "components/domicile/mojom/electron_frame.mojom.h"
#include "uv.h"
#include "v8/include/v8-forward.h"
#include "v8/include/v8-persistent-handle.h"

namespace node {
class Environment;
class IsolateData;
}  // namespace node

namespace domicile {

// Whether this renderer was started for an Electron page with Node.js: see
// components/domicile/common/electron_node_switches.h. Only such a renderer
// may start Node.
bool IsElectronNodeRenderer();

// Node.js in one document of an Electron window that isn't sandboxed, as
// Electron's renderer has it (its NodeBindings): a Node environment in the
// preload's world, the main world without context isolation, whose libuv
// loop runs off the renderer's own. A thread waits on the loop's backend and
// posts a turn of it to the renderer's main thread, one at a time.
//
// It loads the window's preload with Node's require, `require("electron")`
// giving it the preload's contextBridge and ipcRenderer. With
// nodeIntegration and no context isolation, the page gets `require`,
// `module`, `__filename` and `__dirname`; without integration, Node's globals
// leave the main world once the preload ran, as Electron removes them.
//
// One per document; freeing it ends the environment, before its context goes.
class ElectronNodeEnvironment final {
 public:
  // Starts Node in `context`, the preload's world, and loads `node`'s
  // preload. Its process has what `app` says, and an argv of the renderer's
  // program and `arguments`, the window's additionalArguments. `electron` is what `require("electron")`
  // gives, and `preload_failed` hears what the preload threw. Node failing to
  // start is the engine's bug, so it ends the renderer.
  static std::unique_ptr<ElectronNodeEnvironment> Start(
      v8::Isolate* isolate,
      v8::Local<v8::Context> context,
      const mojom::ElectronAppFacts& app,
      const mojom::ElectronNode& node,
      const std::vector<std::string>& arguments,
      v8::Local<v8::Object> electron,
      v8::Local<v8::Function> preload_failed);

  ElectronNodeEnvironment(const ElectronNodeEnvironment&) = delete;
  ElectronNodeEnvironment& operator=(const ElectronNodeEnvironment&) = delete;
  ~ElectronNodeEnvironment();

  // Whether `context` is the one it runs in.
  bool RunsIn(v8::Local<v8::Context> context) const;

 private:
  explicit ElectronNodeEnvironment(v8::Isolate* isolate);

  // Begins the loop's turns, from a fresh task: the environment may have
  // started inside the page's script.
  void StartPolling();
  // Parks the thread, so only the main thread touches the loop.
  void StopPolling();
  // A turn of the loop, on the main thread, then lets the thread wait again.
  void RunOnce();
  // On the thread: waits for the loop's backend, then posts a turn.
  static void Poll(void* self);
  // Node's JavaScript asked for a turn soon, as a new tick, immediate or
  // timer does from the page's own task: wakes the thread, which then waits
  // only until the loop's earliest timer.
  static void Activate(const v8::FunctionCallbackInfo<v8::Value>& info);
  // The wakeup in a turn: runs Node's queued ticks.
  static void Woken(uv_async_t* handle);

  const raw_ptr<v8::Isolate> isolate_;
  scoped_refptr<base::SingleThreadTaskRunner> task_runner_;
  uv_loop_t loop_;
  // Wakes the thread, and keeps the loop alive while nothing else does.
  uv_async_t wakeup_;
  // Lock step: the thread waits on it after each turn it posted.
  uv_sem_t turn_;
  uv_thread_t thread_;
  bool polling_ = false;
  // Turns so far, for the log of the first few.
  int turns_ = 0;
  std::atomic<bool> closing_{false};
  // Waits on the loop's backend, which is itself an epoll.
  int epoll_ = -1;
  raw_ptr<node::IsolateData> isolate_data_ = nullptr;
  raw_ptr<node::Environment> environment_ = nullptr;
  v8::Global<v8::Context> context_;
  // Made on the main thread, for the thread's posts.
  base::WeakPtr<ElectronNodeEnvironment> weak_this_;
  base::WeakPtrFactory<ElectronNodeEnvironment> weak_factory_{this};
};

}  // namespace domicile

#endif  // COMPONENTS_DOMICILE_RENDERER_ELECTRON_NODE_H_
