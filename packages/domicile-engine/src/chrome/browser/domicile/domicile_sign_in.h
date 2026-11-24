// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef CHROME_BROWSER_DOMICILE_DOMICILE_SIGN_IN_H_
#define CHROME_BROWSER_DOMICILE_DOMICILE_SIGN_IN_H_

namespace domicile {

// Sign-ins a site or a proxy asks for (HTTP authentication), asked by the
// shell.
//
// Chrome asks with a dialog anchored to the outermost WebContents' window,
// which for a <webview> guest is the shell's own, so Chrome's unstyled
// "Sign in" box was drawn over the desktop. This sets Chrome's override
// (patch 0177) so every LoginHandler asks the guest's element through
// SignInRequested (see components/domicile/mojom/web_view_guest.mojom).
//
// - Chrome still decides when to ask: a page's own request, a navigation and
//   a proxy all come here, and extensions may answer first.
// - The answer goes to Chrome's LoginHandler, so another request for the
//   same realm is answered with it, as in Chrome.
// - Chrome's password manager does not fill or save these.
// - A page outside any guest gets no sign-in: its request is canceled.
// - An Electron app's page asks its app first, as `login`: the app signs in
//   or cancels, and when no listener takes it the shell asks, where
//   Electron would cancel. See electron_sign_ins.h.
//
// Called once from StartDesk, before any guest exists.
void UseTheShellForSignIns();

}  // namespace domicile

#endif  // CHROME_BROWSER_DOMICILE_DOMICILE_SIGN_IN_H_
