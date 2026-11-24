import { describe, expect, it } from "bun:test";
import { loadEmittedStylesheet } from "@domicile-desktop/test-support/emitted-stylesheet";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { Button } from "../Button/Button";
import { PanelFooter } from "../PanelFooter/PanelFooter";
import { List, ListRow } from "./ListRow";

loadEmittedStylesheet(
  document,
  new URL("../../styled-system/styles.css", import.meta.url),
);

describe(ListRow, () => {
  describe("rendering", () => {
    it("is an item of its list, with its label, detail and end", () => {
      render(
        <List label="Devices">
          <ListRow
            detail="Battery 80%"
            end={<button type="button">Disconnect</button>}
            label="WH-1000XM4"
          />
        </List>,
      );
      const row = screen.getByRole("listitem");
      expect(screen.getByRole("list", { name: "Devices" })).toContainElement(
        row,
      );
      expect(row).toHaveTextContent("WH-1000XM4");
      expect(row).toHaveTextContent("Battery 80%");
      expect(row).toContainElement(
        screen.getByRole("button", { name: "Disconnect" }),
      );
    });

    it("says when its end shows only on hover, so the stylesheet can hide it", () => {
      render(
        <List>
          <ListRow
            end={<button type="button">Open</button>}
            endOnHover
            label="report.pdf"
          />
        </List>,
      );
      expect(screen.getByRole("listitem")).toHaveAttribute("data-end-on-hover");
    });

    it("draws what goes under it, such as a field, in the item", () => {
      render(
        <List>
          <ListRow label="Office">
            <input aria-label="Passphrase" />
          </ListRow>
        </List>,
      );
      expect(screen.getByRole("listitem")).toContainElement(
        screen.getByRole("textbox", { name: "Passphrase" }),
      );
    });
  });

  describe("interactions", () => {
    it("folds what goes under it behind a toggle when given one", async () => {
      render(
        <List>
          <ListRow disclosure="Details" label="Centar">
            <span>10.42.0.17</span>
          </ListRow>
        </List>,
      );
      const toggle = screen.getByRole("button", { name: "Details" });
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByText("10.42.0.17")).toBeNull();

      await userEvent.click(toggle);

      expect(toggle).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByText("10.42.0.17")).toBeVisible();
    });

    it("pads its drawer tightly, centering a footer between its rule and the tile's edge, inset from its side", async () => {
      render(
        <List>
          <ListRow disclosure="Details" label="Centar">
            <PanelFooter action={<Button>Disconnect</Button>} />
          </ListRow>
        </List>,
      );
      await userEvent.click(screen.getByRole("button", { name: "Details" }));

      const footer = screen.getByRole("contentinfo");
      const drawer = globalThis.getComputedStyle(
        footer.parentElement as Element,
      );
      expect(drawer.paddingBlockStart).toBe("0.375rem");
      expect(drawer.paddingBlockEnd).toBe("0.375rem");
      expect(drawer.paddingBlockEnd).toBe(
        globalThis.getComputedStyle(footer).paddingBlockStart,
      );
      expect(
        globalThis.getComputedStyle(
          screen.getByRole("button", { name: "Disconnect" }),
        ).marginInlineEnd,
      ).toBe("0rem");
    });

    it("is one button when it can be pressed, named for assistive tech", async () => {
      const pressed = new Promise((resolve) => {
        render(
          <List>
            <ListRow
              end="3"
              label="PrussinNet"
              name="PrussinNet: 3 unread"
              onPress={() => {
                resolve(true);
              }}
            />
          </List>,
        );
      });
      await userEvent.click(
        screen.getByRole("button", { name: "PrussinNet: 3 unread" }),
      );
      expect(await pressed).toBe(true);
    });

    it("puts its actions beside its button, not in it", async () => {
      const pressed: string[] = [];
      render(
        <List>
          <ListRow
            actions={
              <Button
                onClick={() => {
                  pressed.push("pin");
                }}
              >
                Pin
              </Button>
            }
            label="Dark Reader"
            onPress={() => {
              pressed.push("row");
            }}
          />
        </List>,
      );

      await userEvent.click(screen.getByRole("button", { name: "Pin" }));
      await userEvent.click(
        screen.getByRole("button", { name: "Dark Reader" }),
      );

      expect(pressed).toStrictEqual(["pin", "row"]);
    });

    it("cuts a long label short rather than pushing its actions out", () => {
      render(
        <List>
          <ListRow
            actions={<Button>Pin</Button>}
            label="An extension whose name runs past the panel's edge"
            onPress={() => undefined}
          />
        </List>,
      );

      const row = globalThis.getComputedStyle(
        screen.getByRole("button", {
          name: "An extension whose name runs past the panel's edge",
        }),
      );
      expect(row.flexGrow).toBe("1");
      expect(row.minInlineSize).toBe("0rem");
    });

    it("takes a middle click or a Ctrl+click apart from a click", async () => {
      const pressed: string[] = [];
      render(
        <List label="Profiles">
          <ListRow
            label="Work"
            onPress={() => {
              pressed.push("press");
            }}
            onPressInNew={() => {
              pressed.push("new");
            }}
          />
        </List>,
      );
      const row = screen.getByRole("button", { name: "Work" });
      const user = userEvent.setup();

      await user.pointer({ keys: "[MouseMiddle]", target: row });
      await user.keyboard("{Control>}");
      await user.click(row);
      await user.keyboard("{/Control}");
      await user.click(row);

      expect(pressed).toStrictEqual(["new", "new", "press"]);
    });

    it("takes a right click where it lands, in place of the page's menu", async () => {
      const pressed = Promise.withResolvers<{ x: number; y: number }>();
      render(
        <List label="Apps">
          <ListRow
            label="Syncthing"
            onPress={() => undefined}
            onSecondaryPress={pressed.resolve}
          />
        </List>,
      );
      const row = screen.getByRole("button", { name: "Syncthing" });

      const shown = fireEvent.contextMenu(row, { clientX: 12, clientY: 34 });

      expect(await pressed.promise).toStrictEqual({ x: 12, y: 34 });
      expect(shown).toBe(false);
    });

    it("says it is busy while its request is out", () => {
      render(
        <List>
          <ListRow busy label="Office" onPress={() => undefined} />
        </List>,
      );
      expect(screen.getByRole("button", { name: "Office" })).toHaveAttribute(
        "aria-busy",
        "true",
      );
    });
  });

  describe("motion", () => {
    it("is still its list's item, with its label, when it can move", () => {
      render(
        <List>
          <ListRow
            label="invoice.pdf"
            motion={{
              arriving: true,
              leaving: undefined,
              onLeft: () => undefined,
            }}
            surface="filled"
          />
        </List>,
      );
      const row = screen.getByRole("listitem");
      expect(row).toHaveTextContent("invoice.pdf");
      expect(row).toHaveAttribute("data-arriving");
      expect(row).toHaveAttribute("data-surface", "filled");
    });

    it("leaves out of reach", () => {
      render(
        <List>
          <ListRow
            end={<button type="button">Open</button>}
            label="invoice.pdf"
            motion={{ arriving: false, leaving: 0, onLeft: () => undefined }}
          />
        </List>,
      );
      expect(document.querySelector("li[data-leaving]")).toHaveTextContent(
        "invoice.pdf",
      );
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
    });
  });
});
