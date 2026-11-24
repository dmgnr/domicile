// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef CHROME_BROWSER_DOMICILE_DOMICILE_PERMISSIONS_H_
#define CHROME_BROWSER_DOMICILE_DOMICILE_PERMISSIONS_H_

namespace content {
class WebContents;
}  // namespace content

namespace domicile {

// Permission prompts for <webview> guests, answered by the shell.
//
// Chrome draws a prompt as a bubble anchored to a browser window's location
// bar. A guest has no browser window, so a request went unanswered. This gives
// `guest` Chrome's PermissionRequestManager, with a prompt that asks the
// element through PermissionRequested (see
// components/domicile/mojom/web_view_guest.mojom). Chrome's settings, embargo
// and request grouping are unchanged.
//
// A request the shell has no kind for (components/domicile/browser/
// site_permissions.h) is ignored: no grant, nothing stored.
//
// An Electron app's page whose session has a permission request handler asks
// the app instead, for the kinds Electron names (ElectronPermissionFor in
// components/domicile/browser/electron_app.h).
//
// Called from AttachTabHelpers, before the guest's first navigation.
void AttachPermissionPrompts(content::WebContents& guest);

// Routes guests' camera and microphone requests through Chrome's
// MediaCaptureDevicesDispatcher, which asks through the prompt above. See
// MediaAccess in components/domicile/browser/web_view_guest.h.
//
// Called once from StartDesk, before any guest exists.
void UseChromeForGuestMedia();

}  // namespace domicile

#endif  // CHROME_BROWSER_DOMICILE_DOMICILE_PERMISSIONS_H_
