// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef COMPONENTS_DOMICILE_BROWSER_SHELL_SWAP_H_
#define COMPONENTS_DOMICILE_BROWSER_SHELL_SWAP_H_

#include <optional>
#include <string>
#include <vector>

#include "base/files/file_path.h"
#include "base/functional/callback.h"
#include "base/memory/raw_ref.h"
#include "base/synchronization/lock.h"
#include "base/thread_annotations.h"
#include "base/time/time.h"
#include "base/timer/timer.h"
#include "components/domicile/browser/shell_source.h"

namespace domicile {

// Whether the shell's page ran its module: nullopt once `Shell` returned, or
// why it did not run, as the page's error screen says it.
using ShellOutcome = std::optional<std::string>;

// What the shell's page says of its module, from any thread, with the
// ShellSource serial its document was served for.
//
// The page says it on its control channel, which is read on the IO thread;
// the swap that waits for it lives on the UI thread with the shell's window.
// Like DeskActivity, listeners run on the reporting thread and outside the
// lock, so callers wrap them with `base::BindPostTask`.
class ShellReports {
 public:
  using Listener = base::RepeatingCallback<void(const std::string& serial,
                                                const ShellOutcome& ran)>;

  // The process-wide one. Tests build their own instead.
  static ShellReports& Get();

  ShellReports();
  ShellReports(const ShellReports&) = delete;
  ShellReports& operator=(const ShellReports&) = delete;
  ~ShellReports();

  // Calls `heard` on each later `Heard`. For the life of the process.
  void Listen(Listener heard);

  void Heard(const std::string& serial, const ShellOutcome& ran);

 private:
  base::Lock lock_;
  std::vector<Listener> listeners_ GUARDED_BY(lock_);
};

// Swaps the shell for `domicile load-shell`, and puts the old one back when
// the new one does not run.
//
// A shell that 404s, will not parse or throws leaves the window on its error
// screen, with no shell to load another from. So the swap waits for the page
// to say whether the module ran. If it did not, the swap serves the shell it
// replaced again and answers with why. A shell that says nothing for
// `patience` is taken as loaded.
//
// Nothing to go back to -- the same shell loaded again, as after a rebuild --
// leaves the error screen up. The files were rebuilt in place, so the old
// shell is gone either way.
//
// On one sequence: the UI thread's, with the shell's window.
class ShellSwap {
 public:
  // nullopt once the new shell ran, or why it did not.
  using Swapped = base::OnceCallback<void(const ShellOutcome& ran)>;

  // `load` loads whatever `source` serves into the shell's window. `changed`
  // runs before the swap loads a shell other than the one it serves now.
  ShellSwap(ShellSource& source,
            base::RepeatingClosure load,
            base::RepeatingClosure changed,
            base::TimeDelta patience);
  ShellSwap(const ShellSwap&) = delete;
  ShellSwap& operator=(const ShellSwap&) = delete;
  ~ShellSwap();

  // Serves `module` out of `root`, as `files` says, loads it, and answers
  // `swapped` once the page says whether it ran. A swap still waiting is
  // answered first, as replaced; the shell to go back to stays the one that
  // last ran.
  void Swap(const base::FilePath& root,
            const std::string& module,
            ShellFiles files,
            Swapped swapped);

  // The shell's page served for ShellSource serial `serial` said whether its
  // module ran. Ignored unless it is the page the waiting swap served: the
  // page before the swap may run its module after the swap starts, and a
  // reload or the old shell coming back has no swap waiting.
  void Heard(const std::string& serial, const ShellOutcome& ran);

 private:
  // A shell to serve: a module under a root.
  struct Served {
    base::FilePath root;
    std::string module;
    ShellFiles files = ShellFiles::kDirectory;
  };

  // Answers the waiting swap with `ran` and stops waiting.
  void Answer(const ShellOutcome& ran);

  // Serves `shell` and loads it, telling `changed_` first if it is another.
  void Serve(const Served& shell);

  const raw_ref<ShellSource> source_;
  const base::RepeatingClosure load_;
  const base::RepeatingClosure changed_;
  const base::TimeDelta patience_;

  // How to answer the waiting swap, null while none waits, and the shell
  // that ran before it.
  Swapped swapped_;
  Served previous_;
  base::OneShotTimer patience_timer_;
};

}  // namespace domicile

#endif  // COMPONENTS_DOMICILE_BROWSER_SHELL_SWAP_H_
