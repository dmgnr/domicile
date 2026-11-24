// Parses `pactl -f json info` and `pactl -f json list` into `Audio`.
//
// Run `pactl` under `LC_ALL=C`: it translates some values, such as a port's
// availability, that this module matches as English words.

import type { Result } from "@cprussin/option-result";
import { Err, Ok } from "@cprussin/option-result";
import { z } from "zod";

import type {
  Audio,
  AudioCard,
  AudioDevice,
  AudioLink,
  AudioStream,
} from "./audio";
import { Meter } from "./audio";
import { Target, targetId } from "./ids";

/** The raw volume `pactl` reports for 100%. */
export const NORMAL = 65_536;

/** Application id of this library's meters, so they are hidden from the lists. */
export const METER_APPLICATION = "org.domicile.meter";

/** Applications whose streams are level meters. Matches pavucontrol's list. */
const MIXERS = new Set([
  METER_APPLICATION,
  "org.PulseAudio.pavucontrol",
  "org.gnome.VolumeControl",
  "org.kde.kmixd",
]);

/** PipeWire property shared by a filter's device and its stream. */
const LINK_GROUP = "node.link-group";

/** Parses the output of `pactl -f json info` and `pactl -f json list`. */
export const reading = (info: string, list: string): Result<Audio, string> => {
  const parsedInfo = parseJson(infoSchema, info);
  const parsedList = parseJson(listSchema, list);
  return parsedInfo.andThen((server) =>
    parsedList.map((devices) => audioOf(server, devices)),
  );
};

const volumeSchema = z.record(z.string(), z.unknown());

const propertiesSchema = z.record(z.string(), z.string()).default({});

const infoSchema = z.object({
  default_sink_name: z.string().nullish(),
  default_source_name: z.string().nullish(),
});

const deviceSchema = z.object({
  active_port: z.string().nullish(),
  description: z.string().nullish(),
  index: z.number(),
  /** On a source, the sink it monitors; on a sink, its monitor source. */
  monitor_source: z.string().nullish(),
  mute: z.boolean(),
  name: z.string(),
  ports: z
    .array(
      z.object({
        availability: z.string(),
        description: z.string(),
        name: z.string(),
      }),
    )
    .default([]),
  properties: propertiesSchema,
  volume: volumeSchema,
});

const streamSchema = z.object({
  index: z.number(),
  mute: z.boolean(),
  properties: propertiesSchema,
  /** A sink input's device. */
  sink: z.number().optional(),
  /** A source output's device. */
  source: z.number().optional(),
  volume: volumeSchema,
});

const cardSchema = z.object({
  active_profile: z.string().nullish(),
  name: z.string(),
  profiles: z.record(
    z.string(),
    z.object({
      available: z.boolean(),
      description: z.string(),
      priority: z.number().default(0),
    }),
  ),
  properties: propertiesSchema,
});

const listSchema = z.object({
  cards: z.array(cardSchema).default([]),
  sink_inputs: z.array(streamSchema).default([]),
  sinks: z.array(deviceSchema).default([]),
  source_outputs: z.array(streamSchema).default([]),
  sources: z.array(deviceSchema).default([]),
});

type Info = z.infer<typeof infoSchema>;
type List = z.infer<typeof listSchema>;
type Device = z.infer<typeof deviceSchema>;
type Stream = z.infer<typeof streamSchema>;
type Card = z.infer<typeof cardSchema>;

const parseJson = <T extends NonNullable<unknown>>(
  schema: z.ZodType<T>,
  text: string,
): Result<T, string> => {
  const json = z.string().transform(jsonOf).pipe(schema).safeParse(text);
  return json.success ? Ok(json.data) : Err(z.prettifyError(json.error));
};

const jsonOf = (text: string, context: z.RefinementCtx): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    context.addIssue({ code: "custom", input: text, message: "not JSON" });
    return z.NEVER;
  }
};

const audioOf = (info: Info, list: List): Audio => {
  const outputsByIndex = new Map(
    list.sinks.map((sink) => [sink.index, targetId(Target.Output, sink.name)]),
  );
  const inputsByIndex = new Map(
    list.sources.map((source) => [
      source.index,
      targetId(Target.Input, source.name),
    ]),
  );
  const plumbing = new Set(
    [...list.sinks, ...list.sources].flatMap((device) => {
      const group = device.properties[LINK_GROUP];
      return group === undefined ? [] : [group];
    }),
  );
  const listed = (stream: Stream) =>
    !isAMixers(stream) && !isPlumbing(stream, plumbing);
  const outputs: Side = {
    at: (stream) => stream.sink,
    device: Target.Output,
    devices: list.sinks,
    stream: Target.Playback,
    streams: list.sink_inputs,
  };
  const inputs: Side = {
    at: (stream) => stream.source,
    device: Target.Input,
    devices: list.sources,
    stream: Target.Recording,
    streams: list.source_outputs,
  };
  return {
    cards: list.cards.map(card),
    inputs: list.sources.map((source) =>
      device(source, inputs, plumbing, info.default_source_name),
    ),
    meters: meters(list),
    outputs: list.sinks.map((sink) =>
      device(sink, outputs, plumbing, info.default_sink_name),
    ),
    playback: list.sink_inputs
      .filter(listed)
      .map((playing) =>
        stream(
          playing,
          Target.Playback,
          outputsByIndex.get(playing.sink ?? -1),
        ),
      ),
    recording: list.source_outputs
      .filter(listed)
      .map((recording) =>
        stream(
          recording,
          Target.Recording,
          inputsByIndex.get(recording.source ?? -1),
        ),
      ),
  };
};

/** An output's monitor source (if any), an input itself, or a stream. */
const meters = (list: List): ReadonlyMap<string, Meter> =>
  new Map<string, Meter>([
    ...list.sinks.flatMap((sink) =>
      sink.monitor_source === undefined || sink.monitor_source === null
        ? []
        : [
            [
              targetId(Target.Output, sink.name),
              Meter.Source(sink.monitor_source),
            ] as const,
          ],
    ),
    ...list.sources.map(
      (source) =>
        [
          targetId(Target.Input, source.name),
          Meter.Source(source.name),
        ] as const,
    ),
    ...list.sink_inputs.map(
      (playing) =>
        [
          targetId(Target.Playback, playing.index),
          Meter.Stream(playing.index),
        ] as const,
    ),
  ]);

/** One direction: outputs and their playback, or inputs and their recording. */
type Side = {
  device: Target;
  stream: Target;
  devices: readonly Device[];
  streams: readonly Stream[];
  /** The index of the device a stream plays to or records from. */
  at: (stream: Stream) => number | undefined;
};

const device = (
  from: Device,
  side: Side,
  plumbing: ReadonlySet<string>,
  defaultName: string | null | undefined,
): AudioDevice => {
  const monitor = side.device === Target.Input && isAMonitor(from);
  // A monitor carries its sink's link group, but records the sink, not the
  // filter's input chain.
  const links = monitor ? [] : through(side, from, new Set([from.index]));
  return {
    default: defaultName === from.name,
    description: from.description ?? from.name,
    filtered: side.streams.some(
      (stream) =>
        isPlumbing(stream, plumbing) && side.at(stream) === from.index,
    ),
    id: targetId(side.device, from.name),
    monitor,
    muted: from.mute || links.some((link) => link.muted),
    port: from.active_port ?? undefined,
    ports: from.ports.map((port) => ({
      available: port.availability !== "not available",
      description: port.description,
      name: port.name,
    })),
    through: links,
    volume: loudest(from.volume),
  };
};

/**
 * What a filter's sound passes through: each stream in its link group, the
 * device that stream plays to or records from, and that device's own links.
 * `seen` holds the devices already in the chain, so a loop ends.
 */
const through = (
  side: Side,
  from: Device,
  seen: ReadonlySet<number>,
): AudioLink[] => {
  const group = from.properties[LINK_GROUP];
  return group === undefined
    ? []
    : side.streams
        .filter((stream) => stream.properties[LINK_GROUP] === group)
        .flatMap((stream) => {
          const next = side.devices.find(
            (candidate) => candidate.index === side.at(stream),
          );
          return [
            { id: targetId(side.stream, stream.index), muted: stream.mute },
            ...(next === undefined || seen.has(next.index)
              ? []
              : [
                  { id: targetId(side.device, next.name), muted: next.mute },
                  ...through(side, next, new Set([...seen, next.index])),
                ]),
          ];
        });
};

/**
 * Whether a source monitors a sink. Uses `device.class` when the server sets
 * it, else whether `monitor_source` names a sink. Some `pactl` versions write
 * "none" there as `""` or `"n/a"`.
 */
const isAMonitor = (source: Device): boolean => {
  const deviceClass = source.properties["device.class"];
  return deviceClass === undefined
    ? namesASink(source.monitor_source)
    : deviceClass === "monitor";
};

const namesASink = (sink: string | null | undefined): boolean =>
  sink !== undefined && sink !== null && sink !== "" && sink !== "n/a";

/**
 * Uses the application name with the media name as title. Without an
 * application name, the media name becomes the name and there is no title.
 */
const stream = (
  from: Stream,
  kind: Target,
  device: string | undefined,
): AudioStream => {
  const media = from.properties["media.name"];
  const application = from.properties["application.name"];
  return {
    application: application ?? media ?? "Unknown",
    device,
    id: targetId(kind, from.index),
    muted: from.mute,
    title: application === undefined ? undefined : media,
    volume: loudest(from.volume),
  };
};

const isAMixers = (stream: Stream): boolean => {
  const application = stream.properties["application.id"];
  return application !== undefined && MIXERS.has(application);
};

/**
 * Whether a stream carries a filter device's audio to the hardware, such as a
 * PipeWire filter-chain for speaker correction. It shares the device's link
 * group.
 */
const isPlumbing = (stream: Stream, plumbing: ReadonlySet<string>): boolean => {
  const group = stream.properties[LINK_GROUP];
  return group !== undefined && plumbing.has(group);
};

const card = (from: Card): AudioCard => ({
  description: from.properties["device.description"] ?? from.name,
  id: from.name,
  profile: from.active_profile ?? undefined,
  profiles: Object.entries(from.profiles)
    .toSorted(
      ([aName, a], [bName, b]) =>
        b.priority - a.priority || byCodeUnits(aName, bName),
    )
    .map(([name, profile]) => ({
      available: profile.available,
      description: profile.description,
      name,
    })),
});

/**
 * The loudest channel as a fraction of 100%. An invalid volume, reported as
 * `{"error": ...}`, reads as 0.
 */
const loudest = (volume: Readonly<Record<string, unknown>>): number =>
  Math.max(
    0,
    ...Object.values(volume).flatMap((channel) => {
      const parsed = channelSchema.safeParse(channel);
      return parsed.success ? [parsed.data.value / NORMAL] : [];
    }),
  );

const channelSchema = z.object({ value: z.number() });

const byCodeUnits = (a: string, b: string): number => {
  if (a < b) {
    return -1;
  } else {
    return a > b ? 1 : 0;
  }
};
