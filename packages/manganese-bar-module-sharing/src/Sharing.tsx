import { Button } from "@domicile-desktop/component-library/Button";
import { Popover } from "@domicile-desktop/component-library/Popover";
import { sourceName } from "@domicile-desktop/component-library/source-name";
import type { App } from "@domicile-desktop/component-library/useApps";
import { useApps } from "@domicile-desktop/component-library/useApps";
import type { Portals } from "@domicile-desktop/sdk/desktop/portals";
import type { Captured, Capturing } from "@domicile-desktop/sdk/portal";
import { CapturedKind, CapturingKind } from "@domicile-desktop/sdk/portal";
import type { AppsDesktop } from "@domicile-desktop/system-apps/apps-desktop";
import { AppWindowIcon } from "@phosphor-icons/react/dist/ssr/AppWindow";
import { GlobeIcon } from "@phosphor-icons/react/dist/ssr/Globe";
import { MonitorIcon } from "@phosphor-icons/react/dist/ssr/Monitor";
import { ScreencastIcon } from "@phosphor-icons/react/dist/ssr/Screencast";
import { SelectionIcon } from "@phosphor-icons/react/dist/ssr/Selection";
import { SquaresFourIcon } from "@phosphor-icons/react/dist/ssr/SquaresFour";
import { StopIcon } from "@phosphor-icons/react/dist/ssr/Stop";
import { useEffect, useState } from "react";
import { css } from "../styled-system/css";
import { center, flex, hstack } from "../styled-system/patterns";

/** What the indicator reads: captures, and applications' desktop entries. */
export type SharingDesktop = AppsDesktop & {
  readonly portals: Pick<Portals, "capturing" | "on" | "stopCapturing">;
};

type Props = {
  /** The desktop whose captures to show. */
  domicile: SharingDesktop;
};

/** A running screen cast. */
type ScreenCast = Extract<Capturing, { kind: CapturingKind.ScreenCast }>;

/**
 * Top bar sharing indicator: a red pill naming what is shared, shown while an
 * application records the desktop through the ScreenCast portal. Its panel
 * lists each application, what it records and a button that stops it. Agents
 * are `<Agents />`'s, and input sessions `<PortalDialogs />`'s.
 */
export const Sharing = ({ domicile }: Props) => {
  const [capturing, setCapturing] = useState<readonly ScreenCast[]>([]);
  const apps = useApps(domicile, [
    ...capturing.map((capture) => capture.appId),
    ...capturing.flatMap((capture) => windowAppIds(capture.sources)),
  ]);

  useEffect(() => {
    const { portals } = domicile;
    const heard = () => {
      setCapturing(
        (portals.capturing ?? []).filter((session) => isScreenCast(session)),
      );
    };
    heard();
    return portals.on("change", heard);
  }, [domicile]);

  return capturing.length > 0 ? (
    <Casts
      apps={apps}
      capturing={capturing}
      stop={(id) => {
        domicile.portals.stopCapturing(id);
      }}
    />
  ) : undefined;
};

/** The red pill, and its panel of each application's cast. */
const Casts = ({
  apps,
  capturing,
  stop,
}: {
  apps: (appId: string) => App;
  capturing: readonly ScreenCast[];
  stop: (id: number) => void;
}) => (
  <Popover
    align="center"
    side="bottom"
    tone="overPhoto"
    tooltip={who(apps, capturing)}
    trigger={
      <button className={triggerStyles} type="button">
        <ScreencastIcon aria-hidden size={15} weight="bold" />
        {`Sharing ${what(capturing.flatMap(({ sources }) => sources))}`}
      </button>
    }
  >
    <div className={panelStyles}>
      {capturing.map((capture) => (
        <Session
          app={apps(capture.appId)}
          apps={apps}
          capture={capture}
          key={capture.id}
          stop={() => {
            stop(capture.id);
          }}
        />
      ))}
    </div>
  </Popover>
);

/** One application's cast: who, each source it records, and a stop button. */
const Session = ({
  app,
  apps,
  capture,
  stop,
}: {
  app: App;
  apps: (appId: string) => App;
  capture: ScreenCast;
  stop: () => void;
}) => (
  <section className={sessionStyles}>
    <span className={whoStyles}>
      {app.icon !== undefined && (
        <img alt="" className={appIconStyles} src={app.icon} />
      )}
      {app.name}
    </span>
    <ul aria-label={`Shared by ${app.name}`} className={sourcesStyles}>
      {capture.sources.map((source) => (
        <Source apps={apps} key={sourceKey(source)} source={source} />
      ))}
    </ul>
    <Button
      beforeIcon={<StopIcon aria-hidden weight="fill" />}
      onClick={stop}
      size="sm"
      variant="danger"
    >
      Stop sharing
    </Button>
  </section>
);

/** A source's icon, its name, and what of it is shared. */
const Source = ({
  apps,
  source,
}: {
  apps: (appId: string) => App;
  source: Captured;
}) => (
  <li className={sourceStyles}>
    <span className={sourceIconStyles}>
      <SourceIcon apps={apps} source={source} />
    </span>
    <span className={sourceTextStyles}>
      <span className={sourceNameStyles}>{label(source)}</span>
      <span className={detailStyles}>{detail(apps, source)}</span>
    </span>
  </li>
);

const SourceIcon = ({
  apps,
  source,
}: {
  apps: (appId: string) => App;
  source: Captured;
}) => {
  switch (source.kind) {
    case CapturedKind.Window: {
      const { icon } = apps(source.appId);
      return icon === undefined ? (
        <AppWindowIcon aria-hidden size={18} />
      ) : (
        <img alt="" className={windowIconStyles} src={icon} />
      );
    }
    case CapturedKind.BrowserWindow:
      return <GlobeIcon aria-hidden size={18} />;
    case CapturedKind.Monitor:
      return <MonitorIcon aria-hidden size={18} />;
    case CapturedKind.Desk:
      return <SquaresFourIcon aria-hidden size={18} />;
    case CapturedKind.Region:
      return <SelectionIcon aria-hidden size={18} />;
  }
};

/** A source's name in the panel: a browser window by its title alone. */
const label = (source: Captured): string =>
  source.kind === CapturedKind.BrowserWindow
    ? source.title
    : sourceName(source);

/** What of a source is shared, or whose window it is. */
const detail = (apps: (appId: string) => App, source: Captured): string => {
  switch (source.kind) {
    case CapturedKind.Window:
      return source.appId === "" ? "Window" : apps(source.appId).name;
    case CapturedKind.BrowserWindow:
      return "Browser window";
    case CapturedKind.Monitor:
      return source.description === ""
        ? "Whole screen"
        : `Whole screen · ${source.name}`;
    case CapturedKind.Desk:
      return "Every screen";
    case CapturedKind.Region:
      return `${String(source.size[0])} × ${String(source.size[1])}`;
  }
};

/** The pill's hover text: who is sharing. */
const who = (
  apps: (appId: string) => App,
  capturing: readonly ScreenCast[],
): string => {
  const names = capturing.map(({ appId }) => apps(appId).name);
  const last = names.at(-1);
  return names.length > 1 && last !== undefined
    ? `Shared with ${names.slice(0, -1).join(", ")} and ${last}`
    : `Shared with ${names.join("")}`;
};

/**
 * What `sources` are, after "Sharing": one source by its kind, several of a
 * kind counted, and several kinds as things.
 */
const what = (sources: readonly Captured[]): string => {
  const kinds = new Set(sources.map((source) => noun(source.kind)));
  const [kind] = kinds;
  if (kinds.size !== 1 || kind === undefined) {
    return `${String(sources.length)} things`;
  } else {
    return sources.length === 1
      ? kind.one
      : `${String(sources.length)} ${kind.many}`;
  }
};

/** A source kind's name, alone and counted. */
const noun = (kind: CapturedKind): { one: string; many: string } => {
  switch (kind) {
    case CapturedKind.Window:
    case CapturedKind.BrowserWindow:
      return WINDOW;
    case CapturedKind.Monitor:
      return SCREEN;
    case CapturedKind.Desk:
      return ALL_SCREENS;
    case CapturedKind.Region:
      return AREA;
  }
};

// One object per noun, so `what` counts the kinds that share one as one.
const WINDOW = { many: "windows", one: "window" };
const SCREEN = { many: "screens", one: "screen" };
const ALL_SCREENS = { many: "screens", one: "all screens" };
const AREA = { many: "areas", one: "area" };

/** The app ids of the windows among `sources`, to name and draw them. */
const windowAppIds = (sources: readonly Captured[]): string[] =>
  sources.flatMap((source) =>
    source.kind === CapturedKind.Window && source.appId !== ""
      ? [source.appId]
      : [],
  );

const isScreenCast = (session: Capturing): session is ScreenCast =>
  session.kind === CapturingKind.ScreenCast;

const sourceKey = (source: Captured): string => {
  switch (source.kind) {
    case CapturedKind.Window:
      return `window:${source.id}`;
    case CapturedKind.BrowserWindow:
      return `browser-window:${source.id}`;
    case CapturedKind.Monitor:
      return `monitor:${source.name}`;
    case CapturedKind.Desk:
      return "desk";
    case CapturedKind.Region:
      return `region:${source.position.join(",")}:${source.size.join("x")}`;
  }
};

// Red, as recording lights are, so it stands out from the bar's white icons.
const triggerStyles = hstack({
  _hover: {
    backgroundColor: "color-mix(in oklab, {colors.danger} 85%, black)",
  },
  backgroundColor: "danger",
  blockSize: 6,
  borderRadius: "lg",
  borderStyle: "none",
  color: "onPhoto",
  cursor: "pointer",
  flexShrink: 0,
  fontSize: "sm",
  fontWeight: "semibold",
  gap: 1.5,
  paddingInline: 2.5,
  textShadow: "none",
  transition: "background-color {durations.fast} {easings.default}",
  whiteSpace: "nowrap",
});

const panelStyles = flex({
  direction: "column",
  gap: 4,
  inlineSize: 72,
  paddingBlock: 1.5,
});

const sessionStyles = flex({ direction: "column", gap: 2 });

const whoStyles = hstack({ fontWeight: "semibold", gap: 2 });

const appIconStyles = css({ blockSize: 5, flexShrink: 0, inlineSize: 5 });

const sourcesStyles = flex({
  backgroundColor: "color-mix(in oklab, currentcolor 8%, transparent)",
  borderRadius: "lg",
  direction: "column",
  listStyle: "none",
  margin: 0,
  padding: 1,
});

const sourceStyles = hstack({ gap: 3, padding: 1.5 });

const sourceIconStyles = center({
  backgroundColor: "color-mix(in oklab, currentcolor 12%, transparent)",
  blockSize: 8,
  borderRadius: "md",
  flexShrink: 0,
  inlineSize: 8,
});

const windowIconStyles = css({ blockSize: 5, inlineSize: 5 });

const sourceTextStyles = flex({ direction: "column", minInlineSize: 0 });

const sourceNameStyles = css({
  fontSize: "sm",
  fontWeight: "medium",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
});

const detailStyles = css({ fontSize: "xs", opacity: 0.75 });
