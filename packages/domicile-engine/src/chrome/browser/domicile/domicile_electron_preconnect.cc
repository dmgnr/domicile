// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "chrome/browser/domicile/domicile_electron_preconnect.h"

#include "base/memory/weak_ptr.h"
#include "chrome/browser/domicile/domicile_electron_page.h"
#include "components/domicile/browser/electron_app.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
#include "url/gurl.h"

namespace domicile {

void TellElectronAppOfPreconnect(content::GlobalRenderFrameHostId frame,
                                 const GURL& url,
                                 bool allow_credentials) {
  // A frame can go before its hint arrives, as Chrome's own handler allows.
  content::RenderFrameHost* host = content::RenderFrameHost::FromID(frame);
  if (host == nullptr) {
    return;
  }
  base::WeakPtr<ElectronSession> session = ElectronPage::SessionOf(
      *content::WebContents::FromRenderFrameHost(host));
  if (session) {
    session->TellPreconnect(url, allow_credentials);
  }
}

}  // namespace domicile
