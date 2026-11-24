// The shell guard-extension-menu.sh drives: a page that manages one installed
// extension through `installedExtensions` and its three calls.
//
// WHAT THIS PAGE SAYS, all of it to the console, which the engine writes to its
// own log:
//
//   GUARD listening            the desktop was handed to Shell and a listener
//                              is registered
//   GUARD installed count=…    an `installedextensionschanged` arrived, and
//                              how many rows it had. The control's reading
//                              that its absence is an answer
//   GUARD row enabled=… fromConfig=… icon=… configured=…
//                              the `?expect=` row, the first time it arrives
//   GUARD private              the row has no `inPrivate`: private windows
//                              are a private browser profile's switches
//   GUARD locked               configureExtension() of a setting the config
//                              sets was refused with an OperationError
//   GUARD kept                 uninstallExtension() of the config's extension
//                              was refused with an OperationError
//   GUARD off                  setExtensionEnabled(false) switched it off: its
//                              row says so and `extensions` has no action
//   GUARD on                   setExtensionEnabled(true) switched it back on,
//                              action and all
//   GUARD refused              (the control) setExtensionEnabled() of an
//                              extension that is not installed was refused
//   GUARD failed step=… error=…
//                              a call rejected where it should have resolved,
//                              or the reverse
//
// Everything is inside `HostShell`, which the document Domicile writes calls once
// the module has loaded.

export const HostShell = (_root, desktop) => {
  const say = (what) => {
    console.log(`GUARD ${what}`);
  };

  const host = desktop;
  if (host === null || host === undefined) {
    throw new Error(
      "guard-extension-menu: no desktop was handed to Shell, so this document" +
        " was not served by the forked engine",
    );
  }

  const params = new URLSearchParams(location.search);
  const expected = params.get("expect");
  // The control's list stays empty; the claim's can be empty at first, before
  // the config's extension has loaded, so only the control decides on it.
  const control = params.get("control") === "1";
  if (expected === null) {
    throw new Error("guard-extension-menu: ?expect= is required");
  }

  const rowOf = () =>
    host.installedExtensions?.find(({ id }) => id === expected);
  const inTray = () =>
    host.extensions?.some(({ id }) => id === expected) ?? false;

  /** Says `step` failed: `error` is what came back, or "none" for a resolve. */
  const failed = (step) => (error) => {
    say(
      `failed step=${step} error=${error?.name ?? "none"} ${error?.message ?? ""}`,
    );
  };

  /** Says `line` if the call rejected with an OperationError, and runs `next`. */
  const refused = (step, line, next) => (error) => {
    if (error?.name === "OperationError") {
      say(line);
      next();
    } else {
      failed(step)(error);
    }
  };

  // The step waiting on a change, which each event checks. Each runs once.
  let waiting = undefined;
  const check = () => {
    if (waiting?.done()) {
      const { then } = waiting;
      waiting = undefined;
      then();
    }
  };
  const when = (done, then) => {
    waiting = { done, then };
    check();
  };

  const switchOn = () => {
    host.setExtensionEnabled(expected, true).catch(failed("on"));
    when(
      () => rowOf()?.enabled === true && inTray(),
      () => say("on"),
    );
  };
  const switchOff = () => {
    host.setExtensionEnabled(expected, false).catch(failed("off"));
    when(
      () => rowOf()?.enabled === false && !inTray(),
      () => {
        say("off");
        switchOn();
      },
    );
  };
  const uninstall = () => {
    host
      .uninstallExtension(expected)
      .then(failed("kept"), refused("kept", "kept", switchOff));
  };
  const lock = () => {
    host
      .configureExtension(expected, { fileAccess: true })
      .then(failed("locked"), refused("locked", "locked", uninstall));
  };
  const noPrivate = () => {
    if ("inPrivate" in (rowOf() ?? {})) {
      say("failed step=private error=the row still has inPrivate");
    } else {
      say("private");
      lock();
    }
  };

  let started = false;
  host.addEventListener("installedextensionschanged", () => {
    say(`installed count=${host.installedExtensions.length}`);
    const row = rowOf();
    if (!started) {
      if (control) {
        started = true;
        // The control: an extension that is not installed is refused.
        host.setExtensionEnabled(expected, false).then(
          failed("refused"),
          refused("refused", "refused", () => undefined),
        );
      } else if (row !== undefined) {
        started = true;
        say(
          `row enabled=${row.enabled} fromConfig=${row.fromConfig}` +
            ` icon=${row.icon.startsWith("data:image/png;base64,")}` +
            ` configured=${row.configured.join(",")}`,
        );
        noPrivate();
      }
    }
    check();
  });
  host.addEventListener("extensionschanged", check);
  say("listening");
};
