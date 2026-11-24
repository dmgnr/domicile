// Clicks on something a person can open here or in a new tab, as a link.

/** `MouseEvent.button` for the middle button. */
const MIDDLE_BUTTON = 1;

type Click = { button: number; ctrlKey: boolean };

/**
 * `onClick` and `onAuxClick` handlers that call `onOpen` for a click, and
 * `onOpenInNew` for a middle click or a Ctrl+click, as Chrome opens a link in
 * a new tab.
 */
export const newTabClick = (onOpen: () => void, onOpenInNew: () => void) => ({
  onAuxClick: (event: Click) => {
    if (event.button === MIDDLE_BUTTON) {
      onOpenInNew();
    }
  },
  onClick: (event: Click) => {
    if (event.ctrlKey) {
      onOpenInNew();
    } else {
      onOpen();
    }
  },
});
