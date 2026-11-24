import { domicilePreset } from "@domicile-desktop/component-library/pandacss-preset";
import { defineConfig } from "@pandacss/dev";

export default defineConfig({
  exclude: [],
  globalCss: {
    "html, body": {
      blockSize: "100%",
    },
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
        // The glow behind the header, drifting so the page never sits still.
        glowDrift: {
          "0%": { transform: "translate(0, 0) scale(1)" },
          "50%": { transform: "translate(6%, 10%) scale(1.12)" },
          "100%": { transform: "translate(-4%, 4%) scale(0.96)" },
        },
        // The empty state's picture, bobbing.
        hover: {
          "0%, 100%": { transform: "translateY(0)" },
          "50%": { transform: "translateY(calc({spacing.1.5} * -1))" },
        },
        // A row, section or panel arriving.
        rise: {
          "0%": { opacity: "0", transform: "translateY({spacing.1.5})" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        // A removed row: fades and slides away while its height closes.
        // main-thread animation: a removed row's height closes once, so the
        // rows below close up.
        rowLeave: {
          "0%": {
            gridTemplateRows: "1fr",
            opacity: "1",
            transform: "translateX(0)",
          },
          "100%": {
            gridTemplateRows: "0fr",
            opacity: "0",
            transform: "translateX({spacing.6})",
          },
        },
        // The highlight sweeping across a loading skeleton.
        shimmer: {
          "0%": { transform: "translateX(-100%)" },
          "100%": { transform: "translateX(100%)" },
        },
      },
      tokens: {
        durations: {
          // One drift of the header glow.
          drift: { value: "18s" },
          // One bob of the empty state's picture.
          hover: { value: "4s" },
          // One sweep of the skeleton highlight.
          shimmer: { value: "1.6s" },
        },
      },
    },
  },
});
