import { describe, expect, it, setDefaultTimeout } from "bun:test";
import type { Options } from "@domicile-desktop/sdk/options";
import { defineOptions, option } from "@domicile-desktop/sdk/options";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { App } from "./App";
import { hostExtensions } from "./extensions";
import type { FakeHostState } from "./fake-host";
import { fakeHost } from "./fake-host";
import type {
  BrowserProfiles,
  InstalledExtension,
  KnownAgents,
  Monitor,
  SettingsFiles,
  WebAgents,
} from "./host";

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
    icon: undefined,
    id: UBLOCK,
    name: "uBlock Origin Lite",
    optionsUrl: `chrome-extension://${UBLOCK}/dashboard.html`,
    settings: { file_access: false, site_access: "all_sites" },
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
    agents,
    chosen = "/home/me/src/my-extension",
    config = {},
    configExtensions = [],
    monitors,
    options,
    profiles,
    refuse,
    webAgents,
    writable = true,
  }: {
    /** Agents on the web; none by default. */
    webAgents?: WebAgents;
    /** The agents in now and remembered; none by default. */
    agents?: KnownAgents;
    /** The browser profiles the engine runs. */
    profiles?: BrowserProfiles;
    /** The folder the picker returns; `null` for a canceled picker. */
    chosen?: string | null;
    config?: Record<string, unknown>;
    configExtensions?: string[];
    /** The lit monitors; none by default. */
    monitors?: Monitor[];
    /** What the shell declares; none by default. */
    options?: Options;
    refuse?: string;
    writable?: boolean;
  } = {},
) => {
  const host = fakeHost({
    agents: structuredClone(agents),
    chosen: chosen ?? undefined,
    configExtensions,
    files: files(config, writable, options),
    installed: structuredClone(INSTALLED),
    media: structuredClone(MEDIA),
    monitors,
    profiles: structuredClone(profiles),
    refuse,
    siteData: structuredClone(SITE_DATA),
    sites: structuredClone(SITES),
    webAgents: structuredClone(webAgents),
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

/** The config's profiles, as the Profiles page tests start them. */
const BROWSER = {
  default_private_profile: "private",
  default_profile: "personal",
  profiles: {
    personal: { color: "#0d9488", name: "Personal" },
    private: { color: "#a78bfa", name: "Private", private: true },
    work: { color: "#d97706", extensions: [UBLOCK], name: "Work" },
  },
  sites: { "*.acme.com": "work" },
};

/** What the engine runs for {@link BROWSER}, with a site the user pinned. */
const PROFILES: BrowserProfiles = {
  defaultPrivateProfile: "private",
  defaultProfile: "personal",
  profiles: [
    {
      color: "#0d9488",
      extensions: [{ enabled: false, id: UBLOCK, locked: false }],
      id: "personal",
      name: "Personal",
      private: false,
    },
    {
      color: "#d97706",
      extensions: [{ enabled: true, id: UBLOCK, locked: true }],
      id: "work",
      name: "Work",
      private: false,
    },
    {
      color: "#a78bfa",
      extensions: [{ enabled: false, id: UBLOCK, locked: false }],
      id: "private",
      name: "Private",
      private: true,
    },
  ],
  sites: [
    { pinned: false, profile: "work", site: "*.acme.com" },
    { pinned: true, profile: "work", site: "github.com/acme" },
  ],
};

/** A profile's card on the Profiles page. */
const profileCard = async (name: string) =>
  within(await screen.findByRole("region", { name }));

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

    it("says a plugged-in monitor that can't show HDR can't, in place of its switch", async () => {
      await renderApp("Displays", {
        config: {
          output: {
            profiles: [
              {
                displays: [
                  { display: "DEL DELL U3219Q 2ZLS413" },
                  { display: "drm-2" },
                  { display: "drm-3" },
                ],
                name: "desk",
              },
            ],
          },
        },
        monitors: [
          {
            hdr: "unsupported",
            names: [
              "drm-1",
              "DEL DELL U3219Q 2ZLS413",
              "Dell Inc. DELL U3219Q 2ZLS413",
            ],
          },
          { hdr: "off", names: ["drm-2"] },
        ],
      });
      await screen.findByText("Not supported");
      expect(screen.getAllByText("Not supported")).toHaveLength(1);
      expect(
        screen.queryByRole("switch", { name: "DEL DELL U3219Q 2ZLS413 HDR" }),
      ).toBeNull();
      // One that takes it, and one not plugged in, keep their switches.
      screen.getByRole("switch", { name: "drm-2 HDR" });
      screen.getByRole("switch", { name: "drm-3 HDR" });
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
        row.getByRole("switch", { name: "Allow on local files" }),
      ).toBeVisible();
      await user.click(row.getByRole("switch", { name: "uBlock Origin Lite" }));
      await waitFor(() => {
        expect(
          row.queryByRole("switch", { name: "Allow on local files" }),
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

    it("allows an extension on local files", async () => {
      const { host, user } = await renderApp("Extensions");
      await user.click(
        (await ublock()).getByRole("switch", {
          name: "Allow on local files",
        }),
      );
      await waitFor(() => {
        expect(host.configured).toEqual([
          { id: UBLOCK, settings: { file_access: true } },
        ]);
      });
      expect(host.writes).toEqual([]);
    });

    it("changes a setting the config sets in the config", async () => {
      const { host, user } = await renderApp("Extensions", {
        config: {
          extensions: { settings: { [UBLOCK]: { file_access: true } } },
        },
      });
      const allowed = (await ublock()).getByRole("switch", {
        name: "Allow on local files",
      });
      expect(allowed).toBeChecked();
      await user.click(allowed);
      await waitFor(() => {
        expect(written(host.writes)).toEqual({
          extensions: { settings: { [UBLOCK]: { file_access: false } } },
        });
      });
      expect(host.configured).toEqual([]);
    });

    it("leaves a setting a read-only config sets", async () => {
      await renderApp("Extensions", {
        config: {
          extensions: { settings: { [UBLOCK]: { file_access: true } } },
        },
        writable: false,
      });
      expect(
        (await ublock()).getByRole("switch", {
          name: "Allow on local files",
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
        config: {
          extensions: { settings: { [UBLOCK]: { file_access: null } } },
        },
        writable: false,
      });
      expect(
        (await ublock()).getByRole("switch", {
          name: "Allow on local files",
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
      expect(screen.getByText("No site matches")).toBeInTheDocument();
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

  describe("agents", () => {
    const AGENTS: KnownAgents = {
      connected: [
        {
          agent: "Claude Code",
          reach: {
            type: "windows",
            windows: [
              { id: "n1", title: "Notes" },
              { id: "w1", title: "Pull requests" },
            ],
          },
          session: 4,
        },
      ],
      remembered: [{ agent: "Codex", lastUsedMs: Date.now() }],
    };

    it("lists each agent connected now, then those remembered", async () => {
      await renderApp("Agents", { agents: AGENTS });
      expect(
        await screen.findByText("Connected now · Notes and Pull requests"),
      ).toBeInTheDocument();
      expect(
        screen.getByText("Remembered · Your whole desktop · Last used today"),
      ).toBeInTheDocument();
    });

    it("stops a connected agent and forgets a remembered one", async () => {
      const { host, user } = await renderApp("Agents", { agents: AGENTS });
      await user.click(
        await screen.findByRole("button", { name: "Stop Claude Code" }),
      );
      await user.click(screen.getByRole("button", { name: "Forget Codex" }));
      await waitFor(() => {
        expect(screen.queryByText("Codex")).not.toBeInTheDocument();
      });
      expect(host.state.agents).toEqual({ connected: [], remembered: [] });
      expect(
        screen.getByText(/No agent is connected or remembered/u),
      ).toBeInTheDocument();
    });
  });

  describe("troubleshooting", () => {
    it("turns detailed logging on", async () => {
      const { host, user } = await renderApp("Troubleshooting");
      const detailed = await screen.findByRole("switch", {
        name: "Detailed logging",
      });
      await waitFor(() => {
        expect(detailed).toBeEnabled();
      });
      await user.click(detailed);
      await waitFor(() => {
        expect(host.state.detailed).toBe(true);
      });
      expect(detailed).toBeChecked();
    });

    it("saves the logs hidden, then opens Downloads", async () => {
      const { host, user } = await renderApp("Troubleshooting");
      await user.click(screen.getByRole("button", { name: "Save logs" }));
      expect(
        await screen.findByText(/Saved domicile-logs-2026-11-27-091203.txt/u),
      ).toBeInTheDocument();
      expect(host.exported).toEqual([true]);
      await user.click(screen.getByRole("button", { name: "Open Downloads" }));
      expect(host.downloadsOpened.times).toBe(1);
    });

    it("saves everything once hiding is off", async () => {
      const { host, user } = await renderApp("Troubleshooting");
      await user.click(
        screen.getByRole("switch", {
          name: "Hide web addresses and window titles",
        }),
      );
      await user.click(screen.getByRole("button", { name: "Save logs" }));
      await waitFor(() => {
        expect(host.exported).toEqual([false]);
      });
    });
  });

  describe("agents on the web", () => {
    const ADDRESS = "https://desk.mcp.domicile-desktop.com/mcp";
    const WEB: WebAgents = {
      signedIn: [{ client: "c1", lastUsedMs: Date.now(), name: "claude.ai" }],
      status: { address: ADDRESS, problem: undefined, ready: true },
    };

    it("turns connecting from the web on in the config", async () => {
      const { host, user } = await renderApp("Agents");
      expect(screen.queryByText("Your desktop's address")).toBeNull();
      await user.click(
        await screen.findByRole("switch", { name: "Connect from the web" }),
      );
      await waitFor(() => {
        expect(written(host.writes).agents).toEqual({ web: true });
      });
    });

    it("shows the address to copy once the relay gives it", async () => {
      await renderApp("Agents", {
        config: { agents: { web: true } },
        webAgents: WEB,
      });
      expect(await screen.findByText(ADDRESS)).toBeInTheDocument();
      expect(
        screen.getByText("Add it to the agent as a connector."),
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
    });

    it("asks the desk to try again when it couldn't get ready", async () => {
      const { host, user } = await renderApp("Agents", {
        config: { agents: { web: true } },
        webAgents: {
          signedIn: [],
          status: {
            address: ADDRESS,
            problem: "Couldn't get a certificate, trying again in 2 minutes",
            ready: false,
          },
        },
      });
      await user.click(
        await screen.findByRole("button", { name: "Try again" }),
      );
      expect(host.retried.times).toBe(1);
    });

    it("signs an agent on the web out", async () => {
      const { host, user } = await renderApp("Agents", {
        config: { agents: { web: true } },
        webAgents: WEB,
      });
      await user.click(
        await screen.findByRole("button", { name: "Sign out claude.ai" }),
      );
      await waitFor(() => {
        expect(screen.queryByText("claude.ai")).toBeNull();
      });
      expect(host.state.webAgents?.signedIn).toEqual([]);
    });
  });

  describe("profiles", () => {
    const openProfiles = (writable = true) =>
      renderApp("Profiles", {
        config: { browser: BROWSER },
        profiles: PROFILES,
        writable,
      });

    it("switches an extension in one profile through the desktop", async () => {
      const { host, user } = await openProfiles();
      const personal = await profileCard("Personal");
      await user.click(
        personal.getByRole("switch", {
          name: "uBlock Origin Lite in Personal",
        }),
      );
      await waitFor(() => {
        expect(host.switched).toEqual([
          { enabled: true, id: UBLOCK, profile: "personal" },
        ]);
      });
      expect(host.writes).toEqual([]);
    });

    it("switches an extension the config locks in the config", async () => {
      const { host, user } = await openProfiles();
      const work = await profileCard("Work");
      await user.click(
        work.getByRole("switch", { name: "uBlock Origin Lite in Work" }),
      );
      await waitFor(() => {
        expect(written(host.writes).browser.profiles.work.extensions).toEqual(
          [],
        );
      });
      expect(host.switched).toEqual([]);
    });

    it("locks what the config sets when the config is read-only", async () => {
      await openProfiles(false);
      const work = await profileCard("Work");
      expect(
        work.getByRole("switch", { name: "uBlock Origin Lite in Work" }),
      ).toHaveAttribute("aria-disabled", "true");
      expect(
        screen.getByRole("combobox", { name: "Where *.acme.com opens" }),
      ).toBeDisabled();
      expect(
        screen.queryByRole("button", { name: "Remove *.acme.com" }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("combobox", { name: "Where github.com/acme opens" }),
      ).toBeEnabled();
      expect(
        screen.queryByRole("button", { name: "Make default" }),
      ).not.toBeInTheDocument();
    });

    it("adds a site through the desktop", async () => {
      const { host, user } = await openProfiles();
      await user.type(
        await screen.findByRole("textbox", { name: "Add a site" }),
        "Chase.com",
      );
      await choose(user, "Profile to open it in", "Private");
      await user.click(screen.getByRole("button", { name: "Add" }));
      await waitFor(() => {
        expect(host.pinned).toEqual([
          { profile: "private", site: "chase.com" },
        ]);
      });
      expect(
        await screen.findByRole("combobox", { name: "Where chase.com opens" }),
      ).toHaveTextContent("Private");
    });

    it("refuses a site that is already listed, pointing at its row", async () => {
      const { host, user } = await openProfiles();
      await user.type(
        await screen.findByRole("textbox", { name: "Add a site" }),
        "github.com/acme",
      );
      expect(screen.getByRole("alert")).toHaveTextContent(
        "github.com/acme already opens in Work. Change its profile in its row above.",
      );
      expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
      expect(host.pinned).toEqual([]);
    });

    it("moves the config's site in the config and the user's through the desktop", async () => {
      const { host, user } = await openProfiles();
      await screen.findByRole("combobox", { name: "Where *.acme.com opens" });
      await choose(user, "Where *.acme.com opens", "Private");
      await waitFor(() => {
        expect(written(host.writes).browser.sites).toEqual({
          "*.acme.com": "private",
        });
      });
      await user.click(
        screen.getByRole("button", { name: "Remove github.com/acme" }),
      );
      await waitFor(() => {
        expect(host.pinned).toEqual([
          { profile: "personal", site: "github.com/acme" },
        ]);
      });
    });

    it("makes a profile the default, unlisting its sites", async () => {
      const { host, user } = await openProfiles();
      const work = await profileCard("Work");
      await user.click(work.getByRole("button", { name: "Make default" }));
      await waitFor(() => {
        const { browser } = written(host.writes);
        expect(browser.default_profile).toBe("work");
        expect(browser.sites).toEqual({});
      });
    });

    it("moves a profile in the config's order", async () => {
      const { host, user } = await openProfiles();
      const personal = await profileCard("Personal");
      expect(
        personal.getByRole("button", { name: "Move Personal up" }),
      ).toBeDisabled();
      const work = await profileCard("Work");
      await user.click(work.getByRole("button", { name: "Move Work up" }));
      // Unordered, the config lists them by id: personal, private, work.
      await waitFor(() => {
        expect(written(host.writes).browser.order).toEqual([
          "personal",
          "work",
          "private",
        ]);
      });
    });

    it("sets any color from the well", async () => {
      const { host } = await openProfiles();
      const work = await profileCard("Work");
      const well = work.getByLabelText("Work's color, any color");
      fireEvent.change(well, { target: { value: "#2bd96b" } });
      fireEvent.blur(well);
      await waitFor(() => {
        expect(written(host.writes).browser.profiles.work?.color).toBe(
          "#2bd96b",
        );
      });
    });

    it("adds and removes a profile in the config", async () => {
      const { host, user } = await openProfiles();
      await user.type(
        await screen.findByRole("textbox", { name: "New profile's name" }),
        "Side Project",
      );
      await user.click(screen.getByRole("button", { name: "Add profile" }));
      await waitFor(() => {
        expect(written(host.writes).browser.profiles["side-project"]).toEqual({
          color: "#06b6d4",
          name: "Side Project",
          private: false,
        });
      });
      const work = await profileCard("Work");
      await user.click(work.getByRole("button", { name: "Remove Work" }));
      await waitFor(() => {
        const { browser } = written(host.writes);
        expect(Object.keys(browser.profiles)).not.toContain("work");
        expect(browser.sites).toEqual({});
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
