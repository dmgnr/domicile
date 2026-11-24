import { describe, expect, it } from "bun:test";
import { clockOf, playheadAt } from "./playhead";

describe("playheadAt", () => {
  const heard = {
    at: 1000,
    duration: 270,
    playing: true,
    position: 102,
    rate: 1,
  };

  it("moves on from where the page said, at its rate, while it plays", () => {
    expect(playheadAt(heard, 3500)).toBe(104.5);
    expect(playheadAt({ ...heard, rate: 2 }, 3500)).toBe(107);
  });

  it("stays put while paused", () => {
    expect(playheadAt({ ...heard, playing: false }, 3500)).toBe(102);
  });

  it("stops at the end", () => {
    expect(playheadAt(heard, 1_000_000)).toBe(270);
  });
});

describe("clockOf", () => {
  it("reads minutes and seconds", () => {
    expect(clockOf(102)).toBe("1:42");
    expect(clockOf(270)).toBe("4:30");
    expect(clockOf(5.9)).toBe("0:05");
  });

  it("reads hours for a long video", () => {
    expect(clockOf(3723)).toBe("1:02:03");
  });
});
