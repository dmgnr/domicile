// The engine's `<app>` element: a Wayland client's window, laid out by the
// page.
//
// The engine defines the element, embeds the surface, reports its size and
// sends the pointer, wheel and keys over it to its client in the client's own
// coordinates. This module only names the tag, the events the engine
// dispatches on it, and its type.

/**
 * The `<app>` tag name, shared by a shell's styles and tests.
 *
 * Nothing registers it: `customElements.define` needs a hyphen in the name, so
 * the engine defines the element.
 */
export const APP_TAG_NAME = "app";

/**
 * Fired on an `<app>` when a click asks for keyboard focus for it. Cancelable,
 * because the shell decides who holds the keyboard.
 *
 * Cancelable so the shell owns focus policy. Left uncanceled, the SDK focuses
 * the client. A shell with its own policy calls `preventDefault()` and later
 * calls `focusApp` itself.
 *
 * The engine dispatches this as a `CustomEvent`, because the click is a pointer
 * event in this document. A page's own `preventDefault()` on the `pointerdown`
 * takes the press, and then nothing is asked. It bubbles so a shell needs only
 * one listener.
 */
export const APP_FOCUS_REQUESTED_EVENT = "domicile-focus-requested";

/** The detail of an {@link APP_FOCUS_REQUESTED_EVENT}. */
export type AppFocusRequest = {
  /** The host's id for the client that was clicked. */
  appId: string;
};

/**
 * Fired on the focused `<app>` when a press lands outside every window.
 *
 * Left uncanceled, keyboard focus returns to the page. A shell that draws
 * chrome for a window, such as a title bar, calls `preventDefault()` when the
 * press hit that chrome; the engine cannot tell which window a `<div>` belongs
 * to. Read {@link AppFocusReleaseRequest.pressed} to decide. It bubbles.
 */
export const APP_FOCUS_RELEASE_REQUESTED_EVENT =
  "domicile-focus-release-requested";

/**
 * Fired on an `<app>` when a key press reaches its client: not a modifier, a
 * repeat or a chord the shell grabbed. Typing in a window, as opposed to a key
 * the desktop handled.
 *
 * A plain `Event` naming no key, so typed text stays the client's. It bubbles
 * and is not cancelable. A `<webview>` fires the same for its page (see
 * `WEBVIEW_KEY_DELIVERED_EVENT`).
 */
export const APP_KEY_DELIVERED_EVENT = "domicile-key-delivered";

/** The detail of an {@link APP_FOCUS_RELEASE_REQUESTED_EVENT}. */
export type AppFocusReleaseRequest = {
  /** The host's id for the client about to lose keyboard focus. */
  appId: string;
  /** The element the press hit, or `undefined` if there was none. */
  pressed: Element | undefined;
};

/**
 * Fired on an `<app>` when its window reaches the screen: viz showed the
 * window's first frame, or the first frame its client drew after its box
 * changed size.
 *
 * Fired once for each. A move, and a hidden window shown again, fire nothing.
 * A `CustomEvent` with an {@link AppWindowChange} detail. It bubbles and is not
 * cancelable.
 */
export const APP_PRESENTED_EVENT = "domicile-presented";

/**
 * Fired on an `<app>` when the compositor marks its window `suspended`: the
 * page reported it hidden (`setAppBounds` with no area) and no cast shows it.
 * The client draws about once a second until {@link APP_RESUMED_EVENT}.
 *
 * A `CustomEvent` with an {@link AppWindowChange} detail. It bubbles and is not
 * cancelable.
 */
export const APP_SUSPENDED_EVENT = "domicile-suspended";

/**
 * Fired on an `<app>` when the compositor clears its window's `suspended`
 * state: the page gave it a box, a cast shows it, or a new page connected.
 *
 * A `CustomEvent` with an {@link AppWindowChange} detail. It bubbles and is not
 * cancelable.
 */
export const APP_RESUMED_EVENT = "domicile-resumed";

/**
 * The detail of an {@link APP_PRESENTED_EVENT}, {@link APP_SUSPENDED_EVENT}
 * or {@link APP_RESUMED_EVENT}.
 */
export type AppWindowChange = {
  /** The host's id for the window. */
  appId: string;
};

/**
 * The engine's `<app>` element type.
 *
 * Declared globally because React types a `ref` from `HTMLElementTagNameMap`;
 * an exported copy would be a distinct type the ref cannot be assigned to. The
 * engine ships no `.d.ts`. On stock Chromium the element is an
 * `HTMLUnknownElement`.
 */
declare global {
  // An `interface` so it can merge with a future DOM lib declaration.
  interface HTMLAppElement extends HTMLElement {
    /**
     * Which window this element shows. Reflects the `app-id` attribute; empty
     * when the attribute is unset.
     */
    appId: string;
    /**
     * Whether the user is resizing the window with the pointer. Reflects the
     * `resizing` attribute. While set, each new box shows without waiting for
     * the client to draw at it; clearing it waits once for the final size.
     */
    resizing: boolean;
  }

  // biome-ignore lint/style/useConsistentTypeDefinitions: declaration merging onto a built-in type is what `interface` is for and what a type alias cannot do
  interface HTMLElementTagNameMap {
    app: HTMLAppElement;
  }
}
