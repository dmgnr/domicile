import { describe, expect, it } from "bun:test";
import { fireEvent, render } from "@testing-library/react";

import { ExtensionIcon } from "./ExtensionIcon";

const ICON = "data:image/png;base64,iVBORw==";

describe("ExtensionIcon", () => {
  it("draws the extension's own icon", () => {
    const { container } = render(
      <ExtensionIcon icon={ICON} name="1Password" size="sm" />,
    );
    expect(container.querySelector("img")?.getAttribute("src")).toBe(ICON);
  });

  it("draws the initial when the extension has no icon", () => {
    const { container } = render(
      <ExtensionIcon icon={undefined} name="uBlock" size="md" />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("U");
  });

  it("draws the initial when the icon won't load", () => {
    const { container } = render(
      <ExtensionIcon icon={ICON} name="1Password" size="sm" />,
    );
    const image = container.querySelector("img");
    if (image === null) {
      throw new Error("no icon was drawn");
    }
    fireEvent.error(image);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("1");
  });
});
