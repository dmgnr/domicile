import { afterEach, describe, expect, it, jest } from "bun:test";
import { FakeDomicileHost } from "@domicile-desktop/sdk/fake-host";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";

import { Progress } from "./progress";
import { Splash } from "./Splash";

const display = (name: string, x: number, width: number, height: number) => ({
  adaptiveSync: "unsupported",
  hdr: "unsupported",
  height,
  modeHeight: height,
  modeWidth: width,
  name,
  peakLuminance: 0,
  refreshMhz: 60_000,
  scale: 1,
  sdrWhite: 0,
  transform: "normal",
  width,
  x,
  y: 0,
});

const DISPLAYS = [
  display("eDP-1", 0, 1920, 1080),
  display("DP-1", 1920, 2560, 1440),
];

/**
 * Renders the splash over a fake desktop and returns a way to report progress
 * and the files the page said it ended in.
 */
const splash = (displays: typeof DISPLAYS | null = DISPLAYS) => {
  const fake = new FakeDomicileHost();
  fake.set({ displays });
  const listeners: ((progress: Progress) => void)[] = [];
  const ended: string[] = [];
  render(
    <Splash
      domicile={fake.domicile}
      end={(_, path) => {
        ended.push(path);
        return Promise.resolve();
      }}
      follow={(onProgress) => {
        listeners.push(onProgress);
        return () => undefined;
      }}
    />,
  );
  return {
    ended,
    fake,
    report: (progress: Progress) => {
      act(() => {
        for (const listener of listeners) {
          listener(progress);
        }
      });
    },
  };
};

afterEach(cleanup);

describe(Splash, () => {
  it("covers every display", () => {
    splash();
    expect(screen.getAllByRole("heading", { name: "domicile" })).toHaveLength(
      2,
    );
  });

  it("says which step the build is on", () => {
    const { report } = splash();
    report(Progress.Installing(["react", "zod"]));
    expect(screen.getAllByRole("status")[0]).toHaveTextContent(
      "Installing react, zod",
    );
  });

  it("shows why a build failed and logs out on a key", () => {
    const { fake, report } = splash();
    report(Progress.Failed(42, "src/shell.ts: no Shell export"));
    expect(
      screen.getAllByText("src/shell.ts: no Shell export")[0],
    ).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Enter" });
    expect(fake.calls).toContainEqual(["spawn", ["kill", "-TERM", "42"]]);
  });

  describe("giving way to the shell", () => {
    afterEach(() => {
      jest.useRealTimers();
    });

    it("ends once the mark has drawn and Ready has shown", () => {
      jest.useFakeTimers();
      const { ended, report } = splash();
      act(() => {
        jest.advanceTimersByTime(1000);
      });
      report(Progress.Built("/run/splash/ended"));
      act(() => {
        jest.advanceTimersByTime(899);
      });
      expect(ended).toEqual([]);
      act(() => {
        jest.advanceTimersByTime(1);
      });
      expect(ended).toEqual(["/run/splash/ended"]);
    });

    it("shows a shell built before it drew for the whole mark", () => {
      jest.useFakeTimers();
      const { ended, fake, report } = splash(null);
      report(Progress.Built("/run/splash/ended"));
      act(() => {
        jest.advanceTimersByTime(5000);
      });
      expect(ended).toEqual([]);
      act(() => {
        fake.set({ displays: DISPLAYS });
      });
      act(() => {
        jest.advanceTimersByTime(1599);
      });
      expect(ended).toEqual([]);
      act(() => {
        jest.advanceTimersByTime(1);
      });
      expect(ended).toEqual(["/run/splash/ended"]);
    });
  });

  it("logs out on nothing while the build runs", () => {
    const { fake, report } = splash();
    report(Progress.Bundling());
    fireEvent.keyDown(window, { key: "Enter" });
    expect(fake.calls.filter(([call]) => call === "spawn")).toEqual([]);
  });
});
