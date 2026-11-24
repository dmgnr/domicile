// The app module guard-app-module.sh runs with `run_app`. Domicile calls
// `main` with the document's body and the `AppDomicile` the SDK's layer
// builds over a DomicileAppHost.
//
//   GUARD app-main narrow=<bool>   main ran; narrow when the desktop has no
//                                  `windows`, so it is not the shell's
//   GUARD app-answered written=<bool>  the stand-in compositor's answer to
//                                  the call reached the app, through the
//                                  layer
//   GUARD app-fetch own=… shell=…  whether fetch() read the app's own
//                                  file and the shell's: read, empty or
//                                  refused
//   GUARD app-isolated isolated=<bool> shared=<bool>  crossOriginIsolated,
//                                  and whether SharedArrayBuffer exists

export const main = (root, domicile) => {
  const say = (what) => {
    console.log(`GUARD ${what}`);
  };
  root.textContent = "app module";
  say(
    `app-isolated isolated=${crossOriginIsolated} shared=${typeof SharedArrayBuffer === "function"}`,
  );
  say(
    `app-main narrow=${domicile.windows === undefined && typeof domicile.files?.write === "function"}`,
  );
  // The stand-in compositor answers every call `written`.
  domicile.files
    .write("/guard-app-module", "")
    .then((written) => {
      say(`app-answered written=${written.isOk()}`);
    })
    .catch((error) => {
      console.error("guard-app-module: the app's call failed", error);
    });
  Promise.all([
    reading("app.js", "export const main"),
    reading("domicile://shell/guard-app-module.js", "export const HostShell"),
  ])
    .then(([own, shell]) => {
      say(`app-fetch own=${own} shell=${shell}`);
    })
    .catch((error) => {
      console.error("guard-app-module: the app could not report", error);
    });
};

/** Whether fetch() answered `url` with `marker`, without it, or failed. */
const reading = (url, marker) =>
  fetch(url)
    .then((response) => response.text())
    .then(
      (text) => (text.includes(marker) ? "read" : "empty"),
      () => "refused",
    );
