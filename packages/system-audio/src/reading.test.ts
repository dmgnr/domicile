import { describe, expect, it } from "bun:test";

import type { Audio, AudioChoice } from "./audio";
import { Meter } from "./audio";
import { FILTERED_LIST, INFO, LIST } from "./pactl.fixture";
import { reading } from "./reading";

const read = (list: string = LIST): Audio =>
  reading(INFO, list).match({
    Err: (error) => {
      throw new Error(`unreadable: ${error}`);
    },
    Ok: (audio) => audio,
  });

const choice = (
  name: string,
  description: string,
  available: boolean,
): AudioChoice => ({ available, description, name });

describe("reading", () => {
  it("reads outputs from the sinks, at their loudest channel", () => {
    expect(read().outputs).toStrictEqual([
      {
        default: true,
        description: "Built-in Audio Analog Stereo",
        filtered: false,
        id: "output:alsa_output.analog-stereo",
        monitor: false,
        muted: false,
        port: "analog-output-speaker",
        ports: [
          choice("analog-output-speaker", "Speakers", true),
          choice("analog-output-headphones", "Headphones", false),
        ],
        through: [],
        volume: 39_322 / 65_536,
      },
      // An invalid volume reads as silence.
      {
        default: false,
        description: "HDMI",
        filtered: false,
        id: "output:hdmi",
        monitor: false,
        muted: true,
        port: undefined,
        ports: [],
        through: [],
        volume: 0,
      },
    ]);
  });

  it("reads inputs from the sources, with the monitors marked", () => {
    expect(
      read().inputs.map(({ id, monitor, volume, ...input }) => [
        id,
        monitor,
        input.default,
        volume,
      ]),
    ).toStrictEqual([
      ["input:alsa_output.analog-stereo.monitor", true, false, 1],
      ["input:alsa_input.analog-stereo", false, true, 0.25],
    ]);
  });

  it("names each stream's application and device, and hides other mixers' meters", () => {
    const audio = read();

    expect(audio.playback).toStrictEqual([
      {
        application: "Firefox",
        device: "output:alsa_output.analog-stereo",
        id: "playback:42",
        muted: false,
        title: "A song",
        volume: 1,
      },
      // Without an application name, the media name stands in.
      {
        application: "bell",
        device: "output:alsa_output.analog-stereo",
        id: "playback:43",
        muted: false,
        title: undefined,
        volume: 1,
      },
      // On a sink missing from the list.
      {
        application: "late",
        device: undefined,
        id: "playback:44",
        muted: false,
        title: undefined,
        volume: 1,
      },
    ]);
    expect(audio.recording).toStrictEqual([
      {
        application: "Recorder",
        device: "input:alsa_input.analog-stereo",
        id: "recording:7",
        muted: true,
        title: undefined,
        volume: 0.25,
      },
    ]);
  });

  it("lists each card's profiles best first", () => {
    expect(read().cards).toStrictEqual([
      {
        description: "Built-in Audio",
        id: "alsa_card.pci",
        profile: "output:analog-stereo",
        profiles: [
          choice("output:analog-stereo", "Analog Stereo Output", true),
          choice("output:hdmi-stereo", "Digital Stereo (HDMI) Output", false),
          choice("off", "Off", true),
        ],
      },
      // Without a description, the name stands in.
      {
        description: "bluez_card.00_11",
        id: "bluez_card.00_11",
        profile: undefined,
        profiles: [],
      },
    ]);
  });

  it("meters an output off its monitor, an input off itself and a stream off itself", () => {
    expect(read().meters).toStrictEqual(
      new Map<string, Meter>([
        [
          "output:alsa_output.analog-stereo",
          Meter.Source("alsa_output.analog-stereo.monitor"),
        ],
        [
          "input:alsa_output.analog-stereo.monitor",
          Meter.Source("alsa_output.analog-stereo.monitor"),
        ],
        [
          "input:alsa_input.analog-stereo",
          Meter.Source("alsa_input.analog-stereo"),
        ],
        ["playback:42", Meter.Stream(42)],
        ["playback:43", Meter.Stream(43)],
        ["playback:44", Meter.Stream(44)],
        ["playback:45", Meter.Stream(45)],
      ]),
    );
  });

  it("hides a filter's own stream", () => {
    expect(read(FILTERED_LIST).playback.map(({ id }) => id)).toStrictEqual([
      "playback:42",
      "playback:43",
      "playback:44",
    ]);
  });

  it("reads a filter as muted when the hardware behind it is", () => {
    const [filter, hardware] = read(FILTERED_LIST).outputs;

    expect(filter?.muted).toBe(true);
    expect(filter?.through).toStrictEqual([
      { id: "playback:77", muted: false },
      { id: "output:alsa_output.analog-stereo", muted: true },
    ]);
    expect(filter?.filtered).toBe(false);
    expect(hardware?.through).toStrictEqual([]);
    expect(hardware?.filtered).toBe(true);
  });

  it("reads an input filter's chain back to the microphone", () => {
    // Echo cancellation: a filter source to record from, and its stream
    // recording the microphone.
    const list = LIST.replace(
      `"sources": [`,
      `"sources": [
    {"index": 80, "name": "echo-cancel-source", "description": "Echo-Cancel Source",
     "mute": false, "volume": {"mono": {"value": 65536}}, "monitor_source": null,
     "properties": {"node.link-group": "echo-cancel-4"}, "ports": [], "active_port": null},`,
    ).replace(
      `"source_outputs": [`,
      `"source_outputs": [
    {"index": 81, "source": 53, "mute": false, "volume": {"mono": {"value": 65536}},
     "properties": {"node.link-group": "echo-cancel-4"}},`,
    );

    const inputs = read(list).inputs;

    expect(inputs[0]?.muted).toBe(true);
    expect(inputs[0]?.through).toStrictEqual([
      { id: "recording:81", muted: false },
      { id: "input:alsa_input.analog-stereo", muted: true },
    ]);
    // The monitor shares a filter's group in PipeWire, but records its sink.
    const monitored = read(
      list.replace(
        `"monitor_source": "alsa_output.analog-stereo",
     "properties": {}`,
        `"monitor_source": "alsa_output.analog-stereo",
     "properties": {"node.link-group": "echo-cancel-4"}`,
      ),
    ).inputs[1];
    expect(monitored?.through).toStrictEqual([]);
    expect(inputs.map(({ filtered }) => filtered)).toStrictEqual([
      false,
      false,
      true,
    ]);
  });

  it("hides its own meters' recordings", () => {
    const list = LIST.replace(
      `"source_outputs": [`,
      `"source_outputs": [
    {"index": 9, "source": 52, "mute": false, "volume": {"mono": {"value": 65536}},
     "properties": {"application.id": "org.domicile.meter"}},`,
    );

    expect(read(list).recording.map(({ id }) => id)).toStrictEqual([
      "recording:7",
    ]);
  });

  it("reads an input that names no sink as no monitor", () => {
    for (const none of [`""`, `"n/a"`]) {
      const list = LIST.replace(
        `"monitor_source": null,`,
        `"monitor_source": ${none},`,
      );

      expect(read(list).inputs[1]?.monitor).toBe(false);
    }
  });

  it("takes the device class's word for what is a monitor", () => {
    const list = LIST.replace(
      `"monitor_source": "alsa_output.analog-stereo",
     "properties": {}`,
      `"monitor_source": "",
     "properties": {"device.class": "monitor"}`,
    );

    expect(read(list).inputs[0]?.monitor).toBe(true);
  });

  it("fails on what is not pactl's JSON", () => {
    expect(reading(INFO, "Connection failure").isErr()).toBe(true);
    expect(reading(INFO, `{"sinks": [{"index": "one"}]}`).isErr()).toBe(true);
  });
});
