// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef CHROME_BROWSER_DOMICILE_DOMICILE_IDENTITY_DIALOG_H_
#define CHROME_BROWSER_DOMICILE_DOMICILE_IDENTITY_DIALOG_H_

#include <memory>

namespace content {
class IdentityRequestDialogController;
class WebContents;
}  // namespace content

namespace domicile {

// The "Sign in with" (FedCM) dialogs for a request from `web_contents`'s page,
// for ChromeContentBrowserClient::CreateIdentityRequestDialogController
// (patch 0210), in place of Chrome's.
//
// - A page in a <webview> asks its element through IdentityRequested (see
//   components/domicile/mojom/web_view_guest.mojom), and the provider's own
//   pages open as browser windows in the page's profile and partition. See
//   components/domicile/browser/identity_dialog.h.
// - A page outside any <webview> gets no dialog: every step is refused, and
//   the site's request fails as if dismissed.
std::unique_ptr<content::IdentityRequestDialogController> MakeIdentityDialog(
    content::WebContents* web_contents);

}  // namespace domicile

#endif  // CHROME_BROWSER_DOMICILE_DOMICILE_IDENTITY_DIALOG_H_
