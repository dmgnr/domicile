import { describe, expect, it, setDefaultTimeout } from "bun:test";
import type { Options } from "@domicile-desktop/sdk/options";
import { defineOptions, option } from "@domicile-desktop/sdk/options";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { App } from "./App";
import { hostExtensions } from "./extensions";
import type { FakeHostState } from "./fake-host";
import { fakeHost } from "./fake-host";
import type { InstalledExtension, SettingsFiles } from "./host";

const CONFIG_PATH = "/home/me/.config/domicile/domicile.json";
const SHELL_PATH = "/home/me/.config/domicile/shell.ts";
const UBLOCK = "ddkjiahejlhfcafbddmgiahcphecmpfh";

// Each test drives the whole app through user-event. CI runs every turbo task
// at once, and under that load the first test, which pays the warm-up, and the
// Select tests pass bun's 5s default.
setDefaultTimeout(15_000);

const files = (
  config: Record<string, unknown>,
  writable = true,
  options: Options | undefined = undefined,
): SettingsFiles => ({
  config: {
    path: CONFIG_PATH,
    text: JSON.stringify(config),
    writable,
  },
  evaluated: undefined,
  options: options === undefined ? undefined : JSON.stringify(options),
  shell: {
    path: SHELL_PATH,
    text: "export const Shell = runManganese();\n",
    writable,
  },
});

const SITES = {
  defaults: {
    "automatic-downloads": "ask",
    camera: "ask",
    clipboard: "ask",
    "idle-detection": "ask",
    "local-fonts": "ask",
    location: "ask",
    microphone: "ask",
    midi: "ask",
    notifications: "allow",
    "window-management": "ask",
  },
  sites: [
    { origin: "https://meet.example", permission: "camera", setting: "allow" },
    {
      origin: "https://meet.example",
      permission: "microphone",
      setting: "allow",
    },
    {
      origin: "https://maps.example",
      permission: "location",
      setting: "block",
    },
    {
      origin: `chrome-extension://${UBLOCK}`,
      permission: "notifications",
      setting: "block",
    },
  ],
} as const satisfies FakeHostState["sites"];

const MEDIA = {
  cameras: [
    { id: "/dev/video0", name: "Integrated Camera" },
    { id: "/dev/video2", name: "USB Camera" },
  ],
  microphones: [{ id: "default", name: "Default" }],
} as const satisfies FakeHostState["media"];

const SITE_DATA = [
  { bytes: 2048, cookies: 0, host: "notes.example" },
  { bytes: 4_800_000_000, cookies: 3, host: "mail.example" },
] as const satisfies FakeHostState["siteData"];

const INSTALLED: InstalledExtension[] = [
  {
    description: "An efficient content blocker.",
    enabled: true,
    id: UBLOCK,
    name: "uBlock Origin Lite",
    optionsUrl: `chrome-extension://${UBLOCK}/dashboard.html`,
    settings: { file_access: false, private: false, site_access: "all_sites" },
    version: "2025.1",
  },
];

/** uBlock's row on the Extensions page. */
const ublock = async () =>
  within(await screen.findByRole("group", { name: "uBlock Origin Lite" }));

/** The app over a fake host with `config`, opened on `page`. */
const renderApp = async (
  page: string,
  {
    chosen = "/home/me/src/my-extension",
    config = {},
    configExtensions = [],
    options,
    refuse,
    writable = true,
  }: {
    /** The folder the picker returns; `null` for a canceled picker. */
    chosen?: string | null;
    config?: Record<string, unknown>;
    configExtensions?: string[];
    /** What the shell declares; none by default. */
    options?: Options;
    refuse?: string;
    writable?: boolean;
  } = {},
) => {
  const host = fakeHost({
    chosen: chosen ?? undefined,
    configExtensions,
    files: files(config, writable, options),
    installed: structuredClone(INSTALLED),
    media: structuredClone(MEDIA),
    refuse,
    siteData: structuredClone(SITE_DATA),
    sites: structuredClone(SITES),
  });
  const user = userEvent.setup();
  render(<App extensions={hostExtensions(host.host)} host={host.host} />);
  await user.click(await screen.findByRole("button", { name: page }));
  await screen.findByRole("heading", { level: 1, name: page });
  return { host, user };
};

/** The config the app last wrote. */
const written = (writes: { file: string; text: string }[]) => {
  const last = writes.at(-1);
  expect(last?.file).toBe("config");
  return JSON.parse(last?.text ?? "");
};

const choose = async (
  user: ReturnType<typeof userEvent.setup>,
  name: string,
  option: string,
) => {
  await user.click(screen.getByRole("combobox", { name }));
  await user.click(await screen.findByRole("option", { name: option }));
};

describe(App, () => {
  describe("the config", () => {
    it("writes a choice as soon as it is made, keeping the rest", async () => {
      const { host, user } = await renderApp("Appearance", {
        config: { idle: { blank_after_seconds: 60 }, shell: "./shell.ts" },
      });
      await choose(user, "Theme", "Light");
      await waitFor(() => {
        expect(written(host.writes)).toEqual({
          idle: { blank_after_seconds: 60 },
          shell: "./shell.ts",
          theme: { mode: "light" },
        });
      });
    });

    it("shows a read-only config's values and says why it cannot change", async () => {
      await renderApp("Appearance", {
        config: { theme: { mode: "light" } },
        writable: false,
      });
      expect(
        screen.getByText(
          `${CONFIG_PATH} is read-only. Change it where it is made, such as your home-manager config.`,
        ),
      ).toBeInTheDocument();
      const theme = screen.getByRole("combobox", { name: "Theme" });
      expect(theme).toHaveTextContent("Light");
      expect(theme).toBeDisabled();
    });

    it("says why the desktop refused a change", async () => {
      const { user } = await renderApp("Appearance", {
        refuse: "the compositor would refuse this: theme.mode",
      });
      await choose(user, "Theme", "Light");
      expect(
        await screen.findByText("the compositor would refuse this: theme.mode"),
      ).toBeInTheDocument();
    });

    it("shows an edit made elsewhere", async () => {
      const { host } = await renderApp("Appearance");
      host.state.files = files({ theme: { mode: "light" } });
      host.change();
      await waitFor(() => {
        expect(
          screen.getByRole("combobox", { name: "Theme" }),
        ).toHaveTextContent("Light");
      });
    });
  });

  describe("pages", () => {
    it("sets the keyboard layout when the field is left", async () => {
      const { host, user } = await renderApp("Keyboard");
      const layout = screen.getByRole("textbox", { name: "Layout" });
      await user.clear(layout);
      await user.type(layout, "de");
      await user.tab();
      await waitFor(() => {
        expect(written(host.writes).input.keyboard.xkb_layout).toBe("de");
      });
    });

    it("adds an xkb option", async () => {
      const { host, user } = await renderApp("Keyboard");
      await user.type(
        screen.getByRole("textbox", { name: "Add an option" }),
        "caps:escape",
      );
      await user.click(screen.getByRole("button", { name: "Add option" }));
      await waitFor(() => {
        expect(written(host.writes).input.keyboard.xkb_options).toEqual([
          "caps:escape",
        ]);
      });
    });

    describe("keymaps", () => {
      /** A keyboard that switches between dvp and us. */
      const TWO = {
        input: {
          keyboard: {
            keymaps: [{ name: "dvp", xkb_variant: "dvp" }, { name: "us" }],
          },
        },
      };

      it("adds a keymap to switch to, keeping the keyboard's as the first", async () => {
        const { host, user } = await renderApp("Keyboard", {
          config: { input: { keyboard: { xkb_variant: "dvp" } } },
        });
        await user.type(
          screen.getByRole("textbox", { name: "New keymap name" }),
          "us",
        );
        await user.click(screen.getByRole("button", { name: "Add keymap" }));
        await waitFor(() => {
          expect(written(host.writes).input.keyboard).toEqual(
            TWO.input.keyboard,
          );
        });
      });

      it("refuses a keymap name the keyboard already has", async () => {
        const { host, user } = await renderApp("Keyboard", { config: TWO });
        await user.type(
          screen.getByRole("textbox", { name: "New keymap name" }),
          "us",
        );
        await user.click(screen.getByRole("button", { name: "Add keymap" }));
        expect(
          await screen.findByText("A keymap is already named us"),
        ).toBeVisible();
        expect(host.writes).toEqual([]);
      });

      it("sets a keymap's layout", async () => {
        const { host, user } = await renderApp("Keyboard", { config: TWO });
        const layout = screen.getByRole("textbox", { name: "us layout" });
        await user.clear(layout);
        await user.type(layout, "de");
        await user.tab();
        await waitFor(() => {
          expect(written(host.writes).input.keyboard.keymaps[1]).toEqual({
            name: "us",
            xkb_layout: "de",
          });
        });
      });

      it("renames a keymap", async () => {
        const { host, user } = await renderApp("Keyboard", { config: TWO });
        const name = screen.getByRole("textbox", { name: "us name" });
        await user.clear(name);
        await user.type(name, "qwerty");
        await user.tab();
        await waitFor(() => {
          expect(written(host.writes).input.keyboard.keymaps[1]).toEqual({
            name: "qwerty",
          });
        });
      });

      it("moves a keymap first, which makes it the one the desktop starts on", async () => {
        const { host, user } = await renderApp("Keyboard", { config: TWO });
        await user.click(screen.getByRole("button", { name: "Move us up" }));
        await waitFor(() => {
          expect(written(host.writes).input.keyboard.keymaps).toEqual([
            { name: "us" },
            { name: "dvp", xkb_variant: "dvp" },
          ]);
        });
      });

      it("goes back to one keyboard when one keymap is left", async () => {
        const { host, user } = await renderApp("Keyboard", { config: TWO });
        await user.click(screen.getByRole("button", { name: "Remove us" }));
        await waitFor(() => {
          expect(written(host.writes).input.keyboard).toEqual({
            xkb_variant: "dvp",
          });
        });
      });
    });

    it("blanks the screens after a time, and never once it is cleared", async () => {
      const { host, user } = await renderApp("Power & lock", {
        config: { idle: { blank_after_seconds: 300 } },
      });
      const after = screen.getByRole("textbox", {
        name: "Blank the screens after (seconds)",
      });
      await user.clear(after);
      await user.tab();
      await waitFor(() => {
        expect(written(host.writes)).toEqual({});
      });
    });

    it("locks after a time of its own, and never once it is cleared", async () => {
      const { host, user } = await renderApp("Power & lock", {
        config: { idle: { blank_after_seconds: 300 } },
      });
      const after = screen.getByRole("textbox", {
        name: "Lock after (seconds)",
      });
      await user.type(after, "900");
      await user.tab();
      await waitFor(() => {
        expect(written(host.writes).idle).toEqual({
          blank_after_seconds: 300,
          lock_after_seconds: 900,
        });
      });
      await user.clear(after);
      await user.tab();
      await waitFor(() => {
        expect(written(host.writes).idle).toEqual({ blank_after_seconds: 300 });
      });
    });

    it("unlocks through another PAM service", async () => {
      const { host, user } = await renderApp("Power & lock");
      await user.type(
        screen.getByRole("textbox", { name: "PAM service" }),
        "login",
      );
      await user.tab();
      await waitFor(() => {
        expect(written(host.writes).lock).toEqual({ pam_service: "login" });
      });
    });

    it("unlocks through domicile once the service is cleared", async () => {
      const { host, user } = await renderApp("Power & lock", {
        config: { lock: { pam_service: "login" } },
      });
      await user.clear(screen.getByRole("textbox", { name: "PAM service" }));
      await user.tab();
      await waitFor(() => {
        expect(written(host.writes)).toEqual({});
      });
    });

    it("asks apps not to use the camera", async () => {
      const { host, user } = await renderApp("Privacy");
      await user.click(
        screen.getByRole("switch", { name: "Ask apps not to use the camera" }),
      );
      await waitFor(() => {
        expect(written(host.writes).lockdown).toEqual({ disable_camera: true });
      });
    });

    it("lists what the file search leaves out, starting from the default", async () => {
      const { host, user } = await renderApp("Launcher");
      await user.type(
        screen.getByRole("textbox", { name: "Add a pattern" }),
        "Downloads",
      );
      await user.click(screen.getByRole("button", { name: "Add pattern" }));
      await waitFor(() => {
        expect(written(host.writes).files.omit).toEqual(["**/.*", "Downloads"]);
      });
    });

    it("edits a startup command as one line", async () => {
      const { host, user } = await renderApp("Startup", {
        config: { startup: { commands: [["emacs", "--daemon"]] } },
      });
      const command = screen.getByRole("textbox", { name: "Command 1" });
      expect(command).toHaveValue("emacs --daemon");
      await user.clear(command);
      await user.type(command, `sh -c "sleep 1; mako"`);
      await user.tab();
      await waitFor(() => {
        expect(written(host.writes).startup.commands).toEqual([
          ["sh", "-c", "sleep 1; mako"],
        ]);
      });
    });

    it("sets the scale of a display in a profile", async () => {
      const { host, user } = await renderApp("Displays", {
        config: {
          output: {
            profiles: [{ displays: [{ display: "drm-1" }], name: "laptop" }],
          },
        },
      });
      const scale = screen.getByRole("textbox", { name: "drm-1 scale" });
      await user.clear(scale);
      await user.type(scale, "1.5");
      await user.tab();
      await waitFor(() => {
        expect(written(host.writes).output.profiles).toEqual([
          { displays: [{ display: "drm-1", scale: 1.5 }], name: "laptop" },
        ]);
      });
    });

    it("turns on HDR for a display in a profile", async () => {
      const { host, user } = await renderApp("Displays", {
        config: {
          output: {
            profiles: [{ displays: [{ display: "drm-1" }], name: "laptop" }],
          },
        },
      });
      expect(
        screen.queryByRole("textbox", { name: "drm-1 everyday brightness" }),
      ).toBeNull();
      await user.click(screen.getByRole("switch", { name: "drm-1 HDR" }));
      await waitFor(() => {
        expect(written(host.writes).output.profiles).toEqual([
          { displays: [{ display: "drm-1", hdr: true }], name: "laptop" },
        ]);
      });
    });

    it("sets how bright everyday content is on a display in HDR", async () => {
      const { host, user } = await renderApp("Displays", {
        config: {
          output: {
            profiles: [
              { displays: [{ display: "drm-1", hdr: true }], name: "laptop" },
            ],
          },
        },
      });
      const white = screen.getByRole("textbox", {
        name: "drm-1 everyday brightness",
      });
      expect(white).toHaveValue("203");
      await user.clear(white);
      await user.type(white, "250");
      await user.tab();
      await waitFor(() => {
        expect(written(host.writes).output.profiles).toEqual([
          {
            displays: [{ display: "drm-1", hdr: true, sdr_white: 250 }],
            name: "laptop",
          },
        ]);
      });
    });

    it("writes a profile monitor's position at the origin", async () => {
      // A profile monitor with no position goes right of the others, so
      // `[0, 0]` has to be written out.
      const { host, user } = await renderApp("Displays", {
        config: {
          output: {
            profiles: [{ displays: [{ display: "drm-1" }], name: "laptop" }],
          },
        },
      });
      const x = screen.getByRole("textbox", { name: "drm-1 x" });
      expect(x).toHaveValue("");
      await user.type(x, "0");
      await user.tab();
      await waitFor(() => {
        expect(written(host.writes).output.profiles).toEqual([
          {
            displays: [{ display: "drm-1", position: [0, 0] }],
            name: "laptop",
          },
        ]);
      });
    });

    it("leaves a cleared profile monitor for the desktop to place", async () => {
      const { host, user } = await renderApp("Displays", {
        config: {
          output: {
            profiles: [
              {
                displays: [{ display: "drm-1", position: [1920, 0] }],
                name: "laptop",
              },
            ],
          },
        },
      });
      await user.clear(screen.getByRole("textbox", { name: "drm-1 x" }));
      await user.tab();
      await waitFor(() => {
        expect(written(host.writes).output.profiles).toEqual([
          { displays: [{ display: "drm-1" }], name: "laptop" },
        ]);
      });
    });
  });

  describe("the shell's options", () => {
    const OPTIONS = defineOptions({
      clock: {
        format: option.choice("Clock format", ["24h", "12h"], "24h"),
        seconds: option.toggle("Show seconds", true),
      },
      wallpaper: {
        minutes: option.number("Minutes per photo", 1, { max: 60, min: 1 }),
      },
    });

    it("shows each option the shell declares and writes a change under shell_options", async () => {
      const { host, user } = await renderApp("Shell", {
        config: { shell_options: { wallpaper: { minutes: 5 } } },
        options: OPTIONS,
      });
      expect(
        screen.getByRole("textbox", { name: "Minutes per photo" }),
      ).toHaveValue("5");
      await choose(user, "Clock format", "12h");
      await waitFor(() => {
        expect(written(host.writes).shell_options).toEqual({
          clock: { format: "12h" },
          wallpaper: { minutes: 5 },
        });
      });
    });

    it("titles a group's card in words", async () => {
      await renderApp("Shell", {
        options: defineOptions({
          nightLight: { warmth: option.number("Warmth", 50) },
        }),
      });
      expect(screen.getByText("Night light")).toBeVisible();
    });

    it("removes an option set back to its default", async () => {
      const { host, user } = await renderApp("Shell", {
        config: { shell_options: { clock: { seconds: false } } },
        options: OPTIONS,
      });
      await user.click(screen.getByRole("switch", { name: "Show seconds" }));
      await waitFor(() => {
        expect(written(host.writes)).toEqual({});
      });
    });

    it("refuses a number outside the option's limits", async () => {
      const { host, user } = await renderApp("Shell", { options: OPTIONS });
      const minutes = screen.getByRole("textbox", {
        name: "Minutes per photo",
      });
      await user.clear(minutes);
      await user.type(minutes, "90");
      await user.tab();
      expect(await screen.findByText("90 is above 60")).toBeVisible();
      expect(minutes).toHaveValue("1");
      expect(host.writes).toEqual([]);
    });

    it("says when the shell declares no options", async () => {
      await renderApp("Shell");
      expect(screen.getByText("This shell declares no options.")).toBeVisible();
    });
  });

  describe("extensions", () => {
    it("turns an extension off", async () => {
      const { host, user } = await renderApp("Extensions");
      await user.click(
        await screen.findByRole("switch", { name: "uBlock Origin Lite" }),
      );
      await waitFor(() => {
        expect(host.state.installed[0]?.enabled).toBe(false);
      });
    });

    it("says whether an extension is on beside its switch", async () => {
      const { user } = await renderApp("Extensions");
      const toggle = await screen.findByRole("switch", {
        name: "uBlock Origin Lite",
      });
      expect(toggle.closest("label")).toHaveTextContent("On");
      await user.click(toggle);
      await waitFor(() => {
        expect(toggle.closest("label")).toHaveTextContent("Off");
      });
    });

    it("opens an extension's options", async () => {
      const { host, user } = await renderApp("Extensions");
      await user.click(
        (await ublock()).getByRole("button", { name: "Options" }),
      );
      expect(host.opened).toEqual([
        `chrome-extension://${UBLOCK}/dashboard.html`,
      ]);
    });

    it("uninstalls an extension the config installed", async () => {
      const { host, user } = await renderApp("Extensions", {
        config: { extensions: { web_store: [UBLOCK] } },
      });
      await user.click(
        (await ublock()).getByRole("button", { name: "Uninstall" }),
      );
      await waitFor(() => {
        expect(written(host.writes)).toEqual({});
      });
    });

    it("shows an extension's settings only while it is on", async () => {
      const { user } = await renderApp("Extensions");
      const row = await ublock();
      expect(
        row.getByRole("switch", { name: "Allow in private windows" }),
      ).toBeVisible();
      await user.click(row.getByRole("switch", { name: "uBlock Origin Lite" }));
      await waitFor(() => {
        expect(
          row.queryByRole("switch", { name: "Allow in private windows" }),
        ).not.toBeInTheDocument();
      });
    });

    it("shows only the settings an extension can use", async () => {
      await renderApp("Extensions");
      const row = await ublock();
      expect(
        row.getByRole("switch", { name: "Allow on local files" }),
      ).toBeVisible();
      expect(
        row.queryByRole("switch", { name: "Allow user scripts" }),
      ).not.toBeInTheDocument();
    });

    it("allows an extension in private windows", async () => {
      const { host, user } = await renderApp("Extensions");
      await user.click(
        (await ublock()).getByRole("switch", {
          name: "Allow in private windows",
        }),
      );
      await waitFor(() => {
        expect(host.configured).toEqual([
          { id: UBLOCK, settings: { private: true } },
        ]);
      });
      expect(host.writes).toEqual([]);
    });

    it("changes a setting the config sets in the config", async () => {
      const { host, user } = await renderApp("Extensions", {
        config: { extensions: { settings: { [UBLOCK]: { private: true } } } },
      });
      const allowed = (await ublock()).getByRole("switch", {
        name: "Allow in private windows",
      });
      expect(allowed).toBeChecked();
      await user.click(allowed);
      await waitFor(() => {
        expect(written(host.writes)).toEqual({
          extensions: { settings: { [UBLOCK]: { private: false } } },
        });
      });
      expect(host.configured).toEqual([]);
    });

    it("leaves a setting a read-only config sets", async () => {
      await renderApp("Extensions", {
        config: { extensions: { settings: { [UBLOCK]: { private: true } } } },
        writable: false,
      });
      expect(
        (await ublock()).getByRole("switch", {
          name: "Allow in private windows",
        }),
      ).toHaveAttribute("aria-disabled", "true");
    });

    it("runs an extension only on the sites added to it", async () => {
      const { host, user } = await renderApp("Extensions");
      const row = await ublock();
      await user.click(row.getByRole("combobox", { name: "Site access" }));
      await user.click(
        await screen.findByRole("option", { name: "On specific sites" }),
      );
      expect(host.configured).toEqual([]);
      await user.type(
        row.getByRole("textbox", { name: "Add a site" }),
        "GitHub.com",
      );
      await user.click(row.getByRole("button", { name: "Add site" }));
      await waitFor(() => {
        expect(host.state.installed[0]?.settings.site_access).toEqual([
          "github.com",
        ]);
      });
      await user.click(
        await row.findByRole("button", { name: "Remove github.com" }),
      );
      await waitFor(() => {
        expect(host.configured.at(-1)).toEqual({
          id: UBLOCK,
          settings: { site_access: [] },
        });
      });
    });

    it("refuses a site Chrome cannot grant, and a site added twice", async () => {
      const { host, user } = await renderApp("Extensions", {
        config: {
          extensions: {
            settings: { [UBLOCK]: { site_access: ["github.com"] } },
          },
        },
      });
      const row = await ublock();
      const field = row.getByRole("textbox", { name: "Add a site" });
      await user.type(field, "https://gitlab.com");
      await user.click(row.getByRole("button", { name: "Add site" }));
      await user.clear(field);
      await user.type(field, "github.com");
      await user.click(row.getByRole("button", { name: "Add site" }));
      expect(
        await screen.findByText(/https:\/\/gitlab\.com is not a site/),
      ).toBeVisible();
      expect(host.writes).toEqual([]);
      expect(row.getAllByText("github.com")).toHaveLength(1);
    });

    it("reads a config that sets a setting to null as leaving it", async () => {
      await renderApp("Extensions", {
        config: { extensions: { settings: { [UBLOCK]: { private: null } } } },
        writable: false,
      });
      expect(
        (await ublock()).getByRole("switch", {
          name: "Allow in private windows",
        }),
      ).not.toHaveAttribute("aria-disabled", "true");
    });

    it("runs an extension when it is clicked", async () => {
      const { host, user } = await renderApp("Extensions");
      await choose(user, "Site access", "When you click it");
      await waitFor(() => {
        expect(host.configured).toEqual([
          { id: UBLOCK, settings: { site_access: "on_click" } },
        ]);
      });
    });
  });

  describe("unpacked and uninstalled through the engine", () => {
    it("loads the unpacked folder chosen in the desktop's picker", async () => {
      const { host, user } = await renderApp("Extensions", {
        writable: false,
      });
      await user.click(
        screen.getByRole("button", { name: "Load unpacked folder" }),
      );
      await waitFor(() => {
        expect(host.loaded).toEqual(["/home/me/src/my-extension"]);
      });
    });

    it("loads nothing when the picker is canceled", async () => {
      const { host, user } = await renderApp("Extensions", { chosen: null });
      await user.click(
        screen.getByRole("button", { name: "Load unpacked folder" }),
      );
      await waitFor(() => {
        expect(host.chosen).toEqual([undefined]);
      });
      expect(host.loaded).toEqual([]);
    });

    it("uninstalls an extension the config did not install", async () => {
      const { host, user } = await renderApp("Extensions");
      await user.click(
        (await ublock()).getByRole("button", { name: "Uninstall" }),
      );
      await waitFor(() => {
        expect(host.uninstalled).toEqual([UBLOCK]);
      });
    });

    it("leaves an extension a read-only config installed", async () => {
      await renderApp("Extensions", {
        config: { extensions: { web_store: [UBLOCK] } },
        configExtensions: [UBLOCK],
        writable: false,
      });
      expect(
        await screen.findByRole("switch", { name: "uBlock Origin Lite" }),
      ).toBeInTheDocument();
      expect(
        (await ublock()).queryByRole("button", { name: "Uninstall" }),
      ).not.toBeInTheDocument();
    });
  });

  describe("site permissions", () => {
    it("lists the sites with a permission and changes one", async () => {
      const { host, user } = await renderApp("Site permissions");
      await user.click(await screen.findByRole("button", { name: /^Camera/ }));
      await choose(user, "meet.example", "Block");
      await waitFor(() => {
        expect(host.state.sites.sites).toContainEqual({
          origin: "https://meet.example",
          permission: "camera",
          setting: "block",
        });
      });
    });

    it("names an extension by its name", async () => {
      const { user } = await renderApp("Site permissions");
      await user.click(
        await screen.findByRole("button", { name: /^Notifications/ }),
      );
      expect(
        await screen.findByRole("combobox", { name: "uBlock Origin Lite" }),
      ).toHaveTextContent("Block");
    });

    it("picks the camera a site gets when it names none", async () => {
      const { host, user } = await renderApp("Site permissions");
      await user.click(await screen.findByRole("button", { name: /^Camera/ }));
      expect(
        await screen.findByRole("combobox", { name: "Camera device" }),
      ).toHaveTextContent("Integrated Camera");
      await choose(user, "Camera device", "USB Camera");
      await waitFor(() => {
        expect(host.state.media.cameras[0]?.id).toBe("/dev/video2");
      });
    });

    it("lists each site's permissions", async () => {
      const { user } = await renderApp("Site permissions");
      await user.click(screen.getByRole("tab", { name: "By site" }));
      await user.click(
        await screen.findByRole("button", { name: /^meet\.example/ }),
      );
      const detail = await screen.findByRole("group", {
        name: "meet.example",
      });
      expect(
        within(detail).getByRole("combobox", { name: "Microphone" }),
      ).toHaveTextContent("Allow");
      expect(
        within(detail).getByRole("combobox", { name: "Notifications" }),
      ).toHaveTextContent("Allow");
    });

    it("removes a site's own settings", async () => {
      const { host, user } = await renderApp("Site permissions");
      await user.click(screen.getByRole("tab", { name: "By site" }));
      await user.click(
        await screen.findByRole("button", { name: /^meet\.example/ }),
      );
      await user.click(
        await screen.findByRole("button", { name: "Remove site" }),
      );
      await waitFor(() => {
        expect(host.state.sites.sites).toEqual([
          SITES.sites[2],
          SITES.sites[3],
        ]);
      });
      expect(
        await screen.findByRole("button", { name: /^maps\.example/ }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: /^meet\.example/ }),
      ).not.toBeInTheDocument();
    });
  });

  describe("site data", () => {
    it("lists each site's data, largest first", async () => {
      await renderApp("Site data");
      expect(await screen.findByText("4.8 GB · 3 cookies")).toBeInTheDocument();
      expect(screen.getByText("2 kB")).toBeInTheDocument();
      expect(
        screen
          .getAllByRole("button", { name: /^Remove / })
          .map((button) => button.getAttribute("aria-label")),
      ).toEqual(["Remove mail.example's data", "Remove notes.example's data"]);
    });

    it("finds a site by its name", async () => {
      const { user } = await renderApp("Site data");
      await user.type(
        await screen.findByRole("searchbox", { name: "Search sites" }),
        "notes",
      );
      expect(screen.getByText("notes.example")).toBeInTheDocument();
      expect(screen.queryByText("mail.example")).not.toBeInTheDocument();
      await user.type(screen.getByRole("searchbox"), "zzz");
      expect(
        screen.getByText("No site with data matches."),
      ).toBeInTheDocument();
    });

    it("removes a site's data once asked", async () => {
      const { host, user } = await renderApp("Site data");
      await user.click(
        await screen.findByRole("button", {
          name: "Remove mail.example's data",
        }),
      );
      const dialog = await screen.findByRole("dialog");
      await user.click(within(dialog).getByRole("button", { name: "Remove" }));
      await waitFor(() => {
        expect(host.state.siteData).toEqual([SITE_DATA[0]]);
      });
      await waitFor(() => {
        expect(screen.queryByText("mail.example")).not.toBeInTheDocument();
      });
    });
  });

  describe("code", () => {
    it("saves an edit to the shell", async () => {
      const { host, user } = await renderApp("Code");
      await user.click(screen.getByRole("tab", { name: "Shell" }));
      const editor = await screen.findByRole("textbox", { name: SHELL_PATH });
      await user.type(editor, "// mine");
      await user.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => {
        expect(host.writes.at(-1)).toEqual({
          file: "shell",
          text: "export const Shell = runManganese();\n// mine",
        });
      });
    });

    it("cannot edit a read-only file", async () => {
      await renderApp("Code", { writable: false });
      expect(
        screen.getByRole("textbox", { name: CONFIG_PATH }),
      ).toHaveAttribute("readonly");
      expect(
        screen.queryByRole("button", { name: "Save" }),
      ).not.toBeInTheDocument();
    });
  });
});
