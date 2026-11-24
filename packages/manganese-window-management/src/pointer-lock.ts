import type { Unsubscribe } from "@domicile-desktop/sdk/desktop/subscribe";
import type {
  ClientWindow,
  Windows,
} from "@domicile-desktop/sdk/desktop/windows";

/** What the pointer lock reads and asks of the page. */
export type LockingDocument = Pick<
  Document,
  | "addEventListener"
  | "exitPointerLock"
  | "pointerLockElement"
  | "querySelectorAll"
  | "removeEventListener"
>;

/** The windows the pointer lock follows and answers. */
export type LockingWindows = Pick<
  Windows,
  "focused" | "list" | "on" | "pointerConstrained"
>;

/**
 * The window whose pointer the shell should lock: the one with the keyboard,
 * when its client asked for a lock.
 *
 * The compositor offers a lock only for the window under the pointer, so this
 * is the window the user is both pointing at and typing into, as sway grants
 * one. Moving the keyboard elsewhere (a chord, which still reaches the shell)
 * is how the user takes the pointer back. A confinement is taken by
 * `usePointerConfinement`, which follows the window as it moves.
 */
export const lockFor = (
  list: readonly ClientWindow[],
  focused: string | undefined,
): string | undefined =>
  list.some(
    (window) => window.appId === focused && window.pointerConstraint === "lock",
  )
    ? focused
    : undefined;

/** The window an `<app>` element shows, or `undefined` for anything else. */
const appOf = (element: Element | null): string | undefined =>
  element?.localName === "app"
    ? (element.getAttribute("app-id") ?? undefined)
    : undefined;

/**
 * Holds a pointer lock on the `<app>` of {@link lockFor}'s window, and lets it
 * go once that window loses the keyboard or its client withdraws the ask.
 *
 * The compositor tells the client it is locked only when the page says it
 * holds the lock, so the page's own `pointerlockchange` is what is reported,
 * not the request: a lock the engine refused, or one lost when the element
 * remounted, is never reported held.
 */
export const followPointerLock = (
  windows: LockingWindows,
  page: LockingDocument,
): Unsubscribe => {
  // The window the compositor was last told the page holds the pointer for.
  let held: string | undefined;

  const sync = () => {
    const wanted = lockFor(windows.list, windows.focused);
    const locked = appOf(page.pointerLockElement);
    if (locked !== undefined && locked !== wanted) {
      page.exitPointerLock();
    } else if (wanted !== undefined && locked === undefined) {
      const element = [...page.querySelectorAll("app")].find(
        (app) => appOf(app) === wanted,
      );
      // Refused, or the element went away first: nothing is held, and the
      // next change asks again.
      void element?.requestPointerLock().catch(() => undefined);
    }
  };

  const changed = () => {
    const locked = appOf(page.pointerLockElement);
    if (held !== undefined && held !== locked) {
      windows.pointerConstrained(held, false);
    }
    if (locked !== undefined && locked !== held) {
      windows.pointerConstrained(locked, true);
    }
    held = locked;
    // Lock the window that wants it now, if letting go was to make way.
    sync();
  };

  const unsubscribe = [
    windows.on("change", sync),
    windows.on("focuschange", sync),
  ];
  page.addEventListener("pointerlockchange", changed);
  sync();

  return () => {
    for (const stop of unsubscribe) {
      stop();
    }
    page.removeEventListener("pointerlockchange", changed);
    if (appOf(page.pointerLockElement) !== undefined) {
      page.exitPointerLock();
    }
    // Unheard once unsubscribed, so said here.
    if (held !== undefined) {
      windows.pointerConstrained(held, false);
    }
  };
};
