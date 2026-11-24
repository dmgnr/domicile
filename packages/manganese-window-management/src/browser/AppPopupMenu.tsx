import { ContextMenu } from "@domicile-desktop/component-library/ContextMenu";
import type { AppMenuEntry } from "@domicile-desktop/sdk/app-menu";
import { useRef, useState } from "react";

import { AppMenuEntries } from "./AppMenuBar";

type Props = {
  entries: readonly AppMenuEntry[];
  /** Where it goes, in the viewport's CSS pixels. */
  at: { x: number; y: number };
  /** The entry chosen, or 0 once it is put away with none. Called once. */
  onAnswer: (command: number) => void;
};

/**
 * An Electron app's popup menu (`Menu.popup`), such as one its menu button
 * opens, drawn with the shell's menus. See "Menu bars" in
 * docs/SHELL-BROWSER-WINDOWS.md.
 */
export const AppPopupMenu = ({ at, entries, onAnswer }: Props) => {
  // A choice closes the menu too, and the app hears only the choice.
  const answered = useRef(false);
  const [open, setOpen] = useState(true);
  const answer = (command: number) => {
    if (!answered.current) {
      answered.current = true;
      onAnswer(command);
    }
  };
  return (
    <ContextMenu
      at={at}
      label="Application"
      onOpenChange={(opening) => {
        if (!opening) {
          setOpen(false);
          answer(0);
        }
      }}
      open={open}
    >
      <AppMenuEntries entries={entries} onChoose={answer} />
    </ContextMenu>
  );
};
