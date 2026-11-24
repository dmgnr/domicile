# Chrome extensions on a desk

- The desk config lists Chrome extensions. The engine installs them into the
  profile that browser windows use.
- Each extension's action appears in the shell's tray. Its popup opens in a
  `<webview>`.
- To `chrome.tabs`, every `<webview>` is a tab, and the desktop is one
  `chrome.windows` window. Extensions can also open `popup` windows, which the
  shell draws.
- Shell API: [SHELL-EXTENSIONS.md](/docs/SHELL-EXTENSIONS.md).

## Problem

The engine is a `chrome/` build, so the extension system (service workers,
content scripts, `declarativeNetRequest`, `chrome.storage`) is already compiled
in. Three things are missing:

- **Install.** The Web Store install button needs a Chrome browser window. A
  desk has none.
- **Action UI.** Chrome draws the icon and popup in its toolbar. The shell owns
  the whole screen, so there is no toolbar.
- **Tabs.** `chrome.tabs` finds tabs through a browser window's tab strip. A
  `WebViewGuest` is in none, so `tabs.query` returns nothing. Most popups start
  with `tabs.query({active: true, currentWindow: true})`.

## Design

### Installing

```json
{
  "extensions": {
    "web_store": ["ddkjiahejlhfcafbddmgiahcphecmpfh"],
    "unpacked": ["~/src/my-extension"]
  }
}
```

- `web_store`: Web Store ids (this one is uBlock Origin Lite).
- `unpacked`: directories, absolute or under `~`.

| Step | Where |
|---|---|
| Parse, expand `~`, keep the last good config on a bad edit | `domicile-config`, `ExtensionsConfig` |
| Send the list with the handshake and on reload | `domicile-protocol`, `HostMessage::Extensions { web_store, unpacked, settings }` |
| Receive it in the browser process | `components/domicile/browser/control_channel.cc` |
| Decide what to add and remove | `components/domicile/browser/extension_installer.{h,cc}`, `ReconcileExtensions` |
| Install and uninstall in the profile | `chrome/browser/domicile/domicile_extension_installer.{h,cc}` (patch 0055) |

Once `ExtensionSystem::ready()`, reconciling:

- Adds a missing Web Store id via
  `PendingExtensionManager::AddFromExternalUpdateUrl` with
  `extension_urls::GetWebstoreUpdateUrl()`, as `kInternal`, as a Store
  install is. It installs and updates from the Store. Not an external
  location: at every start Chrome uninstalls, data and all, each external
  extension no external provider lists (`CheckExternalUninstall`), and the
  config is no provider.
- Loads a missing directory via `UnpackedInstaller::Load`. Failures are logged.
  Paths are compared after `base::MakeAbsoluteFilePath`.
- Uninstalls an extension it added that the list no longer names, with
  `UNINSTALL_REASON_ORPHANED_EXTERNAL_EXTENSION`. The pref
  `domicile.extensions.added` records what it added, and claims a listed,
  installed id it lacks. It leaves other extensions alone.

Listing an extension is consent. There is no install prompt, and manifest
permissions are granted as declared (`GrantPermissionsOf`), at install, at
each update and at each start. A Web Store install with no prompt grants
none, and Chrome switches off a `kInternal` extension whose active
permissions exceed its granted ones (`DISABLE_PERMISSIONS_INCREASE`).
Switching an extension on grants its permissions too.

Each browser profile is a Chrome profile of its own, so the lists are
reconciled once per profile: each gets every extension, switched on or off
in it. An extension the user installs in one profile goes into the others
too, from the Web Store or its unpacked directory, and one they uninstall
leaves them all. A profile whose `browser.profiles.<id>.extensions` names its
extensions has those on and the rest off, and the user cannot switch them.
One that names none starts each extension on, or off in a private profile,
the first time it is installed there, and the user switches it from then on
(`BrowserProfileRegistry` in
`chrome/browser/domicile/domicile_browser_profiles.h`). See
[BROWSER-PROFILES.md](BROWSER-PROFILES.md).

The Settings app removes extensions by editing these lists, and switches
extensions on and off through `chrome.management`
([SETTINGS.md](/docs/SETTINGS.md)).

#### From the Settings app

A home-manager config is read-only, so the Settings app also installs and
uninstalls through the engine's command socket, relayed by
`domicile-app-host` and `domicile`
([CONTROL-CHANNEL.md](/packages/domicile-engine/docs/CONTROL-CHANNEL.md#command-socket)):

| Command | Does |
|---|---|
| `load_unpacked` | `UnpackedInstaller::Load` on an absolute directory, picked in the `FileChooser` portal. It is not recorded in `domicile.extensions.added`, so reconciling leaves it, and Chromium loads it again on every start. |
| `uninstall_extension` | `UNINSTALL_REASON_USER_INITIATED`. Refuses an id in `domicile.extensions.added`, which reconciling would install again. |
| `config_extensions` | The ids in `domicile.extensions.added`. The app shows no uninstall button for these unless the config is writable and lists the id. |

Chromium disables unpacked extensions outside developer mode
(`DISABLE_UNSUPPORTED_DEVELOPER_EXTENSION`). The installer sets
`prefs::kExtensionsUIDeveloperMode` before loading a directory and leaves it
on.

### Settings

A desk has no chrome://extensions, so its per-extension settings come from the
config and the Settings app:

```json
{
  "extensions": {
    "settings": {
      "eimadpbcbfnmbkopoojfekhnkhdbieeh": {
        "file_access": false,
        "site_access": ["github.com", "*.example.com"]
      },
      "jinjaccalgkegednnccohejagnlnfdag": {
        "user_scripts": true,
        "site_access": "on_click"
      }
    }
  }
}
```

| Setting | Chrome's call | Chrome's default |
|---|---|---|
| `file_access` | `util::SetAllowFileAccess` | off |
| `user_scripts` | `UserScriptManager::SetUserScriptPrefEnabled` | off |
| `site_access` | `ScriptingPermissionsModifier`: `"all_sites"` grants every host it asks for, `"on_click"` withholds them, a list grants `*://host/*` for each | `"all_sites"` |

- Private windows are not a setting: a private browser profile's extension
  switches say what runs in its pages (below). The config refuses `private`,
  and so do `configure_extension` and the engine's `extensions` message.
- An extension that cannot use a setting is refused it: one that asks for no
  `file://` access,
  no `userScripts` permission, or no hosts. The listing leaves those out.
- A setting the config leaves out is the user's, changed in the Settings app
  through the command socket's `configure_extension`.
- One the config drops goes back to Chrome's default. The pref
  `domicile.extensions.settings` records what the config last set
  (`ReconcileSettings`).
- A Web Store id is still pending when the config arrives, so its settings are
  applied once it installs (`InstallWatch`).
- `file_access` reloads the extension, as on chrome://extensions.

Code: `components/domicile/browser/extension_settings.{h,cc}` (parse, write,
reconcile) and `chrome/browser/domicile/domicile_extension_settings.{h,cc}`
(read and set in the profile).

### Private windows

A private page is a `<webview private>`, a guest of a private browser
profile's off-the-record profile. Its extensions are installed into its
hidden parent and allowed into private pages, and those switched on there
run in them (ExtensionsFor in
`components/domicile/browser/browser_profiles.h`). Its desk is that
off-the-record profile's own `DomicileWindowController`, made the first time
a private page opens. Chrome's `EventRouter` and
`ExtensionTabUtil` already hide an off-the-record window from an extension not
allowed in private windows, so the desk only has to treat the private desk as
one more window:

- Private guests get the same tab helpers as others, except history and
  favicons (`domicile_tab_helpers.cc`).
- `tabs.query`, `windows.getAll` and the window lookups walk every desk the
  extension may see (`domicile_desk_functions.cc`).
- The current and last focused window is the desk whose tab last took focus
  (`LastFocusedDesk`). For an extension not allowed in private windows, it is
  the ordinary desk (patch 0206, `CurrentWindowFor`).
- The tray's active tab is a private page only for an extension allowed in
  private windows.

### The tray

`components/domicile/mojom/extension_tray.mojom` carries action state from the
browser process to the shell. It binds on the shell's origin only, like the
control channel, and appears on the `DomicileHost`. The SDK layer gives a
shell it as `domicile.extensions` (`list`, `activate`, `setProfile`,
`on("change")`):

```ts
// DomicileHost
readonly extensions: readonly DomicileExtension[] | null; // with extensionschanged
activateExtension(id: string): void;
setExtensionsProfile(profile: string): void;

interface DomicileExtension {
  id: string;
  name: string;
  title: string;              // the action's tooltip
  icon: string;               // data:image/png, rendered at the page's DPR
  badgeText: string;
  badgeColor: string;         // CSS color, #rrggbbaa
  popup: string | null;       // chrome-extension://<id>/popup.html, or null (undefined in the SDK)
  enabled: boolean;
  profile: string;            // the browser profile it is in, which its popup opens in
}
```

- **One profile's actions.** Each browser profile is a Chrome profile with
  its own extensions, so the tray shows one profile's, as Chrome's toolbar
  shows its window's: `setExtensionsProfile(profile)` names it, and a shell
  names the profile of the page it last focused. The default profile's until
  then, and while that profile loads. Clicks go to the active tab of that
  profile's pages, and each entry's `profile` says which it is. The popup
  opens as `<webview extensionpopup profile={profile}>`, in the extension's
  own profile, where its storage and sign-ins are.

- **`extensions`** holds every extension whose manifest names an action, and
  `extensionschanged` fires on every change, so a reloaded page reads it
  again. Chrome synthesizes an action for one that names none and shows it in
  the toolbar only once pinned; the tray leaves it out, and lists it only in
  its menu. Sources: `ExtensionRegistryObserver` and
  `ExtensionActionDispatcher::Observer::OnExtensionActionUpdated`.
- **`icon`** is a data URL because `action.setIcon({imageData})` has no URL.
- **Action state** is per tab. The list reports the active tab's state and is
  resent when the active tab changes. With no active tab it reports the
  default (tab `-1`).
- **`activateExtension(id)`** handles every click, as
  `ExtensionActionRunner::RunAction` does for a toolbar click:
  - It grants `activeTab` on the active tab
    (`ActiveTabPermissionGranter::GrantIfRequested`). With no active tab, it
    grants nothing.
  - It dispatches `action.onClicked` with that tab if the action has no
    popup, from `GrantIfRequested`'s callback, so the listener can use the
    grant.
- **Popups.** If the action has a popup, the shell opens
  `<webview extensionpopup src={popup}>` in a panel under the icon.
  - The page gets the full extension API from its `chrome-extension://`
    origin.
  - The popup's `window.close()` fires `domicile-close` on the element
    (`WebViewGuestClient.CloseRequested`).
  - The guest has view type `kExtensionPopup`, no tab id and no desk window,
    like Chrome's toolbar bubble. So `runtime.getContexts` lists it as
    `POPUP`, `tabs.getCurrent()` returns nothing, and
    `tabs.query({active: true, currentWindow: true})` returns the desk's
    active tab. Some extensions depend on this: Bitwarden sets a 380px body
    width only when `tabs.getCurrent()` finds no tab.
- **Panel size** fits the popup's content, like Chrome's bubble. The guest's
  page runs in Blink's auto-resize mode between Chrome's popup bounds, 25x25
  and 800x600 (`WebViewGuest::EnableAutoResize`), as `ExtensionViewViews`
  does. Each size it takes reaches the element as `contentWidth` /
  `contentHeight` and `domicile-content-size-change`
  (`WebViewGuestClient.ContentSizeChanged`). The tray shows the panel once the
  page has loaded, as `ExtensionPopup` does.
- **`action.openPopup()`** asks the shell for the popup, since the desk has
  no toolbar. The desk's function replaces Chrome's
  (`domicile_desk_functions.cc`) and checks as Chrome does: the desk's
  window, not a popup window, and a popup on the active tab. It sends
  `ExtensionTrayClient.PopupRequested(id, popup, profile)` to every tray, which
  the shell gets as `extensionpopuprequested`, with the extension's profile
  for the popup's `<webview>`. It answers once the shell is
  asked, not once the popup loads. The popup's URL is carried because
  Phantom clears its popup as soon as the call answers.
- **`sidePanel.open()`** opens the side panel's page as a popup window of its
  own, with no size, since the desk has no side panel. The shell tiles it
  with the other windows, with no address bar. A second call raises the window already
  showing that page; `sidePanel.close()` closes it. The desk's functions
  replace Chrome's and check as Chrome does (a target, the window, an enabled
  panel), but ask for no user gesture, which the desk's clicks lack. Phantom
  opens in its side panel by default from 26.37.

- **Every installed extension** reaches the shell too, for a menu that
  switches and configures them, as chrome://extensions does. The SDK gives it
  as `domicile.extensions.installed` (`on("installed")`), with `setEnabled`,
  `configure` and `uninstall`:

  ```ts
  // DomicileHost
  readonly installedExtensions: readonly DomicileInstalledExtension[] | null; // with installedextensionschanged
  setExtensionEnabled(id: string, enabled: boolean): Promise<void>;
  configureExtension(id: string, settings: DomicileExtensionSettings): Promise<void>;
  uninstallExtension(id: string): Promise<void>;
  ```

  - Each row has the manifest's icon, whether it is on, and the
    [settings](#settings) it can use (null for one it cannot), the sites for
    `"specific_sites"`, which settings the config sets (`configured`), and
    whether the config installed it (`fromConfig`).
  - The calls are the Settings app's (`SetExtensionEnabledIn`,
    `ConfigureExtensionIn`, `UninstallFrom`). Each rejects with an
    `OperationError` carrying the engine's words: a setting the config sets,
    an extension the config installed, or one not installed.
  - The list is resent once per burst of changes: an install, a load, a pref
    or permission change, a new config, a loaded icon.
  - Manganese draws it as the tray's menu: see
    [TOP-BAR.md](/packages/shell-manganese/docs/TOP-BAR.md#tray).

SDK side: the `DomicileHost` types in `packages/chrome-sdk`, and the tray,
its menu and popup panel in `packages/manganese-bar-module-tray/src/`.

### Tabs

| Chrome | On a desk |
|---|---|
| Tab | A `WebViewGuest` with view type `kTabContents` |
| Window | One `DomicileWindowController : extensions::WindowController` in `WindowControllerList`. Its tabs are the live guests in creation order. |
| Active tab | The guest whose element last took focus. Extension pages (popup windows, action popups) never become the active tab. |

Patch 0056 attaches helpers to every tab guest on creation:

- `SessionTabHelper`: tab id, read by `declarativeNetRequest` `tabIds` and
  `webRequest`.
- `extensions::TabHelper`: `activeTab`, `scripting.executeScript`.
- `WebNavigationTabObserver`: `webNavigation` events and `getAllFrames`,
  which password managers such as 1Password fill through.
- `HistoryTabHelper` and the favicon driver: visits for `chrome.history`. See
  [HISTORY.md](/docs/HISTORY.md).

The browser gets no focus notification for an inner `WebContents`, so the
element reports it (`WebViewGuest.Focused`).

Chrome's lookups walk browser windows. Patches 0057 and 0154 add one hook
call to each of these, declared in
`chrome/browser/extensions/domicile_desk_hooks.h`:

| Lookup | Desk answer |
|---|---|
| `ExtensionTabUtil::GetTabById` | the guest, the desk's controller, its index |
| `ExtensionTabUtil::CreateTabObject` | its index and `active` |
| `ExtensionTabUtil::ForEachTab` | every guest too |
| `ChromeExtensionFunctionDetails::GetCurrentWindowController` | the last focused desk the extension may see, since the shell's own window is not a desk window (patch 0206) |
| `SendExecuteMimeTypeHandlerEvent` (patch 0154) | no tab id for a stream outside a guest, so the PDF viewer in the shell asks `chrome.tabs` nothing |

- `tabs.query` and the mutations below are the desk's own
  `ExtensionFunction`s. They replace Chrome's by name in
  `ExtensionFunctionRegistry::Register`.
- Tab events (`onCreated`, `onUpdated`, `onRemoved`, `onActivated`,
  `onZoomChange`) come from the guests' lifecycle. They are built as
  `TabsEventRouter` builds them and broadcast through the profile's
  `EventRouter`. `TabsEventRouter` itself can't be used: its dispatch is
  private and it `CHECK`s for a `TabInterface` that guests lack.

Mutations:

| Call | Handled by |
|---|---|
| `tabs.create({url})` | The browser opens a browser window (`domicile_browser_windows.h`). Resolves with the next new tab. |
| `tabs.update(id, {url})`, `{muted}` | The guest |
| `tabs.update(id, {active: true})`, `windows.update(id, {focused: true})` | The shell, as `domicile-focus-request` on that element |
| `tabs.remove(id)` | The browser closes that browser window. A shell's own `<webview src>` gets `domicile-close`. Resolves immediately. |
| `windows.get`, `getCurrent`, `getLastFocused`, `getAll` | The desk |
| `windows.create({type: "popup", url})` | A popup window (below) |
| `windows.remove(id)` | A popup window's tab, as `tabs.remove`. Refused for the desk window. |
| `tabs.setZoom`, `getZoom` | The guest: `WebViewGuest::ZoomTo`, per site via `HostZoomMap`, or per tab in its zoom mode. The element gets `domicile-zoom-change`. `0` is the default. Values outside Blink's browser range are refused, and so is any zoom in `disabled` mode. |
| `tabs.getZoomSettings`, `setZoomSettings` | The guest's zoom mode, kept by Chrome's `ZoomController` as for a Chrome tab. `manual` keeps the page at the default zoom and reports the factor; the PDF viewer zooms its own pages this way. Manual and per-tab modes end when the page navigates away. |
| `action.openPopup()` | The shell's tray (above) |
| `sidePanel.open()`, `sidePanel.close()` | A popup window showing the side panel (above) |
| `tabs.move`, `group`, `ungroup`, `discard`, `duplicate`, `createSplit`, `unsplit`; `tabs.update`'s `pinned`, `openerTabId`, `autoDiscardable`; `windows.update` bounds and state; any `windows.create` other than a `popup` with one `url` | Error: `not supported on a Domicile desk` |

### Popup windows

Bitwarden signs in with `windows.create({type: "popup", url, width, height})`
and closes it with `windows.remove`. A popup window is a second
`DomicileWindowController` of type `popup`, owned by the desk's controller
(`domicile_window_controller.{h,cc}`):

1. `windows.create` makes an empty window and fires `windows.onCreated`
   (`OpenPopup`).
2. The browser opens a browser window at `url` as the window's only tab
   (`WebViewGuest::RequestPopupWindow`, `BrowserWindowHost::OpenPopupWindow`,
   `AddToDesk`).
3. The shell gets it in `browserwindowschanged` with `popupWindow`, `width`
   and `height` (0 if unset), and draws it.
4. `windows.create` resolves with the populated window (`WhenNextTab`).
5. `windows.remove` or the page's `window.close()` closes that browser window.
   The window closes with its tab and fires `windows.onRemoved`
   (`DeskWindowsRemoveFunction`, `PopupEmptied`).

| Call | A popup window |
|---|---|
| `windows.getCurrent`, `tabs.query({currentWindow})` | Itself from its own page. The desk from a service worker. |
| `windows.getLastFocused`, `lastFocusedWindow` | Itself after its tab takes focus, until a desk tab does |
| `windows.getAll`, `tabs.query({windowType})` | Listed with the desk, filtered by type |
| `windows.update(id, {focused: true})` | `domicile-focus-request` on its element |

The desk window reports `left: 0, top: 0`. Bitwarden positions its popup
relative to the source window and passes `NaN` without them.

## Key decisions

- **Config over a store UI.** Home-manager writes the config, and the Store
  flow needs a browser window. The Settings app edits the config too.
- **Compositor sends the list; the launcher does not pass `--load-extension`.**
  The launcher never reads the config, Chromium disables the switch by default
  (`DisableLoadExtensionCommandLineSwitch`), it can't name a Web Store id, and
  it doesn't follow a reload.
- **Default profile.** Browser windows use it (see `web_view_guest.h`, *NO
  GUEST SiteInstance*), so content scripts and network rules see the pages the
  user browses.
  A `<webview partition>` page has a guest SiteInstance in its own
  StoragePartition. Content scripts still run in it, but an extension page
  opened there gets no extension APIs.
- **One window for all `<webview>`s.** Extensions expect many tabs and one
  active tab per window.
- **Refuse unsupported calls.** A no-op `tabs.move` that reports success is a
  bug the extension can't detect.
- **Popup windows are real windows.** They have their own id, so
  `windows.remove` closes them and `tabs.query({windowType: "popup"})` finds
  them. The engine owns the window and its page, and the shell draws it.
- **Only `popup` windows.** A `normal` window is a shell browser window, which
  `tabs.create` already requests. Size is passed through. Position is the
  shell's choice, as under Wayland in Chrome.
- **Passkeys come from extensions.** The browser draws no WebAuthn UI (patch
  0048), so a password manager extension provides passkeys, by wrapping
  `navigator.credentials` in a content script or via
  `chrome.webAuthenticationProxy`. For conditional `get()` the browser reports
  conditional UI as available and holds the request until the site aborts it
  (patch 0084). Bitwarden races its own answer against the browser's, so a
  browser refusal left it answering a page that had stopped listening.
  `guard-webview-passkey-extension.sh` checks that an extension answers a
  page's WebAuthn request in a `<webview>`, by content script and by
  `webAuthenticationProxy`.
- **Manifest V3 only.** Chromium at the pin no longer loads MV2. uBlock Origin
  Lite works; uBlock Origin does not.

## Not in scope

- `chrome.contextMenus`: the shell draws the context menu, and
  `domicile-context-menu` carries no extension items.
- `chrome.commands`: shortcuts belong to the shell. Use `grabShortcut` if
  needed.
- Install, permission and "extension added" bubbles (see Installing).

## Tests

Engine guards in `packages/domicile-engine/scripts/`:

- `guard-extension-installer.sh`
- `guard-extension-in-private.sh`
- `guard-extension-tray.sh`
- `guard-extension-open-popup.sh`
- `guard-extension-side-panel.sh`
- `guard-webview-content-script.sh`
- `guard-webview-tabs.sh`
- `guard-webview-active-tab.sh`
- `guard-webview-popup-window.sh`
- `guard-webview-passkey-extension.sh`
