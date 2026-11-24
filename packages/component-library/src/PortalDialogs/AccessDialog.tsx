import type { AccessBody, PortalAnswer } from "@domicile-desktop/sdk/portal";
import { PortalAnswer as Answer } from "@domicile-desktop/sdk/portal";
import { css } from "../../styled-system/css";
import { Button } from "../Button/Button";
import { ModalDialog } from "../ModalDialog/ModalDialog";
import type { Presence } from "./presence";

type Props = {
  answer: (answer: PortalAnswer) => void;
  /** Who asks, as the dialog names them; unnamed when the shell asks. */
  asker: string | undefined;
  body: AccessBody;
  /** Whether it is up; see {@link Presence}. */
  presence: Presence;
  screen: string | undefined;
};

/** A yes/no question from an application. Dismissing it denies. */
export const AccessDialog = ({
  answer,
  asker,
  body,
  presence,
  screen,
}: Props) => {
  // One line under the title. The subtitle mostly restates the title, so the
  // body wins when there is one.
  const detail = [body.body, body.subtitle].find((text) => text !== "");
  return (
    <ModalDialog
      closeButton={false}
      footer={
        <>
          {asker !== undefined && (
            <p className={askerStyles}>{`${asker} asks`}</p>
          )}
          <Button
            onClick={() => {
              answer(Answer.Canceled());
            }}
            variant="outline"
          >
            {body.denyLabel ?? "Deny"}
          </Button>
          <Button
            onClick={() => {
              answer(Answer.Access());
            }}
            variant={body.destructive ? "danger" : "accent"}
          >
            {body.grantLabel ?? "Allow"}
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
      title={body.title}
    >
      {detail !== undefined && <p className={detailStyles}>{detail}</p>}
    </ModalDialog>
  );
};

// Who asks sits opposite the buttons, leaving the body one line.
const askerStyles = css({
  color: "muted",
  fontSize: "ui",
  margin: 0,
  marginInlineEnd: "auto",
});

const detailStyles = css({ color: "muted", margin: 0 });
