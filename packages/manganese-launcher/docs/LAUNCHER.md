# The launcher

**Meta+Space** (or Meta+D, the bar's launcher button, or a tab strip's "+")
opens a search box.
Every row is something Enter can do. Source: `src/`.

## Rows, in order

1. For a `!` tag (`!wiki`, `!yt`, …): the tagged site's page for the words, if
   it has one, then a search on that site, with its logo. `!gh` with a name
   (`cprussin` or `cprussin/domicile`) goes to that GitHub page.
2. A URL, if the line is one.
3. Applications and bookmarks (the `applications` option), as one list by
   name.
4. A path, if the line is spelled like one.
5. Files from the compositor's index of the home directory.
6. A Google search for the line as typed. Always present.

While the last word starts with `!`, the tags it could be (`!p` included) head
the list, each with what it does. Enter, Tab or a click fills the tag in rather
than launching.

The site (2) and the search (6) each have a row beside them that opens them in
a private browser. `!p` anywhere in the line offers only the web rows (1, 2
and 6), all private. `!g` offers only its Google search (1), so Enter
searches without the matches. Opened over a private browser window, the box starts
with `!p `. A private browser's address bar is tinted the `private`
color and says "Private"; its new windows are private too. See
[private browsing](../../../docs/SHELL-BROWSER-WINDOWS.md#private-browsing).

The footer lists every tag, `!p` included, at its start.

`@domicile-desktop/manganese-address/typed-address` decides whether a line is a site or a search.
Browser address bars use the same rule.

## Sources

- **Applications**: `@domicile-desktop/system-apps` reads desktop entries
  through the system calls (`launcher/app-search.ts`). Icons come from
  `theme.icon_theme`, then `hicolor`. Entries are read while the launcher is closed, so rows
  don't shift when it opens; typing searches that list.
- **Bookmarks**: open as a page. The icon is the one the page named when last
  previewed or visited, else the one `system-apps` fetched with `curl`.
- **Files**: the compositor's index matches the query and returns the top
  results. While indexing is unfinished, the panel says so and re-queries.

## Opening a file

- **Enter** runs `xdg-open` on the file (`window-management/open-command.ts`).
  In a desktop that is `domicile open`, which opens it as a terminal or an
  app would: see [docs/LAUNCHER.md](../../../docs/LAUNCHER.md#opening-files).
- **Shift+Enter** asks which to open it with, in the AppChooser portal's dialog
  (`launcher/OpenWith.tsx`). Shift+Enter on any other row acts as Enter.
- The dialog lists what `@domicile-desktop/system-apps/openers` offers. First
  is the app Enter would open it with, as `domicile open --which` says, even
  a `NoDisplay` one, so the dialog and Enter always agree. Then every type's
  defaults from `mimeapps.list`, `domicile-mimeapps.list` first, the type's
  own before its supertypes' (`mime/subclasses`, and `text/plain` for every
  `text/*`); then installed entries whose `MimeType` lists one. The type
  comes from shared-mime-info's `mime/globs2`, by name; a directory is
  `inode/directory`. `NoDisplay` entries are not offered otherwise.
  `Terminal` entries are offered, and run in the config's `terminal`, only
  when it names one ([SHELL-CONFIG.md](/docs/SHELL-CONFIG.md#terminal)).
- URLs and searches open as a page.

## Preview

A preview of the highlighted row sits beside the list. It updates once typing
settles, and keeps the last preview until then.

- **Text file**: the start of the file, highlighted with `lowlight` in the
  theme's colors.
- **Folder**: a grid of its contents; images show as thumbnails.
- **Audio**: tags and cover art, over a player. Told by content, not name:
  ID3v2 (MP3, WAV, AIFF), FLAC, Ogg Vorbis and Opus, MP4.
- **Video**: one frame from 10% in.
- **Image or PDF**: loaded from `domicile://home/`.
- **URL or search**: the page, in a private `<webview>`, so previewing stores
  nothing.
- **Bookmark**: the page, signed in, so its icon can be learned.
- **Inbox**: its account and unread count, and the sender, subject and age of
  the newest message in each of its eight newest unread conversations, from
  the shell's `glances`. Gmail reads them with the API; Messages gives only a
  count.
- **Application**: the image named by `X-Domicile-Preview`, or else its
  description and the command Enter runs.

## Behavior

- The highlight starts on the first row. The pointer moves it.
- A pick runs once the launcher has finished closing and a frame without it
  has been painted, so nothing it opens sees the launcher. A screenshot app
  would shoot it.
- While the launcher is open, other bindings are ignored. See
  [Keys](../../manganese-window-management/docs/KEYS.md#commands).
