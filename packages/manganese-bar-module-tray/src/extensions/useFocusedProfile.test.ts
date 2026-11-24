import { describe, expect, it } from "bun:test";
import type { BrowserProfile } from "@domicile-desktop/sdk/desktop/browser";
import type { Domicile } from "@domicile-desktop/sdk/desktop/desktop";
import { renderHook } from "@testing-library/react";

import { useFocusedProfile } from "./useFocusedProfile";

const profile = (id: string, isDefault = false) =>
  ({ id, isDefault, name: id }) as unknown as BrowserProfile;

/** A desktop with a default and a work profile, and one work page. */
const fakeDomicile = () => {
  const shown: string[] = [];
  const domicile = {
    browser: {
      on: () => () => undefined,
      profiles: [profile("default", true), profile("work")],
      windows: [{ id: "page", profile: "work" }],
    },
    extensions: {
      setProfile: (id: string) => {
        shown.push(id);
      },
    },
  } as unknown as Pick<Domicile, "browser" | "extensions">;
  return { domicile, shown };
};

describe("useFocusedProfile", () => {
  it("shows the default profile's extensions before a page is focused", () => {
    const { domicile, shown } = fakeDomicile();
    const hook = renderHook(() => useFocusedProfile(domicile, undefined));

    expect(hook.result.current?.id).toBe("default");
    expect(shown).toStrictEqual(["default"]);
  });

  it("shows the focused page's profile's extensions, once each time it changes", () => {
    const { domicile, shown } = fakeDomicile();
    const hook = renderHook(
      ({ focused }: { focused: string | undefined }) =>
        useFocusedProfile(domicile, focused),
      { initialProps: { focused: undefined as string | undefined } },
    );
    hook.rerender({ focused: "page" });
    hook.rerender({ focused: "page" });

    expect(hook.result.current?.id).toBe("work");
    expect(shown).toStrictEqual(["default", "work"]);
  });
});
