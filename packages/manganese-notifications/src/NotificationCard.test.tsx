import { describe, expect, it } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";

import { notification } from "./fixture";
import { NotificationCard } from "./NotificationCard";

const NOW = new Date(2026, 9, 1, 12, 0, 0).getTime();

/** A card, with every press it hands on kept in `pressed`. */
const card = (
  fields: Parameters<typeof notification>[0],
  pressed: string[] = [],
) =>
  render(
    <NotificationCard
      closeLabel="Clear"
      notification={notification(fields)}
      now={NOW}
      onAction={(key) => {
        pressed.push(key);
      }}
      onClose={() => {
        pressed.push("closed");
      }}
      onReply={(text) => {
        pressed.push(`replied ${text}`);
      }}
    />,
  );

describe("NotificationCard", () => {
  describe("rendering", () => {
    it("says when it is compact, as in a list, so the stylesheet can tighten it", () => {
      const { container } = render(
        <NotificationCard
          closeLabel="Clear"
          density="compact"
          notification={notification({ summary: "New message" })}
          now={NOW}
          onAction={() => undefined}
          onClose={() => undefined}
          onReply={() => undefined}
        />,
      );

      expect(container.firstElementChild).toHaveAttribute(
        "data-density",
        "compact",
      );
    });

    it("says who, when, what and more", () => {
      card({
        appName: "chat.example.com",
        body: "Ada: lunch?",
        summary: "New message",
        time: NOW - 5 * 60 * 1000,
      });

      expect(screen.getByText("chat.example.com")).toBeVisible();
      expect(screen.getByText("5m")).toBeVisible();
      expect(screen.getByText("New message")).toBeVisible();
      expect(screen.getByText("Ada: lunch?")).toBeVisible();
    });

    it("draws its picture, which says nothing its words do not", () => {
      card({ appName: "Firefox", icon: "data:image/png;base64,iVBORw0KGgo=" });

      expect(screen.getByRole("presentation")).toHaveAttribute(
        "src",
        "data:image/png;base64,iVBORw0KGgo=",
      );
    });

    it("runs its body under its picture, across the whole card", () => {
      const { container } = card({ body: "Ada: lunch?" });

      expect(
        screen
          .getByText("Ada: lunch?")
          .parentElement?.isSameNode(container.firstElementChild),
      ).toBe(true);
    });

    it("says a critical one is", () => {
      card({ summary: "Battery low", urgency: "critical" });

      expect(screen.getByLabelText("Critical")).toBeVisible();
    });
  });

  describe("pressing", () => {
    it("takes its default action when it offers one", () => {
      const pressed: string[] = [];
      card({ clickable: true, summary: "New message" }, pressed);

      // The keyboard's way in, and the pointer's anywhere on the card.
      fireEvent.click(screen.getByRole("button", { name: "New message" }));
      fireEvent.click(screen.getByText("Firefox"));

      expect(pressed).toEqual(["default", "default"]);
    });

    it("is nothing to press when it offers none", () => {
      const pressed: string[] = [];
      card({ clickable: false, summary: "Plain" }, pressed);

      fireEvent.click(screen.getByText("Plain"));

      expect(
        screen.queryByRole("button", { name: "Plain" }),
      ).not.toBeInTheDocument();
      expect(pressed).toEqual([]);
    });

    it("presses its buttons, and only them", () => {
      const pressed: string[] = [];
      card(
        {
          actions: [
            { key: "reply", label: "Reply" },
            { key: "mute", label: "Mute" },
          ],
          clickable: true,
        },
        pressed,
      );

      fireEvent.click(screen.getByRole("button", { name: "Mute" }));

      expect(pressed).toEqual(["mute"]);
    });

    it("names an unlabeled reply Reply", () => {
      card({ actions: [{ key: "inline-reply", label: "" }] });

      expect(screen.getByRole("button", { name: "Reply" })).toBeVisible();
    });

    describe("replying", () => {
      /** A card offering a reply and Mute, with its presses in `pressed`. */
      const replyCard = (pressed: string[] = []) =>
        card(
          {
            actions: [
              { key: "mute", label: "Mute" },
              { key: "inline-reply", label: "Reply" },
            ],
            clickable: true,
          },
          pressed,
        );

      it("opens its reply field from Reply, focused, without pressing the card", () => {
        const pressed: string[] = [];
        replyCard(pressed);
        const reply = screen.getByRole("button", { name: "Reply" });

        expect(reply).toHaveAttribute("aria-expanded", "false");
        fireEvent.click(reply);

        expect(reply).toHaveAttribute("aria-expanded", "true");
        expect(screen.getByRole("textbox", { name: "Reply" })).toHaveFocus();
        expect(pressed).toEqual([]);
      });

      it("sends what is typed, then closes the field and returns to Reply", () => {
        const pressed: string[] = [];
        replyCard(pressed);
        const reply = screen.getByRole("button", { name: "Reply" });
        fireEvent.click(reply);

        expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
        fireEvent.change(screen.getByRole("textbox", { name: "Reply" }), {
          target: { value: "On my way" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Send" }));

        expect(pressed).toEqual(["replied On my way"]);
        expect(screen.getByRole("textbox", { name: "Reply" })).toHaveValue("");
        expect(reply).toHaveAttribute("aria-expanded", "false");
        expect(reply).toHaveFocus();
      });

      it("closes the field on Escape and returns to Reply", () => {
        replyCard();
        const reply = screen.getByRole("button", { name: "Reply" });
        fireEvent.click(reply);

        fireEvent.keyDown(screen.getByRole("textbox", { name: "Reply" }), {
          key: "Escape",
        });

        expect(reply).toHaveAttribute("aria-expanded", "false");
        expect(reply).toHaveFocus();
      });

      it("closes an empty field when focus leaves it, and keeps a draft open", () => {
        replyCard();
        const reply = screen.getByRole("button", { name: "Reply" });
        const field = screen.getByRole("textbox", { name: "Reply" });
        fireEvent.click(reply);

        fireEvent.change(field, { target: { value: "Draft" } });
        fireEvent.blur(field);
        expect(reply).toHaveAttribute("aria-expanded", "true");

        fireEvent.change(field, { target: { value: "" } });
        fireEvent.blur(field);
        expect(reply).toHaveAttribute("aria-expanded", "false");
      });
    });

    // The pointer can slip off the close button before it lets go. The click
    // then lands on the card, which must not open the notification.
    it("does not open from a press that started on a button", () => {
      const pressed: string[] = [];
      card({ clickable: true, summary: "New message" }, pressed);

      fireEvent.pointerDown(screen.getByRole("button", { name: "Clear" }));
      fireEvent.click(screen.getByText("Firefox"));

      expect(pressed).toEqual([]);
    });

    it("closes, and only closes", () => {
      const pressed: string[] = [];
      card({ clickable: true }, pressed);

      fireEvent.click(screen.getByRole("button", { name: "Clear" }));

      expect(pressed).toEqual(["closed"]);
    });
  });
});
