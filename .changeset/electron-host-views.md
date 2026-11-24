---
"@domicile-desktop/electron-host": minor
---

Electron apps can use views. `WebContentsView` and `BrowserView` open as views, and a window's `contentView.addChildView`, `removeChildView` and each view's `setBounds` and `setVisible` place them in the window for the shell to draw. `BrowserView`'s `setBrowserView`, `addBrowserView`, `setTopBrowserView` and `setAutoResize` work as in Electron. A window's `getContentBounds`, `getBounds` and `getSize` read the size the shell gave it, `resize` fires as it changes, and `BrowserWindow.fromWebContents` finds the window holding a view's page.
