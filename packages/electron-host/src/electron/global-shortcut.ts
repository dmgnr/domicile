// The stand-in for Electron's `globalShortcut`. A Wayland client can't take a
// key from the whole desktop, so every registration fails as Electron's does
// for a key another app holds: `register` answers false. The shell's own
// bindings are where a desktop-wide key belongs.

export const createGlobalShortcut = (warn: (why: string) => void) => {
  let suspended = false;
  const refuse = (accelerator: string) => {
    warn(
      `globalShortcut can't take ${accelerator} on Domicile: bind it in the shell instead`,
    );
    return false;
  };
  return {
    isRegistered: (_accelerator: string) => false,
    isSuspended: () => suspended,
    register: (accelerator: string, _callback: () => void) =>
      refuse(accelerator),
    registerAll: (accelerators: readonly string[], _callback: () => void) => {
      for (const accelerator of accelerators) {
        refuse(accelerator);
      }
    },
    setSuspended: (value: boolean) => {
      suspended = value;
    },
    unregister: (_accelerator: string) => undefined,
    unregisterAll: () => undefined,
  };
};
