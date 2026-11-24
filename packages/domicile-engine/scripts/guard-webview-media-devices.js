// The shell guard-webview-media-devices.sh runs: one browser window, whose
// element lists the cameras, prefers one, and lists them again.
//
// Logs to the console, which the engine writes to its log:
//
//   GUARD shell-loaded               the module ran
//   GUARD listed cameras=…           the cameras, most preferred first
//   GUARD bad-kind name=…            what setMediaDevice("speaker") threw
//   GUARD preferred id=…             setMediaDevice resolved
//   GUARD refused id=… name=…        setMediaDevice rejected
//   GUARD relisted cameras=…         the cameras after the choice
//   GUARD never-listed why=…         no two cameras ever came back
//
// `?prefer=last` prefers the last camera listed; any other value is an id
// sent as is, which the control uses for one no camera has.

export const HostShell = () => {
  const say = (what) => {
    console.log(`GUARD ${what}`);
  };

  const parameters = new URLSearchParams(location.search);
  const src = parameters.get("src");
  const prefer = parameters.get("prefer");
  if (src === null || prefer === null) {
    throw new Error(
      "guard-webview-media-devices: ?src= and ?prefer= are required",
    );
  } else {
    const view = document.createElement("webview");
    view.style.position = "absolute";
    view.style.inset = "0";
    view.style.border = "0";
    document.body.append(view);
    view.setAttribute("src", src);

    const ids = (devices) => devices.cameras.map(({ id }) => id).join(",");
    const wait = (milliseconds) =>
      new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
      });

    // The element has no guest until the page is attached, so this asks
    // until two cameras come back. The engine answers the first ask once
    // Chrome has listed them.
    const listed = async (tries, why) => {
      if (tries === 0) {
        say(`never-listed why=${why}`);
        return undefined;
      } else {
        try {
          const devices = await view.mediaDevices();
          return devices.cameras.length >= 2
            ? devices
            : (await wait(250), listed(tries - 1, `cameras=${ids(devices)}`));
        } catch (error) {
          await wait(250);
          return listed(tries - 1, error.name);
        }
      }
    };

    const run = async () => {
      const devices = await listed(240, "never asked");
      if (devices !== undefined) {
        say(`listed cameras=${ids(devices)}`);
        try {
          await view.setMediaDevice("speaker", devices.cameras[0].id);
          say("bad-kind name=none");
        } catch (error) {
          say(`bad-kind name=${error.name}`);
        }
        const id = prefer === "last" ? devices.cameras.at(-1).id : prefer;
        try {
          await view.setMediaDevice("camera", id);
          say(`preferred id=${id}`);
        } catch (error) {
          say(`refused id=${id} name=${error.name}`);
        }
        say(`relisted cameras=${ids(await view.mediaDevices())}`);
      }
    };
    run().catch((error) => {
      say(`threw ${error}`);
    });

    say("shell-loaded");
  }
};
