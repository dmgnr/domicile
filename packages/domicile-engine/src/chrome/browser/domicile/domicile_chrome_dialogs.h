// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef CHROME_BROWSER_DOMICILE_DOMICILE_CHROME_DIALOGS_H_
#define CHROME_BROWSER_DOMICILE_DOMICILE_CHROME_DIALOGS_H_

namespace domicile {

// No Chrome dialog, sheet or floating window is drawn.
//
// Every question a page asks that Domicile knows of is answered by the shell.
// This covers the rest:
//
// - Any Chrome dialog left is refused (patch 0183's RefuseEveryDialog): closed
//   as it is shown, as a cancel, and logged at ERROR, so a gap fails closed and
//   shows in the log rather than drawing a Chrome box over the desktop.
// - Payment Request and FedCM ("Sign in with Google"'s account chooser) are
//   off, as passwords and passkeys are (patch 0048): each is a Chrome sheet,
//   and sites without them fall back to their own forms and sign-in pages.
//
// Called once from StartDesk, before any page's process is started, since the
// APIs are turned off on the command line each renderer is given.
void RefuseChromeDialogs();

}  // namespace domicile

#endif  // CHROME_BROWSER_DOMICILE_DOMICILE_CHROME_DIALOGS_H_
