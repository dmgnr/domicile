// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/browser/electron_downloads.h"

#include <memory>
#include <optional>
#include <string>
#include <utility>

#include "base/check.h"
#include "base/logging.h"
#include "base/memory/raw_ref.h"
#include "base/notreached.h"
#include "base/scoped_observation.h"
#include "base/supports_user_data.h"
#include "base/time/time.h"
#include "components/download/public/common/download_item.h"
#include "url/origin.h"

namespace domicile {
namespace {

const char kMarkKey[] = "domicile_electron_download";

ElectronDownloadState StateOf(const download::DownloadItem& item) {
  switch (item.GetState()) {
    case download::DownloadItem::IN_PROGRESS:
      return ElectronDownloadState::kProgressing;
    case download::DownloadItem::COMPLETE:
      return ElectronDownloadState::kCompleted;
    case download::DownloadItem::CANCELLED:
      return ElectronDownloadState::kCanceled;
    case download::DownloadItem::INTERRUPTED:
      return ElectronDownloadState::kInterrupted;
    case download::DownloadItem::MAX_DOWNLOAD_STATE:
      break;
  }
  NOTREACHED();
}

ElectronDownloadDetails DetailsOf(const download::DownloadItem& item,
                                  const base::FilePath& suggested_path) {
  return {
      .url = item.GetURL(),
      .url_chain = item.GetUrlChain(),
      .filename = suggested_path.BaseName().AsUTF8Unsafe(),
      .mime_type = item.GetMimeType(),
      .total_bytes = item.GetTotalBytes(),
      .content_disposition = item.GetContentDisposition(),
      .has_user_gesture = item.HasUserGesture(),
      .start_time = item.GetStartTime().InSecondsFSinceUnixEpoch(),
      .etag = item.GetETag(),
      .last_modified = item.GetLastModifiedTime(),
      .initiator_origin = item.GetRequestInitiator().has_value()
                              ? item.GetRequestInitiator()->Serialize()
                              : std::string(),
  };
}

ElectronDownloadProgress ProgressOf(const download::DownloadItem& item) {
  return {
      .state = StateOf(item),
      .done = item.IsDone(),
      .paused = item.IsPaused(),
      .can_resume = item.CanResume(),
      .received_bytes = item.GetReceivedBytes(),
      .total_bytes = item.GetTotalBytes(),
      .bytes_per_second = item.CurrentSpeed(),
      .save_path = item.GetTargetFilePath(),
      .filename = item.GetFileNameToReportUser().AsUTF8Unsafe(),
      .mime_type = item.GetMimeType(),
      .end_time =
          item.IsDone()
              ? std::optional(item.GetEndTime().InSecondsFSinceUnixEpoch())
              : std::nullopt,
  };
}

// The app's hold on one of its pages' downloads: kept on the DownloadItem.
class ElectronDownloadMark final : public base::SupportsUserData::Data,
                                   public download::DownloadItem::Observer,
                                   public ElectronDownloadControl {
 public:
  ElectronDownloadMark(download::DownloadItem& item,
                       base::WeakPtr<ElectronSession> session,
                       std::string window)
      : item_(item), session_(std::move(session)), window_(std::move(window)) {
    observation_.Observe(&item);
  }

  ElectronDownloadMark(const ElectronDownloadMark&) = delete;
  ElectronDownloadMark& operator=(const ElectronDownloadMark&) = delete;
  ~ElectronDownloadMark() override = default;

  void Ask(const base::FilePath& suggested_path,
           base::OnceCallback<void(ElectronDownloadAnswer)> decided) {
    if (!session_) {
      LOG(WARNING) << "domicile: an Electron app's download asked where to go "
                      "after its app went; it is canceled.";
      std::move(decided).Run(ElectronDownloadAnswer{.cancel = true});
      return;
    }
    // A download asked again, as after a name conflict, is a new
    // will-download, as it would be in Electron.
    number_ =
        session_->AskDownload(window_, DetailsOf(*item_, suggested_path),
                              weak_factory_.GetWeakPtr(), std::move(decided));
  }

  // download::DownloadItem::Observer:
  void OnDownloadUpdated(download::DownloadItem* item) override {
    if (session_ && number_.has_value()) {
      session_->DownloadUpdated(*number_, ProgressOf(*item));
    }
  }
  void OnDownloadDestroyed(download::DownloadItem* item) override {
    observation_.Reset();
    weak_factory_.InvalidateWeakPtrs();
  }

  // ElectronDownloadControl:
  void Pause() override { item_->Pause(); }
  void Resume() override { item_->Resume(/*user_resume=*/true); }
  void Cancel() override { item_->Cancel(/*user_cancel=*/true); }

 private:
  const raw_ref<download::DownloadItem> item_;
  const base::WeakPtr<ElectronSession> session_;
  const std::string window_;
  // The number the app knows it by, once asked.
  std::optional<int> number_;
  base::ScopedObservation<download::DownloadItem,
                          download::DownloadItem::Observer>
      observation_{this};
  base::WeakPtrFactory<ElectronDownloadMark> weak_factory_{this};
};

}  // namespace

void MarkElectronDownload(download::DownloadItem& item,
                          base::WeakPtr<ElectronSession> session,
                          const std::string& window) {
  item.SetUserData(kMarkKey, std::make_unique<ElectronDownloadMark>(
                                 item, std::move(session), window));
}

bool IsElectronAppDownload(const download::DownloadItem& item) {
  return item.GetUserData(kMarkKey) != nullptr;
}

void AskElectronAppWhereDownloadGoes(
    download::DownloadItem& item,
    const base::FilePath& suggested_path,
    base::OnceCallback<void(ElectronDownloadAnswer)> decided) {
  auto* mark = static_cast<ElectronDownloadMark*>(item.GetUserData(kMarkKey));
  CHECK(mark) << "domicile: only an Electron app's download asks its app";
  mark->Ask(suggested_path, std::move(decided));
}

}  // namespace domicile
