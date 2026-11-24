# System access for shells

A shell reaches the system through three primitives: files, processes and a
D-Bus client. Desktop features (battery, audio, network, apps) are TypeScript
libraries on them, so a shell adds a feature without a change to Domicile.

```
shell page ─ domicile.files, … ────▶ engine (opaque relay) ─────▶ compositor
                                                                  ├─ files
                                                                  ├─ processes
                                                                  └─ D-Bus (session, system)
```

## Page API

<!-- tab: React -->

```tsx
const Battery = () => {
  const { files } = useDomicile();
  const [charge, setCharge] = useState<string>();
  useEffect(() => {
    files
      .readText("/sys/class/power_supply/BAT0/capacity")
      .then((read) => setCharge(read.unwrapOr(undefined)));
  }, [files]);
  return <span>{charge}%</span>;
};
```

<!-- tab: JavaScript -->

```js
export const Shell = async (root, domicile) => {
  const charge = await domicile.files.readText(
    "/sys/class/power_supply/BAT0/capacity",
  );
  const changes = await domicile.processes.spawn(["pactl", "subscribe"]);
};
```

<!-- /tabs -->

- Each call resolves a `Result<T, SystemError>`. A process's output and a
  watch's changes are `ReadableStream`s. The SDK's types are the reference.
- `dbus.call()` and `dbus.match()` reach the session and system buses. A body is
  JSON read against its D-Bus signature; `domicile_host::dbus_json` documents
  the mapping.
- `capture.screenshot()` takes an interactive Screenshot portal screenshot as if the
  shell were the app: `<PortalDialogs />` draws the dialog, and the call
  resolves with `ScreenshotKept.Saved(path)`, `ScreenshotKept.Copied()` when
  the user pressed Ctrl+C, or fails `canceled`.
- `capture.screenRecord()` records the screen: `<PortalDialogs />` draws the
  screen cast picker, then a toolbar until the user stops the recording.
  Resolves with the WebM's path, or fails `canceled` when the picker is
  dismissed or the recording discarded. See
  [PORTALS.md](PORTALS.md#screen-recording).
- `capture.preview()` draws a window as it last drew itself, or a browser
  window's page, as a PNG `data:` URL. The pickers preview a window that is
  not on screen with it.
- `windows.setStates()` and `windows.requests()` set a window's tiled,
  maximized and fullscreen states and hear clients ask for them; see
  [WRITING-A-SHELL.md](WRITING-A-SHELL.md#window-states).
- `windows.bells()` hears clients ring the bell; see
  [WRITING-A-SHELL.md](WRITING-A-SHELL.md#bells).
- `displays.addVirtual()` adds a monitor with no connector, which the desk
  extends onto, until `remove()` or the page goes away. Casting to a TV uses
  it; see [CASTING-TO-TVS.md](CASTING-TO-TVS.md). Manganese's
  `virtual-monitor add` command adds one from a key or a terminal.
- `displays.sleep()` turns every monitor off until input or
  `displays.wake()`, or one by name until it is woken; see
  [IDLE.md](IDLE.md#sleeping-on-demand).
- `keyboard.keymaps()` streams the config's keymaps and the active one;
  `keyboard.selectKeymap()` switches to another
  ([SHELL-CONFIG.md](SHELL-CONFIG.md#keyboard)).
- `shell.commands(help, bindings)` streams each command `domicile
  send-shell` sends, numbered, and describes the commands the page runs and
  the keys that run them; `shell.answer(sent, ran)` says whether it ran one,
  with any output `send-shell` prints. `bindKeys` does both for you; see
  [KEYBINDINGS.md](architecture/KEYBINDINGS.md#commands-from-a-terminal).
- `session.unlockRefusals()` streams why each passphrase did not unlock the desktop
  ([SHELL-IDLE-AND-LOCK.md](SHELL-IDLE-AND-LOCK.md#drawing-the-lock-screen)).
- Spawned programs are found on the compositor's `PATH`. The distribution
  packages recommend `pactl`, `parec` and `curl`; the Nix package appends
  them to `PATH`, so a user's own copies win.
- A reload starts every library from nothing: each reads its state again, so a
  readout is empty until its first reply.
- A compositor restart keeps the page. A call it had open fails
  `compositor_gone`, except a watch, D-Bus match or other stream: the SDK
  sends it again for the next compositor. Changes in between are not heard: a
  watch's or match's `items` stream `Listened.Missed()` once the next
  compositor starts it, and a reader reads again. `system-battery`,
  `system-bluetooth`, `system-network`, the tray menu and the icon theme do.
  `system-backlight` starts `udevadm` again and reads; `system-audio`
  resubscribes.
  See [ENGINE-FORK.md](architecture/ENGINE-FORK.md#a-compositor-restart).

## The browser's cookies

`browser.fetch(url, { method, headers, body, sapisidHashOrigin })` sends a
GET or a POST to an https address from the engine's browser process with the
cookies of the profile the ordinary browser windows use. A bar item reads a site the user signed in to
in a browser window, with no sign-in of its own.

```ts
const inbox = await domicile.browser.fetch(
  "https://mail.google.com/mail/?authuser=me%40gmail.com",
);
// { status: 200, url: "https://mail.google.com/mail/u/0/", body: "<!doctype…" }
```

- Resolves with `status`, the final `url` after redirects, and the `body` as
  text, whatever the status. Rejects with a `NetworkError` for a network
  failure, a refusal, or an answer over 8 MiB.
- `method` is `"GET"` (the default) or `"POST"`. A GET sends no body, and comes from no
  origin (`Sec-Fetch-Site: none`). A POST sends `body` with the page's
  `Content-Type`, as a same-origin CORS request from the address's own
  origin: that `Origin`, `Sec-Fetch-Site: same-origin`, `Sec-Fetch-Mode:
  cors`.
- Refused: an address that is not https, another method, a GET with a body,
  a `Cookie` or `Origin` header, a header the network stack sets itself (`Host`, `Content-Length`, …), and every request
  while the desk is locked, or that it locked during.
- A GET follows redirects on https only, and one to another origin drops
  the page's headers. A POST follows none.
- `sapisidHashOrigin`, such as `"https://mail.google.com"`, adds the
  `Authorization: SAPISIDHASH …` header Google's first-party APIs take. The
  engine computes it from the SAPISID cookie the request carries, so the
  cookie never reaches the page. A hashed request follows no redirect.
- Only the shell's `domicile` has it; app modules do not.
- Engine side:
  [CONTROL-CHANNEL.md](../packages/domicile-engine/docs/CONTROL-CHANNEL.md#outside-the-control-channel).

## Libraries

| Package | Source |
|---|---|
| `@domicile-desktop/system-battery` | UPower over D-Bus |
| `@domicile-desktop/system-backlight` | sysfs, `udevadm monitor`, logind `SetBrightness`; iio-sensor-proxy's ambient light over D-Bus |
| `@domicile-desktop/system-audio` | `pactl` and `parec` |
| `@domicile-desktop/system-network` | NetworkManager, iwd or wpa_supplicant over D-Bus; `iwctl` to join a new network on iwd |
| `@domicile-desktop/system-bluetooth` | BlueZ over D-Bus |
| `@domicile-desktop/system-apps` | desktop entries, icons and bookmarks |
| `@domicile-desktop/sdk/file-preview` | a launcher's file preview: directory entries, text, audio tags and cover |
| `@domicile-desktop/sdk/dbusmenu` | a tray item's `com.canonical.dbusmenu` menu, on the item's own bus name |

Each library owns its system's format and the safety rules for it (for
example, `system-backlight` never sets the level to zero), with tests on
recorded output.

## What stays in Domicile

| Stays | Why |
|---|---|
| Windows, input, rendering, Wayland protocols | only the compositor and engine can do them |
| The lock and PAM | must outlive the page ([LOCK.md](LOCK.md)) |
| Notifications, tray, portals | D-Bus servers that own a bus name |
| The home file index and `searchFiles` | speed: only the matches cross to the page |
| Launching apps (`spawn`) | a client outlives a shell reload and runs on the compositor's Wayland display |
| Clipboard history (`copyClipboardEntry`, `removeClipboardEntry`) | the compositor serves the paste, so it outlives the client that copied; full text stays out of the page ([CLIPBOARD.md](../packages/manganese-clipboard/docs/CLIPBOARD.md)) |
| The screen's color temperature (`set_color_temperature`) | only the engine reaches the display's gamma ramp ([Night light](DISPLAYS.md#night-light-and-gamma-control)) |
| Theme (`theme`, `windowsTheme`) | clients read it from the portal's `Settings`; the compositor switches them only after every chrome captures its old frame |

## Wire

- Page to compositor: `system_request { id, request }`. `request` starts a
  call (`read_file`, `write_file`, `create_dir`, `read_dir`, `stat`, `watch`, `spawn`,
  `dbus_call`, `dbus_match`, `screenshot`, `screen_record`, `preview_window`, `shell_commands`, `answer_shell_command`, `send_shell`,
  `idle_after`, `idle_before_blanking`, `idle_holds`, `unlock_refusals`, `set_window_states`, `window_requests`,
  `virtual_monitor`, `agent`, `agents`, `stop_agent`, `forget_agent`, `keymaps`, `select_keymap`, `set_color_temperature`)
  or
  drives one running under the same `id` (`unwatch`, `stdin`, `close_stdin`,
  `kill`, `agent_did`). `agent` is `domicile agent`'s, and its session gets an `agent_reach` event when the user changes it; see [AGENTS.md](AGENTS.md). `read_file` takes an
  optional byte range, `offset` and `length`.
- Compositor to page: one `system_reply` per call that starts something
  (`failed` included), then for a watch or process any number of
  `system_event` and one `system_end`. Bytes are base64.
- Types: `domicile_protocol::SystemRequest` and its neighbors. The executor is
  `domicile_host::system`, one per chrome connection, on the connection's
  thread.
- The engine relays both as opaque strings: the host's
  `callSystem(id, request)` and its `system` event, a `MessageEvent` whose `data` is the line. Only the engine
  writes `compositor_gone`, for the calls of a compositor that hung up. A new request
  type changes `domicile-protocol`, the compositor and the SDK, not the
  engine.
- Large files for display (`<img>`, `<video>`) use
  [`domicile://home/`](architecture/DOMICILE-SCHEME.md).

## Security

The shell is trusted code: it can already spawn any argv. These rules keep
that trust from reaching anything else.

- **Binding:** only the `domicile` that the engine hands to `Shell` in a
  `domicile://shell` document reaches the system, through the control
  channel's own binding. `<webview>` guests, extensions and `domicile://home`
  never do. An app module's `AppDomicile` does too, for files, processes
  and D-Bus only
  ([APP-MODULES.md](architecture/APP-MODULES.md#the-host)).
- **Content Security Policy:** `domicile://shell` serves
  `script-src 'self' 'wasm-unsafe-eval'`.
  A script injected through a notification body, window title or file name
  does not run ([SHELL-PACKAGING.md](SHELL-PACKAGING.md#scripts)).
- **argv only:** no shell string. A shell that wants `sh -c` passes it.
- **Lock:** `crate::lock::refused` covers every system call. While locked:
  - a call that starts something fails with `locked`, except:
    - a read, stat, listing or watch of an absolute path under `/sys` with no
      `..`
    - the calls `system-battery`, `system-backlight` and `system-audio` make,
      and `system-bluetooth`'s watch, matched field by field, so a lock screen
      shows the battery and Bluetooth and sets the brightness and volume
      ([LOCK.md](LOCK.md#lock-screen-readouts))
    - `shell_commands`, `answer_shell_command` and `window_requests`, so a page reloaded while
      locked hears them after unlock
    - `idle_after` and `idle_before_blanking`, so a lock screen can dim
    - `idle_holds`, like `idle_after`
    - `unlock_refusals`, which a lock screen needs while locked
    - `set_window_states`, like `windows.setBounds`
    - `keymaps` and `select_keymap`, so a lock screen shows and switches the
      keymap the passphrase is typed on
    - `set_color_temperature`, so the night light keeps its schedule
  - `stdin` is dropped; `unwatch`, `close_stdin` and `kill` are allowed
  - processes and watches started before the lock keep running
- **Lifetime:** a page's processes, watches, matches and virtual monitors end
  when its connection closes, so a reload or `domicile load-shell` leaks
  nothing.

## Why

- **Primitives over a message per feature.** GNOME Shell (GIO), AGS/Astal and
  Quickshell expose the same three.
- **D-Bus as a primitive, over `spawn("busctl", …)`.** NetworkManager, BlueZ,
  UPower, MPRIS and logind are D-Bus services; parsing `busctl` output loses
  types.
- **In the compositor, over the engine's browser process.** The compositor
  enforces the lock, already spawns clients and already runs `zbus`, and its
  Rust tests run without a GPU.
- **Opaque relay in the engine, over typed IDL members.** A member per request
  would grow the engine with every feature. The SDK parses replies with Zod.
