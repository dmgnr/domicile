// The shell guard-desk-state.sh drives. It binds the channel and polls the
// state attributes without listening for their events, logging a reading
// whenever one changes:
//
//   GUARD listening              the channel is bound
//   GUARD state <json>           every attribute the stand-in spoke to

export const HostShell = (_root, desktop) => {
  const host = desktop;
  if (host === null || host === undefined) {
    throw new Error(
      "guard-desk-state: no desktop was handed to Shell, so this document was not" +
        " served by the forked engine",
    );
  }
  // Listening is what binds the channel -- see DomicileHost::AddedEventListener.
  host.addEventListener("idlechanged", () => undefined);
  console.log("GUARD listening");

  // Polled: the stand-in's lines reach the page later on a loaded machine, so a
  // single read after a fixed delay can miss some. The guard judges the latest.
  let logged;
  setInterval(() => {
    const reading = JSON.stringify(readState(host));
    if (reading !== logged) {
      logged = reading;
      console.log(`GUARD state ${reading}`);
    }
  }, 250);
};

const readState = (host) => ({
  altKey: host.altKey,
  clipboard: host.clipboard?.map(
    ({ current, id, image, preview, thumbnail }) => ({
      current,
      id,
      image,
      preview,
      thumbnail,
    }),
  ),
  ctrlKey: host.ctrlKey,
  idle: host.idle,
  locked: host.locked,
  shellOptions: host.shellOptions,
  shiftKey: host.shiftKey,
  theme: host.theme,
  tray: host.tray?.map(({ bus, id, itemIsMenu, menu, title }) => ({
    bus,
    id,
    itemIsMenu,
    menu,
    title,
  })),
  windowsTheme: host.windowsTheme,
});
