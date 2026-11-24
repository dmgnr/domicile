import { Button } from "@domicile-desktop/component-library/Button";
import { Switch } from "@domicile-desktop/component-library/Switch";
import type { MessageBox } from "@domicile-desktop/sdk/message-box";
import type { RefCallback } from "react";
import { useState } from "react";

import { PageModal } from "./PageModal";

type Props = {
  box: MessageBox;
  /** The user pressed button `button`, leaving the checkbox `checked`. */
  onAnswer: (button: number, checked: boolean) => void;
  /** Gets the element to focus: the default button, or else Cancel. */
  ref?: RefCallback<HTMLElement> | undefined;
};

/**
 * An Electron app's message box (`dialog.showMessageBox`), over the window
 * that asked, as a page's `confirm()` is.
 *
 * The app's buttons, in the app's order, with its default one in the accent
 * color. A `PageModal`: Enter presses the default button, if the app named
 * one, and Escape presses its cancel button. The app's checkbox, such as
 * "Don't ask again", is a switch, as other asks' are. Takes no focus itself:
 * the caller focuses `ref`'s element as its own focus rules allow. Key it by
 * the box, so each starts with the app's checkbox.
 */
export const AppMessageBox = ({ box, onAnswer, ref }: Props) => {
  const [checked, setChecked] = useState(box.checkboxChecked);
  const focused = box.defaultButton ?? box.cancelButton;
  return (
    <PageModal
      footer={box.buttons.map((label, button) => (
        <Button
          // The app's buttons have no ids but their places, which a box never
          // changes.
          key={button}
          onClick={
            button === box.defaultButton
              ? undefined
              : () => {
                  onAnswer(button, checked);
                }
          }
          ref={button === focused ? ref : undefined}
          type={button === box.defaultButton ? "submit" : "button"}
          variant={button === box.defaultButton ? "accent" : "outline"}
        >
          {label}
        </Button>
      ))}
      message={box.detail === "" ? undefined : box.detail}
      onDismiss={() => {
        onAnswer(box.cancelButton, checked);
      }}
      onSubmit={() => {
        if (box.defaultButton !== undefined) {
          onAnswer(box.defaultButton, checked);
        }
      }}
      title={box.message}
    >
      {box.checkbox !== undefined && (
        <Switch
          checked={checked}
          label={box.checkbox}
          onCheckedChange={setChecked}
        />
      )}
    </PageModal>
  );
};
