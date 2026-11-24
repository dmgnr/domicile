import { describe, expect, it, jest } from "bun:test";
import { act, render, screen } from "@testing-library/react";

import { Clock } from "./Clock";
import { ClockOptionsContext } from "./clock-options";

describe("Clock", () => {
  it("shows the reading of the time it is handed", () => {
    render(<Clock now={() => new Date(2026, 8, 16, 20, 53, 40)} />);

    expect(screen.getByText("Wednesday 2026-09-16 20:53:40")).toBeVisible();
  });

  it("reads its format from ClockOptionsContext", () => {
    render(
      <ClockOptionsContext value={{ format: "12h", seconds: false }}>
        <Clock now={() => new Date(2026, 8, 16, 20, 53, 40)} />
      </ClockOptionsContext>,
    );

    expect(screen.getByText("Wednesday 2026-09-16 08:53 PM")).toBeVisible();
  });

  it("ticks every second", () => {
    jest.useFakeTimers();
    const readings = [
      new Date(2026, 8, 16, 20, 53, 40),
      new Date(2026, 8, 16, 20, 53, 41),
    ];
    render(
      <Clock
        now={() => readings.shift() ?? new Date(2026, 8, 16, 20, 53, 41)}
      />,
    );

    act(() => {
      jest.advanceTimersByTime(1000);
    });

    expect(screen.getByText("Wednesday 2026-09-16 20:53:41")).toBeVisible();
    jest.useRealTimers();
  });

  it("without seconds, changes on the minute and reads the clock seldom", () => {
    jest.useFakeTimers();
    let time = new Date(2026, 8, 16, 20, 53, 40);
    let reads = 0;
    render(
      <ClockOptionsContext value={{ format: "24h", seconds: false }}>
        <Clock
          now={() => {
            reads += 1;
            return time;
          }}
        />
      </ClockOptionsContext>,
    );

    act(() => {
      jest.advanceTimersByTime(15_000);
    });
    expect(screen.getByText("Wednesday 2026-09-16 20:53")).toBeVisible();

    time = new Date(2026, 8, 16, 20, 54, 0);
    act(() => {
      jest.advanceTimersByTime(5000);
    });
    expect(screen.getByText("Wednesday 2026-09-16 20:54")).toBeVisible();
    // Every 5 s at most, not every second.
    expect(reads).toBeLessThanOrEqual(6);
    jest.useRealTimers();
  });

  it("catches up within seconds when the clock jumps, as after a sleep", () => {
    jest.useFakeTimers();
    let time = new Date(2026, 8, 16, 20, 53, 40);
    render(
      <ClockOptionsContext value={{ format: "24h", seconds: false }}>
        <Clock now={() => time} />
      </ClockOptionsContext>,
    );

    time = new Date(2026, 8, 16, 23, 10, 2);
    act(() => {
      jest.advanceTimersByTime(5000);
    });

    expect(screen.getByText("Wednesday 2026-09-16 23:10")).toBeVisible();
    jest.useRealTimers();
  });
});
