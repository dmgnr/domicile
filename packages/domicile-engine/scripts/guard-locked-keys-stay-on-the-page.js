// The shell guard-locked-keys-stay-on-the-page.sh drives: a lock screen's
// field, focused, over a window the compositor says has the keyboard. It
// reports:
//
//   GUARD ready              the window is on the desk, it has the keyboard,
//                            and the desk's lock state has arrived
//   GUARD typed <value>      what the field holds after each `input`
//   GUARD key-delivered      a key press was sent to the window's client

export const HostShell = (_root, desktop) => {
  if (desktop === null || desktop === undefined) {
    throw new Error(
      "guard-locked-keys-stay-on-the-page: no desktop was handed to Shell, so" +
        " this document was not served by the forked engine",
    );
  }
  const app = document.createElement("app");
  app.setAttribute("app-id", "term");
  Object.assign(app.style, {
    height: "200px",
    left: "0",
    position: "fixed",
    top: "0",
    width: "400px",
  });
  document.body.append(app);

  const field = document.createElement("input");
  field.type = "password";
  Object.assign(field.style, {
    left: "500px",
    position: "fixed",
    top: "300px",
  });
  document.body.append(field);
  field.addEventListener("input", () => {
    console.log(`GUARD typed ${field.value}`);
  });
  app.addEventListener("domicile-key-delivered", () => {
    console.log("GUARD key-delivered");
  });

  let said = false;
  const ready = () => {
    if (
      !said &&
      desktop.focusedWindow === "term" &&
      typeof desktop.locked === "boolean"
    ) {
      said = true;
      field.focus();
      console.log(`GUARD ready locked=${desktop.locked}`);
    }
  };
  desktop.addEventListener("windowschanged", ready);
  desktop.addEventListener("focusedwindowchanged", ready);
  desktop.addEventListener("lockedchanged", ready);
  ready();
};
