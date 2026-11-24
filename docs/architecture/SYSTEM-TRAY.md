# System tray

The compositor is the StatusNotifierItem host. It sends the tray items to the
shell, and the shell draws the icons and forwards clicks.

## Design

```
application ── RegisterStatusNotifierItem ──▶ compositor (org.kde.StatusNotifierWatcher)
            ◀── GetAll, New* signals ───────       │ HostMessage::Tray { items }
                                                   ▼
                                    engine: `tray` attribute, DomicileTrayItem
                                                   ▼
                                   shell: domicile.tray.items, "change" → icons
shell click ─ tray.activate(id, action) ─▶ engine ─ activate_tray_item ─▶ compositor
            ─▶ ProvideXdgActivationToken, then Activate / SecondaryActivate /
               ContextMenu on the item
shell menu ─ domicile.dbus.call / match ──────▶ compositor ─▶ com.canonical.dbusmenu on `bus`
```

| Piece | Where |
|---|---|
| Wire types: `HostMessage::Tray`, `ChromeMessage::ActivateTrayItem`, `TrayItem`, `TrayAction` | `packages/domicile-protocol` |
| Item properties → title, image, hidden; the `Registry`; pixmap → PNG | `packages/domicile-host/src/tray.rs`, `png.rs` |
| D-Bus: watcher, host name, signals, clicks | `packages/domicile-compositor/src/tray.rs` |
| `tray` attribute, `activateTrayItem()` | `components/domicile/mojom/control_channel.mojom`, `modules/domicile/domicile_tray_*`, patch 0063 |
| SDK: `DomicileTrayItem`, `tray`, `activateTrayItem`; `TrayItem`, `TrayAction` | `@domicile-desktop/sdk/domicile-host`, `@domicile-desktop/sdk/tray` |
| Menus: `watchMenu` reads, follows and clicks an item's dbusmenu | `@domicile-desktop/sdk/dbusmenu` |
| Manganese tray: one reorderable row shared with extension actions, with a menu of every icon to pin or unpin it; menus drawn with `ContextMenu`, entry icons looked up with `@domicile-desktop/system-apps/app-icons` | `packages/manganese-bar-module-tray/src/` |

## Key decisions

- **StatusNotifierItem**, because it is the only tray protocol Wayland clients
  use. XEmbed needs X11.
- **The compositor hosts the tray** because it owns the session bus
  connection; pages have none. The desktop portal in `portals/` works the
  same way.
- **The compositor sends the full tray** on every change and on connect, as it
  does for `clipboard`. `Host::set_tray` sends nothing when nothing changed.
- **Icons are sent as `data:` URLs.**
  - Named icons are looked up at 16 pixels, scale 2, in the item's
    `IconThemePath`, then in the config's `theme.icon_theme`, its parents and
    `hicolor` (`status`, `apps`, `devices`, `panel`), as
    `domicile_host::icon_theme` reads their `index.theme`. A reload that
    changes the theme redraws every icon. Notification icons use the same
    lookup.
  - Pixmaps are encoded as uncompressed (stored-deflate) PNGs, with no new
    dependency.
- **Items are keyed by their `Id`.** The bus name changes every run; the `Id`
  does not. Manganese uses it to keep an icon's position, so a restarted
  application's icon returns to its old place.
  - Duplicate `Id`s get a `#2` suffix.
  - An item with no `Id` is keyed by its bus name and path.
- **`Passive` items are not sent.** Trays conventionally hide them.
- **Clicks respect the lock.** They go through the Wayland thread, which
  refuses them while locked, the same as `Spawn`.
- **Clicks carry an `xdg-activation` token**, so the app can show a window
  that is in a hidden tab, on another screen or on another workspace.
  - The token is handed over with `ProvideXdgActivationToken` before the
    click, as KDE does.
  - Apps that ignore it (Electron) ask with a token of their own, made before
    the keyboard last moved, which is normally dropped. A click lets the
    item's process (from `GetConnectionUnixProcessID`) ask that way once,
    within 10 seconds, as a notification press does (`activation::invites`).
  - A shell's D-Bus call clicking a menu entry (`com.canonical.dbusmenu`
    `Event` `clicked`, as "Show Slack" is) gets the same, for the item on the
    call's bus (`tray::menu_clicked`). The token is minted before the call
    runs.
- **Reads never block the D-Bus worker.** Each `GetAll` runs on its own thread,
  because a call waits as long as its application does.
  - An item has at most one read in flight. Signals during a read cause one
    more read after it.
  - Calls on the tray's connection time out after 3 seconds
    (`ANSWER_WITHIN`). A timed-out read is a failed read: the item is hidden
    until a read answers. Its next signal reads it again, and so does a wait
    after each timeout, 3 seconds doubling up to a minute
    (`RETRY_AT_MOST`), since an application busy starting up, as many are at
    login, may answer late and never signal. The first timeout per item logs
    a warning; later ones log at debug.
  - Clicks use `call_noreply`, so they never wait.
- **Icon lookups are cached** for the 32 names used last. An icon named by a
  path is read each time, since applications rewrite one file in place.
- **Secondary click opens the item's dbusmenu**, as KDE's and waybar's trays
  do. An item with no `Menu` (`menu` empty, for none or `/NO_DBUSMENU`) gets
  `ContextMenu` and opens its own. Primary click is `Activate`, except for an
  item that sets `ItemIsMenu` (`itemIsMenu`): it gets the secondary click's
  menu, as the spec asks.
- **Menus are drawn by the shell, through the system calls.** Most
  libappindicator items only expose `com.canonical.dbusmenu`. The page reaches
  any session bus name with `dbusCall` and `dbusMatch`, so menus need no
  compositor or engine code. The lock refuses those calls.
- **Menu entries draw their icon and mnemonic.**
  - `icon-name` is looked up at 16 pixels in the config's
    `theme.icon_theme`, its parents and `hicolor` (`actions`, `status`,
    `devices`, `apps`), then as `<name>-symbolic`. A symbolic icon is a mask
    over the text color. A name not found falls back to `icon-data`, the
    application's PNG.
  - The mnemonic is underlined. Its letter chooses the first enabled entry
    with it in the open menu or submenu, and opens a submenu. Other letters
    go to base-ui's type-ahead, which only highlights.
- **A menu is read only while open.** Opening sends `AboutToShow(0)`, then
  `GetLayout` reads the whole tree. `LayoutUpdated` and
  `ItemsPropertiesUpdated` read it again; so does an `AboutToShow` that
  answers `true`, sent as each submenu opens.

## Open questions

- **Nested sessions.** Inside another desktop session, that session's panel
  already owns `org.kde.StatusNotifierWatcher`, so the compositor hosts
  nothing. Recommendation: leave it; nested runs are for development.
