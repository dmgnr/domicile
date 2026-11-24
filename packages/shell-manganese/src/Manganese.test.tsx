import { describe, expect, it } from "bun:test";
import { applicationsConfigSchema } from "@domicile-desktop/manganese-launcher/applications-config";
import { floatingRulesSchema } from "@domicile-desktop/manganese-window-management/floating/floating-rules";

import { exec } from "@domicile-desktop/manganese-window-management/keyboard/commands";
import { FakeDomicile } from "@domicile-desktop/react/fake-domicile";
import { FakeDomicileHost } from "@domicile-desktop/sdk/fake-host";
import { act, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";

import { Manganese } from "./Manganese";

/** A fake desktop describing one screen. */
const onADesk = (): FakeDomicileHost => {
  const fake = new FakeDomicileHost();
  fake.set({
    displays: [
      {
        adaptiveSync: "unsupported",
        hdr: "unsupported",
        height: 1080,
        modeHeight: 1080,
        modeWidth: 1920,
        name: "left",
        peakLuminance: 0,
        refreshMhz: 60_000,
        scale: 1,
        sdrWhite: 0,
        transform: "normal",
        width: 1920,
        x: 0,
        y: 0,
      },
    ],
  });
  return fake;
};

const applications = applicationsConfigSchema.parse(undefined);
const floating = floatingRulesSchema.parse(undefined);

/** Manganese on `fake`, in strict mode as `mount` draws it. */
const renderManganese = async (
  fake: FakeDomicileHost,
  options: Partial<ComponentProps<typeof Manganese>> = {},
) =>
  await act(async () =>
    render(
      <FakeDomicile fake={fake}>
        <Manganese
          applications={applications}
          floating={floating}
          {...options}
        />
      </FakeDomicile>,
      { reactStrictMode: true },
    ),
  );

describe("Manganese", () => {
  it("draws the bar it is given", async () => {
    await renderManganese(onADesk(), {
      bar: { center: [], left: [<span key="mail">mail 3/12</span>], right: [] },
    });

    expect(await screen.findByText("mail 3/12")).toBeInTheDocument();
  });

  // Custom keybindings replace the defaults.
  it("binds the keys it is given rather than its own", async () => {
    const fake = onADesk();
    await renderManganese(fake, {
      keybindings: { keybindings: { "Meta+x": exec("kitty") }, modes: {} },
    });

    expect(
      new Set(
        fake.calls.flatMap(([method, chord]) =>
          method === "grabShortcut" ? [chord] : [],
        ),
      ),
    ).toEqual(new Set(["Meta+x"]));
  });

  // The config's look, which the settings portal also serves windows.
  it("follows the config's contrast and motion", async () => {
    const fake = onADesk();
    await renderManganese(fake);

    act(() => {
      fake.set({ highContrast: true, reducedMotion: true });
    });

    const html = document.documentElement;
    expect(html.getAttribute("data-contrast")).toBe("high");
    expect(html.hasAttribute("data-reduced-motion")).toBe(true);
    html.removeAttribute("data-contrast");
    html.removeAttribute("data-reduced-motion");
  });
});
