import { Button } from "@domicile-desktop/component-library/Button";
import {
  ChoiceList,
  RadioRow,
} from "@domicile-desktop/component-library/ChoiceRow";
import { ModalDialog } from "@domicile-desktop/component-library/ModalDialog";
import type { Icon } from "@phosphor-icons/react";
import { useState } from "react";

import { css } from "../styled-system/css";

/** One address an inbox writes email from. */
export type Sender = {
  /** The address, such as `me@example.com` or an alias. */
  address: string;
  /** The inbox's icon. */
  icon: Icon;
  /** The inbox's name, such as `Work`. */
  inbox: string;
};

type Props = {
  /** The `mailto:` link, shown on one line at the bottom. */
  link: string;
  /** The name of the application that asked, if known. */
  asker?: string | undefined;
  /** Every address it may write from, in the order listed. */
  senders: readonly Sender[];
  /** The address picked last time, which starts picked. */
  lastChoice?: string | undefined;
  onChoose: (sender: Sender) => void;
  onCancel: () => void;
  /** Whether it is up. Turned off, it animates out. */
  open?: boolean | undefined;
  screen?: string | undefined;
};

/**
 * Pick which inbox, and which of its addresses, to write a `mailto:` link's
 * email from. The address picked last time, else the first, starts picked.
 * Enter writes; dismissing it cancels.
 */
export const MailPicker = ({
  asker,
  lastChoice,
  link,
  onCancel,
  onChoose,
  open = true,
  screen,
  senders,
}: Props) => {
  const [picked, setPicked] = useState<string | undefined>();
  const chosen =
    senders.find(({ address }) => address === picked) ??
    senders.find(({ address }) => address === lastChoice) ??
    senders[0];
  const write = () => {
    if (chosen !== undefined) {
      onChoose(chosen);
    }
  };
  const to = recipientsOf(link);
  return (
    <ModalDialog
      closeButton={false}
      footer={
        <>
          {asker !== undefined && (
            <p className={askerStyles}>{`${asker} asks`}</p>
          )}
          <Button onClick={onCancel} variant="outline">
            Cancel
          </Button>
          <Button
            disabled={chosen === undefined}
            onClick={write}
            variant="accent"
          >
            Write email
          </Button>
        </>
      }
      onOpenChange={(opening) => {
        if (!opening) {
          onCancel();
        }
      }}
      open={open}
      screen={screen}
      title={to === "" ? "Write an email" : `Write to ${to}`}
    >
      <p className={textStyles}>Choose the inbox to send from.</p>
      <div className={listStyles}>
        <ChoiceList<string>
          aria-label="Send from"
          // Enter on a row writes, as the dialog's main button does.
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              write();
            }
          }}
          onValueChange={setPicked}
          value={chosen?.address}
        >
          {senders.map(({ address, icon: SenderIcon, inbox }) => (
            <RadioRow
              detail={address}
              icon={<SenderIcon weight="duotone" />}
              key={address}
              name={inbox}
              value={address}
            />
          ))}
        </ChoiceList>
      </div>
      <p className={addressStyles}>{link}</p>
    </ModalDialog>
  );
};

/** The addresses a `mailto:` link writes to, as people read them. */
const recipientsOf = (link: string): string => {
  const to = link.slice(link.indexOf(":") + 1).split("?")[0] ?? "";
  return decodeURIComponent(to).split(",").join(", ");
};

const textStyles = css({ color: "muted", margin: 0 });

// Who asks sits opposite the buttons, as in the app chooser.
const askerStyles = css({
  color: "muted",
  fontSize: "ui",
  margin: 0,
  marginInlineEnd: "auto",
});

const listStyles = css({
  marginBlockStart: 3,
  maxBlockSize: 80,
  overflowY: "auto",
});

// A link can be long, with no spaces, as the app chooser's address can.
const addressStyles = css({
  color: "muted",
  fontFamily: "mono",
  fontSize: "xs",
  marginBlockEnd: 0,
  marginBlockStart: 3,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
});
