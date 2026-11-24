// The shell guard-shell-workers.sh drives. It starts each kind of worker from
// a script beside it and waits for each to reply:
//
//   GUARD workers classic=<word> module=<word> shared=<word> shared-module=<word>
//
// where <word> is the worker's reply, `error` when the worker failed to start,
// or `silent` when it said nothing in time. Each worker loads
// guard-shell-workers-word.js, so a reply also means its own imports loaded.
//
// Domicile calls `HostShell` once the module loads.

// Long enough for a loaded crux, short enough to report inside the guard's
// deadline.
const REPLY_MS = 15_000;

export const HostShell = () => {
  Promise.all([
    reply(dedicated("guard-shell-workers-classic.js", "classic")),
    reply(dedicated("guard-shell-workers-module.js", "module")),
    reply(shared("guard-shell-workers-classic.js", "classic")),
    reply(shared("guard-shell-workers-module.js", "module")),
  ])
    .then(([classic, module, sharedClassic, sharedModule]) => {
      console.log(
        `GUARD workers classic=${classic} module=${module} shared=${sharedClassic} shared-module=${sharedModule}`,
      );
    })
    .catch((error) => {
      console.error("guard-shell-workers: the shell could not report", error);
    });
};

/** A dedicated worker of `type` on `script`, as a port to ask and an error target. */
const dedicated = (script, type) => {
  const worker = new Worker(new URL(script, import.meta.url), { type });
  return { failed: worker, port: worker };
};

/** A shared worker of `type` on `script`, as a port to ask and an error target. */
const shared = (script, type) => {
  const worker = new SharedWorker(new URL(script, import.meta.url), {
    name: `guard-shell-workers-${type}`,
    type,
  });
  worker.port.start();
  return { failed: worker, port: worker.port };
};

/** What the worker answers `ping` with, `error` or `silent`. */
const reply = ({ port, failed }) =>
  new Promise((resolve) => {
    const timeout = setTimeout(() => resolve("silent"), REPLY_MS);
    const settle = (word) => {
      clearTimeout(timeout);
      resolve(word);
    };
    port.addEventListener("message", (event) => settle(String(event.data)));
    failed.addEventListener("error", () => settle("error"));
    port.postMessage("ping");
  });
