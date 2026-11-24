import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { useRef } from "react";
import { css } from "../../styled-system/css";
import { FilePicker } from "../FilePicker/FilePicker";
import type { FileRequest } from "../FilePicker/file-request";
import { useScreenRegion } from "../Screen/DisplayProvider";
import type { Presence } from "./presence";

type Props = {
  /** Whether it is up; see {@link Presence}. */
  presence: Presence;
  request: FileRequest;
  /** The display to cover. Without it, the whole page. */
  screen: string | undefined;
};

/**
 * A `FilePicker` over `screen`, modal like `ModalDialog`: in a portal at the
 * dialogs' depth, with the rest of the page inert. Its box takes the keyboard
 * on open.
 *
 * The picker answers every key and press itself, Escape included, so the
 * dialog never closes on its own.
 */
export const ModalFilePicker = ({ presence, request, screen }: Props) => {
  const region = useScreenRegion(screen);
  const box = useRef<HTMLInputElement>(null);
  return (
    <BaseDialog.Root onOpenChange={stayOpen} {...presence}>
      <BaseDialog.Portal>
        {/* The picker is the dialog; this box only places it. */}
        <BaseDialog.Popup
          className={regionStyles}
          initialFocus={box}
          role="presentation"
          style={region}
        >
          <FilePicker ref={box} request={request} />
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
};

/** Ignores base-ui's requests to close; see {@link ModalFilePicker}. */
const stayOpen = () => {
  // The picker cancels through its request.
};

// At the other dialogs' depth, over every window.
const regionStyles = css({
  inset: 0,
  position: "fixed",
  zIndex: "modal",
});
