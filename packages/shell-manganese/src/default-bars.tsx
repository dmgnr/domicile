// Manganese's bars.

import type { BarLayout } from "@domicile-desktop/manganese-bar/bar-layout";
import { Cast } from "@domicile-desktop/manganese-bar-module-cast";
import { Clock } from "@domicile-desktop/manganese-bar-module-clock";
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
import { Fragment } from "react";

/**
 * Manganese's default bar.
 *
 * The launcher button is first, with the tray right after it: they share one
 * item, as the bar puts its item gap around each item. The sharing indicator
 * and the agents in control lead the right column, so they are seen, then the
 * keep awake eye, casting to TVs
 * and downloads. The keymap, which shows only on a keyboard with several, is next, then
 * quick settings. The bell is last because the drawer it opens slides out from
 * that edge.
 */
export const DEFAULT_BAR: BarLayout = {
  center: [<Clock key="clock" />],
  left: [
    <Fragment key="launcher">
      <LauncherButton />
      <Tray />
    </Fragment>,
    <WorkspaceSwitcher key="workspaces" />,
  ],
  right: [
    <Sharing key="sharing" />,
    <Agents key="agents" />,
    <KeptAwake key="kept-awake" />,
    <Cast key="cast" />,
    <Downloads key="downloads" />,
    <Keymap key="keymap" />,
    <QuickSettings key="quick-settings" />,
    <Notifications key="notifications" />,
  ],
};

/**
 * The lock screen's bar: the keymap, so the passphrase is typed on the right
 * one, and quick settings, which offers what a locked desktop allows.
 */
export const LOCK_BAR: BarLayout = {
  center: [],
  left: [],
  right: [<Keymap key="keymap" />, <QuickSettings key="quick-settings" />],
};
