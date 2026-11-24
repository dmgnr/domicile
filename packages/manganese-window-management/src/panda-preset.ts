import { definePreset } from "@pandacss/dev";

// A float swapping depth with one it overlaps: it moves apart, swaps depth at
// the furthest point, and moves back. See `shuffledBy` and `restacking.ts`.
//
// The move and the depth are two animations. The compositor thread can run the
// move only if `z-index` is not in it.
//
// Each is defined once and registered under two names; see `nextShuffle`.
const RESTACKING = {
  "0%": { transform: "translate(0, 0)" },
  "50%": { transform: "translate(var(--restack-x), var(--restack-y))" },
  "100%": { transform: "translate(0, 0)" },
};

// The new depth is set at 51% so it lands right after the furthest point.
// Interpolated from 50% to 100%, it would change too late, after the windows
// overlap again.
// main-thread animation: steps the depth once at 51%; nothing eases.
const RESTACKING_DEPTH = {
  "0%, 50%": { zIndex: "var(--restack-from)" },
  "51%, 100%": { zIndex: "var(--restack-to)" },
};

// The scratchpad is a drop-down: a window shown from it slides down from above
// the screen's top edge, `--lift` away (see `slidAcross`). It is clear of the
// edge only in the last stretch, so it fades in there and does not show on a
// screen above. Played backwards, it stows the window again. Registered under
// two names so one restarts the other; see `movingStyles`.
const SCRATCHPAD_SLIDE = {
  "0%": {
    opacity: "0",
    transform: "translateY(calc(-1 * var(--lift)))",
  },
  "15%": { opacity: "1" },
  "100%": { opacity: "1", transform: "translateY(0)" },
};

/**
 * The ring and shadow an opening or closing tab's contents carry, or
 * `--tab-edge` where they would spill off the screen (see `unedgedOn`).
 */
const TAB_EDGE =
  "var(--tab-edge, 0 0 0 1px {colors.borderStrong}, {shadows.lifted})";

// The scratchpad backdrop fades in with a window's drop, and out with its
// stow by playing this backwards. Two names for the same reason as
// `SCRATCHPAD_SLIDE`.
const BACKDROP_FADE = {
  "0%": { opacity: "0" },
  "100%": { opacity: "1" },
};

/** Keyframes and tokens for windows: opening, closing, restacking, workspace switches and the scratchpad. */
export const windowManagementPreset = definePreset({
  name: "@domicile-desktop/manganese-window-management",
  theme: {
    extend: {
      keyframes: {
        backdropHiding: BACKDROP_FADE,
        backdropShowing: BACKDROP_FADE,
        // A drop indicator's box fades out where it was as the line between
        // two tabs fades in; see `DropIndicator`.
        dropBoxFading: {
          "0%": { opacity: "1" },
          "100%": { opacity: "0" },
        },
        dropLineShowing: BACKDROP_FADE,
        // The overview's backdrop, names and picker rings fade in as it
        // opens; the backdrop fades out by `overviewHiding`. See `overview/`.
        overviewHiding: BACKDROP_FADE,
        overviewShowing: BACKDROP_FADE,
        // A video in picture-in-picture grows out of its place in its page,
        // and shrinks back into it (see `PictureInPictureFloats`).
        pictureInPictureGrowing: {
          "0%": {
            transform:
              "translate(var(--pip-x), var(--pip-y)) scale(var(--pip-scale))",
          },
          "100%": { transform: "none" },
        },
        // Once its video left: it fades where it is, in its page's place
        // when it shrank back there.
        pictureInPictureLeaving: {
          "0%": {
            opacity: "1",
            transform:
              "translate(var(--pip-x, 0px), var(--pip-y, 0px)) scale(var(--pip-scale, 1))",
          },
          "100%": {
            opacity: "0",
            transform:
              "translate(var(--pip-x, 0px), var(--pip-y, 0px)) scale(var(--pip-scale, 1))",
          },
        },
        pictureInPictureReturning: {
          "0%": { transform: "none" },
          "100%": {
            transform:
              "translate(var(--pip-x), var(--pip-y)) scale(var(--pip-scale))",
          },
        },
        // Its shadow fades in and out with it, on a layer of its own.
        pictureInPictureShadowIn: {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        pictureInPictureShadowOut: {
          "0%": { opacity: "1" },
          "100%": { opacity: "0" },
        },
        // A workspace switch slides every window on the workspace by one
        // screen width (`--workspace-width`; see `slidAcross`). The arriving
        // workspace starts where the leaving one ends, so they never overlap
        // and nothing needs to fade.
        windowArrivingFromEnd: {
          "0%": { transform: "translateX(var(--workspace-width))" },
          "100%": { transform: "translateX(0)" },
        },
        windowArrivingFromStart: {
          "0%": {
            transform: "translateX(calc(-1 * var(--workspace-width)))",
          },
          "100%": { transform: "translateX(0)" },
        },
        // The reverse of `windowOpening`. It shrinks only to 0.85 rather than
        // to nothing; the fade does most of the work.
        windowClosing: {
          "0%": { opacity: "1", transform: "scale(1)" },
          "100%": { opacity: "0", transform: "scale(0.85)" },
        },
        // A closing tab collapses along its strip: `--collapse-x` in a tabbed
        // container, `--collapse-y` in a stack; see `collapsedAlong`.
        //
        // Only the bar plays it. A closing tab's contents shrink into it with
        // `windowClosingIntoTab` over the tab drawn underneath at the same box
        // (see `movingStyles`).
        // A closing tab's contents shrink into its tab and fade, about the tab
        // (see `contentsScaledAbout`).
        windowClosingIntoTab: {
          "0%": { opacity: "1", transform: "scale(1)" },
          "100%": { opacity: "0", transform: "scale(0.15)" },
        },
        windowClosingTab: {
          "0%": { opacity: "1", transform: "scale(1, 1)" },
          "100%": {
            opacity: "0",
            transform: "scale(var(--collapse-x, 1), var(--collapse-y, 1))",
          },
        },
        // Fades in as the contents start to shrink, so the shadow does not
        // appear in one frame.
        // main-thread animation: the tab edge is drawn on the window element
        // itself, which holds no layer to fade instead; it runs only while a
        // tab opens or closes.
        windowClosingTabEdge: {
          "0%": { boxShadow: "none" },
          "30%": { boxShadow: TAB_EDGE },
          "100%": { boxShadow: TAB_EDGE },
        },
        // A tab switch: the revealed tab fades in over the hidden one; see
        // `tab-switch.ts`.
        //
        // Both hold a fixed depth throughout (see `placement.ts`). Otherwise
        // the hidden tab would keep the shown tab's depth until the fade ends
        // (`settlingStyles`) and could draw over the tab being revealed.
        // main-thread animation: holds a fixed depth for the motion; the value
        // never changes, so nothing repaints.
        windowConcealing: {
          "0%": { zIndex: "-1" },
          "100%": { zIndex: "-1" },
        },
        windowDropping: SCRATCHPAD_SLIDE,
        // Holds a window at the tiled depth. The tab a close uncovers, and the
        // tab a switch reveals, keep it while the other tab fades over or
        // under them, whatever `settlingStyles` does with their depth, so no
        // other hidden tab shows through.
        // main-thread animation: holds a fixed depth for the motion; the value
        // never changes, so nothing repaints.
        windowHeldTiled: {
          "0%": { zIndex: "0" },
          "100%": { zIndex: "0" },
        },
        // The workspace being left slides out by one screen width.
        windowLeavingToEnd: {
          "0%": { transform: "translateX(0)" },
          "100%": { transform: "translateX(var(--workspace-width))" },
        },
        windowLeavingToStart: {
          "0%": { transform: "translateX(0)" },
          "100%": {
            transform: "translateX(calc(-1 * var(--workspace-width)))",
          },
        },
        // A window opening fades and scales up to its laid-out box.
        //
        // Uses a transform, not the box size: an `<app>`'s box sets its
        // client's configured size, so resizing it would make the client
        // redraw every frame.
        //
        // The bar and contents are separate elements, so each gets an inline
        // `transform-origin` at the frame's center; see `scaledAbout`.
        windowOpening: {
          "0%": { opacity: "0", transform: "scale(0.85)" },
          "100%": { opacity: "1", transform: "scale(1)" },
        },
        // The reverse of `windowClosingIntoTab`.
        windowOpeningFromTab: {
          "0%": { opacity: "0", transform: "scale(0.15)" },
          "100%": { opacity: "1", transform: "scale(1)" },
        },
        // The reverse of `windowClosingTab`: a new tab opens out along its
        // strip. Only the bar plays it; the contents grow out of it with
        // `windowOpeningFromTab` over the tab they hide (see `movingStyles`).
        windowOpeningTab: {
          "0%": {
            opacity: "0",
            transform: "scale(var(--collapse-x, 1), var(--collapse-y, 1))",
          },
          "100%": { opacity: "1", transform: "scale(1, 1)" },
        },
        // Fades out as the contents settle, so the shadow does not vanish in
        // one frame.
        // main-thread animation: the tab edge is drawn on the window element
        // itself, which holds no layer to fade instead; it runs only while a
        // tab opens or closes.
        windowOpeningTabEdge: {
          "0%": { boxShadow: TAB_EDGE },
          "70%": { boxShadow: TAB_EDGE },
          "100%": { boxShadow: "none" },
        },
        windowRestacking: RESTACKING,
        windowRestackingAgain: RESTACKING,
        windowRestackingDepth: RESTACKING_DEPTH,
        windowRestackingDepthAgain: RESTACKING_DEPTH,
        windowRevealing: {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        // A window sent to a workspace no screen shows. It shrinks further
        // than `windowClosing`, so it does not look closed.
        windowSending: {
          "0%": { opacity: "1", transform: "scale(1)" },
          "100%": { opacity: "0", transform: "scale(0.6)" },
        },
        windowStowing: SCRATCHPAD_SLIDE,
      },
      semanticTokens: {
        colors: {
          // The open tab and the browser toolbar under it, one surface. White
          // in light mode, so it stands clear of the darker `tabRail`.
          chrome: {
            value: {
              _light: "{colors.white}",
              base: "color-mix(in oklab, {colors.foreground} 14%, {colors.background})",
            },
          },
          // A tab strip behind its tabs.
          tabRail: {
            value: {
              _light:
                "color-mix(in oklab, {colors.foreground} 10%, {colors.background})",
              base: "color-mix(in oklab, {colors.card} 45%, {colors.background})",
            },
          },
        },
      },
    },
  },
});
