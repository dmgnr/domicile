// A shell's logs, by subsystem.
//
// Each line goes to the console with the subsystem first, `[notifications]
// shown 3`. The engine logs a shell's console at its own severity, so
// `error` is an error in the desktop's logs, shown by default, and `debug`
// shows once `domicile set-log-level debug shell` asks for it. The launcher
// files the name as `DOMICILE_SUBSYSTEM`, so
// `journalctl --user -t domicile-shell DOMICILE_SUBSYSTEM=notifications`
// reads one part of a shell. See docs/LOGGING.md.

/** Logs for one part of a shell. */
export type Logger = {
  /** Something broke that the user would notice. Shown by default. */
  error: (...said: unknown[]) => void;
  /** Something unexpected the shell got past. */
  warn: (...said: unknown[]) => void;
  /** A change worth a line. */
  info: (...said: unknown[]) => void;
  /** Detail for tracing an issue. */
  debug: (...said: unknown[]) => void;
};

/** What a {@link Logger} writes to: the console, or a test's stand-in. */
export type LogSink = Pick<Console, "error" | "warn" | "info" | "debug">;

const NAME = /^[A-Za-z0-9_-]+$/;

/**
 * Logs for the part of a shell named `subsystem`: letters, digits, `-` and
 * `_`, such as `notifications` or `launcher`.
 */
export const logger = (subsystem: string, sink: LogSink = console): Logger => {
  if (!NAME.test(subsystem)) {
    throw new Error(
      `a logger's subsystem is letters, digits, - and _, not ${JSON.stringify(subsystem)}`,
    );
  }
  const tag = `[${subsystem}]`;
  return {
    debug: (...said) => sink.debug(tag, ...said),
    error: (...said) => sink.error(tag, ...said),
    info: (...said) => sink.info(tag, ...said),
    warn: (...said) => sink.warn(tag, ...said),
  };
};
