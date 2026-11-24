import { describe, expect, it } from "bun:test";
import { Drilldown } from "@domicile-desktop/component-library/Drilldown";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { css } from "../styled-system/css";
import { device, heldSound, laptop, stream } from "./fixture";
import { Mixer } from "./Mixer";

const mixer = (
  sound: ReturnType<typeof heldSound>,
  audio: typeof laptop = laptop,
) => {
  const view = (current: typeof laptop) => (
    <Drilldown>
      <Mixer audio={current} server={sound.server} />
    </Drilldown>
  );
  const { rerender } = render(view(audio));
  return {
    report: (next: typeof laptop) => {
      rerender(view(next));
    },
  };
};

/** Pick `name` from the `Select` called `label`. */
const choose = async (label: string, name: string) => {
  await userEvent.click(screen.getByRole("combobox", { name: label }));
  await userEvent.click(screen.getByRole("option", { name }));
};

/** The names of the options in the `Select` called `label`. */
const options = async (label: string) => {
  await userEvent.click(screen.getByRole("combobox", { name: label }));
  return screen.getAllByRole("option").map((option) => option.textContent);
};

/** Two microphones: the laptop's and a headset's. */
const withHeadset = {
  ...laptop,
  inputs: [
    ...laptop.inputs,
    device({ description: "Headset", id: "input:headset" }),
  ],
};

describe("Mixer", () => {
  describe("at a glance", () => {
    it("says what to do with nothing to play or record on", () => {
      mixer(heldSound(), {
        ...laptop,
        cards: [],
        inputs: [],
        outputs: [],
        playback: [],
        recording: [],
      });

      expect(screen.getByRole("status")).toHaveTextContent(
        "No speakers or microphonesPlug some in and they'll show up here.",
      );
    });

    it("leaves the sound cards to turn on when they are off", () => {
      mixer(heldSound(), { ...laptop, inputs: [], outputs: [] });

      expect(screen.getByRole("status")).toHaveTextContent(
        /^No speakers or microphones$/,
      );
      expect(
        screen.getByRole("button", { name: "Sound card modes" }),
      ).toBeInTheDocument();
    });

    it("has the volume and the microphone, metering only the microphone", () => {
      const sound = heldSound();
      mixer(sound);

      sound.levels(new Map([["input:mic", 0.001]]));

      expect(screen.getByRole("slider", { name: "Volume" })).toHaveAttribute(
        "aria-valuenow",
        "50",
      );
      expect(
        screen.queryByRole("meter", { name: "Volume level" }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("meter", { name: "Microphone level" }),
      ).toHaveAttribute("aria-valuenow", "0");
      expect(sound.metered.at(-1)).toEqual(["input:mic"]);
    });

    it("grays a muted microphone's row and marks its meter", () => {
      const sound = heldSound();
      mixer(sound, {
        ...laptop,
        inputs: laptop.inputs.map((input) => ({ ...input, muted: true })),
      });

      sound.levels(new Map([["input:mic", 1]]));

      expect(
        screen.getByRole("meter", { name: "Microphone level" }),
      ).toHaveAttribute("data-muted");
      expect(
        screen
          .getByRole("button", { name: "Mute Volume" })
          .closest("[data-muted]"),
      ).toBeNull();
      expect(
        screen
          .getByRole("button", { name: "Unmute Microphone" })
          .closest("[data-muted]")?.className,
      ).toContain(css({ color: "muted" }));
    });

    it("has the first microphone when the server's default input is a monitor", () => {
      const sound = heldSound();
      mixer(sound, {
        ...laptop,
        inputs: laptop.inputs.map((input) => ({
          ...input,
          default: input.monitor,
        })),
      });

      expect(
        screen.getByRole("slider", { name: "Microphone" }),
      ).toHaveAttribute("aria-valuenow", "30");
    });
  });

  describe("where sound goes", () => {
    it("picks from each plugged-in port and device, showing the one in use", async () => {
      mixer(heldSound());

      expect(
        screen.getByRole("combobox", { name: "Play sound on" }),
      ).toHaveTextContent("Speakers");
      expect(await options("Play sound on")).toStrictEqual([
        "Speakers",
        "HDMI",
      ]);
    });

    it("makes another device the default", async () => {
      const sound = heldSound();
      mixer(sound);

      await choose("Play sound on", "HDMI");

      expect(sound.asked).toEqual([["setDefault", "output:hdmi"]]);
    });

    it("switches the device's port", async () => {
      const sound = heldSound();
      mixer(sound, {
        ...laptop,
        outputs: laptop.outputs.map((output) => ({
          ...output,
          ports: output.ports.map((port) => ({ ...port, available: true })),
        })),
      });

      await choose("Play sound on", "Headphones");

      expect(sound.asked).toEqual([
        ["setPort", "output:speakers", "analog-output-headphones"],
      ]);
    });

    it("picks the microphone to record from", async () => {
      const sound = heldSound();
      mixer(sound, withHeadset);

      await choose("Record from", "Headset");

      expect(sound.asked).toEqual([["setDefault", "input:headset"]]);
    });

    it("offers no choice with only one way", () => {
      mixer(heldSound(), {
        ...laptop,
        outputs: [device({ default: true })],
      });

      expect(
        screen.queryByRole("combobox", { name: "Play sound on" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("combobox", { name: "Record from" }),
      ).not.toBeInTheDocument();
    });
  });

  describe("apps", () => {
    it("lists each app with its volume, saying which use the microphone", () => {
      mixer(heldSound());

      const apps = screen.getByRole("region", { name: "Apps" });
      expect(
        within(apps).getByRole("button", { name: /^Firefox/ }),
      ).toHaveTextContent(/^Firefox$/);
      expect(
        within(apps).getByRole("button", { name: /^Recorder/ }),
      ).toHaveTextContent("RecorderUsing the microphone");
      expect(
        within(apps).getByRole("slider", { name: "Firefox" }),
      ).toHaveAttribute("aria-valuenow", "100");
      expect(
        within(apps).getByRole("slider", { name: "Recorder" }),
      ).toBeInTheDocument();
    });

    it("turns down and mutes all of an app's sound together", async () => {
      const sound = heldSound();
      mixer(sound, {
        ...laptop,
        playback: [
          ...laptop.playback,
          stream({ id: "playback:43", title: "A video" }),
        ],
      });

      await userEvent.click(
        screen.getByRole("button", { name: "Mute Firefox" }),
      );

      expect(sound.asked).toEqual([
        ["setMuted", "playback:42", true],
        ["setMuted", "playback:43", true],
      ]);
    });

    it("moves an app to another output from its page", async () => {
      const sound = heldSound();
      mixer(sound);

      await userEvent.click(screen.getByRole("button", { name: /^Firefox/ }));
      expect(screen.getByRole("heading", { name: "Firefox" })).toBeVisible();
      await choose("Plays on", "HDMI");

      expect(sound.asked).toEqual([
        ["moveStream", "playback:42", "output:hdmi"],
      ]);
    });

    it("leaves the hardware behind a filter out of an app's outputs", async () => {
      mixer(heldSound(), {
        ...laptop,
        outputs: laptop.outputs.map((output) =>
          output.id === "output:hdmi" ? { ...output, filtered: true } : output,
        ),
      });

      await userEvent.click(screen.getByRole("button", { name: /^Firefox/ }));

      expect(await options("Plays on")).toStrictEqual(["Speakers"]);
    });

    it("can record from what an output plays", async () => {
      const sound = heldSound();
      mixer(sound);

      await userEvent.click(screen.getByRole("button", { name: /^Recorder/ }));
      await choose("Records from", "Monitor of Speakers");

      expect(sound.asked).toEqual([
        ["moveStream", "recording:7", "input:speakers.monitor"],
      ]);
    });

    it("leaves an app's page once the app stops", async () => {
      const sound = heldSound();
      const view = mixer(sound);
      await userEvent.click(screen.getByRole("button", { name: /^Firefox/ }));

      view.report({ ...laptop, playback: [] });

      expect(
        screen.queryByRole("heading", { name: "Firefox" }),
      ).not.toBeInTheDocument();
    });

    it("has no apps when nothing plays or records", () => {
      mixer(heldSound(), { ...laptop, playback: [], recording: [] });

      expect(
        screen.queryByRole("region", { name: "Apps" }),
      ).not.toBeInTheDocument();
    });
  });

  describe("cards", () => {
    it("switches a card's mode from its page", async () => {
      const sound = heldSound();
      mixer(sound);
      await userEvent.click(
        screen.getByRole("button", { name: "Sound card modes" }),
      );

      expect(await options("Built-in Audio")).toStrictEqual([
        "Stereo sound only",
        "Off",
      ]);
      await userEvent.click(screen.getByRole("option", { name: "Off" }));

      expect(sound.asked).toEqual([["setProfile", "alsa_card.pci", "off"]]);
    });
  });
});
