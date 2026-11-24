# Browser profiles

A browser profile is a set of sign-ins, site data and extensions. Pages of
every profile share the desktop's windows and tab groups. The config maps
sites to profiles, so a page opens in its site's profile without a picker, and
the user can move any page to another profile.

## Problem

Every browser window shares one Chrome profile, plus one off-the-record profile
for private windows. A user with a work and a personal account has to sign out
and in, or use a private window, and every extension sees every page: a work
password manager reads personal sites.

`<webview partition>` does not fix this. A partition splits cookies and
storage, but extensions belong to the Chrome profile, so they would still see
every page and keep one state (one Bitwarden login).

## Design

### Config

```json
{
  "browser": {
    "profiles": {
      "personal": { "name": "Personal", "color": "#0d9488" },
      "work": {
        "name": "Work",
        "color": "#d97706",
        "extensions": ["aeblfdkhhhdcdjpifhhbdiojplfjncoa"]
      },
      "private": { "name": "Private", "color": "#a78bfa", "private": true }
    },
    "order": ["personal", "work", "private"],
    "default_profile": "personal",
    "default_private_profile": "private",
    "sites": { "*.acme.com": "work", "github.com/acme": "work" }
  }
}
```

- **`profiles`**: by id. `extensions` lists the ids from `extensions.web_store`
  and `extensions.unpacked` that the profile turns on, and locks the profile's
  extension switches to it. Unset leaves the switches to the user: each
  starts on, or off in a private profile. `private` keeps nothing past the
  profile's last page.
- **`order`**: the order the compositor sends the profiles in, and so the
  order the shell and Settings list them in: these ids, then the rest by id.
  Each id must be a profile, once.
- **`default_profile`**: where an unlisted site opens. Never private.
- **`default_private_profile`**: where "new private window" opens. Always
  private.
- **`sites`**: a map, so a site has one profile. Keys are a host, `*.host`, or
  a host and path prefix. The most specific match wins. A site never maps to
  `default_profile`; the config is refused if one does.
- **Unset `browser`**: one default profile, `default`, and one private one,
  `private`.
- `extensions.settings.<id>.private` is gone: a private profile's
  `extensions` replaces it.

### Engine

- **One Chrome profile per browser profile.** Each has its own cookies,
  storage, cache, history, permissions, extensions and extension state.
- **The default profile is the shell's profile**, today's user data directory,
  so existing sign-ins stay.
- **Other profiles** live in `domicile-<id>` in the user data directory,
  since `ProfileManager` loads only its direct children. Each is loaded when
  the config names it.
- **A private profile** is the primary off-the-record profile of a hidden
  regular profile `<id>`. Chrome gives an off-the-record profile its parent's
  extensions, so the hidden profile holds the private profile's extension
  set. No page opens in the hidden profile itself.
- **Guests** are made in their profile's context, as private guests are
  (`ContextFor` in `web_view_guest.cc`). `partition` still splits storage
  inside a profile.
- **One window list.** `DeskWindows` stays on the shell's profile and lists
  guests of every profile. Each window carries its profile id.
- **One desk per profile.** `chrome.tabs` and `chrome.windows` in a profile see
  only its own pages.
- **Extensions** are installed into every profile and switched on or off in
  each, so one switched off keeps its data. That is the config's, and every
  one the user installs in any profile: from the Web Store page in a profile's
  window, or the Settings app's "load unpacked". The others install it from
  the Web Store, or from its directory. One the user uninstalls leaves every
  profile. A profile whose config names its `extensions` has the config's
  switches set and locked; any other extension starts at its default the
  first time it is installed there and the user switches it from then on,
  which Chrome keeps. `extensions.settings` applies in every profile.

### Routing

The engine picks the profile, so every shell, `domicile open`, `window.open`
and `chrome.tabs.create` behave the same.

- `profileFor(url)`: the most specific `sites` match, else `default_profile`.
- **Pinned sites:** the profile menu pins a site to a profile. The engine keeps
  pins in the shell profile's prefs and adds them under the config's `sites`:
  a site the config names keeps the config's profile and shows locked. Pinning
  to the default profile removes the pin.
- **New windows** with no opener open in `profileFor(url)`, unless the caller
  names a profile. A window at an address that isn't a web address, such as an
  extension's own page from `chrome.tabs.create`, opens in the profile that
  asked for it, where that extension is switched on.
- **Top-level navigations the user starts** (link clicks, the address bar,
  back and forward) move the page to `profileFor(target)` when it differs from
  `profileFor(current)`. Comparing both ends keeps a page the user moved by
  hand in its profile while it stays on the same site.
- **Redirects, iframes and popups with an opener** stay in the page's
  profile, so sign-in flows complete where they started.

### Moving a page

`Reopen(window, profile)` makes a new guest in the target profile under the
same window id, so the shell keeps its place and group. The window's
`<webview>` is told to ask for it again, and shows the new page.

- The back and forward list moves as URLs and titles. Page state, form input
  and POST bodies do not; the page reloads.
- Routing moves pages the same way.

### SDK

| API | Does |
|---|---|
| `host.browserProfiles` + `browserprofileschanged` | The profiles: id, name, color, private, default. |
| `DomicileBrowserWindow.profile` | The window's profile id. |
| `openBrowserWindow(url, { profile })` | Opens in `profile`, or by routing when unset. |
| `reopenBrowserWindow(id, profile)` | Moves a window's page to `profile`. |
| `browserProfileFor(url)` | Routing's answer for `url`. |
| `browserSiteFor(url)` | The site entry that routes `url`, if any. |
| `pinBrowserSite(site, profile)` | Pins a site to a profile, kept by the engine. |
| `DomicileBrowserProfile.pinnedSites` / `configSites` | The sites that open in it, by who set them. |
| `browser.fetch(url, { profile })` | Fetches with `profile`'s cookies. |
| `InstalledExtension.profiles` | The profiles an extension is on in. |

`domicile open --profile <id> <url>` and launcher bookmarks name a profile the
same way.

### Manganese

Mockup: `/mnt/project-files/browser-profiles/mockup.html` in the project.

- A profile button at the start of the address bar opens the profile menu:
  move the page, pin the site to a profile, open in a new tab of a profile,
  the profile's extensions.
- Tabs outside the default profile carry the profile's color on their icon.
- The tray shows the focused page's profile's extensions.
- Settings has a Profiles page: a card per profile and one Sites list.
- Gmail and Messages bar modules take a `profile` option.

## Key decisions

- **Chrome profiles over partitions:** extensions and their state are per
  Chrome profile.
- **Swap in place over a new tab** for a link to another profile's site: the
  user asked for it, and back swaps back.
- **Unlisted sites go to the default profile** rather than inheriting the
  opener's: one rule to predict.
- **Private is a profile option** rather than a mode of each profile: a
  private Work profile is one more profile.

## Plan

- [x] config: `browser`, the JSON schema, home-manager options
- [x] config: drop `extensions.settings.*.private` (the SDK's `inPrivate`
  too)
- [x] engine: a Chrome profile per browser profile, private profiles, guests
  opened in a profile, windows listed with their profile
- [x] engine: extensions per profile, a desk per profile
- [x] engine: routing and `Reopen`
- [x] protocol and SDK: the API above, `domicile open --profile`
- [x] SDK: `browser.fetch(url, { profile })`, `openApp(url, { profile })`;
  a site's app window is in a profile, its site's by default
- [x] bar modules, inboxes and launcher bookmarks take a `profile`;
  `domicile open --app --profile`
- [x] Manganese: address bar button and menu (move the page, open it in a new
  window of a profile), tab dots
- [x] engine and SDK: sites the user pins, kept in the shell profile's prefs
  under the config's (the config wins; its sites show locked)
- [x] Manganese: pin a site to a profile from the menu
- [x] engine and SDK: every extension in every profile, switched per profile
  (`DomicileBrowserProfile.extensions`, `enabledExtensions`,
  `lockedExtensions`, `setBrowserProfileExtensionEnabled`)
- [x] Manganese: switch a profile's extensions from the menu
- [x] Manganese: tray by profile (the last focused page's)
- [x] Settings: Profiles page (`browser_profiles` and `pin_browser_site` on the
  command socket)
