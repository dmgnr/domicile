# @domicile-desktop/manganese-notifications

## 2.0.1

### Patch Changes

- Updated dependencies [d0fbc5b]
- Updated dependencies [d566f68]
- Updated dependencies [87ac040]
- Updated dependencies [24b88fb]
- Updated dependencies [81215c5]
- Updated dependencies [3e37020]
- Updated dependencies [3bdac3b]
- Updated dependencies [2a1913f]
- Updated dependencies [da632d6]
- Updated dependencies [a5ade39]
- Updated dependencies [8c477cc]
- Updated dependencies [996cc29]
- Updated dependencies [9bd54ab]
- Updated dependencies [8ff882e]
- Updated dependencies [25522ef]
- Updated dependencies [e821d1f]
- Updated dependencies [19cc2c5]
  - @domicile-desktop/sdk@2.3.0
  - @domicile-desktop/component-library@2.1.1
  - @domicile-desktop/manganese-host@2.0.3
  - @domicile-desktop/react@0.1.3
  - @domicile-desktop/manganese-bar@1.1.3

## 2.0.0

### Major Changes

- 50318b4: The notifications panel's Do not disturb switch is now a Pause button in its header. Pause for 1 hour, until 8 AM tomorrow, or until you resume; the header says until when, and Resume ends it early. Clear all moves beside the Recent label. Do not disturb left on carries over as a pause until resumed.
  
  - `useNotifications` returns `pause`, `pauseFor` and `resume` in place of `doNotDisturb` and `setDoNotDisturb`.
  - `NotificationDrawer` takes `pause`, `onPause` and `onResume` in place of `doNotDisturb` and `onDoNotDisturb`; `NotificationBell` and the drawer context take `paused`.
  - The component library adds `Menu`, a menu opened from a button, and a `status` line on `PanelHeader`.

### Patch Changes

- bc45b4c: Gmail's page no longer notifies the same mail again while its window is open.
- d69b2f4: A page's notification names its browser window, so only the Gmail inbox's own window has its duplicate notifications cleared; Gmail in another window notifies again.
- Updated dependencies [f9bbf5d]
- Updated dependencies [c664ef4]
- Updated dependencies [1af639c]
- Updated dependencies [eba7d0d]
- Updated dependencies [62ccd23]
- Updated dependencies [af7415e]
- Updated dependencies [bb1e4cb]
- Updated dependencies [c1988f7]
- Updated dependencies [d69b2f4]
- Updated dependencies [e81703a]
- Updated dependencies [8eaae53]
- Updated dependencies [f592184]
- Updated dependencies [18413ff]
- Updated dependencies [69fe0d8]
- Updated dependencies [3d22f74]
- Updated dependencies [a354497]
- Updated dependencies [75708d7]
- Updated dependencies [9246b97]
- Updated dependencies [50318b4]
- Updated dependencies [cdb3534]
- Updated dependencies [eeb9468]
  - @domicile-desktop/component-library@2.1.0
  - @domicile-desktop/sdk@2.2.0
  - @domicile-desktop/manganese-bar@1.1.2
  - @domicile-desktop/manganese-host@2.0.2
  - @domicile-desktop/react@0.1.2

## 1.1.1

### Patch Changes

- Updated dependencies [fdad979]
  - @domicile-desktop/sdk@2.1.0
  - @domicile-desktop/component-library@2.0.1
  - @domicile-desktop/manganese-host@2.0.1
  - @domicile-desktop/react@0.1.1
  - @domicile-desktop/manganese-bar@1.1.1

## 1.1.0

### Minor Changes

- a3c11aa: Animate clearing notifications in the drawer: a cleared card slides out, then the cards below close up. Several cleared at once leave in turn.
- c429bd5: The notifications panel has a Do not disturb switch. While it is on, only critical notifications pop up; the rest still collect in the panel, and the bell shows struck through.
- a113605: Inboxes open as app windows instead of a page in the notifications drawer. Messages is one window that keeps running in the background: closing it hides it. Each Gmail account has one window, reused by its inbox row, its bar counter and its new-mail notifications. `Inbox.Page` is replaced by `Inbox.Window`, and an inbox's `launcherName` adds a launcher entry that opens its window.
- d4b9da4: The bell counts an inbox's new mail or texts once: its own notifications stay out of the count, since its unread conversations already add to it. Every inbox names the sender its notifications arrive under, `notifiesAs`, and `useNotifications` takes the senders to leave out.
- be59aae: Inboxes in the notification drawer: `runManganese({ inboxes })` lists inboxes above the notifications, and their unread conversations count toward the bell. An inbox is plain data (`Inbox.Watched` or `Inbox.Page`, from `@domicile-desktop/manganese-notifications/inbox`). New packages `@domicile-desktop/manganese-inbox-gmail` (`gmailInbox`) and `@domicile-desktop/manganese-inbox-google-messages` (`messagesInbox`, which opens in the drawer, widened, with a back button). The Gmail and Google Messages bar items stay, and export what the inboxes share. `SlideOver` gains `keepMounted`, `onBack` and `wide`.
- 5bdc699: The launcher previews an inbox by its account, unread count and newest unread mail, instead of the command it runs.
- cd83e49: A notification's actions sit in a strip across its foot. Reply opens a boxed reply field in place of the strip, with an animated swap.
- 1fcf33a: The notification drawer opens as a panel under the bell, like quick settings, instead of sliding in from the screen's edge. Its sections have clearer headings, inbox rows are tighter, and each notification sits on its own tile. "Clear all" is in a quieter footer. An inbox's page, such as Messages, widens the panel and has a back button.
  
  `NotificationsDrawer` (from `notifications-context`) now holds a popover `handle` that every bell opens, in place of `open(screen)`. `NotificationDrawer` takes `handle`, `onOpen(screen)` and `onClose()` in place of `onOpenChange`.

### Patch Changes

- c99bfef: Keep the notification drawer from flashing a scrollbar while its last notification closes up.
- d961736: Keep the notification drawer from flashing scrollbars while notifications slide in or out.
- f71cc09: The Downloads bar item's panel opens by itself as a download starts, on the screen with the keyboard, and stays until dismissed. Removed downloads slide out as cleared notifications do. As the last download finishes, the item eases from its percent to a check and "Done", then back to its icon. Opening a file no app opens says so, in the downloads panel and in the launcher, instead of doing nothing.
  
  - `LeavingRow` and `useLeavingRows` (component library) hold the notification drawer's arrive and leave motion; `ListRow` takes it as `motion`.
  - `Bar` has `popsUp`: whether an item may open its panel by itself.
  - `opens` and `nothingOpens` (`@domicile-desktop/system-apps/opens`) ask `domicile open --which` before opening a file.
  - `Launcher` takes `opens`.
- f6f6e5b: An empty inbox says "Empty" under its name, where its conversation count goes, rather than at the row's end.
- 4967b5d: Email inbox rows show the conversation total under the name and the unread count in the pill, which counts to 99+ in line with text.
- 0aa24da: Slide in only notifications that arrive while the drawer is open, not every one each time it opens.
- 40d7378: Rebalance notification cards: a larger picture beside the sender and summary, the body across the full width under them, even padding, and action buttons in body-size text. Avatar's `sm` size is now 40px.
- cbaa64e: Clearing a notification no longer opens it when the pointer slips off the close button before letting go.
- 4ee2c21: Panels over the wallpaper, such as the bar's popovers, stay dark in light mode. Everything in them, including buttons, fields and cards, now uses the dark theme's colors, so nothing is lost against the panel. Gray text is darker in light mode and lighter in dark mode, so it reads on cards. `CountBadge` takes `inline` to sit beside text.
  
  The notifications popup uses the see-through panel, like quick settings. An inbox's unread count is a pill at the end of its row, in place of the total.
- 3146073: Each package asks for the bun and Node its workspace does: `engines` is `bun >=1.4.2`, `node >=24`.
- e83ec4a: Bar panels never show blank. New `EmptyState` and `Loading` panel parts: Wi-Fi, Bluetooth, Sound, notifications and inboxes say when they are off, empty or still checking, and Bluetooth says when it couldn't be read.
- 7a786a4: Quick settings, its Wi-Fi, Bluetooth and Sound details, and the notifications panel are built from shared panel parts (`Panel`, `PanelHeader`, `PanelSection`, `ListRow`, `DetailList`, `SliderRow`, `PanelNote`, `PanelFooter`, `IconButton`) with one type scale and set of colors, so they line up and nothing spills out of its panel. Bluetooth devices are grouped as connected, paired and nearby; refusals say what failed in plain words; and a panel opened with the pointer no longer shows a focus ring on its first control.
- c15ba93: Shells and manganese packages take the typed `Domicile` instead of the raw host. `PortalDialogs` takes `domicile` (no more `host`/`desktopOf`), `usePortalWallpaper` and manganese-host's helpers take `Domicile` slices, and the SDK's `bindKeys`, `fireGlobalShortcuts`, `watchShellOptions` and `casting` take namespaces. Adds `portals.fireShortcut`.
- 9664607: Clearing the last notification no longer shrinks the drawer before it grows back for "You're all caught up": the list eases straight to the note's height as the row slides out.
- 5d2376e: Clicking a notification popup opens it on the first click. The popup's swipe-to-dismiss took the click away from the card.
- Updated dependencies [bafd922]
- Updated dependencies [fe90bca]
- Updated dependencies [77fd631]
- Updated dependencies [9e60e1e]
- Updated dependencies [6bbc80b]
- Updated dependencies [a62f35a]
- Updated dependencies [923e65b]
- Updated dependencies [cb4d2f9]
- Updated dependencies [44eb13c]
- Updated dependencies [3980a9a]
- Updated dependencies [c7a232d]
- Updated dependencies [66d220b]
- Updated dependencies [a2def76]
- Updated dependencies [d3a65c5]
- Updated dependencies [eca2588]
- Updated dependencies [f15f43a]
- Updated dependencies [7c8d9e2]
- Updated dependencies [fc3ee2f]
- Updated dependencies [9d0934e]
- Updated dependencies [a9a62e8]
- Updated dependencies [fa78a81]
- Updated dependencies [509f948]
- Updated dependencies [a2ee8ea]
- Updated dependencies [22844b3]
- Updated dependencies [c80cd2a]
- Updated dependencies [c03a44b]
- Updated dependencies [9fe15f8]
- Updated dependencies [f71cc09]
- Updated dependencies [aeb6f92]
- Updated dependencies [40f5af3]
- Updated dependencies [ab2d2f0]
- Updated dependencies [17064a7]
- Updated dependencies [a88ce23]
- Updated dependencies [ecd3fba]
- Updated dependencies [0e8c788]
- Updated dependencies [62a671f]
- Updated dependencies [a1569c6]
- Updated dependencies [6fecbbd]
- Updated dependencies [258d9aa]
- Updated dependencies [d9f5353]
- Updated dependencies [fb9e591]
- Updated dependencies [14e6071]
- Updated dependencies [56e1c22]
- Updated dependencies [98d378e]
- Updated dependencies [54472b5]
- Updated dependencies [e42226f]
- Updated dependencies [506b12f]
- Updated dependencies [00e5da2]
- Updated dependencies [75b9403]
- Updated dependencies [3f7e261]
- Updated dependencies [b49fa3a]
- Updated dependencies [35b8470]
- Updated dependencies [6730912]
- Updated dependencies [2a87739]
- Updated dependencies [2d2289b]
- Updated dependencies [7a29c8f]
- Updated dependencies [4967b5d]
- Updated dependencies [be59aae]
- Updated dependencies [a999398]
- Updated dependencies [9d4a876]
- Updated dependencies [44d0983]
- Updated dependencies [7ac9e00]
- Updated dependencies [6825067]
- Updated dependencies [cd02e0e]
- Updated dependencies [840418d]
- Updated dependencies [7aa450b]
- Updated dependencies [57b5b1f]
- Updated dependencies [b2c6fd5]
- Updated dependencies [a472a59]
- Updated dependencies [93f015d]
- Updated dependencies [b85d9bb]
- Updated dependencies [01b9340]
- Updated dependencies [fccc784]
- Updated dependencies [2bf4b18]
- Updated dependencies [e1205bb]
- Updated dependencies [40d7378]
- Updated dependencies [670713c]
- Updated dependencies [e7cbd52]
- Updated dependencies [8bc5b85]
- Updated dependencies [4ee2c21]
- Updated dependencies [3146073]
- Updated dependencies [bbf849b]
- Updated dependencies [e83ec4a]
- Updated dependencies [7a786a4]
- Updated dependencies [4759ab2]
- Updated dependencies [3bb9bd5]
- Updated dependencies [0f4582e]
- Updated dependencies [d80e2f5]
- Updated dependencies [58d2cfe]
- Updated dependencies [c15ba93]
- Updated dependencies [2fe5852]
- Updated dependencies [a5bff8c]
- Updated dependencies [52a1d65]
- Updated dependencies [3e5b976]
- Updated dependencies [d138939]
- Updated dependencies [4064278]
- Updated dependencies [f4a973d]
- Updated dependencies [341debf]
- Updated dependencies [ae7874c]
- Updated dependencies [599d60f]
- Updated dependencies [74a9564]
- Updated dependencies [75799a0]
- Updated dependencies [2430e48]
- Updated dependencies [9fd298a]
- Updated dependencies [c4fe915]
- Updated dependencies [b1041f8]
- Updated dependencies [20a1fc5]
- Updated dependencies [065ff4b]
- Updated dependencies [1e2aeca]
- Updated dependencies [b39d80e]
- Updated dependencies [21b82af]
- Updated dependencies [427c184]
- Updated dependencies [ee63a45]
- Updated dependencies [66bfb0d]
- Updated dependencies [5a6a4fc]
- Updated dependencies [25b9bd3]
- Updated dependencies [113dabe]
- Updated dependencies [0bd0d2a]
- Updated dependencies [d9f5353]
- Updated dependencies [1971d87]
- Updated dependencies [b741b92]
- Updated dependencies [570e7bb]
- Updated dependencies [2edc3c1]
- Updated dependencies [b241f68]
- Updated dependencies [5d2376e]
- Updated dependencies [6c3db42]
- Updated dependencies [9c89f16]
- Updated dependencies [ca86667]
- Updated dependencies [0c58b28]
- Updated dependencies [ee1cc17]
- Updated dependencies [eb6b52a]
- Updated dependencies [63728a9]
  - @domicile-desktop/component-library@2.0.0
  - @domicile-desktop/sdk@2.0.0
  - @domicile-desktop/manganese-bar@1.1.0
  - @domicile-desktop/manganese-host@2.0.0
  - @domicile-desktop/react@0.1.0

## 1.0.0

### Major Changes

- 2056529: The first release.

### Patch Changes

- Updated dependencies [2056529]
  - @domicile-desktop/component-library@1.0.0
  - @domicile-desktop/manganese-bar@1.0.0
  - @domicile-desktop/manganese-host@1.0.0
  - @domicile-desktop/sdk@1.0.0
