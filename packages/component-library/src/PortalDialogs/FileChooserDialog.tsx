import type {
  FileChoice,
  FileChooserBody,
  PortalAnswer,
} from "@domicile-desktop/sdk/portal";
import {
  PortalAnswer as Answer,
  FileChooserMode,
} from "@domicile-desktop/sdk/portal";
import { useState } from "react";
import { css } from "../../styled-system/css";
import { ChooserMode } from "../FilePicker/file-request";
import type { Folders } from "../FilePicker/folders";
import { Select } from "../Select/Select";
import { ModalFilePicker } from "./ModalFilePicker";
import type { Presence } from "./presence";

/** A boolean choice's answers, as the portal spells them. */
const YES_NO = [
  { label: "No", value: "false" },
  { label: "Yes", value: "true" },
] as const;

type Props = {
  answer: (answer: PortalAnswer) => void;
  body: FileChooserBody;
  folders: Folders;
  /** Whether it is up; see {@link Presence}. */
  presence: Presence;
  screen: string | undefined;
};

/**
 * An application's file chooser: the `FilePicker` over `screen`, or the
 * whole page, with the application's choices beside its buttons. Its box
 * takes the keyboard on open.
 */
export const FileChooserDialog = ({
  answer,
  body,
  folders,
  presence,
  screen,
}: Props) => {
  const [choices, setChoices] = useState<ReadonlyMap<string, string>>(
    () => new Map(body.choices.map((choice) => [choice.id, choice.initial])),
  );
  return (
    <ModalFilePicker
      presence={presence}
      request={{
        accept: [],
        acceptLabel: body.acceptLabel ?? acceptOf(body.mode),
        cancel: () => {
          answer(Answer.Canceled());
        },
        choose: (paths, filter) => {
          answer(Answer.FileChooser({ choices, currentFilter: filter, paths }));
        },
        controls: (
          <>
            {body.mode === FileChooserMode.SaveFiles && (
              <span
                className={savesStyles}
              >{`Saves ${body.files.join(", ")}`}</span>
            )}
            {body.choices.map((choice) => (
              <Choice
                choice={choice}
                key={choice.id}
                onChange={(value) => {
                  setChoices(new Map(choices).set(choice.id, value));
                }}
                value={choices.get(choice.id)}
              />
            ))}
          </>
        ),
        currentFilter: body.currentFilter,
        currentFolder: body.currentFolder,
        filters: body.filters.length === 0 ? undefined : body.filters,
        folders,
        home: body.home,
        mode: chooserModeOf(body),
        suggestedName: body.currentName ?? "",
        title: body.title,
      }}
      screen={screen}
    />
  );
};

/** One of the application's questions: a select of its options, or yes/no. */
const Choice = ({
  choice,
  onChange,
  value,
}: {
  choice: FileChoice;
  onChange: (value: string) => void;
  value: string | undefined;
}) => (
  <Select
    aria-label={choice.label}
    onValueChange={(picked) => {
      if (picked !== null) {
        onChange(picked);
      }
    }}
    options={
      choice.options.length === 0
        ? YES_NO
        : choice.options.map((option) => ({
            label: option.label,
            value: option.id,
          }))
    }
    value={value}
  />
);

const savesStyles = css({ color: "muted", fontSize: "sm" });

/** The picker's mode for what the application asked. */
const chooserModeOf = (body: FileChooserBody): ChooserMode => {
  switch (body.mode) {
    case FileChooserMode.Open:
      return openModeOf(body);
    case FileChooserMode.Save:
      return ChooserMode.Save;
    case FileChooserMode.SaveFiles:
      return ChooserMode.OpenFolder;
  }
};

const openModeOf = (body: FileChooserBody): ChooserMode => {
  if (body.directory) {
    return ChooserMode.OpenFolder;
  } else {
    return body.multiple ? ChooserMode.OpenMultiple : ChooserMode.Open;
  }
};

/** `SaveFiles` picks a folder, but the user is saving. */
const acceptOf = (mode: FileChooserMode): string | undefined =>
  mode === FileChooserMode.SaveFiles ? "Save" : undefined;
