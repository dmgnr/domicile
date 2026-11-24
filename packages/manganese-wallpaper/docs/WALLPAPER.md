# The wallpaper

A photograph behind the whole desktop, changing every minute. Source:
`src/`.

- **One copy per screen**, cropped to that monitor, so nothing is drawn in
  the gaps between monitors of different sizes. All copies show the same
  photo. Until the compositor reports the screens, one copy covers the page.
- **Each theme has its own rotation**: night scenes for dark, daylight scenes
  for light. CSS shows the current theme's, and only it
  rotates. The other holds its loaded photo, so a theme switch shows it at
  once.
- **Still**: manganese's `wallpaper.rotate` option, off, keeps the photo on
  screen and stops the minute timer, so nothing redraws an idle desktop.
- **Held during a theme wipe**: a photograph due mid-wipe fades in once the
  wipe ends, so no crossfade shows through the new theme's frame.
- **Mounted**: only the photo on screen, the one fading out and the next one.
  The next one mounts a full minute early, so it has loaded before its turn.
  The hidden theme mounts only its photo on screen.
- **Crossfade**: the incoming photo fades in over the outgoing one, which
  stays opaque underneath, so the background never shows through. `isolation: isolate` keeps their `z-index` from stacking over the
  chrome.
- **Photos**: `runManganese`'s `wallpapers` option sets each theme's list:
  web addresses, image files and folders of images (see the user guide's
  [Appearance](/docs/use/APPEARANCE.md#choose-the-photos)). `useWallpapers`
  replaces each folder with its images, sorted by name, once at start. A path
  that cannot be read is logged and left out.
- **Random order**: each pass through a theme's photos is a fresh shuffle,
  never starting on the photo the last pass ended on.
- **Paths** are read through `domicile.files` only while mounted, so at most
  three photos are held at once.
- **Built-in photos**: `photos.ts` lists Wikimedia Commons files by title,
  fetched via `Special:FilePath?width=3840`. Their `srcset` also offers
  `width=1920`, and `sizes` is what covering each screen takes, so a 1080p
  screen fetches and decodes a quarter of the pixels. Commons serves only
  set widths and rounds others up. Each is public domain or CC0, so
  no credit line is needed. Each was checked for:
  - at least 3840px wide, landscape;
  - brightness that suits its theme: mostly dark with few bright areas for
    dark, mostly bright with no large dark areas for light, and the top band
    (under the bar) matching;
  - a look by eye at the whole frame, dropping charts, diagrams, text,
    captions, borders, people, near-duplicates, and soft or grainy photos.
- **Offline**: each theme has one photo in the repo
  (`src/fallback-*.jpg`) under its rotation. It fades in only once a
  remote photo fails or 3s pass without the remote photos loading, so it does
  not flash on start. A remote photo stays transparent until it loads.
- **Retries**: a photo that fails to load retries after 1s, doubling the wait
  up to 60s, until it loads. The network can be down, or up with no internet,
  for any length of time.
- **A picture an application set** through the Wallpaper portal replaces the
  rotation on every screen, and the lock screen shows its own over the blur.
  Both come from `usePortalWallpaper` and are read with `usePictureUrl`, both
  in `@domicile-desktop/component-library`. See
  [PORTALS.md](/docs/PORTALS.md).
