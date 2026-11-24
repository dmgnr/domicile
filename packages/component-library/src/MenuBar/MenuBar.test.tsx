import { describe, expect, it } from "bun:test";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { MenuBar } from "./MenuBar";

const bar = (chose: string[] = [], open?: boolean) =>
  render(
    <MenuBar label="Claude">
      <MenuBar.Menu label="File" mnemonic={0} {...(open ? { open } : {})}>
        <MenuBar.Item
          onClick={() => {
            chose.push("new");
          }}
          shortcut="Ctrl+N"
        >
          New Conversation
        </MenuBar.Item>
        <MenuBar.Separator />
        <MenuBar.Item>Quit</MenuBar.Item>
      </MenuBar.Menu>
      <MenuBar.Menu label="Edit">
        <MenuBar.Item>Undo</MenuBar.Item>
      </MenuBar.Menu>
    </MenuBar>,
  );

describe(MenuBar, () => {
  describe("rendering", () => {
    it("draws a named bar of its menus' names, closed", () => {
      bar();

      expect(screen.getByRole("menubar", { name: "Claude" })).toBeVisible();
      expect(
        screen.getAllByRole("menuitem").map((item) => item.textContent),
      ).toEqual(["File", "Edit"]);
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });

    it("underlines a menu's mnemonic", () => {
      bar();

      const file = screen.getByRole("menuitem", { name: "File" });
      expect(file.querySelector("span")?.textContent).toBe("F");
    });

    it("opens a menu it is told to", async () => {
      bar([], true);

      expect(
        await screen.findByRole("menu", { name: "File" }),
      ).toBeInTheDocument();
    });
  });

  describe("interactions", () => {
    it("opens a menu of its items, with their shortcuts, and chooses one", async () => {
      const chose: string[] = [];
      bar(chose);

      await userEvent.click(screen.getByRole("menuitem", { name: "File" }));
      const newConversation = await screen.findByRole("menuitem", {
        name: /New Conversation/,
      });

      expect(newConversation).toHaveTextContent("Ctrl+N");
      await userEvent.click(newConversation);
      expect(chose).toEqual(["new"]);
    });
  });
});
