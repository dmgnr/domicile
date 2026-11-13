# Engine: browser behavior

The engine's browser leaves keys, clicks and credentials to the shell. Every
`Browser` the engine opens is a shell window. Part of the
[engine fork](ENGINE-FORK.md).

## Keys, clicks and gestures

Patch `0047`:

- Every key reaches the page. An unhandled key stays unhandled: no reload,
  back, F11, zoom, close or quit.
- A right click is only the page's `contextmenu` event.
- Ctrl+wheel and edge swipes do nothing.

In a browser window (`WebViewGuest`):

- A right click the page leaves alone goes to the shell as
  `domicile-context-menu` (patch `0092`). The shell draws the menu and sends
  the chosen action back with `event.run()`.
- `inspect` opens DevTools in a browser window at DevTools' address.
  `chrome/browser/domicile/domicile_devtools.h` attaches it.
- DevTools draws its own context menus in HTML (its soft menu), since the
  engine has no native menus. The shell gets no `domicile-context-menu` from
  it. Copy actions write the frame's clipboard, as a page's copy does.
- A chord the page does not handle goes to the shell.
- Ctrl+wheel goes to the shell as a zoom request.

The shell binds browser keys itself.

## Passwords and passkeys

Patch `0048`:

- No password manager, autofill or translate.
- WebAuthn has no browser UI and reports no platform authenticator.

Passkeys belong to extensions ([EXTENSIONS.md](EXTENSIONS.md)):

- `PublicKeyCredential` stays, for a content script to wrap.
- An origin a `webAuthenticationProxy` extension has taken still gets a request
  delegate.
- `isConditionalMediationAvailable()` returns true for origins no extension
  proxies. Patch `0084` holds a conditional `get()` until the site aborts it, so a passkey
  extension's autofill can answer it.

## HTTP pages

- HTTPS-First Mode is off, in every profile and private window:
  `domicile::TurnOffBrowserOffers` sets its prefs on each start. Chrome warns
  before an http page with a dialog on the page's tab, and a `<webview>` guest
  has no tab, so the page stays blank.
- HTTPS Upgrades stay on. An http address tries https first and falls back to
  http when https fails. The shell's address bar marks the page not secure.

## Device choosers

Patch `0110`:

- WebHID, WebUSB and Web Serial ask the shell to pick a device. Chrome's
  chooser is a bubble on a browser window, which a `<webview>` guest has none
  of.
- `//chrome/browser/domicile/domicile_device_chooser.h` sets Chrome's override.
  Chrome's controllers still list the devices and grant the one picked.
- Web Bluetooth's chooser goes the same way. Its scanning prompt, which picks
  no device, is refused.
- A page outside any guest gets no device.

## New windows

- A page's `target="_blank"` or `window.open()` makes a real window: content
  keeps the opener, the name and a form's POST body.
- Content CHECKs that a guest's opener has a guest SiteInstance, which needs a
  partition of its own and would log the user out of every site. Patch `0115`
  relaxes it for guests without one.
- A `<webview partition>` and a window opened in a partition have a guest
  SiteInstance in a StoragePartition of their own (`ParamsFor` in
  `web_view_guest.cc`), so their new windows keep the partition.
- `WebViewGuest::CreateNewGuestWindow` makes the page as a browser window, and
  `AddNewContents` lists it once the page shows it.
- A middle click and an extension's window open at the address with no
  opener (`ReportNewWindow`).

## Navigations

- `WillNavigateThrottle` defers a page's own main-frame navigation and asks
  the element (`domicile-will-navigate`), as Electron's `will-navigate`.
  `preventDefault()` cancels it before any request. The shell's `src`,
  history steps and reloads do not ask (`AsksBeforeNavigating`).
- A closed element answers yes, so a navigation never hangs.

## What sites are told

- Sites are told the engine is Google Chrome: `navigator.userAgentData` and
  `Sec-CH-UA` carry the `Google Chrome` brand beside `Chromium` (patch 0157).
  A Chromium build sends no browser brand, and Akamai's bot check refuses
  that on some sign-ins, such as Citi's.

## Dialogs

- `alert()`, `confirm()` and `prompt()` ask the shell. A guest's
  `WebViewGuest` is its `JavaScriptDialogManager`; content dismisses every
  dialog without one.
- One at a time (`GuestDialogs`). A second one, from another frame's process,
  is dismissed at once.
- A navigation or close cancels the open dialog and withdraws it from the
  shell.
- A `beforeunload` that asks to stay asks the shell too, as a dialog of type
  `beforeunload` (`RunBeforeUnloadDialog`). Unanswered, it leaves, as with no
  manager, so a shell that draws no dialog never traps a page.
- A paused page does not slow the shell's animations. A `<webview>` rasters
  its whole page and embeds a new scale without waiting, so a window
  sliding or shrinking with a dialog open animates at full rate (patch 0155).
- The shell's `closeBrowserWindow` runs the page's `beforeunload`
  (`WebViewGuest::AskToClose`, `DispatchBeforeUnload`) and closes in
  `BeforeUnloadFired` if the page agrees. A page with no handler closes at
  once. `window.close()` and `chrome.tabs.remove` close without asking.
- Patch `0114` only lists the event's files for the build.

## Links for applications

- A link for an application (`zoommtg:`, `mailto:`) asks the shell
  (`domicile-external-app`), not Chrome's dialog. Chrome's dialog anchors to
  the outermost WebContents, which for a guest is the shell's own window.
- Patch `0176` adds `ExternalProtocolHandler::SetDialogOverride`;
  `chrome/browser/domicile/domicile_external_apps.h` sets it.
- Chrome still decides whether to ask: blocked schemes open nothing, a
  remembered site opens at once. "Always allow" is Chrome's, in the profile.
- A page outside any guest opens nothing.

## Sign-ins

- A site or proxy that asks for a user name and password (HTTP
  authentication) asks the shell (`domicile-sign-in`), not Chrome's dialog,
  which anchors to the shell's window the same way.
- Patch `0177` adds `LoginHandler::SetCreateOverride`;
  `chrome/browser/domicile/domicile_sign_in.h` sets it, so every
  `LoginHandler` asks the guest's element.
- Chrome still decides when to ask, and extensions may answer first. A
  sign-in answers other requests for the same realm; a cancel is that
  request's alone. A newer request replaces an older, unanswered one.
- Chrome's password manager does not fill or save these.
- A page outside any guest gets no sign-in.

## Other prompts

- File System Access (view or edit a file or folder, a folder of system
  files, a dangerous file), client certificates, Bluetooth pairing and
  extension install, permission and re-enable prompts ask the shell
  (`domicile-prompt`), not Chrome's dialogs, which anchor to the shell's
  window the same way.
- Patch `0179` adds the overrides; `chrome/browser/domicile/domicile_prompts.h`
  sets them. Client certificates use Chrome's existing selector hook.
- A guest has no File System Access prompt manager, so these were refused
  outright before; now the shell asks. Reading and editing are asked
  separately, as Chrome's request does.
- With no certificate installed, the page continues without one and nothing
  is asked, as in Chrome.
- A page outside any guest gets no.
- Reloading a page a form posted to asks the shell (`resend-form`). Content's
  default did nothing, so the reload never happened.
- A page that stops responding asks the shell (`unresponsive`): yes ends it,
  as Chrome's "Exit page" does, and it then shows as crashed; no waits, and
  it is asked again if it stays hung. Withdrawn when the page responds.

## Pickers

- A page's color, date and time pickers and a text input's `<datalist>` ask
  the shell (`domicile-picker`). Chrome drew the first as page popups of its
  own, and the `<datalist>` through autofill, which a guest has none of.
- Patch `0182` routes Blink's choosers to
  `third_party/blink/renderer/core/html/domicile/domicile_page_picker.h` in
  every document but the shell's own, which binds `PagePicker` to the frame's
  `WebViewGuest`. Closing the control withdraws it.
- A frame outside every guest has no shell to ask: its picker is dropped and
  the control keeps its value.

## Tooltips

- A page's tooltips (`title` and the like) are reported to the element
  (`tooltip`, `domicile-tooltip-change`), and the shell draws them. Chrome's
  are native windows drawn by the shell's view, outside any shell UI.
- Patch `0181` hands the tooltip to the WebContents' delegate first, and
  draws none when it takes it, naming the widget it came from. Cleared when
  the pointer leaves the page, or on a press, as Chrome's is.
- A new tooltip waits 500 ms, Chrome's delay; the renderer reports a title
  at once.
- A frame from another site (an extension's inline menu, a challenge frame)
  is its own widget, with its own coordinates. `WebViewGuest` maps the
  pointer from that widget into the page's.

## Error, warning and crashed pages

- A page that fails to load (a network error, an HTTP error with nothing to
  show, a certificate error, or a Safe Browsing, lookalike or HTTPS-First
  warning) is reported to the element (`pageFailure`,
  `domicile-page-failure-change`), and the shell draws the page.
- Patch `0180` leaves the page itself blank: Chrome's error page builder and
  every interstitial's HTML give an empty document, so no Chrome UI shows
  under the shell's.
- `proceedPastWarning()` passes a warning as Chrome's "Proceed anyway" does,
  and only where Chrome would (`pageFailureCanProceed`): a certificate error
  the user may override, or a warning.
- A crashed page was already reported (`renderProcessGone`); the shell now
  draws it too.

## "Sign in with" (FedCM)

- A site's "Sign in with" request (`navigator.credentials.get({identity})`)
  asks the element as `domicile-identity`, one step at a time: loading, the
  accounts, signed out of the provider, verifying, and an error. The shell
  draws each, and each replaces the last. Patch `0210` has
  `CreateIdentityRequestDialogController` make `IdentityDialog`
  (`components/domicile/browser/identity_dialog.h`) in place of Chrome's
  account chooser.
- The step open when the request ends (the page navigated, or the request
  was aborted) is withdrawn (`domicile-identity-withdrawn`).
- Only the shell's dismissal counts as the user's close, which embargoes the
  site's quiet requests as Chrome's close button does. A step the shell
  ignores is dismissed without the embargo.
- The provider's own pages (its sign-in page, a continuation, an error's
  details) open as browser windows in the page's profile. The provider closes
  one with `IdentityProvider.close()`.
- A page outside any `<webview>` has every step refused, as Chrome does with
  no dialog to show.

## Chrome's dialogs, sheets and floating windows

No Chrome dialog is drawn. Chrome draws a page's dialogs over the outermost
window, which for a `<webview>` is the shell's, so every one Domicile knows of
asks the shell instead (the sections above). `RefuseChromeDialogs`
(`domicile_chrome_dialogs.cc`, from `StartDesk`) covers the rest:

- Patch `0183`: any Chrome dialog left is closed as it is shown, as a cancel,
  and logged at ERROR (`domicile: refused a Chrome dialog for ...`). A gap
  fails closed and shows in the log.
- Payment Request is off (`payment_request_enabled` in patch `0183`'s
  `OverrideWebPreferences`), since it asks with a Chrome sheet. A site falls
  back to its own checkout form.
- Patch `0183`: picture-in-picture video is off
  (`picture_in_picture_enabled`), since Chrome floats it in a window of its
  own. A video has no picture-in-picture button and
  `requestPictureInPicture()` is refused. Document picture-in-picture stays:
  its window is the page's own, and a `<webview>` opens it as a shell window.

## Host shortcuts when nested

Under a host compositor, the engine inhibits the host's shortcuts so the shell
gets its Meta chords.

- Patch `0038` creates a `zwp_keyboard_shortcuts_inhibitor_v1` through
  `WaylandKeyboard::CreateShortcutsInhibitor`. Upstream calls it only for the
  Keyboard Lock API on a fullscreen window, and a nested desktop is not
  fullscreen.
- `--domicile-inhibit-host-shortcuts` turns it on. `domicile-launch` passes it
  on the Wayland platform only, so a guard running `--ozone-platform=wayland`
  does not swallow the session's keymap.

## Clients' shortcut inhibitors

Domicile's compositor serves `zwp_keyboard_shortcuts_inhibit_manager_v1` to
its own clients. A window holding an inhibitor gets the shell's grabbed chords
while it has the keyboard. See
[KEYBINDINGS.md](KEYBINDINGS.md#key-decisions). This is the other direction
from patch `0038`, which is the engine asking a host compositor.

## Chrome's own pages and strings

The engine leaves out Chrome's own UI, which the shell replaces.

- Patch `0146`: Settings, the New Tab page, the password manager, What's New
  and the WebUI gallery are not registered. Their paks, and those of tab
  search, the side panels and Customize Chrome, are not in `resources.pak`.
- Patch `0147`: every locale but en-US carries only the strings a desk can
  show. `src/components/domicile/locales/foreign_allowlist.py` lists what it
  drops. en-US keeps every string, and `ResourceBundle` reads it for a string
  a locale lacks.
  - A Chrome string the desk does show, dropped by mistake, appears in
    English. Take its source or prefix off the lists.
- `src/build/args/domicile_trim.gn`: no WebUI code caches.
- The field trial testing config stays on, without its
  `CompositedAnimationsForceMainFrames` study (patch 0196).

## Guards

- `guard-shell-shortcuts.sh`: keyboard.
- `guard-webview-passkey-extension.sh`: passkeys.
- `guard-shortcuts-inhibitor.sh` and `guard-shortcuts-inhibitor-chord.sh`: the
  engine sends the inhibit request, and sway honors it. See
  [ENGINE-FORK-MEASUREMENTS.md](ENGINE-FORK-MEASUREMENTS.md#host-shortcut-inhibitor).
- `guard-webview-context-menu.sh`: the context menu and DevTools.
- `guard-webview-permissions.sh`: permission requests and site settings.
- `guard-webview-device-request.sh`: device requests.
- `guard-webview-dialog.sh` and `guard-webview-beforeunload.sh`: dialogs.
- `guard-webview-partition.sh`: partitions.
- `guard-webview-will-navigate.sh`: will-navigate.
- `guard-webview-external-app.sh`: links for applications.
- `guard-webview-sign-in.sh`: sign-ins.
- `guard-webview-file-access.sh`: file access prompts.
- `guard-webview-page-failure.sh`: error pages.
- `guard-webview-resend-form.sh`: sending a form again.
- `guard-webview-page-picker.sh`: pickers.
- `guard-webview-sign-in-with.sh`: "Sign in with" asks the shell.
- `guard-webview-chrome-sheets.sh`: Payment Request and picture-in-picture
  are off.
- `guard-browser-brand.sh`: the Google Chrome brand.
- No guard reads the browser's offers.
