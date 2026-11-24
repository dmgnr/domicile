import { describe, expect, it } from "bun:test";
import type { Extension } from "@domicile-desktop/sdk/extension";
import { FakeDomicileHost } from "@domicile-desktop/sdk/fake-host";
import { act, renderHook } from "@testing-library/react";

import { useOpenedPopup } from "./useOpenedPopup";

const ID = "abcdefghijklmnopabcdefghijklmnop";
const POPUP = `chrome-extension://${ID}/popup.html`;

/** An action that names no popup: its click fires `action.onClicked`. */
const wallet: Extension = {
  badgeColor: "#00000000",
  badgeText: "",
  enabled: true,
  icon: "data:image/png;base64,iVBORw0KGgo=",
  id: ID,
  name: "Wallet",
  popup: undefined,
  profile: "default",
  title: "Wallet",
};

/** The hook over a fake host, on a desk whose focused screen is `DP-1`. */
const opening = (extensions: readonly Extension[] = [wallet]) => {
  const fake = new FakeDomicileHost();
  const hook = renderHook(
    ({ shown }) => useOpenedPopup(fake.domicile, shown, "DP-1"),
    { initialProps: { shown: extensions } },
  );
  return { fake, hook };
};

describe("useOpenedPopup", () => {
  it("opens a clicked action's popup on its bar's screen", () => {
    const { hook } = opening();

    act(() => {
      hook.result.current.open("HDMI-1", {
        id: ID,
        popup: POPUP,
        profile: "default",
      });
    });

    expect(hook.result.current.opened).toStrictEqual({
      id: ID,
      popup: POPUP,
      profile: "default",
      screen: "HDMI-1",
    });
  });

  it("closes the popup only from the bar it is on", () => {
    const { hook } = opening();
    act(() => {
      hook.result.current.open("HDMI-1", {
        id: ID,
        popup: POPUP,
        profile: "default",
      });
    });

    act(() => {
      hook.result.current.open("DP-1", undefined);
    });
    expect(hook.result.current.opened?.screen).toBe("HDMI-1");

    act(() => {
      hook.result.current.open("HDMI-1", undefined);
    });
    expect(hook.result.current.opened).toBeUndefined();
  });

  it("opens the popup an extension asks for on the focused screen", () => {
    // Phantom's tray click: its action names no popup, so the click reaches
    // `action.onClicked`, which calls `action.openPopup()`.
    const { fake, hook } = opening();

    act(() => {
      fake.dispatch("extensionpopuprequested", {
        extensionId: ID,
        popup: POPUP,
        profile: "default",
      });
    });

    expect(hook.result.current.opened).toStrictEqual({
      id: ID,
      popup: POPUP,
      profile: "default",
      screen: "DP-1",
    });
  });

  it("opens the popup an extension asks for on the bar its action was clicked on", () => {
    // Docked, the clicked tray is often not on the focused screen.
    const { fake, hook } = opening();

    act(() => {
      hook.result.current.clicked("HDMI-1", ID);
    });
    act(() => {
      fake.dispatch("extensionpopuprequested", {
        extensionId: ID,
        popup: POPUP,
        profile: "default",
      });
    });

    expect(hook.result.current.opened?.screen).toBe("HDMI-1");
  });

  it("opens a popup asked for after another action's click on the focused screen", () => {
    const { fake, hook } = opening();

    act(() => {
      hook.result.current.clicked("HDMI-1", "ponmlkjihgfedcbaponmlkjihgfedcba");
    });
    act(() => {
      fake.dispatch("extensionpopuprequested", {
        extensionId: ID,
        popup: POPUP,
        profile: "default",
      });
    });

    expect(hook.result.current.opened?.screen).toBe("DP-1");
  });

  it("closes the popup when its action leaves the tray", () => {
    const { hook } = opening();
    act(() => {
      hook.result.current.open("DP-1", {
        id: ID,
        popup: POPUP,
        profile: "default",
      });
    });

    hook.rerender({ shown: [{ ...wallet, enabled: false }] });

    expect(hook.result.current.opened).toBeUndefined();
  });
});
