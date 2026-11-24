# @domicile-desktop/component-library

Shared React UI components for every Domicile app, plus the Panda CSS preset
the other packages extend.

- Components wrap [`@base-ui/react`](https://base-ui.com) where it has a
  primitive. base-ui handles focus, keyboard navigation, portals and
  validation. This package adds styling and a simpler API.
- Each component loads the prebuilt stylesheet (`styled-system/styles.css`,
  from `panda cssgen`), so a shell that renders one needs no Panda step.
- Apps use these components instead of raw HTML buttons, inputs or dialogs.
  If one is missing, add it here. See
  [/docs/guidelines/STYLING.md](../../docs/guidelines/STYLING.md).

## Exports

Each export is `@domicile-desktop/component-library/<name>`.

| Name | What it is |
|---|---|
| `app-host-frames` | `encodeFrame` and `frameDecoder`: the length-prefixed JSON an app module and `domicile-app-host` speak over stdio. |
| `Accordion` | Stack of sections that open and close. `surface="filled"` draws each as a tile. |
| `Autocomplete` | Text field with a suggestion list the caller supplies and ranks. |
| `Avatar` | Avatar with an initials or gradient fallback. |
| `Button` | Button or link, with variants and sizes. |
| `Card` | Raised surface with optional title and footer. |
| `ChoiceRow` | Rows of a pick list, with icon, name and detail, framed while picked: `RadioRow` in `ChoiceList` for one, `CheckboxRow` for several. Take the panel's white text in an `overPhoto` popover. |
| `CountBadge` | Unread count in an accent pill, pinned to the corner of its positioned parent, or `inline` beside text. Shows "9+" past nine. |
| `DetailList` | Terms and values in two columns, such as a connection's addresses. Long values wrap in their column. |
| `Drilldown` | View that slides a second `Panel` in from the side, with a back button. |
| `EmptyState` | A panel or section with nothing to show: an icon in a soft circle, what is missing, a hint on what would fill it, and a button that would if there is one. |
| `Field` | Label, control and validation message. |
| `FilePicker` | Keyboard-first file picker over its positioned parent. |
| `IconButton` | Round, quiet button that shows only an icon: a back arrow, a details arrow, a mute button. Drawn in `currentcolor`. |
| `file-request` | `FileRequest` and `ChooserMode`: what `FilePicker` asks for and how it answers. |
| `Input` | Text input with prefix icon, clear button and invalid state. |
| `Kbd` | Keyboard key cap. |
| `list-walk` | Arrow-key movement of a highlight through a list while focus stays in an input. |
| `LeavingRow` | List item that slides in as it arrives and out as it leaves, then closes its height. `useLeavingRows` keeps removed items until they have left; `ListRow`'s `motion` uses it. |
| `ListRow` | Row of a panel's `List`: icon, label over a detail, and something at the end. One button, or a `filled` tile holding its own buttons. `disclosure` folds what goes under it behind a toggle. |
| `Loading` | What a panel waits for: a spinner over its words, what it searches for with rings spreading from it, or a spinner alone at a row's end. |
| `ModalDialog` | Modal dialog with `title`, `footer` and `trigger` props. |
| `Notice` | Pill that briefly shows a change, such as a zoom level or volume, with an optional level meter. Key it per change. |
| `ContextMenu` | Menu opened at a point, such as a right click's. Parts: `Item`, `CheckboxItem`, `RadioGroup` and `RadioItem`, `Submenu`, `Separator`. Items take an `icon` and a `mnemonic`, whose letter chooses them. |
| `PortalDialogs` | Every dialog applications ask for through the desktop portal. Mount one per shell with `domicile={domicile}`; it refuses kinds it cannot draw. `omitScreenCasts` leaves screen casts out of its indicator. See [PORTALS.md](/docs/PORTALS.md). |
| `Panel` | Titled panel: a `PanelHeader`, then its content a step apart. `PanelAction` puts the content's controls in the header. |
| `PanelFooter` | A panel's last line under a rule: a summary and an action. |
| `PanelHeader` | A panel's title, with a back button when one level in and controls at the end. |
| `PanelNote` | One line on how a panel stands beside its rows; `warning` says a refusal plainly, with the service's words in its tooltip. |
| `PanelSection` | A group in a panel under a small label, such as Inboxes or Paired. |
| `source-name` | `sourceName`: how a screen cast's source is named. |
| `Popover` | Non-modal panel anchored to the control that opened it. `tone="overPhoto"` is a see-through panel for the bar, dark in either theme. |
| `PopupBoundary` | Keeps every popup inside it (tooltips, popovers, menus, lists) within a box, such as a window's frame, and closes them when the box moves. Outside one, popups stay on their `Screen`. `Popover` and `Tooltip` take `spansWindows` to leave it. |
| `PopupScene` | Closes every popup inside it when its `scene` key changes. A shell keys it on what moves or covers its windows: an overview, a fullscreen window, a workspace switch. |
| `Provider` | base-ui `DirectionProvider` wrapper. Every app roots its tree in it. |
| `QuickTile` | Quick settings tile into the details of something nearly always on, such as Wi-Fi: one button with an arrow, or only its state without details. Its icon's circle is lit in the accent color while `lit`. |
| `QuickToggle` | Quick settings switch for something turned on and off often: an icon in a circle, in the accent color while on, over its label. |
| `Screen` | Renders its children once per selected display. |
| `DisplayProvider` | Supplies the host's displays to `Screen`. |
| `display-source` | `Display` and `DisplaySource` types for `DisplayProvider`. |
| `Select` | Select / listbox. |
| `SlideOver` | Drawer anchored to a screen edge. |
| `SliderRow` | A slider with what it sets, its value and an optional button, lined up with the rows around it. |
| `Slider` | Single-value range slider drawn in `currentcolor`. |
| `Switch` | On/off switch with its label, which `hideLabel` keeps unseen beside a title that says it. |
| `Tabs` | Tab set built from a `tabs` array, with sizes. |
| `TabRail` | Vertical tab rail with brand slot, footer and collapse. |
| `Textarea` | Auto-sizing textarea with a resize handle. |
| `Toaster` | Stack of toasts in a corner. The caller renders each card. |
| `Tooltip` | Short label shown while the pointer rests on its trigger. |
| `ThemeProvider` | Light/dark theme state. Sets `data-theme` on `<html>`. |
| `ThemeSwitch` | Button that flips the theme. |
| `useApps` | Hook: names and icons of applications by app id, from their desktop entries. |
| `usePictureUrl` | Hook: a URL an `<img>` can show for a file read through `domicile.files`. |
| `usePortalWallpaper` | Hook: the pictures applications set through the Wallpaper portal, as paths. |
| `theme-core`, `theme-source`, `standalone-theme-source` | Theme types and sources. Use the standalone source where there is no compositor, such as Storybook. |
| `control-sizes` | `Size` type and `SIZES` array for sized controls. |
| `spacing` | rem value of one spacing step, for runtime math. |
| `pandacss-preset` | `domicilePreset`, extended by every package's `panda.config.ts`. |
| `vite-shell` | `shellBuild({ entry })`: the Vite config a shell needs so Domicile can load it. See the comments in `src/vite-shell.ts`. |

## Scripts

```sh
bun run start:dev        # Storybook on port 4000
bun run build:storybook  # build Storybook into storybook-static/
bun run start:prod       # serve that build on port 4000
bun run prepare          # Panda codegen and stylesheet into styled-system/
bun run test:unit        # bun:test + happy-dom
bun run test:types       # tsc --noEmit
```

## More

- [docs/AGENTS.md](./docs/AGENTS.md): rules for adding or changing a
  component.
