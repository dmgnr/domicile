import { MenuBar } from "@domicile-desktop/component-library/MenuBar";
import type { AppMenuEntry, AppMenuItem } from "@domicile-desktop/sdk/app-menu";
import { MenuEntryKind, ToggleKind } from "@domicile-desktop/sdk/app-menu";

type Props = {
  entries: readonly AppMenuEntry[];
  /** The top-level entry whose menu is open, if any. */
  open: number | undefined;
  /** A top-level entry's menu opened, or `undefined` once none is open. */
  onOpen: (open: number | undefined) => void;
  /** The user chose entry `id`; the app runs it. */
  onChoose: (id: number) => void;
};

/**
 * An Electron app's menu bar under its window's tab: one menu per top-level
 * entry, drawn with the shell's menus. See "Menu bars" in
 * docs/SHELL-BROWSER-WINDOWS.md.
 */
export const AppMenuBar = ({ entries, onChoose, onOpen, open }: Props) => (
  <MenuBar label="Application menu">
    {entries.map((entry) =>
      entry.kind === MenuEntryKind.Item ? (
        <MenuBar.Menu
          disabled={!entry.enabled}
          key={entry.id}
          label={entry.label}
          mnemonic={entry.mnemonic}
          onOpenChange={(opening) => {
            if (opening) {
              onOpen(entry.id);
            } else if (open === entry.id) {
              onOpen(undefined);
            }
          }}
          open={open === entry.id}
        >
          <AppMenuEntries entries={entry.submenu ?? []} onChoose={onChoose} />
        </MenuBar.Menu>
      ) : undefined,
    )}
  </MenuBar>
);

type EntriesProps = Pick<Props, "entries" | "onChoose">;

/** A menu's entries, for the menu bar's menus and the app's popup menus. */
export const AppMenuEntries = ({ entries, onChoose }: EntriesProps) =>
  entries.map((entry) =>
    entry.kind === MenuEntryKind.Separator ? (
      <MenuBar.Separator key={entry.id} />
    ) : (
      <Item item={entry} key={entry.id} onChoose={onChoose} />
    ),
  );

type ItemProps = Pick<Props, "onChoose"> & { item: AppMenuItem };

/** An entry, a submenu, a check box or a radio item. */
const Item = ({ item, onChoose }: ItemProps) => {
  const icon =
    item.icon === undefined ? undefined : <img alt="" src={item.icon} />;
  if (item.submenu !== undefined) {
    return (
      <MenuBar.Submenu
        disabled={!item.enabled}
        icon={icon}
        label={item.label}
        mnemonic={item.mnemonic}
      >
        <AppMenuEntries entries={item.submenu} onChoose={onChoose} />
      </MenuBar.Submenu>
    );
  }
  const shared = {
    children: item.label,
    disabled: !item.enabled,
    icon,
    mnemonic: item.mnemonic,
    onClick: () => {
      onChoose(item.id);
    },
  };
  switch (item.toggle?.kind) {
    case undefined: {
      return <MenuBar.Item {...shared} shortcut={item.accelerator?.label} />;
    }
    case ToggleKind.Checkmark: {
      // The app flips it when clicked, and the next listing shows it.
      return (
        <MenuBar.CheckboxItem
          checked={item.toggle.checked}
          closeOnClick
          {...shared}
        />
      );
    }
    case ToggleKind.Radio: {
      return (
        <MenuBar.RadioGroup value={item.toggle.checked ? item.id : undefined}>
          <MenuBar.RadioItem closeOnClick value={item.id} {...shared} />
        </MenuBar.RadioGroup>
      );
    }
  }
};
