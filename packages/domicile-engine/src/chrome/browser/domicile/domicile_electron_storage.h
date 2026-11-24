// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef CHROME_BROWSER_DOMICILE_DOMICILE_ELECTRON_STORAGE_H_
#define CHROME_BROWSER_DOMICILE_DOMICILE_ELECTRON_STORAGE_H_

#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "base/functional/callback.h"
#include "components/domicile/browser/electron_app.h"
#include "components/domicile/browser/electron_protocol.h"
#include "components/domicile/browser/web_view_partition.h"
#include "url/gurl.h"

namespace content {
class StoragePartition;
}  // namespace content

namespace domicile {

// The storage of `partition`, as WebViewGuest makes it for a window there,
// or none without a shell.
content::StoragePartition* StorageOf(const WebViewPartition& partition);

// An Electron app session's storage: its cookies (session.cookies), its
// sites' data (clearStorageData) and its HTTP cache, in `partition` of the
// shell's profile, where the app's windows keep theirs. Each runs `done`
// once. With no shell there is no profile, so there is nothing to find,
// keep or clear. See "Sessions" in docs/architecture/ELECTRON-APPS.md.

void GetElectronCookies(
    const WebViewPartition& partition,
    const std::optional<GURL>& url,
    base::OnceCallback<void(std::vector<ElectronCookie>)> done);
void SetElectronCookie(
    const WebViewPartition& partition,
    const ElectronCookieDetails& details,
    base::OnceCallback<void(std::optional<std::string> why)> done);
void RemoveElectronCookie(const WebViewPartition& partition,
                          const GURL& url,
                          const std::string& name,
                          base::OnceClosure done);
void FlushElectronCookies(const WebViewPartition& partition,
                          base::OnceClosure done);
// Calls `changed` with each change to the cookies, as session.cookies'
// `changed` says it, until the watch is destroyed. Hears nothing without a
// shell.
std::unique_ptr<ElectronCookieWatch> WatchElectronCookies(
    const WebViewPartition& partition,
    base::RepeatingCallback<void(const ElectronCookieChange&)> changed);
void ClearElectronStorage(const WebViewPartition& partition,
                          const ElectronClearStorage& clear,
                          base::OnceClosure done);
void ClearElectronCache(const WebViewPartition& partition,
                        base::OnceClosure done);

}  // namespace domicile

#endif  // CHROME_BROWSER_DOMICILE_DOMICILE_ELECTRON_STORAGE_H_
