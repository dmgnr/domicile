// The shell module guard-webview-keyboard.sh loads: one browser window holding
// the keyboard, with a desktop chord claimed over it.
//
// It must be a domicile:// document: the browser binds WebViewGuestHost and
// the control channel only for the shell's origin. See
// ShellURLLoaderFactory::ShellDocument.
//
// ?kind= picks the element, as in guard-webview-framing.js. `webview` puts a
// guest behind it, so the browser process handles keys above the focused page.
// `iframe` is the negative control: it takes the keyboard but has no guest
// delegate, so the chord must not fire.
//
// Console output, which the engine writes to its log:
//
//   GUARD claimed                 the chord was claimed
//   GUARD window-focused          the element is this document's activeElement
//   GUARD shortcut keycode=…      a claimed chord came back up the control
//                                 channel
//   GUARD release keycode=…       its key came up in the guest, and the chord
//                                 was let go
//   GUARD modifiers alt=…         the seat's modifiers, which the shell
//                                 cannot read from DOM events while a window
//                                 has the keyboard (needed to Alt-drag a float)
//   GUARD document-keydown code=… a key reached the shell's document. Must
//                                 not happen over a browser window
//   GUARD guest-chord key=…       a chord the guest page did not handle, sent
//                                 to the element as `domicile-guest-keydown`.
//                                 This is how a browser window's Ctrl+R
//                                 reaches the shell. A plain key must never
//                                 produce one
//   GUARD guest-keyup key=…       a key let go of in the guest page, sent to
//                                 the element as `domicile-guest-keyup`. How
//                                 a lone Alt shows an app's menu bar. Only a
//                                 modifier may produce one
//   GUARD zoom factor=…           the zoom the browser reports after the first
//                                 guest chord set 150%
//   GUARD key-delivered           a key press reached the guest page, as
//                                 `domicile-key-delivered`. Once for each
//                                 unclaimed key; never for a claimed chord
//
// The engine's document calls `HostShell` once the module loads.

export const HostShell = (_root, desktop) => {
  /**
   * Reads a required query parameter. No default, so a misconfigured guard
   * fails instead of measuring the wrong thing.
   */
  const required = (parameters, name) => {
    const value = parameters.get(name);
    if (value === null) {
      throw new Error(`guard-webview-keyboard: ?${name}= is required`);
    } else {
      return value;
    }
  };

  /**
   * Creates the element under test. Rejects unknown kinds, which would become
   * an HTMLUnknownElement that never takes the keyboard.
   */
  const buildView = (kind) => {
    switch (kind) {
      case "webview": {
        return document.createElement("webview");
      }
      case "iframe": {
        return document.createElement("iframe");
      }
      default: {
        throw new Error(
          `guard-webview-keyboard: ?kind= is "webview" or "iframe", got "${kind}"`,
        );
      }
    }
  };

  const say = (what) => {
    console.log(`GUARD ${what}`);
  };

  /**
   * Resolves once the element holds its page. The control's <iframe> replaces
   * its first, same-origin frame when the cross-origin page loads, and focus
   * taken before that stays with the replaced frame, so keys reach this
   * document. A <webview>'s guest is focused on the interval below as it
   * attaches.
   */
  const holdsItsPage = (view, kind) =>
    kind === "iframe"
      ? new Promise((resolve) => {
          view.addEventListener("load", () => {
            if (view.contentDocument === null) {
              resolve();
            }
          });
        })
      : Promise.resolve();

  const parameters = new URLSearchParams(location.search);
  const kind = required(parameters, "kind");
  const view = buildView(kind);
  const pageLoaded = holdsItsPage(view, kind);

  view.style.position = "absolute";
  view.style.inset = "0";
  view.style.inlineSize = "100%";
  view.style.blockSize = "100%";
  view.style.border = "0";

  // The shell's own keyboard. Over a browser window it hears nothing, because
  // DOM focus has left this document.
  //
  // It also proves the harness can deliver keys here: the guard presses a key
  // before the window takes focus, and that keystroke triggers taking the
  // keyboard.
  document.addEventListener("keydown", (event) => {
    say(`document-keydown code=${event.code} alt=${event.altKey}`);
    takeTheKeyboard();
  });

  // Alt+Tab, as manganese grabs it. The engine finds Tab on evdev 15 in the
  // keyboard the control-socket stand-in describes.
  const ALT_TAB = "Alt+Tab";

  const host = desktop;
  if (host === null || host === undefined) {
    // Without the control channel every reading below would be missing for an
    // unrelated reason, so fail loudly.
    throw new Error(
      "guard-webview-keyboard: no desktop was handed to Shell, so this document" +
        " was not served by the forked engine",
    );
  }

  host.addEventListener("shortcut", (event) => {
    say(
      `shortcut keycode=${event.keycode} alt=${event.altKey}` +
        ` ctrl=${event.ctrlKey} shift=${event.shiftKey} meta=${event.metaKey}`,
    );
  });

  host.addEventListener("shortcutrelease", (event) => {
    say(
      `release keycode=${event.keycode} alt=${event.altKey}` +
        ` ctrl=${event.ctrlKey} shift=${event.shiftKey} meta=${event.metaKey}`,
    );
  });

  host.addEventListener("modifierschanged", () => {
    say(
      `modifiers alt=${host.altKey} ctrl=${host.ctrlKey}` +
        ` shift=${host.shiftKey} meta=${host.metaKey}`,
    );
  });

  // A chord the guest page did not handle, returned by the guest's delegate.
  // The first one also zooms the page, so the run can check the zoom arrives.
  let zoomed = false;
  view.addEventListener("domicile-guest-keydown", (event) => {
    say(
      `guest-chord key=${event.key} code=${event.code} alt=${event.altKey}` +
        ` ctrl=${event.ctrlKey} shift=${event.shiftKey} meta=${event.metaKey}`,
    );
    if (!zoomed) {
      zoomed = true;
      view.setZoom(1.5);
    }
  });
  view.addEventListener("domicile-guest-keyup", (event) => {
    say(`guest-keyup key=${event.key} code=${event.code}`);
  });

  view.addEventListener("domicile-key-delivered", () => {
    say("key-delivered");
  });

  view.addEventListener("domicile-zoom-change", () => {
    say(`zoom factor=${view.zoom}`);
  });

  // The stand-in sends `idle` after the keyboard, on the same socket, so once
  // `idle` is set the keyboard has reached this page. A chord claimed earlier
  // reaches the browser's registry only when the keyboard arrives, and the
  // guard presses Alt+Tab as soon as this says `claimed`.
  const waiting = setInterval(() => {
    if (host.idle === true) {
      clearInterval(waiting);
      host.grabShortcut(ALT_TAB);
      say(`claimed ${ALT_TAB}`);
    }
  }, 100);

  // Set `src` after attaching: it requests a guest, which needs a frame.
  document.body.append(view);
  view.setAttribute("src", required(parameters, "src"));

  // Focuses the window, as `BrowserWindow.tsx` does. Runs between the guard's
  // two keystrokes so they read before and after, and not before the element
  // holds its page.
  //
  // Repeats on an interval: attaching is asynchronous and signals nothing, and
  // focusing an element before its page exists does nothing.
  //
  // Checks `document.activeElement` here, not focus in the guest page. A page
  // reports focus only when the browser window is active, and headless has no
  // display to make it active.
  let announced = false;
  let taking = false;
  const takeTheKeyboard = () => {
    if (!taking) {
      taking = true;
      pageLoaded
        .then(() => {
          setInterval(() => {
            view.focus();
            if (!announced && document.activeElement === view) {
              announced = true;
              say("window-focused");
            }
          }, 200);
        })
        .catch((error) => {
          say(`take-the-keyboard-failed ${error}`);
        });
    }
  };

  // Also on a timer, so a harness that delivers no keys to this document still
  // finishes the run. The guard reports that run as weaker.
  setTimeout(takeTheKeyboard, 5000);
};
