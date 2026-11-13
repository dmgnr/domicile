// The shell guard-windows-state.sh drives. It fires every event name the
// desktop has, reads `domicile.windows` once to bind the channel, then reads
// nothing until the compositor stand-in has said everything -- a shell that
// listens late -- and reports what the attributes hold:
//
//   GUARD names missing=…          every event the desktop names, fired at an
//                                  addEventListener listener and at its
//                                  on<name> handler; `none` or which did not
//                                  fire
//   GUARD listening                the channel is bound
//   GUARD windows <json>           `windows`, every field of every window
//   GUARD focused <id|null>        `focusedWindow`
//   GUARD appearance <a> <c> <m>   `accentColor`, `highContrast`,
//                                  `reducedMotion`
//   GUARD changed n=…              how many `windowschanged` it heard after
//                                  subscribing late: none are owed, and the
//                                  attribute is what carries the state
//   GUARD system data=…            a `system_reply` the stand-in sent, as it
//                                  reached this page: the relay inward. The
//                                  stand-in's log holds the outward one

// THE NAMES. The desktop's event names are the fork's own, in
// modules/domicile/domicile_event_names.h, rather than entries in Blink's
// event_type_names.json5 -- which recompiled most of Blink for every name
// added. Each is fired at a listener and at its on<name> handler: the handler
// is keyed on the fork's name, so a name the list and the IDL disagree on is a
// handler that never runs. packages/domicile-engine/tests/test-engine-event-names.sh keeps this list
// and the fork's the same set, reading it at the top level of this file.
const EVENT_NAMES = [
  "shortcut",
  "shortcutrelease",
  "gesture",
  "focusrequested",
  "browserwindowschanged",
  "castsinkschanged",
  "pictureinpicturevideoschanged",
  "downloadschanged",
  "displayschanged",
  "windowschanged",
  "focusedwindowchanged",
  "clipboardchanged",
  "traychanged",
  "notificationschanged",
  "extensionschanged",
  "extensionpopuprequested",
  "idlechanged",
  "lockedchanged",
  "themechanged",
  "windowsthemechanged",
  "modifierschanged",
  "appearancechanged",
  "shelloptionschanged",
  "system",
  "portalrequests",
  "compositorreplaced",
];

// Under guard-windows-state.sh's 60-second wait for this page's last line.
const READ_DEADLINE_MS = 30_000;

export const HostShell = (_root, desktop) => {
  const host = desktop;
  if (host === null || host === undefined) {
    throw new Error(
      "guard-windows-state: no desktop was handed to Shell, so this document" +
        " was not served by the forked engine",
    );
  }

  const missing = EVENT_NAMES.flatMap((name) => {
    const heard = { handler: false, listener: false };
    const listener = () => {
      heard.listener = true;
    };
    host.addEventListener(name, listener);
    host[`on${name}`] = () => {
      heard.handler = true;
    };
    host.dispatchEvent(new Event(name));
    host.removeEventListener(name, listener);
    host[`on${name}`] = null;
    return [
      ...(heard.listener ? [] : [name]),
      ...(heard.handler ? [] : [`on${name}`]),
    ];
  });
  console.log(
    `GUARD names missing=${missing.length === 0 ? "none" : missing.join(",")}`,
  );

  // A system call's answer, as the stand-in wrote it. The names check above
  // fired an untrusted `system`, which is not an answer. The stand-in sends it
  // last, on the same socket as every window message, so it is when to read.
  // READ_DEADLINE_MS reads anyway when it never comes: a channel that stopped
  // partway still gets a reading the verdict can name the cause from.
  const read = once(() => report(host));
  host.addEventListener("system", (event) => {
    if (event.isTrusted) {
      console.log(`GUARD system data=${event.data}`);
      read();
    }
  });
  setTimeout(read, READ_DEADLINE_MS);

  // Reading binds the channel, which is what has the compositor announce.
  void host.windows;
  console.log("GUARD listening");

  // One call the browser must wrap as a `system_request`, and one that is not
  // a call and must not reach the compositor at all.
  host.callSystem(1, JSON.stringify({ call: "stat", path: "/" }));
  host.callSystem(2, "not a call");
  // Must reach the compositor as `sync_frames`.
  host.syncFrames();
};

// Reads the attributes once, as a shell that listens late would.
const report = (host) => {
  let changed = 0;
  host.addEventListener("windowschanged", () => {
    changed += 1;
  });
  const windows = host.windows.map((window) => ({
    appId: window.appId,
    clientFrame: window.clientFrame,
    cursor: window.cursor,
    desktopId: window.desktopId,
    dialog: window.dialog,
    frame: window.frame,
    gid: window.gid,
    grab: window.grab,
    height: window.height,
    inhibitsShortcuts: window.inhibitsShortcuts,
    maxHeight: window.maxHeight,
    maxWidth: window.maxWidth,
    minHeight: window.minHeight,
    minWidth: window.minWidth,
    parent: window.parent,
    pid: window.pid,
    pidfdInode: window.pidfdInode,
    sandboxAppId: window.sandboxAppId,
    sandboxEngine: window.sandboxEngine,
    sandboxed: window.sandboxed,
    sandboxInstanceId: window.sandboxInstanceId,
    title: window.title,
    transientFor: window.transientFor,
    uid: window.uid,
    urgent: window.urgent,
    width: window.width,
    x: window.x,
    y: window.y,
  }));
  console.log(`GUARD windows ${JSON.stringify(windows)}`);
  console.log(`GUARD focused ${host.focusedWindow}`);
  console.log(
    `GUARD appearance ${host.accentColor} ${host.highContrast} ${host.reducedMotion}`,
  );
  setTimeout(() => {
    console.log(`GUARD changed n=${changed}`);
  }, 500);
};

const once = (fn) => {
  let done = false;
  return () => {
    if (!done) {
      done = true;
      fn();
    }
  };
};
