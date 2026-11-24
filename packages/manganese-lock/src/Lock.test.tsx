import { describe, expect, it } from "bun:test";
import { DisplayProvider } from "@domicile-desktop/component-library/DisplayProvider";
import { Popover } from "@domicile-desktop/component-library/Popover";
import { Slider } from "@domicile-desktop/component-library/Slider";
import {
  OnOneScreen,
  SCREEN,
} from "@domicile-desktop/manganese-window-management/screens/fixture";
import { UnlockRefusal } from "@domicile-desktop/sdk/system";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PropsWithChildren } from "react";
import { Lock } from "./Lock";
import type { Refused } from "./useLocked";

/** The lock state, as `useLocked` returns it. */
type Standing = {
  checking: boolean;
  locked: boolean;
  refusals: number;
  refused?: Refused | undefined;
};

/** The monotonic clock the lock reads, frozen, in milliseconds. */
const NOW = 86_400_000;

/** Renders the lock, recording every passphrase it submits. */
const lock = (locked = true) => {
  const offered: string[] = [];
  const drawn = (standing: Standing) => (
    <Lock
      {...standing}
      now={() => NOW}
      onUnlock={(passphrase) => {
        offered.push(passphrase);
      }}
      screen={SCREEN}
    />
  );
  const { rerender } = render(drawn({ checking: false, locked, refusals: 0 }), {
    wrapper: OnOneScreen,
  });
  return {
    field: () => screen.getByLabelText("Passphrase") as HTMLInputElement,
    offered,
    says: (standing: Partial<Standing>) => {
      rerender(
        drawn({ checking: false, locked: true, refusals: 0, ...standing }),
      );
    },
    user: userEvent.setup(),
  };
};

describe("Lock", () => {
  it("is out of reach while the desk is open", () => {
    // Inert rather than unmounted so it can fade out. A transparent sheet would
    // still catch every click and Tab.
    lock(false);

    expect(
      screen.getByLabelText("Passphrase").closest("[inert]"),
    ).not.toBeNull();
  });

  it("shows the lock screen picture an application set", () => {
    render(
      <Lock
        checking={false}
        locked
        onUnlock={() => undefined}
        picture="blob:moon"
        refusals={0}
        screen={SCREEN}
      />,
      { wrapper: OnOneScreen },
    );

    expect(
      document.querySelector("img[data-lock-picture]")?.getAttribute("src"),
    ).toBe("blob:moon");
  });

  it("covers the desktop and asks for the passphrase", () => {
    lock();

    expect(screen.getByLabelText("Passphrase").closest("[inert]")).toBeNull();
  });

  it("blurs each screen and not the gaps between them", () => {
    // Monitors of different sizes leave gaps in the page. A blur over the
    // whole page would cost as much there as on the screens.
    render(
      <Lock
        checking={false}
        locked
        onUnlock={() => undefined}
        refusals={0}
        screen="left"
      />,
      { wrapper: OnTwoScreens },
    );

    expect(
      [...document.querySelectorAll<HTMLElement>("[data-veil]")].map(
        ({ style: { height, left, top, width } }) => ({
          height,
          left,
          top,
          width,
        }),
      ),
    ).toEqual([
      { height: "1080px", left: "0px", top: "0px", width: "1920px" },
      { height: "1440px", left: "1920px", top: "120px", width: "2560px" },
    ]);
  });

  it("asks for the passphrase on the focused screen", () => {
    // Centered on the page, the field would sit on the seam between monitors
    // or in a gap no monitor shows.
    render(
      <Lock
        checking={false}
        locked
        onUnlock={() => undefined}
        refusals={0}
        screen="right"
      />,
      { wrapper: OnTwoScreens },
    );

    const { height, left, top, width } =
      screen
        .getByLabelText("Passphrase")
        .closest<HTMLElement>("[data-lock-content]")?.style ?? {};
    expect({ height, left, top, width }).toEqual({
      height: "1440px",
      left: "1920px",
      top: "120px",
      width: "2560px",
    });
  });

  it("blurs the whole page until the screens are described", () => {
    // A desk that locks while starting must not be left readable.
    render(
      <Lock
        checking={false}
        locked
        onUnlock={() => undefined}
        refusals={0}
        screen={SCREEN}
      />,
      {
        wrapper: ({ children }) => (
          <DisplayProvider
            source={{ displays: undefined, onDisplays: () => () => undefined }}
          >
            {children}
          </DisplayProvider>
        ),
      },
    );

    const veils = document.querySelectorAll<HTMLElement>("[data-veil]");
    expect(veils.length).toBe(1);
    expect(veils[0]?.getAttribute("style")).toBeNull();
  });

  describe("the bar", () => {
    it("is drawn across each screen, for that screen", () => {
      render(
        <Lock
          bar={(name) => <p>{`Bar on ${name}`}</p>}
          checking={false}
          locked
          onUnlock={() => undefined}
          refusals={0}
          screen="left"
        />,
        { wrapper: OnTwoScreens },
      );

      expect(
        screen
          .getAllByText(/^Bar on/)
          .map((bar) => [
            bar.textContent,
            bar.closest("[data-screen]")?.getAttribute("data-screen"),
          ]),
      ).toEqual([
        ["Bar on left", "left"],
        ["Bar on right", "right"],
      ]);
    });

    it("is not drawn while the desk is open", () => {
      // The desktop's own bar has the same controls.
      render(
        <Lock
          bar={() => <p>Bar</p>}
          checking={false}
          locked={false}
          onUnlock={() => undefined}
          refusals={0}
          screen={SCREEN}
        />,
        { wrapper: OnOneScreen },
      );

      expect(screen.queryByText("Bar")).not.toBeInTheDocument();
    });

    it("opens its panels over the lock", async () => {
      // The page's body is under the sheet.
      const { container } = render(
        <Lock
          bar={() => (
            <Popover trigger={<button type="button">Brightness</button>}>
              Level
            </Popover>
          )}
          checking={false}
          locked
          onUnlock={() => undefined}
          refusals={0}
          screen={SCREEN}
        />,
        { wrapper: OnOneScreen },
      );

      await userEvent.click(screen.getByRole("button", { name: "Brightness" }));

      expect(container).toContainElement(screen.getByRole("dialog"));
    });
  });

  describe("the keyboard", () => {
    it("is put in the field as the desk shuts", () => {
      // On the transition, not on mount: the sheet is always mounted.
      const { says } = lock(false);

      says({ locked: true });

      expect(document.activeElement).toBe(screen.getByLabelText("Passphrase"));
    });

    it("cannot be taken out of the field while the desk is shut", async () => {
      // The field is the only input on a locked desktop, so a key elsewhere
      // would be lost.
      const { user } = lock();

      await user.tab();
      expect(document.activeElement).toBe(screen.getByLabelText("Passphrase"));

      await user.click(screen.getByRole("button", { name: "Unlock" }));
      expect(document.activeElement).toBe(screen.getByLabelText("Passphrase"));
    });

    it("is taken back from anything else on the page", async () => {
      // The shell draws more than the lock, and any of it could take focus
      // under the sheet.
      render(
        <>
          <input aria-label="Elsewhere" />
          <Lock
            checking={false}
            locked
            onUnlock={() => undefined}
            refusals={0}
            screen={SCREEN}
          />
        </>,
        { wrapper: OnOneScreen },
      );

      screen.getByLabelText("Elsewhere").focus();
      await nextTask();

      expect(document.activeElement).toBe(screen.getByLabelText("Passphrase"));
    });

    it("is taken back only once the focus change has finished", () => {
      // Focusing the field from inside the change re-enters it. A <webview>'s
      // page then takes the focus after the field does, and the field holds
      // the keys but is not drawn focused.
      render(
        <>
          <input aria-label="Elsewhere" />
          <Lock
            checking={false}
            locked
            onUnlock={() => undefined}
            refusals={0}
            screen={SCREEN}
          />
        </>,
        { wrapper: OnOneScreen },
      );

      screen.getByLabelText("Elsewhere").focus();

      expect(document.activeElement).toBe(screen.getByLabelText("Elsewhere"));
    });

    it("types into the field when focus has gone nowhere", async () => {
      // Focus falls to the page's body when what held it goes away.
      const { field, user } = lock();

      field().blur();
      await user.keyboard("hunter2");

      expect(field().value).toBe("hunter2");
    });

    it("comes back to the field after the bar is used", async () => {
      // A slider takes focus on a click, and the next key typed would move it.
      render(
        <Lock
          bar={() => <Slider label="Brightness" max={100} min={0} value={50} />}
          checking={false}
          locked
          onUnlock={() => undefined}
          refusals={0}
          screen={SCREEN}
        />,
        { wrapper: OnOneScreen },
      );
      const user = userEvent.setup();

      await user.click(screen.getByRole("slider", { name: "Brightness" }));

      expect(document.activeElement).toBe(screen.getByLabelText("Passphrase"));
    });

    it("stays in a panel the bar opens", async () => {
      // Taking it back to the field would close the panel.
      render(
        <Lock
          bar={() => (
            <Popover trigger={<button type="button">Brightness</button>}>
              <Slider label="Level" max={100} min={0} value={50} />
            </Popover>
          )}
          checking={false}
          locked
          onUnlock={() => undefined}
          refusals={0}
          screen={SCREEN}
        />,
        { wrapper: OnOneScreen },
      );
      const user = userEvent.setup();

      await user.click(screen.getByRole("button", { name: "Brightness" }));
      await user.click(screen.getByRole("slider", { name: "Level" }));

      expect(document.activeElement).toBe(
        screen.getByRole("slider", { name: "Level" }),
      );
    });
  });

  it("offers what was typed and never decides anything itself", async () => {
    // The component only submits the passphrase. The compositor's unlock clears
    // it; clearing on submit would let Enter alone appear to unlock.
    const { offered, user } = lock();

    await user.type(screen.getByLabelText("Passphrase"), "open sesame{Enter}");

    expect(offered).toStrictEqual(["open sesame"]);
    expect(screen.getByLabelText("Passphrase")).toBeTruthy();
  });

  it("keeps the passphrase out of the document", () => {
    // The passphrase must not be readable on screen.
    lock();

    expect(screen.getByLabelText("Passphrase").getAttribute("type")).toBe(
      "password",
    );
  });

  describe("a passphrase being checked", () => {
    it("stays in the field, and is not offered twice", async () => {
      // Kept until the compositor answers, so the user can see what they sent.
      const { field, offered, says, user } = lock();
      await user.type(field(), "open sesame{Enter}");

      says({ checking: true });
      await user.type(field(), "{Enter}");

      expect(field().value).toBe("open sesame");
      expect(offered).toStrictEqual(["open sesame"]);
    });

    it("is cleared once it is refused, and the refusal said", async () => {
      // Only a refusal clears the field, so a wrong guess is not left on
      // screen.
      const { field, says, user } = lock();
      await user.type(field(), "wrong{Enter}");
      says({ checking: true });

      says({ refusals: 1 });

      expect(field().value).toBe("");
      expect(screen.getByRole("alert").textContent).toBe("Wrong passphrase");
    });

    it("stops saying it was wrong once somebody types again", async () => {
      const { field, says, user } = lock();
      says({ refusals: 1 });

      await user.type(field(), "x");

      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("says the compositor could not check it", () => {
      // A broken PAM setup is not a typo; retyping will not help.
      const { says } = lock();

      says({
        refusals: 1,
        refused: {
          refusal: UnlockRefusal.Unverifiable,
          retryAt: NOW,
        },
      });

      expect(screen.getByRole("alert").textContent).toBe(
        "This desktop could not check the passphrase",
      );
    });

    it("counts down the wait after too many wrong ones", async () => {
      // Shown while typing too, since a passphrase sent now is not checked.
      const { field, says, user } = lock();
      says({
        refusals: 4,
        refused: {
          refusal: UnlockRefusal.WrongPassphrase,
          retryAt: NOW + 4500,
        },
      });

      await user.type(field(), "x");

      expect(screen.getByRole("alert").textContent).toBe(
        "Wrong passphrase. Try again in 5 s",
      );
    });

    it("says it came too soon, and is not offered until the wait ends", async () => {
      const { field, offered, says, user } = lock();
      says({
        refusals: 1,
        refused: {
          refusal: UnlockRefusal.TooSoon,
          retryAt: NOW + 20_000,
        },
      });

      await user.type(field(), "open sesame{Enter}");

      expect(screen.getByRole("alert").textContent).toBe(
        "Too many tries. Try again in 20 s",
      );
      expect(offered).toStrictEqual([]);
    });

    it("is cleared once the desk opens", async () => {
      // The sheet stays mounted to fade out, so the passphrase must not stay in
      // it.
      const { field, says, user } = lock();
      await user.type(field(), "open sesame{Enter}");

      says({ locked: false });

      expect(field().value).toBe("");
    });
  });
});

/** A desk of two monitors of different sizes, which leaves gaps in the page. */
const OnTwoScreens = ({ children }: PropsWithChildren) => (
  <DisplayProvider
    source={{
      displays: [
        { name: "left", position: [0, 0], scale: 1, size: [1920, 1080] },
        { name: "right", position: [1920, 120], scale: 2, size: [2560, 1440] },
      ],
      onDisplays: () => () => undefined,
    }}
  >
    {children}
  </DisplayProvider>
);

/** Waits for the timers due now, such as a deferred focus, to run. */
const nextTask = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve);
  });
