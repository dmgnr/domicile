import type {
  ChosenTrigger,
  PortalAnswer,
  ProposedShortcut,
  ShortcutsBody,
} from "@domicile-desktop/sdk/portal";
import { PortalAnswer as Answer } from "@domicile-desktop/sdk/portal";
import { useState } from "react";
import { css } from "../../styled-system/css";
import { Button } from "../Button/Button";
import { Field } from "../Field/Field";
import { Input } from "../Input/Input";
import { ModalDialog } from "../ModalDialog/ModalDialog";
import type { App } from "../useApps/useApps";
import type { ChordCheck } from "./chord-check";
import { ChordCheckKind, checkChord, holders } from "./chord-check";
import type { Presence } from "./presence";

/** A shortcut and the chord typed for it. */
type Row = { chord: string; shortcut: ProposedShortcut };

type Props = {
  answer: (answer: PortalAnswer) => void;
  apps: (appId: string) => App;
  /** Who asks, as the dialog names them. */
  asker: string;
  body: ShortcutsBody;
  /** Whether it is up; see {@link Presence}. */
  presence: Presence;
  screen: string | undefined;
  /** The shell's own chords, flagged as conflicts. */
  shellChords: readonly string[];
};

/**
 * A review of the chords an application asks to hold. Each can be accepted,
 * changed or cleared; one another holds is flagged. Declining clears them
 * all, so the application binds them unbound later without asking again.
 * Dismissing it binds nothing and keeps no choice.
 */
export const GlobalShortcutsDialog = ({
  answer,
  apps,
  asker,
  body,
  presence,
  screen,
  shellChords,
}: Props) => {
  const [written, setWritten] = useState<readonly Row[]>(() =>
    body.shortcuts.map((shortcut) => ({
      chord: shortcut.trigger ?? "",
      shortcut,
    })),
  );
  const held = holders(shellChords, body.taken);
  const rows = written.map(({ chord, shortcut }) => ({
    check: checkChord(chord, held),
    chord,
    shortcut,
  }));

  return (
    <ModalDialog
      closeButton={false}
      footer={
        <>
          <Button
            onClick={() => {
              answer(
                Answer.GlobalShortcuts(
                  rows.map(
                    ({ shortcut }): ChosenTrigger => ({
                      id: shortcut.id,
                      trigger: undefined,
                    }),
                  ),
                ),
              );
            }}
            variant="outline"
          >
            Decline
          </Button>
          <Button
            disabled={rows.some(
              ({ check }) => check.kind === ChordCheckKind.Invalid,
            )}
            onClick={() => {
              answer(
                Answer.GlobalShortcuts(
                  rows.map(
                    ({ check, shortcut }): ChosenTrigger => ({
                      id: shortcut.id,
                      trigger: chosen(check),
                    }),
                  ),
                ),
              );
            }}
          >
            Bind
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
      title="Global shortcuts"
    >
      <p className={askerStyles}>
        {`${asker} wants shortcuts that work in any window`}
      </p>
      {rows.map(({ check, chord, shortcut }) => (
        <Field
          hint={note(check, apps)}
          invalid={check.kind === ChordCheckKind.Invalid}
          key={shortcut.id}
          label={
            shortcut.description === "" ? shortcut.id : shortcut.description
          }
        >
          <Input
            clearable
            onValueChange={(value) => {
              setWritten((all) =>
                all.map((row) =>
                  row.shortcut === shortcut ? { ...row, chord: value } : row,
                ),
              );
            }}
            placeholder="Unbound"
            value={chord}
          />
        </Field>
      ))}
    </ModalDialog>
  );
};

const askerStyles = css({ color: "muted", fontSize: "sm", margin: 0 });

/** The trigger to bind for `check`, in its one spelling. */
const chosen = (check: ChordCheck): string | undefined => {
  switch (check.kind) {
    case ChordCheckKind.Free:
    case ChordCheckKind.Taken:
      return check.chord;
    case ChordCheckKind.Cleared:
    case ChordCheckKind.Invalid:
      return undefined;
  }
};

/**
 * What the field says under the chord. In the hint, not an error popover, so
 * a chord half typed does not take focus.
 */
const note = (
  check: ChordCheck,
  apps: (appId: string) => App,
): string | undefined => {
  switch (check.kind) {
    case ChordCheckKind.Invalid:
      return check.message;
    case ChordCheckKind.Taken:
      return check.by === undefined
        ? "The desktop uses this chord"
        : `${apps(check.by).name} uses this chord`;
    case ChordCheckKind.Cleared:
    case ChordCheckKind.Free:
      return undefined;
  }
};
