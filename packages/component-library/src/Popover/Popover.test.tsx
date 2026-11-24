import { afterEach, describe, expect, it, spyOn } from "bun:test";
import {
  drawAt,
  drawPopups,
  popupLeft,
  undrawPopups,
} from "@domicile-desktop/test-support/popup-layout";
import {
  act,
  render,
  screen,
  waitFor,
  waitForElementToBeRemoved,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";

import { Button } from "../Button/Button";
import { Select } from "../Select/Select";

import { createHandle, Popover, PopoverContainer } from "./Popover";

describe(Popover, () => {
  describe("rendering", () => {
    it("does not render the body when closed", () => {
      render(
        <Popover open={false} title="Connection">
          Body
        </Popover>,
      );
      expect(screen.queryByText("Body")).not.toBeInTheDocument();
    });

    it("renders the title and the body when open", () => {
      render(
        <Popover open title="Connection">
          Body
        </Popover>,
      );
      expect(screen.getByText("Connection")).toBeInTheDocument();
      expect(screen.getByText("Body")).toBeInTheDocument();
    });

    it("renders a body with no title", () => {
      render(
        <Popover open title={undefined}>
          Body
        </Popover>,
      );
      expect(screen.getByText("Body")).toBeInTheDocument();
    });

    it("says when it is drawn flush, so the stylesheet can drop its padding", () => {
      render(
        <Popover flush open>
          Body
        </Popover>,
      );
      expect(screen.getByRole("dialog")).toHaveAttribute("data-flush");
    });

    it("says when it is withheld, so the stylesheet can hide it until its body is ready", () => {
      render(
        <Popover open withheld>
          Body
        </Popover>,
      );
      expect(screen.getByRole("dialog")).toHaveAttribute("data-withheld");
    });

    it("says when it is wide, so the stylesheet can widen its cap", () => {
      render(
        <Popover open wide>
          Body
        </Popover>,
      );
      expect(screen.getByRole("dialog")).toHaveAttribute("data-wide");
    });

    it("says when it is drawn over a photograph, so the stylesheet can glass it", () => {
      render(
        <Popover open tone="overPhoto">
          Body
        </Popover>,
      );
      expect(screen.getByRole("dialog")).toHaveAttribute(
        "data-tone",
        "overPhoto",
      );
    });

    it("is padded unless it is drawn flush", () => {
      render(<Popover open>Body</Popover>);
      expect(screen.getByRole("dialog")).not.toHaveAttribute("data-flush");
    });

    it("renders the trigger and stays closed until it is pressed", () => {
      render(
        <Popover title="Connection" trigger={<Button>Details</Button>}>
          Body
        </Popover>,
      );
      expect(screen.getByRole("button", { name: "Details" })).toBeVisible();
      expect(screen.queryByText("Body")).not.toBeInTheDocument();
    });

    it("keeps its body in the page while closed when kept mounted", () => {
      render(
        <Popover keepMounted trigger={<Button>Details</Button>}>
          Body
        </Popover>,
      );
      expect(screen.getByText("Body")).toBeInTheDocument();
      expect(screen.getByText("Body")).not.toBeVisible();
    });

    it("draws the panel in the element a PopoverContainer names", () => {
      const layer = document.createElement("div");
      document.body.append(layer);
      render(
        <PopoverContainer value={layer}>
          <Popover open>Body</Popover>
        </PopoverContainer>,
      );
      expect(layer).toContainElement(screen.getByRole("dialog"));
      layer.remove();
    });
  });

  describe("interactions", () => {
    it("opens when its trigger is pressed", async () => {
      render(
        <Popover title="Connection" trigger={<Button>Details</Button>}>
          Body
        </Popover>,
      );

      await userEvent.click(screen.getByRole("button", { name: "Details" }));

      expect(screen.getByText("Body")).toBeInTheDocument();
    });

    it("takes focus itself when the pointer opens it, so no control shows a focus ring", async () => {
      render(
        <Popover trigger={<Button>Details</Button>}>
          <button type="button">First</button>
        </Popover>,
      );

      await userEvent.click(screen.getByRole("button", { name: "Details" }));

      await waitFor(() => {
        expect(screen.getByRole("dialog")).toHaveFocus();
      });
    });

    it("leaves focus where it is when it opens quietly, by itself", async () => {
      const Quiet = ({ open }: { open: boolean }) => (
        <>
          <input aria-label="Page" />
          <Popover open={open} quiet trigger={<Button>Details</Button>}>
            Body
          </Popover>
        </>
      );
      const { rerender } = render(<Quiet open={false} />);
      screen.getByRole("textbox", { name: "Page" }).focus();

      rerender(<Quiet open />);

      await screen.findByText("Body");
      expect(screen.getByRole("textbox", { name: "Page" })).toHaveFocus();
    });

    it("still takes focus when the pointer opens it quietly", async () => {
      render(
        <Popover quiet trigger={<Button>Details</Button>}>
          Body
        </Popover>,
      );

      await userEvent.click(screen.getByRole("button", { name: "Details" }));

      await waitFor(() => {
        expect(screen.getByRole("dialog")).toHaveFocus();
      });
    });

    it("focuses its first control when the keyboard opens it", async () => {
      render(
        <Popover trigger={<Button>Details</Button>}>
          <button type="button">First</button>
        </Popover>,
      );

      screen.getByRole("button", { name: "Details" }).focus();
      await userEvent.keyboard("{Enter}");

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "First" })).toHaveFocus();
      });
    });

    describe("with a tooltip", () => {
      it("names its trigger while the pointer rests on it", async () => {
        render(
          <Popover
            tooltip="Connection details"
            trigger={<Button label="Details">i</Button>}
          >
            Body
          </Popover>,
        );

        await userEvent.hover(screen.getByRole("button", { name: "Details" }));

        expect(
          await screen.findByRole("tooltip", {}, { timeout: 2000 }),
        ).toHaveTextContent("Connection details");
      });

      it("still opens when its trigger is pressed", async () => {
        render(
          <Popover
            tooltip="Connection details"
            trigger={<Button>Details</Button>}
          >
            Body
          </Popover>,
        );

        await userEvent.click(screen.getByRole("button", { name: "Details" }));

        expect(screen.getByText("Body")).toBeInTheDocument();
      });
    });

    describe("with triggers elsewhere", () => {
      it("opens from a trigger that shares its handle", async () => {
        const handle = createHandle();
        render(
          <>
            <Popover handle={handle}>Body</Popover>
            <Popover.Trigger
              handle={handle}
              render={<Button>Elsewhere</Button>}
            />
          </>,
        );

        await userEvent.click(
          screen.getByRole("button", { name: "Elsewhere" }),
        );

        expect(screen.getByText("Body")).toBeInTheDocument();
      });

      it("closes when that trigger is pressed again", async () => {
        const handle = createHandle();
        render(
          <>
            <Popover handle={handle} trigger={<Button>Here</Button>}>
              Body
            </Popover>
            <Popover.Trigger
              handle={handle}
              render={<Button>Elsewhere</Button>}
            />
          </>,
        );
        const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
        await userEvent.click(elsewhere);

        await userEvent.click(elsewhere);

        await waitFor(() => {
          expect(screen.queryByText("Body")).not.toBeInTheDocument();
        });
      });
    });

    describe("on a desktop of several screens", () => {
      afterEach(undrawPopups);

      it("stays on the screen of the trigger that opened it", async () => {
        const handle = createHandle();
        render(
          <>
            <div data-screen="DP-1">
              <Popover handle={handle} trigger={<Button>Here</Button>}>
                Body
              </Popover>
            </div>
            <div data-screen="DP-2">
              <Popover.Trigger
                handle={handle}
                render={<Button>Elsewhere</Button>}
              />
            </div>
          </>,
        );
        const here = screen.getByRole("button", { name: "Here" });
        const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
        drawAt(here, { height: 28, width: 28, x: 560, y: 0 });
        drawAt(here.parentElement as HTMLElement, {
          height: 800,
          width: 600,
          x: 0,
          y: 0,
        });
        drawAt(elsewhere, { height: 28, width: 28, x: 610, y: 0 });
        drawAt(elsewhere.parentElement as HTMLElement, {
          height: 800,
          width: 600,
          x: 600,
          y: 0,
        });
        drawPopups("dialog", { height: 100, width: 300 });

        await userEvent.click(elsewhere);

        await waitFor(() => {
          expect(panelRight()).toBeGreaterThanOrEqual(900);
        });
      });

      it("hangs under an anchor it is given in place of a trigger", async () => {
        const Anchored = ({ open }: { open: boolean }) => {
          const [anchor, setAnchor] = useState<HTMLElement | null>(null);
          return (
            <>
              <span data-testid="anchor" ref={setAnchor} />
              <Popover align="end" anchor={anchor} open={open}>
                Body
              </Popover>
            </>
          );
        };
        const { rerender } = render(<Anchored open={false} />);
        drawAt(screen.getByTestId("anchor"), {
          height: 0,
          width: 0,
          x: 800,
          y: 40,
        });
        drawPopups("dialog", { height: 100, width: 300 });

        rerender(<Anchored open />);

        await waitFor(() => {
          expect(panelRight()).toBe(800);
        });
      });

      it("stays on its trigger's screen", async () => {
        render(
          <div data-screen="DP-1">
            <Popover trigger={<Button>Details</Button>}>Body</Popover>
          </div>,
        );
        const trigger = screen.getByRole("button", { name: "Details" });
        drawAt(trigger, { height: 28, width: 28, x: 560, y: 0 });
        drawAt(trigger.parentElement as HTMLElement, {
          height: 800,
          width: 600,
          x: 0,
          y: 0,
        });
        drawPopups("dialog", { height: 100, width: 300 });

        await userEvent.click(trigger);

        await waitFor(() => {
          expect(panelRight()).toBeLessThanOrEqual(600);
        });
      });
    });

    // Its padding counts, so a pointer on its way to a control holds it too.
    it("says when the pointer comes onto it and leaves, padding included", async () => {
      const hovers: boolean[] = [];
      render(
        <Popover
          onHoverChange={(hovered) => {
            hovers.push(hovered);
          }}
          open
        >
          Body
        </Popover>,
      );
      const panel = screen.getByRole("dialog");
      await userEvent.hover(panel);
      await userEvent.unhover(panel);
      expect(hovers).toStrictEqual([true, false]);
    });

    it("closes when focus moves to something outside it", async () => {
      // Focus moves at once, which also logs a focus thief; that has its own
      // test below.
      const errors = spyOn(console, "error").mockImplementation(
        () => undefined,
      );
      render(
        <>
          <Popover title="Connection" trigger={<Button>Details</Button>}>
            Body
          </Popover>
          <button type="button">Elsewhere</button>
        </>,
      );
      await userEvent.click(screen.getByRole("button", { name: "Details" }));

      act(() => {
        screen.getByRole("button", { name: "Elsewhere" }).focus();
      });

      await waitForElementToBeRemoved(() => screen.queryByText("Body"));
      errors.mockRestore();
    });

    it("says what took focus when that shuts it as it opens", async () => {
      const errors = spyOn(console, "error").mockImplementation(
        () => undefined,
      );
      try {
        render(
          <>
            <Popover title="Connection" trigger={<Button>Details</Button>}>
              Body
            </Popover>
            <button className="thief" id="elsewhere" type="button">
              Elsewhere
            </button>
          </>,
        );
        await userEvent.click(screen.getByRole("button", { name: "Details" }));

        act(() => {
          screen.getByRole("button", { name: "Elsewhere" }).focus();
        });

        await waitForElementToBeRemoved(() => screen.queryByText("Body"));
        expect(errors).toHaveBeenCalledTimes(1);
        expect(String(errors.mock.calls[0]?.[0])).toContain(
          "button#elsewhere.thief took focus",
        );
      } finally {
        errors.mockRestore();
      }
    });

    it("asks nothing of its owner when focus moves while it is closed", () => {
      // Its panel lingers while closed: kept mounted, or playing its closing
      // transition. A close asked for then would close a popover the same
      // owner opened in its place, such as the tray's next extension popup.
      const asked: boolean[] = [];
      render(
        <>
          <Popover
            keepMounted
            onOpenChange={(open) => {
              asked.push(open);
            }}
            open={false}
            title="Connection"
          >
            Body
          </Popover>
          <button type="button">Elsewhere</button>
        </>,
      );

      act(() => {
        screen.getByRole("button", { name: "Elsewhere" }).focus();
      });

      expect(asked).toStrictEqual([]);
    });

    it("stays open when focus moves within it", async () => {
      render(
        <Popover title="Connection" trigger={<Button>Details</Button>}>
          <button type="button">Inside</button>
        </Popover>,
      );
      await userEvent.click(screen.getByRole("button", { name: "Details" }));

      act(() => {
        screen.getByRole("button", { name: "Inside" }).focus();
      });

      expect(screen.getByRole("button", { name: "Inside" })).toBeVisible();
    });

    it("stays open while a select inside it is used, though its list is drawn elsewhere", async () => {
      const user = userEvent.setup();
      render(
        <Popover title="Connection" trigger={<Button>Details</Button>}>
          <Select
            aria-label="Port"
            defaultValue="speakers"
            options={[
              { label: "Speakers", value: "speakers" },
              { label: "Headphones", value: "headphones" },
            ]}
          />
        </Popover>,
      );
      await user.click(screen.getByRole("button", { name: "Details" }));

      await user.click(screen.getByRole("combobox", { name: "Port" }));
      await user.click(screen.getByRole("option", { name: "Headphones" }));

      expect(screen.getByRole("combobox", { name: "Port" })).toHaveTextContent(
        "Headphones",
      );
    });
  });
});

/** The open panel's right edge. Panels are drawn 300px wide. */
const panelRight = () => popupLeft("dialog") + 300;
