import { describe, expect, it } from "bun:test";
import { render } from "@testing-library/react";

describe("the engine's elements in JSX", () => {
  it("draws an <app> for a window, by its id", () => {
    const { container } = render(<app app-id="term" />);
    expect(container.querySelector("app")?.getAttribute("app-id")).toBe("term");
  });

  it("draws an <app> for a video in picture-in-picture, by its id", () => {
    const { container } = render(<app picture-in-picture="1" />);
    expect(
      container.querySelector("app")?.getAttribute("picture-in-picture"),
    ).toBe("1");
  });

  it("draws a <webview> showing a browser window", () => {
    const { container } = render(<webview window="1" />);
    expect(container.querySelector("webview")?.getAttribute("window")).toBe(
      "1",
    );
  });
});
