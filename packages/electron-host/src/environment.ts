// The environment variables the host reads, parsed once at its entry point.

import { z } from "zod";

const schema = z.object({
  /** The session bus, where the desktop serves its portals. */
  DBUS_SESSION_BUS_ADDRESS: z.string().optional(),
  /** The engine's Electron socket, which the desktop names to its apps. */
  DOMICILE_ELECTRON_SOCK: z.string().optional(),
  /** systemd's `<device>:<inode>` of the journal stream stderr may be. */
  JOURNAL_STREAM: z.string().optional(),
  /** The compositor's socket, where `shell.beep` rings the bell. */
  WAYLAND_DISPLAY: z.string().optional(),
  XDG_CACHE_HOME: z.string().optional(),
  XDG_CONFIG_HOME: z.string().optional(),
  /** The desktop, by which Chromium picks where safeStorage keeps its key. */
  XDG_CURRENT_DESKTOP: z.string().optional(),
  /** Where the home trash is, for `shell.trashItem`. */
  XDG_DATA_HOME: z.string().optional(),
  /** Where the compositor's socket is. */
  XDG_RUNTIME_DIR: z.string().optional(),
  /** Where the apps' own schemes are kept for the desktop's next start. */
  XDG_STATE_HOME: z.string().optional(),
});

export type Environment = z.infer<typeof schema>;

export const readEnvironment = (
  // biome-ignore lint/style/noProcessEnv: the one place the host reads its environment
  source: Readonly<Record<string, string | undefined>> = process.env,
): Environment => schema.parse(source);
