import { BrowsersIcon } from "@phosphor-icons/react/dist/ssr/Browsers";
import { MonitorIcon } from "@phosphor-icons/react/dist/ssr/Monitor";
import { StackIcon } from "@phosphor-icons/react/dist/ssr/Stack";
import type { ReactNode } from "react";

import { css, cva } from "../../styled-system/css";
import { flex, grid } from "../../styled-system/patterns";
import { repoFile } from "../page/repo";
import { Section } from "../page/Section";

type Stage = {
  icon: ReactNode;
  /** What draws or arranges at this stage. */
  title: string;
  body: string;
  /** `engine` marks the stage the browser engine runs. */
  tone?: "engine" | undefined;
  /** Draws the stage as a stack of boxes: one copy per app. */
  stacked?: boolean | undefined;
};

type Source = {
  label: string;
  /** How the source appears on the page, if it does. */
  code?: string | undefined;
};

/** One input and the stages it passes through on its own. */
type Lane = {
  source: Source;
  stages?: readonly Stage[] | undefined;
};

type Diagram = {
  title: string;
  /** What feeds the first shared stage, side by side. */
  lanes: readonly Lane[];
  /** The stages every lane passes through, top to bottom. */
  stages: readonly Stage[];
};

const CONVENTIONAL: Diagram = {
  lanes: [
    {
      source: { label: "Websites" },
      stages: [
        {
          body: "Renders and composites its pages into one window, with its own engine.",
          icon: <BrowsersIcon />,
          title: "Chromium",
        },
      ],
    },
    {
      source: { label: "Electron apps" },
      stages: [
        {
          body: "Each app brings its own copy.",
          icon: <BrowsersIcon />,
          stacked: true,
          title: "Chromium",
        },
      ],
    },
    { source: { label: "Native apps" } },
  ],
  stages: [
    {
      body: "Arranges every window, Chromium's included, and composites them.",
      icon: <StackIcon />,
      title: "The desktop compositor",
    },
    { body: "", icon: <MonitorIcon />, title: "The screen" },
  ],
  title: "A typical desktop",
};

const DOMICILE: Diagram = {
  lanes: [
    { source: { code: "<webview>", label: "Websites" } },
    { source: { label: "Domicile apps" } },
    { source: { label: "Electron apps" } },
    { source: { code: "<app>", label: "Native apps" } },
    { source: { code: "HTML", label: "Your desktop" } },
  ],
  stages: [
    {
      body: "Native apps still draw their own windows, and Domicile's Wayland server hands them to the engine. The engine lays out your desktop, websites, Domicile and Electron apps, and windows with CSS, and composites them in one frame.",
      icon: <BrowsersIcon />,
      title: "Domicile",
      tone: "engine",
    },
    { body: "", icon: <MonitorIcon />, title: "The screen" },
  ],
  title: "Domicile",
};

/** Why unify: the two arrangements, side by side. */
export const Why = () => (
  <Section
    id="why"
    lede="On most desktops the browser is one app among many, and every Electron app brings a copy of Chromium too. Each has its own rendering engine and compositor, and runs in a window that a separate desktop compositor arranges. That's a sound design. Domicile tries the other one."
    title="You're already running a browser."
  >
    <div className={diagramsStyles}>
      <Flow diagram={CONVENTIONAL} />
      <Flow diagram={DOMICILE} />
    </div>
    <ul className={notesStyles}>
      <li>
        Websites still render in their own processes, and apps in theirs. What
        changes is what arranges and composites them: one engine, with CSS.
      </li>
      <li>
        Domicile apps and Electron apps are web pages in app windows, so they
        share the one engine. An Electron app can also run as a native app, with
        its own Chromium.
      </li>
      <li>
        It's a different arrangement, not a speedup. Pixels are still drawn,
        imported and composited.{" "}
        <a
          className={linkStyles}
          href={repoFile("docs/architecture/ENGINE-FORK-MEASUREMENTS.md")}
        >
          What's been measured
        </a>
      </li>
    </ul>
    <a className={moreStyles} href="/docs/how-it-works">
      How it works →
    </a>
  </Section>
);

/** One arrangement, top to bottom: its lanes side by side, each ending in an
 * arrow, then the stages they share. The lanes' arrows stretch, so every lane
 * ends level. */
const Flow = ({ diagram }: { diagram: Diagram }) => (
  <figure className={flowStyles}>
    <figcaption className={flowTitleStyles}>{diagram.title}</figcaption>
    <div className={pathStyles}>
      <ul className={lanesStyles}>
        {diagram.lanes.map((lane) => (
          <li className={laneStyles} key={lane.source.label}>
            <span className={sourceStyles}>
              <span>{lane.source.label}</span>
              {lane.source.code === undefined ? undefined : (
                <code className={sourceCodeStyles}>{lane.source.code}</code>
              )}
            </span>
            {(lane.stages ?? []).map((stage) => (
              <span className={laneStageStyles} key={stage.title}>
                <Connector />
                <StageBox compact stage={stage} />
              </span>
            ))}
            <Connector />
          </li>
        ))}
      </ul>
      <ol className={stagesStyles}>
        {diagram.stages.map((stage, index) => (
          <li className={stageWrapStyles} key={stage.title}>
            {index === 0 ? undefined : <Connector />}
            <StageBox stage={stage} />
          </li>
        ))}
      </ol>
    </div>
  </figure>
);

const Connector = () => <span aria-hidden="true" className={connectorStyles} />;

/** A `compact` box shares its row with other lanes, so on narrow screens it
 * shows only its title. */
const StageBox = ({
  compact = false,
  stage,
}: {
  compact?: boolean;
  stage: Stage;
}) => (
  <div
    className={stageStyles({
      compact,
      stacked: stage.stacked ?? false,
      tone: stage.tone ?? "plain",
    })}
  >
    <span aria-hidden="true" className={stageIconStyles({ compact })}>
      {stage.icon}
    </span>
    <div className={stageTextStyles}>
      <span className={stageTitleStyles}>{stage.title}</span>
      {stage.body === "" ? undefined : (
        <span className={stageBodyStyles({ compact })}>{stage.body}</span>
      )}
    </div>
  </div>
);

const diagramsStyles = grid({
  alignItems: "start",
  gap: { base: 10, md: 5 },
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 26rem), 1fr))",
});

// A card on wide screens. Narrow screens drop it, so the lanes get its
// padding.
const flowStyles = flex({
  backgroundColor: { md: "card" },
  border: { md: "1px solid {colors.border}" },
  borderRadius: "2xl",
  direction: "column",
  gap: 4,
  padding: { base: 0, md: 7 },
});

const flowTitleStyles = css({
  fontFamily: "display",
  fontSize: "xl",
  fontWeight: "bold",
});

// The lanes' arrows run straight into the stage below them.
const pathStyles = flex({ direction: "column" });

const lanesStyles = grid({
  gap: 2,
  gridAutoColumns: "minmax(0, 1fr)",
  gridAutoFlow: "column",
  listStyle: "none",
});

const laneStyles = flex({ direction: "column" });

const laneStageStyles = flex({ direction: "column" });

const sourceStyles = flex({
  align: "center",
  backgroundColor: "background",
  border: "1px solid {colors.border}",
  borderRadius: "lg",
  direction: "column",
  fontSize: "sm",
  fontWeight: "medium",
  gap: 0.5,
  justify: "center",
  paddingBlock: 2.5,
  paddingInline: { base: 1.5, md: 3 },
  textAlign: "center",
});

const sourceCodeStyles = css({
  color: "accent",
  fontFamily: "mono",
  fontSize: "xs",
});

const stagesStyles = flex({ direction: "column", listStyle: "none" });

const stageWrapStyles = flex({ direction: "column" });

// A line down to the stage, ending in an arrowhead.
const connectorStyles = css({
  _after: {
    borderInline: "5px solid transparent",
    borderTop: "6px solid {colors.border}",
    content: '""',
    insetBlockEnd: "-1px",
    insetInlineStart: "50%",
    position: "absolute",
    translate: "-50% 0",
  },
  alignSelf: "center",
  backgroundColor: "border",
  blockSize: 6,
  flex: 1,
  inlineSize: "1px",
  marginBlockEnd: 1,
  minBlockSize: 6,
  position: "relative",
});

const stageStyles = cva({
  base: {
    alignItems: "flex-start",
    borderRadius: "xl",
    display: "flex",
    gap: 3,
    paddingBlock: 3.5,
    paddingInline: 4,
  },
  variants: {
    compact: {
      false: {},
      true: {
        gap: { base: 0, md: 3 },
        justifyContent: { base: "center", md: "flex-start" },
        paddingInline: { base: 1.5, md: 4 },
      },
    },
    // Two more boxes peek out behind it, down and to the right.
    stacked: {
      false: {},
      true: {
        boxShadow:
          "5px 5px 0 -1px {colors.background}, 5px 5px 0 0 {colors.border}, 10px 10px 0 -1px {colors.background}, 10px 10px 0 0 {colors.border}",
        marginBlockEnd: "10px",
        marginInlineEnd: "10px",
      },
    },
    tone: {
      engine: {
        backgroundImage:
          "linear-gradient(135deg, color-mix(in oklab, {colors.accent} 18%, {colors.card}), color-mix(in oklab, {colors.accent} 6%, {colors.card}))",
        border:
          "1px solid color-mix(in oklab, {colors.accent} 45%, {colors.border})",
      },
      plain: {
        backgroundColor: "background",
        border: "1px solid {colors.border}",
      },
    },
  },
});

const stageIconStyles = cva({
  base: {
    color: "accent",
    flex: "none",
    fontSize: "xl",
    lineHeight: "1",
    marginBlockStart: "0.1em",
  },
  variants: {
    compact: {
      false: {},
      true: { display: { base: "none", md: "block" } },
    },
  },
});

const stageTextStyles = flex({ direction: "column", gap: 1, minInlineSize: 0 });

const stageTitleStyles = css({ fontWeight: "semibold" });

const stageBodyStyles = cva({
  base: { color: "muted", fontSize: "sm" },
  variants: {
    compact: {
      false: {},
      true: { display: { base: "none", md: "inline" } },
    },
  },
});

const notesStyles = flex({
  color: "muted",
  direction: "column",
  gap: 2,
  listStyle: "disc",
  marginBlockStart: 6,
  maxInlineSize: "3xl",
  paddingInlineStart: 5,
});

const linkStyles = css({ color: "foreground", textDecoration: "underline" });

const moreStyles = css({
  _hover: { color: "accent" },
  color: "foreground",
  display: "inline-block",
  fontWeight: "semibold",
  marginBlockStart: 5,
});
