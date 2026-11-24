import type { Preset } from "@pandacss/dev";
import { definePreset, defineRecipe } from "@pandacss/dev";
import pandacssPreset from "@pandacss/dev/presets";
import { iconKeyframes } from "./_icon/icon-keyframes";
import type { Size } from "./control-sizes";
import { CONTROL_HEIGHT, CONTROL_PADDING_INLINE } from "./control-sizes";
import { SPACING_STEP_REM } from "./spacing";

// The two packages' Preset types differ but are compatible at runtime. The
// ts-expect-error fails once the types agree, so it can then be removed.
// @ts-expect-error preset shape mismatch between @pandacss/preset-panda and @pandacss/dev
const basePreset: Preset = pandacssPreset;

// Adds every quarter step up to `MAX_SPACING_STEP` to the spacing scale. The
// bound is high because numeric size props use this scale, and a missing step
// silently emits no style. Only referenced steps produce CSS.
const MAX_SPACING_STEP = 1000;
const SPACING_STEP_KEY_INCREMENT = 0.25;
const quarterStepSpacing = Object.fromEntries(
  Array.from(
    { length: MAX_SPACING_STEP / SPACING_STEP_KEY_INCREMENT + 1 },
    (_, i) => {
      const step = i * SPACING_STEP_KEY_INCREMENT;
      return [step.toString(), { value: `${step * SPACING_STEP_REM}rem` }];
    },
  ),
);

// `LevelToast` holds, then fades out over the last fifth.
const levelToastHold = {
  "0%": { opacity: "1" },
  "80%": { opacity: "1" },
  "100%": { opacity: "0" },
};

/** A color token as this preset writes it. */
type ColorToken = { value: string | Readonly<Record<string, unknown>> };

/**
 * Gives every color drawn from the palette its dark value inside a panel over
 * the wallpaper, which is dark in either theme. A mix is declared again there
 * too, since a custom property mixes the colors where it is declared, not
 * where it is used.
 */
const darkOverPhoto = <Colors extends Record<string, ColorToken>>(
  colors: Colors,
): Colors =>
  // `fromEntries` loses the keys' types; the names are unchanged.
  Object.fromEntries(
    Object.entries(colors).map(([name, token]) => {
      const dark =
        typeof token.value === "string" ? token.value : token.value.base;
      return typeof dark === "string" && dark.includes("{colors.")
        ? [
            name,
            {
              ...token,
              value: {
                ...(typeof token.value === "string"
                  ? { base: token.value }
                  : token.value),
                _onPhoto: dark,
              },
            },
          ]
        : [name, token];
    }),
  ) as Colors;

export const domicilePreset = definePreset({
  conditions: {
    extend: {
      activeEnabled: "&:active:not(:disabled):not([data-disabled])",
      // `theme.contrast` set to `high`, as `data-contrast="high"` on
      // `<html>`. Panda's own `_highContrast` matches forced colors instead.
      contrastHigh: "[data-contrast=high] &",
      // Inside a button or link that is pressed, such as an animated icon's
      // part.
      controlActive: ":is(button, a, [role=button]):active &",
      // Inside a button or link under the pointer, such as an animated icon's
      // part.
      controlHover: ":is(button, a, [role=button]):hover &",
      // A picked item keeps its fill under the pointer: the current page or
      // place, a selected tab or option, a checked row.
      hoverEnabled:
        "&:hover:not(:disabled):not([data-disabled]):not([aria-current]):not([aria-selected=true]):not([data-checked])",
      // Under the pointer, or while the popup it opened is open, so a bar
      // panel reads as coming from its button.
      hoverOrOpen: "&:is(:hover, [data-popup-open])",
      // Panda's default `_light` matches a `light` class; we use
      // `data-theme="light"` on `<html>`.
      light: "[data-theme=light] &",
      // A panel over the wallpaper, such as a bar's popover: dark whatever
      // the theme. See `darkOverPhoto`.
      onPhoto: "[data-tone=overPhoto] &",
      // Primary input is touch. Uses `pointer` because viewport width can't
      // tell a touchscreen monitor from a mouse-driven one.
      pointerCoarse: "@media (pointer: coarse)",
      // Touch on a tablet or larger screen: popups are centered overlays.
      touchOverlay: "@media (pointer: coarse) and (min-width: 640px)",
      // Touch on a phone-sized screen: popups are bottom sheets. 640px is
      // Panda's `sm` breakpoint and the boundary with `touchOverlay`.
      touchSheet: "@media (pointer: coarse) and (max-width: 639px)",
    },
  },
  // biome-ignore assist/source/useSortedKeys: Theme-toggle-wipe rules are kept grouped under their shared explanatory comment instead of being scattered alphabetically.
  globalCss: {
    // Theme change wipe: a view transition clips the new theme in over the
    // old. This avoids a global color `transition` that would override
    // element transitions. `data-theme-flip-to` on `<html>` sets the
    // direction: dark from the top, light from the bottom.
    //
    // Scoped to the wipe, so other view transitions, such as `load_shell`'s
    // handover from the splash, keep the browser's crossfade.
    "html[data-theme-flip-to]::view-transition-old(root)": {
      // Disable the default fade-out so only the wipe plays.
      animationName: "none",
    },
    "html[data-theme-flip-to]::view-transition-new(root)": {
      animationDuration: "{durations.wipe}",
      animationTimingFunction: "{easings.outQuart}",
      // The default `plus-lighter` blend leaves a bright seam at the clip
      // edge.
      mixBlendMode: "normal",
    },
    "html[data-theme-flip-to='dark']::view-transition-new(root)": {
      animationName: "themeSwipeFromTop",
    },
    "html[data-theme-flip-to='light']::view-transition-new(root)": {
      animationName: "themeSwipeFromBottom",
    },
    // Held at the start, so only the old frame shows, while windows repaint
    // behind it (`flipThemeWithAnimation`). Scoped to the wipe, so a hold can
    // never freeze another transition, such as the splash handover, partway.
    "html[data-theme-flip-to][data-theme-holding]::view-transition-new(root)": {
      animationPlayState: "paused",
    },
    // Disable element transitions during a theme change. Otherwise they are
    // mid-flight when the new snapshot is captured, so the snapshot shows the
    // old colors and the elements snap at the end. `!important` beats more
    // specific `transition` rules.
    "[data-theme-flipping] *, [data-theme-flipping] *::before, [data-theme-flipping] *::after":
      {
        transition: "none !important",
      },
    // `theme.reduced_motion`, as `data-reduced-motion` on `<html>`: every
    // animation and transition, the theme wipe's included, runs once at the
    // shortest duration, and without delay, so a staggered change lands at
    // once. Shortened rather than removed so `animationend` and
    // `transitionend` still fire.
    "[data-reduced-motion] *, [data-reduced-motion] *::before, [data-reduced-motion] *::after":
      {
        animationDelay: "0s !important",
        animationDuration: "{durations.fastest} !important",
        animationIterationCount: "1 !important",
        transitionDelay: "0s !important",
        transitionDuration: "{durations.fastest} !important",
      },
    "html[data-reduced-motion]::view-transition-group(*), html[data-reduced-motion]::view-transition-old(*), html[data-reduced-motion]::view-transition-new(*)":
      {
        animationDuration: "{durations.fastest} !important",
      },
    html: {
      "::selection": {
        backgroundColor: "accent",
        color: "background",
      },
      "*": {
        "&::-webkit-scrollbar": {
          blockSize: 2,
          inlineSize: 2,
        },
        "&::-webkit-scrollbar-corner": {
          backgroundColor: "transparent",
        },
        "&::-webkit-scrollbar-thumb": {
          backgroundColor: "border",
          borderRadius: "full",
          transition: "background-color {durations.fast} {easings.out}",
        },
        "&::-webkit-scrollbar-thumb:active": {
          backgroundColor: "foreground",
        },
        "&::-webkit-scrollbar-thumb:hover": {
          backgroundColor: "muted",
        },
        "&::-webkit-scrollbar-track": {
          backgroundColor: "transparent",
        },
        outlineColor: {
          _focusVisible: "accent",
          base: "transparent",
        },
        outlineOffset: 0.5,
        // Only where it can show: Blink repaints an element with an outline,
        // even a transparent one, every time it moves.
        outlineStyle: {
          _focusVisible: "solid",
          base: "none",
        },
        outlineWidth: 2,
        scrollbarColor: "{colors.border} transparent",
        scrollbarWidth: "thin",
      },
      "&[data-theme=light]": { colorScheme: "light" },
      backgroundColor: "background",
      color: "foreground",
      colorScheme: "dark",
      fontFamily: "body",
    },
  },
  name: "domicile",
  presets: [basePreset],
  theme: {
    extend: {
      keyframes: {
        ...iconKeyframes,
        // `LevelToast`'s entrance, once per showing.
        levelToastEnter: {
          "0%": {
            opacity: "0",
            transform: "translateY({spacing.3}) scale(0.96)",
          },
          "100%": { opacity: "1", transform: "none" },
        },
        // `LevelToast`'s hold and fade-out. Two copies so a change can
        // restart it by switching names.
        levelToastHold,
        levelToastHoldAgain: levelToastHold,
        // `Notice`: appears quickly, holds long enough to read, then fades
        // out on its own.
        noticeShown: {
          "0%": {
            opacity: "0",
            transform: "translateY(calc(-1 * {spacing.1}))",
          },
          "10%": { opacity: "1", transform: "translateY(0)" },
          "75%": { opacity: "1" },
          "100%": { opacity: "0" },
        },
        // A ring that spreads out from a searching panel's icon and fades,
        // like radar.
        ping: {
          "0%": { opacity: "0.55", transform: "scale(0.6)" },
          "100%": { opacity: "0", transform: "scale(1.9)" },
        },
        pulse: {
          "0%": { opacity: "0.3" },
          "50%": { opacity: "0.7" },
          "100%": { opacity: "0.3" },
        },
        // A loading spinner. `pulse` is for a busy control instead.
        spin: {
          "0%": { transform: "rotate(0deg)" },
          "100%": { transform: "rotate(360deg)" },
        },
        themeSwipeFromBottom: {
          "0%": { clipPath: "inset(100% 0 0 0)" },
          "100%": { clipPath: "inset(0 0 0 0)" },
        },
        themeSwipeFromTop: {
          "0%": { clipPath: "inset(0 0 100% 0)" },
          "100%": { clipPath: "inset(0 0 0 0)" },
        },
        // The countdown bar in `Toaster`.
        toastCountdown: {
          "0%": { transform: "scaleX(1)" },
          "100%": { transform: "scaleX(0)" },
        },
      },
      recipes: {
        control: defineRecipe({
          base: {
            alignItems: "center",
            display: "inline-flex",
            flexDirection: "row",
            justifyContent: "center",
            // Always, so the focus ring fades out with `outline-color`.
            outlineStyle: "solid",
            transition: `
              color {durations.fastest} {easings.linear},
              border-color {durations.fastest} {easings.linear},
              background-color {durations.fastest} {easings.linear},
              outline-color {durations.fast} {easings.linear},
              opacity {durations.slow} {easings.out},
              filter {durations.slow} {easings.out}
            `,
          },
          className: "control",
          // Lets Panda extract `size` from props such as `<Button size="sm">`.
          // It can't see runtime calls like `control({ size })`.
          jsx: ["Button", "Input", "Select", "Textarea"],
          variants: {
            // biome-ignore assist/source/useSortedKeys: The sort order is useful here
            size: {
              xs: {
                blockSize: CONTROL_HEIGHT.xs,
                borderRadius: "sm",
                fontSize: "xs",
                gap: 1,
                minBlockSize: CONTROL_HEIGHT.xs,
                paddingInline: CONTROL_PADDING_INLINE.xs,
              },
              sm: {
                blockSize: CONTROL_HEIGHT.sm,
                borderRadius: "sm",
                fontSize: "sm",
                gap: 1.5,
                minBlockSize: CONTROL_HEIGHT.sm,
                paddingInline: CONTROL_PADDING_INLINE.sm,
              },
              md: {
                blockSize: CONTROL_HEIGHT.md,
                borderRadius: "md",
                fontSize: "md",
                gap: 2,
                minBlockSize: CONTROL_HEIGHT.md,
                paddingInline: CONTROL_PADDING_INLINE.md,
              },
              lg: {
                blockSize: CONTROL_HEIGHT.lg,
                borderRadius: "lg",
                fontSize: "lg",
                gap: 2.5,
                minBlockSize: CONTROL_HEIGHT.lg,
                paddingInline: CONTROL_PADDING_INLINE.lg,
              },
              xl: {
                blockSize: CONTROL_HEIGHT.xl,
                borderRadius: "lg",
                fontSize: "xl",
                gap: 3,
                minBlockSize: CONTROL_HEIGHT.xl,
                paddingInline: CONTROL_PADDING_INLINE.xl,
              },
              "2xl": {
                blockSize: CONTROL_HEIGHT["2xl"],
                borderRadius: "xl",
                fontSize: "2xl",
                gap: 4,
                minBlockSize: CONTROL_HEIGHT["2xl"],
                paddingInline: CONTROL_PADDING_INLINE["2xl"],
              },
              "3xl": {
                blockSize: CONTROL_HEIGHT["3xl"],
                borderRadius: "2xl",
                fontSize: "3xl",
                gap: 5.5,
                minBlockSize: CONTROL_HEIGHT["3xl"],
                paddingInline: CONTROL_PADDING_INLINE["3xl"],
              },
              "4xl": {
                blockSize: CONTROL_HEIGHT["4xl"],
                borderRadius: "3xl",
                fontSize: "4xl",
                gap: 7.5,
                minBlockSize: CONTROL_HEIGHT["4xl"],
                paddingInline: CONTROL_PADDING_INLINE["4xl"],
              },
            } satisfies Record<Size, unknown>,
          },
        }),
      },
      semanticTokens: {
        // `base` is dark; `_light` applies under `data-theme="light"`.
        //
        // Only foreground, background, accent, danger, private, success and
        // warning have per-theme values. The rest are `color-mix(...)` of
        // those, so they follow the theme.
        //
        // `_contrastHigh` moves text to the palette's ends and leans the
        // mixed grays toward the foreground.
        colors: darkOverPhoto({
          accent: {
            // Steps differ per theme so each has enough contrast with its
            // background. `pandacss-preset.test.ts` checks this.
            value: { _light: "{colors.cyan.700}", base: "{colors.cyan.500}" },
          },
          backdrop: {
            // Black works in both themes.
            value: "rgb(from black r g b / 70%)",
          },
          background: {
            value: {
              _light: "{colors.neutral.50}",
              base: "{colors.neutral.900}",
            },
          },
          border: {
            value: {
              _contrastHigh:
                "color-mix(in oklab, {colors.foreground} 45%, {colors.background})",
              base: "color-mix(in oklab, {colors.foreground} 18%, {colors.background})",
            },
          },
          borderStrong: {
            value: {
              _contrastHigh:
                "color-mix(in oklab, {colors.foreground} 60%, {colors.background})",
              base: "color-mix(in oklab, {colors.foreground} 25%, {colors.background})",
            },
          },
          card: {
            value:
              "color-mix(in oklab, {colors.foreground} 6%, {colors.background})",
          },
          danger: {
            value: { _light: "{colors.red.600}", base: "{colors.red.500}" },
          },
          dangerSoft: {
            value:
              "color-mix(in oklab, {colors.danger} 70%, {colors.background})",
          },
          // `divider`, `fill`, `fillHover`, `textFaint` and `textSoft` are
          // drawn from `currentcolor`, so they read on any surface: a card,
          // a panel over the wallpaper, an accent tile. See "Panels" in
          // docs/guidelines/STYLING.md.
          divider: {
            value: "color-mix(in oklab, currentcolor 12%, transparent)",
          },
          // A tile, row or card resting on a panel.
          fill: {
            value: "color-mix(in oklab, currentcolor 8%, transparent)",
          },
          fillHover: {
            value: "color-mix(in oklab, currentcolor 14%, transparent)",
          },
          // A bar button lit under the pointer or while its panel is open.
          fillOverPhoto: {
            value: "color-mix(in oklab, white 16%, transparent)",
          },
          foreground: {
            value: {
              _contrastHigh: "{colors.neutral.50}",
              _light: {
                _contrastHigh: "{colors.neutral.950}",
                base: "{colors.neutral.900}",
              },
              base: "{colors.neutral.200}",
            },
          },
          muted: {
            value: {
              _contrastHigh:
                "color-mix(in oklab, {colors.foreground} 80%, {colors.background})",
              // Readable on a tile on a card; `pandacss-preset.test.ts`
              // checks this.
              base: "color-mix(in oklab, {colors.foreground} 65%, {colors.background})",
            },
          },
          // Text on a `danger` fill. Theme-independent, so it reads the same
          // on the red in either theme.
          onDanger: {
            value: "white",
          },
          // Text and panels drawn over the wallpaper. Theme-independent
          // because the wallpaper doesn't change with the theme.
          onPhoto: {
            value: "white",
          },
          // Dark enough that `textFaint` stays readable over white, which a
          // bright wallpaper or website can put behind it in either theme;
          // `pandacss-preset.test.ts` checks this.
          panelOverPhoto: {
            value: "rgb(from black r g b / 75%)",
          },
          // Marks a private browser window. Distinct from `accent`, which
          // marks focus and selection everywhere.
          private: {
            value: {
              _light: "{colors.violet.700}",
              base: "{colors.violet.400}",
            },
          },
          skeleton: {
            value:
              "color-mix(in oklab, {colors.foreground} 25%, {colors.background})",
          },
          success: {
            value: { _light: "{colors.green.700}", base: "{colors.green.500}" },
          },
          // Section labels, quieter than `textSoft`.
          textFaint: {
            value: "color-mix(in oklab, currentcolor 65%, transparent)",
          },
          // A row's or tile's second line, and figures beside a control.
          textSoft: {
            value: "color-mix(in oklab, currentcolor 75%, transparent)",
          },
          warning: {
            value: { _light: "{colors.amber.700}", base: "{colors.amber.500}" },
          },
        }),
        shadows: {
          // A soft shadow for floating surfaces such as popups. Lighter in
          // light mode, where the dark value looks heavy.
          lifted: {
            value: {
              _light: "0 6px 24px rgb(from black r g b / 15%)",
              base: "0 6px 24px rgb(from black r g b / 50%)",
            },
          },
          modal: {
            value: "0 20px 48px rgb(from black r g b / 60%)",
          },
          // A text shadow for light text over the wallpaper. Tight and dark
          // because a blurred shadow under small text looks smudged.
          // Theme-independent, like `onPhoto`.
          textOverPhoto: {
            value: "0 1px 2px rgb(from black r g b / 80%)",
          },
        },
      },
      // The type of panels: a popover's or a drawer's controls and lists. A
      // label and its detail differ in size and color, not weight, so they
      // keep their look on a font with no semibold face.
      textStyles: {
        panelDetail: {
          value: { fontSize: "xs", fontWeight: "normal", lineHeight: "tight" },
        },
        panelLabel: {
          value: { fontSize: "sm", fontWeight: "medium", lineHeight: "tight" },
        },
        panelOverline: {
          value: {
            fontSize: "0.6875rem",
            fontWeight: "semibold",
            letterSpacing: "wide",
            lineHeight: "tight",
            textTransform: "uppercase",
          },
        },
        panelTitle: {
          value: {
            fontSize: "sm",
            fontWeight: "semibold",
            lineHeight: "tight",
          },
        },
      },
      tokens: {
        borderWidths: {
          // A text stroke painted under the glyphs (`paintOrder: "stroke"`)
          // to look semibold without a wider font weight shifting layout.
          fauxBold: { value: "0.05em" },
          // As `fauxBold`, but about as heavy as a medium weight.
          fauxMedium: { value: "0.025em" },
        },
        durations: {
          // Wallpaper crossfade. Long because nothing waits on it.
          crossfade: { value: "2s" },
          // How long a `LevelToast` stays up after its last change.
          levelToast: { value: "2s" },
          // How long a `Notice` stays up. Longer than the scale above, which
          // is for control feedback, not reading.
          notice: { value: "1.5s" },
          // One ring of `ping`. Two run half a ring apart.
          ping: { value: "2s" },
          pulse: { value: "1.5s" },
          // One turn of `spin`. A slower spinner looks stuck.
          spin: { value: "1s" },
          // The theme change wipe.
          wipe: { value: "1.6s" },
        },
        easings: {
          // For long movements, such as a workspace switch or the lock
          // screen's entrance. `outQuart` starts at full speed, which looks
          // like a jump over a screen's width.
          emphasized: { value: "cubic-bezier(0.2, 0, 0, 1)" },
          // Ease-out with a small overshoot, for a landing bounce.
          outBack: { value: "cubic-bezier(0.34, 1.8, 0.64, 1)" },
          // easeOutQuart, for settling animations where `easings.out` feels
          // too linear.
          outQuart: { value: "cubic-bezier(0.25, 1, 0.5, 1)" },
        },
        fontSizes: {
          // The desktop's one text size, 13px: bar items, tab and window
          // titles, the address bar. Between `xs` and `sm`.
          ui: { value: "0.8125rem" },
        },
        fonts: {
          // The desktop's face: `--desktop-font`, which a shell sets from its
          // options (see `applyFont`), then Inter, which `fonts/inter.css`
          // ships, so text looks the same on every computer.
          body: {
            value:
              "var(--desktop-font, Inter), Inter, ui-sans-serif, system-ui, sans-serif",
          },
          mono: {
            value:
              "ui-monospace, 'SF Mono', 'JetBrains Mono', Menlo, Monaco, Consolas, monospace",
          },
        },
        gradients: {
          // A dark band behind light text at the top of the wallpaper, for
          // when `shadows.textOverPhoto` is not enough. The 65% stop keeps the
          // text row dark before the fade. Theme-independent, like `onPhoto`.
          //
          // Make the band taller than the text so the fade has room below
          // it.
          scrimOverPhoto: {
            value:
              "linear-gradient(to bottom, rgb(from black r g b / 85%), rgb(from black r g b / 55%) 65%, transparent)",
          },
        },
        opacity: {
          disabled: { value: "0.6" },
          // Fades a dragged element so the drop target shows through.
          dragging: { value: "0.4" },
          // Fades a bar item that is off, muted or offline, so the state reads
          // at a glance over the wallpaper.
          inactive: { value: "0.35" },
          pulseMin: { value: "0.3" },
        },
        // Without this, Panda treats numeric sizes as pixels
        // (`inlineSize: 65` would be `65px`, not `16.25rem`).
        sizes: quarterStepSpacing,
        spacing: quarterStepSpacing,
        zIndex: {
          // Above everything, so an open panel can't be used while locked and
          // the veil blurs the whole desk. The highest z-index there is, since
          // a shell stacks its windows at depths of its own.
          lock: { value: "2147483647" },
          // Popups and dialogs: over every window, a fullscreen one's
          // included, for the same reason.
          modal: { value: "2147483646" },
          modalBackdrop: { value: "2147483645" },
          // Below windows a shell raises, such as a fullscreen one, and
          // below modals so it never covers a dialog.
          toast: { value: "199" },
        },
      },
    },
  },
});
