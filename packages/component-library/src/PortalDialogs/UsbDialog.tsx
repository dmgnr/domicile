import type {
  PortalAnswer,
  UsbBody,
  UsbDevice,
} from "@domicile-desktop/sdk/portal";
import { PortalAnswer as Answer } from "@domicile-desktop/sdk/portal";
import { css } from "../../styled-system/css";
import { flex } from "../../styled-system/patterns";
import { Button } from "../Button/Button";
import { ModalDialog } from "../ModalDialog/ModalDialog";
import type { Presence } from "./presence";

type Props = {
  answer: (answer: PortalAnswer) => void;
  /** Who asks, as the dialog names them. */
  asker: string;
  body: UsbBody;
  /** Whether it is up; see {@link Presence}. */
  presence: Presence;
  screen: string | undefined;
};

/**
 * USB devices an application would open, each with how it would use it.
 * Allowing grants them all; dismissing denies.
 */
export const UsbDialog = ({ answer, asker, body, presence, screen }: Props) => (
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
            answer(Answer.Access());
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
    title={`${asker} wants to use USB devices`}
  >
    <ul className={listStyles}>
      {body.devices.map((device) => (
        <li className={deviceStyles} key={device.id}>
          <span>{deviceName(device)}</span>
          <span className={accessStyles}>
            {device.writable ? "Read and write" : "Read only"}
          </span>
        </li>
      ))}
    </ul>
  </ModalDialog>
);

const listStyles = flex({
  direction: "column",
  gap: 2,
  listStyle: "none",
  margin: 0,
  padding: 0,
});

const deviceStyles = flex({ direction: "column" });

const accessStyles = css({ color: "muted", fontSize: "sm" });

/** A device's vendor and product, as far as udev knows them. */
const deviceName = ({ product, vendor }: UsbDevice): string => {
  const named = [vendor, product].filter((part) => part !== undefined);
  return named.length === 0 ? "Unknown device" : named.join(" ");
};
