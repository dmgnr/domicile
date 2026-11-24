import { describe, expect, it } from "bun:test";
import type { MessageBox } from "@domicile-desktop/sdk/message-box";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AppMessageBox } from "./AppMessageBox";

const quit: MessageBox = {
  buttons: ["Cancel", "Quit"],
  cancelButton: 0,
  checkbox: "Don't ask again",
  checkboxChecked: false,
  defaultButton: 1,
  detail: "Any conversation still generating will stop.",
  kind: "question",
  message: "Quit Claude?",
  title: "Claude",
};

/** Renders `box`, recording its answers as "button checked". */
const renderBox = (box: MessageBox) => {
  const answers: string[] = [];
  render(
    <AppMessageBox
      box={box}
      onAnswer={(button, checked) => {
        answers.push(`${button.toString()} ${checked.toString()}`);
      }}
      ref={(element) => {
        element?.focus();
      }}
    />,
  );
  return answers;
};

describe("AppMessageBox", () => {
  describe("rendering", () => {
    it("is named by the app's message and described by its detail", () => {
      renderBox(quit);

      const dialog = screen.getByRole("alertdialog", { name: "Quit Claude?" });
      expect(dialog).toHaveAccessibleDescription(
        "Any conversation still generating will stop.",
      );
    });

    it("shows the app's buttons in the app's order", () => {
      renderBox({
        ...quit,
        buttons: ["Don't Save", "Cancel", "Save"],
        cancelButton: 1,
        defaultButton: 2,
      });

      expect(
        screen.getAllByRole("button").map((button) => button.textContent),
      ).toEqual(["Don't Save", "Cancel", "Save"]);
    });

    it("focuses the default button", () => {
      renderBox(quit);

      expect(screen.getByRole("button", { name: "Quit" })).toHaveFocus();
    });

    it("focuses the cancel button with no default", () => {
      renderBox({ ...quit, defaultButton: undefined });

      expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    });

    it("shows no switch with no checkbox", () => {
      renderBox({ ...quit, checkbox: undefined });

      expect(screen.queryByRole("switch")).toBeNull();
    });

    it("starts the switch as the app checked it", () => {
      renderBox({ ...quit, checkboxChecked: true });

      expect(
        screen.getByRole("switch", { name: "Don't ask again" }),
      ).toBeChecked();
    });
  });

  describe("answering", () => {
    it("answers with the button pressed", async () => {
      const answers = renderBox(quit);

      await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

      expect(answers).toEqual(["0 false"]);
    });

    it("answers with the checkbox as the user left it", async () => {
      const answers = renderBox(quit);

      await userEvent.click(
        screen.getByRole("switch", { name: "Don't ask again" }),
      );
      await userEvent.click(screen.getByRole("button", { name: "Quit" }));

      expect(answers).toEqual(["1 true"]);
    });

    it("presses the default button on Enter", async () => {
      const answers = renderBox(quit);

      await userEvent.keyboard("{Enter}");

      expect(answers).toEqual(["1 false"]);
    });

    it("presses the cancel button on Escape", async () => {
      const answers = renderBox({
        ...quit,
        buttons: ["Save", "Don't Save", "Cancel"],
        cancelButton: 2,
        defaultButton: 0,
      });

      await userEvent.keyboard("{Escape}");

      expect(answers).toEqual(["2 false"]);
    });

    it("answers once for a click on the default button", async () => {
      const answers = renderBox(quit);

      await userEvent.click(screen.getByRole("button", { name: "Quit" }));

      expect(answers).toEqual(["1 false"]);
    });
  });
});
