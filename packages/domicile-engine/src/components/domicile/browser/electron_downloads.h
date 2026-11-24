// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef COMPONENTS_DOMICILE_BROWSER_ELECTRON_DOWNLOADS_H_
#define COMPONENTS_DOMICILE_BROWSER_ELECTRON_DOWNLOADS_H_

#include <string>

#include "base/files/file_path.h"
#include "base/functional/callback.h"
#include "base/memory/weak_ptr.h"
#include "components/domicile/browser/electron_app.h"

namespace download {
class DownloadItem;
}

namespace domicile {

// Marks `item`, which desk window `window`'s page started in `session`, as
// that app's download, as Electron's session sees it: will-download decides
// where it goes, and its DownloadItem hears how it goes. The mark lives as
// long as `item`, so it outlives a page that closes first, as Slack's hidden
// download window does.
void MarkElectronDownload(download::DownloadItem& item,
                          base::WeakPtr<ElectronSession> session,
                          const std::string& window);

// Whether `item` is marked as an app's download.
bool IsElectronAppDownload(const download::DownloadItem& item);

// Asks the will-download of the session whose app's download `item` is where
// it goes, reading `suggested_path`'s name. `decided` runs once with the
// answer: a cancel when the app has gone. From
// ChromeDownloadManagerDelegate::RequestConfirmation, before any picker.
void AskElectronAppWhereDownloadGoes(
    download::DownloadItem& item,
    const base::FilePath& suggested_path,
    base::OnceCallback<void(ElectronDownloadAnswer)> decided);

}  // namespace domicile

#endif  // COMPONENTS_DOMICILE_BROWSER_ELECTRON_DOWNLOADS_H_
