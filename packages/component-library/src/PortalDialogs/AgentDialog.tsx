import { CheckboxGroup } from "@base-ui/react/checkbox-group";
import type {
  AgentBody,
  AgentWindow,
  PortalAnswer,
} from "@domicile-desktop/sdk/portal";
import { PortalAnswer as Answer } from "@domicile-desktop/sdk/portal";
import { AppWindowIcon } from "@phosphor-icons/react/dist/ssr/AppWindow";
import { GlobeIcon } from "@phosphor-icons/react/dist/ssr/Globe";
import { SquaresFourIcon } from "@phosphor-icons/react/dist/ssr/SquaresFour";
import { useState } from "react";
import { css } from "../../styled-system/css";
import { flex } from "../../styled-system/patterns";
import { Button } from "../Button/Button";
import { CheckboxRow, ChoiceList, RadioRow } from "../ChoiceRow/ChoiceRow";
import { EmptyState } from "../EmptyState/EmptyState";
import { ModalDialog } from "../ModalDialog/ModalDialog";
import { Switch } from "../Switch/Switch";
import type { App } from "../useApps/useApps";
import type { Presence } from "./presence";
import { WindowIcon } from "./WindowIcon";

type Props = {
  answer: (answer: PortalAnswer) => void;
  apps: (appId: string) => App;
  body: AgentBody;
  /** Whether it is up; see {@link Presence}. */
  presence: Presence;
  screen: string | undefined;
};

/** What the user lets the agent reach. */
type Reach = "desk" | "windows";

/**
 * Whether an agent, such as Claude Code, may see and use the desk: all of
 * it, or only the windows the user checks, which none are at first. Allow
 * stays off until one is. With the whole desk, Remember lets it in without
 * asking next time. Dismissing it denies.
 *
 * Asked to change what an agent reaches, it starts from what it reaches
 * now, and dismissing it keeps that.
 */
export const AgentDialog = ({
  answer,
  apps,
  body,
  presence,
  screen,
}: Props) => {
  const changing = body.current !== undefined;
  const [reach, setReach] = useState<Reach>(
    body.current?.kind === "windows" ? "windows" : "desk",
  );
  const [checked, setChecked] = useState<readonly string[]>(() =>
    body.current?.kind === "windows"
      ? body.current.windows.map((window) => window.id)
      : [],
  );
  const [remember, setRemember] = useState(body.remembered);
  const picked = body.windows.filter((window) => checked.includes(window.id));
  return (
    <ModalDialog
      closeButton={false}
      footer={
        <>
          {reach === "desk" && (
            <span className={rememberStyles}>
              <Switch
                checked={remember}
                label={`Remember for ${body.agent}`}
                onCheckedChange={setRemember}
              />
            </span>
          )}
          <Button
            onClick={() => {
              answer(Answer.Canceled());
            }}
            variant="outline"
          >
            Cancel
          </Button>
          <Button
            disabled={reach === "windows" && picked.length === 0}
            onClick={() => {
              answer(
                reach === "desk"
                  ? Answer.Agent({ kind: "desk" }, remember)
                  : Answer.Agent({ kind: "windows", windows: picked }),
              );
            }}
          >
            {changing ? "Save" : "Allow"}
          </Button>
        </>
      }
      onOpenChange={(open) => {
        if (!open) {
          answer(Answer.Canceled());
        }
      }}
      {...presence}
      screen={screen}
      title={
        changing
          ? `Change what ${body.agent} can use`
          : `Let ${body.agent} use your desktop?`
      }
    >
      <p className={textStyles}>
        {changing
          ? "It keeps what it has if you cancel."
          : "It will see what you pick and click and type there. Stop it any time from the bar."}
      </p>
      <div className={choicesStyles}>
        <ChoiceList<Reach>
          aria-label="What it can use"
          onValueChange={(value) => {
            setReach(value);
          }}
          value={reach}
        >
          <RadioRow
            detail="Every window, plus your pointer and keyboard."
            icon={<SquaresFourIcon aria-hidden />}
            name="Entire desktop"
            value="desk"
          />
          <RadioRow
            detail="Your pointer and keyboard stay yours."
            icon={<AppWindowIcon aria-hidden />}
            name="Only these windows"
            value="windows"
          />
        </ChoiceList>
      </div>
      {reach === "windows" && (
        <CheckboxGroup
          aria-label="Windows it can use"
          className={windowsStyles}
          onValueChange={(value) => {
            setChecked(value);
          }}
          value={[...checked]}
        >
          {body.windows.map((window) => (
            <CheckboxRow
              detail={kindOf(apps, window)}
              icon={<Icon apps={apps} window={window} />}
              key={window.id}
              name={window.title === "" ? "Untitled window" : window.title}
              value={window.id}
            />
          ))}
          {body.windows.length === 0 && (
            <EmptyState layout="inline" title="No windows are open" />
          )}
          <p className={noteStyles}>Private windows are never shared.</p>
        </CheckboxGroup>
      )}
    </ModalDialog>
  );
};

/** A browser window's globe, or a native window's application icon. */
const Icon = ({
  apps,
  window,
}: {
  apps: (appId: string) => App;
  window: AgentWindow;
}) =>
  window.browser ? (
    <GlobeIcon aria-hidden />
  ) : (
    <WindowIcon app={window.app === undefined ? undefined : apps(window.app)} />
  );

/** What a window is, under its title: a browser, or its application. */
const kindOf = (apps: (appId: string) => App, window: AgentWindow): string => {
  if (window.browser) {
    return "Browser";
  } else {
    return window.app === undefined ? "Window" : apps(window.app).name;
  }
};

const textStyles = css({ color: "foreground", margin: 0 });

// At the footer's start, away from its buttons.
const rememberStyles = css({ fontSize: "sm", marginInlineEnd: "auto" });

const choicesStyles = css({ marginBlockStart: 3 });

// Nested under "Only these windows", in line with its text.
const windowsStyles = flex({
  direction: "column",
  gap: 1,
  marginBlockStart: 1,
  marginInlineStart: 8,
});

const noteStyles = css({
  color: "muted",
  fontSize: "xs",
  margin: 0,
  paddingBlockStart: 1,
  paddingInline: 2.5,
});
