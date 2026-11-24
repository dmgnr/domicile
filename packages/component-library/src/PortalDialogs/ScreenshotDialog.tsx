import type { BrowserWindow } from "@domicile-desktop/sdk/desktop/browser";
import type {
  FrozenDesk,
  PortalAnswer,
  ShotRect,
} from "@domicile-desktop/sdk/portal";
import { PortalAnswer as Answer } from "@domicile-desktop/sdk/portal";
import { useEffect, useState } from "react";
import { css } from "../../styled-system/css";
import { Button } from "../Button/Button";
import { ModalDialog } from "../ModalDialog/ModalDialog";
import type { App } from "../useApps/useApps";
import { onFrame } from "./on-frame";
import { usePicking } from "./picking";
import type { Presence } from "./presence";
import type { Region } from "./RegionPicker";
import { RegionPicker } from "./RegionPicker";
import type { Choice } from "./SourcePicker";
import { SourcePicker } from "./SourcePicker";
import type { ShownWindow } from "./shown-windows";
import { ShownWindowKind, shownArea } from "./shown-windows";
import {
  browserChoice,
  screenChoice,
  wholeDeskChoice,
  windowChoice,
} from "./source-choices";
import type { DrawPreview } from "./useWindowPreview";

type Props = {
  answer: (answer: PortalAnswer) => void;
  /** Names a window's application by its Wayland app id. */
  apps: (appId: string) => App;
  /** Who asks, as the dialog names them; absent when the shell itself asks. */
  asker: string | undefined;
  body: FrozenDesk;
  /** Whether it is up; see {@link Presence}. */
  presence: Presence;
  /** The desktop's browser windows, as the engine lists them. */
  browserWindows: readonly BrowserWindow[];
  screen: string | undefined;
  /** A browser window's page icon URL, if its page has one. */
  pageIcon: (id: string) => string | undefined;
  /** Draws a window that is not on screen. */
  previewWindow: DrawPreview;
  /** The windows the shell draws on screen, read once as the dialog opens. */
  shownWindows: () => readonly ShownWindow[];
};

/** What saving a choice keeps. */
enum PickKind {
  Area,
  Window,
  BrowserWindow,
}

const Pick = {
  /** An area of the frozen desk. */
  Area: (area: ShotRect) => ({ area, kind: PickKind.Area as const }),
  /**
   * A browser window from the engine's capture of its page, without what is
   * over it. A hidden one draws while it is captured.
   */
  BrowserWindow: (id: string, part?: ShotRect | undefined) => ({
    id,
    kind: PickKind.BrowserWindow as const,
    part,
  }),
  /**
   * A window from its own last frame, without what is over it, or `part` of
   * it, in the frame's pixels.
   */
  Window: (id: string, part?: ShotRect | undefined) => ({
    id,
    kind: PickKind.Window as const,
    part,
  }),
};

type Pick = ReturnType<(typeof Pick)[keyof typeof Pick]>;

/** Something the dialog offers to save, and what saving it keeps. */
type Picked = Choice & { pick: Pick };

/**
 * Picks what to save of a frozen desk: all of it, a screen or a window from
 * a list beside the desk, or an area dragged over the desk or selected on
 * screen over the frozen desk. The desk outlines the pick, with its size. A
 * window is saved from its own frame, so what is over it, such as a
 * notification, is left out. Copy, or Ctrl+C, copies the pick to the
 * clipboard instead of saving it. Dismissing it cancels.
 */
export const ScreenshotDialog = ({
  answer,
  apps,
  asker,
  body,
  browserWindows,
  pageIcon,
  presence,
  previewWindow,
  screen,
  shownWindows,
}: Props) => {
  // Read once, as the desk froze; a later move would not match the frame.
  const [shown] = useState(shownWindows);
  const whole: Picked = {
    ...wholeDeskChoice(body),
    pick: Pick.Area({ height: body.height, width: body.width, x: 0, y: 0 }),
  };
  const screens: Picked[] = body.monitors.map(
    ({ area, description, name }) => ({
      ...screenChoice(name, description, area),
      pick: Pick.Area(area),
    }),
  );
  const windows: Picked[] = [
    ...body.windows.map(({ appId, id, title }) => ({
      ...windowChoice(
        id,
        title,
        appId === "" ? undefined : apps(appId),
        shownArea(body, shown, ShownWindowKind.App, id),
      ),
      pick: Pick.Window(id),
    })),
    ...browserWindows.map(({ appId, id, title }) => ({
      ...browserChoice(
        id,
        title,
        pageIcon(id),
        shownArea(body, shown, ShownWindowKind.Browser, id),
        appId === "" ? undefined : apps(appId),
      ),
      pick: Pick.BrowserWindow(id),
    })),
  ];
  const choices = [whole, ...screens, ...windows];
  // The index of the choice picked, or the area dragged.
  const [picked, setPicked] = useState<number | ShotRect>(0);
  // A part dragged over the window picked, drawn alone as it is not on
  // screen.
  const [part, setPart] = useState<ShotRect | undefined>(undefined);
  const pick =
    typeof picked === "number"
      ? partOf(pickAt(choices, picked).pick, part)
      : Pick.Area(picked);
  // Whether the area is being selected on screen, over the frozen desk.
  const { dialog, picker, setPicking } = usePicking(presence);
  useEffect(() => {
    const copy = (event: KeyboardEvent) => {
      if (dialog.open && isCopy(event)) {
        event.preventDefault();
        answer(answerOf(pick, true));
      }
    };
    document.addEventListener("keydown", copy);
    return () => {
      document.removeEventListener("keydown", copy);
    };
  }, [answer, dialog.open, pick]);
  return (
    <>
      {picker !== undefined && (
        <RegionPicker
          actions={[
            {
              label: "Copy",
              pick: (region) => {
                answer(Answer.Screenshot(onFrameOf(body, region), true));
              },
              shortcut: isCopy,
            },
            {
              label: "Save",
              pick: (region) => {
                answer(Answer.Screenshot(onFrameOf(body, region), false));
              },
            },
          ]}
          back={() => {
            setPicking(false);
          }}
          cancel={() => {
            answer(Answer.Canceled());
          }}
          frozen={body}
          {...picker}
        />
      )}
      <ModalDialog
        closeButton={false}
        footer={
          <>
            <Button
              onClick={() => {
                setPicking(true);
              }}
              variant="ghost"
            >
              Select on screen
            </Button>
            <Button
              onClick={() => {
                answer(Answer.Canceled());
              }}
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              onClick={() => {
                answer(answerOf(pick, true));
              }}
              variant="outline"
            >
              Copy
            </Button>
            <Button
              onClick={() => {
                answer(answerOf(pick, false));
              }}
            >
              Save
            </Button>
          </>
        }
        onOpenChange={(open) => {
          if (!open) {
            answer(Answer.Canceled());
          }
        }}
        {...dialog}
        screen={screen}
        size="xl"
        title="Take a screenshot"
      >
        {asker !== undefined && (
          <p className={askerStyles}>{`${asker} asks`}</p>
        )}
        <SourcePicker
          caption={caption(
            typeof picked === "number" &&
              pickAt(choices, picked).area === undefined,
            part,
          )}
          desk={body}
          dragged={typeof picked === "number" ? undefined : picked}
          draggedPart={part}
          label="What to save"
          multiple={false}
          onDrag={(area) => {
            setPicked(area);
            setPart(undefined);
          }}
          onDragPart={setPart}
          onPick={([index]) => {
            if (index === undefined) {
              throw new Error("a screenshot pick of nothing");
            } else {
              setPicked(index);
              setPart(undefined);
            }
          }}
          picked={typeof picked === "number" ? [picked] : []}
          previewWindow={previewWindow}
          sections={[
            { choices: [whole], label: undefined },
            { choices: screens, label: "Screens" },
            { choices: windows, label: "Windows" },
          ]}
        />
      </ModalDialog>
    </>
  );
};

const askerStyles = css({ color: "muted", fontSize: "sm", margin: 0 });

/** Choice `index` of `choices`, which the list's radios number. */
const pickAt = (choices: readonly Picked[], index: number): Picked => {
  const choice = choices[index];
  if (choice === undefined) {
    throw new Error(`no screenshot choice ${String(index)}`);
  } else {
    return choice;
  }
};

/** `pick`, or `part` of it when it is a window and a part is dragged. */
const partOf = (pick: Pick, part: ShotRect | undefined): Pick => {
  switch (pick.kind) {
    case PickKind.Area:
      return pick;
    case PickKind.Window:
      return Pick.Window(pick.id, part);
    case PickKind.BrowserWindow:
      return Pick.BrowserWindow(pick.id, part);
  }
};

/** Under the desk, for a window `hidden` from it, with a `part` of it. */
const caption = (hidden: boolean, part: ShotRect | undefined): string => {
  if (part !== undefined) {
    return "A part of the window, as it last drew itself.";
  } else if (hidden) {
    return "Not on screen: saved as it last drew itself. Drag over it to pick a part.";
  } else {
    return "Drag over the desk to pick an area.";
  }
};

/** The answer that saves `pick`, and copies it too when `copy` is set. */
const answerOf = (pick: Pick, copy: boolean): PortalAnswer => {
  switch (pick.kind) {
    case PickKind.Area:
      return Answer.Screenshot(pick.area, copy);
    case PickKind.Window:
      return Answer.ScreenshotWindow(pick.id, copy, pick.part);
    case PickKind.BrowserWindow:
      return Answer.ScreenshotBrowserWindow(pick.id, copy, pick.part);
  }
};

/** `region` of the page in `desk`'s frame pixels; it must be on the desk. */
const onFrameOf = (desk: FrozenDesk, region: Region): ShotRect => {
  const area = onFrame(desk, {
    height: region.size[1],
    width: region.size[0],
    x: region.position[0],
    y: region.position[1],
  });
  if (area === undefined) {
    throw new Error("an area selected off the desk");
  } else {
    return area;
  }
};

/** Whether `event` is Ctrl+C, with no other modifier. */
const isCopy = (event: KeyboardEvent): boolean =>
  event.ctrlKey &&
  !event.altKey &&
  !event.metaKey &&
  !event.shiftKey &&
  event.key.toLowerCase() === "c";
