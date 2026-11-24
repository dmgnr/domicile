import { describe, expect, it } from "bun:test";
import { ConnectionSafety } from "@domicile-desktop/manganese-address/connection-safety";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { css } from "../../styled-system/css";
import { AddressBar } from "./AddressBar";
import type { PageHistoryChoice } from "./page-history";

/** Shared props; each case overrides what it tests. */
const BAR = {
  address: "https://example.com",
  canGoBack: false,
  canGoForward: false,
  history: undefined,
  holdZoom: false,
  isPrivate: false,
  loading: false,
  loadProgress: 0,
  onBack: () => undefined,
  onBackInNewWindow: () => undefined,
  onForward: () => undefined,
  onForwardInNewWindow: () => undefined,
  onNavigate: () => undefined,
  onReload: () => undefined,
  onSetSitePermission: () => undefined,
  onShowAllHistory: () => undefined,
  onStop: () => undefined,
  onZoomIn: () => undefined,
  onZoomOut: () => undefined,
  onZoomReset: () => undefined,
  permissionRequest: undefined,
  security: ConnectionSafety.Secure,
  sitePermissions: [],
  visited: ["https://example.com"],
  zoom: 1,
} as const;

const address = (): HTMLInputElement =>
  screen.getByRole("combobox", { name: "Address" });

const control = (name: string): HTMLElement =>
  screen.getByRole("button", { name });

/** A middle click, which arrives as `auxclick`, not `click`. */
const middleClick = (): MouseEvent =>
  new MouseEvent("auxclick", { bubbles: true, button: 1 });

describe("AddressBar", () => {
  it("shuts its lock when a page turns out to be secure", () => {
    const { rerender } = render(
      <AddressBar {...BAR} security={ConnectionSafety.Unstated} />,
    );
    expect(document.querySelector("[data-part=shackle]")).toBeNull();
    rerender(<AddressBar {...BAR} />);

    expect(document.querySelector("[data-part=shackle]")).not.toBeNull();
  });

  it("shows where the window was sent", () => {
    render(<AddressBar {...BAR} />);

    expect(address()).toHaveValue("https://example.com");
  });

  // The open tab above is the same color, so the two read as one piece of
  // chrome.
  it("is the same surface as the open tab above", () => {
    render(<AddressBar {...BAR} />);

    expect(address().closest("form")?.className).toContain(
      css({ backgroundColor: "chrome" }),
    );
  });

  describe("a private window", () => {
    it("says it is private beside the address", () => {
      render(<AddressBar {...BAR} isPrivate />);

      expect(screen.getByText("Private")).toBeInTheDocument();
    });

    it("says nothing of the kind for an ordinary window", () => {
      render(<AddressBar {...BAR} />);

      expect(screen.queryByText("Private")).toBeNull();
    });
  });

  describe("the profile button", () => {
    const PROFILES = [
      {
        color: "#0d9488",
        configSites: [],
        enabledExtensions: [],
        extensions: [],
        id: "personal",
        isDefault: true,
        isDefaultPrivate: false,
        isPrivate: false,
        lockedExtensions: [],
        name: "Personal",
        pinnedSites: [],
      },
      {
        color: "#d97706",
        configSites: [],
        enabledExtensions: [],
        extensions: [],
        id: "work",
        isDefault: false,
        isDefaultPrivate: false,
        isPrivate: false,
        lockedExtensions: [],
        name: "Work",
        pinnedSites: [],
      },
    ] as const;

    const withProfiles = (
      calls: string[],
      pinned?: { locked: boolean; profile: string; site: string },
      extensions?: readonly {
        enabled: boolean;
        icon: string;
        id: string;
        locked: boolean;
        name: string;
      }[],
    ) => ({
      extensions,
      onMove: (id: string) => {
        calls.push(`move ${id}`);
      },
      onOpenInNew: (id: string) => {
        calls.push(`open ${id}`);
      },
      onPin: (id: string) => {
        calls.push(`pin ${id}`);
      },
      onSwitchExtension: (id: string, on: boolean) => {
        calls.push(`switch ${id} ${on ? "on" : "off"}`);
      },
      pinned,
      profile: PROFILES[1],
      profiles: PROFILES,
    });

    it("names the page's profile, private or not", () => {
      render(<AddressBar {...BAR} isPrivate profile={withProfiles([])} />);

      expect(control("Browser profile: Work")).toBeInTheDocument();
      expect(screen.queryByText("Private")).toBeNull();
    });

    it("moves the page to another profile", async () => {
      const calls: string[] = [];
      render(<AddressBar {...BAR} profile={withProfiles(calls)} />);

      await userEvent.click(control("Browser profile: Work"));
      await userEvent.click(control("Move this page to Personal"));

      expect(calls).toStrictEqual(["move personal"]);
    });

    it("leaves the page where it is for its own profile", async () => {
      const calls: string[] = [];
      render(<AddressBar {...BAR} profile={withProfiles(calls)} />);

      await userEvent.click(control("Browser profile: Work"));
      await userEvent.click(control("Work, this page's profile"));

      expect(calls).toStrictEqual([]);
    });

    it("opens the page in a new window of a profile", async () => {
      const calls: string[] = [];
      render(<AddressBar {...BAR} profile={withProfiles(calls)} />);

      await userEvent.click(control("Browser profile: Work"));
      await userEvent.click(control("Open in a new Personal window"));

      expect(calls).toStrictEqual(["open personal"]);
    });

    it("opens the page in a new window of a profile Ctrl+clicked", async () => {
      const calls: string[] = [];
      render(<AddressBar {...BAR} profile={withProfiles(calls)} />);

      await userEvent.click(control("Browser profile: Work"));
      fireEvent.click(control("Move this page to Personal"), { ctrlKey: true });

      expect(calls).toStrictEqual(["open personal"]);
    });

    it("pins the page's site to a profile", async () => {
      const calls: string[] = [];
      render(
        <AddressBar
          {...BAR}
          profile={withProfiles(calls, {
            locked: false,
            profile: "work",
            site: "github.com/acme",
          })}
        />,
      );

      await userEvent.click(control("Browser profile: Work"));
      expect(
        control("github.com/acme opens in Work by default"),
      ).toHaveAttribute("aria-pressed", "true");
      expect(
        screen.getByText("github.com/acme is pinned to Work."),
      ).toBeVisible();
      await userEvent.click(
        control("Open github.com/acme in Personal by default"),
      );

      expect(calls).toStrictEqual(["pin personal"]);
    });

    it("says a site with no pin opens in the default profile", async () => {
      render(
        <AddressBar
          {...BAR}
          profile={withProfiles([], {
            locked: false,
            profile: "personal",
            site: "news.example",
          })}
        />,
      );

      await userEvent.click(control("Browser profile: Work"));

      expect(
        screen.getByText(
          "news.example opens in Personal, your default profile.",
        ),
      ).toBeVisible();
    });

    it("offers no pins for a site the config pins", async () => {
      render(
        <AddressBar
          {...BAR}
          profile={withProfiles([], {
            locked: true,
            profile: "work",
            site: "*.acme.com",
          })}
        />,
      );

      await userEvent.click(control("Browser profile: Work"));

      expect(
        screen.getByText("Your config opens *.acme.com in Work."),
      ).toBeVisible();
      expect(screen.queryByRole("button", { name: /by default$/ })).toBeNull();
    });

    it("switches the profile's extensions, but not those the config switches", async () => {
      const calls: string[] = [];
      const icon = "data:image/png;base64,";
      render(
        <AddressBar
          {...BAR}
          profile={withProfiles(calls, undefined, [
            { enabled: false, icon, id: "b", locked: false, name: "Bitwarden" },
            { enabled: true, icon, id: "o", locked: true, name: "1Password" },
          ])}
        />,
      );

      await userEvent.click(control("Browser profile: Work"));
      expect(screen.getByText("Extensions in Work")).toBeVisible();
      expect(screen.getByRole("switch", { name: "1Password" })).toHaveAttribute(
        "aria-disabled",
        "true",
      );
      expect(
        screen.getByRole("img", { name: "Set in your config" }),
      ).toBeVisible();
      await userEvent.click(screen.getByRole("switch", { name: "Bitwarden" }));

      expect(calls).toStrictEqual(["switch b on"]);
    });

    it("offers no pins for a page that is no web site", async () => {
      render(<AddressBar {...BAR} profile={withProfiles([])} />);

      await userEvent.click(control("Browser profile: Work"));

      expect(screen.queryByRole("button", { name: /by default$/ })).toBeNull();
    });
  });

  it("puts the site permissions just after the connection", () => {
    render(<AddressBar {...BAR} />);

    const buttons = screen.getAllByRole("button");
    const connection = buttons.indexOf(
      screen.getByRole("button", { name: /^Connection/ }),
    );

    expect(buttons[connection + 1]).toBe(control("Site permissions"));
  });

  // One button for Reload and Stop, since only one applies at a time.
  describe("the reload button", () => {
    it("reloads the page while nothing is arriving", async () => {
      const calls: string[] = [];
      render(
        <AddressBar
          {...BAR}
          onReload={() => {
            calls.push("reload");
          }}
        />,
      );

      await userEvent.click(control("Reload"));

      expect(calls).toStrictEqual(["reload"]);
      expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    });

    it("becomes a stop button while a page is arriving", async () => {
      const calls: string[] = [];
      render(
        <AddressBar
          {...BAR}
          loading
          onStop={() => {
            calls.push("stop");
          }}
        />,
      );

      await userEvent.click(control("Stop"));

      expect(calls).toStrictEqual(["stop"]);
      expect(screen.queryByRole("button", { name: "Reload" })).toBeNull();
    });

    it("spins its arrow into the X, in the same drawing, as a page starts arriving", () => {
      const { rerender } = render(<AddressBar {...BAR} />);
      const svg = control("Reload").querySelector("svg");
      rerender(<AddressBar {...BAR} loading />);

      expect(control("Stop").querySelector("svg")).toBe(svg);
      expect(
        control("Stop").querySelector("[data-part=arrow]"),
      ).toHaveAttribute("data-state", "hidden");
    });
  });

  describe("the loading bar", () => {
    it("says how far a page that is arriving has loaded", () => {
      render(<AddressBar {...BAR} loading loadProgress={0.4} />);

      expect(
        screen.getByRole("progressbar", { name: "Loading" }),
      ).toHaveAttribute("aria-valuenow", "40");
    });

    it("is gone once the page has arrived", () => {
      render(<AddressBar {...BAR} />);

      expect(screen.queryByRole("progressbar")).toBeNull();
    });
  });

  // A button that would do nothing is disabled.
  describe("the history controls", () => {
    it("grays out what the history cannot reach", () => {
      render(<AddressBar {...BAR} />);

      expect(control("Back")).toBeDisabled();
      expect(control("Forward")).toBeDisabled();
    });

    it("sends the page back and forward when it can", async () => {
      const calls: string[] = [];
      render(
        <AddressBar
          {...BAR}
          canGoBack
          canGoForward
          onBack={() => {
            calls.push("back");
          }}
          onForward={() => {
            calls.push("forward");
          }}
        />,
      );

      await userEvent.click(control("Back"));
      await userEvent.click(control("Forward"));

      expect(calls).toStrictEqual(["back", "forward"]);
    });

    // As a middle click on Chrome's back button opens a tab.
    it("goes back and forward in a new window on a middle click or a Ctrl+click", () => {
      const calls: string[] = [];
      render(
        <AddressBar
          {...BAR}
          canGoBack
          canGoForward
          onBack={() => {
            calls.push("back");
          }}
          onBackInNewWindow={() => {
            calls.push("back in a new window");
          }}
          onForward={() => {
            calls.push("forward");
          }}
          onForwardInNewWindow={() => {
            calls.push("forward in a new window");
          }}
        />,
      );

      fireEvent(control("Back"), middleClick());
      fireEvent.click(control("Forward"), { ctrlKey: true });

      expect(calls).toStrictEqual([
        "back in a new window",
        "forward in a new window",
      ]);
    });

    it("leaves a right click alone", () => {
      const calls: string[] = [];
      render(
        <AddressBar
          {...BAR}
          canGoBack
          onBackInNewWindow={() => {
            calls.push("back in a new window");
          }}
        />,
      );

      fireEvent(
        control("Back"),
        new MouseEvent("auxclick", { bubbles: true, button: 2 }),
      );

      expect(calls).toStrictEqual([]);
    });
  });

  // As Chrome's back and forward menus.
  describe("the history menus", () => {
    const entry = (id: number, title: string) => ({
      favicon: "",
      id,
      title,
      url: `https://example.com/${id}`,
    });

    /** A history with `back` behind the page and `forward` ahead of it. */
    const historyOf = (
      back: ReturnType<typeof entry>[],
      forward: ReturnType<typeof entry>[] = [],
      went: string[] = [],
    ): PageHistoryChoice => ({
      go: (id) => {
        went.push(`go ${id}`);
      },
      goInNewWindow: (id) => {
        went.push(`new window ${id}`);
      },
      list: () => Promise.resolve({ back, forward }),
    });

    const menuItems = async (): Promise<string[]> => {
      const menu = await screen.findByRole("menu", undefined, {
        timeout: 2000,
      });
      return within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent ?? "");
    };

    it("lists the pages behind on a right click on Back, nearest first", async () => {
      render(
        <AddressBar
          {...BAR}
          canGoBack
          history={historyOf([entry(2, "Two"), entry(1, "One")])}
        />,
      );

      fireEvent.contextMenu(control("Back"));

      expect(await menuItems()).toStrictEqual([
        "Two",
        "One",
        "Show full history",
      ]);
    });

    it("lists the pages ahead on a right click on Forward", async () => {
      render(
        <AddressBar
          {...BAR}
          canGoForward
          history={historyOf([entry(1, "One")], [entry(3, "Three")])}
        />,
      );

      fireEvent.contextMenu(control("Forward"));

      expect(await menuItems()).toStrictEqual(["Three", "Show full history"]);
    });

    it("opens on holding Back, without going back", async () => {
      const calls: string[] = [];
      render(
        <AddressBar
          {...BAR}
          canGoBack
          history={historyOf([entry(1, "One")])}
          onBack={() => {
            calls.push("back");
          }}
        />,
      );

      // Found first: the open menu hides the rest of the page from queries.
      const back = control("Back");
      fireEvent.pointerDown(back, { button: 0 });
      expect(await menuItems()).toStrictEqual(["One", "Show full history"]);
      fireEvent.pointerUp(back, { button: 0 });
      fireEvent.click(back, { detail: 1 });

      expect(calls).toStrictEqual([]);
    });

    // The release after a long press lands on the menu's backdrop, so no
    // click follows it to the button.
    it("still goes back from the keyboard after a long press", async () => {
      const calls: string[] = [];
      render(
        <AddressBar
          {...BAR}
          canGoBack
          history={historyOf([entry(1, "One")])}
          onBack={() => {
            calls.push("back");
          }}
        />,
      );
      const back = control("Back");
      fireEvent.pointerDown(back, { button: 0 });
      await menuItems();
      fireEvent.click(back, { detail: 0 });

      expect(calls).toStrictEqual(["back"]);
    });

    it("goes back on a slow click from an engine without history entries", async () => {
      const calls: string[] = [];
      render(
        <AddressBar
          {...BAR}
          canGoBack
          onBack={() => {
            calls.push("back");
          }}
        />,
      );
      const back = control("Back");
      fireEvent.pointerDown(back, { button: 0 });
      await new Promise((resolve) => {
        setTimeout(resolve, 600);
      });
      fireEvent.pointerUp(back, { button: 0 });
      fireEvent.click(back, { detail: 1 });

      expect(calls).toStrictEqual(["back"]);
    });

    it("lists at most twelve pages, as Chrome does", async () => {
      const back = Array.from({ length: 20 }, (_, index) =>
        entry(index, `Page ${index}`),
      );
      render(<AddressBar {...BAR} canGoBack history={historyOf(back)} />);

      fireEvent.contextMenu(control("Back"));

      expect(await menuItems()).toHaveLength(13);
    });

    it("goes to a picked page, or opens it in a new window on a middle click or a Ctrl+click", async () => {
      const went: string[] = [];
      render(
        <AddressBar
          {...BAR}
          canGoBack
          history={historyOf([entry(2, "Two"), entry(1, "One")], [], went)}
        />,
      );

      fireEvent.contextMenu(control("Back"));
      await menuItems();
      fireEvent(screen.getByRole("menuitem", { name: "Two" }), middleClick());
      fireEvent.contextMenu(control("Back"));
      await menuItems();
      fireEvent.click(screen.getByRole("menuitem", { name: "Two" }), {
        ctrlKey: true,
      });
      fireEvent.contextMenu(control("Back"));
      await menuItems();
      await userEvent.click(screen.getByRole("menuitem", { name: "One" }));

      expect(went).toStrictEqual(["new window 2", "new window 2", "go 1"]);
    });

    it("opens the History app from Show full history", async () => {
      const opened = new Promise<void>((resolve) => {
        render(
          <AddressBar
            {...BAR}
            canGoBack
            history={historyOf([entry(1, "One")])}
            onShowAllHistory={resolve}
          />,
        );
      });

      fireEvent.contextMenu(control("Back"));
      await menuItems();
      await userEvent.click(
        screen.getByRole("menuitem", { name: "Show full history" }),
      );

      await opened;
    });

    it("opens nothing from an engine without history entries", () => {
      render(<AddressBar {...BAR} canGoBack />);

      fireEvent.contextMenu(control("Back"));

      expect(screen.queryByRole("menu")).toBeNull();
    });
  });

  describe("what Enter does", () => {
    it("loads a bare host over https", async () => {
      const sent: string[] = [];
      render(
        <AddressBar
          {...BAR}
          onNavigate={(url) => {
            sent.push(url);
          }}
        />,
      );

      await userEvent.clear(address());
      await userEvent.type(address(), "docs.example.com{Enter}");

      expect(sent).toStrictEqual(["https://docs.example.com"]);
    });

    it("searches for a line that is not an address", async () => {
      const sent: string[] = [];
      render(
        <AddressBar
          {...BAR}
          onNavigate={(url) => {
            sent.push(url);
          }}
        />,
      );

      await userEvent.clear(address());
      await userEvent.type(address(), "how tall is a giraffe{Enter}");

      expect(sent).toStrictEqual([
        "https://google.com/search?q=how%20tall%20is%20a%20giraffe",
      ]);
    });

    it("does nothing at all on an empty line", async () => {
      const sent: string[] = [];
      render(
        <AddressBar
          {...BAR}
          onNavigate={(url) => {
            sent.push(url);
          }}
        />,
      );

      await userEvent.clear(address());
      await userEvent.type(address(), "{Enter}");

      expect(sent).toStrictEqual([]);
    });
  });

  describe("the suggestions", () => {
    it("offers where the window has been, and loads the one that is taken", async () => {
      const sent: string[] = [];
      render(
        <AddressBar
          {...BAR}
          onNavigate={(url) => {
            sent.push(url);
          }}
          visited={["https://example.com", "https://docs.example.com/guide"]}
        />,
      );

      await userEvent.clear(address());
      await userEvent.type(address(), "docs");
      await userEvent.click(
        await screen.findByText("https://docs.example.com/guide"),
      );

      expect(sent).toStrictEqual(["https://docs.example.com/guide"]);
    });
  });

  it("goes back to showing the address when the window is sent somewhere else", async () => {
    const { rerender } = render(<AddressBar {...BAR} />);
    await userEvent.clear(address());
    await userEvent.type(address(), "half a typed add");

    rerender(<AddressBar {...BAR} address="https://docs.example.com" />);

    expect(address()).toHaveValue("https://docs.example.com");
  });

  // The indicator uses the browser's security state, not the URL scheme: an
  // `https://` page with an invalid certificate is not secure.
  it("carries the browser's verdict on the page it is showing", () => {
    render(
      <AddressBar
        {...BAR}
        address="https://expired.example.com"
        security={ConnectionSafety.Dangerous}
      />,
    );

    expect(control("Connection is not private")).toBeVisible();
  });

  describe("the zoom controls", () => {
    it("drives the zoom with each of its three", async () => {
      const calls: string[] = [];
      render(
        <AddressBar
          {...BAR}
          onZoomIn={() => {
            calls.push("in");
          }}
          onZoomOut={() => {
            calls.push("out");
          }}
          onZoomReset={() => {
            calls.push("reset");
          }}
          zoom={1.25}
        />,
      );

      await userEvent.click(control("Zoom in"));
      await userEvent.click(control("Zoom out"));
      await userEvent.click(control("125%"));

      expect(calls).toStrictEqual(["in", "out", "reset"]);
    });

    it("stays out of the way at 100%", () => {
      render(<AddressBar {...BAR} zoom={1} />);

      expect(screen.queryByRole("group", { name: "Zoom" })).toBeNull();
    });

    it("stays at 100% while the zoom popup hangs from it", () => {
      render(<AddressBar {...BAR} holdZoom zoom={1} />);

      expect(screen.getByRole("group", { name: "Zoom" })).toBeInTheDocument();
    });

    it("grays out zooming past either end", () => {
      const { rerender } = render(<AddressBar {...BAR} zoom={5} />);
      expect(control("Zoom in")).toBeDisabled();

      rerender(<AddressBar {...BAR} zoom={0.25} />);
      expect(control("Zoom out")).toBeDisabled();
    });
  });
});
