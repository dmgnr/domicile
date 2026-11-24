import { describe, expect, it } from "bun:test";
import { fakeDesktop } from "@domicile-desktop/system-apps/fake-desktop";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AppChooser } from "./AppChooser";

const entry = (name: string): string =>
  `[Desktop Entry]\nType=Application\nName=${name}\nExec=app\n`;

/** A desktop with an editor and a viewer installed, the viewer the default. */
const desktop = () =>
  fakeDesktop(
    {
      "/config/mimeapps.list":
        "[Default Applications]\ntext/plain=viewer.desktop\n",
      "/share/applications/editor.desktop": entry("Editor"),
      "/share/applications/viewer.desktop": entry("Viewer"),
    },
    () => ({
      code: 0,
      stderr: "",
      stdout: "XDG_CONFIG_HOME=/config\0XDG_DATA_DIRS=/share\0",
    }),
  );

/** What the chooser answered: an application, or `undefined` on cancel. */
const chosen = (
  choices: readonly string[] = ["editor", "viewer"],
  asker?: string,
): Promise<string | undefined> =>
  new Promise((resolve) => {
    render(
      <AppChooser
        address="claude://claude.ai/magic-link?token=secret"
        asker={asker}
        choices={choices}
        contentType="text/plain"
        domicile={desktop()}
        onCancel={() => {
          resolve(undefined);
        }}
        onChoose={resolve}
        opened="this link"
        screen={undefined}
      />,
    );
  });

describe("AppChooser", () => {
  describe("with several applications", () => {
    it("asks which one, and names who asks", async () => {
      const answer = chosen(undefined, "Chromium");

      expect(
        await screen.findByRole("dialog", {
          name: "Choose an app to open this link",
        }),
      ).toHaveTextContent("Chromium asks");
      await userEvent.keyboard("{Escape}");
      expect(await answer).toBeUndefined();
    });

    it("opens the type's default with Open", async () => {
      const answer = chosen();
      await screen.findByRole("option", { name: "Viewer", selected: true });
      await userEvent.click(screen.getByRole("button", { name: "Open" }));

      expect(await answer).toBe("viewer");
    });

    it("opens another application picked", async () => {
      const answer = chosen();
      await userEvent.dblClick(
        await screen.findByRole("option", { name: "Editor" }),
      );

      expect(await answer).toBe("editor");
    });

    it("cancels", async () => {
      const answer = chosen();
      await screen.findByRole("option", { name: "Editor" });
      await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

      expect(await answer).toBeUndefined();
    });
  });

  describe("with one application", () => {
    it("asks whether to open it, by name", async () => {
      const answer = chosen(["editor"], "Chromium");

      const dialog = await screen.findByRole("dialog", {
        name: "Open Editor?",
      });
      expect(dialog).toHaveTextContent("Opens this link in Editor.");
      expect(dialog).toHaveTextContent("Chromium asks");
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
      await userEvent.click(
        screen.getByRole("button", { name: "Open Editor" }),
      );
      expect(await answer).toBe("editor");
    });

    it("lists it when the user asked to choose", async () => {
      const answer = chosen(["editor"]);
      await screen.findByRole("option", { name: "Editor", selected: true });
      await userEvent.click(screen.getByRole("button", { name: "Open" }));

      expect(await answer).toBe("editor");
    });
  });

  describe("with no application", () => {
    it("says so and only closes", async () => {
      const answer = chosen([], "Chromium");

      const dialog = await screen.findByRole("dialog", {
        name: "No app can open this link",
      });
      expect(dialog).toHaveTextContent("No app on this computer can open it.");
      expect(dialog).toHaveTextContent("Chromium asks");
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Open" }),
      ).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Close" }));
      expect(await answer).toBeUndefined();
    });
  });

  it("animates out when closed, then says so", async () => {
    const props = {
      choices: ["editor"],
      contentType: undefined,
      domicile: desktop(),
      onCancel: () => undefined,
      onChoose: () => undefined,
      opened: "this link",
      screen: undefined,
    };
    const { rerender } = render(<AppChooser {...props} />);
    const closed = new Promise<boolean>((resolve) => {
      rerender(
        <AppChooser {...props} onOpenChangeComplete={resolve} open={false} />,
      );
    });

    expect(screen.getByRole("dialog", { hidden: true })).toHaveAttribute(
      "data-closed",
    );
    expect(await closed).toBe(false);
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { hidden: true }),
      ).not.toBeInTheDocument();
    });
  });
});
