# @domicile-desktop/manganese-quick-settings

## 1.0.3

### Patch Changes

- @domicile-desktop/component-library@2.1.1
  - @domicile-desktop/manganese-bar-module-battery@1.1.3
  - @domicile-desktop/manganese-bar-module-bluetooth@1.1.3
  - @domicile-desktop/manganese-bar-module-brightness@2.0.3
  - @domicile-desktop/manganese-bar-module-idle-inhibitor@1.1.3
  - @domicile-desktop/manganese-bar-module-network@1.1.3
  - @domicile-desktop/manganese-bar-module-volume@2.0.3
  - @domicile-desktop/react@0.1.3
  - @domicile-desktop/manganese-bar@1.1.3
  - @domicile-desktop/manganese-bar-module-theme-switch@1.1.3

## 1.0.2

### Patch Changes

- Updated dependencies [f9bbf5d]
- Updated dependencies [62ccd23]
- Updated dependencies [c1988f7]
- Updated dependencies [e81703a]
- Updated dependencies [3d22f74]
- Updated dependencies [75708d7]
- Updated dependencies [50318b4]
- Updated dependencies [eeb9468]
  - @domicile-desktop/component-library@2.1.0
  - @domicile-desktop/manganese-bar-module-network@1.1.2
  - @domicile-desktop/manganese-bar@1.1.2
  - @domicile-desktop/manganese-bar-module-battery@1.1.2
  - @domicile-desktop/manganese-bar-module-bluetooth@1.1.2
  - @domicile-desktop/manganese-bar-module-brightness@2.0.2
  - @domicile-desktop/manganese-bar-module-idle-inhibitor@1.1.2
  - @domicile-desktop/manganese-bar-module-theme-switch@1.1.2
  - @domicile-desktop/manganese-bar-module-volume@2.0.2
  - @domicile-desktop/react@0.1.2

## 1.0.1

### Patch Changes

- @domicile-desktop/component-library@2.0.1
  - @domicile-desktop/manganese-bar-module-battery@1.1.1
  - @domicile-desktop/manganese-bar-module-bluetooth@1.1.1
  - @domicile-desktop/manganese-bar-module-brightness@2.0.1
  - @domicile-desktop/manganese-bar-module-idle-inhibitor@1.1.1
  - @domicile-desktop/manganese-bar-module-network@1.1.1
  - @domicile-desktop/manganese-bar-module-volume@2.0.1
  - @domicile-desktop/react@0.1.1
  - @domicile-desktop/manganese-bar@1.1.1
  - @domicile-desktop/manganese-bar-module-theme-switch@1.1.1

## 1.0.0

### Major Changes

- 54472b5: Bar items ease in, out and between widths: each sits in a new `FluidItem`, which follows its content's width, fades as it comes and goes, and keeps what left drawn until it has faded. Quick settings' icons do the same. `QuickSettingsParts.Indicators` is now a list of components, one per icon.

### Minor Changes

- 10ee944: A keep awake pill in the default bar shows while anything keeps the screens on, names the apps, and turns off your own hold. Quick settings' button drops its eye, and `KeepAwakeIndicator` is gone.
- a1f9bb9: `QuickSettings` moves to its own package, `@domicile-desktop/manganese-quick-settings`. `@domicile-desktop/manganese/QuickSettings` is gone. The separate hardware bar items stay.

### Patch Changes

- 77fd631: A bar button stays lit while the panel it opened is open. New `fillOverPhoto` color and `_hoverOrOpen` condition.
- f71cc09: The Downloads bar item's panel opens by itself as a download starts, on the screen with the keyboard, and stays until dismissed. Removed downloads slide out as cleared notifications do. As the last download finishes, the item eases from its percent to a check and "Done", then back to its icon. Opening a file no app opens says so, in the downloads panel and in the launcher, instead of doing nothing.
  
  - `LeavingRow` and `useLeavingRows` (component library) hold the notification drawer's arrive and leave motion; `ListRow` takes it as `motion`.
  - `Bar` has `popsUp`: whether an item may open its panel by itself.
  - `opens` and `nothingOpens` (`@domicile-desktop/system-apps/opens`) ask `domicile open --which` before opening a file.
  - `Launcher` takes `opens`.
- 7a29c8f: Icons in the bar, quick settings and level notices move when their state changes or they are pointed at: the bell swings, Wi-Fi arcs fill out, Bluetooth dots slide out, speaker waves pulse, a slash draws across what is off, the dark mode sun turns to a moon, and more. New `Animated*Icon` components and `_controlHover` / `_controlActive` conditions in the component library. The notifications bar item no longer exports a Panda preset.
- 7a786a4: Quick settings, its Wi-Fi, Bluetooth and Sound details, and the notifications panel are built from shared panel parts (`Panel`, `PanelHeader`, `PanelSection`, `ListRow`, `DetailList`, `SliderRow`, `PanelNote`, `PanelFooter`, `IconButton`) with one type scale and set of colors, so they line up and nothing spills out of its panel. Bluetooth devices are grouped as connected, paired and nearby; refusals say what failed in plain words; and a panel opened with the pointer no longer shows a focus ring on its first control.
- d138939: Center the quick settings button's icons. The Wi-Fi icon dims its unlit arcs instead of hiding them, so it keeps its shape at any signal. The battery in the button drops its own inset and the room it kept for `100%` (new `fitted` prop, `BatteryIndicator` export), so both ends of the button match.
- 9a2597b: Quick settings closes on the details it shows, rather than sliding back to the tiles as it closes.
- 4064278: Quick settings is tidier. The panel is narrower and evenly padded. A tile's status line is easier to read on the accent color. The brightness and volume sliders start and end together, and their percentages are larger. The battery line and Settings button are smaller and quieter. The mixer's captions match the slider figures.
- f4a973d: Quick settings: Wi-Fi and Bluetooth tiles open their panels instead of switching; Keep awake, Night light and Dark mode become a row of switches (`QuickToggle`). The network panel groups by Wired and Wi-Fi with details folded away (`ListRow` `disclosure`). Sound lists outputs and inputs by port name to pick from.
- 44f23d6: The top bar is easier to read: the clock is larger, workspaces are numbers with the current one on a lit square instead of a white disc, and bar buttons light up as rounded squares like the rest of the desktop.
- Updated dependencies [bafd922]
- Updated dependencies [8fa9c05]
- Updated dependencies [77fd631]
- Updated dependencies [1caba05]
- Updated dependencies [9e60e1e]
- Updated dependencies [6bbc80b]
- Updated dependencies [a62f35a]
- Updated dependencies [923e65b]
- Updated dependencies [cb4d2f9]
- Updated dependencies [44eb13c]
- Updated dependencies [3980a9a]
- Updated dependencies [623860a]
- Updated dependencies [c7a232d]
- Updated dependencies [66d220b]
- Updated dependencies [a2def76]
- Updated dependencies [eca2588]
- Updated dependencies [f15f43a]
- Updated dependencies [487c705]
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
- Updated dependencies [4967b5d]
- Updated dependencies [be59aae]
- Updated dependencies [a999398]
- Updated dependencies [4917e8f]
- Updated dependencies [9d4a876]
- Updated dependencies [10ee944]
- Updated dependencies [44d0983]
- Updated dependencies [7ac9e00]
- Updated dependencies [6825067]
- Updated dependencies [cd02e0e]
- Updated dependencies [840418d]
- Updated dependencies [7aa450b]
- Updated dependencies [1ad2756]
- Updated dependencies [a472a59]
- Updated dependencies [b85d9bb]
- Updated dependencies [01b9340]
- Updated dependencies [558794b]
- Updated dependencies [59b63cd]
- Updated dependencies [35bf5de]
- Updated dependencies [fccc784]
- Updated dependencies [e1205bb]
- Updated dependencies [40d7378]
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
- Updated dependencies [1f1775a]
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
- Updated dependencies [2430e48]
- Updated dependencies [9fd298a]
- Updated dependencies [c4fe915]
- Updated dependencies [065ff4b]
- Updated dependencies [1e2aeca]
- Updated dependencies [b39d80e]
- Updated dependencies [21b82af]
- Updated dependencies [427c184]
- Updated dependencies [ee63a45]
- Updated dependencies [f8b1742]
- Updated dependencies [0abccd9]
- Updated dependencies [5a6a4fc]
- Updated dependencies [25b9bd3]
- Updated dependencies [113dabe]
- Updated dependencies [0bd0d2a]
- Updated dependencies [1971d87]
- Updated dependencies [b741b92]
- Updated dependencies [570e7bb]
- Updated dependencies [2edc3c1]
- Updated dependencies [b241f68]
- Updated dependencies [5d2376e]
- Updated dependencies [44f23d6]
- Updated dependencies [6c3db42]
- Updated dependencies [42f1cd0]
- Updated dependencies [1d6f437]
- Updated dependencies [63728a9]
  - @domicile-desktop/component-library@2.0.0
  - @domicile-desktop/manganese-bar-module-brightness@2.0.0
  - @domicile-desktop/manganese-bar-module-bluetooth@1.1.0
  - @domicile-desktop/manganese-bar-module-network@1.1.0
  - @domicile-desktop/manganese-bar-module-volume@2.0.0
  - @domicile-desktop/manganese-bar-module-idle-inhibitor@1.1.0
  - @domicile-desktop/manganese-bar@1.1.0
  - @domicile-desktop/manganese-bar-module-battery@1.1.0
  - @domicile-desktop/manganese-bar-module-theme-switch@1.1.0
  - @domicile-desktop/react@0.1.0
