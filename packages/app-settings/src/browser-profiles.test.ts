import { describe, expect, it } from "bun:test";

import type { BrowserConfig } from "./browser-profiles";
import {
  isProfileSite,
  profileIdFor,
  profileOrder,
  withDefault,
  withoutProfile,
  withProfileMoved,
  withSite,
} from "./browser-profiles";

const BROWSER: BrowserConfig = {
  default_private_profile: "private",
  default_profile: "personal",
  order: [],
  profiles: {
    personal: {
      color: "#0d9488",
      extensions: undefined,
      name: "Personal",
      private: false,
    },
    private: {
      color: "#a78bfa",
      extensions: undefined,
      name: "Private",
      private: true,
    },
    work: {
      color: "#d97706",
      extensions: undefined,
      name: "Work",
      private: false,
    },
  },
  sites: { "*.acme.com": "work" },
};

describe(isProfileSite, () => {
  it("takes a host, its subdomains, or a host and a path", () => {
    expect(isProfileSite("github.com")).toBe(true);
    expect(isProfileSite("*.github.com")).toBe(true);
    expect(isProfileSite("github.com/acme/api")).toBe(true);
  });

  it("refuses an empty path part and a host that is not one", () => {
    expect(isProfileSite("github.com//acme")).toBe(false);
    expect(isProfileSite("not a site")).toBe(false);
    expect(isProfileSite("*.github.com/acme/")).toBe(false);
  });
});

describe(profileIdFor, () => {
  it("spells a name as an id, numbering one that is taken", () => {
    expect(profileIdFor("Side Project!", [])).toBe("side-project");
    expect(profileIdFor("Work", ["work", "work-2"])).toBe("work-3");
    expect(profileIdFor("☕", [])).toBe("profile");
  });
});

describe(withDefault, () => {
  it("makes a private profile the default private one, keeping the sites", () => {
    expect(withDefault(BROWSER, "private")).toEqual({
      ...BROWSER,
      default_private_profile: "private",
    });
  });
});

describe(withoutProfile, () => {
  it("refuses the defaults", () => {
    expect(() => withoutProfile(BROWSER, "personal")).toThrow(
      "personal is a default profile, which can't be removed",
    );
  });

  it("takes the profile out of the order", () => {
    const browser = { ...BROWSER, order: ["work", "personal"] };
    expect(withoutProfile(browser, "work").order).toStrictEqual(["personal"]);
  });
});

describe(profileOrder, () => {
  it("lists the order's profiles, then the rest by id", () => {
    expect(profileOrder({ ...BROWSER, order: ["work"] })).toStrictEqual([
      "work",
      "personal",
      "private",
    ]);
  });
});

describe(withProfileMoved, () => {
  it("moves a profile and writes the whole order", () => {
    expect(withProfileMoved(BROWSER, "work", -1).order).toStrictEqual([
      "personal",
      "work",
      "private",
    ]);
  });

  it("stops at either end", () => {
    expect(withProfileMoved(BROWSER, "personal", -1).order).toStrictEqual([
      "personal",
      "private",
      "work",
    ]);
  });
});

describe(withSite, () => {
  it("unlists a site moved to the default profile", () => {
    expect(withSite(BROWSER, "*.acme.com", "personal").sites).toEqual({});
  });
});
