// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef CHROME_BROWSER_DOMICILE_DOMICILE_ELECTRON_SOCKET_H_
#define CHROME_BROWSER_DOMICILE_DOMICILE_ELECTRON_SOCKET_H_

namespace domicile {

// Starts taking Electron apps on --domicile-electron-socket: each connection
// is one app's `electron-host`, and its windows are app windows on the desk.
// Does nothing without that switch. See docs/architecture/ELECTRON-APPS.md.
//
// Lives in //chrome because the windows are DeskWindows'. Called once, on the
// UI thread, from StartDesk.
void StartElectronSocket();

}  // namespace domicile

#endif  // CHROME_BROWSER_DOMICILE_DOMICILE_ELECTRON_SOCKET_H_
