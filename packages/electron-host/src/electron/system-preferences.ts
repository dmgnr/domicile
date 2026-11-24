// The stand-in for Electron's `systemPreferences` on Linux: its animation
// settings, and the desktop's accent color from the settings portal (see
// src/appearance.ts).

import { EventEmitter } from "node:events";

/**
 * Electron's `systemPreferences`, starting at the desktop's `initial` accent
 * color. `accentColorChanged` takes each accent the desktop sends.
 */
export const createSystemPreferences = (
  reducedMotion: () => boolean,
  initial: string,
) => {
  let accent = initial;
  const systemPreferences = Object.assign(new EventEmitter(), {
    getAccentColor: () => accent,
    getAnimationSettings: () => ({
      prefersReducedMotion: reducedMotion(),
      scrollAnimationsEnabledBySystem: !reducedMotion(),
      shouldRenderRichAnimations: !reducedMotion(),
    }),
  });
  return {
    accentColorChanged: (color: string) => {
      if (color !== accent) {
        accent = color;
        systemPreferences.emit("accent-color-changed", eventObject(), color);
      }
    },
    systemPreferences,
  };
};

/** The event object Electron passes first to a listener. */
const eventObject = () => {
  const event = {
    defaultPrevented: false,
    preventDefault: () => {
      event.defaultPrevented = true;
    },
  };
  return event;
};
