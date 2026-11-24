// Holds `pactl subscribe` open and reads the server again after each burst of
// changes settles, subscribing again when the subscription ends.

import type { Result } from "@cprussin/option-result";

import type { Audio } from "./audio";
import { AudioError } from "./audio-error";
import { C_LOCALE, pactl } from "./pactl";
import { reading } from "./reading";
import type { AudioDesktop, Report, Timing } from "./sound-server";
import { announcesAChange } from "./subscription";

const SUBSCRIBE = ["pactl", "-f", "json", "subscribe"];

/** See `SoundServer.watch`. */
export const watchAudio = (
  domicile: AudioDesktop,
  onAudio: (audio: Audio) => void,
  timing: Timing,
  report: Report,
): (() => void) => {
  const stopping = new AbortController();
  const told = (audio: Audio) => {
    if (!stopping.signal.aborted) {
      onAudio(audio);
    }
  };
  keepSubscribed(domicile, told, timing, report, stopping.signal).catch(
    (error: unknown) => {
      // biome-ignore lint/suspicious/noConsole: a broken watch has no caller to return to
      console.error("the sound server watch broke", error);
    },
  );
  return () => {
    stopping.abort();
  };
};

/** Subscribes until stopped, saying once if there is no sound server. */
const keepSubscribed = async (
  domicile: AudioDesktop,
  onAudio: (audio: Audio) => void,
  timing: Timing,
  report: Report,
  signal: AbortSignal,
) => {
  let said = false;
  while (!signal.aborted) {
    const ended = await subscribe(domicile, onAudio, timing, report, signal);
    if (!said) {
      said = ended.match({
        Err: (error) => {
          report(
            "no sound server to read; the mixer is empty until there is",
            error,
          );
          return true;
        },
        Ok: () => false,
      });
    }
    await sleep(timing.reopenMs, signal);
  }
};

/**
 * One subscription: reads the server, then again after each settled burst of
 * changes, until `pactl` exits. Fails if the first read does.
 */
const subscribe = async (
  domicile: AudioDesktop,
  onAudio: (audio: Audio) => void,
  timing: Timing,
  report: Report,
  signal: AbortSignal,
): Promise<Result<"ended", AudioError>> =>
  (await domicile.processes.spawn(SUBSCRIBE, C_LOCALE))
    .mapErr((error): AudioError => AudioError.Refused(error.message))
    .andThenAsync(async (subscription) => {
      const kill = () => {
        subscription.kill();
      };
      signal.addEventListener("abort", kill);
      const settling = {
        reads: Promise.resolve(),
        timer: undefined as ReturnType<typeof setTimeout> | undefined,
      };
      const changed = () => {
        clearTimeout(settling.timer);
        settling.timer = setTimeout(() => {
          settling.reads = settling.reads.then(async () => {
            (await readServer(domicile)).match({
              Err: (error) => {
                report("the sound server could not be read", error);
              },
              Ok: onAudio,
            });
          });
        }, timing.settleMs);
      };
      // Read after subscribing, so no change in between is missed.
      const first = await readServer(domicile);
      first.match({
        // Returned below, once the subscription ends.
        Err: () => undefined,
        Ok: onAudio,
      });
      await forEachLine(subscription.stdout, (line) => {
        if (announcesAChange(line)) {
          changed();
        }
      });
      await subscription.exited;
      clearTimeout(settling.timer);
      await settling.reads;
      signal.removeEventListener("abort", kill);
      return first.map(() => "ended" as const);
    });

/** Reads the server's whole state once. */
export const readServer = async (
  domicile: AudioDesktop,
): Promise<Result<Audio, AudioError>> => {
  const info = await pactl(domicile, ["-f", "json", "info"]);
  const list = await pactl(domicile, ["-f", "json", "list"]);
  return info.andThen((server) =>
    list.map((devices) => parsed(server, devices)),
  );
};

/** Throws on output that is not `pactl`'s JSON: a format this does not know. */
const parsed = (info: string, list: string): Audio =>
  reading(info, list).match({
    Err: (why) => {
      throw new Error(`unreadable pactl JSON: ${why}`);
    },
    Ok: (audio) => audio,
  });

const forEachLine = async (
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
) => {
  const decoder = new TextDecoder();
  let carried = "";
  for await (const bytes of stream) {
    const text = decoder.decode(bytes, { stream: true });
    const lines = (carried + text).split("\n");
    carried = lines.slice(-1).join("");
    for (const line of lines.slice(0, -1)) {
      onLine(line);
    }
  }
};

/** Resolves after `ms`, or at once when `signal` aborts. */
const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
