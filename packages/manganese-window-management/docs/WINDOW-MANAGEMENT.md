# Window management

Manganese uses sway's layout model. For the key bindings, see
[KEYS.md](KEYS.md).

## Layout

- Each workspace holds a tree. Windows are leaves; containers lay out their
  children split, tabbed or stacking.
- Tiled windows have a 20px gap between them and at the screen's sides and
  bottom, which the focus glow lights. A lone window keeps the gap at the
  edges. The top edge has half the gap, 10px, since the top bar already
  separates windows from the screen's edge.
- Every tiled window is in a tab group, and a split holds only groups
  (`tree/grouped.ts`). A new window opens as a tab just after the focused
  one. Closing a window gives its space to the rest.
- Splitting is a move: a window moved, dropped or split out of a group lands
  in a group of its own. There is no opening straight into a split.
- A window moved out of a group into a split takes an even share, and the
  rest keep their relative sizes. Moving it on into the next group gives the
  split its old sizes back.
- Closing the focused window focuses the one in its group focused most
  recently before it, as sway's focus stack does. Each window records when it
  last took focus, and keeps that when it moves.
- The first window on a workspace opens in a tab group of one, so the next
  window's place shows.
- A group changes only on request (a layout or split command, a move or a
  drop). Closing down to one window keeps the group. A group left holding only
  another group is replaced by it, and so is a split left holding one group.
- `split h` / `split v` (Meta+B / Meta+V) move the window out of its group, to
  the group's right or below it. A window alone in its group stays put.
- `layout toggle split` (Meta+E) on a group splits its tabs into groups of
  their own. On a window alone in its group, it turns the split around the
  group between a row and a column. `layout tabbed` or `layout stacking` on a split merges its groups'
  windows into one group. On a group already in that layout, it acts on the
  split around the group.
- `move <direction>` moves a window alone in its group as the group would: into
  the next group that way, as a tab. A tab moves along its strip, then out of
  the group past its end. A selected group moves the same way, nesting as a
  tab of the group it enters.
- `group` (Meta+G) turns the focused tab into a group of one in the same
  slot. New windows open in it, and `split h` / `split v` inside it make a
  split within the outer tab. Moving its last window out removes it.
- Every edge of a split lies on a whole pixel, as a float's does. Shares are
  kept exact; only the boxes round.
- There are 10 workspaces for the whole desktop, plus the scratchpad and floating
  windows.
- A window is either a Wayland client or a browser window the shell opened.
- Until the compositor reports the screens, only the wallpaper is drawn. A
  desktop with no screens shows a message.

## Screens

Workspaces belong to the desktop, and screens show them, as in sway:

- A workspace shows on one screen at a time.
- `workspace 2` goes to the screen already showing workspace 2.
- A hidden workspace belongs to the screen that last showed it. Only that
  screen's bar lists it.
- An empty workspace opens on the screen with the keyboard.
- A window opens on the screen with the keyboard.
- Two screens never show one workspace. A client surface can be shown in only
  one place, so a second copy would blank the first.

## Focus

- **Focus follows the pointer.** The window under the pointer gets the
  keyboard. No click needed. This is one case in `reduceWindows`; a shell that
  wants click-to-focus changes only that case. Holding Meta does not stop it:
  the sheets that catch Meta+drag report the pointer entering too. A tab
  group's strip counts as its open window.
- **Hovering does not raise.** A click raises.
- **The screen under the pointer gets the keyboard**, even with no window on
  it (`src/screens/useScreenFollowsPointer.ts`).
- **`focus <direction>`** past the edge of a workspace or a fullscreen window
  moves to the next screen that way, then wraps.
- **`move <direction>`** past the edge of a workspace moves the tiled window
  (or `focus parent` selection) to the next screen that way, as in sway. It
  enters that screen's tiling on the near side, and focus follows it. Floats
  and fullscreen windows stay put.
- **The chrome does not take focus.** The bar, wallpaper and title bars leave
  the keyboard where it was.
- **The focused window stands out.** An accent ring and glow surround it
  (`FocusGlow.tsx`), lighting the gaps around it. A window in a tab group
  lights the whole group, tabs included. Its title bar is raised with bold
  text. The glow fades out and in where it is, rather than moving to the next
  window, so pointer-driven focus changes don't flash or slide. A glow that
  has faded out leaves the page (`useFocusGlows`).
- **Meta+A selects a group.** Commands then act on the whole container. One
  glow surrounds the group, and an accent tint covers its tabs, windows and
  the gaps between them (`SelectionTint.tsx`). The tint tells a selected tab
  group from its focused tab, since the glow lights the whole tab group for
  both. A group selected inside another group's tab is lit in its well,
  without that tab. A fullscreen group keeps its glow and tint while
  selected. The focused window's bar gets the accent color; tabs keep
  their usual states. Meta+Shift+A, focusing a floating window, clicking
  or typing in any window, pressing a title bar or tab inside the group, or
  the pointer coming back from another screen ends the selection, leaving
  that window selected.
- **`xdg-activation` requests are granted.** The compositor forwards them as
  `focus_requested`. Manganese switches to that window's workspace, shows its
  tab, focuses it and warps the pointer to it. A browser window whose page or
  extension asks to come forward (`domicile-focus-request`) is treated the
  same, as is one whose page asks to stay as it closes (a `beforeunload`
  dialog). The compositor drops requests made before the keyboard last moved, so a
  window cannot take focus back after the user moved on. Manganese ignores a
  window asking for the keyboard it already has, so a client asking as the
  keyboard enters it cannot take it back from a window opened since.

### Pointer warping

The pointer follows keyboard focus (sway's `mouse_warping container`):

- The pointer warps only when it will not be over the newly focused window,
  title bar included, once the layout settles. A window that slides in under
  the pointer, such as a neighbor filling a closed window's space, leaves it
  where it is. `warpTo` in `src/pointer-warp.ts` holds this rule for every
  focus change below. The engine checks where the pointer is, since the shell
  cannot see it move over a browser window's page.
- A keyed focus change, or a granted focus request, warps the pointer to the
  center of the new window's contents. An empty screen warps to its center.
- A window that opens with the keyboard also warps the pointer, but only when
  the pointer is over another window. Over the top bar or an empty workspace,
  it stays put.
- Focus changes on `pointerover` only when the pointer moves, however slowly.
  A window sliding under a still pointer does not take focus.

### Browser windows

- A pointer that enters a browser window directly over its page (not its
  chrome) may not move focus until a click.
- Clicking in the address bar keeps the caret there.
- A background app's window (`useWindows`' `backgroundApps`, such as the
  Messages inbox) opens hidden, shows when its app asks for focus, and hides
  instead of closing, so its page keeps running.

For how warping, browser-window focus and modifier drags work, see
[FOCUS-INTERNALS.md](FOCUS-INTERNALS.md).

## Fullscreen

- **Meta+F** fills the screen with the focused window, or with the group after
  **Meta+A**. A fullscreen group keeps its layout and tab strips.
- A fullscreen group follows its windows: it takes in windows opened inside it
  and survives splits, moves and closes inside it (`fullscreenKept`). It ends
  with its last window.
- A browser window fills its screen while its page is fullscreen, such as
  after a video's fullscreen button (`pageFullscreened`), and hides its title
  bar or tab and its address bar, even if Meta+F made it fullscreen. Leaving
  fullscreen with Meta+F takes the page out too.
- A client window fills its screen while its client asks to be fullscreen,
  the same way. Maximize requests change nothing, as in sway.

## Client states

`AppWindow` sets each client's `xdg_toplevel` states, so a client that draws
its own frame leaves out its shadow, rounded corners and resize border:

- tiled: `tiled_left`, `tiled_right`, `tiled_top`, `tiled_bottom`
- floating: none, as in sway
- fullscreen on its own: `fullscreen`

## Floating windows

- **Meta+Shift+Tab** floats the window, or tiles it again at the tiling focus.
  New floats cascade from the previous ones. A click raises a float.
- A floated window goes in a tabbed container, so new windows opened while it
  has the keyboard join it as tabs. Tiling it again drops the container when
  it holds one window.
- After **Meta+A**, the whole selected container floats as one box and keeps
  its layout. Tiling keys work inside it. A new window opened while the
  keyboard is in a floating group joins that group.
- **Dragging a lone float's bar** moves it. Let go over another group's tab,
  it joins that group beside the tab.
- **Dragging a tab of a floating group of several** pulls it out, as dragging
  a tiled window does (see below). **Dragging the strip's empty end** moves
  the whole float.
- **Meta+drag** moves a float. **Meta+Shift+drag** or **Meta+right-drag**
  resizes from the nearest corner. The mode is fixed when the drag starts.
- The Shift used to float a window does not count as the resize modifier until
  it is released and pressed again.
- **Edges resize without a modifier**: a strip along each edge and a larger
  square at each corner (`floating/float-borders.ts`). Over the title bar,
  only the outside strip is a border.
- A float can't be resized below 240×120 px, and its top-left corner stays on
  the desktop.
- **A float moves to the screen its center is dragged onto**, as in sway
  (`floatDragged`). A browser window crosses screens without reloading.
- A scratchpad window shows as wide and tall as the screen, less 48px at the
  sides and bottom, flush with the screen's top edge (`scratchpadFloatFor`).
  Its top corners are square.
- **A scratchpad window is modal.** A backdrop dims the screen under it
  (`ScratchpadBackdrop.tsx`); a press on the backdrop hides the window. The
  focus ring stays on the window focus returns to when it hides.
- A float casts a shadow (`FloatShadow.tsx`), except when fullscreen.
- Stacking order is the `z-index` of the window's element, so drawing order and
  hit-testing order match.
- A window's open tab and popups draw one above the window (`raised`), so
  tabs that swap slide under the open one. Floats are two apart to leave room.
- A tiled window moving to another tab group draws over every tiled strip
  while it eases there, under every float (`crossing.ts`).
- Raising a float over one it overlaps animates the two swapping places.
  Every part of a float moves as one, hidden tabs and nested groups included
  (`restacking.ts`).

### Opening floating

A client window opens floating, as sway opens a dialog, when:

- its client gave it a parent (`xdg_toplevel.set_parent`), or
- its client fixed its size: a minimum on both axes, and a maximum equal to
  it on either, or
- a `floating` rule matches it. A rule's `app` and `title` are regular
  expressions on the window's Wayland app id and its title when it first
  draws. A rule matches when every pattern it gives does:

  ```ts
  export const Shell = runManganese({
    floating: [{ app: "pinentry" }, { app: "^Slack$", title: "^Huddle" }],
  });
  ```

Such a window:

- opens in the middle of the screen with the keyboard, its contents the size
  the client drew (`floatCenteredFor`). It is not put in a tabbed container,
  so new windows still tile.
- has no title bar if its client asked to draw its own frame
  (`DomicileWindow.clientFrame`), such as a frameless Electron window. Its
  client draws over the whole box (`isBare`). Meta+drag still moves it and its
  edges still resize it. Floating it again after tiling it brings the bar
  back.

The decision is made once, when the window first draws: the compositor
announces a window only then, so its title, app id and limits are known.

A browser window opens floating at the size it asked for when an extension's
`chrome.windows.create` or a page's `window.open()` gave a width or height,
such as a Slack huddle.

## Dragging windows and tabs

- **Meta+drag**, or dragging its title bar, picks up a tiled window. An
  overlay shows where it will land: half of a target puts it on that side; the
  center puts it in the target's tab group, just after the target. A target
  outside a tab group becomes one with it. Dropping over
  nothing does nothing. See `tree/drop.ts`.
- **A drop can land on any screen.** Targets include tiled windows on other
  screens, and the whole of a screen with nothing tiled. Focus follows the
  window.
- **Dropping on a tab strip**, tiled or floating, puts the window in it as a
  tab, before or after the nearest tab, by which half of that tab the pointer
  is nearer. The overlay is a line between the two tabs. A float hides the
  targets behind it. Moving onto a strip, the box fades out where it was and
  the line fades in; leaving it, the box grows out of the line. A box scaled
  to a line would stretch its border and rounding into a blob.
- The overlay is drawn over the open tabs of the windows it aims at.
- **Dropping on the edge of a window in a tab group** puts the window beside
  the group, as in sway, in a group of its own. A nested group splits its
  place in the outer strip with it, as the overlay shows (`Beside.Apart`).
- **Dragging a tab over its own group** breaks it out of the group: it goes
  beside the group, on the half under the pointer.
- **Dragging the empty end of a tab strip**, past its last tab, picks up the
  whole tab group. It focuses the open tab and drops like a window, but never
  on a window inside it (`StripEnd.tsx`). It stays selected after the drop
  only if it was selected before the drag.
- **Dragging a tab along its strip** moves it at once into the slot nearest
  the pointer, with no overlay.
- **A nested group's tab** drags and drops like a window's tab, carrying the
  whole group (`GroupTitleBar.tsx`). Other tabs move past it and drop beside
  it; a group of one stays a group. Its own tabs drop beside it too, which
  takes them out of it, including past it from the strip's empty end.
- The pointer shows `grabbing` anywhere on the desktop while a window moves
  (`GrabbingSheet.tsx`).
- A move aims only once the pointer is 8px from the press, so clicking a tab
  never drops it beside its container's open tab.
- **Meta+right-drag** or **Meta+Shift+drag** resizes from the
  corner nearest the pointer. An edge on the screen's edge can't move, so the
  opposite edge follows the pointer instead. See `tree/stretch.ts`. Unlike a
  move, a resize does not make the window transparent.
- **Shared edges resize without a modifier**, over the window's border and the
  gap beside it (`tiled/borders.ts`).
- An edge drag, tiled or floating, ends at its release. A release the page
  never hears also ends it, at the first move with no button held or when the
  edge loses the pointer, so the edge never keeps the pointer
  (`follow-press.ts`).
- During an edge drag, windows keep taking the pointer: the edge holds it. A webview made click-through takes the pointer back only at the
  engine's next frame, so the moves and clicks just after the release would
  reach the desktop instead of the page.
- Fullscreen windows cannot be dragged, nor can a fullscreen group by its
  strip.

## Title bars

- Every window has a title bar: its name, a float/tile button (same as
  Meta+Shift+Tab), a fullscreen button (same as Meta+F) and a close button.
  The buttons act on their own window, never its group. A tab of a floating
  group tiles alone; the rest stays floating.
- A browser window's name is its page's title, or its site when the page has
  none.
- Each bar and tab draws its window's icon before the name, else a stand-in:
  - A client's: the first icon found of the desktop entry its Wayland app id
    names, the entries whose `StartupWMClass` is the app id (both matched in
    any case), and the icon named after the app id, in
    `theme.icon_theme`. Entries are read again when a new app id appears.
  - A browser window's: its page's icon.
- A middle click on a bar or tab closes its window. On a tab holding a group,
  it closes every window in the group.
- The bar is inside the window's box, so a window's size includes its bar.
- The contents reach 1px up under the bar (`SURFACE_TUCK`), so no sliver of
  the desktop shows between them at fractional scales.
- Only the top corners are rounded. The bottom of the frame is client pixels.
- The page hit-tests the bar, so clicks on it never reach the client.
- In a tabbed or stacking container, each window's tab is its title bar. The
  tabs rest in a tab strip, even a container of one.
- The strip is one box with a rounded top and an edge (`TabStrip.tsx`). Its
  bottom edge is the window's top edge; the open tab covers it to join its
  window.
- The group's open tab draws the strip, and its tabs lie on it, each drawn by
  its own window. A tab switch hands the strip to the next open tab.
- Tabs are at most 240px wide, so the strip always runs on past the last one.
- Resting the pointer on a tab shows its whole name in a tooltip, with a
  browser window's page description (`<meta name="description">`) under it.
- A "+" past a tabbed strip's last tab focuses the strip's open tab and opens
  the launcher, so the launched window opens as a tab beside it.
- Two buttons at the far end of a tabbed strip float/tile and fullscreen the
  whole group (`StripButtons.tsx`). Float selects the group as Meta+A does.
  Fullscreen focuses the strip's open tab and leaves the selection on it.
- A hidden tab shows only its close button. Dividers separate hidden tabs.
- A tab for a nested container shows the name of its last-focused window, an
  icon for its layout and its window count.
- A shown nested container sits in a well under its tab, in the open tab's
  color, with a 10px margin around its windows (`GroupWell.tsx`).
- A tab strip inside a well, its open tab and its own well draw a stronger
  edge, so they stand out on the well.
- A bar has four states, set as `data-focus` (`title-focus.ts`): sway's
  `focused`, `focused_inactive` and `unfocused`, plus `leaf` for the focused
  window inside a selected group.

## Overview

`overview` (Meta+O, the switcher's button) toggles, and `overview show`
(`pinch:4:inward`) and `overview hide` (`pinch:4:outward`) go one way. It shows each
screen's workspaces at once, as tiles in a grid (`overview/tiles.ts`): those
with windows, and the shown one.

- The windows are the real ones, scaled into their tile by a transform on
  a box inside each part's wrapper (`overview/seen-styles.ts`), so they stay
  live. A surface can only show in one place, so there are no copies.
- Both the wrapper and the box clip to the screen. The box's clip moves with
  it, keeping a float that hangs off the edge in its tile; the wrapper's
  does not, keeping windows coming in from beside off the next monitor. The
  wrapper takes its part's depth as its `z-index`, since the transformed box
  is its own stacking context.
- Hidden workspaces' windows get their placements as if shown. Coming in,
  their `<app>` or `<webview>` is `resizing`, so the engine shows the desk
  without waiting for them to draw again, as on a workspace switch. They
  never take the pointer (`shut`), from the start rather than as the
  overview closes, since that would restyle every part of every window.
- The box takes the move through `--overview-to`, which its window's parts
  reset, so setting it restyles the box alone. Not `@property`: registering
  any custom property slows every restyle.
- One camera per screen moves every tile, name and window together
  (`cameraOf`): opening, it pulls back from the shown workspace, whose tile
  starts filling the screen, so the others come in from the side they sit
  on. They come in from `--overview-from` by `@starting-style`, which only
  applies as an element comes into view (the box is `display: none` while
  its window has no placement). So a window already showing that moves to
  another tile mid-overview eases there instead of flying in again. Every
  move is a transition to `--overview-to`, never an animation, so closing
  partway through opening turns back from where the camera got to. The
  names and rings fade in once it has all but landed.
- Closing, the camera pushes into the workspace picked, which grows to fill
  the screen while the others leave beside it and fade. The overview is gone
  when the backdrop's fade ends, which fades out under its own keyframe: a
  reversed animation that has played does not play again. The leaving
  windows, tab strips included, let presses through, since the picker over
  them is gone.
- `OverviewPicker` is a layer of buttons over the tiles: a click picks the
  workspace or the window under it, a main-button drag moves that window to
  another tile, arrows and Tab move between tiles and Escape closes.
- Workspace switch and send slides are skipped while it shows.
- While it is open, the reducer ignores commands that change windows or
  workspaces (`SHUT_IN_OVERVIEW`), and `useWindows` skips their side
  effects (`isShutInOverview`), so `kill` closes nothing. The bar's
  workspace buttons are ignored with the keys. The aim is forgotten once its
  workspace loses its tile. The desktop turns `focus <way>` into
  `OverviewAimed` and `move <way>` into `WorkspacesSwapped` first
  (`overview/steering.ts`), stepping through the tiles by `tileToward`:
  `focus` on to the monitor past the edge of its own's tiles, as
  `screenToward` picks outside the overview (`aimedToward`), `move` along
  its own monitor's. A
  swap trades two workspaces' windows and homes; the screen keeps showing
  what it showed, under its new name. Each card follows its windows
  (`overviewCards`, traded by each swap), drawn screen-sized through
  its tile by one eased matrix as the windows are, in a fixed document
  order, so a swap cut short turns back as its windows do. The names stay, as
  the workspaces' places.
- `useKeybindings` drops every key's command while it is open but its own,
  the launcher and clipboard toggles, lock, screenshot and the media keys
  (`HEARD_OVER_OVERVIEW`), as it does for the launcher.
- The picker's `Rings`, over every screen's picker, ring the aimed tile
  bold white and each shown one in the accent: the keys are grabbed before
  the page sees them, so focusing a tile never makes it `:focus-visible`.
  Each ring is keyed by the card under it, and the shown ones are kept in
  the cards' order, so a swap slides a ring with its card while aiming
  elsewhere moves it at once. The aim's ring crosses monitors with its
  card; a shown ring stays on its screen's place unless the card it rings
  is shown again elsewhere. An aim whose windows a swap leaves empty and
  unshown stays where it was. A hovered tile's own ring is faint, so it
  never reads as the aim.
- Opening it closes the launcher and clipboard, and opening either closes it.
- Opening it drops a window drag in progress, whose handles it hides.

## Animations

- Opening: fade in and grow from the center.
- Opening a tab: the tab opens out from its start as the tabs after it slide
  along; the contents grow out of the tab and fade in over the tab they
  hide, a little slower than a window opens so the move is seen.
- Rearranging: windows ease to their new boxes.
- Moving a tab along its strip, by keys or by dragging: the tabs slide to
  their new places, the moved one included.
- Closing: shrink and fade out.
- Sending to a workspace no screen shows: shrink further and fade out. A
  tab group leaves as one: every part scales about the group's middle.
- Closing a tab: it closes up toward its start as the tabs after it slide
  back. Its contents shrink into the tab and fade out over the tab it
  uncovers, as slowly as a new tab's grow out.
- An opening or closing tab's contents carry a ring and shadow while they
  move, so they show over a tab that looks like them. Both fade, so neither
  comes or goes in one frame. None in a group filling its screen, where the
  shadow would spill onto the next display.
- Sending away a tab: it shrinks and fades with its contents, as a sent
  window does, while the tabs after it slide back.
- Sending to the scratchpad: slide up off the top of the screen. Showing it
  slides the window back down. Each slide is the other played backwards, so
  one that cuts the other short starts where the window is
  (`DrawnWindow.rewound`). The backdrop fades with the slides.
- Workspace switch: the new workspace slides in; the old one slides out.
  Each window is clipped to its screen meanwhile, so it never shows on the
  next one, and to its workspace, so a float hanging off the screen never
  slides into view.
- Tab switch: crossfade. On a workspace sliding in, the tab switched to
  slides with it instead. Parts first drawn partway through (a hidden tab's
  contents, the strip it opens) start where the slide has got to
  (`DrawnWindow.shownRewound`).

Rules:

- Open and close use transforms. Resizing the element would reconfigure the
  client every frame.
- A browser window's page keeps its raster scale while a transform animation
  runs on it or a box around it, and takes the resting scale when it ends
  (engine patch 0233). Otherwise a heavy page rasters again every frame of an
  open, close or settle.
- Rearranging gives a window's contents their new box at once, so the client
  is configured once. The box then eases from the old one with `translate`
  and `scale` (`useSettling`). Eased boxes would hold every frame: the engine
  waits for a resized client to draw. Contents snap while a motion plays,
  since `scale` would scale the motion's travel. The ease takes
  `durations.fastest` under reduced motion.
- The box clips what it holds, which keeps its own size about the box's top
  left corner (`UPRIGHT`): the `<app>`, or a browser window's address bar and
  page. Scaling it would stretch the client's pixels; the box crops it
  instead.
- While the box settles, the contents keep their old size on each side where
  the box shrinks (`keptAt`), and take the new size when the settle ends. A
  shrinking box is drawn bigger than the new size at first, so a client
  already at that size would leave a gap between itself and the box's edge.
- The `<app>` or `<webview>` carries `resizing` while its box settles. The
  engine then shows the client's latest frame at its own size instead of
  holding the page for the client to draw: a held page starts the ease
  frames late, and the first frame shown is already well along it.
- Every other part of a window eases the same way: title bars, tabs, strips,
  glows, shadows and the drop indicator. One mechanism on one timing, on the
  compositor's thread, keeps the parts together: each edge moves linearly in
  the eased progress. Glows and shadows are drawn once at their new size and
  scale, blur included, so no frame repaints them.
- A bar keeps its icon, title and buttons at their own size (`UPRIGHT` in
  `useSettling`): they scale back by the inverse of the bar's scale, sampled
  in steps close enough to stay within a thousandth of their size. A title
  laid out wider than a growing bar is clipped by the bar and runs under its
  buttons.
- Depth never eases: each `z-index` step restacks the page's layers. A raise
  is at once. A part whose depth drops (`useLowered`) keeps its old depth
  until it has settled, so a window leaving fullscreen stays over the windows
  it still covers.
- A part drawn by a new element, such as a strip handed to the next open tab,
  eases from where the element it replaces was drawn (`SettleHandoffs`). A
  strip takes over only from one at its own nesting depth, not from the strip
  of a group around it.
- A window moved into or out of a nested group moves alone. The outer strip
  stays where it is, and the group's tab eases to its new slot. A window's
  strip at another depth is a new element (`TabStrip`), and a group's tab
  takes over from the one drawn before (`TitleBar`).
- A tab switch that hides a nested group hides its windows at once. They do
  not leave as windows sent to another workspace do.
- A float being dragged, or a window being resized, follows the pointer
  without easing. A dragged float carries all its windows, tabs and strip. A
  dragged tiled tab eases into each slot it moves to along its strip.
- A window sliding in from where it was not drawn (a workspace switch, the
  scratchpad) carries `resizing` too. Its client or page draws again as it
  comes in, and the engine would otherwise hold the desk up to four frames
  for it at the start of every slide.
- While an edge drag or a modifier resize runs, every `<app>` and `<webview>`
  carries `resizing`, so the engine does not wait for a client or page to draw
  each box. Every window, since a tiled edge resizes the windows on both
  sides.
- The title bar and contents scale about one shared center (`scaledAbout`).
- Only windows new since the last render animate open.
- Hidden windows (behind a tab, on another workspace) stay mounted, so client
  surfaces and pages stay alive. They are not drawn, and `AppWindow` reports an
  empty box so the compositor stops their clients drawing. A tab switch or a
  new tab draws the tab it hides under the new one until that one is in
  (`tab-switch.ts`). A closing tab's contents wait a moment before fading, so
  the tab it uncovers is drawn first (`movingStyles`).
- A closed or sent-away window keeps rendering from a saved record
  (`closing.ts`) at its old place in the document, so React does not remount
  a `<webview>`. It takes no input while it leaves. Its contents animate
  too: the compositor keeps a closed window's surface, and the engine a closed
  browser window's page (muted), for a second after it closes. It keeps the
  last frame even when the client destroys that buffer before closing, as
  GLFW clients like kitty do.
- A leaving window draws above the windows moving into its space, but under
  the windows that were over it (`leaving`).
- Keyframes that move or fade a window never set `z-index`. Chromium runs an
  animation on the compositor thread only if it can run every property there,
  and `z-index` cannot. A motion that holds or swaps depth adds a second,
  depth-only animation.
- A workspace switch clips each part of a window with CSS `clip` on its
  wrapper (`clippedTo`), not an animated `clip-path`. The clip is a static
  rectangle like `SlideOver`'s `overflow: clip`, which the
  compositor applies to client surfaces too. Parts are `position: absolute`
  so the wrapper's clip reaches them; the wrapper has no `z-index`, so each
  part still stacks by its own.
- Each part also clips itself to its workspace (`clippedAlong`), with `clip`
  in its own box so the clip moves with the slide. The wrapper hands it the
  screen through `SlidingScreen` while a switch slides it.
- Durations live in the Panda tokens only. The shell waits for each CSS
  animation's end event.

## Redrawing

A change redraws only the windows it touches. Animations detect changes by
identity, so each step keeps unchanged objects:

- The reducer keeps window records whose fields did not change, and the whole
  state for a report that changes nothing.
- `useStageScreens` lays a screen out again only when its workspace or the
  desk changes. Key presses, modes and titles keep every placement.
- A screen laid out again keeps every placement, float and tab equal to the
  last one (`structural-sharing.ts`). A focus change or a float drag redraws
  only the windows whose box changed.
- `Stage` and its per-window parts are memoized, with callbacks that take a
  window id. So are each monitor's bar and the desktop's panels.
- `useReclaimFocus` does not wait for a redraw: it watches the page for
  focus dropped by chrome unmounting or going inert anywhere. It does not
  reclaim behind a desktop panel or the lock screen, whose keys must not
  reach the page.
- A window being dragged or resized puts each part on a layer of its own
  (`heldStyles`), so a move shifts layers and repaints nothing. Otherwise
  Chromium squashes the parts over an `<app>` into shared layers and repaints
  their blurred shadows and glows on every pointer move.
- Nothing a drag changes every frame is inherited by a window's parts:
  `--lift` is set only while the scratchpad slides the window.
- Listeners every window would add exist only while needed: a tile drag's
  and a border drag's while it runs, `useReclaimFocus`'s while its window is
  focused.
