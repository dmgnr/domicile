// The keyboard: chords the shell grabs from clients, and the seat's held
// modifiers. See docs/architecture/KEYBINDINGS.md.

import type { DomicileHost, DomicileShortcutEvent } from "../domicile-host";
import type { On } from "./subscribe";
import { hostEvent, on } from "./subscribe";
import type { System } from "./system-calls";

/** A grabbed chord, pressed or let go. `keycode` is an evdev code. */
export type Shortcut = {
  chord: string;
  keycode: number;
  altKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
};

/** How {@link Keyboard.grab} takes a chord. */
export type GrabOptions = {
  /**
   * Whether the chord stays the shell's while the window with the keyboard
   * holds a shortcuts inhibitor, as sway's `bindsym --inhibited`: the way back
   * to the desktop from a VM. Otherwise that window gets it as a key.
   */
  readonly whileInhibited?: boolean;
  /**
   * For a modifier alone, a tap of it: the longest it may be held, in
   * milliseconds, and still be a tap. The engine's default, 300, unless set.
   */
  readonly longestTap?: number;
};

/**
 * The seat's modifiers, which count only keys forwarded to a client. See
 * "Reading held modifiers" in packages/chrome-sdk/docs/ELEMENTS.md.
 */
export type Modifiers = {
  alt: boolean;
  ctrl: boolean;
  shift: boolean;
  meta: boolean;
};

export type KeyboardListeners = {
  /** A grabbed chord was pressed, in a `<webview>` or on the page. */
  shortcut: (shortcut: Shortcut) => void;
  /** A pressed chord's key or one of its modifiers came up. */
  shortcutrelease: (shortcut: Shortcut) => void;
  modifierschange: () => void;
};

export type Keyboard = {
  /** `undefined` until the compositor says. */
  readonly modifiers: Modifiers | undefined;
  /**
   * Route `chord`, in sway's grammar such as `Meta+Shift+l`, to the page
   * rather than to the focused client. Throws a SyntaxError for a chord
   * written wrong.
   */
  grab: (chord: string, options?: GrabOptions) => void;
  /** Answer one {@link Keyboard.grab}; the last gives the key back. */
  ungrab: (chord: string) => void;
  /**
   * Hear `input.keyboard`'s keymaps and the one the desktop types on, at once
   * and on each switch or reload. Allowed while the desktop is locked.
   */
  keymaps: System["keymaps"];
  /**
   * Switch every keyboard to another of the config's keymaps, until the
   * desktop restarts. Allowed while the desktop is locked.
   */
  selectKeymap: System["selectKeymap"];
  /**
   * Activate, deactivate or toggle the shortcuts inhibitor of the window with
   * the keyboard, as sway's `seat shortcuts_inhibitor`. Its
   * `DomicileWindow.inhibitsShortcuts` follows. A window holding none changes
   * nothing. Bind it to a chord grabbed `whileInhibited`.
   */
  switchShortcutsInhibitor: System["switchShortcutsInhibitor"];
  on: On<KeyboardListeners>;
};

export type KeyboardHost = Pick<
  DomicileHost,
  | "addEventListener"
  | "altKey"
  | "ctrlKey"
  | "grabShortcut"
  | "metaKey"
  | "removeEventListener"
  | "shiftKey"
  | "ungrabShortcut"
>;

export const keyboard = (
  host: KeyboardHost,
  calls: Pick<System, "keymaps" | "selectKeymap" | "switchShortcutsInhibitor">,
): Keyboard => ({
  grab: (chord, { whileInhibited = false, longestTap } = {}) => {
    // Left off unless set, as a grab by an older shell is.
    if (longestTap !== undefined) {
      host.grabShortcut(chord, whileInhibited, longestTap);
    } else if (whileInhibited) {
      host.grabShortcut(chord, true);
    } else {
      host.grabShortcut(chord);
    }
  },
  keymaps: () => calls.keymaps(),
  get modifiers() {
    return modifiersOf(host);
  },
  on: on<KeyboardListeners>({
    modifierschange: (listener) =>
      hostEvent(host, "modifierschanged", () => listener()),
    shortcut: (listener) =>
      hostEvent(host, "shortcut", (event) => listener(shortcutOf(event))),
    shortcutrelease: (listener) =>
      hostEvent(host, "shortcutrelease", (event) =>
        listener(shortcutOf(event)),
      ),
  }),
  selectKeymap: (choice) => calls.selectKeymap(choice),
  switchShortcutsInhibitor: (action) => calls.switchShortcutsInhibitor(action),
  ungrab: (chord) => {
    host.ungrabShortcut(chord);
  },
});

const modifiersOf = ({
  altKey,
  ctrlKey,
  shiftKey,
  metaKey,
}: KeyboardHost): Modifiers | undefined =>
  altKey === null || ctrlKey === null || shiftKey === null || metaKey === null
    ? undefined
    : { alt: altKey, ctrl: ctrlKey, meta: metaKey, shift: shiftKey };

const shortcutOf = (event: DomicileShortcutEvent): Shortcut => ({
  altKey: event.altKey,
  chord: event.chord,
  ctrlKey: event.ctrlKey,
  keycode: event.keycode,
  metaKey: event.metaKey,
  shiftKey: event.shiftKey,
});
