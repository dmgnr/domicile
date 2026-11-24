// The stand-in for Electron's `desktopCapturer` and
// `session.setDisplayMediaRequestHandler`. The desktop's share picker, which
// the shell draws, says what a page captures, as Electron's own does under
// Wayland, where the ScreenCast portal picks. See "Desktop pieces" in
// docs/architecture/ELECTRON-APPS.md.

import type { NativeImage } from "./native-image";
import { nativeImage } from "./native-image";

export type SourceType = "screen" | "window";

/** Electron's `SourcesOptions`. */
export type SourcesOptions = {
  types: SourceType[];
  thumbnailSize?: { width: number; height: number } | undefined;
  fetchWindowIcons?: boolean | undefined;
};

/** Electron's `DesktopCapturerSource`. */
export type DesktopCapturerSource = {
  /**
   * What a page passes as `chromeMediaSourceId`. The engine opens the
   * desktop's picker for any desktop `getUserMedia()`, so it names no one
   * window or screen.
   */
  id: string;
  name: string;
  thumbnail: NativeImage;
  display_id: string;
  appIcon: NativeImage | null;
};

/**
 * The one source the desktop's picker stands for, as Electron's under Wayland
 * gives one: a page's `getUserMedia()` with it opens the picker, which offers
 * screens, windows and browser windows alike.
 */
const pickerSource = (types: readonly SourceType[]): DesktopCapturerSource => {
  const screen = types.includes("screen");
  return {
    appIcon: null,
    display_id: "",
    id: screen ? "screen:0:0" : "window:0:0",
    name: screen ? "Screen or window" : "Window",
    thumbnail: nativeImage.createEmpty(),
  };
};

/** Electron's `desktopCapturer`. */
export const desktopCapturer = {
  // Rejects rather than throws, as Electron's does.
  getSources: (options: SourcesOptions): Promise<DesktopCapturerSource[]> => {
    const types = options.types;
    return !Array.isArray(types) || types.length === 0
      ? Promise.reject(
          new TypeError(
            'desktopCapturer.getSources takes `types`, some of "screen" and "window"',
          ),
        )
      : Promise.resolve([pickerSource(types)]);
  },
};

/** Electron's handler: it calls `callback` once with the streams to share. */
export type DisplayMediaRequestHandler = (
  request: unknown,
  callback: (streams: unknown) => void,
) => void;

/**
 * Electron's `setDisplayMediaRequestHandler`. A page's `getDisplayMedia()`
 * always opens the desktop's picker, as Electron's `useSystemPicker` does:
 * the user picks there, so the handler is kept but not asked.
 */
export const setDisplayMediaRequestHandler = (
  _handler: DisplayMediaRequestHandler | null,
  _options?: { useSystemPicker?: boolean },
) => undefined;
