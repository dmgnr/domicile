// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef CHROME_BROWSER_DOMICILE_DOMICILE_ELECTRON_PRECONNECT_H_
#define CHROME_BROWSER_DOMICILE_DOMICILE_ELECTRON_PRECONNECT_H_

#include "content/public/browser/global_routing_id.h"

class GURL;

namespace domicile {

// A page's resource hint (`<link rel=preconnect>`) asked for a connection to
// `url`. When `frame` is an Electron app's page, its session's `preconnect`
// listeners hear of it, as in Electron; Chrome preconnects as for any page.
// Patch 0271 calls it from NetworkHintsHandlerImpl::Preconnect.
void TellElectronAppOfPreconnect(content::GlobalRenderFrameHostId frame,
                                 const GURL& url,
                                 bool allow_credentials);

}  // namespace domicile

#endif  // CHROME_BROWSER_DOMICILE_DOMICILE_ELECTRON_PRECONNECT_H_
