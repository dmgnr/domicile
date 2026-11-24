import type { LauncherBody, PortalAnswer } from "@domicile-desktop/sdk/portal";
import { PortalAnswer as Answer } from "@domicile-desktop/sdk/portal";
import { useState } from "react";
import { css } from "../../styled-system/css";
import { hstack } from "../../styled-system/patterns";
import { Button } from "../Button/Button";
import { Input } from "../Input/Input";
import { ModalDialog } from "../ModalDialog/ModalDialog";
import type { Presence } from "./presence";

type Props = {
  answer: (answer: PortalAnswer) => void;
  /** Who asks, as the dialog names them. */
  asker: string;
  body: LauncherBody;
  /** Whether it is up; see {@link Presence}. */
  presence: Presence;
  screen: string | undefined;
};

/**
 * A launcher an application would add to the desktop's apps, with its icon,
 * a name the user may change and a web app's address. Dismissing it adds
 * nothing.
 */
export const LauncherDialog = ({
  answer,
  asker,
  body,
  presence,
  screen,
}: Props) => {
  const [name, setName] = useState(body.name);
  const trimmed = name.trim();
  return (
    <ModalDialog
      closeButton={false}
      footer={
        <>
          <Button
            onClick={() => {
              answer(Answer.Canceled());
            }}
            variant="outline"
          >
            Cancel
          </Button>
          <Button
            disabled={trimmed === ""}
            onClick={() => {
              answer(Answer.DynamicLauncher(trimmed));
            }}
          >
            Add
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
      title={`${asker} wants to add an app`}
    >
      <div className={rowStyles}>
        {body.icon !== undefined && (
          <img alt="App icon" className={iconStyles} src={body.icon} />
        )}
        <Input
          aria-label="Name"
          onChange={(event) => {
            setName(event.target.value);
          }}
          readOnly={!body.editableName}
          value={name}
        />
      </div>
      {body.target !== undefined && (
        <p className={targetStyles}>{body.target}</p>
      )}
    </ModalDialog>
  );
};

const rowStyles = hstack({ gap: 3 });

const iconStyles = css({ blockSize: 12, flexShrink: 0, inlineSize: 12 });

const targetStyles = css({
  color: "muted",
  fontSize: "sm",
  margin: 0,
  overflowWrap: "anywhere",
});
