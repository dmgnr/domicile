// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef CHROME_BROWSER_DOMICILE_DOMICILE_DESK_FUNCTIONS_H_
#define CHROME_BROWSER_DOMICILE_DOMICILE_DESK_FUNCTIONS_H_

namespace domicile {

// Registers the desk's chrome.tabs, chrome.windows, action.openPopup and
// sidePanel.open and close functions in place of Chrome's.
// ExtensionFunctionRegistry::Register replaces entries by name, so Chrome's
// code needs no patch.
//
// Each call acts where its target lives (docs/architecture/EXTENSIONS.md#tabs):
//
//   tabs.query                    every window's tabs, matched by
//                                 //components/domicile:desk_tabs
//   tabs.update {url, muted}      the guest's WebContents
//   tabs.update {active}          the shell, as `domicile-focus-request`
//   windows.update {focused}      the same, on that window's active tab
//   tabs.create {url}             opens a browser window. Answered with the
//                                 next tab the desk gains
//   windows.create {type: popup,  a popup window, made here with no tab, plus
//   url}                          a browser window as its tab. Answered once
//                                 the tab is attached
//   tabs.remove                   closes a browser window, or fires
//                                 `domicile-close` on a shell's own page.
//                                 Answered immediately
//   windows.remove                a popup window's tab, the same way. The
//                                 desk's own window is refused
//   tabs.setZoom, getZoom         the guest's zoom, as its element's setZoom
//                                 sets it: per site, through HostZoomMap, or
//                                 per tab in its zoom mode
//   tabs.getZoomSettings,         the guest's zoom mode, which Chrome's
//   setZoomSettings               ZoomController keeps, as for a Chrome tab
//   windows.get, getCurrent,      the desk's window and its popup windows.
//   getLastFocused, getAll        "Current" is the caller's tab's window, or
//                                 the desk's for a caller in no tab
//   action.openPopup              the shell's tray, as
//                                 `extensionpopuprequested`. Answered once the
//                                 shell is asked
//   sidePanel.open                a popup window showing the side panel, with
//                                 no size asked, so the shell tiles it, or
//                                 the one already showing it raised. No user
//                                 gesture asked
//   sidePanel.close               closes that window
//   RefusedOnDesk()               `not supported on a Domicile desk`
//
// Other functions (tabs.get, reload, sendMessage, executeScript, goBack) are
// Chrome's, which find desk tabs through the lookup hooks.
void RegisterDeskFunctions();

}  // namespace domicile

#endif  // CHROME_BROWSER_DOMICILE_DOMICILE_DESK_FUNCTIONS_H_
