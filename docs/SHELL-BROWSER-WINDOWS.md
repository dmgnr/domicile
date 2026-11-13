# Browser windows in a shell

`<webview>` is a tag built into the engine. It shows a web page in its own
browsing context. A browser window in a shell is an address bar you draw over a
`<webview>`. Manganese's is
[`BrowserWindow.tsx`](/packages/manganese-window-management/src/BrowserWindow.tsx).

Part of [WRITING-A-SHELL.md](WRITING-A-SHELL.md). Extensions are in
[SHELL-EXTENSIONS.md](SHELL-EXTENSIONS.md).

Each example is in React and in plain JavaScript. React ignores `on…` props on
`<webview>`, as on `<app>`, so the React examples listen in an effect, on a
ref to the element.

## The engine owns browser windows

The browser holds each browser window's page, so it outlives your document.
After `domicile load-shell`, the new shell gets every window with its scroll,
form input, history and playing media intact.

<!-- tab: React -->

```tsx
import { useDomicile } from "@domicile-desktop/react/domicile-provider";
import { useWatch } from "@domicile-desktop/react/use-watch";

const BrowserWindows = () => {
  const { browser } = useDomicile();
  const windows = useWatch(browser, "change", () => browser.windows) ?? [];
  return (
    <>
      {windows.map(({ id }) => (
        // React sets `window` before the view enters the document.
        <webview key={id} window={id} />
      ))}
      <button onClick={() => browser.open("https://example.com")}>+</button>
    </>
  );
};
```

<!-- tab: JavaScript -->

```js
const drawn = new Map();

const show = () => {
  for (const { id } of domicile.browser.windows ?? []) {
    if (!drawn.has(id)) {
      const view = document.createElement("webview");
      view.setAttribute("window", id); // before append
      document.body.append(view);
      drawn.set(id, view);
    }
  }
};
show();
domicile.browser.on("change", show);

plus.addEventListener("click", () => {
  domicile.browser.open("https://example.com");
});
```

<!-- /tabs -->

- **`browser.windows`** is the whole list, oldest first, `undefined` until
  the engine lists it. `browser.on("change")` fires when a window opens, closes,
  navigates or changes title. A window you have not drawn is new; a missing
  one was closed. Each has `id`, `url` and `title`. An extension's popup
  window also has `popupWindow` ([SHELL-EXTENSIONS.md](SHELL-EXTENSIONS.md)).
  `width` and `height` are the size an extension's popup window or a page's
  `window.open()` asked for, such as a call's small window; 0 on an axis it
  left unset. Manganese floats a window with either at that size.
- **`browser.open(url)` and `browser.close(id)`** are for your own
  UI. The result arrives in the next list. Other windows open without you
  ([New windows](#new-windows)). A page may ask to stay before it closes
  ([Close requests](#close-requests)).
- **`browser.openApp(url, { id, reuse })`** opens an app window, as `domicile
  open --app` does, for your own launcher. It is listed with `isApp: true` and
  `appId: id` ([New windows](#new-windows)). With an `id`, `AppReuse.Focus`
  brings that app's open window to the front instead (its `<webview>` fires
  `domicile-focus-request`), and `AppReuse.Navigate` also loads `url` in it.
  The engine matches the window, so two quick calls never open two.
- **`browser.countMatches(id, selector)`** counts the elements matching a CSS
  selector in window `id`'s page, as a `<webview>`'s `countMatches` does. A
  hidden window answers.
- **Set `window` before the view enters the document.** The engine reads it
  once, when the view connects. A window shows in one view at a time: a second
  view naming it stays empty, so never remount the view drawing it.
- **A `<webview src="…">` with no `window`** is your own page, such as an
  extension's popup or a preview. It closes with your document.

## Navigations

A page's own navigation (a link, `location`, a form) fires
`domicile-will-navigate` (`WEBVIEW_WILL_NAVIGATE_EVENT`) first, as Electron's
`will-navigate`:

<!-- tab: React -->

```tsx
import { WEBVIEW_WILL_NAVIGATE_EVENT } from "@domicile-desktop/sdk/webview-element";

useEffect(() => {
  const view = viewRef.current; // the <webview>
  const navigating = (event) => {
    if (!allowed(event.url)) {
      event.preventDefault(); // stays on the page; nothing is requested
    }
  };
  view?.addEventListener(WEBVIEW_WILL_NAVIGATE_EVENT, navigating);
  return () => view?.removeEventListener(WEBVIEW_WILL_NAVIGATE_EVENT, navigating);
}, []);
```

<!-- tab: JavaScript -->

```js
import { WEBVIEW_WILL_NAVIGATE_EVENT } from "@domicile-desktop/sdk/webview-element";

view.addEventListener(WEBVIEW_WILL_NAVIGATE_EVENT, (event) => {
  if (!allowed(event.url)) {
    event.preventDefault(); // stays on the page; nothing is requested
  }
});
```

<!-- /tabs -->

- Answer synchronously: the navigation waits for dispatch to return.
- Only the main frame asks. `src`, `goBack`, `goForward`, `reload` and the
  page's own history steps and reloads do not.

## Private browsing

- **`browser.openPrivate(url)`** opens a private window. It is listed with
  `isPrivate: true`. Draw it so the user can tell.
- **`<webview private>`** makes your own page private, such as a preview. Set
  `private` before the view enters the document.
- A private page is in Chrome's off-the-record profile: its cookies, cache and
  storage stay in memory, shared by every private page and none of the user's.
- Private data ends when the last private page closes, whether a private
  window or a `<webview private>`. The next private page starts empty.
- A private window's new windows are private too.
- Extensions see no private page.

## Partitions

A partition is storage of its own (cookies, cache, IndexedDB), apart from the
user's and every other partition, like a separate browser profile:

- **`<webview partition="persist:work">`** keeps it on disk across restarts.
  **Any other name** keeps it in memory until the engine exits. No
  `partition` is the user's own storage. Set it before the view enters the
  document.
- **`browser.open(url, { partition })`** opens a window in one. It is listed
  with its `partition` (`""` for none).
- Pages and windows with the same name share it. Their new windows keep it.
- `private` with a partition is in memory, apart from other private pages.
- A page in a partition cannot show notifications. Chromium denies them
  outside a site's own storage.
- `persist:` with no name is refused: the view stays empty, and
  `browser.open` throws a `TypeError`.

## Basics

- `goBack`, `goForward`, `stop` and `reload` are element methods.
- `goBackInNewWindow` and `goForwardInNewWindow` open a new browser window
  with a copy of the view's history and take the step there, as a middle
  click on Chrome's back button does. The view stays on its page. A private
  view's window is private.
- `src` is reflected: setting the property or the attribute navigates. A view
  drawing a browser window does not send `src` on connect, since the page is
  already loaded.
- Give it a size. Its intrinsic size is 300×150.
- **Hide a window with `display: none`** on the view or an ancestor, and keep
  it mounted. Its page is then hidden like a background tab:
  `document.visibilityState` is `hidden`, timers slow and nothing paints.
  Showing the view shows the page. The page hears a hide 100ms late, so a
  view that is shown again within that time never reads `hidden`.
- **Lay out a hidden window while it `isCaptured`.** A screenshot, a picker's
  preview or a screen cast of the page alone sets it, and `browser.on("change")`
  fires. A page with no layout box draws nothing, so the capture would get no
  frame. Manganese draws a hidden tab under the shown one meanwhile.
- `domicile://` addresses, and `blob:` URLs the shell created, show
  `about:blank#blocked`. A guest on the shell's origin could control the
  compositor.
- The page is a guest with no parent frame, so sites that send
  `X-Frame-Options: DENY` or `frame-ancestors 'none'` still load.
- Pointer events, focus and keys inside the guest do not reach your page. The
  element reports what you need through properties and events.
- All `<webview>` events bubble, so one listener on your window frame covers
  them. In JSX, bind them with `addEventListener` on a ref.
- **`view.countMatches(selector)`** resolves with how many elements in the
  page's main document match a CSS selector, read where the page's script
  cannot change the answer. A hidden page answers. It throws `SyntaxError` for
  a bad selector, and rejects with `InvalidStateError` before the view has a
  page or when the page gave no number, as when it navigated first.

## State: history, loading, address

Each piece of state is a property on the element. Its event carries no data
and only says to reread. Read once on mount too: a shell that mounts mid-load,
or a React shell whose listeners attach after the first commit, otherwise shows
stale state.

| Property | Event | Meaning |
|---|---|---|
| `canGoBack`, `canGoForward` | `domicile-history-change` | Whether back and forward would move |
| `loading` | `domicile-loading-change` | Whether the page is loading, as a browser's spinner shows. Same-document navigations (fragment, `pushState`) do not count |
| `loadProgress` | `domicile-load-progress-change` | How far the page has loaded, from 0.1 to 1. Read it only while `loading` |
| `url`, `security` | `domicile-page-change` | The address the page is at, and its connection security |
| `zoom` | `domicile-zoom-change` | Zoom factor; 1 is 100% |
| `favicon` | `domicile-favicon-change` | Icon URL, or `""` |
| `description` | `domicile-description-change` | The page's `<meta name="description">`, trimmed, or `""` |
| `targetUrl` | `domicile-target-url-change` | The link under the pointer, or `""`. The engine draws no status bubble; manganese's is `browser/LinkTarget.tsx` |
| `tooltip`, `tooltipX`, `tooltipY` | `domicile-tooltip-change` | The tooltip under the pointer, such as a `title`, or `""`, and where the pointer was when it appeared, in the element's CSS pixels. A new one appears after Chrome's 500 ms delay. The engine draws no tooltip; manganese's is `browser/PageTooltip.tsx` |
| `findMatches`, `findActiveMatch` | `domicile-find-change` | Find-in-page results |
| `contentWidth`, `contentHeight` | `domicile-content-size-change` | The size an `extensionpopup` view's page sized itself to |
| `pageFullscreen` | `domicile-page-fullscreen-change` | Whether the page is fullscreen; see [Fullscreen](#fullscreen) |
| `wakeLock` | `domicile-wake-lock-change` | Whether the page keeps the screens on: its own `navigator.wakeLock`, or a video playing. Manganese's keep awake eye names the site |
| `renderProcessGone`, `renderProcessExitCode` | `domicile-render-process-change` | Why the page's renderer went away, or `""`; see [Crashed pages](#crashed-pages) |

<!-- tab: React -->

```tsx
import { WEBVIEW_HISTORY_CHANGE_EVENT } from "@domicile-desktop/sdk/webview-element";

const [history, setHistory] = useState({ back: false, forward: false });

useEffect(() => {
  const view = viewRef.current; // the <webview>
  const readHistory = () =>
    setHistory({ back: view.canGoBack, forward: view.canGoForward });
  readHistory();
  view.addEventListener(WEBVIEW_HISTORY_CHANGE_EVENT, readHistory);
  return () => view.removeEventListener(WEBVIEW_HISTORY_CHANGE_EVENT, readHistory);
}, []);

// <button disabled={!history.back}>…
```

<!-- tab: JavaScript -->

```js
import { WEBVIEW_HISTORY_CHANGE_EVENT } from "@domicile-desktop/sdk/webview-element";

const readHistory = () => {
  back.disabled = !view.canGoBack;
  forward.disabled = !view.canGoForward;
};

readHistory();
view.addEventListener(WEBVIEW_HISTORY_CHANGE_EVENT, readHistory);
```

<!-- /tabs -->

- **`url` vs `src`:** `src` is where you last sent the view. `url` is where
  the page is now, after links and redirects. Show `url` in the address bar.
- **`security`** is `neutral`, `secure`, `warning` or `dangerous`
  (`WEBVIEW_SECURITY_LEVELS`), from the same check as Chrome's padlock. `""`
  means unknown, not neutral. Always pair `security` with `url`, never with
  `src`, or the padlock can describe a different page.
- **`favicon`** is the best icon the page links (SVG first, then largest), as
  an absolute URL.

## Focus

A click inside the guest is invisible to your page, but its focus is not:

- The `<webview>` becomes `document.activeElement` and fires `focus` and
  `focusin`. Popover dismissal, focus traps and React `onFocus` work.
- `domicile-guest-focus` (`WEBVIEW_GUEST_FOCUS_EVENT`) also fires when the
  guest regains focus with your document. Use it to raise the window:

<!-- tab: React -->

```tsx
import { WEBVIEW_GUEST_FOCUS_EVENT } from "@domicile-desktop/sdk/webview-element";

useEffect(() => {
  const frame = frameRef.current; // the browser window's element
  const focused = () => {
    raise(frame);
  };
  frame?.addEventListener(WEBVIEW_GUEST_FOCUS_EVENT, focused);
  return () => frame?.removeEventListener(WEBVIEW_GUEST_FOCUS_EVENT, focused);
}, []);
```

<!-- tab: JavaScript -->

```js
import { WEBVIEW_GUEST_FOCUS_EVENT } from "@domicile-desktop/sdk/webview-element";

frame.addEventListener(WEBVIEW_GUEST_FOCUS_EVENT, () => {
  raise(frame);
});
```

<!-- /tabs -->

`frame.contains(document.activeElement)` tells you whether a browser window
(page or address bar) has focus.

## The keyboard

The compositor does not know about browser windows, so the shell moves
keyboard focus to and from them:

- **Take it:** call `domicile.windows.focusShell()` when a browser window becomes
  active.
  Otherwise the last focused client keeps receiving keys. See
  [Taking the keyboard](WRITING-A-SHELL.md#taking-the-keyboard-for-your-own-ui).
- **Give it back:** blur the focused element in the browser window when the
  user switches away. While a guest page has focus, keys never reach your
  document, so `windows.focus` cannot forward them and other windows get no keys.
- **Keep the caret:** do not focus the page if the window already has focus.
  The click that activated the window may have been in the address bar.

The guest has no built-in browser behavior:

- No Chrome shortcuts (Ctrl+R, Alt+Left, F11, Ctrl+W, …), no browser-drawn
  context menu, no swipe navigation.
- No password saving, autofill, translation or built-in passkeys. Passkeys
  come from a password manager extension.

Bind browser keys yourself:

- `domicile-guest-keydown`: a `KeyboardEvent` for each chord (Ctrl, Alt or
  Meta held) the page did not `preventDefault`. Plain keys never arrive.
- `domicile-zoom-in-request` / `domicile-zoom-out-request`: Ctrl+wheel. They
  zoom nothing. Call `view.setZoom(factor)` (0.25 to 5). Zoom is per host, as
  in Chrome.
- `view.find(text, backward)` searches; the same text again goes to the next
  match. `view.stopFinding()` ends it. A navigation ends it too. Matches are
  counted across all frames.
- `view.print()` prints the page through the desktop's print dialog, as
  Chrome's Ctrl+Shift+P does. A page's `window.print()` uses the same dialog.
  There is no Print Preview.
- Manganese's `BrowserWindow.tsx` binds Chrome's default keys, including
  Ctrl+F, Ctrl+Shift+I and Ctrl+Shift+P.

Draw the context menu yourself:

- `domicile-context-menu`: a right click the page did not `preventDefault`.
  The event carries what was under the click: `linkUrl`, `srcUrl`,
  `mediaType`, `selectionText`, `isEditable`, the `can*` edit flags, and `x` /
  `y` relative to the view.
- `event.run(action)` does what only the browser can: `copy-link-address`,
  `save-link-as`, `copy-image`, `copy-media-address`, `save-media-as`, the
  edit commands (`cut`, `paste`, …) and `inspect`. A save asks
  `domicile-file-chooser` where. See `WEBVIEW_CONTEXT_MENU_ACTIONS`.
- Back, reload and "open in new window" (`browser.open`) need no menu
  action.
- `view.inspect()` opens DevTools for the page in a new browser window. It
  arrives in the next `browser_windows`, like any other window. DevTools draws
  its own context menus, so its window fires no `domicile-context-menu`.
- Manganese's `browser/page-menu.ts` builds Chrome's menu from the event.

Desktop chords from `bindKeys` still work while a guest has focus. They arrive
as a `keyboard.on("shortcut")` event. `domicile.keyboard.grab` grabs a chord by name without
`bindKeys` ([Keybindings](WRITING-A-SHELL.md#keybindings)).

## New windows

The browser opens a window without you for:

- a `target="_blank"` link, `window.open` or a middle click
- `domicile open <url>`, which `BROWSER` (`domicile-open-url`) and
  `xdg-open` run inside a desktop
- `domicile open --app <url>`, which lists the window with `isApp`, and
  `appId` from `--id`. Draw it
  without an address bar, and with a read-only one while its page is off the
  origin it opened at ([WEB-APPS.md](architecture/WEB-APPS.md)).
- an extension's `tabs.create` or `windows.create`
- DevTools, from `view.inspect()` or a context menu's `inspect`

The window arrives in the next `browser.on("change")`. You decide where it goes.

A page's new window is the window it asked for: `window.open` returns it, and
the opener, the window name and a form's POST body are kept. It is listed once
the page shows it, at the address it opens. A middle click opens the link with
no opener, as in Chrome.

## Fullscreen

A page's `requestFullscreen()`, such as a video's fullscreen button, makes it
fullscreen at once:

- The page fills the `<webview>`'s box. Grow the view to fill the screen.
- `pageFullscreen` turns true and `domicile-page-fullscreen-change` fires.
- Escape in the page ends it, before the page sees the key.
- `view.exitPageFullscreen()` ends it, such as when the user takes the window
  out of fullscreen.

Manganese fills the screen with the window while its page is fullscreen
(`usePageFullscreen`).

## Crashed pages

A page whose renderer dies (a crash, a kill, out of memory) stays in its view
until you reload it:

<!-- tab: React -->

```tsx
import { WEBVIEW_RENDER_PROCESS_CHANGE_EVENT } from "@domicile-desktop/sdk/webview-element";

const [gone, setGone] = useState("");

useEffect(() => {
  const view = viewRef.current; // the <webview>
  const readGone = () => setGone(view.renderProcessGone);
  readGone();
  view.addEventListener(WEBVIEW_RENDER_PROCESS_CHANGE_EVENT, readGone);
  return () =>
    view.removeEventListener(WEBVIEW_RENDER_PROCESS_CHANGE_EVENT, readGone);
}, []);

// gone === "" ? null : (
//   <Card reason={gone} onRetry={() => viewRef.current?.reload()} />
// )
```

<!-- tab: JavaScript -->

```js
import { WEBVIEW_RENDER_PROCESS_CHANGE_EVENT } from "@domicile-desktop/sdk/webview-element";

const showCard = () => {
  card.hidden = view.renderProcessGone === "";
  reason.textContent = view.renderProcessGone;
};
showCard();
view.addEventListener(WEBVIEW_RENDER_PROCESS_CHANGE_EVENT, showCard);
retry.addEventListener("click", () => view.reload());
```

<!-- /tabs -->

- **`renderProcessGone`** is `crashed`, `killed`, `oom`, `abnormal-exit`,
  `clean-exit`, `launch-failed` or `memory-eviction`
  (`WEBVIEW_RENDER_PROCESS_GONE_REASONS`), and `""` while the page runs.
- **`renderProcessExitCode`** is Chromium's code for the process: its wait
  status, or the browser's own code when it ended the process. 0 while it
  runs. Log it; branch on `renderProcessGone`.
- **The view draws nothing** while the page is gone, so your card can sit over
  it or under it. Chromium's sad frame is not drawn.
- **`reload()` or a new `src`** starts a new renderer. The property returns to
  `""` and the event fires again.
- A browser window keeps its state across `domicile load-shell`, so a new
  shell reads `renderProcessGone` on mount.

## Close requests

`window.close()` in a browser window's page, or an extension's
`chrome.tabs.remove`, closes the window. It leaves the next `browser.on("change")`.
`window.close()` works only when the page's history has a single entry.

`browser.close(id)` runs the page's `beforeunload` first, as closing a
Chrome tab does:

- A page with no `beforeunload` handler closes at once.
- A handler that asks to stay fires a `beforeunload` dialog
  ([Dialogs](#dialogs)). Leave (`accept()`) closes the window; Cancel
  (`dismiss()`) keeps it, and it stays in the list.
- Chrome lets a page ask only after the user has interacted with it.

In a view of your own (a `<webview src>` with no `window`), the element fires
`domicile-close` and nothing closes until you remove it:

<!-- tab: React -->

```tsx
import { WEBVIEW_CLOSE_EVENT } from "@domicile-desktop/sdk/webview-element";

useEffect(() => {
  const popupView = popupViewRef.current; // your own <webview src>
  const closed = () => {
    setPopupOpen(false); // unmounts the view
  };
  popupView?.addEventListener(WEBVIEW_CLOSE_EVENT, closed);
  return () => popupView?.removeEventListener(WEBVIEW_CLOSE_EVENT, closed);
}, []);
```

<!-- tab: JavaScript -->

```js
import { WEBVIEW_CLOSE_EVENT } from "@domicile-desktop/sdk/webview-element";

popupView.addEventListener(WEBVIEW_CLOSE_EVENT, () => {
  popupView.remove();
});
```

<!-- /tabs -->

## File pickers

`<input type="file">`, downloads, `showSaveFilePicker()` and the PDF viewer's
save all fire `domicile-file-chooser`. The browser shows no dialog; you draw
the picker. A dialog from the shell's own page asks the desktop's
FileChooser portal instead, as an application's does
([PORTALS.md](PORTALS.md)). A folder dropped on a page's `webkitdirectory`
input uploads its files, with no picker.

<!-- tab: React -->

```tsx
import { WEBVIEW_FILE_CHOOSER_EVENT } from "@domicile-desktop/sdk/webview-element";

useEffect(() => {
  const frame = frameRef.current; // the browser window's element
  const choosing = (event) => {
    event.preventDefault(); // claim it
    showPicker(event.mode, event.accept, event.suggestedName).then(
      (paths) => event.choose(paths),
      () => event.cancel(),
    );
  };
  frame?.addEventListener(WEBVIEW_FILE_CHOOSER_EVENT, choosing);
  return () => frame?.removeEventListener(WEBVIEW_FILE_CHOOSER_EVENT, choosing);
}, []);
```

<!-- tab: JavaScript -->

```js
import { WEBVIEW_FILE_CHOOSER_EVENT } from "@domicile-desktop/sdk/webview-element";

frame.addEventListener(WEBVIEW_FILE_CHOOSER_EVENT, (event) => {
  event.preventDefault(); // claim it
  showPicker(event.mode, event.accept, event.suggestedName).then(
    (paths) => event.choose(paths),
    () => event.cancel(),
  );
});
```

<!-- /tabs -->

- **`preventDefault()`:** claims it. Unclaimed choosers are canceled when
  dispatch returns.
- **`event.home`** is the absolute home directory.
- **`event.currentFolder`** is the absolute folder to start in, or `""` for
  the home. A download starts in the download folder (`XDG_DOWNLOAD_DIR`).
- **Listing directories:** `domicile.files.readDir` and `files.stat`
  ([SHELL-SYSTEM-ACCESS.md](/docs/SHELL-SYSTEM-ACCESS.md)).
  They are refused while the desktop is locked.
- **Paths** are absolute or relative to home (`""` is home). `..` throws a
  `TypeError`.
- **`mode`** is `open`, `open-multiple`, `open-folder` or `save`. `accept`
  lists extensions without the dot (empty means any). `suggestedName` is for
  saves.
- **Downloads:** every download asks, in `save` mode. Canceling saves
  nothing. The download is then listed in `domicile.downloads`; see
  [Downloads](#downloads).
- **A ready-made picker:** `@domicile-desktop/component-library/FilePicker`
  takes a `FileRequest`. Manganese builds one from the event in
  `window-management/browser/file-request.ts`. It asks before a save
  replaces a file.

## Downloads

`domicile.downloads` lists the desk's downloads, oldest first: every download
a browser window's page started while the engine runs. A download stays listed
after its window closes. The list is the engine's, so every shell document
sees the same one.

- **Listed** once the shell picks where it goes. A download canceled in the
  picker is never listed.
- **Each download:** `id`, `state` (`InProgress`, `Complete` or `Failed`),
  `path`, `receivedBytes`, `totalBytes` (0 when the server sent no size),
  `window` (the browser window that started it, or `undefined`) and `page`.
- **`cancel(id)`** stops a download in progress; it leaves the list.
- **`remove(id)`** and **`clear()`** take finished and failed downloads off
  the list. The files stay.
- **`on("change")`** fires on every change, including progress.
- Downloads from an earlier run of the engine are not listed.

Manganese draws the list as a bar item: `@domicile-desktop/manganese-bar-module-downloads`.

## Permissions

The browser draws no permission prompt. A site asking for a permission it has
no stored choice for fires `domicile-permission-request`:

<!-- tab: React -->

```tsx
import { WEBVIEW_PERMISSION_REQUEST_EVENT } from "@domicile-desktop/sdk/webview-element";

useEffect(() => {
  const frame = frameRef.current; // the browser window's element
  const asked = (event) => {
    event.preventDefault(); // claim it
    ask(event.origin, event.permissions).then(
      (allowed) => (allowed ? event.allow() : event.deny()),
      () => event.dismiss(),
    );
  };
  frame?.addEventListener(WEBVIEW_PERMISSION_REQUEST_EVENT, asked);
  return () => frame?.removeEventListener(WEBVIEW_PERMISSION_REQUEST_EVENT, asked);
}, []);
```

<!-- tab: JavaScript -->

```js
import { WEBVIEW_PERMISSION_REQUEST_EVENT } from "@domicile-desktop/sdk/webview-element";

frame.addEventListener(WEBVIEW_PERMISSION_REQUEST_EVENT, (event) => {
  event.preventDefault(); // claim it
  ask(event.origin, event.permissions).then(
    (allowed) => (allowed ? event.allow() : event.deny()),
    () => event.dismiss(),
  );
});
```

<!-- /tabs -->

- **`preventDefault()`:** claims it. Unclaimed requests are ignored: the page
  gets nothing and nothing is stored.
- **Answers:** `allow()` and `deny()` store the choice for the site.
  `dismiss()` stores nothing; Chrome blocks a site for a while after several.
- **One at a time.** Camera and microphone may come together.
- **`domicile-permission-request-withdrawn`:** the browser dropped the request,
  for example on navigation. Stop showing it.
- **Permissions:** `camera`, `microphone`, `location`, `notifications`,
  `clipboard`, `midi`, `window-management`, `local-fonts`, `idle-detection`
  and `automatic-downloads` (`WEBVIEW_PERMISSIONS`). A request for anything
  else is ignored.
- **Hidden windows wait.** A request is asked when its window is shown.
- **Site settings:** `view.sitePermissions()` maps each permission to `ask`,
  `allow` or `block` for the page's site, `{}` for a page that is not `http`,
  `https` or `chrome-extension`. An extension's pages share one origin, so a
  choice made in a browser window holds in its action popup. `view.setSitePermission(permission, setting)` stores one.
  `domicile-site-permissions-change` signals a change.
- **Camera and microphone device:** `view.mediaDevices()` resolves with
  `{cameras, microphones}`, each `{id, name}`, most preferred first. A page
  that names no device gets the first. `view.setMediaDevice(kind, id)` puts
  one first, for `kind` `camera` or `microphone`; it rejects with
  `NotFoundError` for an id no connected device has. The preference is the
  profile's, not the site's, and there is no change event, so list again
  when showing it.
- **Notifications** default to `ask`, like the rest
  ([NOTIFICATIONS.md](/docs/architecture/NOTIFICATIONS.md)).
- **Screen capture** (`getDisplayMedia`) asks no site permission. The
  desktop's ScreenCast portal asks, in the shell's picker
  ([PORTALS.md](PORTALS.md)). The page gets the window, browser window,
  monitor or region picked, with the pointer. Asking for `audio` gets the
  source's sound: a window's app's, or every app's for a monitor or region.
  A browser window is captured as a tab: its page alone, its sound,
  `cropTo()` and its capture handle. `preferCurrentTab` opens the same
  picker, where the page's own browser window is listed with the rest.
  - The promise waits for the pick. Canceling the picker rejects it with
    `NotAllowedError`.
  - The pick opens two portal sessions: the picker's, then the capture's,
    which restores the pick from its token without asking again.
  - `displaySurface` is `window` for a window, `browser` for a browser
    window, and `monitor` for a monitor or region.

Manganese draws both in the address bar's site permissions panel
(`window-management/browser/SitePermissions.tsx`).

## Devices

The browser draws no device chooser. A page asking for a device through
WebHID, WebUSB or Web Serial, such as a hardware wallet, fires
`domicile-device-request`:

<!-- tab: React -->

```tsx
import { WEBVIEW_DEVICE_REQUEST_EVENT } from "@domicile-desktop/sdk/webview-element";

useEffect(() => {
  const frame = frameRef.current; // the browser window's element
  const asked = (event) => {
    event.preventDefault(); // claim it
    pick(event.title, () => event.devices()).then(
      (id) => event.choose([id]),
      () => event.cancel(),
    );
  };
  frame?.addEventListener(WEBVIEW_DEVICE_REQUEST_EVENT, asked);
  return () => frame?.removeEventListener(WEBVIEW_DEVICE_REQUEST_EVENT, asked);
}, []);
```

<!-- tab: JavaScript -->

```js
import { WEBVIEW_DEVICE_REQUEST_EVENT } from "@domicile-desktop/sdk/webview-element";

frame.addEventListener(WEBVIEW_DEVICE_REQUEST_EVENT, (event) => {
  event.preventDefault(); // claim it
  pick(event.title, () => event.devices()).then(
    (id) => event.choose([id]),
    () => event.cancel(),
  );
});
```

<!-- /tabs -->

- **`preventDefault()`:** claims it. Unclaimed requests are canceled: the page
  gets no device.
- **`title`:** Chrome's question, naming the site and the kind of device.
- **`devices()`:** `{ id, name }` for each device on offer. Empty while
  `listed` is false, before the browser has listed them.
  `domicile-device-request-change` fires when they change, including as
  devices are plugged in or removed.
- **Answers:** `choose(ids)` grants the site those devices; `cancel()` grants
  none. A device unplugged after it was offered is dropped from the answer.
- **One at a time.** `multiple` is false for every chooser Chrome has.
- **`domicile-device-request-withdrawn`:** the browser dropped the request,
  for example on navigation. Stop showing it.

Manganese draws it over the page (`window-management/browser/DeviceAsk.tsx`),
and above an extension's popup.

## Dialogs

The browser draws no dialog. A page's `alert()`, `confirm()` or `prompt()`,
or a `beforeunload` handler that asks to stay, pauses it and fires
`domicile-dialog`:

<!-- tab: React -->

```tsx
import { WEBVIEW_DIALOG_EVENT } from "@domicile-desktop/sdk/webview-element";

useEffect(() => {
  const frame = frameRef.current; // the browser window's element
  const asked = (event) => {
    event.preventDefault(); // claim it
    show(event.dialogType, event.message, event.defaultValue).then(
      (value) => event.accept(value),
      () => event.dismiss(),
    );
  };
  frame?.addEventListener(WEBVIEW_DIALOG_EVENT, asked);
  return () => frame?.removeEventListener(WEBVIEW_DIALOG_EVENT, asked);
}, []);
```

<!-- tab: JavaScript -->

```js
import { WEBVIEW_DIALOG_EVENT } from "@domicile-desktop/sdk/webview-element";

frame.addEventListener(WEBVIEW_DIALOG_EVENT, (event) => {
  event.preventDefault(); // claim it
  show(event.dialogType, event.message, event.defaultValue).then(
    (value) => event.accept(value),
    () => event.dismiss(),
  );
});
```

<!-- /tabs -->

- **`preventDefault()`:** claims it. Unclaimed dialogs are dismissed:
  `confirm()` returns false and `prompt()` null. An unclaimed `beforeunload`
  leaves.
- **`dialogType`:** `alert`, `confirm`, `prompt` or `beforeunload`
  (`WEBVIEW_DIALOG_TYPES`).
- **`origin`:** the calling frame's site, or `null` for one with none.
- **Answers:** `accept(value)` is OK, and `value` is what `prompt()` returns.
  `dismiss()` is Cancel.
- **`beforeunload`:** the page is closing, navigating or reloading, and asked
  to stay. `message` is empty: draw Chrome's "Leave site?". `accept()` leaves;
  `dismiss()` stays. See [Close requests](#close-requests).
- **One at a time.** A second dialog while one is open is dismissed.
- **`domicile-dialog-withdrawn`:** the browser dropped the dialog, for example
  on navigation. Stop showing it.

Manganese draws it over the page it pauses
(`window-management/browser/PageDialog.tsx`), and over an extension's popup.

## Links for applications

A link for an application, such as `zoommtg:` or `mailto:`, fires
`domicile-external-app` instead of Chrome's "Open xdg-open?" dialog:

<!-- tab: React -->

```tsx
import { WEBVIEW_EXTERNAL_APP_EVENT } from "@domicile-desktop/sdk/webview-element";

useEffect(() => {
  const frame = frameRef.current; // the browser window's element
  const asked = (event) => {
    event.preventDefault(); // claim it
    ask(event.url, event.origin, event.mayRemember).then(
      (remember) => event.open(remember),
      () => event.dismiss(),
    );
  };
  frame?.addEventListener(WEBVIEW_EXTERNAL_APP_EVENT, asked);
  return () => frame?.removeEventListener(WEBVIEW_EXTERNAL_APP_EVENT, asked);
}, []);
```

<!-- tab: JavaScript -->

```js
import { WEBVIEW_EXTERNAL_APP_EVENT } from "@domicile-desktop/sdk/webview-element";

frame.addEventListener(WEBVIEW_EXTERNAL_APP_EVENT, (event) => {
  event.preventDefault(); // claim it
  ask(event.url, event.origin, event.mayRemember).then(
    (remember) => event.open(remember),
    () => event.dismiss(),
  );
});
```

<!-- /tabs -->

- **`preventDefault()`:** claims it. Unclaimed, nothing opens.
- **`url`:** the link. **`origin`:** the site that opened it, or `""`.
- **`open(remember)`:** launches the scheme's default application. With
  `remember` and `mayRemember` (secure sites only), the site opens these links
  without asking from then on.
- **Not fired** for a blocked scheme or a site already remembered.
- **One at a time.** A newer one replaces the open one, which opens nothing
  and fires `domicile-external-app-withdrawn`.

Manganese asks over the page, naming the application from its desktop entry
(`manganese-page-requests/ExternalAppAsk.tsx`).

## Sign-ins

A site or proxy that asks for a user name and password (HTTP authentication)
fires `domicile-sign-in` instead of Chrome's "Sign in" dialog:

<!-- tab: React -->

```tsx
import { WEBVIEW_SIGN_IN_EVENT } from "@domicile-desktop/sdk/webview-element";

useEffect(() => {
  const frame = frameRef.current; // the browser window's element
  const asked = (event) => {
    event.preventDefault(); // claim it
    ask(event.url, event.proxy, event.secure).then(
      ({ username, password }) => event.signIn(username, password),
      () => event.dismiss(),
    );
  };
  frame?.addEventListener(WEBVIEW_SIGN_IN_EVENT, asked);
  return () => frame?.removeEventListener(WEBVIEW_SIGN_IN_EVENT, asked);
}, []);
```

<!-- tab: JavaScript -->

```js
import { WEBVIEW_SIGN_IN_EVENT } from "@domicile-desktop/sdk/webview-element";

frame.addEventListener(WEBVIEW_SIGN_IN_EVENT, (event) => {
  event.preventDefault(); // claim it
  ask(event.url, event.proxy, event.secure).then(
    ({ username, password }) => event.signIn(username, password),
    () => event.dismiss(),
  );
});
```

<!-- /tabs -->

- **`preventDefault()`:** claims it. Unclaimed, it is canceled and the page
  shows the site's refusal.
- **`url`:** the server or proxy that asked. **`proxy`:** whether a proxy
  asked. **`secure`:** false when the password would cross the network
  unencrypted. **`realm`:** the server's own text; Chrome does not show it.
- **One at a time.** A newer one replaces the open one, which is canceled
  and fires `domicile-sign-in-withdrawn`, as does one the browser drops.
- A sign-in also answers other requests for the same realm.

Manganese asks over the page (`manganese-page-requests/SignInAsk.tsx`).

## Other prompts

Questions Chrome would ask with dialogs of its own fire `domicile-prompt`:
letting a site view or edit a file or folder, picking a certificate to sign
in with, pairing a Bluetooth device, adding an extension or granting it
permissions, sending a form again on reload, and ending a page that stopped
responding.

<!-- tab: React -->

```tsx
import { WEBVIEW_PROMPT_EVENT } from "@domicile-desktop/sdk/webview-element";

useEffect(() => {
  const frame = frameRef.current; // the browser window's element
  const asked = (event) => {
    event.preventDefault(); // claim it
    ask(event.kind, event.origin, event.subject, event.details).then(
      ({ choice, text }) => event.accept(choice, text),
      () => event.dismiss(),
    );
  };
  frame?.addEventListener(WEBVIEW_PROMPT_EVENT, asked);
  return () => frame?.removeEventListener(WEBVIEW_PROMPT_EVENT, asked);
}, []);
```

<!-- tab: JavaScript -->

```js
import { WEBVIEW_PROMPT_EVENT } from "@domicile-desktop/sdk/webview-element";

frame.addEventListener(WEBVIEW_PROMPT_EVENT, (event) => {
  event.preventDefault(); // claim it
  ask(event.kind, event.origin, event.subject, event.details).then(
    ({ choice, text }) => event.accept(choice, text),
    () => event.dismiss(),
  );
});
```

<!-- /tabs -->

- **`preventDefault()`:** claims it. Unclaimed, it is answered no.
- **`kind`:** what is asked; `WEBVIEW_PROMPT_KINDS` lists them and what each
  reads. **`origin`:** the site that asked. **`subject`:** the file's,
  device's or extension's name, or the page's title. **`details`:** a file's full path, the
  certificates (`"name\nissuer"`), or an extension's permissions. **`pin`:**
  the PIN a Bluetooth device shows.
- **`accept(choice, text)`:** yes. `choice` is the picked certificate;
  `text` the typed Bluetooth PIN. **`dismiss()`:** no. For a certificate, no
  continues without one.
- **One at a time.** A newer one replaces the open one, which is answered no
  and fires `domicile-prompt-withdrawn`, as does one the browser drops. An
  `unresponsive` prompt is withdrawn when the page responds again.

Manganese asks over the page (`manganese-page-requests/PromptAsk.tsx`).

## Pickers

A color input, a date or time input, or a text input's `<datalist>` fires
`domicile-picker` instead of opening a picker Chrome draws.

<!-- tab: React -->

```tsx
import { WEBVIEW_PICKER_EVENT } from "@domicile-desktop/sdk/webview-element";

useEffect(() => {
  const frame = frameRef.current; // the browser window's element
  const opened = (event) => {
    event.preventDefault(); // claim it
    pick(event.kind, event.value, event.options, {
      x: event.anchorX,
      y: event.anchorY + event.anchorHeight,
    }).then(
      (value) => event.choose(value),
      () => event.cancel(),
    );
  };
  frame?.addEventListener(WEBVIEW_PICKER_EVENT, opened);
  return () => frame?.removeEventListener(WEBVIEW_PICKER_EVENT, opened);
}, []);
```

<!-- tab: JavaScript -->

```js
import { WEBVIEW_PICKER_EVENT } from "@domicile-desktop/sdk/webview-element";

frame.addEventListener(WEBVIEW_PICKER_EVENT, (event) => {
  event.preventDefault(); // claim it
  pick(event.kind, event.value, event.options, {
    x: event.anchorX,
    y: event.anchorY + event.anchorHeight,
  }).then(
    (value) => event.choose(value),
    () => event.cancel(),
  );
});
```

<!-- /tabs -->

- **`preventDefault()`:** claims it. Unclaimed, the control keeps its value.
- **`kind`:** `color`, `date`, `time`, `datetime-local`, `month`, `week` or
  `list`; `WEBVIEW_PICKER_KINDS` gives each one's value format.
  **`value`**, **`min`**, **`max`**, **`step`:** the control's, as written.
  **`options`** and **`labels`:** a `<datalist>`'s suggestions, or a color
  input's.
- **`anchorX`**, **`anchorY`**, **`anchorWidth`**, **`anchorHeight`:** the
  control's box in the element's CSS pixels, to hang the picker from.
- **`choose(value)`:** picks it, in the kind's format. **`cancel()`:** keeps
  the old value.
- **One at a time.** A newer one replaces the open one, which is canceled and
  fires `domicile-picker-withdrawn`, as does one the page closes.

Manganese draws them over the page (`manganese-page-requests/PickerAsk.tsx`).

## "Sign in with"

A site that signs in with an identity provider ("Sign in with Google",
FedCM) fires `domicile-identity` for each step of it, instead of Chrome's
account chooser:

<!-- tab: React -->

```tsx
import { WEBVIEW_IDENTITY_EVENT } from "@domicile-desktop/sdk/webview-element";

useEffect(() => {
  const frame = frameRef.current; // the browser window's element
  const asked = (event) => {
    event.preventDefault(); // claim it
    show(event.step, event.site, event.providers(), event.accounts()).then(
      (account) => event.choose(account),
      () => event.dismiss(),
    );
  };
  frame?.addEventListener(WEBVIEW_IDENTITY_EVENT, asked);
  return () => frame?.removeEventListener(WEBVIEW_IDENTITY_EVENT, asked);
}, []);
```

<!-- tab: JavaScript -->

```js
import { WEBVIEW_IDENTITY_EVENT } from "@domicile-desktop/sdk/webview-element";

frame.addEventListener(WEBVIEW_IDENTITY_EVENT, (event) => {
  event.preventDefault(); // claim it
  show(event.step, event.site, event.providers(), event.accounts()).then(
    (account) => event.choose(account),
    () => event.dismiss(),
  );
});
```

<!-- /tabs -->

- **`preventDefault()`:** claims it. Unclaimed, the request fails.
- **`step`:** `loading`, `accounts`, `signed-out`, `verifying` or `error`;
  `WEBVIEW_IDENTITY_STEPS` gives what each shows and takes.
- **`button`:** the page asked from its own sign-in button, so show it over
  the page. False when the site offers it unasked, as many do on load: leave
  the page usable.
- **`site`**, **`purpose`:** the site signing in and what for (`sign-in`,
  `sign-up`, `use`, `continue`), to title it.
- **`providers()`**, **`accounts()`:** each account names its provider and
  what signing in with it `shared`s with the site the first time. A
  provider lists the site's privacy policy and terms of service.
- **`choose(account)`:** signs in. **`signInToProvider(provider)`:** opens
  the provider's sign-in page in a browser window, when signed out or for
  another account. **`moreDetails()`:** opens an `error`'s page.
  **`dismiss()`:** the user's close, which quiets the site's unasked offers
  for a while, as Chrome's ✕ does.
- **One step at a time.** The next step replaces the open one, which fires
  `domicile-identity-withdrawn`, as does one the browser drops.

Manganese asks over the page after the site's button, and in the page's
corner otherwise (`manganese-page-requests/IdentityAsk.tsx`).

## Error, warning and crashed pages

The engine draws no error page, certificate or Safe Browsing warning, or
crashed page: the page is left blank and the element says why.

<!-- tab: React -->

```tsx
import { WEBVIEW_PAGE_FAILURE_CHANGE_EVENT } from "@domicile-desktop/sdk/webview-element";

useEffect(() => {
  const frame = frameRef.current; // the browser window's element
  const changed = () => {
    setFailure(frame?.pageFailure ?? ""); // "" once a page loads
  };
  frame?.addEventListener(WEBVIEW_PAGE_FAILURE_CHANGE_EVENT, changed);
  return () =>
    frame?.removeEventListener(WEBVIEW_PAGE_FAILURE_CHANGE_EVENT, changed);
}, []);
```

<!-- tab: JavaScript -->

```js
import { WEBVIEW_PAGE_FAILURE_CHANGE_EVENT } from "@domicile-desktop/sdk/webview-element";

frame.addEventListener(WEBVIEW_PAGE_FAILURE_CHANGE_EVENT, () => {
  showFailure(frame.pageFailure); // "" once a page loads
});
```

<!-- /tabs -->

- **`pageFailure`:** `network`, `http`, `certificate` or `warning`, or `""`.
  **`pageFailureUrl`:** the address that failed. **`pageFailureError`:**
  Chromium's name for the error, such as `ERR_NAME_NOT_RESOLVED`.
  **`pageFailureHttpStatus`:** the status for `http`.
- **`proceedPastWarning()`:** loads the page a certificate or safety warning
  stopped, only when **`pageFailureCanProceed`**.
- A crashed page sets `renderProcessGone` instead
  (`domicile-render-process-change`); `reload()` brings it back.

Manganese draws these over the page
(`manganese-window-management/src/browser/PageProblem.tsx`).
