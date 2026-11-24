// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/renderer/electron_node.h"

#include <errno.h>
#include <sys/epoll.h>
#include <unistd.h>

#include <iterator>
#include <memory>
#include <set>
#include <string>
#include <tuple>
#include <utility>
#include <vector>

#include "base/command_line.h"
#include "base/files/file_path.h"
#include "base/functional/bind.h"
#include "base/location.h"
#include "base/logging.h"
#include "base/memory/ptr_util.h"
#include "base/no_destructor.h"
#include "components/domicile/common/electron_node_switches.h"
#include "components/version_info/version_info.h"
#include "gin/converter.h"
#include "node.h"
#include "v8/include/v8-context.h"
#include "v8/include/v8-exception.h"
#include "v8/include/v8-function-callback.h"
#include "v8/include/v8-function.h"
#include "v8/include/v8-isolate.h"
#include "v8/include/v8-local-handle.h"
#include "v8/include/v8-message.h"
#include "v8/include/v8-microtask-queue.h"
#include "v8/include/v8-object.h"
#include "v8/include/v8-primitive.h"
#include "v8/include/v8-script.h"

namespace domicile {
namespace {

// Run by Node as it starts, where Electron runs its renderer's `node_init`:
// with Node's process object and the require Node gives an embedder, which
// loads only the modules a user may (`module`, not Node's internal ones), the
// preload's `electron`, and what the browser said of the window. It makes Node
// look as it does in an Electron renderer, then loads the preload.
constexpr char kNodeInit[] = R"JS(
(function (process, builtinRequire, electron, options) {
  'use strict';
  const Module = builtinRequire('module');
  const path = builtinRequire('path');
  const timers = builtinRequire('timers');
  const world = globalThis;

  // require('electron') is the preload's contextBridge and ipcRenderer.
  const electronIds = new Set(['electron', 'electron/renderer',
                               'electron/common']);
  const load = Module._load;
  Module._load = function (request, parent, isMain) {
    if (electronIds.has(request)) return electron;
    return Reflect.apply(load, this, [request, parent, isMain]);
  };

  // A preload keeps process, global and Buffer after the page's world loses
  // them, as Electron wraps every module (Electron's
  // pass_all_globals_through_require.patch passes them).
  Module.wrapper = [
    '(function (exports, require, module, __filename, __dirname, process, ' +
        'global, Buffer) { return function (exports, require, module, ' +
        '__filename, __dirname) { ',
    '\n}.call(this, exports, require, module, __filename, __dirname); });',
  ];

  const fixed = (object, key, value) => {
    Object.defineProperty(object, key, { value, enumerable: true });
  };
  fixed(process, 'type', 'renderer');
  fixed(process, 'sandboxed', false);
  fixed(process, 'contextIsolated', options.contextIsolated);
  fixed(process, 'resourcesPath', options.resourcesPath);
  fixed(process.versions, 'electron', options.electronVersion);
  fixed(process.versions, 'chrome', options.chromeVersion);
  // The app's environment, not the engine's this renderer inherited.
  for (const [key, value] of Object.entries(options.env)) {
    process.env[key] = value;
  }

  // Node's loop runs in turns the page's own tasks don't see: work queued
  // from the page's side wakes it, as Electron's activateUvLoop does.
  const activate = options.activate;
  const waking = (call) => function (...args) {
    activate();
    return Reflect.apply(call, this, args);
  };
  process.nextTick = waking(process.nextTick);
  timers.setImmediate = waking(timers.setImmediate);
  timers.setTimeout = waking(timers.setTimeout);
  timers.setInterval = waking(timers.setInterval);
  world.setImmediate = timers.setImmediate;
  world.clearImmediate = timers.clearImmediate;

  // An exception no handler takes reaches the console as an uncaught one in
  // the world's own script does (from the preload's world, not the page's
  // error event), instead of
  // ending the renderer as Node's default would.
  const uncaught = (error) => {
    if (process.listenerCount('uncaughtException') > 1) return;
    world.reportError(error);
  };
  process.on('uncaughtException', uncaught);

  if (options.integration && !options.contextIsolated) {
    // The page's own world gets Node's module globals, its file's directory
    // the base of its relative requires.
    let filename = path.join(options.appPath, 'index.html');
    if (world.location.protocol === 'file:') {
      filename = path.normalize(
          decodeURIComponent(world.location.pathname));
    }
    const page = new Module(filename, null);
    page.filename = filename;
    page.paths = Module._nodeModulePaths(path.dirname(filename));
    page.loaded = true;
    world.module = page;
    // As Node's own require of a module: its requires, resolved from it.
    const require = (id) => page.require(id);
    require.resolve = (request, resolveOptions) =>
        Module._resolveFilename(request, page, false, resolveOptions);
    require.resolve.paths = (request) =>
        Module._resolveLookupPaths(request, page);
    require.main = process.mainModule;
    require.extensions = Module._extensions;
    require.cache = Module._cache;
    world.require = require;
    world.__filename = filename;
    world.__dirname = path.dirname(filename);
  }

  if (options.preload !== '') {
    try {
      Module._load(options.preload, null, false);
    } catch (error) {
      options.preloadFailed(error);
      console.error(`Unable to load preload script: ${options.preload}`);
      console.error(error);
    }
  }

  if (!options.integration && !options.contextIsolated) {
    // The preload had Node; the page, in the same world, doesn't.
    process.once('loaded', () => {
      for (const name of ['process', 'Buffer', 'setImmediate',
                          'clearImmediate', 'global', 'root', 'GLOBAL']) {
        delete world[name];
      }
    });
  }
  process.emit('loaded');
})
)JS";

// The environments, to find one from its context.
std::set<ElectronNodeEnvironment*>& Environments() {
  static base::NoDestructor<std::set<ElectronNodeEnvironment*>> environments;
  return *environments;
}

// Node's process-wide start, once, as Electron's renderer does it: on the
// renderer's V8 and its platform, without Node's signal handlers.
void StartNodeOnce() {
  static bool started = false;
  if (started) {
    return;
  }
  started = true;
  std::vector<std::string> args = {
      base::CommandLine::ForCurrentProcess()->GetProgram().value(),
      // The renderer's V8 already took the trap handler; V8 takes it once.
      "--disable-wasm-trap-handler",
      // Node turns this on unless told not to, but this renderer's isolate
      // was made without it, its builtins for source phase imports marked
      // disabled: a function V8 later points at one of them stops V8
      // ("!new_code->is_disabled_builtin()"). V8's flags must stay as the
      // isolate was made.
      "--no-js-source-phase-imports",
  };
  const uint64_t flags =
      node::ProcessInitializationFlags::kNoInitializeCppgc |
      node::ProcessInitializationFlags::kNoInitializeV8 |
      node::ProcessInitializationFlags::kNoInitializeNodeV8Platform |
      node::ProcessInitializationFlags::kEnableStdioInheritance |
      node::ProcessInitializationFlags::kNoDefaultSignalHandling |
      // Chromium already set these up, and the engine's environment is not
      // Node's to read: a NODE_OPTIONS there would run in every Node page.
      node::ProcessInitializationFlags::kDisableNodeOptionsEnv |
      node::ProcessInitializationFlags::kNoParseGlobalDebugVariables |
      node::ProcessInitializationFlags::kNoAdjustResourceLimits |
      node::ProcessInitializationFlags::kNoICU;
  std::shared_ptr<node::InitializationResult> result =
      node::InitializeOncePerProcess(
          args, static_cast<node::ProcessInitializationFlags::Flags>(flags));
  for (const std::string& error : result->errors()) {
    LOG(ERROR) << "domicile: Node.js: " << error;
  }
  // The arguments are the engine's own, so Node refusing them is its bug.
  CHECK_EQ(result->early_return(), 0)
      << "domicile: Node.js did not start in this renderer";
}

std::string Describe(v8::Isolate* isolate, const v8::TryCatch& try_catch) {
  if (!try_catch.HasCaught()) {
    return "no exception";
  }
  const v8::String::Utf8Value message(isolate, try_catch.Exception());
  return *message ? std::string(*message, message.length())
                  : "an exception with no message";
}

// Node's JavaScript enters libuv's loop with explicit microtask checkpoints,
// as Node does everywhere; the page's own runs scoped ones. For the length of
// a turn.
class ExplicitMicrotasks {
 public:
  explicit ExplicitMicrotasks(v8::MicrotaskQueue* queue)
      : queue_(queue), policy_(queue->GetMicrotasksPolicy()) {
    queue_->SetMicrotasksPolicy(v8::MicrotasksPolicy::kExplicit);
  }
  ExplicitMicrotasks(const ExplicitMicrotasks&) = delete;
  ExplicitMicrotasks& operator=(const ExplicitMicrotasks&) = delete;
  ~ExplicitMicrotasks() { queue_->SetMicrotasksPolicy(policy_); }

 private:
  const raw_ptr<v8::MicrotaskQueue> queue_;
  const v8::MicrotasksPolicy policy_;
};

}  // namespace

bool IsElectronNodeRenderer() {
  return base::CommandLine::ForCurrentProcess()->HasSwitch(
      kDomicileElectronNodeSwitch);
}

// static
std::unique_ptr<ElectronNodeEnvironment> ElectronNodeEnvironment::Start(
    v8::Isolate* isolate,
    v8::Local<v8::Context> context,
    const mojom::ElectronAppFacts& app,
    const mojom::ElectronNode& node,
    const std::vector<std::string>& arguments,
    v8::Local<v8::Object> electron,
    v8::Local<v8::Function> preload_failed) {
  // The browser sends a Node page only to a renderer it started for one:
  // anything else is the engine's bug, and this one is sandboxed.
  CHECK(IsElectronNodeRenderer())
      << "domicile: an Electron page with Node.js reached a renderer that "
         "was not started for one";
  StartNodeOnce();
  std::unique_ptr<ElectronNodeEnvironment> self =
      base::WrapUnique(new ElectronNodeEnvironment(isolate));
  v8::HandleScope handle_scope(isolate);
  v8::Context::Scope context_scope(context);

  // Node's start and the app's preload run with explicit checkpoints, as
  // Node does everywhere.
  ExplicitMicrotasks microtasks(context->GetMicrotaskQueue());
  CHECK(node::InitializeContext(context).FromMaybe(false))
      << "domicile: Node.js did not take an Electron page's context";
  self->isolate_data_ = node::CreateIsolateData(isolate, &self->loop_,
                                                /*platform=*/nullptr,
                                                /*allocator=*/nullptr);
  CHECK(self->isolate_data_);
  const uint64_t flags = node::EnvironmentFlags::kDefaultFlags |
                         node::EnvironmentFlags::kHideConsoleWindows |
                         node::EnvironmentFlags::kNoGlobalSearchPaths |
                         // Blink's module loader and web globals stay.
                         node::EnvironmentFlags::kNoRegisterESMLoader |
                         node::EnvironmentFlags::kNoBrowserGlobals |
                         node::EnvironmentFlags::kNoCreateInspector |
                         node::EnvironmentFlags::kNoStartDebugSignalHandler;
  std::vector<std::string> argv = {
      base::CommandLine::ForCurrentProcess()->GetProgram().value()};
  argv.insert(argv.end(), arguments.begin(), arguments.end());
  {
    v8::TryCatch try_catch(isolate);
    self->environment_ = node::CreateEnvironment(
        self->isolate_data_, context, argv, {},
        static_cast<node::EnvironmentFlags::Flags>(flags));
    CHECK(self->environment_)
        << "domicile: Node.js did not start in an Electron page: "
        << Describe(isolate, try_catch);
  }
  self->context_.Reset(isolate, context);
  Environments().insert(self.get());

  v8::Local<v8::Object> env = v8::Object::New(isolate);
  for (const auto& [key, value] : node.env) {
    env->CreateDataProperty(context, gin::StringToV8(isolate, key),
                            gin::StringToV8(isolate, value))
        .Check();
  }
  v8::Local<v8::Object> options = v8::Object::New(isolate);
  const auto set = [&](const char* key, v8::Local<v8::Value> value) {
    options
        ->CreateDataProperty(context, gin::StringToSymbol(isolate, key), value)
        .Check();
  };
  set("preload", gin::StringToV8(isolate, node.preload_path));
  set("integration", v8::Boolean::New(isolate, node.integration));
  set("contextIsolated", v8::Boolean::New(isolate, node.context_isolation));
  set("resourcesPath", gin::StringToV8(isolate, app.resources_path));
  set("appPath", gin::StringToV8(isolate, node.app_path));
  set("electronVersion", gin::StringToV8(isolate, app.electron_version));
  set("chromeVersion",
      gin::StringToV8(isolate, std::string(version_info::GetVersionNumber())));
  set("env", env);
  set("preloadFailed", preload_failed);
  set("activate", v8::Function::New(context, &ElectronNodeEnvironment::Activate)
                      .ToLocalChecked());

  {
    v8::TryCatch try_catch(isolate);
    v8::MaybeLocal<v8::Value> loaded = node::LoadEnvironment(
        self->environment_,
        [&](const node::StartExecutionCallbackInfo& info)
            -> v8::MaybeLocal<v8::Value> {
          v8::ScriptOrigin origin(
              gin::StringToV8(isolate, "domicile-electron:///node-init.js"));
          v8::Local<v8::Script> script;
          v8::Local<v8::Value> made;
          // Ours, so its failing to compile is the engine's bug.
          CHECK(v8::Script::Compile(
                    context, gin::StringToV8(isolate, kNodeInit), &origin)
                    .ToLocal(&script) &&
                script->Run(context).ToLocal(&made) && made->IsFunction())
              << "domicile: the Electron page's Node.js start did not compile";
          v8::Local<v8::Value> argv[] = {
              info.process_object, info.native_require, electron, options};
          return made.As<v8::Function>()->Call(
              context, v8::Undefined(isolate),
              static_cast<int>(std::size(argv)), argv);
        });
    // The preload's own exceptions are caught and reported there; this is
    // Node's start or ours failing.
    CHECK(!loaded.IsEmpty())
        << "domicile: Node.js did not load in an Electron page: "
        << Describe(isolate, try_catch);
  }

  // From a fresh task: this may be inside the page's script.
  self->task_runner_->PostTask(
      FROM_HERE,
      base::BindOnce(&ElectronNodeEnvironment::StartPolling, self->weak_this_));
  return self;
}

ElectronNodeEnvironment::ElectronNodeEnvironment(v8::Isolate* isolate)
    : isolate_(isolate),
      task_runner_(base::SingleThreadTaskRunner::GetCurrentDefault()) {
  CHECK_EQ(uv_loop_init(&loop_), 0);
  // Electron's libuv patch: a new watcher interrupts the thread's wait, so
  // it waits on that too.
  CHECK_EQ(uv_loop_configure(&loop_, UV_LOOP_INTERRUPT_ON_IO_CHANGE), 0);
  // With nothing else on the loop, the thread still waits rather than spins.
  CHECK_EQ(uv_async_init(&loop_, &wakeup_, &ElectronNodeEnvironment::Woken),
           0);
  wakeup_.data = this;
  CHECK_EQ(uv_sem_init(&turn_, 0), 0);
  epoll_ = epoll_create1(EPOLL_CLOEXEC);
  PCHECK(epoll_ >= 0);
  epoll_event event = {};
  event.events = EPOLLIN;
  event.data.fd = uv_backend_fd(&loop_);
  PCHECK(epoll_ctl(epoll_, EPOLL_CTL_ADD, uv_backend_fd(&loop_), &event) == 0);
  weak_this_ = weak_factory_.GetWeakPtr();
}

ElectronNodeEnvironment::~ElectronNodeEnvironment() {
  StopPolling();
  Environments().erase(this);
  if (environment_) {
    v8::HandleScope handle_scope(isolate_);
    v8::Local<v8::Context> context = context_.Get(isolate_);
    v8::Context::Scope context_scope(context);
    // Freeing it runs its loop's last callbacks, which enter Node.
    ExplicitMicrotasks microtasks(context->GetMicrotaskQueue());
    std::ignore = node::EmitProcessExit(environment_);
    node::FreeEnvironment(environment_.ExtractAsDangling());
    node::FreeIsolateData(isolate_data_.ExtractAsDangling());
  }
  context_.Reset();
  uv_close(reinterpret_cast<uv_handle_t*>(&wakeup_), nullptr);
  // Whatever Node left open closes now.
  uv_walk(
      &loop_,
      [](uv_handle_t* handle, void*) {
        if (!uv_is_closing(handle)) {
          uv_close(handle, nullptr);
        }
      },
      nullptr);
  while (uv_run(&loop_, UV_RUN_DEFAULT) != 0) {
  }
  CHECK_EQ(uv_loop_close(&loop_), 0);
  uv_sem_destroy(&turn_);
  close(epoll_);
}

bool ElectronNodeEnvironment::RunsIn(v8::Local<v8::Context> context) const {
  return context_ == context;
}

void ElectronNodeEnvironment::StartPolling() {
  if (polling_) {
    return;
  }
  polling_ = true;
  CHECK_EQ(uv_thread_create(&thread_, &ElectronNodeEnvironment::Poll, this), 0);
  RunOnce();
}

void ElectronNodeEnvironment::StopPolling() {
  if (!polling_) {
    return;
  }
  closing_ = true;
  // The thread waits on the turn or on the loop: wake both.
  uv_sem_post(&turn_);
  uv_async_send(&wakeup_);
  uv_thread_join(&thread_);
  polling_ = false;
}

void ElectronNodeEnvironment::RunOnce() {
  if (!environment_ || closing_) {
    return;
  }
  if (turns_ < 12) {
    LOG(INFO) << "domicile: an Electron page's Node.js turns (" << turns_ + 1
              << ")";
  }
  v8::HandleScope handle_scope(isolate_);
  v8::Local<v8::Context> context = context_.Get(isolate_);
  v8::Context::Scope context_scope(context);
  {
    ExplicitMicrotasks microtasks(context->GetMicrotaskQueue());
    // The thread is parked until the post below, and reads the loop's
    // timeout again before it waits, so a watcher started now needn't
    // interrupt it.
    uv_loop_interrupt_suspend(&loop_);
    const int alive = uv_run(&loop_, UV_RUN_NOWAIT);
    uv_loop_interrupt_resume(&loop_);
    // What guard-electron-node.sh reads when Node's loop stalls.
    if (++turns_ <= 12) {
      LOG(INFO) << "domicile: an Electron page's Node.js turned (" << turns_
                << "), " << (alive ? "alive" : "idle") << ", waiting "
                << uv_backend_timeout(&loop_) << " ms for its next";
    }
  }
  uv_sem_post(&turn_);
}

// static
void ElectronNodeEnvironment::Poll(void* arg) {
  auto* self = static_cast<ElectronNodeEnvironment*>(arg);
  for (int waits = 1;; ++waits) {
    uv_sem_wait(&self->turn_);
    if (self->closing_) {
      return;
    }
    const int timeout = uv_backend_timeout(&self->loop_);
    epoll_event event;
    int ready;
    do {
      ready = epoll_wait(self->epoll_, &event, 1, timeout);
    } while (ready == -1 && errno == EINTR);
    // Only our own epoll and the loop's are in this, so a failure is ours.
    PCHECK(ready >= 0) << "domicile: an Electron page's Node.js stopped "
                          "waiting on its loop";
    if (self->closing_) {
      return;
    }
    if (waits <= 12) {
      LOG(INFO) << "domicile: an Electron page's Node.js waited (" << waits
                << ") up to " << timeout << " ms, " << ready
                << " ready; asking for a turn";
    }
    self->task_runner_->PostTask(
        FROM_HERE,
        base::BindOnce(&ElectronNodeEnvironment::RunOnce, self->weak_this_));
  }
}

// static
void ElectronNodeEnvironment::Woken(uv_async_t* handle) {
  auto* self = static_cast<ElectronNodeEnvironment*>(handle->data);
  if (!self->environment_ || self->closing_) {
    return;
  }
  // In RunOnce's turn: its context and explicit microtasks. Closing the scope
  // runs the ticks queued from the page's side, as Electron's OnCallNextTick
  // does, which no Node callback would otherwise run.
  v8::HandleScope handle_scope(self->isolate_);
  node::CallbackScope scope(self->isolate_, v8::Object::New(self->isolate_),
                            {0, 0});
}

// static
void ElectronNodeEnvironment::Activate(
    const v8::FunctionCallbackInfo<v8::Value>& info) {
  v8::Local<v8::Context> context = info.GetIsolate()->GetCurrentContext();
  for (ElectronNodeEnvironment* environment : Environments()) {
    if (environment->RunsIn(context)) {
      uv_async_send(&environment->wakeup_);
      return;
    }
  }
}

}  // namespace domicile
