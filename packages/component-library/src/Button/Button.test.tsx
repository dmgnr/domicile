import { describe, expect, it } from "bun:test";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { Button, SIZES, VARIANTS } from "./Button";

describe(Button, () => {
  describe("rendering", () => {
    it("renders the children inside a button", () => {
      render(<Button>Save</Button>);
      expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
    });

    // Button keeps an internal ref too. base-ui positions a popover against
    // the trigger's ref, so dropping the caller's ref leaves the popover
    // unpositioned.
    it("gives the element it drew to a ref it is passed", () => {
      const seen: (HTMLElement | null)[] = [];
      render(
        <Button
          ref={(element) => {
            seen.push(element);
          }}
        >
          Save
        </Button>,
      );

      expect(seen[0]).toBe(screen.getByRole("button", { name: "Save" }));
    });

    it("gives an anchor back the same way", () => {
      const seen: (HTMLElement | null)[] = [];
      render(
        <Button
          href="https://example.com"
          ref={(element) => {
            seen.push(element);
          }}
        >
          Visit
        </Button>,
      );

      expect(seen[0]).toBe(screen.getByRole("link", { name: "Visit" }));
    });

    it("renders beforeIcon and afterIcon around the label", () => {
      render(
        <Button
          afterIcon={<span data-testid="after">»</span>}
          beforeIcon={<span data-testid="before">«</span>}
        >
          Save
        </Button>,
      );
      const button = screen.getByRole("button", { name: "« Save »" });
      expect(button).toContainElement(screen.getByTestId("before"));
      expect(button).toContainElement(screen.getByTestId("after"));
    });

    it("keeps the label accessible when only an icon is rendered", () => {
      render(
        <Button label="Save">
          <span aria-hidden="true" data-testid="icon">
            ★
          </span>
        </Button>,
      );
      expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
      expect(screen.getByTestId("icon")).toBeInTheDocument();
    });

    it("draws text with a longer name like any text button", () => {
      render(
        <>
          <Button>Forget</Button>
          <Button label="Forget Codex">Forget</Button>
        </>,
      );
      const named = screen.getByRole("button", { name: "Forget Codex" });
      expect(named).toHaveTextContent("Forget");
      expect(named.className).toBe(
        screen.getByRole("button", { name: "Forget" }).className,
      );
    });

    it("forwards arbitrary props to the underlying button", () => {
      render(
        <Button name="submit-button" title="Save changes" type="submit">
          Save
        </Button>,
      );
      const button = screen.getByRole("button", { name: "Save" });
      expect(button).toHaveAttribute("name", "submit-button");
      expect(button).toHaveAttribute("title", "Save changes");
      expect(button).toHaveAttribute("type", "submit");
    });

    for (const variant of VARIANTS) {
      it(`renders without error for the "${variant}" variant`, () => {
        render(<Button variant={variant}>Save</Button>);
        expect(
          screen.getByRole("button", { name: "Save" }),
        ).toBeInTheDocument();
      });
    }

    for (const size of SIZES) {
      it(`renders without error for the "${size}" size`, () => {
        render(<Button size={size}>Save</Button>);
        expect(
          screen.getByRole("button", { name: "Save" }),
        ).toBeInTheDocument();
      });
    }
  });

  describe("link rendering", () => {
    it("renders an anchor when href is provided", () => {
      render(<Button href="https://example.com">Visit</Button>);
      const link = screen.getByRole("link", { name: "Visit" });
      expect(link.tagName).toBe("A");
      expect(link).toHaveAttribute("href", "https://example.com");
    });

    it("forwards target and rel on anchor renderings", () => {
      render(
        <Button href="https://example.com" rel="noopener" target="_blank">
          Visit
        </Button>,
      );
      const link = screen.getByRole("link", { name: "Visit" });
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener");
    });

    it("does not render a button role when href is provided", () => {
      render(<Button href="https://example.com">Visit</Button>);
      expect(
        screen.queryByRole("button", { name: "Visit" }),
      ).not.toBeInTheDocument();
    });

    it("does not forward the disabled attribute to the anchor (invalid HTML)", () => {
      render(
        <Button disabled href="https://example.com">
          Visit
        </Button>,
      );
      expect(screen.getByRole("link", { name: "Visit" })).not.toHaveAttribute(
        "disabled",
      );
    });

    it("marks a disabled anchor with aria-disabled and data-disabled", () => {
      render(
        <Button disabled href="https://example.com">
          Visit
        </Button>,
      );
      const link = screen.getByRole("link", { name: "Visit" });
      expect(link).toHaveAttribute("aria-disabled", "true");
      expect(link).toHaveAttribute("data-disabled");
    });

    it("blocks navigation when a disabled anchor is clicked", async () => {
      const user = userEvent.setup();
      let clicked = false;
      render(
        <Button
          disabled
          href="https://example.com"
          onClick={() => {
            clicked = true;
          }}
        >
          Visit
        </Button>,
      );
      await user.click(screen.getByRole("link", { name: "Visit" }));
      expect(clicked).toBe(false);
    });

    it("blocks navigation when a loading anchor is clicked", async () => {
      const user = userEvent.setup();
      let clicked = false;
      render(
        <Button
          href="https://example.com"
          loading
          onClick={() => {
            clicked = true;
          }}
        >
          Visit
        </Button>,
      );
      await user.click(screen.getByRole("link", { name: "Visit" }));
      expect(clicked).toBe(false);
    });
  });

  describe("interactions", () => {
    it("invokes onClick when clicked", async () => {
      const user = userEvent.setup();
      let clicked = false;
      render(
        <Button
          onClick={() => {
            clicked = true;
          }}
        >
          Save
        </Button>,
      );
      await user.click(screen.getByRole("button", { name: "Save" }));
      expect(clicked).toBe(true);
    });

    it("respects the disabled prop", () => {
      let clicked = false;
      render(
        <Button
          disabled
          onClick={() => {
            clicked = true;
          }}
        >
          Save
        </Button>,
      );
      const button = screen.getByRole("button", { name: "Save" });
      expect(button).toBeDisabled();
      button.click();
      expect(clicked).toBe(false);
    });
  });

  describe("loading state", () => {
    it("marks the button as loading (disabled, aria-busy, data-loading) and blocks clicks", () => {
      let clicked = false;
      render(
        <Button
          loading
          onClick={() => {
            clicked = true;
          }}
        >
          Save
        </Button>,
      );
      const button = screen.getByRole("button", { name: "Save" });
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute("aria-busy", "true");
      expect(button).toHaveAttribute("data-loading");
      button.click();
      expect(clicked).toBe(false);
    });

    it("clears loading-state attributes when not loading", () => {
      render(<Button>Save</Button>);
      const button = screen.getByRole("button", { name: "Save" });
      expect(button).not.toHaveAttribute("aria-busy");
      expect(button).not.toHaveAttribute("data-loading");
    });
  });
});
