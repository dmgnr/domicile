// The sound server (PulseAudio or PipeWire) for a shell's mixer, through
// `pactl` and `parec` run by `@domicile-desktop/sdk/system`.
//
// - `pactl` and `parec` work with both PulseAudio and `pipewire-pulse`. The
//   compositor's `PATH` must have them.
// - Requests run one at a time, in order, so the last volume a slider sent is
//   the one the server keeps.

import type { Result } from "@cprussin/option-result";
import { Err, Ok } from "@cprussin/option-result";
import type { Processes } from "@domicile-desktop/sdk/desktop/processes";

import { Asked } from "./asked";
import type { Audio, AudioDevice, Meter } from "./audio";
import { AudioError } from "./audio-error";
import { parseId, Target } from "./ids";
import { meters } from "./meters";
import { Request } from "./request";
import { requestQueue } from "./request-queue";
import { readServer, watchAudio } from "./watch-audio";

/** The calls this library makes. */
export type AudioDesktop = {
  readonly processes: Pick<Processes, "run" | "spawn">;
};

/** Each meter's loudest sample since the last report, 0 through 1, by id. */
export type Levels = ReadonlyMap<string, number>;

/** Running meters. Metering a microphone records it: stop when not shown. */
export type Meters = {
  /** Meter these ids from these sources, and stop metering the rest. */
  meter: (wanted: ReadonlyMap<string, Meter>) => void;
  stop: () => void;
};

/** Ids come from {@link SoundServer.watch}; volumes are fractions of 100%. */
export type SoundServer = {
  /**
   * Calls `onAudio` with the server's state and again after each change.
   * Never calls it without a sound server. Returns a stop function.
   */
  watch: (onAudio: (audio: Audio) => void) => () => void;
  /** Kept between 0 and 1.5, pavucontrol's maximum. */
  setVolume: (id: string, volume: number) => Promise<Result<Asked, AudioError>>;
  /**
   * Unmuting a filter device also unmutes what it passes through
   * ({@link AudioDevice.through}). Muting mutes only `id`.
   */
  setMuted: (id: string, muted: boolean) => Promise<Result<Asked, AudioError>>;
  /** Make a device the default for new streams. */
  setDefault: (id: string) => Promise<Result<Asked, AudioError>>;
  /** Move a stream to a device of its own direction. */
  moveStream: (
    id: string,
    device: string,
  ) => Promise<Result<Asked, AudioError>>;
  setPort: (id: string, port: string) => Promise<Result<Asked, AudioError>>;
  setProfile: (
    card: string,
    profile: string,
  ) => Promise<Result<Asked, AudioError>>;
  /** Level meters, reported to `onLevels` while any is running. */
  meters: (onLevels: (levels: Levels) => void) => Meters;
};

/** How long to wait; shortened by tests. */
export type Timing = {
  /** Quiet after a change before the server is read again. */
  settleMs: number;
  /** Delay before subscribing again after a subscription ends. */
  reopenMs: number;
  /** Interval between meter reports. */
  tickMs: number;
};

/** Says that something keeps failing in the background. */
export type Report = (message: string, detail: unknown) => void;

const TIMING: Timing = { reopenMs: 5000, settleMs: 30, tickMs: 50 };

/** The sound server, reached through `domicile`'s processes. */
export const soundServer = (
  domicile: AudioDesktop,
  timing: Timing = TIMING,
  report: Report = warn,
): SoundServer => {
  const ask = requestQueue(domicile);
  return {
    meters: (onLevels) => meters(domicile, onLevels, timing.tickMs, report),
    moveStream: (id, device) => ask(Request.Move(id, device)),
    setDefault: (id) => ask(Request.Default(id)),
    setMuted: (id, muted) =>
      muted || !namesADevice(id)
        ? ask(Request.Muted(id, muted))
        : unmuteChain(domicile, ask, id),
    setPort: (id, port) => ask(Request.Port(id, port)),
    setProfile: (card, profile) => ask(Request.Profile(card, profile)),
    setVolume: (id, volume) => ask(Request.Volume(id, volume)),
    watch: (onAudio) => watchAudio(domicile, onAudio, timing, report),
  };
};

type Ask = (request: Request) => Promise<Result<Asked, AudioError>>;

const namesADevice = (id: string): boolean =>
  parseId(id).match({
    Err: () => false,
    Ok: ({ target }) => target === Target.Output || target === Target.Input,
  });

/**
 * Unmutes a device, then whatever muted stream or device it passes through,
 * read fresh so a mute made elsewhere is seen. The device's own unmute is
 * queued first, so a mute asked during the read still comes after it. The
 * first refusal is the answer.
 */
const unmuteChain = async (
  domicile: AudioDesktop,
  ask: Ask,
  id: string,
): Promise<Result<Asked, AudioError>> => {
  const own = ask(Request.Muted(id, false));
  const links = (await readServer(domicile)).andThenAsync(
    async (audio): Promise<Result<Asked, AudioError>> => {
      const device = [...audio.outputs, ...audio.inputs].find(
        (candidate) => candidate.id === id,
      );
      if (device === undefined) {
        return Err(AudioError.UnknownId(id));
      } else {
        const asked = await Promise.all(
          mutedLinks(device).map((link) => ask(Request.Muted(link, false))),
        );
        return asked.find((answer) => answer.isErr()) ?? Ok(Asked.Done);
      }
    },
  );
  return (await own).and(await links);
};

/** Each muted link in a device's chain. */
const mutedLinks = (device: AudioDevice): string[] =>
  device.through.filter((link) => link.muted).map((link) => link.id);

const warn: Report = (message, detail) => {
  // biome-ignore lint/suspicious/noConsole: background failures have no caller to return to
  console.warn(message, detail);
};
