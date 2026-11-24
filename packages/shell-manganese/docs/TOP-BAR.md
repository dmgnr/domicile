# The top bar

A transparent bar across the top of every screen. Windows tile in the space
below it.

## Layout

`runManganese({ bar })` takes three columns of React nodes: `left`, `center`
(centered on the screen) and `right`. Mix manganese's items with your own.
Each of manganese's items is its own package, takes no props, and is that
package's default export path:

| Item | Package |
|---|---|
| `LauncherButton` | `@domicile-desktop/manganese-bar-module-launcher-button` |
| `Tray` | `@domicile-desktop/manganese-bar-module-tray` |
| `WorkspaceSwitcher` | `@domicile-desktop/manganese-bar-module-workspace-switcher` |
| `Clock` | `@domicile-desktop/manganese-bar-module-clock` |
| `QuickSettings` | `@domicile-desktop/manganese-quick-settings` |
| `Keymap` | `@domicile-desktop/manganese-bar-module-keymap` |
| `ThemeSwitch` | `@domicile-desktop/manganese-bar-module-theme-switch` |
| `IdleInhibitor` | `@domicile-desktop/manganese-bar-module-idle-inhibitor` |
| `Network` | `@domicile-desktop/manganese-bar-module-network` |
| `Bluetooth` | `@domicile-desktop/manganese-bar-module-bluetooth` |
| `Volume` | `@domicile-desktop/manganese-bar-module-volume` |
| `Brightness` | `@domicile-desktop/manganese-bar-module-brightness` |
| `Battery` | `@domicile-desktop/manganese-bar-module-battery` |
| `Notifications` | `@domicile-desktop/manganese-bar-module-notifications` |
| `Sharing` | `@domicile-desktop/manganese-bar-module-sharing` |
| `Agents` | `@domicile-desktop/manganese-bar-module-sharing/agents` |
| `KeptAwake` | `@domicile-desktop/manganese-bar-module-idle-inhibitor/kept-awake` |
| `Cast` | `@domicile-desktop/manganese-bar-module-cast` |
| `Downloads` | `@domicile-desktop/manganese-bar-module-downloads` |

Every item, yours included, eases its width and fades as it shows, hides or
changes size, so its neighbors slide aside. An item hides by rendering
nothing. The bar wraps each item in a `FluidItem`
(`@domicile-desktop/component-library/FluidItem`) to do this. An item is
clipped to its width while it eases, except the last on the left and the first
on the right, which can spill into the bar's empty middle.

Items no default bar has:

| Item | Package |
|---|---|
| `Mode` | `@domicile-desktop/manganese-bar-module-mode` |
| `Gmail` | `@domicile-desktop/manganese-bar-module-gmail` |
| `GoogleMessages` | `@domicile-desktop/manganese-bar-module-google-messages` |

```tsx
import { runManganese } from "@domicile-desktop/manganese";
import { Clock } from "@domicile-desktop/manganese-bar-module-clock";
import { Tray } from "@domicile-desktop/manganese-bar-module-tray";
import { WorkspaceSwitcher } from "@domicile-desktop/manganese-bar-module-workspace-switcher";

export const Shell = runManganese({
  bar: {
    left: [<Tray key="tray" />, <WorkspaceSwitcher key="workspaces" />],
    center: [<Clock key="clock" />],
    right: [<MailCount key="mail" />],
  },
});
```

Each item reads what it shows from context:

- `useBar()` (`@domicile-desktop/manganese-bar/bar-context`): the bar's
  `screen`, whether the desktop is `locked`, and whether an item may open its
  panel by itself there (`popsUp`: the screen with the keyboard, never the
  lock screen).
- `useDomicile()` (`@domicile-desktop/react/domicile-provider`): the
  desktop. Readouts are watched once per desktop
  ([Host readouts](HOST-READOUTS.md#one-watch-per-desk)).
- The launcher, notification drawer, tray and workspaces each have a context
  the desktop provides: `useLauncher()`, `useNotificationsDrawer()`,
  `useTrayState()`, `useWorkspaces()`.

To style your own items, see
[CUSTOM-BAR-ITEMS.md](CUSTOM-BAR-ITEMS.md).

Every bar and the lock screen share one watch per system readout. See
[Host readouts](HOST-READOUTS.md#one-watch-per-desk).

`DEFAULT_BAR` (`src/default-bars.tsx`, exported by
`@domicile-desktop/manganese`) is:

- **left**: launcher button, tray, workspaces
- **center**: clock
- **right**: sharing indicator (while recorded), agents (while one is in
  control), Cast (while a TV is near or
  cast to), downloads (while there are any), keymap (with several keymaps), quick settings, notification bell

The theme selector, idle inhibitor, brightness, volume, Bluetooth, network and
battery items are still exported, for a bar that wants them one by one.

To keep the defaults and add to them, spread `DEFAULT_BAR`:

```tsx
import { DEFAULT_BAR, runManganese } from "@domicile-desktop/manganese";
import { Battery } from "@domicile-desktop/manganese-bar-module-battery";

export const Shell = runManganese({
  bar: {
    ...DEFAULT_BAR,
    right: [<Battery key="battery" />, ...DEFAULT_BAR.right],
  },
});
```

## On the lock screen

- The lock screen draws the same bar on every screen, with only the keymap
  and quick settings (`LOCK_BAR`, `src/default-bars.tsx`). The `bar` option
  does not change it.
- Each offers only what a locked desktop allows
  ([LOCK.md](../../../docs/LOCK.md#lock-screen-readouts)):
  - Quick settings: no network, keep awake or dark mode, and no details.
    The Bluetooth tile shows the state and can't be pressed. The volume
    slider and mute work; there is no mixer.
  - Keymap, brightness, the night light and battery: as on the desktop.
- Panels draw over the lock screen and keep the keyboard until they close.
  Then it goes back to the passphrase.

## Readability over the wallpaper

- Text is white with a tight dark shadow (`shadows.textOverPhoto`) in both
  themes, since the photo does not change with the theme.
- A gradient scrim (`gradients.scrimOverPhoto`) darkens the bar. It extends
  half the bar's height below the bar so the text sits in the darkest part.
  The overhang ignores the pointer.

## Workspaces

- Each bar lists the workspaces on its screen that have windows, plus the one
  the screen shows.
- Each is a number in a rounded square. Hover fills it faintly. The shown
  workspace is filled on the screen with the keyboard and outlined on other
  screens (sway's `focused_workspace` / `active_workspace`).
- On a switch the fill slides to the new workspace with a small bounce, and
  each number turns black as the fill passes under it.

## Clock

- Reads like `Wednesday 2026-09-16 20:53:40` and ticks every second. Without
  seconds it changes on the minute, and reads the time every few seconds.
- The shell options `clock.format` (`24h` or `12h`) and `clock.seconds` change
  that, e.g. `Wednesday 2026-09-16 08:53 PM`. See the
  [README](../README.md#configure).
- Centered on the bar, so it does not shift as other items change.
- A fixed English day and ISO date keep the width stable.

## Hardware

- An item for hardware hides only when the machine has none. Each looks in
  `/sys` every 10 seconds (`watchPresence`,
  `@domicile-desktop/react/watch-presence`), which works while
  locked.
- The theme selector, idle inhibitor, quick settings and notification bell
  always show.

## Quick settings

One item for the computer's settings: the hardware items' icons in one
button, and their controls in one panel, each labeled in words.

- **The button** holds, left to right:
  - the network icon, as the network item draws it;
  - the Bluetooth icon, only while a device is connected, or in `warning`
    when BlueZ fails;
  - the speaker, dimmed while muted;
  - the battery, as the battery item draws it.
- An icon for hardware the machine lacks is left out, as each item hides.
- Each icon eases in and out, and the button eases to fit them.
- Scroll over the button to step the volume by 5%. Middle-click to mute or
  unmute it.
- **The panel**, a `Drilldown` in a popover:
  - Tiles (`QuickTile`): Wi-Fi, Wired (with a cable in, or without Wi-Fi)
    and Bluetooth. Each icon is lit in the accent color while connected. A
    press opens the tile's details.
  - Toggles (`QuickToggle`): Keep awake, Night light, Dark mode.
  - The brightness slider, and the volume slider with an arrow to the mixer.
  - The battery in words, such as `Battery 78%, about 3 h 20 min left`. Red
    while low.
  - **Settings**, which runs `domicile-settings` as the launcher does, and
    closes the panel. Not on the lock screen.
- **Details** slide in over the tiles, with a back button: the network item's
  panel (wired ports and Wi-Fi), the Bluetooth panel, or the mixer.
- The panel keeps the keyboard while open, for a Wi-Fi password.
- Each part is its item package's `quick-settings` export, and reads the same
  desk watches as the item.

## Network

- The primary connection from NetworkManager, iwd or wpa_supplicant, whichever
  is on the system bus first in that order
  ([`@domicile-desktop/system-network`](../../system-network/README.md)).
  iwd and wpa_supplicant report Wi-Fi only.
- The hardware from `/sys/class/net`: interfaces with a `device`, wired or
  Wi-Fi. A wired port with a cable in counts as a wired link when the service
  reports none, as iwd and wpa_supplicant never do.
- An icon only. Wi-Fi: a signal icon graded strong, fair or weak by thirds.
  Wired, or any other kind such as a VPN: a network icon. No connection: a
  crossed-out Wi-Fi icon.
- Hover for the kind and the SSID or VPN name, e.g.
  `Wi-Fi, strong signal: Home`, and `; Wired` when a cable is in beside it.
- Dims with no connection. Turns `warning` when NetworkManager reports limited
  connectivity or a captive portal, or when the service fails
  (`Network unavailable: …`).
- On joining a network, the desk checks for a captive portal and shows its
  sign-in page in a dialog on the screen with the keyboard. The check asks
  `curl` for `http://www.gstatic.com/generate_204`, so it works with iwd and
  wpa_supplicant too. Any answer but `204` is a portal.
  - While the dialog shows, the check repeats every 3 seconds. The dialog
    closes once the probe answers `204`, or on leaving the network.
  - Closing it by hand stops the checks until the next network.
- Hidden only on a machine with no network hardware.
- The compositor refuses the service's calls while locked, so the watches
  start again on unlock.
- Click for the panel:
  - Each wired port: connected or no cable, speed, addresses, gateway,
    interface and hardware address. Addresses come from `ip -j` while the
    panel is open.
  - The Wi-Fi panel, from NetworkManager or iwd. With wpa_supplicant alone it
    says there is no Wi-Fi device.
    - A switch turns the radio on or off. Beside it, **N saved** opens
      Saved networks, and the arrow scans again.
    - Opening it scans.
    - The connection: signal, frequency, speed, addresses, gateway, DNS,
      interface and hardware address, and **Disconnect**. iwd reports no
      addresses.
    - The other networks, strongest first, marked saved and secured. A click
      joins a saved or open network. A new secured one asks for its
      passphrase.
    - **Saved networks** is a page of every saved network, in range or
      not, radio on or off: the connected one, then those in range, then the
      rest by when they were last used. Each shows its security, a **Join
      automatically** switch and **Forget**.
    - A refusal shows under what was asked.
    - Wi-Fi is read only while the panel is open.
  - Details can be selected. Addresses, gateways, DNS servers, interface
    names and hardware addresses have a copy button on the line under the
    pointer.

## Bluetooth

- From BlueZ ([`@domicile-desktop/system-bluetooth`](../../system-bluetooth/README.md)).
- An icon for off, on, or on with a device connected. Dims while off. Its name
  and tooltip list the connected devices, each with its battery, e.g.
  `Bluetooth: WH-1000XM4 (80%)`.
- Click for the Bluetooth panel:
  - A switch turns every adapter on or off.
  - While open with an adapter on, it scans for devices.
  - Devices: connected, then paired, then new. Each shows its state, battery
    and address, and **Disconnect**, **Connect** or **Pair** (pair, then
    connect). Paired devices have a forget button.
  - Pairing registers no agent, so a device that asks for a code does not
    pair.
  - A refusal, such as an rfkill block, shows under what was asked.
- Hidden only without Bluetooth hardware: a controller or an rfkill switch
  for one in `/sys`. With hardware and no adapter from BlueZ it is the icon
  alone: `Bluetooth off` (such as an rfkill block), or
  `Bluetooth unavailable: …` in `warning` when BlueZ fails.

## Battery

- A meter filled to the level, with a bolt in it when on AC, and the
  percentage.
- Always as wide as `100%`.
- At 10% or less it turns `danger`. At 5% or less it also flashes
  (`chargeFlashing`). Both thresholds use the displayed percentage. Neither
  applies on AC.
- Hidden only on machines without a battery in `/sys/class/power_supply`
  (a peripheral's, scope `Device`, does not count). Until UPower reports it,
  a dimmed empty outline, `Battery unavailable`.
- Read from UPower by
  [`@domicile-desktop/system-battery`](../../system-battery/README.md).

## Idle inhibitor

- An eye: closed and dimmed while the screens blank and lock on idle, open on a
  lit circle while they are kept on. Click to toggle.
- Every bar shows the same inhibitor. It is disabled until the portal answers.
- Held through the Inhibit portal's idle flag, since the shell has no Wayland
  surface ([IDLE.md](../../../docs/IDLE.md#idle-inhibitors)).
- A shell reload lets go of it, and the eye starts closed.
- Not on the lock screen.

## Keymap

- The keymap the desktop types on, by its name in `input.keyboard.keymaps`
  ([SHELL-CONFIG.md](../../../docs/SHELL-CONFIG.md#keyboard)).
- Shows only with several keymaps. With `keymap.hideDefault`, hidden too
  while the first keymap is active.
- Click for the list in a popover, each keymap with xkb's name for its
  layout (such as "English (programmer Dvorak)"). Picking one switches every
  keyboard.
- Works on the lock screen, so the passphrase is typed on the right keymap.
- The `keymap` command switches too ([KEYS.md](../../manganese-window-management/docs/KEYS.md#commands)).

## Brightness

- A light bulb icon: empty, lit filament or filled by level.
- With no backlight in `/sys/class/backlight`, a moon, filled while the night
  light is on, that opens the night light switch alone. Until there is a
  level, a dimmed bulb, `Brightness unavailable`.
- Click for a slider and the night light switch in a popover. Scroll over it
  to step by 5%.
- The night light switch works as on macOS: against the schedule until its
  next change (sunrise, or the custom end), or for good with no schedule.
  It is kept across reloads (`night-light:v1` in `localStorage`).
- Automatic brightness and the schedule are options
  ([README](../README.md#configure)), on the Settings app's Shell page.
- The level never goes to zero. See [Host readouts](HOST-READOUTS.md#brightness).
- The slider shows the level `/sys` reports. During a drag it stays under the
  pointer.
- The popover closes on an outside click or focus loss, including a click in
  a `<webview>`.

## Volume

- A speaker icon with zero, one (under 50%) or two waves, or slashed when
  muted. Dims while muted.
- Hidden only with no sound card in `/sys/class/sound`. With one and no sound
  server, a dimmed slashed speaker, `Sound unavailable`.
- Scroll over it to step the output by 5%. Middle-click to mute or unmute it.
  Click for the mixer:
  - Default output and default input, each with mute, slider, level meter and
    port, a quiet `Select` after its name. These are the server's defaults;
    with no default, the first output and the first input that isn't a
    monitor.
  - Drawers, shown when non-empty: **More outputs**, **More inputs**, **Apps**
    (per-app streams) and **Cards** (profiles).
  - A muted device's or stream's row is gray.
  - Names wrap instead of truncating. `Select` lists stay over the panel.
  - A PipeWire filter's own stream (e.g. laptop speaker correction) isn't
    listed under Apps. The hardware behind the filter isn't offered as a
    device unless it is in use.
  - A filter shows as muted when the hardware behind it is; unmuting it
    unmutes both.
- Sliders stop at 100%. A device set higher elsewhere shows its value.
- Level meters run only while the mixer is open, for the devices it shows.
  They show -60 to 0 dB.
- See [Host readouts](HOST-READOUTS.md#volume) for how audio is read.

## Notifications

- Toasts stack in the top-right corner of the screen with the keyboard,
  under its bar, and fan out on hover.
- Clicking a toast runs its action. The close button or a right swipe
  dismisses it.
- A notification's actions sit in a strip along its foot, in its toast and in
  the drawer. If it offers a reply, Reply comes first and opens a reply field
  in place of the strip. Sending, Escape or leaving the field empty closes it.
- Critical toasts stay up and have a red ring.
- No toasts show while locked.
- The bell shows the count since it was last opened. It opens a panel under
  itself of every uncleared notification, where you can open or clear one.
  **Clear all** sits beside the Recent label.
- **Pause**, in that panel's header, holds back every toast but critical ones
  for 1 hour, until 8 AM tomorrow, or until resumed. The header says until
  when, and **Resume** ends it early. Notifications still collect in the
  panel, and the bell shows struck through. A pause stays through a reload.
- The compositor keeps the history, so it survives a reload. See
  [NOTIFICATIONS.md](../../../docs/architecture/NOTIFICATIONS.md).

## Inboxes

`runManganese({ inboxes: [...] })` lists inboxes in the notification drawer,
under **Inboxes**, above the notifications, and in the launcher. None by
default. Each is plain data: a name, an icon, how it is read and what a press
does.

```ts
import { runManganese } from "@domicile-desktop/manganese";
import { gmailInbox } from "@domicile-desktop/manganese-inbox-gmail";
import { messagesInbox } from "@domicile-desktop/manganese-inbox-google-messages";

export const Shell = runManganese({
  inboxes: [
    gmailInbox({
      client: { id, secret },
      email: "me@gmail.com",
      launcherName: "Email - Work",
      nickname: "Work",
    }),
    messagesInbox({ launcherName: "SMS" }),
  ],
});
```

- Each row shows the inbox's unread conversations in a badge on its icon,
  and its conversation count where known. They add to the bell's count.
  Opening the drawer clears only the notifications' part. The inbox's own
  notifications (its `notifiesAs` sender) stay out of the count, so new mail
  counts once.
- An inbox whose `app.pageNotifies` notifies what its window's page notifies
  too. That page's notifications are cleared as they arrive, unshown, by the
  browser window they name (`browserWindow`). `gmailInbox` sets it: Gmail's
  page notifies the same mail while its window is open. Gmail in any other
  window still notifies.
- A press closes the drawer and opens the inbox in an app window of its own,
  or brings that window up: one window per inbox.
- **The launcher** lists each inbox that opens a window, by its
  `launcherName`, else its name. Its row opens the same window
  (`domicile open --app --id <id> --reuse focus <url>`), drawn with the site's
  icon.
- **`Inbox.Watched`** (`@domicile-desktop/manganese-notifications/inbox`): read
  from outside, as a `SharedWatch<InboxReading>`; a press runs its `open`.
  Its `app` names the window the launcher opens. `gmailInbox` is one: a press
  opens the account's own Gmail window (app id `gmail:<email>`), or signs the
  account in. It reads as the [Gmail](#gmail) item does.
- **`Inbox.Window`**: a page in an app window that runs in the background. It
  opens hidden when the shell starts, shows on the current workspace when
  pressed, when one of its notifications (its `notifiesAs` sender) is
  pressed, or when its page asks to be in front, and hides when closed, so
  its notifications keep coming. Its unread count comes from the window's page. `messagesInbox` is
  one (app id `google-messages`). Don't also use the
  [Google Messages](#google-messages) item: Messages runs one web session at
  a time.
- **Email links**: an inbox with a `write` writes email. While one does,
  manganese claims `mailto:` links ([Links](../../../docs/WRITING-A-SHELL.md#links)):
  from pages, apps, `domicile open` and the Email portal. A link asks which
  address to write from, in a dialog listing every such inbox's addresses
  (`MailPicker`), the one picked last first; with one address it writes at
  once. `gmailInbox` writes from the account and its Gmail aliases ("Send mail
  as"), in the account's window: from the account, with Gmail's new message
  form open over the inbox; from an alias, which that form can't be told,
  by saving the message as a draft from the alias and opening the draft.
- Not on the lock screen, as the drawer is not.

## Sharing

- Shown while an application records the desktop through the ScreenCast
  portal: a red pill saying what is shared ("Sharing screen", "Sharing 2
  windows"). Hovering it names who.
- Click lists each recording application, by its desktop entry's name and
  icon, and each source it records:
  - **A window:** its title and its application.
  - **A browser window:** its page's title.
  - **A screen:** its make and model, else "Screen" and its output name. A
    region covering one whole screen shows as that screen.
  - **All screens:** a region covering every screen.
  - **Part of a screen:** a region, with its size.
- Each application has a **Stop sharing** button that ends its session.
- While the bar has this item, the portal dialogs' indicator leaves screen
  casts out, so each shows once. Without it, the indicator lists them.
- See [PORTALS.md](../../../docs/PORTALS.md).

## Agents

- Shown while an agent, such as Claude Code, is in control: one violet pill
  for every session, named as the agent names itself, or "Agents" when the
  sessions are different agents. With several sessions it shows a count.
- Hovering one session's pill says what it can reach.
- Click says what each session can see and use and what it did last, with
  **Change** and **Stop** buttons, and **Stop all** when there are several.
- See [AGENTS.md](../../../docs/AGENTS.md).

## Keep awake

- Shown while anything keeps the screens on: an eye, like the other bar
  icons. Hover names who ("Kept awake by Firefox", "Kept awake by
  youtube.com", "Kept awake by 1 app and 1 website"), or "Kept awake" when
  only quick settings' Keep awake is on.
- An app or website is named once, however many holds it takes.
- A browser window's page is named by its site, from `<webview>`'s
  `wakeLock` ([SHELL-BROWSER-WINDOWS.md](../../../docs/SHELL-BROWSER-WINDOWS.md)).
- Click lists each app, each website with its icon, and **You** with a
  **Turn off** button while quick settings' Keep awake is on.
- See [IDLE.md](../../../docs/IDLE.md#what-holds-the-desktop-awake).

## Downloads

- Shown while there are downloads, from any browser or app window. A download
  icon, with how far the ones in progress have come ("23%"); the icon pulses
  while a size is unknown. As the last one finishes it shows 100%, then a
  check and "Done" for two seconds, then just the icon; its width eases
  between them.
- Its panel opens by itself as a download starts, on the screen with the
  keyboard, as Chromium's download bubble does. It leaves the keyboard where
  it was and stays until dismissed: a press elsewhere, Escape or the item.
- The panel lists every download, newest first: the file name, how far it has
  come and the time left, or the site it came from once it finished or
  failed. **Cancel** stops one in progress; **Open**, **Show in folder** and
  **Remove from list** show on hover for one that finished. **Clear all**
  forgets every one not in progress; the files stay. A row removed slides
  out as a cleared notification does (`LeavingRow`).
- **Open** on a file no application opens says so under its row instead.
- The engine keeps the list, so a download outlives its window. See
  [SHELL-BROWSER-WINDOWS.md](../../../docs/SHELL-BROWSER-WINDOWS.md#downloads).

## Gmail

`<Gmail client={{ id, secret }} email="me@gmail.com" nickname="Work" />`:
one account's inbox, read with the Gmail API. Not in `DEFAULT_BAR`.

- **Signed out:** a **Sign in to me@gmail.com** button opens Google's consent
  page in a browser window. Once the user agrees, the window closes and the
  count shows.
- **Empty inbox:** nothing.
- **Nothing unread:** an envelope, the nickname and the conversation count.
- **Unread:** the same with `unread / total`, the count semibold, on the lit
  pill the idle inhibitor shows when on.
- **Failed read:** the envelope, the nickname and a warning. Its tooltip
  says why.
- Click opens the account's Gmail window, or brings it up.
- **New mail:** a notification per message, under the nickname: the sender,
  then the subject. More than 3 at once are one notification, "5 new emails",
  naming the senders. A press opens the message, or the inbox, in the
  account's Gmail window, opening it if none is. A notification clears once its messages are read, anywhere.
  Mail already unread at startup or sign-in is not notified. Do not
  disturb hides the toasts, as for any notification. The bar item and
  `gmailInbox` share one reading, so each message notifies once.
- Read every 30 seconds, and 1 and 5 seconds after a Gmail browser window
  opens, closes, navigates or changes title. Not read while the desktop is
  locked. Counts are conversations, as Gmail's inbox counts them.
- How it reads:
  - `client` is a Google Cloud OAuth client of the Desktop app type, with the
    Gmail API on and the `gmail.metadata`, `gmail.settings.basic` and
    `gmail.compose` scopes: labels and message headers, never bodies; the
    addresses the account sends from; and drafts, for email written from an
    alias. Publish its consent screen: one in Testing expires sign-ins after
    7 days. A refresh token granted without those scopes signs the account
    out, to sign in again.
  - Sign-in is Google's desktop flow. Consent redirects the window to a
    loopback address nothing listens on; the item reads the code from the
    window's address, closes it, and trades the code for a refresh token.
  - The refresh token is in `localStorage`, per account. One Google revokes
    signs the account out.
  - Each read asks `labels.get INBOX` for `threadsTotal` and
    `threadsUnread`, and `messages.list` for the unread messages in the
    inbox, with an access token kept until it expires. A message not seen
    before gets `messages.get` for its `From` and `Subject`.
  - Notifications go to `org.freedesktop.Notifications` over the session
    bus, with the theme's `gmail` icon, else `mail-unread`.
  - Requests go through `fetchWithCookies`
    ([SHELL-SYSTEM-ACCESS.md](../../../docs/SHELL-SYSTEM-ACCESS.md#the-browsers-cookies)).

## Google Messages

`<GoogleMessages />`: [Google Messages for web](https://messages.google.com/web/)
in a panel. Not in `DEFAULT_BAR`.

- A chat bubble. With unread conversations, it is lit with their count, as
  the Gmail item is for unread mail. The count is read from the page every 5
  seconds: conversations Messages marks unread, leaving out muted ones.
- Click opens the page in a panel under it. The panel keeps the keyboard while
  open.
- Pressing one of Messages' notifications opens the panel.
- The page's permission requests are asked above it. Allow notifications to
  get them.
- How it keeps the page:
  - The page loads with the shell and keeps running while the panel is
    closed, hidden like a background tab
    ([SHELL-BROWSER-WINDOWS.md](../../../docs/SHELL-BROWSER-WINDOWS.md#basics)).
    So its notifications keep coming and its count stays current.
  - The user's own storage, so the pairing lasts. Pair it once in the panel.
    A partition would get no notifications: Chromium denies them to a page in
    one.
  - One page for the desk: the first bar showing the item draws it, and every
    bar's item opens it. Messages runs one web session at a time. When that
    bar goes, the next one loads the page again.
  - A shell reload loads the page again.
- File pickers are not offered, so attachments cannot be sent from it.

## Tray

One row of icons: each app's StatusNotifierItem, and each configured
extension with an action. See
[SYSTEM-TRAY.md](../../../docs/architecture/SYSTEM-TRAY.md).

- **Drag to reorder.** The order is saved in `localStorage` (`tray-order:v1`)
  and shared by every screen. Extensions are keyed by id, apps by title. New
  icons go last, apps first.
- **The menu of every icon**, under a caret at the row's end. It lists every
  app and every installed extension, on or off.
  - **Pins.** Each icon's pin puts it in the row or keeps it out. New icons
    arrive pinned. Dragging an icon onto the caret unpins it. Unpinned keys
    are saved in `localStorage` (`tray-unpinned:v1`) and shared by every
    screen. A switched-off extension has no pin.
  - **Rows** click as their icon does. An unpinned extension's popup opens
    from the row's icon, shown while the popup is open. Right-clicking an
    app's name opens its own menu.
  - **The tray's actions** are the same profile's, so an extension on only in
    another profile, such as a password manager kept to a work profile, shows
    once a page of that profile is focused, and its popup opens there.
  - **Extensions in <profile>** are the last focused browser page's
    profile's ([BROWSER-PROFILES.md](/docs/architecture/BROWSER-PROFILES.md)):
    the tray shows the actions of those switched on there, and each **Switch**
    turns one on or off in that profile. One the config switches there is
    locked. Focusing an app keeps the last page's profile; before any page,
    it is the default profile's.
  - **⋯** holds an extension's options page (in a browser window), what
    websites it can read, local files and user scripts,
    each where it can use them, and Uninstall…, which asks first. "On sites
    you choose…" opens Settings. A setting the config sets is grayed with a
    lock, saying "Set in your config"; an extension the config installed has
    no Uninstall.
  - A dot on the caret says an unpinned extension has a badge.
  - A change the engine refuses is said at the top, with its words on hover.
  - The footer opens Settings.
- **App icons**: click sends `Activate`, middle-click `SecondaryActivate`.
  - Right-click opens the app's dbusmenu under the icon: submenus, check
    boxes and radio items; disabled entries are grayed and hidden ones left
    out. Choosing an entry sends it to the app and closes the menu. A menu
    that cannot be read shows "Menu unavailable".
  - An app without a dbusmenu gets `ContextMenu` on right-click instead.
  - An app that is only a menu (`ItemIsMenu`) gets the right-click
    behavior on click too.
  - Entries show their icon: the icon theme's for its name, else the app's
    own picture. Symbolic icons take the text's color. See
    [SHELL-CONFIG.md](/docs/SHELL-CONFIG.md#theme).
  - Each entry's mnemonic is underlined. Pressing that letter chooses the
    entry, or opens its submenu. Other letters highlight the next entry
    starting with them.
- **Extension icons**: every click calls `extensions.activate(id)`, giving the
  extension `activeTab` on the focused browser window.
  - With a popup, the click opens the popup in a `<webview>` panel under the
    icon. An outside click or the popup's `window.close()` closes it.
    Escape closes it only if focus is on the shell, not inside the popup.
  - Without a popup, the click fires `action.onClicked`.
  - Disabled actions are hidden. Action state follows the focused browser
    window. See [EXTENSIONS.md](../../../docs/architecture/EXTENSIONS.md).
