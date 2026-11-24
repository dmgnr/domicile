// The sound server's state, as `watchAudio` reports it.
//
// Ids are opaque. A device id is `output:` or `input:` plus the device name,
// which survives a server restart. A stream id is `playback:` or `recording:`
// plus the stream index, which lasts as long as the stream.

/** A port of a device, or a profile of a card: something to switch it to. */
export type AudioChoice = {
  /** What `setPort` and `setProfile` name it by. */
  name: string;
  description: string;
  /**
   * `false` for a port with an empty jack, or a profile that needs one. It can
   * still be selected.
   */
  available: boolean;
};

/** An output (a sink) or an input (a source). */
export type AudioDevice = {
  id: string;
  description: string;
  /** The loudest channel's volume as a fraction of 100%. Can exceed 1. */
  volume: number;
  /**
   * Whether it is silent from a mute: its own, or one on anything in
   * {@link AudioDevice.through}. `setMuted(id, false)` unmutes them all.
   */
  muted: boolean;
  /** Whether new streams go to it. */
  default: boolean;
  /**
   * Whether it is an output's monitor source, which records what the output
   * plays. Always `false` for an output.
   */
  monitor: boolean;
  /** E.g. speakers, headphones, line in. Often empty. */
  ports: readonly AudioChoice[];
  /** The {@link AudioChoice.name} of the port in use, if it has ports. */
  port: string | undefined;
  /**
   * For a filter, such as speaker correction: what its sound passes through
   * to or from the hardware, nearest first. Its filter stream, the device
   * that stream plays to or records from, and on. Empty for other devices.
   */
  through: readonly AudioLink[];
  /**
   * Whether a filter plays to it or records from it. Pickers hide it:
   * choosing it would skip the filter.
   */
  filtered: boolean;
};

/** A stream or device a filter's sound passes through. */
export type AudioLink = {
  /** A device id, or a stream id for the filter's own stream. */
  id: string;
  /** Its own mute. */
  muted: boolean;
};

/** Something playing (a sink input) or recording (a source output). */
export type AudioStream = {
  id: string;
  /** The application playing or recording it. */
  application: string;
  /** The stream title, if the application set one. */
  title: string | undefined;
  volume: number;
  muted: boolean;
  /** The {@link AudioDevice.id} it plays to or records from, if listed. */
  device: string | undefined;
};

/** A sound card and its profiles, which select the enabled devices. */
export type AudioCard = {
  id: string;
  description: string;
  /** Sorted best first. */
  profiles: readonly AudioChoice[];
  /** The {@link AudioChoice.name} of the profile in use. */
  profile: string | undefined;
};

export enum MeterKind {
  /** A source by name: an input, or an output's monitor. */
  Source,
  /** A playback stream by index, as pavucontrol meters one. */
  Stream,
}

/** Where a level meter records from. */
export const Meter = {
  Source: (name: string) => ({ kind: MeterKind.Source as const, name }),
  Stream: (index: number) => ({ index, kind: MeterKind.Stream as const }),
};

export type Meter = ReturnType<(typeof Meter)[keyof typeof Meter]>;

/** Every output, input, stream and card. */
export type Audio = {
  outputs: readonly AudioDevice[];
  inputs: readonly AudioDevice[];
  playback: readonly AudioStream[];
  recording: readonly AudioStream[];
  cards: readonly AudioCard[];
  /** Where each meterable device or stream id is metered from. */
  meters: ReadonlyMap<string, Meter>;
};
