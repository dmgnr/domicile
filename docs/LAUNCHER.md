# The launcher

The launcher searches three sources: files in your home directory, installed
desktop entries, and bookmarks. Files are configured in the desk config;
applications and bookmarks are manganese options. A config reload applies
changes.

## Files

The compositor indexes your home directory at startup and watches it for
changes.
`files.omit` lists paths to leave out.

```json
{ "files": { "omit": ["*/*", "!Scratch/*"] } }
```

- Patterns are globs relative to your home directory, with gitignore rules: `*`
  stops at `/`, `**` does not, `!` re-includes, and the last match wins.
- The default is `["**/.*"]`, which hides dotfiles at any depth. Setting
  `files.omit` replaces the default.
- An omitted directory is not walked or watched, so `!` cannot re-include
  anything under it.
- Symlinks are listed by name but not followed.
- A reload walks the home directory again. The launcher keeps its old list
  until the walk finishes.

## Applications

Manganese lists the machine's desktop entries. Those that run in a terminal,
such as htop and vim, are listed only when the config names a `terminal`, and
run in it ([SHELL-CONFIG.md](SHELL-CONFIG.md#terminal)). Its `applications.omit` option
hides some, using the same glob rules over desktop file IDs
(`firefox.desktop`).

```tsx
// ~/.config/domicile/domicile.tsx
import { runManganese } from "@domicile-desktop/manganese";

export const Shell = runManganese({
  applications: { omit: ["*", "!launcher-*"] },
});
```

- Unset shows every entry.
- Entries are read again each time the launcher closes, so a new install shows
  on the next open.
- `Icon` is drawn beside the row.
- `X-Domicile-Preview` names a PNG or SVG under 128 KiB, found the same way as
  `Icon`. It fills the preview while the row is highlighted.
- `StartupWMClass` names the Wayland app id of the window the entry opens. Set
  it when the entry's file name differs from that app id, so the window's
  title bar finds the entry's `Icon`.

```ini
[Desktop Entry]
Type=Application
Name=Agenda
Exec=agenda
Icon=/path/to/agenda.svg
X-Domicile-Preview=/path/to/agenda-preview.svg
```

### Opening files

Enter opens a file with its type's default application, else its
supertype's: a `text/plain` default also opens Markdown, source code and
other text. It is `domicile open`, which a terminal and `xdg-open` in apps
run too. An application that runs in a terminal, such as vim, opens in the
config's `terminal` ([SHELL-CONFIG.md](SHELL-CONFIG.md#terminal)), and is
skipped when it names none. When no application opens it (`domicile open --which` names none),
the launcher stays open and the file's row says so; Shift+Enter still asks
what to open it with. Set one in
`~/.config/domicile-mimeapps.list` to apply only in Domicile, or in
`~/.config/mimeapps.list`:

```ini
[Default Applications]
text/plain=org.gnome.TextEditor.desktop
```

Shift+Enter asks which application to open it with. See manganese's
[launcher doc](../packages/manganese-launcher/docs/LAUNCHER.md#opening-a-file).

## Bookmarks

Manganese's `applications.bookmarks` option adds web pages to the launcher.
Selecting one opens it as a browser window in the shell.

```tsx
export const Shell = runManganese({
  applications: {
    bookmarks: [
      { name: "Calendar - Home", url: "https://calendar.google.com?authuser=me@home.example" },
      { name: "Calendar - Work", url: "https://calendar.google.com?authuser=me@work.example" },
    ],
  },
});
```

- Each bookmark has one `http` or `https` URL. Other schemes are rejected.
- A bookmark's `profile`, such as `"work"`, opens it in that browser profile
  ([BROWSER-PROFILES.md](architecture/BROWSER-PROFILES.md)). Without one, it
  opens in the profile its site opens in. Its preview loads in the same
  profile when it names one, and in the default profile otherwise.
- Manganese fetches each site's icon with `curl`: the page's
  `<link rel="icon">`, else `/favicon.ico`. The Nix package puts `curl` on the
  compositor's `PATH`.
- A failed fetch retries after a minute, so icons appear once the network is
  up.
- The fetch sends no cookies, so sites behind a sign-in may show a placeholder
  glyph.
- Highlighting the row loads the signed-in page. Its icon then replaces the
  glyph.
