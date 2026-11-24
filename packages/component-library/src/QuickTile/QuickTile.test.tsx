import { describe, expect, it } from "bun:test";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { QuickTile } from "./QuickTile";

describe(QuickTile, () => {
  it("opens its details from the whole tile", async () => {
    const opened = Promise.withResolvers<true>();
    render(
      <QuickTile
        detail="Centar"
        icon={<span />}
        label="Wi-Fi"
        lit
        onMore={() => {
          opened.resolve(true);
        }}
      />,
    );
    expect(screen.getByText("Centar")).toBeVisible();

    await userEvent.click(
      screen.getByRole("button", { name: "Wi-Fi details" }),
    );

    expect(await opened.promise).toBe(true);
  });

  it("switches nothing", () => {
    render(
      <QuickTile
        icon={<span />}
        label="Wi-Fi"
        lit={false}
        onMore={() => undefined}
      />,
    );

    expect(screen.getByRole("button")).not.toHaveAttribute("aria-pressed");
  });

  it("lights its icon only while lit", () => {
    const { rerender } = render(
      <QuickTile icon={<span />} label="Wi-Fi" lit onMore={() => undefined} />,
    );
    expect(screen.getByRole("button")).toHaveAttribute("data-lit");

    rerender(
      <QuickTile
        icon={<span />}
        label="Wi-Fi"
        lit={false}
        onMore={() => undefined}
      />,
    );

    expect(screen.getByRole("button")).not.toHaveAttribute("data-lit");
  });

  it("only shows its state without details", () => {
    render(
      <QuickTile detail="On" icon={<span />} label="Bluetooth" lit={false} />,
    );

    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Bluetooth")).toBeVisible();
    expect(screen.getByText("On")).toBeVisible();
  });
});
