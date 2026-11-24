// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "content/browser/domicile/domicile_log_levels.h"

#include <optional>
#include <string>

#include "base/logging.h"
#include "base/no_destructor.h"
#include "base/synchronization/lock.h"
#include "content/browser/child_process_host_impl.h"
#include "content/browser/renderer_host/render_process_host_impl.h"
#include "content/public/browser/browser_child_process_host_iterator.h"
#include "content/public/browser/browser_thread.h"
#include "content/public/browser/domicile_log_levels.h"
#include "content/public/browser/render_process_host.h"

namespace content {

namespace {

struct LogLevels {
  int min_level;
  std::string vmodule;
};

// Child process hosts start on the UI and IO threads, so the levels are
// read under a lock.
base::Lock& LevelsLock() {
  static base::NoDestructor<base::Lock> lock;
  return *lock;
}

std::optional<LogLevels>& Levels() {
  static base::NoDestructor<std::optional<LogLevels>> levels;
  return *levels;
}

}  // namespace

void SetDomicileLogLevels(int min_level, const std::string& vmodule) {
  DCHECK_CURRENTLY_ON(BrowserThread::UI);
  {
    base::AutoLock locked(LevelsLock());
    Levels() = LogLevels{min_level, vmodule};
  }
  logging::SetMinLogLevel(min_level);
  logging::SetVmodule(vmodule);
  for (RenderProcessHost::iterator it = RenderProcessHost::AllHostsIterator();
       !it.IsAtEnd(); it.Advance()) {
    RenderProcessHost* host = it.GetCurrentValue();
    // A host not yet initialized gets them from SendDomicileLogLevels.
    if (host->IsInitializedAndNotDead()) {
      static_cast<RenderProcessHostImpl*>(host)->DomicileSetLogLevels(min_level,
                                                                      vmodule);
    }
  }
  for (BrowserChildProcessHostIterator it; !it.Done(); ++it) {
    static_cast<ChildProcessHostImpl*>(it.GetHost())
        ->child_process()
        ->SetLogLevels(min_level, vmodule);
  }
}

void SendDomicileLogLevels(mojom::ChildProcess& child) {
  base::AutoLock locked(LevelsLock());
  if (const std::optional<LogLevels>& levels = Levels()) {
    child.SetLogLevels(levels->min_level, levels->vmodule);
  }
}

}  // namespace content
