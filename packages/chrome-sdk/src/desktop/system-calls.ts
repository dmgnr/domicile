// The compositor's system calls, typed: what the desktop's namespaces call
// through. Not exported from the SDK; a shell reaches these through its
// `Domicile`. See docs/SHELL-SYSTEM-ACCESS.md.
//
// Each call goes out through `callSystem` with an id, and its answers come
// back as `system` events carrying that id. A call that can fail resolves a
// `Result`; a bug in the protocol throws.

import type { Result } from "@cprussin/option-result";
import { Err, Ok } from "@cprussin/option-result";
import { z } from "zod";

import type { DomicileHost } from "../domicile-host";
import type { InhibitorAction } from "../inhibitor-action";
import { wireInhibitorAction } from "../inhibitor-action";
import type { KeymapChoice, Keymaps } from "../keymap-choice";
import { wireKeymapChoice } from "../keymap-choice";
import type { KnownAgents } from "../portal";
import type { PreviewedWindow } from "../previewed-window";
import { PreviewedWindowKind } from "../previewed-window";
import type {
  CommandRan,
  Link,
  ShellBinding,
  ShellCommand,
  ShellCommandHelp,
} from "../shell-command";
import type {
  ByteRange,
  DbusBody,
  DbusCall,
  DbusMatch,
  DbusSignal,
  DirEntry,
  Exit,
  Listening,
  Ran,
  SpawnOptions,
  Stat,
  Subprocess,
  SystemError,
  UnlockRefused,
  VirtualMonitor,
  VirtualMonitorMode,
  Watch,
} from "../system";
import {
  Bus,
  FileType,
  Listened,
  ScreenshotKept,
  Signal,
  SystemErrorKind,
  UnlockRefusal,
} from "../system";
import type {
  SystemEndMessage,
  SystemEventMessage,
  SystemReplyMessage,
} from "../system-message";
import { parseSystemMessage } from "../system-message";
import type { Bell, WindowState } from "../window-state";
import { ResizeEdge, WindowRequest, wireWindowState } from "../window-state";
import { readAgentReach } from "./portal-wire";

/**
 * The calls. A relative path starts at the home. The compositor runs each in
 * the desktop's environment and refuses most of them while the desktop is
 * locked.
 */
export type System = {
  /** The whole file, or `length` bytes from `offset`: fewer at its end. */
  readFile: (
    path: string,
    range?: ByteRange,
  ) => Promise<Result<Uint8Array, SystemError>>;
  readTextFile: (path: string) => Promise<Result<string, SystemError>>;
  /** Atomic by default: a reader never sees half a file. Writes under `/sys` and `/proc` must not be. */
  writeFile: (
    path: string,
    data: Uint8Array | string,
    options?: { atomic?: boolean },
  ) => Promise<Result<"written", SystemError>>;
  /** Fails {@link SystemErrorKind.AlreadyExists} if anything has the name. */
  createDir: (path: string) => Promise<Result<"created", SystemError>>;
  readDir: (path: string) => Promise<Result<DirEntry[], SystemError>>;
  stat: (path: string) => Promise<Result<Stat, SystemError>>;
  watch: (path: string) => Promise<Result<Watch, SystemError>>;
  /** Run `argv` directly, with no shell; `argv[0]` is looked up on `PATH`. */
  spawn: (
    argv: readonly string[],
    options?: SpawnOptions,
  ) => Promise<Result<Subprocess, SystemError>>;
  /** {@link System.spawn}, collected as text once it ends. */
  run: (
    argv: readonly string[],
    options?: Omit<SpawnOptions, "stdin">,
  ) => Promise<Result<Ran, SystemError>>;
  dbusCall: (call: DbusCall) => Promise<Result<DbusBody, SystemError>>;
  dbusMatch: (
    match: DbusMatch,
  ) => Promise<Result<Listening<Listened<DbusSignal>>, SystemError>>;
  /**
   * Take a screenshot as an interactive Screenshot portal call takes one, as
   * if the shell were the application: the desk freezes, `<PortalDialogs />`
   * draws the screenshot dialog, and the area picked is saved under
   * `$XDG_PICTURES_DIR/Screenshots/`, or copied to the clipboard instead when
   * the user presses Ctrl+C. Resolves with where it went. A call while the
   * shell's screenshot dialog is up resolves as that dialog does, and shows
   * no second one.
   */
  screenshot: () => Promise<Result<ScreenshotKept, SystemError>>;
  /**
   * Record the screen: `<PortalDialogs />` draws the screen cast picker, and
   * what is picked is recorded, with its sound, until its toolbar stops it.
   * Resolves with the WebM under `$XDG_VIDEOS_DIR/Screen recordings/`, or
   * fails `Canceled` when the picker is dismissed or the recording discarded.
   */
  screenRecord: () => Promise<Result<string, SystemError>>;
  /**
   * Draw `window` as it last drew itself, as a `data:` URL of a PNG, for a
   * picker to preview a window that is not on screen. A browser window's page
   * draws while it is captured, so a hidden one draws too.
   */
  previewWindow: (
    window: PreviewedWindow,
  ) => Promise<Result<string, SystemError>>;
  /**
   * Hear each command `domicile send-shell` sends. Every page listening hears
   * every command, and answers each with `answerShellCommand`; `send-shell`
   * fails when no page ran it. `commands` describes what this page runs, for
   * `domicile list-shell-commands`, and `bindings` the keys that run them, for
   * `domicile list-bindings`. Allowed while the desktop is locked.
   */
  shellCommands: (
    commands: readonly ShellCommandHelp[],
    bindings: readonly ShellBinding[],
  ) => Promise<Result<Listening<ShellCommand>, SystemError>>;
  /**
   * Open links of `schemes`, such as `mailto`, for the desktop: hear each one
   * `domicile open` (and so `xdg-open` and applications' links) and the
   * Email portal hand over, instead of the application that opens the
   * scheme. The page that claimed a scheme last gets its links.
   */
  claimLinks: (
    schemes: readonly string[],
  ) => Promise<Result<Listening<Link>, SystemError>>;
  /**
   * Say that this page ran the command numbered `sent`, with what
   * `domicile send-shell` prints if anything, or with `Err`, why it did not.
   */
  answerShellCommand: (
    sent: number,
    ran: Result<CommandRan, string>,
  ) => Promise<Result<"set", SystemError>>;
  /**
   * Hear `true` once nobody has been at the desk for `seconds`, and `false`
   * on the next input. Idle inhibitors hold it off as they hold off
   * blanking. `seconds` must be at least 1. Allowed while the desktop is
   * locked. See docs/SHELL-IDLE-AND-LOCK.md.
   */
  idleAfter: (
    seconds: number,
  ) => Promise<Result<Listening<boolean>, SystemError>>;
  /**
   * As `idleAfter`, `seconds` before the screens blank, to dim or count
   * down. Silent when the screens never blank, or blank sooner.
   */
  idleBeforeBlanking: (
    seconds: number,
  ) => Promise<Result<Listening<boolean>, SystemError>>;
  /**
   * Hear what holds the desktop awake: the app ids of the windows and
   * applications whose idle inhibitors keep the screens from blanking, to name
   * with `useApps`. The shell's own hold
   * through the portal is `"domicile"`. Heard at once, then on each change.
   * Allowed while the desktop is locked. See docs/IDLE.md.
   */
  idleHolds: () => Promise<Result<Listening<readonly string[]>, SystemError>>;
  /**
   * Hear why each passphrase sent with `unlock` did not open the desk. Every
   * page listening hears every refusal. Allowed while the desktop is locked.
   */
  unlockRefusals: () => Promise<Result<Listening<UnlockRefused>, SystemError>>;
  /**
   * Replace the `xdg_toplevel` states the shell set on window `appId`, and
   * configure it. States last until the shell replaces them, across reloads.
   * Fails {@link SystemErrorKind.NotFound} for a window the compositor does
   * not know. Allowed while the desktop is locked.
   */
  setWindowStates: (
    appId: string,
    states: readonly WindowState[],
  ) => Promise<Result<"set", SystemError>>;
  /**
   * Draw `display` (a display's `name`, connector or panel name, as a
   * profile matches it), or every monitor when it is left
   * out, as if its white were a light of `kelvin`, 1000 to 6500, as a
   * night light does; 6500 draws colors as they are. Fades from the color
   * drawn: about 1.5 s to switch a night light on, a few frames for a small
   * step. Every monitor's replaces each one's. Lasts until the shell sets another, across reloads. Changes
   * nothing on a nested desktop, nor on a monitor a night-light app such as
   * gammastep holds. Allowed while the desktop is locked.
   */
  setColorTemperature: (
    kelvin: number,
    display?: string,
  ) => Promise<Result<"set", SystemError>>;
  /**
   * Turn every monitor off now, keeping windows and workspaces as they are.
   * Input more than a second later lights them again, as does
   * {@link System.wakeDisplays}. With `display` (a display's `name`, connector
   * or panel name, as a profile matches it), turn
   * only that one off: it keeps its place and windows, and sleeps through
   * input until woken. Fails {@link SystemErrorKind.NotFound} for a display
   * the desktop does not have. Allowed while the desktop is locked. See
   * docs/IDLE.md#sleeping-on-demand.
   */
  sleepDisplays: (display?: string) => Promise<Result<"set", SystemError>>;
  /** The agents let in now, and those let in without asking. */
  agents: () => Promise<Result<KnownAgents, SystemError>>;
  /**
   * Make remembered agent `agent` ask again next time. Succeeds whether or
   * not it was remembered.
   */
  forgetAgent: (agent: string) => Promise<Result<"set", SystemError>>;
  /**
   * Light the monitors again, after {@link System.sleepDisplays} or idle
   * blanking, or only `display`. Allowed while the desktop is locked.
   */
  wakeDisplays: (display?: string) => Promise<Result<"set", SystemError>>;
  /**
   * Hear each maximize and fullscreen request a client makes. The compositor
   * grants none; grant one with {@link System.setWindowStates}. Allowed while
   * the desktop is locked.
   */
  windowRequests: () => Promise<Result<Listening<WindowRequest>, SystemError>>;
  /**
   * Hear each time a client rings the bell, such as a terminal's `\a`. The
   * compositor makes no sound. Allowed while the desktop is locked.
   */
  bells: () => Promise<Result<Listening<Bell>, SystemError>>;
  /**
   * Add a monitor with no connector, which the desk extends onto and only a
   * capture shows: casting to a TV. A later `displays` lists it. It lasts
   * until removed, or until the page goes away. Fails
   * {@link SystemErrorKind.Other} on a desk whose monitors the engine does
   * not report: nested, or described by `output.displays`. See
   * docs/CASTING-TO-TVS.md.
   */
  addVirtualMonitor: (
    mode: VirtualMonitorMode,
  ) => Promise<Result<VirtualMonitor, SystemError>>;
  /**
   * Hear `input.keyboard`'s keymaps and the one the desktop types on, at once
   * and on each switch or reload. Allowed while the desktop is locked.
   */
  keymaps: () => Promise<Result<Listening<Keymaps>, SystemError>>;
  /**
   * Switch every keyboard to another of the config's keymaps, until the
   * desktop restarts. Fails {@link SystemErrorKind.NotFound} for a name the
   * config does not have. Allowed while the desktop is locked.
   */
  selectKeymap: (choice: KeymapChoice) => Promise<Result<"set", SystemError>>;
  /**
   * Activate, deactivate or toggle the shortcuts inhibitor of the window with
   * the keyboard: the way back to the desktop from a VM. A window holding
   * none changes nothing.
   */
  switchShortcutsInhibitor: (
    action: InhibitorAction,
  ) => Promise<Result<"set", SystemError>>;
};

/** What {@link system} needs of the desktop `Shell` is handed. */
export type SystemHost = Pick<DomicileHost, "callSystem"> & {
  addEventListener: (
    type: "system",
    listener: (event: MessageEvent<string>) => void,
  ) => void;
};

/** The system calls through `host`. Any number may share one host. */
export const system = (host: SystemHost): System => {
  const calls = callsOn(host);
  return {
    addVirtualMonitor: (mode) => addVirtualMonitor(calls, mode),
    agents: () =>
      oneShot(calls, { call: "agents" }, (reply) =>
        reply.kind === "agents"
          ? {
              connected: reply.connected.map(({ agent, reach, session }) => ({
                agent,
                reach: readAgentReach(reach),
                session,
              })),
              remembered: reply.remembered.map(({ agent, last_used_ms }) => ({
                agent,
                lastUsedMs: last_used_ms,
              })),
            }
          : unexpected(reply),
      ),
    answerShellCommand: (sent, ran) =>
      oneShot(
        calls,
        {
          call: "answer_shell_command",
          // `refused` is left out when the page ran it, and `output` when it
          // printed nothing.
          ...ran.match<{ refused?: string; output?: string }>({
            Err: (refused) => ({ refused }),
            Ok: (done) => (done === "ran" ? {} : { output: done.output }),
          }),
          sent,
        },
        (reply) => (reply.kind === "set" ? "set" : unexpected(reply)),
      ),
    bells: () =>
      listening(calls, { call: "bells" }, (event) =>
        event.kind === "bell"
          ? { appId: event.app_id ?? undefined }
          : unexpected(event),
      ),
    claimLinks: (schemes) =>
      listening(calls, { call: "claim_links", schemes }, (event) =>
        event.kind === "link"
          ? { appId: event.app_id, url: event.url }
          : unexpected(event),
      ),
    createDir: (path) =>
      oneShot(calls, { call: "create_dir", path }, (reply) =>
        reply.kind === "created" ? "created" : unexpected(reply),
      ),
    dbusCall: (request) =>
      oneShot(
        calls,
        {
          body: JSON.stringify(request.body ?? []),
          bus: busName(request.bus),
          call: "dbus_call",
          destination: request.destination,
          interface: request.interface,
          member: request.member,
          path: request.path,
          signature: request.signature ?? "",
        },
        (reply) =>
          reply.kind === "returned"
            ? { body: dbusBody(reply.body), signature: reply.signature }
            : unexpected(reply),
      ),
    dbusMatch: (match) =>
      listening<Listened<DbusSignal>>(
        calls,
        {
          bus: busName(match.bus),
          call: "dbus_match",
          ...optional("sender", match.sender),
          ...optional("path", match.path),
          ...optional("interface", match.interface),
          ...optional("member", match.member),
        },
        (event) =>
          event.kind === "signal"
            ? Listened.Heard({
                body: dbusBody(event.body),
                interface: event.interface,
                member: event.member,
                path: event.path,
                sender: event.sender,
                signature: event.signature,
              })
            : unexpected(event),
        Listened.Missed(),
      ),
    forgetAgent: (agent) =>
      oneShot(calls, { agent, call: "forget_agent" }, (reply) =>
        reply.kind === "set" ? "set" : unexpected(reply),
      ),
    idleAfter: (seconds) =>
      listening(
        calls,
        { call: "idle_after", seconds },
        idleOf,
        // The next compositor's clock starts from its start.
        false,
      ),
    idleBeforeBlanking: (seconds) =>
      listening(
        calls,
        { call: "idle_before_blanking", seconds },
        idleOf,
        false,
      ),
    idleHolds: () =>
      listening(calls, { call: "idle_holds" }, (event) =>
        event.kind === "idle_holds" ? event.holders : unexpected(event),
      ),
    keymaps: () =>
      listening(calls, { call: "keymaps" }, (event) =>
        event.kind === "keymaps"
          ? {
              active: event.active,
              keymaps: event.keymaps.map(({ description, name }) => ({
                description,
                name,
              })),
            }
          : unexpected(event),
      ),
    previewWindow: (window) =>
      oneShot(
        calls,
        { call: "preview_window", window: wirePreviewedWindow(window) },
        (reply) => (reply.kind === "preview" ? reply.frame : unexpected(reply)),
      ),
    readDir: (path) =>
      oneShot(calls, { call: "read_dir", path }, (reply) =>
        reply.kind === "entries"
          ? reply.entries.map(({ file_type, name }) => ({
              fileType: fileType(file_type),
              name,
            }))
          : unexpected(reply),
      ),
    readFile: (path, range) => readFile(calls, path, range),
    readTextFile: async (path) =>
      (await readFile(calls, path, undefined)).map((bytes) =>
        new TextDecoder().decode(bytes),
      ),
    run: async (argv, options) =>
      (await spawn(calls, argv, options)).andThenAsync(async (process) => {
        const [stdout, stderr, exited] = await Promise.all([
          new Response(process.stdout).text(),
          new Response(process.stderr).text(),
          process.exited,
        ]);
        return exited.map((exit) => ({ ...exit, stderr, stdout }));
      }),
    screenRecord: () =>
      oneShot(calls, { call: "screen_record" }, (reply) =>
        reply.kind === "saved" ? reply.path : unexpected(reply),
      ),
    screenshot: () =>
      oneShot(calls, { call: "screenshot" }, (reply) => keptOf(reply)),
    selectKeymap: (choice) =>
      oneShot(
        calls,
        { call: "select_keymap", keymap: wireKeymapChoice(choice) },
        (reply) => (reply.kind === "set" ? "set" : unexpected(reply)),
      ),
    setColorTemperature: (kelvin, display) =>
      oneShot(
        calls,
        {
          call: "set_color_temperature",
          // Left out for every monitor.
          ...(display === undefined ? {} : { display }),
          // The compositor reads a whole number.
          kelvin: Math.round(kelvin),
        },
        (reply) => (reply.kind === "set" ? "set" : unexpected(reply)),
      ),
    setWindowStates: (appId, states) =>
      oneShot(
        calls,
        {
          app_id: appId,
          call: "set_window_states",
          states: states.map(wireWindowState),
        },
        (reply) => (reply.kind === "set" ? "set" : unexpected(reply)),
      ),
    shellCommands: (commands, bindings) =>
      listening(
        calls,
        { bindings, call: "shell_commands", commands },
        (event) =>
          event.kind === "shell_command"
            ? { sent: event.sent, words: event.command }
            : unexpected(event),
      ),
    sleepDisplays: (display) =>
      oneShot(
        calls,
        {
          call: "sleep_displays",
          // Left out for every monitor.
          ...(display === undefined ? {} : { display }),
        },
        (reply) => (reply.kind === "set" ? "set" : unexpected(reply)),
      ),
    spawn: (argv, options) => spawn(calls, argv, options),
    stat: (path) =>
      oneShot(calls, { call: "stat", path }, (reply) =>
        reply.kind === "stat"
          ? {
              fileType: fileType(reply.file_type),
              modifiedMs: reply.modified_ms ?? undefined,
              realPath: reply.real_path ?? undefined,
              size: reply.size,
            }
          : unexpected(reply),
      ),
    switchShortcutsInhibitor: (action) =>
      oneShot(
        calls,
        { action: wireInhibitorAction(action), call: "shortcuts_inhibitor" },
        (reply) => (reply.kind === "set" ? "set" : unexpected(reply)),
      ),
    unlockRefusals: () =>
      listening(calls, { call: "unlock_refusals" }, (event) =>
        event.kind === "unlock_refused"
          ? {
              failures: event.failures,
              refusal: unlockRefusal(event.refusal),
              retryInMs: event.retry_in_ms,
            }
          : unexpected(event),
      ),
    wakeDisplays: (display) =>
      oneShot(
        calls,
        {
          call: "wake_displays",
          // Left out for every monitor.
          ...(display === undefined ? {} : { display }),
        },
        (reply) => (reply.kind === "set" ? "set" : unexpected(reply)),
      ),
    watch: (path) =>
      listening<Listened<string>>(
        calls,
        { call: "watch", path },
        (event) =>
          event.kind === "changed"
            ? Listened.Heard(event.path)
            : unexpected(event),
        Listened.Missed(),
      ),
    windowRequests: () =>
      listening(calls, { call: "window_requests" }, (event) =>
        event.kind === "window_request"
          ? windowRequest(event.app_id, event.request)
          : unexpected(event),
      ),
    writeFile: (path, data, options) =>
      oneShot(
        calls,
        {
          atomic: options?.atomic ?? true,
          call: "write_file",
          data: toBase64(data),
          path,
        },
        (reply) => (reply.kind === "written" ? "written" : unexpected(reply)),
      ),
  };
};

type Reply = SystemReplyMessage["reply"];
type Event = SystemEventMessage["event"];
type End = SystemEndMessage["end"];
type WireError = Extract<Reply, { kind: "failed" }>["error"];

/** What a call in flight does with each answer under its id. */
type Handlers = {
  reply: (reply: Reply) => void;
  event: (event: Event) => void;
  end: (end: End) => void;
};

/** The calls in flight on one host, which name them. */
type Calls = {
  host: SystemHost;
  next: number;
  running: Map<number, Handlers>;
};

/** One registry per host, so two systems on a page never share an id. */
const registries = new WeakMap<SystemHost, Calls>();

const callsOn = (host: SystemHost): Calls => {
  const known = registries.get(host);
  if (known === undefined) {
    const calls: Calls = { host, next: 1, running: new Map() };
    host.addEventListener("system", (event) => {
      heard(calls, event.data);
    });
    registries.set(host, calls);
    return calls;
  } else {
    return known;
  }
};

/**
 * Hand a compositor line to the call it answers. An id with nothing here
 * belongs to another copy of this module on the same page.
 */
const heard = (calls: Calls, line: string): void => {
  const message = parseSystemMessage(line);
  const handlers = calls.running.get(message.id);
  if (handlers !== undefined) {
    switch (message.type) {
      case "system_reply": {
        handlers.reply(message.reply);
        break;
      }
      case "system_event": {
        handlers.event(message.event);
        break;
      }
      case "system_end": {
        calls.running.delete(message.id);
        handlers.end(message.end);
        break;
      }
    }
  }
};

/** Send `request` under a new id, with `handlers` for its answers. */
const call = (calls: Calls, request: object, handlers: Handlers): number => {
  const id = calls.next;
  calls.next = id + 1;
  calls.running.set(id, handlers);
  calls.host.callSystem(id, JSON.stringify(request));
  return id;
};

/** A call answered by one reply, which `read` turns into its value. */
const oneShot = <T extends NonNullable<unknown>>(
  calls: Calls,
  request: object,
  read: (reply: Reply) => T,
): Promise<Result<T, SystemError>> =>
  new Promise((resolve) => {
    const id = call(calls, request, {
      end: unexpected,
      event: unexpected,
      reply: (reply) => {
        calls.running.delete(id);
        resolve(
          reply.kind === "failed"
            ? Err(systemError(reply.error))
            : Ok(read(reply)),
        );
      },
    });
  });

const readFile = (
  calls: Calls,
  path: string,
  range: ByteRange | undefined,
): Promise<Result<Uint8Array, SystemError>> =>
  oneShot(
    calls,
    {
      call: "read_file",
      path,
      ...optional("offset", range?.offset),
      ...optional("length", range?.length),
    },
    (reply) =>
      reply.kind === "read" ? fromBase64(reply.data) : unexpected(reply),
  );

const spawn = (
  calls: Calls,
  argv: readonly string[],
  options: SpawnOptions | undefined,
): Promise<Result<Subprocess, SystemError>> =>
  new Promise((resolve) => {
    const stdout = streamed<Uint8Array>();
    const stderr = streamed<Uint8Array>();
    const exited = settled<Result<Exit, SystemError>>();
    const id = call(
      calls,
      {
        argv,
        call: "spawn",
        ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
        env: options?.env ?? {},
        stdin: options?.stdin ?? false,
      },
      {
        end: (end) => {
          stdout.close();
          stderr.close();
          exited.settle(exitOf(end));
        },
        event: (event) =>
          event.kind === "output"
            ? (event.stream === "stdout" ? stdout : stderr).push(
                fromBase64(event.data),
              )
            : unexpected(event),
        reply: (reply) => {
          if (reply.kind === "failed") {
            calls.running.delete(id);
            resolve(Err(systemError(reply.error)));
          } else {
            resolve(
              reply.kind === "started"
                ? Ok({
                    closeStdin: () => {
                      calls.host.callSystem(
                        id,
                        JSON.stringify({ call: "close_stdin" }),
                      );
                    },
                    exited: exited.promise,
                    kill: (signal = Signal.Term) => {
                      calls.host.callSystem(
                        id,
                        JSON.stringify({
                          call: "kill",
                          signal: signalName(signal),
                        }),
                      );
                    },
                    stderr: stderr.stream,
                    stdout: stdout.stream,
                    write: (data) => {
                      calls.host.callSystem(
                        id,
                        JSON.stringify({ call: "stdin", data: toBase64(data) }),
                      );
                    },
                  })
                : unexpected(reply),
            );
          }
        },
      },
    );
  });

const addVirtualMonitor = (
  calls: Calls,
  mode: VirtualMonitorMode,
): Promise<Result<VirtualMonitor, SystemError>> =>
  new Promise((resolve) => {
    const ended = settled<Result<"removed", SystemError>>();
    const id = call(
      calls,
      {
        call: "virtual_monitor",
        height: mode.height,
        name: mode.name,
        refresh_mhz: mode.refreshMhz,
        scale: mode.scale ?? 1,
        width: mode.width,
      },
      {
        end: (end) => {
          ended.settle(stopOf(end).map(() => "removed" as const));
        },
        event: unexpected,
        reply: (reply) => {
          if (reply.kind === "failed") {
            calls.running.delete(id);
            resolve(Err(systemError(reply.error)));
          } else {
            resolve(
              reply.kind === "virtual_monitor"
                ? Ok({
                    ended: ended.promise,
                    output: reply.output,
                    remove: () => {
                      calls.host.callSystem(
                        id,
                        JSON.stringify({ call: "unwatch" }),
                      );
                    },
                    resize: (size) => {
                      calls.host.callSystem(
                        id,
                        JSON.stringify({
                          call: "resize_virtual_monitor",
                          height: size.height,
                          refresh_mhz: size.refreshMhz,
                          scale: size.scale ?? 1,
                          width: size.width,
                        }),
                      );
                    },
                  })
                : unexpected(reply),
            );
          }
        },
      },
    );
  });

/**
 * A call that streams `item`s from its events until `unwatch` stops it: a
 * watch or a D-Bus match. One the browser ends because the compositor exited
 * is sent again, under a new id: the browser holds it for the next compositor.
 * Once the next one starts it, `missed`, when given, is streamed: what changed
 * in between was not heard. See "A compositor restart" in
 * docs/architecture/ENGINE-FORK.md.
 */
const listening = <T>(
  calls: Calls,
  request: object,
  item: (event: Event) => T,
  missed?: T,
): Promise<Result<Listening<T>, SystemError>> =>
  new Promise((resolve) => {
    const items = streamed<T>();
    const ended = settled<Result<"stopped", SystemError>>();
    let current = 0;
    let answered = false;
    let stopped = false;
    const end = (result: Result<"stopped", SystemError>) => {
      items.close();
      ended.settle(result);
    };
    const subscribe = (): void => {
      const id = call(calls, request, {
        end: (wire) => {
          if (isGone(wire)) {
            again();
          } else {
            end(stopOf(wire));
          }
        },
        event: (event) => {
          items.push(item(event));
        },
        reply: (reply) => {
          if (reply.kind === "failed") {
            calls.running.delete(id);
            if (isGone(reply)) {
              again();
            } else if (answered) {
              end(Err(systemError(reply.error)));
            } else {
              resolve(Err(systemError(reply.error)));
            }
          } else if (reply.kind !== "started") {
            unexpected(reply);
          } else if (answered) {
            if (missed !== undefined) {
              items.push(missed);
            }
          } else {
            answered = true;
            resolve(
              Ok({
                ended: ended.promise,
                items: items.stream,
                stop: () => {
                  stopped = true;
                  calls.host.callSystem(
                    current,
                    JSON.stringify({ call: "unwatch" }),
                  );
                },
              }),
            );
          }
        },
      });
      current = id;
    };
    const again = (): void => {
      if (stopped) {
        end(Ok("stopped"));
      } else {
        subscribe();
      }
    };
    subscribe();
  });

/** Whether the browser ended a call because its compositor exited. */
const isGone = (answer: Reply | End): boolean =>
  answer.kind === "failed" && answer.error.kind === "compositor_gone";

/** A stream fed from outside, for answers that arrive as events. */
const streamed = <T>() => {
  let controller: ReadableStreamDefaultController<T> | undefined;
  const stream = new ReadableStream<T>({
    start: (started) => {
      controller = started;
    },
  });
  const opened = (): ReadableStreamDefaultController<T> => {
    if (controller === undefined) {
      throw new Error("a ReadableStream's start runs in its constructor");
    } else {
      return controller;
    }
  };
  return {
    close: () => {
      opened().close();
    },
    push: (value: T) => {
      opened().enqueue(value);
    },
    stream,
  };
};

/** A promise settled from outside. */
const settled = <T>() => {
  const { promise, resolve } = Promise.withResolvers<T>();
  return { promise, settle: resolve };
};

const exitOf = (end: End): Result<Exit, SystemError> => {
  switch (end.kind) {
    case "exited": {
      return Ok({
        code: end.code ?? undefined,
        signal: end.signal ?? undefined,
      });
    }
    case "failed": {
      return Err(systemError(end.error));
    }
    case "stopped": {
      return unexpected(end);
    }
  }
};

const stopOf = (end: End): Result<"stopped", SystemError> => {
  switch (end.kind) {
    case "stopped": {
      return Ok("stopped");
    }
    case "failed": {
      return Err(systemError(end.error));
    }
    case "exited": {
      return unexpected(end);
    }
  }
};

/** An answer the protocol does not allow at this point: a compositor bug. */
/** `window` as a `preview_window` call names it. */
const wirePreviewedWindow = (
  window: PreviewedWindow,
): { id: string; type: "app" | "browser" } => {
  switch (window.kind) {
    case PreviewedWindowKind.App:
      return { id: window.id, type: "app" };
    case PreviewedWindowKind.Browser:
      return { id: window.id, type: "browser" };
  }
};

/** Where a screenshot call's reply says the screenshot went. */
const keptOf = (reply: Reply): ScreenshotKept => {
  switch (reply.kind) {
    case "saved":
      return ScreenshotKept.Saved(reply.path);
    case "copied":
      return ScreenshotKept.Copied();
    default:
      return unexpected(reply);
  }
};

type WireWindowRequest = Extract<Event, { kind: "window_request" }>["request"];

const windowRequest = (
  appId: string,
  request: WireWindowRequest,
): WindowRequest => {
  switch (request.kind) {
    case "maximize":
      return WindowRequest.Maximize(appId);
    case "unmaximize":
      return WindowRequest.Unmaximize(appId);
    case "fullscreen":
      return WindowRequest.Fullscreen(appId, request.display ?? undefined);
    case "unfullscreen":
      return WindowRequest.Unfullscreen(appId);
    case "minimize":
      return WindowRequest.Minimize(appId);
    case "move":
      return WindowRequest.Move(appId);
    case "resize":
      return WindowRequest.Resize(appId, resizeEdgeOf(request.edges));
  }
};

const resizeEdgeOf = (
  edges: Extract<WireWindowRequest, { kind: "resize" }>["edges"],
): ResizeEdge => {
  switch (edges) {
    case "top":
      return ResizeEdge.Top;
    case "bottom":
      return ResizeEdge.Bottom;
    case "left":
      return ResizeEdge.Left;
    case "right":
      return ResizeEdge.Right;
    case "top_left":
      return ResizeEdge.TopLeft;
    case "top_right":
      return ResizeEdge.TopRight;
    case "bottom_left":
      return ResizeEdge.BottomLeft;
    case "bottom_right":
      return ResizeEdge.BottomRight;
  }
};

/** Whether an idle watch's event says nobody is at the desk. */
const idleOf = (event: Event): boolean =>
  event.kind === "idle" ? event.idle : unexpected(event);

const unexpected = (answer: unknown): never => {
  throw new Error(`an unexpected system answer: ${JSON.stringify(answer)}`);
};

const systemError = (error: WireError): SystemError => ({
  kind: errorKind(error.kind),
  message: error.message,
});

const errorKind = (kind: WireError["kind"]): SystemErrorKind => {
  switch (kind) {
    case "not_found": {
      return SystemErrorKind.NotFound;
    }
    case "permission_denied": {
      return SystemErrorKind.PermissionDenied;
    }
    case "already_exists": {
      return SystemErrorKind.AlreadyExists;
    }
    case "not_a_directory": {
      return SystemErrorKind.NotADirectory;
    }
    case "is_a_directory": {
      return SystemErrorKind.IsADirectory;
    }
    case "invalid_input": {
      return SystemErrorKind.InvalidInput;
    }
    case "locked": {
      return SystemErrorKind.Locked;
    }
    case "dbus": {
      return SystemErrorKind.Dbus;
    }
    case "canceled": {
      return SystemErrorKind.Canceled;
    }
    case "compositor_gone": {
      return SystemErrorKind.CompositorGone;
    }
    case "other": {
      return SystemErrorKind.Other;
    }
  }
};

/** A D-Bus body's JSON text, as the array the page reads. */
const dbusBody = (text: string): unknown[] =>
  dbusBodySchema.parse(JSON.parse(text));

const dbusBodySchema = z.array(z.unknown());

const busName = (bus: Bus): string => {
  switch (bus) {
    case Bus.Session: {
      return "session";
    }
    case Bus.System: {
      return "system";
    }
  }
};

/** `{ [name]: value }`, or nothing when `value` is absent. */
const optional = (name: string, value: string | number | undefined) =>
  value === undefined ? {} : { [name]: value };

const fileType = (
  type: "file" | "directory" | "symlink" | "other",
): FileType => {
  switch (type) {
    case "file":
      return FileType.File;
    case "directory":
      return FileType.Directory;
    case "symlink":
      return FileType.Symlink;
    case "other":
      return FileType.Other;
  }
};

const unlockRefusal = (
  refusal: "wrong_passphrase" | "unverifiable" | "too_soon",
): UnlockRefusal => {
  switch (refusal) {
    case "wrong_passphrase":
      return UnlockRefusal.WrongPassphrase;
    case "unverifiable":
      return UnlockRefusal.Unverifiable;
    case "too_soon":
      return UnlockRefusal.TooSoon;
  }
};

const signalName = (signal: Signal): string => {
  switch (signal) {
    case Signal.Hup:
      return "hup";
    case Signal.Int:
      return "int";
    case Signal.Term:
      return "term";
    case Signal.Kill:
      return "kill";
    case Signal.Usr1:
      return "usr1";
    case Signal.Usr2:
      return "usr2";
  }
};

const toBase64 = (data: Uint8Array | string): string =>
  btoa(
    Array.from(
      typeof data === "string" ? new TextEncoder().encode(data) : data,
      (byte) => String.fromCharCode(byte),
    ).join(""),
  );

const fromBase64 = (data: string): Uint8Array =>
  Uint8Array.from(atob(data), (character) => character.charCodeAt(0));
