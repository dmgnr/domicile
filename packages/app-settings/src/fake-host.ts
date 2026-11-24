// An in-memory stand-in for the settings host, for the app's tests.

import type {
  BrowserProfiles,
  ExtensionSettings,
  InstalledExtension,
  KnownAgents,
  MediaDevices,
  Monitor,
  SettingsFiles,
  SettingsHost,
  SiteData,
  SiteSettings,
  Target,
  WebAgents,
} from "./host";

/** What a fake host starts with. */
export type FakeHostState = {
  files: SettingsFiles;
  /** The folder the picker returns, or `undefined` for a canceled one. */
  chosen: string | undefined;
  /** The ids the engine says the config installed. */
  configExtensions: string[];
  /** The extensions in the profile, which switches change. */
  installed: InstalledExtension[];
  sites: SiteSettings;
  /** The hosts that store data, which clearing one removes. */
  siteData: SiteData[];
  media: MediaDevices;
  /** The lit monitors; none by default. */
  monitors?: Monitor[] | undefined;
  /** The agents in now and remembered; none by default. */
  agents?: KnownAgents | undefined;
  /** Agents on the web; no status and nobody signed in by default. */
  webAgents?: WebAgents | undefined;
  /** The browser profiles the engine runs; one default profile if unset. */
  profiles?: BrowserProfiles | undefined;
  /** Whether detailed logging is on; off by default. */
  detailed?: boolean | undefined;
  /** The reason every write is refused, if any. */
  refuse?: string | undefined;
};

/**
 * A host over `state`, which writes change; `writes`, `opened` and the rest
 * record each request.
 */
export const fakeHost = (state: FakeHostState) => {
  const changes = new Set<() => void>();
  const writes: { file: Target; text: string }[] = [];
  const loaded: string[] = [];
  const uninstalled: string[] = [];
  const opened: string[] = [];
  /** Each change to an extension's settings. */
  const configured: { id: string; settings: ExtensionSettings }[] = [];
  /** Each folder the picker returned. */
  const chosen: (string | undefined)[] = [];
  /** Each extension switched in one profile. */
  const switched: { id: string; enabled: boolean; profile: string }[] = [];
  /** Each site pinned to a profile. */
  const pinned: { site: string; profile: string }[] = [];
  /** How many times Try again asked the desk for a certificate now. */
  const retried = { times: 0 };
  /** Each Save logs, by whether it hid addresses and titles. */
  const exported: boolean[] = [];
  /** How many times Downloads was opened. */
  const downloadsOpened = { times: 0 };
  const host: SettingsHost = {
    agents: () =>
      Promise.resolve(
        structuredClone(state.agents ?? { connected: [], remembered: [] }),
      ),
    browserProfiles: () =>
      Promise.resolve(
        structuredClone(
          state.profiles ?? {
            defaultPrivateProfile: "private",
            defaultProfile: "default",
            profiles: [],
            sites: [],
          },
        ),
      ),
    chooseFolder: () => {
      chosen.push(state.chosen);
      return Promise.resolve(state.chosen);
    },
    clearSiteData: (cleared) => {
      state.siteData = state.siteData.filter(({ host }) => host !== cleared);
      return Promise.resolve();
    },
    configExtensions: () => Promise.resolve([...state.configExtensions]),
    configureExtension: (id, settings) => {
      const found = state.installed.find((extension) => extension.id === id);
      if (found === undefined) {
        throw new Error(`No extension ${id}`);
      } else {
        configured.push({ id, settings: structuredClone(settings) });
        found.settings = { ...found.settings, ...structuredClone(settings) };
        return Promise.resolve();
      }
    },
    detailedLogging: () => Promise.resolve(state.detailed ?? false),
    exportLogs: (redact) => {
      exported.push(redact);
      return Promise.resolve({
        path: "/home/me/Downloads/domicile-logs-2026-11-27-091203.txt",
        unhidden: undefined,
      });
    },
    extensions: () => Promise.resolve(structuredClone(state.installed)),
    forgetAgent: (agent) => {
      if (state.agents !== undefined) {
        state.agents.remembered = state.agents.remembered.filter(
          (remembered) => remembered.agent !== agent,
        );
      }
      return Promise.resolve();
    },
    loadUnpacked: (directory) => {
      loaded.push(directory);
      return Promise.resolve("c".repeat(32));
    },
    mediaDevices: () => Promise.resolve(structuredClone(state.media)),
    monitors: () => Promise.resolve(structuredClone(state.monitors ?? [])),
    onChange: (listener) => {
      changes.add(listener);
      return () => {
        changes.delete(listener);
      };
    },
    openDownloads: () => {
      downloadsOpened.times += 1;
      return Promise.resolve();
    },
    openUrl: (url) => {
      opened.push(url);
      return Promise.resolve();
    },
    pinBrowserSite: (site, profile) => {
      pinned.push({ profile, site });
      const profiles = state.profiles;
      if (profiles !== undefined) {
        const others = profiles.sites.filter((each) => each.site !== site);
        profiles.sites =
          profile === profiles.defaultProfile
            ? others
            : [...others, { pinned: true, profile, site }];
      }
      return Promise.resolve();
    },
    read: () => Promise.resolve(structuredClone(state.files)),
    retryWebAgents: () => {
      retried.times += 1;
      return Promise.resolve();
    },
    setDetailedLogging: (on) => {
      state.detailed = on;
      return Promise.resolve(on);
    },
    setExtensionEnabled: (id, enabled, profile) => {
      if (profile !== undefined) {
        switched.push({ enabled, id, profile });
        const found = state.profiles?.profiles
          .find((each) => each.id === profile)
          ?.extensions.find((extension) => extension.id === id);
        if (found === undefined) {
          throw new Error(`No extension ${id} in ${profile}`);
        }
        found.enabled = enabled;
        return Promise.resolve();
      }
      const found = state.installed.find((extension) => extension.id === id);
      if (found === undefined) {
        throw new Error(`No extension ${id}`);
      } else {
        found.enabled = enabled;
        return Promise.resolve();
      }
    },
    setMediaDevice: (kind, id) => {
      const list = kind === "camera" ? "cameras" : "microphones";
      const preferred = state.media[list].filter((device) => device.id === id);
      const others = state.media[list].filter((device) => device.id !== id);
      state.media = { ...state.media, [list]: [...preferred, ...others] };
      return Promise.resolve();
    },
    setSitePermission: (site) => {
      const others = state.sites.sites.filter(
        (stored) =>
          stored.origin !== site.origin ||
          stored.permission !== site.permission,
      );
      state.sites = {
        ...state.sites,
        sites:
          site.setting === state.sites.defaults[site.permission]
            ? others
            : [...others, site],
      };
      return Promise.resolve();
    },
    signOutWebAgent: (client) => {
      if (state.webAgents !== undefined) {
        state.webAgents.signedIn = state.webAgents.signedIn.filter(
          (signedIn) => signedIn.client !== client,
        );
      }
      return Promise.resolve();
    },
    siteData: () => Promise.resolve(structuredClone(state.siteData)),
    sitePermissions: () => Promise.resolve(structuredClone(state.sites)),
    stopAgent: (session) => {
      if (state.agents !== undefined) {
        state.agents.connected = state.agents.connected.filter(
          (connected) => connected.session !== session,
        );
      }
      return Promise.resolve();
    },
    uninstallExtension: (id) => {
      uninstalled.push(id);
      return Promise.resolve();
    },
    webAgents: () =>
      Promise.resolve(
        structuredClone(state.webAgents ?? { signedIn: [], status: undefined }),
      ),
    write: (file, text) => {
      if (state.refuse === undefined) {
        writes.push({ file, text });
        const current = state.files[file];
        if (current === undefined) {
          throw new Error(`The fake has no ${file} to write`);
        } else {
          state.files = { ...state.files, [file]: { ...current, text } };
          return Promise.resolve();
        }
      } else {
        return Promise.reject(new Error(state.refuse));
      }
    },
  };
  /** Tells the app a file changed on disk. */
  const change = () => {
    for (const listener of changes) {
      listener();
    }
  };
  return {
    change,
    chosen,
    configured,
    downloadsOpened,
    exported,
    host,
    loaded,
    opened,
    pinned,
    retried,
    state,
    switched,
    uninstalled,
    writes,
  };
};
