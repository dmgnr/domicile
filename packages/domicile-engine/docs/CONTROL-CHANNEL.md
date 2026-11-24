# Control channel and command socket

The engine has two channels to the rest of Domicile:

- **Control channel** (`DomicileHost`): the shell page and the compositor.
- **Command socket** (`--domicile-command-socket`): the supervisor and the
  engine.

## Control channel

- `DomicileHost` is the shell's API. No page script can find it:
  `DomicileShell` runs the module the shell document names, builds the
  SDK's `Domicile` over the host with the bundled layer (`domicile_layer.js`)
  and passes it into `Shell(root, domicile)`. There is no
  `navigator.domicile` or `window.domicile`. A guard exports `HostShell` to
  be handed the host itself ([GUARDS.md](GUARDS.md)).
- The browser process speaks the wire protocol (JSON lines to the
  compositor). The page sees typed WebIDL values, so it cannot send a
  malformed message.
- Cost: adding a message is an engine change, and so needs an engine release.

### Members

- **Outbound:** `spawn`, `search_files`, `call_system`,
  `answer_portal_request`, `copy_clipboard_entry`, `remove_clipboard_entry`,
  `activate_tray_item`, `dismiss_notifications`, `invoke_notification_action`,
  `reply_to_notification`, `focus_app`,
  `focus_chrome`, `sync_frames`, `close_app`, `set_app_bounds`, `set_desktop_size`,
  `set_device_pixel_ratio`, `set_theme`, `theme_captured`, `unlock`, `lock`,
  `key`, `pointer_motion`, `pointer_leave`, `pointer_button`, `pointer_axis`,
  `pointer_pinch`, `touch`.
  The browser also sends `hello` on connect, with `checked` saying whether
  it is a checked build (DCHECKs on), `activity` for its own
  input, at most every 200 ms, for the idle clock, `desk_pointer` for
  each pointer move, `desk_cursor` for each change of the pointer's
  image, for screen casts, and `pointer_swipe` and `pointer_hold` for each
  touchpad swipe or hold the shell did not grab, and `engine_fault` for a
  bug the engine caught in itself (`DeskFaults`), which the compositor logs
  as an error and shows as an urgent notification with a "Report it"
  button.
- **Inbound:** `welcome`, `app_appeared`, `app_titled`, `app_desktop_id`,
  `app_resized`, `app_min_size`, `app_max_size`, `popup_placed`, `app_closed`,
  `app_cursor`, `app_presented`, `app_suspended`, `app_transient_for`,
  `app_urgent`, `app_inhibits_shortcuts`, `browser_toplevel_ids`, `modifiers`,
  `found_files`,
  `clipboard`, `theme`,
  `windows_theme`, `appearance`, `focus_changed`, `focus_requested`,
  `displays`, `keymap`, `extensions`, `force_dark`, `spellcheck`, `tray`, `notifications`, `shell_config`,
  `idle`, `locked`, `system`, `portal_requests`.
- **Handled in the browser, never sent to the compositor:** `grab_shortcut`,
  `ungrab_shortcut`, `warp_pointer`, `confine_pointer`, and
  `ShellRan`/`ShellFailed`, which
  `DomicileShell` sends once the shell's module ran or did not, for
  `load_shell` (below).
- **Not from the compositor:** `browserwindowschanged`, the desk's browser
  windows, which the browser owns
  (`components/domicile/mojom/browser_windows.mojom`),
  `castsinkschanged`, the TVs the browser's Media Router finds
  (`components/domicile/mojom/cast_sinks.mojom`), `downloadschanged`, the
  desk's downloads (`components/domicile/mojom/downloads.mojom`), and
  `compositorreplaced` (below).

### Members with special handling

- **`pointer_pinch`** comes from `<app>` default input handling. It carries
  begin, update and end with the native device, unsigned millisecond clock,
  finger count, absolute scale, relative rotation and cancellation. The shell
  claims the default action by canceling the `wheel` event; it needs no routing
  method or generated SDK member for native-client forwarding.
- **`touch`** comes from `<app>` default input handling of touch pointer
  events. It carries `down` and `motion` with the point's `id` and its `x`
  and `y` in the client's coordinates, `up` with the `id`, and `cancel`,
  which ends every point on that window. `time` is the event's unsigned
  millisecond clock.
- **`call_system`** and **`system`** carry the shell's system calls. The
  browser wraps the page's request as a `system_request` line and relays
  `system_reply`, `system_event` and `system_end` lines whole, as a
  `MessageEvent`. It reads nothing else of them; the compositor checks each
  call. See `components/domicile/browser/system_call.h` and
  [SHELL-SYSTEM-ACCESS.md](/docs/SHELL-SYSTEM-ACCESS.md).
- **`portal_requests`** and **`answer_portal_request`** carry portal dialogs.
  See [PORTALS.md](/docs/PORTALS.md).
  - The browser relays `portal_requests` whole, as a `portalrequests`
    `MessageEvent`, and reads nothing but `type`.
  - The renderer keeps the latest line and sends it again to a listener added
    later, so a shell that listens late sees pending dialogs.
  - The browser wraps the page's answer, which must be a JSON object with a
    string `kind`, as an `answer_portal_request` line. See
    `components/domicile/browser/portal_request.h`.
- **`tray`**: each item carries the `bus` it answers on and its dbusmenu
  `menu` path, so a shell drives the menu with `call_system`. See
  [SYSTEM-TRAY.md](/docs/architecture/SYSTEM-TRAY.md).
- **`shell_config`** stops in the renderer. `DomicileHost` reads its keys to
  resolve the chords `grabShortcut` is given by name; they do not reach the
  page. Its `options`, the config's `shell_options` as JSON text, become
  `shellOptions`, with a `shelloptionschanged` event when they change.
- **`keymap`** stops in the browser process. It is the xkb keymap the
  compositor compiled from `input.keyboard`, and it feeds Chromium's
  `KeyboardLayoutEngine`. Without it, off ChromeOS, every printable key decodes
  to `DomKey::UNIDENTIFIED`. See `components/domicile/browser/keyboard_layout.h`.
- **`appearance`**'s `cursor` stops in the browser process. It is the
  desk's XCursor theme and size, which the DRM platform draws the pointer
  from. See `ui/base/cursor/domicile/desk_cursor_theme.h` and
  `ui/ozone/platform/drm/domicile/drm_cursor_factory.h`.
- **`appearance`**'s `cursor_hiding` stops in the browser process. It is
  when the desk hides the pointer: after `after_ms` without pointer input, and
  on typing if `when_typing`. See `components/domicile/browser/pointer_hiding.h`.
- **`extensions`** stops in the browser process. It is the desk's
  `[extensions]` list, installed into the profile by
  `chrome/browser/domicile/domicile_extension_installer.h`, with each
  extension's `settings` (`domicile_extension_settings.h`). See
  [EXTENSIONS.md](/docs/architecture/EXTENSIONS.md).
- **`force_dark`** stops in the browser process. It is the desk's
  `theme.force_dark`: hosts whose pages Chromium's auto dark mode draws dark
  while the theme is dark. See `components/domicile/browser/force_dark.h`.
- **`spellcheck`** stops in the browser process. It is the desk's
  `spellcheck`: whether pages check spelling, and in which languages. Every
  profile takes it (`chrome/browser/domicile/domicile_spellcheck.h`). The
  dictionaries ship in the engine's `dictionaries/` folder and are never
  downloaded (patch 0246).
- **`grab_shortcut`**: the browser holds the grabbed set and matches it in
  `WebViewGuest::PreHandleKeyboardEvent`. The compositor cannot do this: keys
  typed into a `<webview>` guest never reach it. A match comes back as a
  `shortcut` event. A guest's release of a grabbed key or a modifier comes
  back as `ShortcutReleased`, which the page pairs with the press as
  `shortcutrelease`. Chromium drops key-ups after a key-down the delegate
  took, so patch `0100` prehandles every key-up. See `components/domicile/browser/shortcut_registry.h`.
- **`ungrab_shortcut`**: the page's `ungrabShortcut` answers one
  `grabShortcut` by name; the last one sends it. Claims are per page, and a
  closed page's are dropped when an open page lets go of the chord.
- **`app_inhibits_shortcuts`**: a window holds a
  `zwp_keyboard_shortcuts_inhibitor_v1`. It sets
  `DomicileWindow.inhibitsShortcuts`, and while that window has the keyboard
  the page's grabbed chords are its keys. See
  [KEYBINDINGS.md](/docs/architecture/KEYBINDINGS.md).
- **`warp_pointer`**: the browser owns the pointer (a DRM cursor plane on a
  tty, the host's pointer when nested), so the compositor cannot move it.
  - Use: focus-follows-mouse desktops. After a keyboard focus change, the
    shell moves the pointer onto the newly focused window.
  - A page may move the pointer only within its own box. Coordinates outside
    are clamped.
  - `unless_over`, a box in the page's coordinates, skips the warp while the
    pointer is over it, by `DeskPointer`'s position. The page cannot see the
    pointer over a browser window's page.
  - Logic and tests: `components/domicile/browser/pointer_warp.h`. Execution:
    `chrome/browser/domicile/domicile_pointer_warp.cc`.
  - The move that lands a warp reaches no client as relative motion: nobody
    moved the mouse. See `components/domicile/common/warp_landing.h`.
- **`confine_pointer`**: holds the pointer inside boxes in the page's
  coordinates, for a game or VM viewer whose `zwp_pointer_constraints_v1`
  confinement the shell took. An empty list lets go, as does the page going
  away.
  - Boxes are clipped to the page's own box. Only the DRM cursor is held,
    through `OzonePlatform::SetDomicilePointerConfinement`; nested or
    headless it answers false.
  - The DRM cursor clamps each mouse and tablet move in the confining
    window's pixels, so a box across a seam holds on both monitors. Warps
    are not held.
  - Logic and tests: `components/domicile/browser/pointer_warp.h` and
    `ui/ozone/platform/drm/domicile/drm_pointer_confinement.h`. Execution:
    `chrome/browser/domicile/domicile_pointer_confinement.cc`.
- **`app_pointer_constraint`** carries the window's `region` beside its
  `constraint`: rectangles in the window's surface coordinates, `null` for the
  whole window, read as `DomicileWindow.pointerRegion`.
- **`pointer_relative`** carries `dx`/`dy`, the page's `movementX/Y`, and
  `dx_unaccel`/`dy_unaccel`, the device's own motion before acceleration.
  On a console libinput reports it and it rides the `PointerEvent` from the
  mouse to the `<app>` (`ui/events/domicile/unaccelerated_motion.h`). A
  device that reports none sends the accelerated motion for both.
- **A compositor that hangs up** is replaced, not fatal. The browser:
  - answers each of the page's open system calls with a failed
    `system_reply` or `system_end` of kind `compositor_gone`, and closes each
    window the old compositor had with `app_closed`;
  - drops queued `system_request` lines and keeps the page's other lines for
    the next compositor;
  - dials again for `kReachFor`, sends `hello`, then fires
    `compositorreplaced`.
  The SDK's watches listen again on `compositor_gone`. See
  [ENGINE-FORK.md](/docs/architecture/ENGINE-FORK.md#a-compositor-restart).
- **`activity`** is the browser's, not the page's. `StartDeskActivity`
  (`chrome/browser/domicile/domicile_desk_activity.h`) watches
  `ui::UserActivityDetector`, and every control channel sends it while a
  compositor is connected. See `components/domicile/browser/desk_activity.h`.
- **`desk_pointer`** is the browser's too. `StartDeskPointer`
  (`chrome/browser/domicile/domicile_desk_pointer.h`) watches aura's mouse
  moves and drags, and sends `at`, in the shell page's CSS pixels, or no `at`
  while there is no shell. With it go `windows`, each browser window whose
  page is under the pointer, as `id` and `at`, a fraction of that page, for
  browser window casts. A repeat of the last place is dropped. See
  `components/domicile/browser/desk_pointer.h`.
- **`desk_cursor`** is the browser's too: the pointer the DRM platform puts
  on screen (`DrmCursor`, patches 0138 and 0163), stood upright for its
  panel, through `ui/base/cursor/domicile/desk_cursor_image.h`. `image` has `size` and
  `hotspot` in pixels, `scale` in pixels a logical pixel, and `bgra`, the
  first frame as premultiplied BGRA in base64. No `image` while the pointer
  is hidden. Sent after `hello` too, once the platform has set one.
- **`displays`** is an attribute, `domicile.displays`, with a
  `displayschanged` event. A component that mounts late can read it.
  - `null`: the compositor has not described a desktop yet.
  - `[]`: the desktop has no screens.

### Outside the control channel

- **App modules:** an app's `DomicileAppHost` uses
  `components/domicile/mojom/app_channel.mojom`. The browser opens its own
  connection to the compositor, says `app_hello`, and carries `call_system`
  and the `system` event only. It binds for an app's origin in the window
  pinned to that app. A compositor that hangs up ends its calls and is
  dialed again, as above, with no `compositorreplaced`. See
  [APP-MODULES.md](/docs/architecture/APP-MODULES.md).
- **Extension tray:** the `extensions` event and `activateExtension()` use
  `components/domicile/mojom/extension_tray.mojom`, a separate browser-side
  pipe. Action state is the browser's own; the compositor never sees it. See
  `chrome/browser/domicile/domicile_extension_tray.h`.
- **Fetches with the profile's cookies:** `fetchWithCookies()` uses
  `components/domicile/mojom/shell_fetch.mojom`, a browser-side pipe bound
  only for the shell's origin (patch 0119). The browser sends a GET or a POST
  from the shell profile's default storage partition, and computes
  `SAPISIDHASH` from the SAPISID cookie itself. A GET has no initiator; a POST
  is a same-origin CORS request from its address's own origin, so it gets
  that `Origin` and `Sec-Fetch-Site: same-origin`.
  - Refusals, redirects and the hash:
    `components/domicile/browser/shell_fetch.h`, unit tested.
  - The request: `chrome/browser/domicile/domicile_shell_fetch.h`.
  - Shell side: [SHELL-SYSTEM-ACCESS.md](/docs/SHELL-SYSTEM-ACCESS.md#the-browsers-cookies).
- **Tabs:** to `chrome.tabs` and `chrome.windows`, every `<webview>` is a tab
  and the desk is one window. See `chrome/browser/domicile/domicile_desk.h`.
  Patch 0057 routes Chrome's tab lookups to `DomicileDesk`. Fork versions of
  some `chrome.tabs`/`chrome.windows` functions replace Chrome's.

### Typed values

- **Sizes are `double`.** The compositor sends `f64`, so `800.0` arrives with
  a decimal point. Reading it as an integer gives zero.
- **Modifiers** are `altKey`, `ctrlKey`, `shiftKey`, `metaKey`. The compositor
  has already resolved xkb's masks against the keymap.
- **Shortcuts** are grabbed by chord name, `grabShortcut("Meta+Shift+l")`. A
  `shortcut` event carries the `chord`, `keycode`, `altKey`, `ctrlKey`,
  `shiftKey` and `metaKey`. `keycode` is an evdev code.

### Adding a message

1. Add it to the mojom, the IDL, the browser-side serializer and the Blink
   method. A message that stops in the browser process skips the Blink side.
2. Add it to [Members](#members).
3. For a new event type, add a line to `domicile_event_names.h` in
   `src/third_party/blink/renderer/modules/domicile/`, beside its `on<name>` in
   the IDL.
   - Do not use Blink's `event_type_names.json5`. Most of Blink includes its
     header, so a change there recompiles most of Blink.
   - `packages/domicile-engine/tests/test-engine-event-names.sh` checks that this list, the IDL and
     the events `guard-windows-state` fires agree.
4. Run `bun run generate` in `packages/chrome-sdk` to regenerate the SDK's
   `domicile-host.ts` from the IDL. An event dispatched as anything but a
   plain `Event` also needs its type in `EVENT_TYPES` in
   `codegen/generate-domicile-host.ts`, since `EventHandler` does not say.
   `packages/domicile-engine/tests/test-host-types-match-the-idl.sh` fails until the file is current.

## Command socket

`--domicile-command-socket <path>` makes the engine bind a Unix stream socket.
The supervisor connects, sends one JSON line, reads one reply, and closes.

```
{"type":"load_shell","version":1,"root":"/x/dist","module":"shell.js"}
{"type":"loaded"}   |   {"type":"refused","why":"…"}

{"type":"run_app","version":1,"root":"/opt/notes","module":"notes.js"}
{"type":"opened"}   |   {"type":"refused","why":"…"}

{"type":"open_url","version":1,"url":"https://example.com/"}
{"type":"open_url","version":1,"url":"https://example.com/","app":true}
{"type":"opened"}   |   {"type":"refused","why":"…"}

{"type":"site_permissions","version":1}
{"type":"site_permissions","defaults":{"camera":"ask",…},"sites":[{"origin":"https://meet.example","permission":"camera","setting":"allow"}]}

{"type":"set_site_permission","version":1,"origin":"https://meet.example","permission":"camera","setting":"block"}
{"type":"set"}   |   {"type":"refused","why":"…"}

{"type":"load_unpacked","version":1,"directory":"/home/me/src/my-extension"}
{"type":"loaded_unpacked","id":"…"}   |   {"type":"refused","why":"…"}

{"type":"uninstall_extension","version":1,"id":"…"}
{"type":"uninstalled"}   |   {"type":"refused","why":"…"}

{"type":"config_extensions","version":1}
{"type":"config_extensions","ids":["…"]}

{"type":"extensions","version":1}
{"type":"extensions","extensions":[{"id":"…","name":"…","description":"…","version":"1.0","enabled":true,"options_url":"chrome-extension://…/options.html","settings":{"private":false,"site_access":"all_sites"},"icon_path":"/home/…/icons/128.png"}]}

{"type":"set_extension_enabled","version":1,"id":"…","enabled":false}
{"type":"set_extension_enabled","version":1,"id":"…","enabled":true,"profile":"work"}
{"type":"set"}   |   {"type":"refused","why":"…"}

{"type":"browser_profiles","version":1}
{"type":"browser_profiles","default_profile":"personal","default_private_profile":"private","profiles":[{"id":"work","name":"Work","color":"#d97706","private":false,"extensions":[{"id":"…","enabled":true,"locked":true}]}],"sites":[{"site":"github.com/acme","profile":"work","pinned":true}]}

{"type":"pin_browser_site","version":1,"site":"github.com/acme","profile":"work"}
{"type":"set"}   |   {"type":"refused","why":"…"}

{"type":"configure_extension","version":1,"id":"…","settings":{"private":true,"site_access":["github.com"]}}
{"type":"set"}   |   {"type":"refused","why":"…"}

{"type":"media_devices","version":1}
{"type":"media_devices","cameras":[{"id":"/dev/video2","name":"USB Camera"}],"microphones":[…]}

{"type":"set_media_device","version":1,"kind":"camera","id":"/dev/video2"}
{"type":"set"}   |   {"type":"refused","why":"…"}

{"type":"history","version":1,"text":"news","end_time":1700000000000.5,"max_results":100}
{"type":"history","items":[{"url":"https://news.example/","title":"News","favicon":"data:image/png;base64,…"}]}

{"type":"visits","version":1,"url":"https://news.example/"}
{"type":"visits","times":[1700000000000.5,…]}

{"type":"delete_history","version":1,"visits":[1700000000000.5,…]}
{"type":"deleted"}   |   {"type":"refused","why":"…"}

{"type":"clear_browsing_data","version":1,"since":1700000000000,"types":["cookies","localStorage"],"origins":["https://a.example"]}
{"type":"cleared"}   |   {"type":"refused","why":"…"}

{"type":"site_data","version":1}
{"type":"site_data","sites":[{"host":"mail.example","bytes":20480.0,"cookies":3}]}   |   {"type":"refused","why":"…"}

{"type":"clear_site_data","version":1,"host":"mail.example"}
{"type":"cleared"}   |   {"type":"refused","why":"…"}

{"type":"disable_while_typing","version":1,"enabled":false}
{"type":"disable_while_typing","enabled":false}   |   {"type":"refused","why":"…"}

{"type":"set_log_levels","version":1,"min_level":0,"vmodule":"*/domicile/*=2"}
{"type":"set"}   |   {"type":"refused","why":"…"}

{"type":"devtools","version":1,"window":"3","method":"DOM.getContentQuads","params":{"backendNodeId":42}}
{"type":"devtools","result":{"quads":[[10,20,110,20,110,40,10,40]]}}   |   {"type":"refused","why":"…"}
```

- Without the switch, the engine binds nothing. Every desktop `domicile`
  starts passes one under the run's directory.
- `load_shell`, `run_app` and `open_url` that arrive while the shell window's
  first page is loading wait up to 3 seconds for it to commit, then refuse.
  With no shell window at all, they refuse at once. The 3 seconds is under the
  supervisor's 5-second wait for a reply. The supervisor asks again on
  `load_shell`'s refusal, "this engine has no shell window to load a shell
  into".
- `load_shell` answers once the new shell's page says whether its module ran,
  or after 5 seconds of silence, taken as loaded. A shell that did not run is
  refused with the page's reason, and the engine serves and loads the shell
  it replaced again. The same shell loaded again, as a module rebuilt in
  place, has nothing to go back to and stays on its error screen. See
  `components/domicile/browser/shell_swap.h`.
- `domicile load-shell <path>` sends `load_shell`. `domicile open <url>`
  sends `open_url`, and `domicile open --app <url>` sends it with `"app":true`.
  `domicile screenshot <file>` goes to the compositor.
- `run_app` serves the app module `module` under `root` at
  `domicile://app-<id>/` and opens an app window pinned to it
  ([APP-MODULES.md](/docs/architecture/APP-MODULES.md)). `root` must be
  absolute.
- `open_url` opens a browser window at the address, as a page's
  `target="_blank"` does. The shell gets it in `browserwindowschanged`, so a
  shell mid-reload gets it with every other window. An unparsable URL, a
  non-boolean `app`, or a desk with no shell to own the window, is refused.
- `"app":true` opens an app window, listed with `isApp`
  ([WEB-APPS.md](/docs/architecture/WEB-APPS.md)). An engine without it
  ignores the key and opens a browser window.
- `site_permissions` and `set_site_permission` are the Settings app's, relayed
  by `domicile` ([SETTINGS.md](/docs/SETTINGS.md)). They list and store the
  shell profile's content settings for each of `kSitePermissions`, as the
  address bar's panel does: user settings for one origin. Setting a
  permission's default removes the site's own.
- `load_unpacked`, `uninstall_extension` and `config_extensions` are the
  Settings app's too ([EXTENSIONS.md](/docs/architecture/EXTENSIONS.md#from-the-settings-app)).
  `load_unpacked` replies once the extension has loaded, or with why it did
  not.
- `extensions` and `set_extension_enabled` are the Settings app's too, in
  place of `chrome.management`
  ([APP-MODULES.md](/docs/architecture/APP-MODULES.md#domiciles-own-state)).
  `extensions` lists the shell profile's extensions, without apps, themes or
  Chrome's components; `options_url` is left out when there is no options
  page. `icon_path` is the file of its manifest icon closest to 128px, left
  out when the manifest names none: a path, so listing reads no files, which
  `domicile-app-host` turns into the image Settings draws. `settings` has each setting the extension can use, spelled as the
  config's `extensions.settings`; `configure_extension` changes the ones it
  names, and refuses one the extension cannot use
  ([EXTENSIONS.md](/docs/architecture/EXTENSIONS.md#settings)).
- `browser_profiles`, `pin_browser_site` and `set_extension_enabled` with a
  `profile` are the Settings app's Profiles page
  ([BROWSER-PROFILES.md](/docs/architecture/BROWSER-PROFILES.md)), as the
  shell's `browserProfiles`, `pinBrowserSite` and
  `setBrowserProfileExtensionEnabled`. Without a `profile`,
  `set_extension_enabled` switches the shell profile's extension. A profile's
  `extensions` is empty while it loads; `locked` is a switch the config's
  `extensions` list sets. A site is `pinned` when the user pinned it, and the
  config's otherwise. Pinning a site to the default profile unpins it; a site
  the config lists is refused.
- `media_devices` and `set_media_device` are the Settings app's too. They list
  each kind's devices in the order of Chrome's device ranking in the shell
  profile's prefs, and move one to the top. A site that names no device gets
  the top one. Patch 0109 lets `//chrome/browser/domicile` use
  `//chrome/browser/media/prefs`.
- `history`, `visits`, `delete_history` and `clear_browsing_data` are the
  History app's, in place of `chrome.history` and `chrome.browsingData`
  ([APP-MODULES.md](/docs/architecture/APP-MODULES.md#domiciles-own-state)).
  Each replies once the shell profile's history service or browsing data
  remover is done.
  - Times are milliseconds since the Unix epoch, fractional to the
    microsecond, as `chrome.history` gives them. The engine rounds each to the
    nearest microsecond.
  - `history` is `chrome.history.search` from the start of time: each page
    once, most recently visited first, at most `max_results` (at least 1),
    visited before `end_time`, matching `text` (empty for every page).
    `favicon` is the page's cached favicon (or its site's) as a PNG `data:`
    URL, about 32 pixels, since an app page cannot load `chrome://favicon2`.
    It is left out when there is none.
  - `visits` lists every visit to `url`, as `chrome.history.getVisits` does;
    a page never visited has none.
  - `delete_history` removes the visits at exactly those times, as their user
    would.
  - `clear_browsing_data` is `chrome.browsingData.remove`: data changed since
    `since` (0 for all time) of each of `types`, named as `DataTypeSet` names
    them. `origins`, when present, limits it to those sites, and then only
    types kept per site may be named, not `downloads`, `formData`, `history`
    or `passwords`. A site's cookies are those of its registrable domain.
    `webSQL` clears nothing: Chromium no longer has it. An unknown type is
    refused.
- `site_data` and `clear_site_data` are the Settings app's
  ([SETTINGS.md](/docs/SETTINGS.md)). Both build Chrome's `BrowsingDataModel`
  for the shell profile, as `chrome://settings/content/all` does.
  - `site_data` lists each web host that stores data: its cookies, and the
    bytes on disk of every kind summed. Extensions' and Domicile's own pages'
    data is left out.
  - `clear_site_data` removes everything one host stores, and replies once
    it is gone.
- `set_log_levels` is `domicile set-log-level`: Chromium's minimum severity
  (0 `INFO` to 3 `FATAL`) and `--vmodule`, in every engine process and those
  started later, until the engine exits. The supervisor makes them from the
  levels it was asked for ([Logs](/docs/LOGGING.md)).
- `disable_while_typing` is `domicile disable-while-typing`
  ([RUNNING-A-DESKTOP.md](/docs/RUNNING-A-DESKTOP.md#disable-while-typing)).
  It sets whether the touchpads rest while a keyboard types when `enabled` is
  given, and replies with whether they do. Off a tty it is refused: the host
  compositor reads the touchpad.
- `devtools` is `domicile devtools`
  ([CLI.md](/docs/CLI.md#domicile-devtools-window-method-params)), which
  `domicile mcp` drives browser windows with. `window` is the engine's id for
  a browser window, or `shell` for the shell's page, which refuses
  `Page.navigate`, `navigateToHistoryEntry` and `reload`. It attaches a DevTools client of its own for the one
  method and detaches once answered, so DevTools the user has open keeps
  working. Only `kDevToolsMethods` in `command_protocol.h` go through, and
  `Page.navigate` only to http and https; a private window is refused, and so
  is a page that does not answer within 10 seconds.
- It is its own socket because the compositor has no part in choosing the
  shell. The supervisor also passes it at
  launch as `--domicile-shell-root` and `--domicile-shell-module`. See
  [THE-DOMICILE-BINARY.md](/docs/architecture/THE-DOMICILE-BINARY.md).
- It carries a version because the supervisor and the engine are published
  separately, so the two ends can come from different revisions. See
  [DATA.md](/docs/guidelines/DATA.md).

| File (under `src/`) | Role |
|---|---|
| `components/domicile/browser/command_protocol.{h,cc}` | parses a line and returns a reply; unit tested |
| `chrome/browser/domicile/domicile_command_socket.{h,cc}` | the socket and the shell's window; in `//chrome` because reloading needs `GlobalBrowserCollection` |
| `components/domicile/browser/shell_source.{h,cc}` | the shell being served; set from the two switches, replaced by `load_shell` |
| `components/domicile/browser/shell_swap.{h,cc}` | waits for the new shell to run, and puts the old one back if it does not; unit tested |
| `components/domicile/browser/shell_window_wait.{h,cc}` | holds `load_shell`, `run_app` and `open_url` until the shell window's first page commits; unit tested |
| `chrome/browser/domicile/domicile_browser_windows.{h,cc}` | the desk's browser windows; `open_url` opens one |
| `chrome/browser/domicile/domicile_cast_sinks.{h,cc}` | the TVs to cast the desktop to, and the casts; see `docs/CASTING-TO-TVS.md` |
| `components/domicile/browser/site_permissions.{h,cc}` | permission and setting names; unit tested |
| `chrome/browser/domicile/domicile_extension_installer.{h,cc}` | loads, uninstalls and lists extensions for the extension commands |
| `chrome/browser/domicile/domicile_history.{h,cc}` | the History app's commands, on the profile's history service, favicon service and browsing data remover |

### Dev reload

- The shell has no reload key (patch 0047).
- Reload a rebuilt shell with `domicile load-shell <path>`. Run it from a
  watch script for live reload.
- `packages/dev-shell/tests/test-dev-shell.sh` checks the served page has no reload poller.
