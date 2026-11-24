# `<app>` and `<webview>`

How the engine's two embedding elements route input and focus.
Event names and full types are in `src/app-element.ts` and
`src/webview-element.ts`.

## `<app>`

`<app app-id="…">` embeds a Wayland client. The engine provides the element.

- **Shell only:** `<app>` and `<webview>` exist only in the shell's document.
  In any other page, such as a site in a `<webview>` or an `<iframe>`, they are
  unknown elements.

- **Size:** the element's layout box is the client's size. The engine sends it
  as the `xdg_toplevel.configure`. There is nothing to call.
- **Resize sync:** a new box holds the page's frame until the client draws at
  it, up to viz's default deadline. Set the `resizing` attribute (or
  `element.resizing = true`) while the user drags an edge: each box then shows
  at once, without waiting, with the client's latest frame at its own size in
  the top left corner until the client draws at the new box. Removing it waits once for the final size.
- **Synced frames:** the `frame` attribute (or `element.frame`) names the
  synced frame of the window to show. Setting it holds the page's frame until
  the window has that frame, up to viz's default deadline. Unset, the
  element shows the newest frame the control channel named for the window, so
  a page that ignores frames never shows a stale one.
  Set it from `DomicileWindow.frame`, in the same render as a popup's move.
  The compositor syncs frames only for a page that called `windows.syncFrames()`; see
  [Synced frames](/docs/architecture/WINDOW-COMPOSITING.md#synced-frames).
- **Scale:** call `domicile.windows.setBounds(appId, { x, y, width, height })` with
  the element's box in page pixels whenever it moves or resizes. The client
  draws at the scale of the monitor holding most of the box. An unreported
  window draws for the densest monitor.
- **Zoom:** CSS `zoom` on an `<app>` (or an ancestor) zooms the window's
  content and keeps it sharp. The client is configured `zoom` times smaller
  than the box and draws `zoom` times denser, so its buffer still fills the box.
  The box itself is laid out as usual: `width: 100%` keeps the tile's size.
  A client without `wp_fractional_scale_v1` draws at its display's
  whole-number scale and is resampled, so a small zoom costs it a large
  buffer. A `transform: scale()` is not zoom: it resamples the window.
- **Hidden:** call `domicile.windows.setBounds(appId, { x: 0, y: 0, width: 0, height: 0 })`
  for an `<app>`
  the page does not draw. The client gets a frame callback once a second and
  is `suspended` until the next box with an area, unless a cast shows it. It
  keeps its monitor and scale.
- **Window events** (bubbling `CustomEvent`s, not cancelable, with
  `detail.appId`; the compositor sends them):
  - `domicile-presented`: the window reached the screen. Fired once for its
    first frame, and once for the first frame its client draws after its box
    changes size. A move, a box at the same size and a hidden window shown
    again fire nothing.
  - `domicile-suspended`: the compositor marked the window `suspended`.
  - `domicile-resumed`: the compositor cleared `suspended`. A new page's
    `hello` clears it on every window.
  - An `<app>` not in the page when one is sent misses it.
- **Pointer:** the element sends pointer and wheel events over it to the
  client, in the client's surface coordinates, through its layout box and
  every transform above it (`zoom` and perspective included). A
  `preventDefault()` on the event takes it from the client.
- **Press capture:** a press the client gets captures the pointer for the
  element until the button is up, so the client gets the drag and the release
  wherever the pointer goes. A page that captures the pointer itself in its
  `pointerdown` listener loses that capture to the element; call
  `preventDefault()` to keep the press.
- **Keyboard:** the engine sends the keystrokes `document` hears to the window
  that has the keyboard. `domicile.windows.focus(appId)` and `domicile.windows.focusShell()`
  move it in code, both in the compositor's seat and for the page's keys.
  Each press sent (not a modifier, a repeat or a grabbed chord) fires
  `domicile-key-delivered` on the `<app>`: a plain `Event` that names no key.
  While the desk is locked, the page keeps every key, so the lock screen
  gets the passphrase.
- **Focus events** (both cancelable; call `preventDefault()` to decide focus
  yourself):
  - `domicile-focus-requested`: a click on a window, before it is focused. A
    popup's click asks for its window.
  - `domicile-focus-release-requested`: a press off every window, fired on the
    window that has the keyboard, before focus returns to the page.
- **Context menu:** a right-click over an `<app>` suppresses the browser's
  menu. The press goes to the client, which draws its own. Elsewhere the
  browser menu is left alone.
- No setup. Routing covers every `<app>` on the page, including ones added
  later.

## `<webview>`

`<webview src="…">` embeds a web page. `<webview window="id">` shows one of
the desk's browser windows, which the engine owns; the engine reads `window`
once, when the view connects. The SDK provides types only.

- **Moving:** a view moved in the document, as React's `insertBefore` does,
  connects again where it lands. A browser window shows there; a `src` view
  loads `src` again, as an `<iframe>` does.

- **Resize sync:** as an `<app>`'s, a new box holds the page's frame until
  the page draws at it. Set the `resizing` attribute while the user drags an
  edge: each box then shows at once, with the page's latest frame at its own
  size in the top left corner until the page draws at the new box.
- **Properties:** `src`, `goBack()`, `goForward()`, `goBackInNewWindow()`,
  `goForwardInNewWindow()`, `history()`, `goToHistoryEntry()`,
  `goToHistoryEntryInNewWindow()`, `stop()`, `reload()`,
  `canGoBack`, `canGoForward`, `loading`, `focus()`, `inspect()` (opens
  DevTools as a new window), `print()` (the desktop's print dialog).
- **Events** (selected; see `src/webview-element.ts` for all):
  - `domicile-close`: the page in a shell's own view (no `window`) called
    `window.close()`. The shell removes the view. A browser window closes in
    the browser.
  - `domicile-focus-request`: the page called `window.focus()` or
    `client.focus()` (how a site answers a click on its notification), or an
    extension asked for the tab. The shell raises the view.
  - `domicile-context-menu`: a right click the page left alone, with what was
    under it. The shell draws the menu; `event.run(action)` does the browser's
    part of an item.
  - `domicile-content-size-change`: `contentWidth` / `contentHeight` changed.
    Use it to size an `extensionpopup` view.
  - `domicile-render-process-change`: the page's renderer died or came back.
    `renderProcessGone` says why, or is `""`; `reload()` recovers it. See
    [Crashed pages](/docs/SHELL-BROWSER-WINDOWS.md#crashed-pages).
- **Browser windows:** `domicile.browser.windows` is the desk's whole list;
  `browser.on("change")` reports changes. `browser.open(url)` and `browser.close(id)` are
  for the shell's own UI. A link with `target="_blank"`, `domicile open`
  and an extension's `tabs.create` or `windows.create` open windows without
  the shell. See
  [SHELL-BROWSER-WINDOWS.md](/docs/SHELL-BROWSER-WINDOWS.md).
- **Extension popups:** for a tray row with a `popup`, call
  `extensions.activate(id)` (which grants `activeTab`), then open a
  `<webview extensionpopup>` at the popup address. Set `extensionpopup` on
  first render.
- **Private pages:** `<webview private>` puts a shell's own page in the
  off-the-record profile, and `browser.openPrivate(url)` opens a private
  window. Set `private` on first render. See
  [SHELL-BROWSER-WINDOWS.md](/docs/SHELL-BROWSER-WINDOWS.md#private-browsing).
- **Partitions:** `<webview partition="persist:work">` gives a page storage of
  its own, kept on disk; any other name keeps it in memory.
  `browser.open(url, { partition })` opens a window in one. Set `partition`
  on first render. See
  [SHELL-BROWSER-WINDOWS.md](/docs/SHELL-BROWSER-WINDOWS.md#partitions).
- **Navigations:** `domicile-will-navigate` fires before the page navigates
  itself; `preventDefault()` cancels it. See
  [SHELL-BROWSER-WINDOWS.md](/docs/SHELL-BROWSER-WINDOWS.md#navigations).

## Reading held modifiers

Read modifiers from your own `KeyboardEvent`s. The page sees every key press,
whichever window has focus:

<!-- tab: React -->

```tsx
const [altHeld, setAltHeld] = useState(false);
useEffect(() => {
  const follow = (event: KeyboardEvent) => setAltHeld(event.altKey);
  document.addEventListener("keydown", follow);
  document.addEventListener("keyup", follow);
  return () => {
    document.removeEventListener("keydown", follow);
    document.removeEventListener("keyup", follow);
  };
}, []);
// Let clicks reach the page while Alt is held.
// <app style={{ pointerEvents: altHeld ? "none" : undefined }} … />
```

<!-- tab: JavaScript -->

```js
const follow = (event) => {
  // Let clicks reach the page while Alt is held.
  portal.style.pointerEvents = event.altKey ? "none" : "";
};
document.addEventListener("keydown", follow);
document.addEventListener("keyup", follow);
```

<!-- /tabs -->

Do not use the host's `altKey`, `ctrlKey`, `shiftKey` and `metaKey` for this.
They report the compositor's seat, which only sees keys forwarded while a
client had focus. A modifier pressed while the page had focus is missing from
them.
