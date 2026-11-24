// The app's pages, in the order the sidebar lists them.

export enum PageId {
  Appearance,
  Keyboard,
  Displays,
  Power,
  Privacy,
  Launcher,
  Startup,
  Shell,
  Extensions,
  Profiles,
  Agents,
  Permissions,
  SiteData,
  Code,
  Troubleshooting,
}

/** Each page's name and what it holds. */
export const PAGES = [
  {
    description: "Theme, accent color, contrast, motion and icons.",
    id: PageId.Appearance,
    title: "Appearance",
  },
  {
    description:
      "The keyboard layout, as xkb names it, or the keymaps to switch between.",
    id: PageId.Keyboard,
    title: "Keyboard",
  },
  {
    description: "Where each monitor goes, and how large things are on it.",
    id: PageId.Displays,
    title: "Displays",
  },
  {
    description: "When the screens go dark, and how the desktop unlocks.",
    id: PageId.Power,
    title: "Power & lock",
  },
  {
    description:
      "What apps are asked not to do. An app that ignores the request is not stopped.",
    id: PageId.Privacy,
    title: "Privacy",
  },
  {
    description: "What the launcher's file search leaves out.",
    id: PageId.Launcher,
    title: "Launcher",
  },
  {
    description: "Commands run once when the desktop starts.",
    id: PageId.Startup,
    title: "Startup",
  },
  {
    description: "The options the shell declares.",
    id: PageId.Shell,
    title: "Shell",
  },
  {
    description: "Chrome extensions in browser windows.",
    id: PageId.Extensions,
    title: "Extensions",
  },
  {
    description:
      "Each profile keeps its own sign-ins, saved data and extensions. Pages from every profile share your windows.",
    id: PageId.Profiles,
    title: "Profiles",
  },
  {
    description:
      "Apps like Claude Code that can see and use your desktop. Each asks before it starts.",
    id: PageId.Agents,
    title: "Agents",
  },
  {
    description: "What each site may use: the camera, your location and more.",
    id: PageId.Permissions,
    title: "Site permissions",
  },
  {
    description: "What each site stores on this computer: cookies and more.",
    id: PageId.SiteData,
    title: "Site data",
  },
  {
    description: "The config file and the shell, as code.",
    id: PageId.Code,
    title: "Code",
  },
  {
    description: "Logs to send along when something goes wrong.",
    id: PageId.Troubleshooting,
    title: "Troubleshooting",
  },
] as const;
