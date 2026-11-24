import { describe, expect, it } from "bun:test";
import { Err, Ok } from "@cprussin/option-result";

import { Asked } from "./asked";
import type { Audio, Meter as MeterType } from "./audio";
import { Meter } from "./audio";
import { AudioError } from "./audio-error";
import { FILTERED_LIST, INFO, LIST } from "./pactl.fixture";
import type { Timing } from "./sound-server";
import { soundServer } from "./sound-server";
import type { Answer } from "./system.fixture";
import { FakeSystem } from "./system.fixture";

const TIMING: Timing = { reopenMs: 20, settleMs: 5, tickMs: 10 };

const C = { env: { LC_ALL: "C" } };

/** A sound server that answers `pactl info` and `list` from the recording. */
const server = (answer: (argv: readonly string[]) => Answer = pactl) => {
  const system = new FakeSystem(answer);
  const reported: unknown[] = [];
  const sound = soundServer({ processes: system }, TIMING, (...said) => {
    reported.push(said);
  });
  return { reported, sound, system };
};

const pactl = (argv: readonly string[]): Answer => {
  switch (argv.at(-1)) {
    case "info":
      return { stdout: INFO };
    case "list":
      return { stdout: LIST };
    default:
      return { stdout: "" };
  }
};

/** Waits until `holds` is true, for work that settles on timers. */
const until = async (holds: () => boolean): Promise<void> => {
  while (!holds()) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
};

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const reads = (system: FakeSystem) =>
  system.ran.filter(([argv]) => argv.at(-1) === "list").length;

describe("watch", () => {
  it("subscribes, then reports the server", async () => {
    const { sound, system } = server();
    const heard: Audio[] = [];

    const stop = sound.watch((audio) => {
      heard.push(audio);
    });
    await until(() => heard.length === 1);
    stop();

    expect(system.spawned[0]?.argv).toStrictEqual([
      "pactl",
      "-f",
      "json",
      "subscribe",
    ]);
    expect(system.spawned[0]?.options).toStrictEqual(C);
    expect(system.ran).toStrictEqual([
      [["pactl", "-f", "json", "info"], C],
      [["pactl", "-f", "json", "list"], C],
    ]);
    expect(heard[0]?.outputs.map(({ id }) => id)).toStrictEqual([
      "output:alsa_output.analog-stereo",
      "output:hdmi",
    ]);
  });

  it("reads again once a burst of changes settles, and not for clients", async () => {
    const { sound, system } = server();
    const heard: Audio[] = [];
    const stop = sound.watch((audio) => {
      heard.push(audio);
    });
    await until(() => heard.length === 1);
    const subscription = system.spawned[0];

    subscription?.print(`{"index":1,"event":"change","on":"sink"}\n`);
    subscription?.print(`{"index":1,"event":"change","on":"sink`);
    subscription?.print(`"}\n{"index":2,"event":"new","on":"sink-input"}\n`);
    await until(() => heard.length === 2);
    subscription?.print(`{"index":3,"event":"new","on":"client"}\n`);
    await pause(TIMING.settleMs * 4);
    stop();

    expect(reads(system)).toBe(2);
  });

  it("stops: ends the subscription and reports nothing more", async () => {
    const { sound, system } = server();
    const heard: Audio[] = [];
    const stop = sound.watch((audio) => {
      heard.push(audio);
    });
    await until(() => heard.length === 1);

    stop();
    system.spawned[0]?.print(`{"index":1,"event":"change","on":"sink"}\n`);
    await pause(TIMING.reopenMs * 2);

    expect(system.spawned[0]?.killed).toStrictEqual([undefined]);
    expect(system.spawned).toHaveLength(1);
    expect(heard).toHaveLength(1);
  });

  it("subscribes again when the subscription ends", async () => {
    const { sound, system } = server();
    const heard: Audio[] = [];
    const stop = sound.watch((audio) => {
      heard.push(audio);
    });
    await until(() => heard.length === 1);

    system.spawned[0]?.exit(0);
    await until(() => heard.length === 2);
    stop();

    expect(system.spawned).toHaveLength(2);
  });

  it("says when the server cannot be read again, and keeps watching", async () => {
    const answers = { refuse: false };
    const { reported, sound, system } = server((argv) =>
      answers.refuse ? { code: 1, stderr: "Gone", stdout: "" } : pactl(argv),
    );
    const heard: Audio[] = [];
    const stop = sound.watch((audio) => {
      heard.push(audio);
    });
    await until(() => heard.length === 1);

    answers.refuse = true;
    system.spawned[0]?.print(`{"index":1,"event":"change","on":"sink"}\n`);
    await until(() => reported.length === 1);
    answers.refuse = false;
    system.spawned[0]?.print(`{"index":1,"event":"change","on":"sink"}\n`);
    await until(() => heard.length === 2);
    stop();

    expect(reported).toStrictEqual([
      ["the sound server could not be read", AudioError.Refused("Gone")],
    ]);
  });

  it("reports nothing without a sound server, says so once, and keeps trying", async () => {
    const { reported, sound, system } = server(() => ({
      code: 1,
      stderr: "Connection failure: Connection refused",
      stdout: "",
    }));
    const heard: Audio[] = [];
    const stop = sound.watch((audio) => {
      heard.push(audio);
    });

    await system.spawnedAtLeast(1);
    system.spawned[0]?.exit(1);
    await system.spawnedAtLeast(2);
    system.spawned[1]?.exit(1);
    await system.spawnedAtLeast(3);
    stop();

    expect(heard).toStrictEqual([]);
    expect(reported).toStrictEqual([
      [
        "no sound server to read; the mixer is empty until there is",
        AudioError.Refused("Connection failure: Connection refused"),
      ],
    ]);
  });
});

describe("requests", () => {
  it("runs pactl in the C locale", async () => {
    const { sound, system } = server();

    expect(await sound.setVolume("output:speakers", 0.5)).toStrictEqual(
      Ok(Asked.Done),
    );
    expect(await sound.setMuted("input:mic", true)).toStrictEqual(
      Ok(Asked.Done),
    );
    expect(await sound.setDefault("input:mic")).toStrictEqual(Ok(Asked.Done));
    expect(await sound.moveStream("playback:4", "output:hdmi")).toStrictEqual(
      Ok(Asked.Done),
    );
    expect(await sound.setPort("output:hdmi", "hdmi-1")).toStrictEqual(
      Ok(Asked.Done),
    );
    expect(await sound.setProfile("alsa_card.pci", "off")).toStrictEqual(
      Ok(Asked.Done),
    );
    expect(system.ran).toStrictEqual([
      [["pactl", "--", "set-sink-volume", "speakers", "32768"], C],
      [["pactl", "--", "set-source-mute", "mic", "1"], C],
      [["pactl", "--", "set-default-source", "mic"], C],
      [["pactl", "--", "move-sink-input", "4", "hdmi"], C],
      [["pactl", "--", "set-sink-port", "hdmi", "hdmi-1"], C],
      [["pactl", "--", "set-card-profile", "alsa_card.pci", "off"], C],
    ]);
  });

  it("says what the server refused", async () => {
    const { sound } = server(() => ({
      code: 1,
      stderr: "Failure: No such entity\n",
      stdout: "",
    }));

    expect(await sound.setMuted("output:gone", true)).toStrictEqual(
      Err(AudioError.Refused("Failure: No such entity")),
    );
  });

  it("asks nothing for an id it never gave out", async () => {
    const { sound, system } = server();

    expect(await sound.setMuted("speakers", true)).toStrictEqual(
      Err(AudioError.UnknownId("speakers")),
    );
    expect(system.ran).toStrictEqual([]);
  });

  it("unmutes a filter and the muted hardware behind it", async () => {
    const { sound, system } = server((argv) =>
      argv.at(-1) === "list" ? { stdout: FILTERED_LIST } : pactl(argv),
    );

    expect(
      await sound.setMuted("output:audio_effect.laptop-convolver", false),
    ).toStrictEqual(Ok(Asked.Done));
    expect(system.ran.map(([argv]) => argv)).toStrictEqual([
      ["pactl", "--", "set-sink-mute", "audio_effect.laptop-convolver", "0"],
      ["pactl", "-f", "json", "info"],
      ["pactl", "-f", "json", "list"],
      ["pactl", "--", "set-sink-mute", "alsa_output.analog-stereo", "0"],
    ]);
  });

  it("keeps a mute asked while an unmute reads the server last", async () => {
    const { sound, system } = server();

    await Promise.all([
      sound.setMuted("output:alsa_output.analog-stereo", false),
      sound.setMuted("output:alsa_output.analog-stereo", true),
    ]);

    expect(
      system.ran
        .map(([argv]) => argv.at(-1))
        .filter((last) => /^[01]$/.test(last ?? "")),
    ).toStrictEqual(["0", "1"]);
  });

  it("mutes only the filter", async () => {
    const { sound, system } = server();

    await sound.setMuted("output:audio_effect.laptop-convolver", true);

    expect(system.ran.map(([argv]) => argv)).toStrictEqual([
      ["pactl", "--", "set-sink-mute", "audio_effect.laptop-convolver", "1"],
    ]);
  });

  it("unmutes no device the server does not list", async () => {
    const { sound, system } = server();

    expect(await sound.setMuted("output:gone", false)).toStrictEqual(
      Err(AudioError.UnknownId("output:gone")),
    );
    expect(system.ran.map(([argv]) => argv.at(-1))).toStrictEqual([
      "0",
      "info",
      "list",
    ]);
  });

  it("skips volumes a later volume overtook while it waited", async () => {
    const { sound, system } = server();

    const asked = await Promise.all([
      sound.setVolume("output:a", 0.1),
      sound.setVolume("output:a", 0.2),
      sound.setVolume("output:a", 0.3),
    ]);

    expect(asked).toStrictEqual([
      Ok(Asked.Done),
      Ok(Asked.Overtaken),
      Ok(Asked.Done),
    ]);
    expect(system.ran.map(([argv]) => argv.at(-1))).toStrictEqual([
      "6554",
      "19661",
    ]);
  });
});

describe("meters", () => {
  const floats = (...samples: number[]): Uint8Array =>
    new Uint8Array(new Float32Array(samples).buffer);

  const metering = () => {
    const { reported, sound, system } = server();
    const heard: ReadonlyMap<string, number>[] = [];
    const meters = sound.meters((levels) => {
      heard.push(levels);
    });
    return { heard, meters, reported, system };
  };

  const wanted = (entries: [string, MeterType][]) => new Map(entries);

  it("records each with parec, as mono floats named as this library's", async () => {
    const { meters, system } = metering();

    meters.meter(
      wanted([
        ["input:mic", Meter.Source("mic")],
        ["playback:42", Meter.Stream(42)],
      ]),
    );
    await system.spawnedAtLeast(2);
    meters.stop();

    const common = [
      "--raw",
      "--format=float32le",
      "--channels=1",
      "--rate=1000",
      "--latency-msec=30",
      "--property=application.id=org.domicile.meter",
    ];
    expect(system.spawned.map(({ argv, options }) => [argv, options])).toEqual([
      [["parec", "--device=mic", ...common], C],
      [["parec", "--monitor-stream=42", ...common], C],
    ]);
  });

  it("reports each meter's peak since the last report, once it has heard any", async () => {
    const { heard, meters, system } = metering();
    meters.meter(
      wanted([
        ["input:mic", Meter.Source("mic")],
        ["output:a", Meter.Source("a.monitor")],
      ]),
    );
    await system.spawnedAtLeast(2);

    system.spawned[0]?.print(floats(0.25, -0.5));
    await until(() => heard.length > 0);
    await until(() => heard.at(-1)?.get("input:mic") === 0);
    meters.stop();

    expect(heard[0]).toStrictEqual(new Map([["input:mic", 0.5]]));
  });

  it("stops what is no longer wanted, starts what is, and leaves the rest", async () => {
    const { meters, system } = metering();
    meters.meter(
      wanted([
        ["input:mic", Meter.Source("mic")],
        ["playback:4", Meter.Stream(4)],
      ]),
    );
    await system.spawnedAtLeast(2);

    meters.meter(
      wanted([
        ["input:mic", Meter.Source("mic")],
        // The stream moved, which restarts its meter.
        ["playback:4", Meter.Stream(5)],
        ["output:a", Meter.Source("a.monitor")],
      ]),
    );
    await system.spawnedAtLeast(4);

    expect(system.spawned.map(({ killed }) => killed.length)).toStrictEqual([
      0, 1, 0, 0,
    ]);
    expect(system.spawned.map(({ argv }) => argv[1])).toStrictEqual([
      "--device=mic",
      "--monitor-stream=4",
      "--monitor-stream=5",
      "--device=a.monitor",
    ]);

    meters.stop();
    expect(system.spawned.map(({ killed }) => killed.length)).toStrictEqual([
      1, 1, 1, 1,
    ]);
  });

  it("says once that parec cannot run", async () => {
    const { meters, reported, system } = metering();
    system.spawnFails = true;

    meters.meter(wanted([["input:mic", Meter.Source("mic")]]));
    meters.meter(wanted([["output:a", Meter.Source("a.monitor")]]));
    await until(() => reported.length > 0);
    await pause(TIMING.tickMs);
    meters.stop();

    expect(reported).toStrictEqual([
      ["the meters cannot record; they read nothing", "no parec"],
    ]);
  });
});
