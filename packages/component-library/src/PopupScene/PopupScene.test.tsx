import { describe, expect, it } from "bun:test";
import {
  render,
  screen,
  waitForElementToBeRemoved,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { useState } from "react";

import { Autocomplete } from "../Autocomplete/Autocomplete";
import { Button } from "../Button/Button";
import { ContextMenu } from "../ContextMenu/ContextMenu";
import { Menu } from "../Menu/Menu";
import { MenuBar } from "../MenuBar/MenuBar";
import { Popover } from "../Popover/Popover";
import { PopupBoundary } from "../PopupBoundary/PopupBoundary";
import { Select } from "../Select/Select";
import { Tooltip } from "../Tooltip/Tooltip";

import { PopupScene } from "./PopupScene";

describe(PopupScene, () => {
  describe("closing popups when the scene changes", () => {
    it("closes a popover", async () => {
      const { rerender } = render(
        <PopupScene scene="desk">
          <Popover trigger={<Button>Details</Button>}>Body</Popover>
        </PopupScene>,
      );
      await userEvent.click(screen.getByRole("button", { name: "Details" }));
      await screen.findByRole("dialog");

      rerender(
        <PopupScene scene="overview">
          <Popover trigger={<Button>Details</Button>}>Body</Popover>
        </PopupScene>,
      );

      await waitForElementToBeRemoved(() => screen.queryByRole("dialog"));
    });

    it("closes a tooltip", async () => {
      const tooltip = (
        <Tooltip
          content="Full title"
          defaultOpen
          trigger={<Button>Tab</Button>}
        />
      );
      const { rerender } = render(
        <PopupScene scene="desk">{tooltip}</PopupScene>,
      );
      await screen.findByRole("tooltip");

      rerender(<PopupScene scene="scratchpad">{tooltip}</PopupScene>);

      await waitForElementToBeRemoved(() => screen.queryByRole("tooltip"));
    });

    it("closes a menu", async () => {
      const menu = (
        <Menu trigger={<Button>Pause</Button>}>
          <Menu.Item>For 1 hour</Menu.Item>
        </Menu>
      );
      const { rerender } = render(<PopupScene scene="desk">{menu}</PopupScene>);
      await userEvent.click(screen.getByRole("button", { name: "Pause" }));
      await screen.findByRole("menu");

      rerender(<PopupScene scene="fullscreen">{menu}</PopupScene>);

      await waitForElementToBeRemoved(() => screen.queryByRole("menu"));
    });

    it("closes a menu bar's menu", async () => {
      const bar = (
        <MenuBar label="Claude">
          <MenuBar.Menu label="File">
            <MenuBar.Item>Quit</MenuBar.Item>
          </MenuBar.Menu>
        </MenuBar>
      );
      const { rerender } = render(<PopupScene scene="desk">{bar}</PopupScene>);
      await userEvent.click(screen.getByRole("menuitem", { name: "File" }));
      await screen.findByRole("menu");

      rerender(<PopupScene scene="overview">{bar}</PopupScene>);

      await waitForElementToBeRemoved(() => screen.queryByRole("menu"));
    });

    it("asks its owner to close a context menu", async () => {
      const closed = await new Promise<boolean>((resolve) => {
        const { rerender } = render(
          <PopupScene scene="desk">
            <OpenContextMenu onOpenChange={resolve} />
          </PopupScene>,
        );
        rerender(
          <PopupScene scene="overview">
            <OpenContextMenu onOpenChange={resolve} />
          </PopupScene>,
        );
      });

      expect(closed).toBe(false);
    });

    it("closes a select's list", async () => {
      const select = (
        <Select
          aria-label="Font"
          options={[
            { label: "Sans", value: "sans" },
            { label: "Serif", value: "serif" },
          ]}
        />
      );
      const { rerender } = render(
        <PopupScene scene="desk">{select}</PopupScene>,
      );
      await userEvent.click(screen.getByRole("combobox", { name: "Font" }));
      await screen.findByRole("listbox");

      rerender(<PopupScene scene="overview">{select}</PopupScene>);

      await waitForElementToBeRemoved(() => screen.queryByRole("listbox"));
    });

    it("closes an autocomplete's suggestions", async () => {
      const { rerender } = render(
        <PopupScene scene="desk">
          <Address />
        </PopupScene>,
      );
      await userEvent.type(
        screen.getByRole("combobox", { name: "Address" }),
        "doc",
      );
      await screen.findByText("docs.example.com");

      rerender(
        <PopupScene scene="overview">
          <Address />
        </PopupScene>,
      );

      await waitForElementToBeRemoved(() =>
        screen.queryByText("docs.example.com"),
      );
    });

    it("closes popups inside an inner scene when an outer one changes", async () => {
      const { rerender } = render(
        <Scenes outer="desk">
          <Popover trigger={<Button>Details</Button>}>Body</Popover>
        </Scenes>,
      );
      await userEvent.click(screen.getByRole("button", { name: "Details" }));
      await screen.findByRole("dialog");

      rerender(
        <Scenes outer="overview">
          <Popover trigger={<Button>Details</Button>}>Body</Popover>
        </Scenes>,
      );

      await waitForElementToBeRemoved(() => screen.queryByRole("dialog"));
    });

    it("closes popups inside a PopupBoundary when its box moves", async () => {
      const { rerender } = render(
        <PopupBoundary box={{ height: 300, width: 400, x: 0, y: 0 }}>
          <Popover trigger={<Button>Details</Button>}>Body</Popover>
        </PopupBoundary>,
      );
      await userEvent.click(screen.getByRole("button", { name: "Details" }));
      await screen.findByRole("dialog");

      rerender(
        <PopupBoundary box={{ height: 300, width: 400, x: 0, y: 500 }}>
          <Popover trigger={<Button>Details</Button>}>Body</Popover>
        </PopupBoundary>,
      );

      await waitForElementToBeRemoved(() => screen.queryByRole("dialog"));
    });
  });

  describe("leaving popups alone", () => {
    it("keeps a popup open while the scene stays", async () => {
      const { rerender } = render(
        <PopupScene scene="desk">
          <Popover trigger={<Button>Details</Button>}>Body</Popover>
        </PopupScene>,
      );
      await userEvent.click(screen.getByRole("button", { name: "Details" }));
      await screen.findByRole("dialog");

      rerender(
        <PopupScene scene="desk">
          <Popover trigger={<Button>Details</Button>}>Other body</Popover>
        </PopupScene>,
      );

      expect(await screen.findByText("Other body")).toBeVisible();
    });

    it("does not ask to close a closed context menu", () => {
      const heard: boolean[] = [];
      const menu = (
        <ContextMenu
          at={{ x: 0, y: 0 }}
          label="Page"
          onOpenChange={(open) => {
            heard.push(open);
          }}
          open={false}
        >
          <ContextMenu.Item>Reload</ContextMenu.Item>
        </ContextMenu>
      );
      const { rerender } = render(<PopupScene scene="desk">{menu}</PopupScene>);

      rerender(<PopupScene scene="overview">{menu}</PopupScene>);

      expect(heard).toEqual([]);
    });
  });
});

/** A context menu its owner holds open until told it closed. */
const OpenContextMenu = ({
  onOpenChange,
}: {
  onOpenChange: (open: boolean) => void;
}) => (
  <ContextMenu
    at={{ x: 0, y: 0 }}
    label="Page"
    onOpenChange={onOpenChange}
    open
  >
    <ContextMenu.Item>Reload</ContextMenu.Item>
  </ContextMenu>
);

/** An address field with one suggestion, as a browser window has. */
const Address = () => {
  const [value, setValue] = useState("");
  return (
    <Autocomplete
      aria-label="Address"
      emptyMessage="Nothing to suggest"
      onValueChange={setValue}
      suggestions={[
        {
          label: "docs.example.com",
          text: "https://docs.example.com",
          value: "https://docs.example.com",
        },
      ]}
      value={value}
    />
  );
};

/** A scene that stays inside one that changes to `outer`. */
const Scenes = ({
  children,
  outer,
}: {
  children: ReactNode;
  outer: string;
}) => (
  <PopupScene scene={outer}>
    <PopupScene scene="window">{children}</PopupScene>
  </PopupScene>
);
