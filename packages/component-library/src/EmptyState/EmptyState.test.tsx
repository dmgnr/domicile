import { describe, expect, it } from "bun:test";
import { WifiSlashIcon } from "@phosphor-icons/react/dist/ssr/WifiSlash";
import { render, screen } from "@testing-library/react";

import { EmptyState } from "./EmptyState";

describe(EmptyState, () => {
  describe("rendering", () => {
    it("says what is missing, with a hint on what to do", () => {
      render(
        <EmptyState
          hint="Turn it on to see networks nearby."
          icon={WifiSlashIcon}
          title="Wi-Fi is off"
        />,
      );
      const state = screen.getByRole("status");
      expect(state).toHaveTextContent("Wi-Fi is off");
      expect(state).toHaveTextContent("Turn it on to see networks nearby.");
    });

    it("leaves the hint out when there is none", () => {
      render(<EmptyState icon={WifiSlashIcon} title="You're all caught up" />);
      expect(screen.getByRole("status")).toHaveTextContent(
        /^You're all caught up$/,
      );
    });

    it("offers what would fill it under the hint", () => {
      render(
        <EmptyState
          action={<button type="button">Look again</button>}
          hint="Move closer to your router, then look again."
          icon={WifiSlashIcon}
          title="No networks nearby"
        />,
      );
      expect(
        screen.getByRole("button", { name: "Look again" }),
      ).toBeInTheDocument();
    });

    it("shows a warning sign for something that couldn't be read", () => {
      render(
        <EmptyState
          detail="The name net.connman.iwd was not provided"
          title="Couldn't read Wi-Fi"
          tone="warning"
        />,
      );
      const state = screen.getByRole("status");
      expect(state).toHaveAttribute("data-tone", "warning");
      expect(state).toHaveAttribute(
        "title",
        "The name net.connman.iwd was not provided",
      );
      expect(state.querySelector("svg")).not.toBeNull();
    });

    it("sits under a panel's rows inline, as words alone", () => {
      render(
        <EmptyState
          icon={WifiSlashIcon}
          layout="inline"
          title="No other networks nearby"
        />,
      );
      const state = screen.getByRole("status");
      expect(state).toHaveAttribute("data-layout", "inline");
      expect(state.querySelector("svg")).toBeNull();
    });
  });
});
