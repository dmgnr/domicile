// Gives the app every Electron API a Linux app can reach, whether or not
// Domicile has it, so an app never meets a bare `undefined` where Electron
// has a function. A method Electron has only on macOS or Windows does
// nothing, as Electron's does on Linux. One Domicile has no stand-in for hands the app back to its
// own Electron when called, naming the API; see `unsupported` in main.ts.
// Reads of what not even Electron has are logged at debug, for the app's
// developer.
// See "Every API" in docs/architecture/ELECTRON-APPS.md.

import { ELECTRON_INSTANCES, ELECTRON_SURFACE } from "./surface";
import { ELECTRON_VERSION } from "./version";

/** Keys runtimes and libraries probe any object for, which aren't the app's. */
const PROBED = new Set([
  "$$typeof",
  "__esModule",
  "asymmetricMatch",
  "constructor",
  "default",
  "inspect",
  "nodeType",
  "then",
  "toJSON",
]);

type Hooks = {
  /** Gives up on running the app here; never returns. */
  readonly unsupported: (why: string) => never;
  /** Logs what the app reached for that Domicile doesn't have, once per name. */
  readonly warn: (why: string) => void;
  /**
   * Logs what the app reached for that not even Electron has on Linux, once
   * per name, for the app's developer. Electron gives the same `undefined`.
   */
  readonly absent: (why: string) => void;
};

/** A stand-in for `module.member` that hands the app back when called. */
const missing = (app: string, module: string, member: string, hooks: Hooks) =>
  function missingElectronApi() {
    return hooks.unsupported(
      `${app} called ${module}.${member}, which Domicile's Electron doesn't have yet`,
    );
  };

/** A class whose construction hands the app back. */
const missingClass = (app: string, module: string, hooks: Hooks) =>
  class MissingElectronClass {
    constructor() {
      hooks.unsupported(
        `${app} made a ${module}, which Domicile's Electron doesn't have yet`,
      );
    }
  };

/**
 * Fills in `electron`, in place, to Electron's whole Linux surface, and wraps
 * each module object so a read of a name Electron doesn't have is logged.
 */
export const completeElectron = (
  electron: Record<string, unknown>,
  app: string,
  hooks: Hooks,
) => {
  const warned = new Set<string>();
  const once = (name: string, say: (why: string) => void, why: string) => {
    if (!warned.has(name)) {
      warned.add(name);
      say(`${app} reached for ${name}, which ${why}`);
    }
  };
  for (const [name, { elsewhere, kind, methods, properties }] of Object.entries(
    ELECTRON_SURFACE,
  )) {
    let module = electron[name] as Record<string, unknown> | undefined;
    if (module === undefined) {
      module = (
        kind === "class" ? missingClass(app, name, hooks) : {}
      ) as Record<string, unknown>;
    }
    for (const method of methods) {
      if (!(method in module)) {
        Object.defineProperty(module, method, {
          configurable: true,
          value: missing(app, name, method, hooks),
          writable: true,
        });
      }
    }
    // What Electron has only on macOS or Windows does nothing on Linux.
    for (const method of elsewhere) {
      if (
        !(method in module) &&
        !(methods as readonly string[]).includes(method)
      ) {
        Object.defineProperty(module, method, {
          configurable: true,
          value: function elsewhereOnly() {
            return undefined;
          },
          writable: true,
        });
      }
    }
    for (const property of properties) {
      if (!(property in module)) {
        Object.defineProperty(module, property, {
          configurable: true,
          get: () => {
            once(
              `${name}.${property}`,
              hooks.warn,
              "Domicile's Electron doesn't have yet",
            );
            return undefined;
          },
        });
      }
    }
    electron[name] =
      kind === "class"
        ? module
        : new Proxy(module, {
            get: (target, key) => {
              if (
                typeof key === "string" &&
                !PROBED.has(key) &&
                !(key in target)
              ) {
                once(
                  `${name}.${key}`,
                  hooks.absent,
                  `Electron ${ELECTRON_VERSION} doesn't have on Linux`,
                );
              }
              // The target, not the proxy, as `this`: getters read private fields.
              return Reflect.get(target, key);
            },
          });
  }
  return electron;
};

/** A name Electron's typings give the objects an app gets: `BrowserWindow`, `WebContents`. */
export type InstanceType = keyof typeof ELECTRON_INSTANCES;

/**
 * Fills in the prototypes of the objects the app gets, in place, to their
 * Electron classes' whole Linux surface, as `completeElectron` does the
 * modules. A member the host gives each object itself still wins: it is the
 * object's own.
 */
export const completeInstances = (
  prototypes: Partial<Record<InstanceType, object>>,
  app: string,
  hooks: Hooks,
) => {
  const warned = new Set<string>();
  for (const [type, prototype] of Object.entries(prototypes) as [
    InstanceType,
    object,
  ][]) {
    if (prototype === Object.prototype) {
      throw new Error(
        `${type}'s stand-in is a plain object, so its prototype can't be completed`,
      );
    }
    const { elsewhere, methods, properties } = ELECTRON_INSTANCES[type];
    for (const method of methods) {
      if (!(method in prototype)) {
        Object.defineProperty(prototype, method, {
          configurable: true,
          value: missing(app, type, method, hooks),
          writable: true,
        });
      }
    }
    for (const method of elsewhere) {
      if (
        !(method in prototype) &&
        !(methods as readonly string[]).includes(method)
      ) {
        Object.defineProperty(prototype, method, {
          configurable: true,
          value: function elsewhereOnly() {
            return undefined;
          },
          writable: true,
        });
      }
    }
    for (const property of properties) {
      if (!(property in prototype)) {
        Object.defineProperty(prototype, property, {
          configurable: true,
          get() {
            const name = `${type}.${property}`;
            if (!warned.has(name)) {
              warned.add(name);
              hooks.warn(
                `${app} reached for ${name}, which Domicile's Electron doesn't have yet`,
              );
            }
            return undefined;
          },
          // An object that sets it keeps its own.
          set(value: unknown) {
            Object.defineProperty(this, property, {
              configurable: true,
              enumerable: true,
              value,
              writable: true,
            });
          },
        });
      }
    }
  }
};
