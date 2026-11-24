import type {
  Devices,
  PortalAnswer,
  RemoteDesktopBody,
} from "@domicile-desktop/sdk/portal";
import { PortalAnswer as Answer } from "@domicile-desktop/sdk/portal";
import { useState } from "react";
import { css } from "../../styled-system/css";
import { flex } from "../../styled-system/patterns";
import { Button } from "../Button/Button";
import { ModalDialog } from "../ModalDialog/ModalDialog";
import { Switch } from "../Switch/Switch";
import { deviceNames } from "./device-names";
import type { Presence } from "./presence";

const LABELS = {
  keyboard: "Keyboard",
  pointer: "Pointer",
  touchscreen: "Touchscreen",
} as const;

type Props = {
  answer: (answer: PortalAnswer) => void;
  /** Who asks, as the dialog names them. */
  asker: string;
  body: RemoteDesktopBody;
  /** Whether it is up; see {@link Presence}. */
  presence: Presence;
  screen: string | undefined;
};

/**
 * Which devices, and the clipboard, an application may control. Offers only
 * what it asked for, all on. Dismissing it denies.
 */
export const RemoteDesktopDialog = ({
  answer,
  asker,
  body,
  presence,
  screen,
}: Props) => {
  const [devices, setDevices] = useState<Devices>(body.devices);
  const [clipboard, setClipboard] = useState(body.clipboard);
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
            Deny
          </Button>
          <Button
            onClick={() => {
              answer(Answer.RemoteDesktop(devices, clipboard));
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
      title="Allow remote control?"
    >
      <p className={textStyles}>{`${asker} wants to control your computer.`}</p>
      <div className={switchesStyles}>
        {deviceNames(body.devices).map((device) => (
          <Switch
            checked={devices[device]}
            key={device}
            label={LABELS[device]}
            onCheckedChange={(checked) => {
              setDevices((held) => ({ ...held, [device]: checked }));
            }}
          />
        ))}
        {body.clipboard && (
          <Switch
            checked={clipboard}
            label="Share clipboard"
            onCheckedChange={setClipboard}
          />
        )}
      </div>
    </ModalDialog>
  );
};

const textStyles = css({ color: "foreground", margin: 0 });

const switchesStyles = flex({
  direction: "column",
  gap: 2,
  marginBlockStart: 3,
});
