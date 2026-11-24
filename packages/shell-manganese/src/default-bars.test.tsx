import { describe, expect, it } from "bun:test";
import { Cast } from "@domicile-desktop/manganese-bar-module-cast";
import { Downloads } from "@domicile-desktop/manganese-bar-module-downloads";
import { KeptAwake } from "@domicile-desktop/manganese-bar-module-idle-inhibitor/kept-awake";
import { Keymap } from "@domicile-desktop/manganese-bar-module-keymap";
import { LauncherButton } from "@domicile-desktop/manganese-bar-module-launcher-button";
import { Notifications } from "@domicile-desktop/manganese-bar-module-notifications";
import { Sharing } from "@domicile-desktop/manganese-bar-module-sharing";
import { Agents } from "@domicile-desktop/manganese-bar-module-sharing/agents";
import { Tray } from "@domicile-desktop/manganese-bar-module-tray";
import { WorkspaceSwitcher } from "@domicile-desktop/manganese-bar-module-workspace-switcher";
import { QuickSettings } from "@domicile-desktop/manganese-quick-settings";
import type { ReactNode } from "react";
import { Fragment, isValidElement } from "react";
import { DEFAULT_BAR, LOCK_BAR } from "./default-bars";

/** The component each item renders. */
const types = (items: readonly ReactNode[]) =>
  items.map((item) => (isValidElement(item) ? item.type : item));

describe("DEFAULT_BAR", () => {
  // The bar puts its item gap around each item, so a group shares one slot.
  it("is the launcher with the tray right after it, then the workspaces, on the left", () => {
    const [group, ...rest] = DEFAULT_BAR.left;
    expect(isValidElement<{ children: ReactNode[] }>(group) && group.type).toBe(
      Fragment,
    );
    expect(
      types(
        isValidElement<{ children: ReactNode[] }>(group)
          ? group.props.children
          : [],
      ),
    ).toEqual([LauncherButton, Tray]);
    expect(types(rest)).toEqual([WorkspaceSwitcher]);
  });

  it("is sharing, agents, keep awake, casting, downloads, the keymap, quick settings and the bell on the right", () => {
    expect(types(DEFAULT_BAR.right)).toEqual([
      Sharing,
      Agents,
      KeptAwake,
      Cast,
      Downloads,
      Keymap,
      QuickSettings,
      Notifications,
    ]);
  });
});

describe("LOCK_BAR", () => {
  it("is the keymap and quick settings", () => {
    expect(
      types([...LOCK_BAR.left, ...LOCK_BAR.center, ...LOCK_BAR.right]),
    ).toEqual([Keymap, QuickSettings]);
  });
});
