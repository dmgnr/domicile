import { Button } from "@domicile-desktop/component-library/Button";
import { Card } from "@domicile-desktop/component-library/Card";
import { CopyIcon } from "@phosphor-icons/react/dist/ssr/Copy";
import { useEffect, useState } from "react";

import { css } from "../../styled-system/css";
import type { ConfigEditor, Report } from "../config-editor";
import type { AgentReach, KnownAgents, SettingsHost, WebAgents } from "../host";
import { Notice } from "../Notice";
import { Page } from "../Page";
import { SettingRow } from "../SettingRow";
import { SwitchRow } from "../SwitchRow";
import { useAgents } from "../useAgents";
import { useWebAgents } from "../useWebAgents";

type Props = {
  title: string;
  description: string;
  host: SettingsHost;
  report: Report;
  /** The config, for `agents.web`; `undefined` while it can't be read. */
  editor: ConfigEditor | undefined;
};

const LIST = new Intl.ListFormat("en", { type: "conjunction" });

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Each agent connected now or remembered: what it reaches, with Stop for one
 * connected and Forget for one remembered, which makes it ask again.
 */
export const AgentsPage = ({
  description,
  editor,
  host,
  report,
  title,
}: Props) => {
  const { agents, failure, forget, stop } = useAgents(host, report);
  const { retry, signOut, webAgents } = useWebAgents(host, report);
  return (
    <Page description={description} title={title}>
      <FromTheWeb
        editor={editor}
        report={report}
        retry={retry}
        signOut={signOut}
        webAgents={webAgents}
      />
      {failure !== undefined && (
        <Notice tone="danger">
          Couldn't list agents:{" "}
          {failure instanceof Error ? failure.message : String(failure)}
        </Notice>
      )}
      {agents !== undefined && (
        <Card>
          {rows(agents).length === 0 ? (
            <p className={hintStyles}>
              No agent is connected or remembered. An agent asks the first time
              it uses your desktop.
            </p>
          ) : (
            <div>
              {rows(agents).map((row) => (
                <SettingRow
                  hint={said(row, Date.now())}
                  key={row.agent}
                  title={row.agent}
                >
                  {row.remembered !== undefined && (
                    <Button
                      label={`Forget ${row.agent}`}
                      onClick={() => {
                        forget(row.agent);
                      }}
                      size="sm"
                      variant="outline"
                    >
                      Forget
                    </Button>
                  )}
                  {row.sessions.length > 0 && (
                    <Button
                      label={`Stop ${row.agent}`}
                      onClick={() => {
                        for (const { session } of row.sessions) {
                          stop(session, row.agent);
                        }
                      }}
                      size="sm"
                      variant="dangerGhost"
                    >
                      Stop
                    </Button>
                  )}
                </SettingRow>
              ))}
            </div>
          )}
        </Card>
      )}
    </Page>
  );
};

/**
 * `agents.web`, which lets agents on the web reach the desk through the
 * relay: the desk's address to give them, and each one signed in.
 */
const FromTheWeb = ({
  editor,
  report,
  retry,
  signOut,
  webAgents,
}: {
  editor: ConfigEditor | undefined;
  report: Report;
  retry: () => void;
  signOut: (client: string, name: string) => void;
  webAgents: WebAgents | undefined;
}) => {
  const on = editor?.settings.agents.web ?? false;
  const address = on ? webAgents?.status?.address : undefined;
  return (
    <Card>
      <SwitchRow
        checked={on}
        disabled={editor === undefined || editor.readOnly !== undefined}
        hint="For agents that run on a website, such as claude.ai. They reach your desktop through Domicile's relay, which passes the connection along without being able to read it. Each one still signs in only once you allow it on your desktop, and asks before it uses anything."
        label="Connect from the web"
        onChange={(checked) => {
          editor?.set(["agents", "web"], checked ? true : undefined);
        }}
      />
      {on && (
        <SettingRow
          hint={addressHint(webAgents?.status)}
          title="Your desktop's address"
        >
          {webAgents?.status?.problem === undefined ? (
            address !== undefined && (
              <CopyButton report={report} text={address} />
            )
          ) : (
            <Button onClick={retry} size="sm" variant="outline">
              Try again
            </Button>
          )}
        </SettingRow>
      )}
      {address !== undefined && (
        <code className={addressStyles}>{address}</code>
      )}
      {webAgents?.signedIn.map(({ client, lastUsedMs, name }) => (
        <SettingRow
          hint={`Signed in · Last used ${lastUsed(lastUsedMs, Date.now())}`}
          key={client}
          title={name}
        >
          <Button
            label={`Sign out ${name}`}
            onClick={() => {
              signOut(client, name);
            }}
            size="sm"
            variant="outline"
          >
            Sign out
          </Button>
        </SettingRow>
      ))}
    </Card>
  );
};

/** What the address row says, as `domicile mcp --relay` reports. */
export const addressHint = (status: WebAgents["status"]): string => {
  if (status?.problem !== undefined) {
    return status.problem;
  } else if (status?.address === undefined) {
    return "Connecting to the relay…";
  } else if (status.ready) {
    return "Add it to the agent as a connector.";
  } else {
    return "Getting your desktop ready. This takes a minute or so the first time.";
  }
};

/** How long Copy says Copied. */
const COPIED_MS = 2000;

const CopyButton = ({ report, text }: { report: Report; text: string }) => {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) {
      return;
    }
    const after = setTimeout(() => {
      setCopied(false);
    }, COPIED_MS);
    return () => {
      clearTimeout(after);
    };
  }, [copied]);
  return (
    <Button
      beforeIcon={<CopyIcon />}
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
        }, report("Couldn't copy the address"));
      }}
      size="sm"
      variant="outline"
    >
      {copied ? "Copied" : "Copy"}
    </Button>
  );
};

const addressStyles = css({
  bg: "surface",
  borderRadius: "md",
  color: "foreground",
  fontFamily: "mono",
  fontSize: "xs",
  overflowWrap: "anywhere",
  paddingBlock: 2,
  paddingInline: 3,
});

/** One agent by name: each of its sessions, and whether it is remembered. */
type Row = {
  agent: string;
  sessions: KnownAgents["connected"];
  /** When it was last let in, if remembered. */
  remembered: number | undefined;
};

/** Connected agents first, oldest first, then the rest remembered. */
export const rows = (agents: KnownAgents): Row[] => {
  const byName = new Map<string, Row>();
  for (const connected of agents.connected) {
    const row = byName.get(connected.agent) ?? {
      agent: connected.agent,
      remembered: undefined,
      sessions: [],
    };
    byName.set(connected.agent, {
      ...row,
      sessions: [...row.sessions, connected],
    });
  }
  for (const { agent, lastUsedMs } of agents.remembered) {
    const row = byName.get(agent) ?? {
      agent,
      remembered: undefined,
      sessions: [],
    };
    byName.set(agent, { ...row, remembered: lastUsedMs });
  }
  return [...byName.values()];
};

/** What a row says under its name, at `now`. */
export const said = (row: Row, now: number): string =>
  [
    ...(row.sessions.length > 0
      ? ["Connected now", reaches(row.sessions.map(({ reach }) => reach))]
      : []),
    ...(row.remembered === undefined
      ? []
      : [
          "Remembered",
          ...(row.sessions.length > 0 ? [] : ["Your whole desktop"]),
          `Last used ${lastUsed(row.remembered, now)}`,
        ]),
  ].join(" · ");

/** What its sessions reach, together. */
const reaches = (reach: readonly AgentReach[]): string =>
  reach.some(({ type }) => type === "desk")
    ? "Your whole desktop"
    : LIST.format(
        reach.flatMap((each) =>
          each.type === "windows"
            ? each.windows.map(({ title }) =>
                title === "" ? "an untitled window" : title,
              )
            : [],
        ),
      );

/** When `time` was, in days, at `now`. */
export const lastUsed = (time: number, now: number): string => {
  const days =
    Math.floor(startOfDay(now) / DAY_MS) -
    Math.floor(startOfDay(time) / DAY_MS);
  if (days <= 0) {
    return "today";
  } else if (days === 1) {
    return "yesterday";
  } else {
    return `${String(days)} days ago`;
  }
};

/** The local midnight before `time`, as a count of milliseconds. */
const startOfDay = (time: number): number => {
  const day = new Date(time);
  day.setHours(0, 0, 0, 0);
  return day.getTime() - day.getTimezoneOffset() * 60 * 1000;
};

const hintStyles = css({ color: "muted", fontSize: "xs", margin: 0 });
