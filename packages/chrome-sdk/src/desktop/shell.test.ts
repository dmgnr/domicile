import { describe, expect, it } from "bun:test";
import { Ok } from "@cprussin/option-result";
import { FakeDomicileHost } from "../fake-host";
import { desktop } from "./desktop";

describe("shell", () => {
  it("reads no options until the compositor says", () => {
    expect(desktop(new FakeDomicileHost().host).shell.options).toBeUndefined();
  });

  it("reads the config's options for the shell", () => {
    const fake = new FakeDomicileHost();
    fake.set({ shellOptions: JSON.stringify({ bar: { clock: true } }) });

    expect(desktop(fake.host).shell.options).toStrictEqual({
      bar: { clock: true },
    });
  });

  it("throws on options that are not an object", () => {
    const fake = new FakeDomicileHost();
    fake.set({ shellOptions: "[]" });

    expect(() => desktop(fake.host).shell.options).toThrow();
  });

  it("listens for commands through the compositor, and answers them", async () => {
    const fake = new FakeDomicileHost();
    const shell = desktop(fake.host).shell;
    shell.commands([], []).catch(() => {
      /* never answered */
    });
    shell.answer(4, Ok("ran")).catch(() => {
      /* never answered */
    });
    await Promise.resolve();

    expect(fake.calls).toStrictEqual([
      [
        "callSystem",
        1,
        JSON.stringify({ bindings: [], call: "shell_commands", commands: [] }),
      ],
      [
        "callSystem",
        2,
        JSON.stringify({ call: "answer_shell_command", sent: 4 }),
      ],
    ]);
  });

  it("claims links through the compositor", async () => {
    const fake = new FakeDomicileHost();
    desktop(fake.host)
      .shell.links(["mailto"])
      .catch(() => {
        /* never answered */
      });
    await Promise.resolve();

    expect(fake.calls).toStrictEqual([
      [
        "callSystem",
        1,
        JSON.stringify({ call: "claim_links", schemes: ["mailto"] }),
      ],
    ]);
  });

  it("says the options changed", async () => {
    const fake = new FakeDomicileHost();
    const changed = new Promise((resolve) => {
      desktop(fake.host).shell.on("optionschange", () => {
        resolve(undefined);
      });
    });
    fake.set({ shellOptions: "{}" });

    expect(await changed).toBeUndefined();
  });
});
