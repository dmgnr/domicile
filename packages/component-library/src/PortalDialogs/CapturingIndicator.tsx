import type { Capturing } from "@domicile-desktop/sdk/portal";
import { CapturingKind } from "@domicile-desktop/sdk/portal";
import { css } from "../../styled-system/css";
import { flex, hstack } from "../../styled-system/patterns";
import { Button } from "../Button/Button";
import { useScreenRegion } from "../Screen/DisplayProvider";
import type { App } from "../useApps/useApps";
import { deviceNames } from "./device-names";
import { sourceName } from "./source-name";

type Props = {
  apps: (appId: string) => App;
  sessions: readonly Capturing[];
  /** Asks the user again what an agent reaches. */
  change: (id: number) => void;
  stop: (id: number) => void;
  screen: string | undefined;
};

/**
 * A row per session that records the screen or controls or captures input,
 * naming its application and what it holds, with a button that ends it. An
 * agent's row also has one that changes what it reaches.
 */
export const CapturingIndicator = ({
  apps,
  change,
  screen,
  sessions,
  stop,
}: Props) => {
  const region = useScreenRegion(screen);
  return sessions.length === 0 ? undefined : (
    <div className={regionStyles} style={region}>
      <ul aria-label="Sharing and remote control" className={listStyles}>
        {sessions.map((session) => (
          <li className={itemStyles} key={session.id}>
            <AppRow app={apps(session.appId)} session={session} />
            {session.kind === CapturingKind.Agent && (
              <Button
                onClick={() => {
                  change(session.id);
                }}
                size="sm"
                variant="outline"
              >
                Change
              </Button>
            )}
            <Button
              onClick={() => {
                stop(session.id);
              }}
              size="sm"
              variant="outline"
            >
              Stop
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
};

// Spans the screen so the list can center on it; takes no clicks itself.
const regionStyles = css({
  inset: 0,
  pointerEvents: "none",
  position: "fixed",
  zIndex: "toast",
});

const listStyles = flex({
  direction: "column",
  gap: 1,
  inlineSize: "fit-content",
  insetBlockStart: 2,
  insetInline: 0,
  listStyle: "none",
  margin: 0,
  marginInline: "auto",
  padding: 0,
  position: "absolute",
});

const iconStyles = css({ blockSize: 4, flexShrink: 0, inlineSize: 4 });

const itemStyles = hstack({
  backgroundColor: "card",
  border: "1px solid {colors.warning}",
  borderRadius: "full",
  boxShadow: "{shadows.lifted}",
  color: "foreground",
  fontSize: "sm",
  gap: 3,
  paddingBlock: 1,
  paddingInlineEnd: 1,
  paddingInlineStart: 4,
  pointerEvents: "auto",
});

/** A session's application icon, when it has one, and what it holds. */
const AppRow = ({ app, session }: { app: App; session: Capturing }) => (
  <>
    {app.icon !== undefined && (
      <img alt="" className={iconStyles} src={app.icon} />
    )}
    <span>{summary(session, app.name)}</span>
  </>
);

/** What a session's row says. */
const summary = (session: Capturing, name: string): string => {
  switch (session.kind) {
    case CapturingKind.RemoteDesktop:
      return `Remote control: ${name} — ${[
        ...deviceNames(session.devices),
        ...(session.clipboard ? ["clipboard"] : []),
      ].join(", ")}`;
    case CapturingKind.InputCapture:
      return `Input capture: ${name} — ${deviceNames(session.devices).join(", ")}`;
    case CapturingKind.ScreenCast:
      return `Sharing: ${name} — ${session.sources.map((source) => sourceName(source)).join(", ")}`;
    // `<PortalDialogs />` gives the shell's recording its own toolbar.
    case CapturingKind.Recording:
      return `Recording: ${session.sources.map((source) => sourceName(source)).join(", ")}`;
    // An agent names itself; it is not an application the desk knows.
    case CapturingKind.Agent:
      return `In control: ${session.agent} — ${
        session.reach.kind === "desk"
          ? "your desktop"
          : session.reach.windows.map((window) => window.title).join(", ")
      }`;
    case CapturingKind.Unknown:
      return `${session.wireKind}: ${name}`;
  }
};
