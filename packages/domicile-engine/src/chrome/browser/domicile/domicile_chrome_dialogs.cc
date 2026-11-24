// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "chrome/browser/domicile/domicile_chrome_dialogs.h"

#include "components/web_modal/web_contents_modal_dialog_manager.h"

namespace domicile {

void RefuseChromeDialogs() {
  web_modal::WebContentsModalDialogManager::RefuseEveryDialog();
}

}  // namespace domicile
