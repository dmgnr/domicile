import { describe, expect, it, jest } from "bun:test";
import { act, render, screen } from "@testing-library/react";

import { LockClock } from "./LockClock";

describe("LockClock", () => {
  it("reads the hour and minute large, and the day under them", () => {
    // No seconds: a figure that size changing every second is a screen that
    // never sits still while nobody is at it.
    render(<LockClock locked now={() => new Date(2026, 8, 16, 8, 3, 40)} />);

    expect(screen.getByText("08:03")).toBeVisible();
    expect(screen.getByText("Wednesday, September 16")).toBeVisible();
  });

  it("stops while unlocked, and reads the time afresh on locking", () => {
    jest.useFakeTimers();
    let time = new Date(2026, 8, 16, 8, 3, 40);
    let reads = 0;
    const now = () => {
      reads += 1;
      return time;
    };
    const { rerender } = render(<LockClock locked now={now} />);
    rerender(<LockClock locked={false} now={now} />);
    const readsWhenUnlocked = reads;

    time = new Date(2026, 8, 16, 9, 30, 0);
    act(() => {
      jest.advanceTimersByTime(3_600_000);
    });
    expect(reads).toBe(readsWhenUnlocked);

    rerender(<LockClock locked now={now} />);
    expect(screen.getByText("09:30")).toBeVisible();

    time = new Date(2026, 8, 16, 9, 31, 0);
    act(() => {
      jest.advanceTimersByTime(60_000);
    });
    expect(screen.getByText("09:31")).toBeVisible();
    jest.useRealTimers();
  });
});
