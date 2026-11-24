import { describe, expect, it } from "bun:test";
import { EnvelopeSimpleIcon } from "@phosphor-icons/react/dist/ssr/EnvelopeSimple";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { Sender } from "./MailPicker";
import { MailPicker } from "./MailPicker";

const SENDERS: readonly Sender[] = [
  { address: "me@prussin.net", icon: EnvelopeSimpleIcon, inbox: "PrussinNet" },
  { address: "me@alias.net", icon: EnvelopeSimpleIcon, inbox: "PrussinNet" },
  { address: "me@meat.com", icon: EnvelopeSimpleIcon, inbox: "Meat Proxy" },
];

const picker = (
  props: Partial<Parameters<typeof MailPicker>[0]> = {},
): { chosen: string[]; canceled: number[] } => {
  const chosen: string[] = [];
  const canceled: number[] = [];
  render(
    <MailPicker
      link="mailto:alex@example.com?subject=Hello"
      onCancel={() => {
        canceled.push(1);
      }}
      onChoose={({ address }) => {
        chosen.push(address);
      }}
      senders={SENDERS}
      {...props}
    />,
  );
  return { canceled, chosen };
};

describe(MailPicker, () => {
  it("names who the email is to, and lists every inbox's addresses", () => {
    picker();

    expect(
      screen.getByRole("dialog", { name: "Write to alex@example.com" }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("radio").map((row) => row.textContent)).toEqual([
      "PrussinNetme@prussin.net",
      "PrussinNetme@alias.net",
      "Meat Proxyme@meat.com",
    ]);
    expect(
      screen.getByText("mailto:alex@example.com?subject=Hello"),
    ).toBeInTheDocument();
  });

  it("writes from the first address", async () => {
    const first = picker();
    await userEvent.click(screen.getByRole("button", { name: "Write email" }));
    expect(first.chosen).toEqual(["me@prussin.net"]);
  });

  it("starts on the address picked last time", async () => {
    const { chosen } = picker({ lastChoice: "me@meat.com" });

    await userEvent.click(screen.getByRole("button", { name: "Write email" }));

    expect(chosen).toEqual(["me@meat.com"]);
  });

  it("writes from the address picked", async () => {
    const { chosen } = picker();

    await userEvent.click(screen.getByRole("radio", { name: /me@alias.net/ }));
    await userEvent.click(screen.getByRole("button", { name: "Write email" }));

    expect(chosen).toEqual(["me@alias.net"]);
  });

  it("names a link with no recipient as a new email, and who asked", () => {
    picker({ asker: "Slack", link: "mailto:?subject=Hi" });

    expect(
      screen.getByRole("dialog", { name: "Write an email" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Slack asks")).toBeInTheDocument();
  });

  it("writes from the address picked with the keyboard on Enter", async () => {
    const { chosen } = picker();

    await userEvent.click(screen.getByRole("radio", { name: /me@meat.com/ }));
    await userEvent.keyboard("{Enter}");

    expect(chosen).toEqual(["me@meat.com"]);
  });

  it("cancels", async () => {
    const { canceled, chosen } = picker();

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(canceled).toEqual([1]);
    expect(chosen).toEqual([]);
  });
});
