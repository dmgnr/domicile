// The shell for guard-media-services-at-rest.sh. It draws nothing and opens
// no page.
//
// It logs to the console, which the engine writes to its log:
//
//   GUARD shell-loaded           this module ran
//   GUARD listed devices=…       the control's enumerateDevices() answered
//   GUARD list-failed name=…     the control's enumerateDevices() threw
//
// `?list=1` (the control) lists the media devices, which starts the services
// that list them.
//
// Everything is inside `HostShell`, which Domicile's document calls once the
// module loads.

export const HostShell = () => {
  console.log("GUARD shell-loaded");
  if (new URLSearchParams(location.search).get("list") === "1") {
    navigator.mediaDevices.enumerateDevices().then(
      (devices) => {
        console.log(`GUARD listed devices=${String(devices.length)}`);
      },
      (error) => {
        console.log(`GUARD list-failed name=${error.name}`);
      },
    );
  }
};
