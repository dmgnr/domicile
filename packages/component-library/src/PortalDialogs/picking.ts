import { useState } from "react";
import type { Presence } from "./presence";

/**
 * A dialog that hands over to a picker, such as its `RegionPicker`, and back,
 * each fading out as the other comes in. `dialog` goes to the dialog's root;
 * `picker`, while it is drawn, to the picker. Whichever is up when `presence`
 * closes fades out, then completes it.
 */
export const usePicking = ({
  onOpenChangeComplete,
  open,
}: Presence): {
  dialog: Presence;
  picker: Presence | undefined;
  /** Brings the picker up, or with `false`, back to the dialog. */
  setPicking: (picking: boolean) => void;
} => {
  const [picking, setPicking] = useState(false);
  // Drawn, though perhaps fading out.
  const [drawn, setDrawn] = useState(false);
  return {
    dialog: {
      onOpenChangeComplete: (opened) => {
        if (!opened && !picking) {
          onOpenChangeComplete(false);
        }
      },
      open: open && !picking,
    },
    picker: drawn
      ? {
          onOpenChangeComplete: (opened) => {
            if (!opened) {
              setDrawn(false);
              if (!open) {
                onOpenChangeComplete(false);
              }
            }
          },
          open: open && picking,
        }
      : undefined,
    setPicking: (pick) => {
      setPicking(pick);
      if (pick) {
        setDrawn(true);
      }
    },
  };
};
