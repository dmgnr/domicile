# @domicile-desktop/manganese-bar-module-notifications

## 2.0.1

### Patch Changes

- @domicile-desktop/component-library@2.1.1
  - @domicile-desktop/manganese-notifications@2.0.1
  - @domicile-desktop/manganese-bar@1.1.3

## 2.0.0

### Major Changes

- 50318b4: The notifications panel's Do not disturb switch is now a Pause button in its header. Pause for 1 hour, until 8 AM tomorrow, or until you resume; the header says until when, and Resume ends it early. Clear all moves beside the Recent label. Do not disturb left on carries over as a pause until resumed.
  
  - `useNotifications` returns `pause`, `pauseFor` and `resume` in place of `doNotDisturb` and `setDoNotDisturb`.
  - `NotificationDrawer` takes `pause`, `onPause` and `onResume` in place of `doNotDisturb` and `onDoNotDisturb`; `NotificationBell` and the drawer context take `paused`.
  - The component library adds `Menu`, a menu opened from a button, and a `status` line on `PanelHeader`.

### Patch Changes

- Updated dependencies [f9bbf5d]
- Updated dependencies [bc45b4c]
- Updated dependencies [62ccd23]
- Updated dependencies [c1988f7]
- Updated dependencies [d69b2f4]
- Updated dependencies [e81703a]
- Updated dependencies [3d22f74]
- Updated dependencies [75708d7]
- Updated dependencies [50318b4]
- Updated dependencies [eeb9468]
  - @domicile-desktop/component-library@2.1.0
  - @domicile-desktop/manganese-notifications@2.0.0
  - @domicile-desktop/manganese-bar@1.1.2

## 1.1.1

### Patch Changes

- @domicile-desktop/component-library@2.0.1
  - @domicile-desktop/manganese-notifications@1.1.1
  - @domicile-desktop/manganese-bar@1.1.1

## 1.1.0

### Minor Changes

- c429bd5: The notifications panel has a Do not disturb switch. While it is on, only critical notifications pop up; the rest still collect in the panel, and the bell shows struck through.
- 7a29c8f: Icons in the bar, quick settings and level notices move when their state changes or they are pointed at: the bell swings, Wi-Fi arcs fill out, Bluetooth dots slide out, speaker waves pulse, a slash draws across what is off, the dark mode sun turns to a moon, and more. New `Animated*Icon` components and `_controlHover` / `_controlActive` conditions in the component library. The notifications bar item no longer exports a Panda preset.
- 1fcf33a: The notification drawer opens as a panel under the bell, like quick settings, instead of sliding in from the screen's edge. Its sections have clearer headings, inbox rows are tighter, and each notification sits on its own tile. "Clear all" is in a quieter footer. An inbox's page, such as Messages, widens the panel and has a back button.
  
  `NotificationsDrawer` (from `notifications-context`) now holds a popover `handle` that every bell opens, in place of `open(screen)`. `NotificationDrawer` takes `handle`, `onOpen(screen)` and `onClose()` in place of `onOpenChange`.

### Patch Changes

- 77fd631: A bar button stays lit while the panel it opened is open. New `fillOverPhoto` color and `_hoverOrOpen` condition.
- 923e65b: Top bar tooltips are design-system tooltips: a frosted pill under the item that stays on its screen. `Tooltip` takes a `tone`, and `Popover` takes a `tooltip` for its trigger.
- 3f7e261: Gmail's unread count is a badge on the item's end corner, like Messages and the notification bell; the item shows the inbox total. The badge is the new `CountBadge` component, which Messages and the bell now share. Messages caps its badge at "9+" and pops it in, as the bell does.
- 3146073: Each package asks for the bun and Node its workspace does: `engines` is `bun >=1.4.2`, `node >=24`.
- 0abccd9: New manganese commands, for a key or `domicile send-shell`: `notifications` toggles the notification drawer, `notifications clear` clears it, and `idle-inhibitor` toggles keeping the screens on.
- 44f23d6: The top bar is easier to read: the clock is larger, workspaces are numbers with the current one on a lit square instead of a white disc, and bar buttons light up as rounded squares like the rest of the desktop.
- Updated dependencies [a3c11aa]
- Updated dependencies [bafd922]
- Updated dependencies [77fd631]
- Updated dependencies [9e60e1e]
- Updated dependencies [a62f35a]
- Updated dependencies [923e65b]
- Updated dependencies [cb4d2f9]
- Updated dependencies [44eb13c]
- Updated dependencies [3980a9a]
- Updated dependencies [c7a232d]
- Updated dependencies [66d220b]
- Updated dependencies [c99bfef]
- Updated dependencies [d961736]
- Updated dependencies [a2def76]
- Updated dependencies [eca2588]
- Updated dependencies [f15f43a]
- Updated dependencies [7c8d9e2]
- Updated dependencies [fc3ee2f]
- Updated dependencies [9d0934e]
- Updated dependencies [a9a62e8]
- Updated dependencies [fa78a81]
- Updated dependencies [509f948]
- Updated dependencies [a2ee8ea]
- Updated dependencies [c429bd5]
- Updated dependencies [c80cd2a]
- Updated dependencies [f71cc09]
- Updated dependencies [aeb6f92]
- Updated dependencies [ab2d2f0]
- Updated dependencies [0e8c788]
- Updated dependencies [a1569c6]
- Updated dependencies [6fecbbd]
- Updated dependencies [258d9aa]
- Updated dependencies [d9f5353]
- Updated dependencies [fb9e591]
- Updated dependencies [14e6071]
- Updated dependencies [56e1c22]
- Updated dependencies [54472b5]
- Updated dependencies [506b12f]
- Updated dependencies [00e5da2]
- Updated dependencies [75b9403]
- Updated dependencies [3f7e261]
- Updated dependencies [b49fa3a]
- Updated dependencies [6730912]
- Updated dependencies [2a87739]
- Updated dependencies [2d2289b]
- Updated dependencies [7a29c8f]
- Updated dependencies [a113605]
- Updated dependencies [f6f6e5b]
- Updated dependencies [d4b9da4]
- Updated dependencies [4967b5d]
- Updated dependencies [be59aae]
- Updated dependencies [44d0983]
- Updated dependencies [7ac9e00]
- Updated dependencies [5bdc699]
- Updated dependencies [6825067]
- Updated dependencies [cd02e0e]
- Updated dependencies [840418d]
- Updated dependencies [7aa450b]
- Updated dependencies [a472a59]
- Updated dependencies [0aa24da]
- Updated dependencies [e1205bb]
- Updated dependencies [cd83e49]
- Updated dependencies [40d7378]
- Updated dependencies [cbaa64e]
- Updated dependencies [1fcf33a]
- Updated dependencies [670713c]
- Updated dependencies [e7cbd52]
- Updated dependencies [8bc5b85]
- Updated dependencies [4ee2c21]
- Updated dependencies [3146073]
- Updated dependencies [e83ec4a]
- Updated dependencies [7a786a4]
- Updated dependencies [4759ab2]
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
- Updated dependencies [599d60f]
- Updated dependencies [74a9564]
- Updated dependencies [2430e48]
- Updated dependencies [9fd298a]
- Updated dependencies [c4fe915]
- Updated dependencies [065ff4b]
- Updated dependencies [1e2aeca]
- Updated dependencies [b39d80e]
- Updated dependencies [21b82af]
- Updated dependencies [427c184]
- Updated dependencies [ee63a45]
- Updated dependencies [5a6a4fc]
- Updated dependencies [9664607]
- Updated dependencies [25b9bd3]
- Updated dependencies [113dabe]
- Updated dependencies [0bd0d2a]
- Updated dependencies [b741b92]
- Updated dependencies [570e7bb]
- Updated dependencies [2edc3c1]
- Updated dependencies [b241f68]
- Updated dependencies [5d2376e]
- Updated dependencies [6c3db42]
- Updated dependencies [63728a9]
  - @domicile-desktop/manganese-notifications@1.1.0
  - @domicile-desktop/component-library@2.0.0
  - @domicile-desktop/manganese-bar@1.1.0

## 1.0.0

### Major Changes

- 2056529: The first release.

### Patch Changes

- Updated dependencies [2056529]
  - @domicile-desktop/component-library@1.0.0
  - @domicile-desktop/manganese-bar@1.0.0
  - @domicile-desktop/manganese-notifications@1.0.0
