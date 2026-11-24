// The shell guard-app-routes-input.sh drives. It draws two windows and calls
// nothing that routes input -- there is no `registerElements` any more, and
// this page has no pointer listener of its own -- then reports:
//
//   GUARD ready                        both windows are on the desk
//   GUARD focus-requested <id> <how>   a press asked for the keyboard, with
//                                      whether the event bubbles and can be
//                                      canceled
//   GUARD keydown <code>               a key reached this document
//   GUARD key-delivered <id> <how>     a key press reached a window's client,
//                                      with whether the event bubbles
//   GUARD pressed <tag>                the control only: a press reached this
//                                      document, on what
//
// `term` is 200x100 of this page's pixels, turned and scaled on the way to the
// screen: `translate(400px, 0) rotate(90deg) scale(2)` about its top left, so
// its own point (x, y) is drawn at (500 - 2y, 50 + 2x). Its client drew 400x200,
// twice the element. `menu` is a popup over it, 50x40 at 700,500 and untouched.
//
// `?kind=div` is the control: the same boxes, as `<div>`s.

const KIND =
  new URL(location.href).searchParams.get("kind") === "div" ? "div" : "app";

const place = (appId, style) => {
  const element = document.createElement(KIND);
  element.setAttribute("app-id", appId);
  Object.assign(element.style, { margin: "0", position: "fixed", ...style });
  document.body.append(element);
  return element;
};

export const HostShell = (_root, desktop) => {
  if (desktop === null || desktop === undefined) {
    throw new Error(
      "guard-app-routes-input: no desktop was handed to Shell, so this" +
        " document was not served by the forked engine",
    );
  }
  place("term", {
    background: "#336",
    height: "100px",
    left: "100px",
    top: "50px",
    transform: "translate(400px, 0) rotate(90deg) scale(2)",
    transformOrigin: "0 0",
    width: "200px",
  });
  place("menu", {
    background: "#633",
    height: "40px",
    left: "700px",
    top: "500px",
    width: "50px",
  });

  document.addEventListener("domicile-focus-requested", (event) => {
    console.log(
      `GUARD focus-requested ${event.detail.appId} bubbles=${event.bubbles} cancelable=${event.cancelable}`,
    );
  });
  document.addEventListener("keydown", (event) => {
    console.log(`GUARD keydown ${event.code}`);
  });
  document.addEventListener("domicile-key-delivered", (event) => {
    console.log(
      `GUARD key-delivered ${event.target.getAttribute?.("app-id") ?? event.target.localName} bubbles=${event.bubbles}`,
    );
  });
  // What reached the page, for the failure message only: the verdict never
  // reads these. Capture-phase on the window, so they hear an event before
  // anything can stop it, and change nothing the <app> does with it.
  for (const type of ["pointerdown", "pointerup", "mousedown", "wheel"]) {
    window.addEventListener(
      type,
      (event) => {
        console.log(
          `GUARD saw ${type} ${event.target.localName}#${event.target.getAttribute?.("app-id") ?? ""} at ${event.clientX},${event.clientY} trusted=${event.isTrusted}`,
        );
      },
      { capture: true, passive: true },
    );
  }
  if (KIND === "div") {
    document.addEventListener("pointerdown", (event) => {
      console.log(`GUARD pressed ${event.target.localName}`);
    });
  }

  let said = false;
  const ready = () => {
    const ids = desktop.windows.map((window) => window.appId);
    if (!said && ids.includes("term") && ids.includes("menu")) {
      said = true;
      console.log("GUARD ready");
    }
  };
  desktop.addEventListener("windowschanged", ready);
  ready();
};
