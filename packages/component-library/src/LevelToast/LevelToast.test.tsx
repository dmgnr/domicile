import { describe, expect, it } from "bun:test";
import { loadEmittedStylesheet } from "@domicile-desktop/test-support/emitted-stylesheet";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";

import { ChoiceToast, LevelToast } from "./LevelToast";

loadEmittedStylesheet(
  document,
  new URL("../../styled-system/styles.css", import.meta.url),
);

/** Volume at `level`, after `changes` changes. */
const volume = (
  changes: number,
  level: number,
  muted = false,
): ComponentProps<typeof LevelToast> => ({
  changes,
  icon: <svg data-testid="icon" />,
  label: "Volume",
  level,
  muted,
});

describe(LevelToast, () => {
  describe("rendering", () => {
    it("announces its label and level as a status", () => {
      render(<LevelToast {...volume(1, 0.4)} />);

      expect(screen.getByRole("status")).toHaveTextContent("Volume40%");
      expect(screen.getByTestId("icon")).toBeInTheDocument();
      expect(screen.getByRole("meter")).toHaveAttribute("aria-valuenow", "40");
    });

    // A held key changes the level many times a second, so the fill must
    // skip layout.
    it("moves the meter's fill with a transform", () => {
      render(<LevelToast {...volume(1, 0.4)} />);

      const fill = screen.getByRole("meter").firstElementChild as HTMLElement;
      const { transition } = globalThis.getComputedStyle(fill);
      expect(transition).toContain("transform ");
      expect(transition).not.toContain("inline-size");
    });

    it("says muted and grays the meter", () => {
      render(<LevelToast {...volume(1, 0.4, true)} />);

      expect(screen.getByRole("status")).toHaveTextContent("VolumeMuted");
      expect(screen.getByRole("meter")).toHaveAttribute("data-muted");
    });
  });

  // Hidden on its own `animationend`, not a timer, so the duration lives only
  // in the stylesheet.
  describe("changes", () => {
    it("stays up and updates in place on a change", () => {
      const { rerender } = render(<LevelToast {...volume(1, 0.4)} />);
      const shown = screen.getByRole("status");

      rerender(<LevelToast {...volume(2, 0.45)} />);

      expect(screen.getByRole("status")).toBe(shown);
      expect(shown).toHaveTextContent("Volume45%");
    });

    it("starts its fade-out over on each change", () => {
      const { rerender } = render(<LevelToast {...volume(1, 0.4)} />);
      const again = screen.getByRole("status").hasAttribute("data-again");

      rerender(<LevelToast {...volume(2, 0.45)} />);

      expect(screen.getByRole("status").hasAttribute("data-again")).toBe(
        !again,
      );
    });

    it("stays up when only its entrance ends", () => {
      render(<LevelToast {...volume(1, 0.4)} />);

      fireEvent.animationEnd(screen.getByRole("meter"));

      expect(screen.getByRole("status")).toBeInTheDocument();
    });

    it("goes away once it has faded out", () => {
      render(<LevelToast {...volume(1, 0.4)} />);

      fireEvent.animationEnd(screen.getByRole("status"));

      expect(screen.queryByRole("status")).toBeNull();
    });

    it("comes back on the next change", () => {
      const { rerender } = render(<LevelToast {...volume(1, 0.4)} />);
      fireEvent.animationEnd(screen.getByRole("status"));

      rerender(<LevelToast {...volume(2, 0.45)} />);

      expect(screen.getByRole("status")).toHaveTextContent("Volume45%");
    });
  });
});

describe(ChoiceToast, () => {
  it("names the choice with no meter, and fades like the level", () => {
    const { rerender } = render(
      <ChoiceToast
        changes={1}
        choice="us"
        icon={<svg data-testid="icon" />}
        label="Keymap"
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Keymapus");
    expect(screen.queryByRole("meter")).toBeNull();

    fireEvent.animationEnd(screen.getByRole("status"));
    expect(screen.queryByRole("status")).toBeNull();

    rerender(
      <ChoiceToast changes={2} choice="dvp" icon={<svg />} label="Keymap" />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Keymapdvp");
  });

  it("says more of the choice under the label", () => {
    render(
      <ChoiceToast
        changes={1}
        choice="us"
        detail="English (US)"
        icon={<svg />}
        label="Keymap"
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "KeymapusEnglish (US)",
    );
  });
});
