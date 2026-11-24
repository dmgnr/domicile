// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/browser/desk_faults.h"

#include <optional>
#include <utility>

#include "base/logging.h"
#include "base/no_destructor.h"

namespace domicile {

// static
DeskFaults& DeskFaults::Get() {
  static base::NoDestructor<DeskFaults> faults;
  return *faults;
}

DeskFaults::DeskFaults() = default;
DeskFaults::~DeskFaults() = default;

DeskFaults::ListenerId DeskFaults::AddListener(Listener heard) {
  base::AutoLock held(lock_);
  const ListenerId id = next_id_++;
  listeners_.emplace_back(id, std::move(heard));
  return id;
}

void DeskFaults::RemoveListener(ListenerId listener) {
  base::AutoLock held(lock_);
  std::erase_if(listeners_, [listener](const auto& registered) {
    return registered.first == listener;
  });
}

void DeskFaults::Report(const std::string& what) {
  // engine-diagnostics.sh greps for the `domicile:` prefix.
  LOG(ERROR) << "domicile: a bug: " << what;
  // Run outside the lock, since a callback may re-enter this.
  std::optional<Listener> tell;
  {
    base::AutoLock held(lock_);
    if (!listeners_.empty()) {
      tell = listeners_.front().second;
    }
  }
  if (tell) {
    tell->Run(what);
  }
}

}  // namespace domicile
