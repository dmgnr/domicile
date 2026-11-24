// The splash: an aurora over a dot grid, the house mark drawing itself, the
// wordmark, and the build's progress, once per display.

import { DisplayProvider } from "@domicile-desktop/component-library/DisplayProvider";
import { Screen } from "@domicile-desktop/component-library/Screen";
import type { Domicile } from "@domicile-desktop/sdk/desktop/desktop";
import type { CSSProperties } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { css } from "../styled-system/css";
import { center, hstack, vstack } from "../styled-system/patterns";
import { followProgress } from "./follow-progress";
import { hostDisplays } from "./host-displays";
import { Progress, Stage } from "./progress";
import { writeEnded } from "./write-ended";

const WORDMARK = "domicile";

/** The build's steps, as the meter's legend names them. */
const STEPS = ["Read", "Install", "Bundle"] as const;

/** How long the mark takes to draw: the `draw` duration in `panda.config.ts`. */
const DRAW_MS = 1600;

/** How long "Ready" shows: the `ending` duration in `panda.config.ts`. */
const ENDING_MS = 900;

type Props = {
  readonly domicile: Domicile;
  /** Says the splash is ready to give way; see `writeEnded`. */
  readonly end?: typeof writeEnded;
  /** Delivers the build's progress; see `followProgress`. */
  readonly follow?: typeof followProgress;
};

export const Splash = ({
  domicile,
  end = writeEnded,
  follow = followProgress,
}: Props) => {
  const displays = useMemo(() => hostDisplays(domicile), [domicile]);
  const [progress, setProgress] = useState<Progress>(Progress.Starting());
  // When the splash first drew. The shell can be built before that.
  const [shownAt, setShownAt] = useState<number | undefined>(undefined);
  const shown = useCallback(() => {
    setShownAt((at) => at ?? Date.now());
  }, []);
  // Each poll parses a new `progress`, so the ending keys on the path.
  const ended = progress.stage === Stage.Built ? progress.ended : undefined;

  useEffect(() => follow(setProgress), [follow]);

  useEffect(() => loggingOutOnAKey(domicile, progress), [domicile, progress]);

  useEffect(
    () => givingWay(domicile, ended, shownAt, end),
    [domicile, ended, shownAt, end],
  );

  return (
    <DisplayProvider source={displays}>
      <Screen everywhere>
        <Shown onShown={shown} />
        <Scene progress={progress} />
      </Screen>
    </DisplayProvider>
  );
};

/** Calls `onShown` once it has rendered, which is once a display is known. */
const Shown = ({ onShown }: { readonly onShown: () => void }) => {
  useEffect(onShown, [onShown]);
  return undefined;
};

/** Everything one display shows. */
const Scene = ({ progress }: { readonly progress: Progress }) => (
  <div className={sceneStyles} data-stage={stageName(progress.stage)}>
    <div aria-hidden className={auroraStyles}>
      <span className={glowStyles} data-glow="cool" />
      <span className={glowStyles} data-glow="warm" />
      <span className={glowStyles} data-glow="deep" />
      <span className={glowStyles} data-glow="core" />
    </div>
    <div aria-hidden className={gridStyles}>
      <div className={gridDotsStyles} />
    </div>
    <div aria-hidden className={vignetteStyles} />
    <div className={contentStyles} data-content="">
      <Mark />
      <h1 aria-label={WORDMARK} className={wordmarkStyles}>
        {[...WORDMARK].map((letter, index) => (
          <span
            aria-hidden
            className={letterStyles}
            key={index}
            style={{ "--letter": index } as CSSProperties}
          >
            {letter}
          </span>
        ))}
      </h1>
      <p className={statusStyles} key={saying(progress)} role="status">
        {saying(progress)}
      </p>
      {progress.stage === Stage.Failed ? (
        <Failure why={progress.why} />
      ) : (
        <Meter stage={progress.stage} />
      )}
    </div>
  </div>
);

/** The house, drawn as one stroke, with a lamp lit in its window. */
const Mark = () => (
  <div className={markStyles}>
    <span aria-hidden className={haloStyles} />
    <span aria-hidden className={haloStyles} data-later="" />
    <svg
      aria-hidden
      className={houseStyles}
      fill="none"
      viewBox="0 0 64 64"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        className={outlineStyles}
        d="M10 30 L32 11 L54 30 V53 Q54 55 52 55 H12 Q10 55 10 53 Z"
        pathLength={1}
        strokeWidth={2.5}
      />
      <path
        className={outlineStyles}
        d="M27 55 V42 Q27 40 29 40 H35 Q37 40 37 42 V55"
        data-door=""
        pathLength={1}
        strokeWidth={2.5}
      />
      <rect
        className={lampStyles}
        height="7"
        rx="1.5"
        width="7"
        x="28.5"
        y="25"
      />
    </svg>
  </div>
);

/** A line that fills as the build moves through its steps. */
const Meter = ({ stage }: { readonly stage: Stage }) => (
  <div className={meterStyles}>
    <div
      aria-label="Building the shell"
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={Math.round(reach(stage) * 100)}
      className={trackStyles}
      role="progressbar"
    >
      <div
        className={fillStyles}
        style={{ "--reach": reach(stage) } as CSSProperties}
      />
    </div>
    <ol className={stepsStyles}>
      {STEPS.map((step, index) => (
        <li
          className={stepStyles}
          data-state={stepState(index, stage)}
          key={step}
        >
          <span aria-hidden className={dotStyles} />
          {step}
        </li>
      ))}
    </ol>
  </div>
);

/** Why the build failed, and the way out. */
const Failure = ({ why }: { readonly why: string }) => (
  <div className={failureStyles}>
    <pre className={whyStyles}>{why}</pre>
    <p className={hintStyles}>
      Press any key to log out. Fix the shell, then log in again.
    </p>
  </div>
);

/**
 * After a failed build, stops `domicile` on any key, which logs out. Returns
 * the listener's teardown, or `undefined` while the build has not failed.
 */
const loggingOutOnAKey = (
  domicile: Domicile,
  progress: Progress,
): (() => void) | undefined =>
  progress.stage === Stage.Failed
    ? stoppingOnAKey(domicile, progress.supervisor)
    : undefined;

const stoppingOnAKey = (
  domicile: Domicile,
  supervisor: number,
): (() => void) => {
  const stop = () => {
    domicile.processes.launch(["kill", "-TERM", String(supervisor)]);
  };
  window.addEventListener("keydown", stop);
  return () => {
    window.removeEventListener("keydown", stop);
  };
};

/**
 * Once the shell is built and the splash has drawn, writes `ended` after the
 * mark has drawn and "Ready" has shown. Returns the timer's teardown, or
 * `undefined` while there is nothing to end.
 */
const givingWay = (
  domicile: Domicile,
  ended: string | undefined,
  shownAt: number | undefined,
  end: typeof writeEnded,
): (() => void) | undefined =>
  ended === undefined || shownAt === undefined
    ? undefined
    : endingAfter(Math.max(ENDING_MS, shownAt + DRAW_MS - Date.now()), () =>
        end(domicile, ended),
      );

const endingAfter = (delay: number, end: () => Promise<void>): (() => void) => {
  const timer = setTimeout(() => {
    end().catch((error: unknown) => {
      // biome-ignore lint/suspicious/noConsole: `domicile` loads the shell over the splash after its own wait, so the log is all that can say why
      console.error("could not say the splash ended", error);
    });
  }, delay);
  return () => {
    clearTimeout(timer);
  };
};

/** The `data-stage` the styles below key on. */
const stageName = (stage: Stage): string => {
  switch (stage) {
    case Stage.Starting:
      return "starting";
    case Stage.Resolving:
      return "resolving";
    case Stage.Installing:
      return "installing";
    case Stage.Bundling:
      return "bundling";
    case Stage.Built:
      return "built";
    case Stage.Failed:
      return "failed";
  }
};

const saying = (progress: Progress): string => {
  switch (progress.stage) {
    case Stage.Starting:
      return "Getting ready";
    case Stage.Resolving:
      return "Reading what your shell imports";
    case Stage.Installing:
      return `Installing ${progress.packages.join(", ")}`;
    case Stage.Bundling:
      return "Bundling your shell";
    case Stage.Built:
      return "Ready";
    case Stage.Failed:
      return "Your shell did not build";
  }
};

/** How far along the meter `stage` is, from 0 to 1. */
const reach = (stage: Stage): number => {
  switch (stage) {
    case Stage.Starting:
      return 0.06;
    case Stage.Resolving:
      return 0.28;
    case Stage.Installing:
      return 0.55;
    case Stage.Bundling:
      return 0.82;
    case Stage.Built:
    case Stage.Failed:
      return 1;
  }
};

/** Which step of the legend `stage` is on. The build starts on the first. */
const onStep = (stage: Stage): number => {
  switch (stage) {
    case Stage.Starting:
    case Stage.Resolving:
      return 0;
    case Stage.Installing:
      return 1;
    case Stage.Bundling:
      return 2;
    case Stage.Built:
    case Stage.Failed:
      return STEPS.length;
  }
};

const stepState = (index: number, stage: Stage): string => {
  const current = onStep(stage);
  if (index < current) {
    return "done";
  } else if (index === current) {
    return "active";
  } else {
    return "waiting";
  }
};

// The aurora's colors per stage. Each is registered as a `<color>` in
// `panda.config.ts`, so a failure eases the whole sky to `danger`.
const sceneStyles = css({
  "--glow-cool": "color-mix(in oklab, {colors.accent} 70%, {colors.private})",
  "--glow-core": "{colors.accent}",
  "--glow-deep": "color-mix(in oklab, {colors.private} 75%, {colors.danger})",
  "--glow-warm": "color-mix(in oklab, {colors.private} 80%, {colors.accent})",
  "&[data-stage=failed]": {
    "--glow-cool": "color-mix(in oklab, {colors.danger} 70%, {colors.warning})",
    "--glow-core": "{colors.danger}",
    "--glow-deep": "color-mix(in oklab, {colors.danger} 60%, {colors.private})",
    "--glow-warm":
      "color-mix(in oklab, {colors.danger} 85%, {colors.background})",
  },
  backgroundColor: "background",
  color: "foreground",
  inset: 0,
  isolation: "isolate",
  overflow: "hidden",
  position: "absolute",
  // main-thread animation: the aurora eases to `danger` once, on a failure.
  transition: `
    --glow-cool {durations.ending} {easings.in-out},
    --glow-core {durations.ending} {easings.in-out},
    --glow-deep {durations.ending} {easings.in-out},
    --glow-warm {durations.ending} {easings.in-out}
  `,
});

const auroraStyles = css({
  inset: 0,
  position: "absolute",
});

// Percentages, so the aurora fills a display of any size the same way.
const glowStyles = css({
  _light: { mixBlendMode: "multiply" },
  "&[data-glow=cool]": {
    animationName: "auroraCool",
    backgroundImage:
      "radial-gradient(circle, color-mix(in oklab, var(--glow-cool) 70%, transparent), transparent 65%)",
    inlineSize: "70%",
    insetBlockStart: "-30%",
    insetInlineStart: "-20%",
  },
  "&[data-glow=core]": {
    animationDuration: "calc({durations.drift} * 0.7)",
    animationName: "auroraCore",
    backgroundImage:
      "radial-gradient(circle, color-mix(in oklab, var(--glow-core) 40%, transparent), transparent 60%)",
    inlineSize: "50%",
    insetBlockStart: "15%",
    insetInlineStart: "25%",
  },
  "&[data-glow=deep]": {
    animationDirection: "alternate-reverse",
    animationDuration: "calc({durations.drift} * 1.1)",
    animationName: "auroraCore",
    backgroundImage:
      "radial-gradient(circle, color-mix(in oklab, var(--glow-deep) 55%, transparent), transparent 65%)",
    inlineSize: "50%",
    insetBlockEnd: "-25%",
    insetInlineStart: "-10%",
  },
  "&[data-glow=warm]": {
    animationDuration: "calc({durations.drift} * 1.3)",
    animationName: "auroraWarm",
    backgroundImage:
      "radial-gradient(circle, color-mix(in oklab, var(--glow-warm) 65%, transparent), transparent 65%)",
    inlineSize: "75%",
    insetBlockEnd: "-35%",
    insetInlineEnd: "-25%",
  },
  animationDirection: "alternate",
  animationDuration: "drift",
  animationIterationCount: "infinite",
  animationTimingFunction: "in-out",
  aspectRatio: "1",
  borderRadius: "full",
  filter: "blur({blurs.3xl})",
  mixBlendMode: "screen",
  position: "absolute",
});

// Holds the mask still while the dots creep under it.
const gridStyles = css({
  inset: 0,
  maskImage:
    "radial-gradient(ellipse at center, {colors.foreground}, transparent 65%)",
  overflow: "hidden",
  position: "absolute",
});

// A cell bigger than the screen on each side, so sliding one cell with a
// transform loops without a seam.
const gridDotsStyles = css({
  animation: "gridCreep {durations.drift} {easings.linear} infinite",
  backgroundImage:
    "radial-gradient(color-mix(in oklab, {colors.foreground} 18%, transparent) 1px, transparent 1px)",
  backgroundSize: "{spacing.8} {spacing.8}",
  inset: -8,
  position: "absolute",
});

// Darkens the edges, so the eye settles on the mark.
const vignetteStyles = css({
  backgroundImage:
    "radial-gradient(ellipse at center, transparent 40%, color-mix(in oklab, {colors.background} 70%, transparent))",
  inset: 0,
  position: "absolute",
});

const contentStyles = vstack({
  gap: 0,
  inset: 0,
  justify: "center",
  position: "absolute",
});

const markStyles = center({
  "--mark": "color-mix(in oklab, var(--glow-core) 80%, {colors.foreground})",
  blockSize: 32,
  color: "var(--mark)",
  inlineSize: 32,
  marginBlockEnd: 10,
  position: "relative",
});

const haloStyles = css({
  "[data-stage=failed] &": { animationPlayState: "paused", opacity: 0 },
  "&[data-later]": { animationDelay: "calc({durations.halo} / -2)" },
  animation: "halo {durations.halo} {easings.out} infinite",
  border: "1px solid color-mix(in oklab, var(--mark) 45%, transparent)",
  borderRadius: "full",
  boxShadow:
    "0 0 {spacing.6} color-mix(in oklab, var(--mark) 25%, transparent), inset 0 0 {spacing.6} color-mix(in oklab, var(--mark) 20%, transparent)",
  inset: 0,
  position: "absolute",
  transition: "opacity {durations.slowest} {easings.out}",
});

const houseStyles = css({
  blockSize: "70%",
  filter:
    "drop-shadow(0 0 {spacing.3} color-mix(in oklab, var(--mark) 70%, transparent))",
  inlineSize: "70%",
  overflow: "visible",
  position: "relative",
});

const outlineStyles = css({
  "&[data-door]": { animationDelay: "calc({durations.draw} * 0.55)" },
  animation:
    "markDrawn {durations.draw} {easings.in-out} both, markFilled {durations.slowest} {easings.out} {durations.draw} both",
  fill: "color-mix(in oklab, var(--mark) 14%, transparent)",
  stroke: "currentColor",
  strokeDasharray: "1",
  strokeLinecap: "round",
  strokeLinejoin: "round",
});

// A warm light in the window, against the cool aurora.
const lampStyles = css({
  "[data-stage=built] &": {
    animationPlayState: "paused",
    fill: "{colors.foreground}",
  },
  "[data-stage=failed] &": { animationPlayState: "paused", opacity: 0 },
  animation:
    "lampLit {durations.slowest} {easings.out} {durations.draw} both, lampBreathing {durations.halo} {easings.in-out} calc({durations.draw} + {durations.slowest}) infinite",
  fill: "color-mix(in oklab, {colors.warning} 65%, {colors.foreground})",
  filter: "drop-shadow(0 0 {spacing.2} {colors.warning})",
  transition:
    "fill {durations.slow} {easings.out}, opacity {durations.slowest} {easings.out}",
});

const wordmarkStyles = hstack({
  fontSize: "6xl",
  fontWeight: "extralight",
  gap: 0,
  letterSpacing: "wordmark",
  lineHeight: "none",
  // The tracking trails the last letter, so the word sits off center by it.
  marginInlineEnd: "calc(-1 * {letterSpacings.wordmark})",
});

const letterStyles = css({
  animation: "letterRise {durations.slower} {easings.outQuart} both",
  animationDelay:
    "calc({durations.draw} * 0.35 + var(--letter) * {durations.faster} * 0.7)",
  backgroundClip: "text",
  backgroundImage:
    "linear-gradient(to bottom, {colors.foreground} 30%, color-mix(in oklab, {colors.foreground} 40%, var(--glow-core)))",
  color: "transparent",
});

const statusStyles = css({
  "[data-stage=failed] &": { color: "danger" },
  animation: "rise {durations.slower} {easings.outQuart} both",
  color: "muted",
  fontSize: "sm",
  letterSpacing: "wide",
  marginBlockStart: 7,
  maxInlineSize: 120,
  minBlockSize: 5,
  overflow: "hidden",
  textAlign: "center",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
});

const meterStyles = vstack({
  animation: "rise {durations.slower} {easings.outQuart} {durations.draw} both",
  gap: 4,
  marginBlockStart: 5,
});

const trackStyles = css({
  backgroundColor: "color-mix(in oklab, {colors.foreground} 10%, transparent)",
  blockSize: 0.5,
  borderRadius: "full",
  inlineSize: 80,
  overflow: "hidden",
  position: "relative",
});

const fillStyles = css({
  "&::after": {
    animation: "shimmer {durations.shimmer} {easings.in-out} infinite",
    backgroundImage:
      "linear-gradient(to right, transparent, color-mix(in oklab, {colors.foreground} 75%, transparent), transparent)",
    content: '""',
    inlineSize: "30%",
    inset: 0,
    position: "absolute",
  },
  backgroundImage:
    "linear-gradient(to right, color-mix(in oklab, var(--glow-warm) 60%, transparent), var(--glow-core))",
  borderRadius: "full",
  inset: 0,
  overflow: "hidden",
  position: "absolute",
  transform: "scaleX(var(--reach))",
  // Physical: the meter fills left to right in every writing direction.
  transformOrigin: "left",
  transition: "transform {durations.slowest} {easings.outQuart}",
});

const stepsStyles = hstack({
  color: "color-mix(in oklab, {colors.foreground} 35%, {colors.background})",
  fontSize: "2xs",
  fontWeight: "medium",
  gap: 7,
  letterSpacing: "widest",
  textTransform: "uppercase",
});

const stepStyles = hstack({
  "&[data-state=active]": { color: "foreground" },
  "&[data-state=done]": { color: "muted" },
  gap: 2,
  transition: "color {durations.slow} {easings.out}",
});

const dotStyles = css({
  "[data-state=active] &": {
    animation: "pulse {durations.halo} {easings.in-out} infinite",
    backgroundColor: "var(--glow-core)",
    borderColor: "var(--glow-core)",
    boxShadow: "0 0 {spacing.2} var(--glow-core)",
  },
  "[data-state=done] &": {
    backgroundColor: "var(--glow-core)",
    borderColor: "var(--glow-core)",
  },
  blockSize: 1.5,
  border: "1px solid currentColor",
  borderRadius: "full",
  inlineSize: 1.5,
  transition:
    "background-color {durations.slow} {easings.out}, border-color {durations.slow} {easings.out}",
});

const failureStyles = vstack({
  alignItems: "stretch",
  animation: "rise {durations.slower} {easings.outQuart} both",
  backdropFilter: "blur({blurs.xl})",
  backgroundColor: "color-mix(in oklab, {colors.card} 65%, transparent)",
  border: "1px solid color-mix(in oklab, {colors.danger} 40%, {colors.border})",
  borderRadius: "2xl",
  boxShadow: "modal",
  gap: 4,
  marginBlockStart: 6,
  maxInlineSize: 160,
  paddingBlock: 5,
  paddingInline: 6,
});

const whyStyles = css({
  color: "foreground",
  fontFamily: "mono",
  fontSize: "xs",
  lineHeight: "relaxed",
  maxBlockSize: 64,
  overflow: "auto",
  userSelect: "text",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
});

const hintStyles = css({
  color: "muted",
  fontSize: "sm",
  textAlign: "center",
});
