# @domicile-desktop/manganese-bar-module-workspace-switcher

## 1.2.1

### Patch Changes

- Updated dependencies [d566f68]
- Updated dependencies [24b88fb]
- Updated dependencies [3e37020]
- Updated dependencies [eaa92c7]
- Updated dependencies [1209f22]
- Updated dependencies [da632d6]
- Updated dependencies [a5ade39]
- Updated dependencies [6a0772b]
- Updated dependencies [b5edfcd]
- Updated dependencies [0ee4ce8]
- Updated dependencies [637cc16]
- Updated dependencies [9bd54ab]
- Updated dependencies [19cc2c5]
- Updated dependencies [64bda78]
- Updated dependencies [4b7a878]
- Updated dependencies [9ea68bf]
- Updated dependencies [5090cbd]
  - @domicile-desktop/manganese-window-management@1.4.0
  - @domicile-desktop/component-library@2.1.1
  - @domicile-desktop/manganese-bar@1.1.3

## 1.2.0

### Minor Changes

- 62ccd23: Manganese has an overview: each monitor's workspaces at once, with their live windows. Open it with Meta+O, a four-finger pinch in, or the new button before the workspaces in the bar. Click a workspace or a window to go there, or drag a window onto another workspace to move it. A four-finger pinch out opens the launcher, whose button now shows a sparkle that twinkles when pointed at. The component library adds `AnimatedSparkleIcon`.

### Patch Changes

- e481089: The workspace switcher's white chip slides to the new workspace with a small bounce, and each number turns black as the chip passes under it.
- 75708d7: The workspace switcher's chip slides smoothly when a workspace comes or goes at the end of the row: the bar items beside its empty middle no longer clip while they resize (`FluidItem`'s new `overflow` prop), and the chip's clip no longer depends on the row's width.
- Updated dependencies [f9bbf5d]
- Updated dependencies [28e836c]
- Updated dependencies [76c4390]
- Updated dependencies [6930e8f]
- Updated dependencies [c664ef4]
- Updated dependencies [7371c33]
- Updated dependencies [1af639c]
- Updated dependencies [cd7e4ba]
- Updated dependencies [b3e7457]
- Updated dependencies [62ccd23]
- Updated dependencies [55194ce]
- Updated dependencies [8375015]
- Updated dependencies [bb1e4cb]
- Updated dependencies [c1988f7]
- Updated dependencies [f6dc5b2]
- Updated dependencies [e2a04a5]
- Updated dependencies [e81703a]
- Updated dependencies [174918e]
- Updated dependencies [e2418db]
- Updated dependencies [1df09a6]
- Updated dependencies [f592184]
- Updated dependencies [18413ff]
- Updated dependencies [69fe0d8]
- Updated dependencies [3d22f74]
- Updated dependencies [92a4035]
- Updated dependencies [a354497]
- Updated dependencies [280ce42]
- Updated dependencies [75708d7]
- Updated dependencies [9246b97]
- Updated dependencies [50318b4]
- Updated dependencies [f4f993a]
- Updated dependencies [87ad25a]
- Updated dependencies [56adc6f]
- Updated dependencies [eeb9468]
  - @domicile-desktop/component-library@2.1.0
  - @domicile-desktop/manganese-window-management@1.3.0
  - @domicile-desktop/manganese-bar@1.1.2

## 1.1.1

### Patch Changes

- a333799: Crossfade the workspace switcher's chip between workspaces again.
- Updated dependencies [fdad979]
  - @domicile-desktop/manganese-window-management@1.2.0
  - @domicile-desktop/component-library@2.0.1
  - @domicile-desktop/manganese-bar@1.1.1

## 1.1.0

### Minor Changes

- 44f23d6: The top bar is easier to read: the clock is larger, workspaces are numbers with the current one on a lit square instead of a white disc, and bar buttons light up as rounded squares like the rest of the desktop.

### Patch Changes

- a62f35a: Bar item text (battery, keyboard layout, Gmail, mode, tray letters) is 13px, like the clock. New `fontSizes.ui` token (13px), the desktop's one text size.
- 3146073: Each package asks for the bun and Node its workspace does: `engines` is `bun >=1.4.2`, `node >=24`.
- b4a16b1: Make the current workspace easier to see: a solid white chip, an outline when it's shown on another screen, and brighter numbers for the rest.
- Updated dependencies [aa215a9]
- Updated dependencies [bafd922]
- Updated dependencies [77fd631]
- Updated dependencies [9e60e1e]
- Updated dependencies [a62f35a]
- Updated dependencies [923e65b]
- Updated dependencies [cb4d2f9]
- Updated dependencies [44eb13c]
- Updated dependencies [3980a9a]
- Updated dependencies [c7a232d]
- Updated dependencies [59b3d65]
- Updated dependencies [66d220b]
- Updated dependencies [a2def76]
- Updated dependencies [eca2588]
- Updated dependencies [f15f43a]
- Updated dependencies [7c8d9e2]
- Updated dependencies [fc3ee2f]
- Updated dependencies [9d0934e]
- Updated dependencies [bb92965]
- Updated dependencies [a9a62e8]
- Updated dependencies [fa78a81]
- Updated dependencies [509f948]
- Updated dependencies [1062efc]
- Updated dependencies [a2ee8ea]
- Updated dependencies [c80cd2a]
- Updated dependencies [e455955]
- Updated dependencies [9fe15f8]
- Updated dependencies [f71cc09]
- Updated dependencies [aeb6f92]
- Updated dependencies [7c948b4]
- Updated dependencies [f3cb310]
- Updated dependencies [e60eb1f]
- Updated dependencies [ab2d2f0]
- Updated dependencies [0e8c788]
- Updated dependencies [62a671f]
- Updated dependencies [a1569c6]
- Updated dependencies [6fecbbd]
- Updated dependencies [258d9aa]
- Updated dependencies [d9f5353]
- Updated dependencies [fb9e591]
- Updated dependencies [14e6071]
- Updated dependencies [56e1c22]
- Updated dependencies [e0bf6c2]
- Updated dependencies [7646678]
- Updated dependencies [920763e]
- Updated dependencies [98d378e]
- Updated dependencies [83f9f2d]
- Updated dependencies [54472b5]
- Updated dependencies [64b22f3]
- Updated dependencies [542a309]
- Updated dependencies [506b12f]
- Updated dependencies [a390b06]
- Updated dependencies [00e5da2]
- Updated dependencies [75b9403]
- Updated dependencies [3f7e261]
- Updated dependencies [b49fa3a]
- Updated dependencies [c9c75a8]
- Updated dependencies [8bc5b85]
- Updated dependencies [6730912]
- Updated dependencies [2a87739]
- Updated dependencies [2d2289b]
- Updated dependencies [7a29c8f]
- Updated dependencies [a113605]
- Updated dependencies [4967b5d]
- Updated dependencies [be59aae]
- Updated dependencies [9b8a4f0]
- Updated dependencies [44d0983]
- Updated dependencies [7ac9e00]
- Updated dependencies [6825067]
- Updated dependencies [cd02e0e]
- Updated dependencies [452a746]
- Updated dependencies [840418d]
- Updated dependencies [7aa450b]
- Updated dependencies [1ad2756]
- Updated dependencies [a472a59]
- Updated dependencies [93f015d]
- Updated dependencies [e781b22]
- Updated dependencies [6b2a242]
- Updated dependencies [9a0cf19]
- Updated dependencies [2425185]
- Updated dependencies [e1205bb]
- Updated dependencies [40d7378]
- Updated dependencies [1fcf33a]
- Updated dependencies [c4b7781]
- Updated dependencies [670713c]
- Updated dependencies [e7cbd52]
- Updated dependencies [8bc5b85]
- Updated dependencies [4ee2c21]
- Updated dependencies [3146073]
- Updated dependencies [d210cae]
- Updated dependencies [d95ffb2]
- Updated dependencies [e83ec4a]
- Updated dependencies [7a786a4]
- Updated dependencies [4759ab2]
- Updated dependencies [48ab992]
- Updated dependencies [3bb9bd5]
- Updated dependencies [0f4582e]
- Updated dependencies [d80e2f5]
- Updated dependencies [58d2cfe]
- Updated dependencies [c15ba93]
- Updated dependencies [2fe5852]
- Updated dependencies [a5bff8c]
- Updated dependencies [52a1d65]
- Updated dependencies [3e5b976]
- Updated dependencies [50f2549]
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
- Updated dependencies [45c846a]
- Updated dependencies [0bbe0f9]
- Updated dependencies [acfe355]
- Updated dependencies [b39d80e]
- Updated dependencies [21b82af]
- Updated dependencies [427c184]
- Updated dependencies [ee63a45]
- Updated dependencies [f8b1742]
- Updated dependencies [e97b6b2]
- Updated dependencies [0abccd9]
- Updated dependencies [5a6a4fc]
- Updated dependencies [ca8979b]
- Updated dependencies [dc66097]
- Updated dependencies [25b9bd3]
- Updated dependencies [113dabe]
- Updated dependencies [0bd0d2a]
- Updated dependencies [6a34b99]
- Updated dependencies [da8b0a7]
- Updated dependencies [48d5b1a]
- Updated dependencies [559480f]
- Updated dependencies [f45bf2b]
- Updated dependencies [4096040]
- Updated dependencies [078546d]
- Updated dependencies [46f285a]
- Updated dependencies [b741b92]
- Updated dependencies [570e7bb]
- Updated dependencies [2edc3c1]
- Updated dependencies [b241f68]
- Updated dependencies [5d2376e]
- Updated dependencies [6c3db42]
- Updated dependencies [0c58b28]
- Updated dependencies [d3847ed]
- Updated dependencies [eb6b52a]
- Updated dependencies [d862eaa]
- Updated dependencies [63728a9]
- Updated dependencies [bc587f5]
  - @domicile-desktop/manganese-window-management@1.1.0
  - @domicile-desktop/component-library@2.0.0
  - @domicile-desktop/manganese-bar@1.1.0

## 1.0.0

### Major Changes

- 2056529: The first release.

### Patch Changes

- Updated dependencies [c705ff5]
- Updated dependencies [2056529]
  - @domicile-desktop/manganese-window-management@1.0.0
  - @domicile-desktop/component-library@1.0.0
  - @domicile-desktop/manganese-bar@1.0.0
