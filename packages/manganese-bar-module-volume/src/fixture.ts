import type { Result } from "@cprussin/option-result";
import { Ok } from "@cprussin/option-result";
import { sharedWatch } from "@domicile-desktop/react/shared-watch";
import { Asked } from "@domicile-desktop/system-audio/asked";
import type {
  Audio,
  AudioDevice,
  AudioStream,
} from "@domicile-desktop/system-audio/audio";
import { Meter } from "@domicile-desktop/system-audio/audio";
import type { AudioError } from "@domicile-desktop/system-audio/audio-error";
import type {
  Levels,
  SoundServer,
} from "@domicile-desktop/system-audio/sound-server";
import { act } from "@testing-library/react";

/** An audio device with test overrides. */
export const device = (overrides: Partial<AudioDevice>): AudioDevice => ({
  default: false,
  description: "Speakers",
  filtered: false,
  id: "output:speakers",
  monitor: false,
  muted: false,
  port: undefined,
  ports: [],
  through: [],
  volume: 0.5,
  ...overrides,
});

/** An audio stream with test overrides. */
export const stream = (overrides: Partial<AudioStream>): AudioStream => ({
  application: "Firefox",
  device: "output:speakers",
  id: "playback:42",
  muted: false,
  title: "A song",
  volume: 1,
  ...overrides,
});

/** Laptop audio: speakers, headphones, a microphone and one playing stream. */
export const laptop: Audio = {
  cards: [
    {
      description: "Built-in Audio",
      id: "alsa_card.pci",
      profile: "output:analog-stereo",
      profiles: [
        {
          available: true,
          description: "Analog Stereo Output",
          name: "output:analog-stereo",
        },
        { available: true, description: "Off", name: "off" },
      ],
    },
  ],
  inputs: [
    device({
      description: "Monitor of Speakers",
      id: "input:speakers.monitor",
      monitor: true,
      volume: 1,
    }),
    device({
      default: true,
      description: "Microphone",
      id: "input:mic",
      volume: 0.3,
    }),
  ],
  meters: new Map<string, Meter>([
    ["output:speakers", Meter.Source("speakers.monitor")],
    ["output:hdmi", Meter.Source("hdmi.monitor")],
    ["input:speakers.monitor", Meter.Source("speakers.monitor")],
    ["input:mic", Meter.Source("mic")],
    ["playback:42", Meter.Stream(42)],
  ]),
  outputs: [
    device({
      default: true,
      port: "analog-output-speaker",
      ports: [
        {
          available: true,
          description: "Speakers",
          name: "analog-output-speaker",
        },
        {
          available: false,
          description: "Headphones",
          name: "analog-output-headphones",
        },
      ],
    }),
    device({ description: "HDMI", id: "output:hdmi", volume: 1 }),
  ],
  playback: [stream({})],
  recording: [
    stream({
      application: "Recorder",
      device: "input:mic",
      id: "recording:7",
      title: undefined,
    }),
  ],
};

/** One request the shell made: method name and arguments. */
export type Request = readonly [method: string, ...args: unknown[]];

/**
 * A fake sound server for tests.
 *
 * - `report` and `levels` stand in for the server.
 * - `asked` and `metered` record the shell's requests.
 */
export const heldSound = () => {
  const listeners: ((audio: Audio) => void)[] = [];
  const meters: ((levels: Levels) => void)[] = [];
  const asked: Request[] = [];
  /** Each set of ids the shell metered, in order; empty once it stopped. */
  const metered: (readonly string[])[] = [];
  const counts = { started: 0, stopped: 0 };
  const record =
    (method: string) =>
    (...args: unknown[]): Promise<Result<Asked, AudioError>> => {
      asked.push([method, ...args]);
      return Promise.resolve(Ok(Asked.Done));
    };
  const server: SoundServer = {
    meters: (onLevels) => {
      counts.started += 1;
      meters.push(onLevels);
      return {
        meter: (wanted) => {
          metered.push([...wanted.keys()]);
        },
        stop: () => {
          counts.stopped += 1;
          metered.push([]);
        },
      };
    },
    moveStream: record("moveStream"),
    setDefault: record("setDefault"),
    setMuted: record("setMuted"),
    setPort: record("setPort"),
    setProfile: record("setProfile"),
    setVolume: record("setVolume"),
    watch: (onAudio) => {
      listeners.push(onAudio);
      return () => undefined;
    },
  };
  return {
    asked,
    audio: sharedWatch(server.watch),
    /** Sends a level for each metered id. */
    levels: (levels: Levels) => {
      act(() => {
        for (const onLevels of meters) {
          onLevels(levels);
        }
      });
    },
    metered,
    report: (audio: Audio) => {
      act(() => {
        for (const onAudio of listeners) {
          onAudio(audio);
        }
      });
    },
    server,
    /** How many times the shell started meters. */
    get started() {
      return counts.started;
    },
    /** How many times the shell stopped meters. */
    get stopped() {
      return counts.stopped;
    },
  };
};
