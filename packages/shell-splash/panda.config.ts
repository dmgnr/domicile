import { domicilePreset } from "@domicile-desktop/component-library/pandacss-preset";
import { defineConfig } from "@pandacss/dev";

/** A glow color the splash eases between, such as `accent` to `danger`. */
const GLOW = { inherits: true, initialValue: "transparent", syntax: "<color>" };

export default defineConfig({
  exclude: [],
  // The page paints the theme's background from its first frame, before the
  // host has described any display to draw a splash on.
  globalCss: {
    "html, body": {
      backgroundColor: "background",
      blockSize: "100%",
      overflow: "clip",
      userSelect: "none",
    },
  },
  // Registered as colors so the aurora can ease from the accent to `danger`
  // when the build fails. An unregistered property would jump.
  globalVars: {
    "--glow-cool": GLOW,
    "--glow-core": GLOW,
    "--glow-deep": GLOW,
    "--glow-warm": GLOW,
  },
  hash: true,
  include: [
    "./src/**/*.{ts,tsx}",
    "../../packages/component-library/src/**/*.{ts,tsx}",
  ],
  jsxFramework: "react",
  // Component props such as content are data; styles use Panda functions.
  jsxStyleProps: "none",
  outdir: "styled-system",
  preflight: true,
  presets: [domicilePreset],
  theme: {
    extend: {
      keyframes: {
        // Three slow orbits, one per patch of the aurora, so it never
        // repeats the same picture.
        auroraCool: {
          "0%": { transform: "translate(0, 0) scale(1) rotate(0deg)" },
          "50%": { transform: "translate(12%, 18%) scale(1.15) rotate(25deg)" },
          "100%": {
            transform: "translate(-6%, 8%) scale(0.95) rotate(-10deg)",
          },
        },
        auroraCore: {
          "0%": { transform: "translate(0, 0) scale(0.9)" },
          "50%": { transform: "translate(-10%, -6%) scale(1.2)" },
          "100%": { transform: "translate(8%, 10%) scale(1)" },
        },
        auroraWarm: {
          "0%": { transform: "translate(0, 0) scale(1.1) rotate(0deg)" },
          "50%": {
            transform: "translate(-14%, -12%) scale(0.9) rotate(-20deg)",
          },
          "100%": { transform: "translate(6%, -4%) scale(1.05) rotate(15deg)" },
        },
        // The dot grid creeps by one cell, then loops without a seam.
        gridCreep: {
          "0%": { transform: "translate(0, 0)" },
          "100%": { transform: "translate({spacing.8}, {spacing.8})" },
        },
        // A ring leaving the mark, like a ripple.
        halo: {
          "0%": { opacity: "0.9", transform: "scale(0.7)" },
          "100%": { opacity: "0", transform: "scale(1.9)" },
        },
        // The window of the house: lit once the outline is drawn, then
        // breathing while the shell builds.
        lampBreathing: {
          "0%, 100%": { opacity: "0.55" },
          "50%": { opacity: "1" },
        },
        lampLit: {
          "0%": { opacity: "0" },
          "100%": { opacity: "0.55" },
        },
        // A wordmark letter rising out of a blur.
        letterRise: {
          "0%": {
            filter: "blur({spacing.1})",
            opacity: "0",
            transform: "translateY({spacing.4})",
          },
          "100%": {
            filter: "blur(0)",
            opacity: "1",
            transform: "translateY(0)",
          },
        },
        // The house drawn as one stroke (`pathLength` 1).
        // main-thread animation: draws the mark's outline once; an SVG stroke's
        // dash has no compositor path.
        markDrawn: {
          "0%": { strokeDashoffset: "1" },
          "100%": { strokeDashoffset: "0" },
        },
        // The fill that settles in once the outline is drawn.
        // main-thread animation: fills the mark once; its outline and fill are
        // one path, so opacity would fade both.
        markFilled: {
          "0%": { fillOpacity: "0" },
          "100%": { fillOpacity: "1" },
        },
        // A line of text arriving: the status, the failure.
        rise: {
          "0%": { opacity: "0", transform: "translateY({spacing.2})" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        // A highlight running along the meter while a step is under way.
        shimmer: {
          "0%": { transform: "translateX(-100%)" },
          "100%": { transform: "translateX(400%)" },
        },
      },
      tokens: {
        durations: {
          // Drawing the mark's outline (`DRAW_MS` in `Splash.tsx`).
          draw: { value: "1.6s" },
          // One full orbit of the aurora.
          drift: { value: "24s" },
          // How long the splash shows "Ready" before it gives way to the
          // shell (`ENDING_MS` in `Splash.tsx`). Also the aurora's ease to
          // `danger` on a failure.
          ending: { value: "900ms" },
          // One ripple, and one breath of the lamp.
          halo: { value: "3.2s" },
          // One run of the meter's highlight.
          shimmer: { value: "1.8s" },
        },
        letterSpacings: {
          // Wide enough that the wordmark reads as a mark, not a word.
          wordmark: { value: "0.32em" },
        },
      },
    },
  },
});
