// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef COMPONENTS_DOMICILE_BROWSER_DESK_FAULTS_H_
#define COMPONENTS_DOMICILE_BROWSER_DESK_FAULTS_H_

#include <stdint.h>

#include <string>
#include <utility>
#include <vector>

#include "base/functional/callback.h"
#include "base/synchronization/lock.h"
#include "base/thread_annotations.h"

namespace domicile {

// Bugs the engine catches in itself, for the compositor to tell the person
// about. A platform bug is loud: the compositor logs it as an error and shows
// an urgent notification with a way to report it, rather than leaving a broken
// window unexplained.
//
// Reported on the UI thread and listened for from each control channel's
// thread, hence the lock. Callers must wrap callbacks with
// `base::BindPostTask`: they run on the thread that reported, and never under
// the lock.
class DeskFaults {
 public:
  // Handle for removing a listener. Never zero.
  using ListenerId = uint64_t;

  // The process-wide one. Tests build their own instead.
  static DeskFaults& Get();

  DeskFaults();
  DeskFaults(const DeskFaults&) = delete;
  DeskFaults& operator=(const DeskFaults&) = delete;
  ~DeskFaults();

  // Hears what went wrong, in a sentence a person can read.
  using Listener = base::RepeatingCallback<void(const std::string& what)>;

  ListenerId AddListener(Listener heard);
  void RemoveListener(ListenerId listener);

  // Tells the first listener: each monitor's shell page has a control channel
  // to the one compositor, which should show one notification, not one per
  // monitor. Also logged as an error here, so a fault with no compositor to
  // hear it still reaches the log.
  void Report(const std::string& what);

 private:
  base::Lock lock_;
  ListenerId next_id_ GUARDED_BY(lock_) = 1;
  std::vector<std::pair<ListenerId, Listener>> listeners_ GUARDED_BY(lock_);
};

}  // namespace domicile

#endif  // COMPONENTS_DOMICILE_BROWSER_DESK_FAULTS_H_
