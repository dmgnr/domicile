# Web apps

A web app on Domicile is a URL and a desktop entry. `domicile open --app <url>`
opens it in an app window: a browser window the shell draws as an application,
with no address bar while its page is on the app's origin. Domicile already is
a browser, so an app ships no browser of its own, as an Electron app does.

## Design

```
Exec=domicile open --app <url>
  ─▶ supervisor   {"type":"open_app","url":…}                     control socket
  ─▶ engine       {"type":"open_url","version":1,"url":…,"app":true}  command socket
  ─▶ shell        DomicileBrowserWindow.isApp                     browserwindowschanged
  ─▶ manganese    <BrowserWindow isApp>: no address bar on the app's origin
```

A shell's own launcher calls `domicile.browser.openApp(url)` instead, which
opens the same window over the shell's `BrowserWindows` pipe
([SHELL-BROWSER-WINDOWS.md](/docs/SHELL-BROWSER-WINDOWS.md)).

### One window per app

An app window can belong to an app id, so a launch can reuse it:

```
domicile open --app --id messages --reuse focus https://messages.google.com/web/
browser.openApp(url, { id: "gmail:me@example.com", reuse: AppReuse.Navigate })
```

- **`appId`** is listed on the window. Empty for none.
- **`reuse`:** `new` (default) opens another window; `focus` raises the
  oldest open window with the id; `navigate` also loads the address in it.
- **Raising** fires `domicile-focus-request` on the window's `<webview>`, as
  the page's own `window.focus()` does, so the shell raises it the same way.
- **`countMatches(id, selector)`** counts elements in a window's page, so a
  shell can read an app's unread count from its window, hidden or not.
- **`clickMatch(id, selector)`** clicks the first shown element matching a
  selector in a window's page, so a shell can open what a notification names in
  the app's own view, such as a mail beside Gmail's inbox list.

- **An app window** is a browser window with `isApp` set. It shares the
  profile, extensions and site permissions of every other window. Its visits
  stay out of the history ([HISTORY.md](/docs/HISTORY.md)).
- **Its page's new windows** (`target="_blank"`, `window.open`) are browser
  windows, as a link out of a Chrome app opens in the browser.
- **Settings and History** are app modules, which open in app windows too
  ([APP-MODULES.md](APP-MODULES.md)).

### Shipping an app

A site is an app once a desktop entry opens it:

```ini
[Desktop Entry]
Type=Application
Name=Music
Icon=/usr/share/icons/music.svg
Exec=domicile open --app https://music.example/
```

Launchers list it like any application ([LAUNCHER.md](/docs/LAUNCHER.md)).
The home-manager module writes one for each of `programs.domicile.webApps`
([SHELL-CONFIG.md](/docs/SHELL-CONFIG.md#home-manager)).

`domicile install-app <url>` writes one from the site's web app manifest:

- **Manifest:** the page's `<link rel="manifest">`. `name` (else
  `short_name`) is the entry's name. `start_url` (else the page) is what it
  opens, and must be on the page's origin.
- **Icon:** the manifest's SVG, else its largest PNG, as the launcher draws
  only those. Maskable-only icons are skipped. Saved to
  `$XDG_DATA_HOME/domicile/app-icons/`.
- **Entry:** `$XDG_DATA_HOME/applications/domicile-app-<host-and-path>.desktop`,
  named after the start URL, so installing again replaces it. Its path is
  printed. `X-Domicile-Installed-From` records `<url>` as given.
- **Fetching:** the `curl` on `PATH`. The desktop's `PATH` has one.

`domicile uninstall-app <url>` removes that entry and its icon, without the
network:

- **`<url>`** is the address given to `install-app`, or the start URL (the
  address after `domicile open --app` in the entry). Entries installed before
  `X-Domicile-Installed-From` existed take only the start URL.
- **Found by:** the file name from `<url>` as a start URL; else each
  `domicile-app-*.desktop` whose `X-Domicile-Installed-From` is `<url>`.
- **Removed:** only those `<stem>.desktop` and `<stem>.{png,svg}` in the two
  directories above. Each path is printed.
- **Nothing there** exits non-zero, naming the URL.

An app that needs the system (files, native programs, D-Bus) is an app
module, as Settings is ([APP-MODULES.md](APP-MODULES.md)): its desktop entry
runs `domicile open --app <entry.js>`.

## Key decisions

- **A flag the engine holds over a list of app URLs in the shell.** It survives
  `domicile load-shell`, every shell sees it, and a launcher need not know
  which URLs are apps.
- **An `app` key on `open_url` over a new engine command.** An engine older
  than app windows ignores the key and opens a browser window instead of
  refusing.
- **`domicile open --app` over a verb of its own.** One verb opens anything;
  `--app` says to open it as an app.
- **Desktop entries over a Domicile app format.** Launchers, `xdg` tools and
  home-manager already make and read them.
- **`install-app` fetches with `curl` over an HTTP crate.** The desktop already
  ships `curl` for bookmark icons, and an HTTP and TLS stack would be a new
  dependency for one verb.
- **`install-app`'s entry runs `domicile` from `PATH`.** A store path would
  break once garbage-collected; home-manager's entries name one because each
  generation rewrites them.
- **Every `open --app` opens a window, unless it names an id to reuse.** An
  app can have several windows, as a browser can; an inbox wants one.
- **The engine matches the window by id, not the shell.** A match in the shell
  races its window list, so two quick launches open two windows, and the CLI
  could not use it.
- **An id the caller names, not one from the URL.** Two Gmail accounts share
  an origin but are separate apps.
- **A read-only address off the app's origin, none on it.** Only a program the
  user runs opens an app window, so its own pages need no address. A page
  elsewhere, such as a sign-in, shows its site and connection, as Chrome does
  for an installed app.
- **The origin is the one the window opened at.** The engine lists the page's
  current address, so manganese keeps the first one it sees.

## Plan

- [x] app windows: `domicile open --app`, `isApp`, manganese draws no address
  bar
- [x] off the app's origin, show a read-only address bar, as Chrome does for an
  installed app
- [x] `domicile install-app <url>`: read the site's web app manifest (`name`,
  `icons`, `start_url`) and write a desktop entry to
  `~/.local/share/applications`
- [x] home-manager `webApps.<name> = { url; icon; }`, which writes desktop
  entries
- [x] `DomicileHost.openAppWindow(url)`, for a shell's own launcher
- [x] app ids and `reuse` (`open --app --id --reuse`, `openApp(url, { id,
  reuse })`), `countBrowserWindowMatches` and `clickBrowserWindowMatch`

## Open questions

- **A profile per app?** Recommendation: no. Share the profile, as Chrome's
  installed apps do, so signing in once signs in everywhere.
