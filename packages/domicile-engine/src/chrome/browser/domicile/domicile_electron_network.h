// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef CHROME_BROWSER_DOMICILE_DOMICILE_ELECTRON_NETWORK_H_
#define CHROME_BROWSER_DOMICILE_DOMICILE_ELECTRON_NETWORK_H_

#include <memory>
#include <string>

#include "base/functional/callback.h"
#include "base/types/expected.h"
#include "base/values.h"
#include "components/domicile/browser/electron_network_calls.h"
#include "components/domicile/browser/web_view_partition.h"

namespace domicile {

// An Electron app session's network and the rest of its storage, in
// `partition` of the shell's profile (see domicile_electron_storage.h):
// clearData, clearAuthCache, clearCodeCaches, resolveHost, preconnect,
// getStoragePath, setCodeCachePath and the shared dictionary calls, each answered once by
// `done` with its result or why it failed. With no shell there is no
// profile: the calls that clear clear nothing, and the ones that answer
// say there is nothing to ask. See electron_network_calls.h.
void RunElectronNetworkCall(
    const WebViewPartition& partition,
    const ElectronNetworkCall& call,
    base::OnceCallback<void(base::expected<base::Value, std::string>)> done);

// Calls `changed` with each change to the service workers of `partition`
// until the watch is destroyed. Hears nothing without a shell.
std::unique_ptr<ElectronServiceWorkerWatch> WatchElectronServiceWorkers(
    const WebViewPartition& partition,
    base::RepeatingCallback<void(const ElectronServiceWorkerChange&)> changed);

}  // namespace domicile

#endif  // CHROME_BROWSER_DOMICILE_DOMICILE_ELECTRON_NETWORK_H_
