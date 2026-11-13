// The desktop a shell is handed, typed and grouped by what it is about. See
// docs/WRITING-A-SHELL.md.

import type { DomicileHost } from "../domicile-host";
import type { AppearanceNamespace } from "./appearance";
import { appearance } from "./appearance";
import type { Browser } from "./browser";
import { browser } from "./browser";
import type { Capture } from "./capture";
import { capture } from "./capture";
import type { Clipboard } from "./clipboard";
import { clipboard } from "./clipboard";
import type { Dbus } from "./dbus";
import { dbus } from "./dbus";
import type { Displays } from "./displays";
import { displays } from "./displays";
import type { Downloads } from "./downloads";
import { downloads } from "./downloads";
import type { Extensions } from "./extensions";
import { extensions } from "./extensions";
import type { Files } from "./files";
import { files } from "./files";
import type { Gestures } from "./gestures";
import { gestures } from "./gestures";
import type { GoogleCast } from "./google-cast";
import { googleCast } from "./google-cast";
import type { Keyboard } from "./keyboard";
import { keyboard } from "./keyboard";
import type { Notifications } from "./notifications";
import { notifications } from "./notifications";
import type { PictureInPicture } from "./picture-in-picture";
import { pictureInPicture } from "./picture-in-picture";
import type { Pointer } from "./pointer";
import { pointer } from "./pointer";
import type { Portals } from "./portals";
import { portals } from "./portals";
import type { Processes } from "./processes";
import { processes } from "./processes";
import type { Session } from "./session";
import { session } from "./session";
import type { ShellNamespace } from "./shell";
import { shell } from "./shell";
import type { On } from "./subscribe";
import { hostEvent, on } from "./subscribe";
import { system } from "./system-calls";
import type { Theme } from "./theme";
import { theme } from "./theme";
import type { Tray } from "./tray";
import { tray } from "./tray";
import type { Windows } from "./windows";
import { windows } from "./windows";

export type DomicileListeners = {
  /**
   * The compositor exited and a new one took over, after every window and
   * system call of the old one ended. Calls that listen listen again.
   */
  compositorreplaced: () => void;
};

/**
 * The desktop: one namespace per subject. State is read from attributes,
 * which say `change` through `on`; a call that can fail resolves a `Result`.
 */
export type Domicile = {
  readonly appearance: AppearanceNamespace;
  readonly browser: Browser;
  readonly capture: Capture;
  readonly clipboard: Clipboard;
  readonly dbus: Dbus;
  readonly displays: Displays;
  readonly downloads: Downloads;
  readonly extensions: Extensions;
  readonly files: Files;
  readonly gestures: Gestures;
  readonly googleCast: GoogleCast;
  readonly keyboard: Keyboard;
  readonly notifications: Notifications;
  readonly pictureInPicture: PictureInPicture;
  readonly pointer: Pointer;
  readonly portals: Portals;
  readonly processes: Processes;
  readonly session: Session;
  readonly shell: ShellNamespace;
  readonly theme: Theme;
  readonly tray: Tray;
  readonly windows: Windows;
  on: On<DomicileListeners>;
};

/** The desktop `host` describes: the same object for each call on a host. */
export const desktop = (host: DomicileHost): Domicile => {
  const known = built.get(host);
  if (known === undefined) {
    const made = build(host);
    built.set(host, made);
    return made;
  } else {
    return known;
  }
};

/** One per host, so its portal listeners and system call ids are shared. */
const built = new WeakMap<DomicileHost, Domicile>();

const build = (host: DomicileHost): Domicile => {
  const calls = system(host);
  const bus = dbus(calls);
  return {
    appearance: appearance(host),
    browser: browser(host),
    capture: capture(calls),
    clipboard: clipboard(host),
    dbus: bus,
    displays: displays(host, calls),
    downloads: downloads(host),
    extensions: extensions(host),
    files: files(host, calls),
    gestures: gestures(host),
    googleCast: googleCast(host),
    keyboard: keyboard(host, calls),
    notifications: notifications(host),
    on: on<DomicileListeners>({
      compositorreplaced: (listener) =>
        hostEvent(host, "compositorreplaced", () => listener()),
    }),
    pictureInPicture: pictureInPicture(host),
    pointer: pointer(host),
    portals: portals(host),
    processes: processes(host, calls),
    session: session(host, calls),
    shell: shell(host, calls),
    theme: theme(host),
    tray: tray(host, bus),
    windows: windows(host, calls),
  };
};
