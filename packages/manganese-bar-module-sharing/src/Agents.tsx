import { Button } from "@domicile-desktop/component-library/Button";
import { Popover } from "@domicile-desktop/component-library/Popover";
import type { Portals } from "@domicile-desktop/sdk/desktop/portals";
import type { Capturing } from "@domicile-desktop/sdk/portal";
import { CapturingKind } from "@domicile-desktop/sdk/portal";
import { RobotIcon } from "@phosphor-icons/react/dist/ssr/Robot";
import { SlidersHorizontalIcon } from "@phosphor-icons/react/dist/ssr/SlidersHorizontal";
import { StopIcon } from "@phosphor-icons/react/dist/ssr/Stop";
import { useEffect, useState } from "react";

import { css } from "../styled-system/css";
import { center, flex, hstack } from "../styled-system/patterns";

/** An agent the user let in. */
export type Agent = Extract<Capturing, { kind: CapturingKind.Agent }>;

const LIST = new Intl.ListFormat("en", { type: "conjunction" });

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/** How often "1 min ago" moves on while the panel is open. */
const TICK_MS = 15 * 1000;

/** What the agents item reads: the agents in control. */
export type AgentsDesktop = {
  readonly portals: Pick<
    Portals,
    "capturing" | "changeAgent" | "on" | "stopCapturing"
  >;
};

/**
 * Top bar agents item: one violet pill for every agent session in control,
 * such as Claude Code, named as the agent names itself. Its panel says what
 * each session can reach and did last, with buttons that change what it
 * reaches and stop it.
 */
export const Agents = ({ domicile }: { domicile: AgentsDesktop }) => {
  const [agents, setAgents] = useState<readonly Agent[]>([]);

  useEffect(() => {
    const { portals } = domicile;
    const heard = () => {
      setAgents(
        (portals.capturing ?? []).filter((session) => isAgent(session)),
      );
    };
    heard();
    return portals.on("change", heard);
  }, [domicile]);

  const [first, ...rest] = agents;
  // Nothing at all when none is in, so the bar closes the item.
  return first === undefined ? undefined : (
    <Pill
      agents={[first, ...rest]}
      change={(agent) => {
        domicile.portals.changeAgent(agent.id);
      }}
      stop={(agent) => {
        domicile.portals.stopCapturing(agent.id);
      }}
    />
  );
};

/** The agent sessions in control, never none. */
type Sessions = readonly [Agent, ...Agent[]];

type Controls = {
  change: (agent: Agent) => void;
  stop: (agent: Agent) => void;
};

/** The one pill, and its panel. */
const Pill = ({ agents, change, stop }: Controls & { agents: Sessions }) => {
  const [first] = agents;
  const names = new Set(agents.map((agent) => agent.agent));
  const label = names.size === 1 ? first.agent : "Agents";
  const several = agents.length > 1 ? sessionsName(agents, names) : undefined;
  return (
    <Popover
      align="center"
      side="bottom"
      tone="overPhoto"
      tooltip={
        several === undefined
          ? `${first.agent} can see and use ${reach(first)}`
          : `${several} are in control`
      }
      trigger={
        <button aria-label={several} className={triggerStyles} type="button">
          <RobotIcon aria-hidden size={15} weight="bold" />
          {label}
          {several !== undefined && (
            <span className={countStyles}>{agents.length}</span>
          )}
        </button>
      }
    >
      {several === undefined ? (
        <Panel agent={first} change={change} stop={stop} />
      ) : (
        <SessionsPanel
          agents={agents}
          change={change}
          stop={stop}
          title={`${several} are in control`}
        />
      )}
    </Popover>
  );
};

/** One session's panel. */
const Panel = ({ agent, change, stop }: Controls & { agent: Agent }) => {
  const now = useNow();
  return (
    <div className={panelStyles}>
      <span className={headStyles}>
        <strong>{`${agent.agent} is in control`}</strong>
        <span className={detailStyles}>
          {`It can see and use ${reach(agent)}.`}
        </span>
      </span>
      <Actions agent={agent} now={now} />
      <Buttons agent={agent} change={change} stop={stop} />
    </div>
  );
};

/** Several sessions' panel: each with its own buttons, then Stop all. */
const SessionsPanel = ({
  agents,
  change,
  stop,
  title,
}: Controls & { agents: Sessions; title: string }) => {
  const now = useNow();
  return (
    <div className={panelStyles}>
      <strong>{title}</strong>
      {agents.map((agent) => (
        <section
          aria-label={agent.agent}
          className={sessionStyles}
          key={agent.id}
        >
          <span className={headStyles}>
            <strong>{agent.agent}</strong>
            <span className={detailStyles}>
              {`Can see and use ${reach(agent)}.`}
            </span>
          </span>
          <Actions agent={agent} now={now} />
          <Buttons agent={agent} change={change} quiet stop={stop} />
        </section>
      ))}
      <span className={buttonsStyles}>
        <Button
          beforeIcon={<StopIcon aria-hidden weight="fill" />}
          onClick={() => {
            for (const agent of agents) {
              stop(agent);
            }
          }}
          size="sm"
          variant="danger"
        >
          Stop all
        </Button>
      </span>
    </div>
  );
};

/** What `agent` did last, if anything. */
const Actions = ({ agent, now }: { agent: Agent; now: number }) =>
  agent.actions.length > 0 && (
    <ul aria-label={`What ${agent.agent} did`} className={actionsStyles}>
      {agent.actions.map((action) => (
        <li
          className={actionStyles}
          key={`${String(action.atMs)}:${action.said}`}
        >
          <span className={saidStyles}>{action.said}</span>
          <time
            className={whenStyles}
            dateTime={new Date(action.atMs).toISOString()}
          >
            {ago(action.atMs, now)}
          </time>
        </li>
      ))}
    </ul>
  );

/** Change and Stop; `quiet` draws Stop without a fill, for one among several. */
const Buttons = ({
  agent,
  change,
  quiet = false,
  stop,
}: Controls & { agent: Agent; quiet?: boolean }) => (
  <span className={buttonsStyles}>
    <Button
      beforeIcon={<SlidersHorizontalIcon aria-hidden />}
      onClick={() => {
        change(agent);
      }}
      size="sm"
      variant="outline"
    >
      Change
    </Button>
    <Button
      beforeIcon={<StopIcon aria-hidden weight="fill" />}
      onClick={() => {
        stop(agent);
      }}
      size="sm"
      variant={quiet ? "dangerGhost" : "danger"}
    >
      Stop
    </Button>
  </span>
);

/** Several sessions, named once: "2 Claude Code sessions" or "3 agents". */
const sessionsName = (agents: Sessions, names: ReadonlySet<string>): string =>
  names.size === 1
    ? `${String(agents.length)} ${agents[0].agent} sessions`
    : `${String(agents.length)} agents`;

const isAgent = (session: Capturing): session is Agent =>
  session.kind === CapturingKind.Agent;

/** What an agent reaches, after "can see and use". */
const reach = (agent: Agent): string =>
  agent.reach.kind === "desk"
    ? "your whole desktop"
    : LIST.format(
        agent.reach.windows.map((window) =>
          window.title === "" ? "an untitled window" : window.title,
        ),
      );

/** How long ago `time` was at `now`, both epoch milliseconds. */
export const ago = (time: number, now: number): string => {
  const since = now - time;
  if (since < MINUTE_MS) {
    return "just now";
  } else if (since < HOUR_MS) {
    return `${String(Math.floor(since / MINUTE_MS))} min ago`;
  } else {
    return `${String(Math.floor(since / HOUR_MS))} hr ago`;
  }
};

/** The time now, moving on every {@link TICK_MS}. */
const useNow = (): number => {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const ticking = setInterval(() => {
      setNow(Date.now());
    }, TICK_MS);
    return () => {
      clearInterval(ticking);
    };
  }, []);
  return now;
};

// Violet, so it reads apart from the red sharing pill.
const triggerStyles = hstack({
  _hover: {
    backgroundColor: "color-mix(in oklab, {colors.violet.600} 85%, black)",
  },
  backgroundColor: "violet.600",
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

// How many sessions, on the pill.
const countStyles = center({
  backgroundColor: "color-mix(in oklab, currentcolor 24%, transparent)",
  blockSize: 4,
  borderRadius: "full",
  fontSize: "xs",
  inline: true,
  minInlineSize: 4,
  paddingInline: 1,
});

const panelStyles = flex({
  direction: "column",
  gap: 3,
  inlineSize: 72,
  paddingBlock: 1.5,
});

const headStyles = flex({ direction: "column", gap: 0.5 });

// A rule above each session, so they read apart.
const sessionStyles = flex({
  borderBlockStart:
    "1px solid color-mix(in oklab, currentcolor 15%, transparent)",
  direction: "column",
  gap: 3,
  paddingBlockStart: 3,
});

// At the panel's end, sized to their labels.
const buttonsStyles = hstack({ gap: 2, justifyContent: "flex-end" });

const detailStyles = css({ fontSize: "xs", opacity: 0.75 });

const actionsStyles = flex({
  backgroundColor: "color-mix(in oklab, currentcolor 8%, transparent)",
  borderRadius: "lg",
  direction: "column",
  listStyle: "none",
  margin: 0,
  padding: 1,
});

const actionStyles = hstack({
  fontSize: "sm",
  gap: 3,
  justifyContent: "space-between",
  padding: 1.5,
});

const saidStyles = css({
  minInlineSize: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
});

const whenStyles = css({ flexShrink: 0, fontSize: "xs", opacity: 0.75 });
