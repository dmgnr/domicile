import type {
  InputCaptureBody,
  PortalAnswer,
} from "@domicile-desktop/sdk/portal";
import { PortalAnswer as Answer } from "@domicile-desktop/sdk/portal";
import { css } from "../../styled-system/css";
import { Button } from "../Button/Button";
import { ModalDialog } from "../ModalDialog/ModalDialog";
import { deviceNames } from "./device-names";
import type { Presence } from "./presence";

const LIST = new Intl.ListFormat("en", { type: "conjunction" });

type Props = {
  answer: (answer: PortalAnswer) => void;
  /** Who asks, as the dialog names them. */
  asker: string;
  body: InputCaptureBody;
  /** Whether it is up; see {@link Presence}. */
  presence: Presence;
  screen: string | undefined;
};

/** Whether an application may take input that leaves the screen. Dismissing it denies. */
export const InputCaptureDialog = ({
  answer,
  asker,
  body,
  presence,
  screen,
}: Props) => (
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
          Deny
        </Button>
        <Button
          onClick={() => {
            answer(Answer.InputCapture());
          }}
        >
          Allow
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
    title="Allow input capture?"
  >
    <p className={textStyles}>
      {`${asker} wants to capture your ${LIST.format(deviceNames(body.devices))} when the pointer leaves the screen.`}
    </p>
  </ModalDialog>
);

const textStyles = css({ color: "foreground", margin: 0 });
