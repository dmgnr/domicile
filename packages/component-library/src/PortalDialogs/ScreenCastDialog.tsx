import type { BrowserWindow } from "@domicile-desktop/sdk/desktop/browser";
import type {
  CastSource,
  PortalAnswer,
  ScreenCastBody,
  ShotRect,
} from "@domicile-desktop/sdk/portal";
import {
  PortalAnswer as Answer,
  CastSourceKind,
  CastSource as Source,
} from "@domicile-desktop/sdk/portal";
import { useState } from "react";
import { css } from "../../styled-system/css";
import { Button } from "../Button/Button";
import { ModalDialog } from "../ModalDialog/ModalDialog";
import type { App } from "../useApps/useApps";
import { onDesk } from "./on-frame";
import { usePicking } from "./picking";
import type { Presence } from "./presence";
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
  /** Who asks, as the dialog names them. */
  asker: string;
  body: ScreenCastBody;
  /** The desktop's browser windows, as the engine lists them. */
  browserWindows: readonly BrowserWindow[];
  /** The TV a cast that asked shows the pick on, titling the dialog for it. */
  castTo?: string | undefined;
  /** Whether it is up; see {@link Presence}. */
  presence: Presence;
  screen: string | undefined;
  /** A browser window's page icon URL, if its page has one. */
  pageIcon: (id: string) => string | undefined;
  /** Draws a window that is not on screen. */
  previewWindow: DrawPreview;
  /**
   * Whether the shell asks, for its own screen recording: the dialog then
   * records rather than shares, and names nobody.
   */
  record?: boolean | undefined;
  /** The windows the shell draws on screen, read once as the dialog opens. */
  shownWindows: () => readonly ShownWindow[];
};

/** Something the dialog offers to share. */
type Offered = Choice & { source: CastSource };

/**
 * A source picker laid out as the screenshot picker is: the screens,
 * windows and browser windows an application may record in a list beside
 * the desk shot as it opened, which outlines each pick. A browser window is
 * its page alone, from the engine. Picks one, or several when the
 * application asks for more, or, when it may have a region, an area dragged
 * over the desk shot as the screenshot picker's is, or selected on the live
 * screen. Dismissing it cancels. For a cast to a TV, it is titled for the TV
 * rather than for who asks. For the shell's own screen recording, it offers
 * to record instead.
 */
export const ScreenCastDialog = ({
  answer,
  apps,
  asker,
  body,
  browserWindows,
  castTo,
  pageIcon,
  previewWindow,
  record = false,
  presence,
  screen,
  shownWindows,
}: Props) => {
  // Read once, as the desk was shot; a later move would not match it.
  const [shown] = useState(shownWindows);
  const { desk } = body;
  // All of the desk, as a region, when the application may have one.
  const whole: Offered[] =
    body.region && desk !== undefined
      ? [
          {
            ...wholeDeskChoice(desk),
            source: Source.Region({
              position: desk.desk.position,
              size: desk.desk.size,
            }),
          },
        ]
      : [];
  // The whole desk, first in the list, is picked as the dialog opens.
  const [picked, setPicked] = useState<readonly number[]>(
    whole.length > 0 ? [0] : [],
  );
  // An area of the desk shot dragged in place of the picks.
  const [dragged, setDragged] = useState<ShotRect | undefined>(undefined);
  // A part dragged over the window picked last, drawn alone as it is not on
  // screen, by the window's index.
  const [part, setPart] = useState<
    { index: number; area: ShotRect } | undefined
  >(undefined);
  const { dialog, picker, setPicking } = usePicking(presence);
  const screens: Offered[] = body.sources.flatMap((source) =>
    source.kind === CastSourceKind.Monitor
      ? [
          {
            ...screenChoice(
              source.name,
              source.description,
              body.desk?.monitors.find(({ name }) => name === source.name)
                ?.area,
            ),
            source,
          },
        ]
      : [],
  );
  const windows: Offered[] = [
    ...body.sources.flatMap((source) =>
      source.kind === CastSourceKind.Window
        ? [
            {
              ...windowChoice(
                source.id,
                source.title,
                source.appId === "" ? undefined : apps(source.appId),
                shownArea(body.desk, shown, ShownWindowKind.App, source.id),
              ),
              source,
            },
          ]
        : [],
    ),
    ...(body.browserWindows
      ? browserWindows.map(({ appId, id, title }) => ({
          ...browserChoice(
            id,
            title,
            pageIcon(id),
            shownArea(body.desk, shown, ShownWindowKind.Browser, id),
            appId === "" ? undefined : apps(appId),
          ),
          source: Source.BrowserWindow({ id, title }),
        }))
      : []),
  ];
  const offered = [...whole, ...screens, ...windows];
  return (
    <>
      {picker !== undefined && (
        <RegionPicker
          actions={[
            {
              label: action(castTo, record),
              pick: (region) => {
                answer(Answer.ScreenCast([Source.Region(region)]));
              },
            },
          ]}
          back={() => {
            setPicking(false);
          }}
          cancel={() => {
            answer(Answer.Canceled());
          }}
          {...picker}
        />
      )}
      <ModalDialog
        closeButton={false}
        footer={
          <>
            {body.region ? (
              <Button
                onClick={() => {
                  setPicking(true);
                }}
                variant="ghost"
              >
                Select on screen
              </Button>
            ) : undefined}
            <Button
              onClick={() => {
                answer(Answer.Canceled());
              }}
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              disabled={picked.length === 0 && dragged === undefined}
              onClick={() => {
                answer(
                  Answer.ScreenCast(
                    desk !== undefined && dragged !== undefined
                      ? [Source.Region(onDesk(desk, dragged))]
                      : offered.flatMap(({ source }, index) =>
                          picked.includes(index)
                            ? [
                                part?.index === index
                                  ? partOf(source, part.area)
                                  : source,
                              ]
                            : [],
                        ),
                  ),
                );
              }}
            >
              {action(castTo, record)}
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
        title={
          heading(castTo, record) ??
          title(body.multiple, windows.length > 0, screens.length > 0)
        }
      >
        {castTo === undefined && !record && (
          <p className={askerStyles}>{`${asker} wants to record`}</p>
        )}
        <SourcePicker
          caption={caption(offered, picked, dragged, part, body.region, record)}
          desk={desk}
          dragged={dragged}
          draggedPart={part?.area}
          label={record ? "What to record" : "What to share"}
          multiple={body.multiple}
          onDrag={
            body.region
              ? (area) => {
                  setDragged(area);
                  setPicked([]);
                  setPart(undefined);
                }
              : undefined
          }
          onDragPart={(area) => {
            const index = picked.at(-1);
            if (index !== undefined) {
              setPart({ area, index });
            }
          }}
          onPick={(indices) => {
            setPicked(indices);
            setDragged(undefined);
            setPart(undefined);
          }}
          picked={picked}
          previewWindow={previewWindow}
          sections={[
            { choices: whole, label: undefined },
            { choices: screens, label: "Screens" },
            { choices: windows, label: "Windows" },
          ]}
        />
      </ModalDialog>
    </>
  );
};

const askerStyles = css({ color: "muted", fontSize: "sm", margin: 0 });

/** The confirm button's label: a cast to a TV, a recording or a share. */
const action = (castTo: string | undefined, record: boolean): string => {
  if (castTo !== undefined) {
    return "Cast";
  }
  return record ? "Record" : "Share";
};

/** The title of a cast to a TV or a recording; others are titled by asker. */
const heading = (
  castTo: string | undefined,
  record: boolean,
): string | undefined => {
  if (castTo !== undefined) {
    return `Cast to ${castTo}`;
  }
  return record ? "Record your screen" : undefined;
};

/** The dialog's title for what it offers. */
const title = (
  multiple: boolean,
  windows: boolean,
  monitors: boolean,
): string => {
  if (windows && monitors) {
    return "Share your screen";
  } else if (monitors) {
    return multiple ? "Share screens" : "Share a screen";
  } else {
    return multiple ? "Share windows" : "Share a window";
  }
};

/** `source`, or `area` of it when it is a window. */
const partOf = (source: CastSource, area: ShotRect): CastSource => {
  switch (source.kind) {
    case CastSourceKind.Window:
    case CastSourceKind.BrowserWindow:
      return { ...source, area };
    case CastSourceKind.Monitor:
    case CastSourceKind.Region:
      return source;
  }
};

/**
 * What the desk says of the sources `picked` from `offered`, of the area
 * `dragged` or of a window's `part`, and whether a `region` may be dragged.
 * Said of a recording when `record` is set.
 */
const caption = (
  offered: readonly Offered[],
  picked: readonly number[],
  dragged: ShotRect | undefined,
  part: { index: number; area: ShotRect } | undefined,
  region: boolean,
  record: boolean,
): string => {
  const [verb, done] = record ? ["record", "Recorded"] : ["share", "Shared"];
  if (dragged !== undefined) {
    return `${done} live, as it changes.`;
  } else if (picked.length === 0) {
    return region
      ? `Pick what to ${verb}, or drag over the desk for an area.`
      : `Pick what to ${verb}.`;
  } else if (part !== undefined) {
    return `A part of the window, ${done.toLowerCase()} as it draws itself.`;
  } else if (picked.some((index) => offered[index]?.area === undefined)) {
    return `Not on screen: ${done.toLowerCase()} as it draws itself. Drag over it to pick a part.`;
  } else {
    return `${done} live, as it changes.`;
  }
};
