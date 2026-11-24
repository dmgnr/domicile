import { AnimatedCheckIcon } from "@domicile-desktop/component-library/AnimatedCheckIcon";
import { AnimatedCloseIcon } from "@domicile-desktop/component-library/AnimatedCloseIcon";
import { AnimatedDownloadIcon } from "@domicile-desktop/component-library/AnimatedDownloadIcon";
import { Button } from "@domicile-desktop/component-library/Button";
import { IconButton } from "@domicile-desktop/component-library/IconButton";
import { List, ListRow } from "@domicile-desktop/component-library/ListRow";
import type { Row } from "@domicile-desktop/component-library/leaving-rows";
import { Panel, PanelAction } from "@domicile-desktop/component-library/Panel";
import { PanelNote } from "@domicile-desktop/component-library/PanelNote";
import { Popover } from "@domicile-desktop/component-library/Popover";
import { useLeavingRows } from "@domicile-desktop/component-library/useLeavingRows";
import type { Download } from "@domicile-desktop/sdk/desktop/downloads";
import { DownloadState } from "@domicile-desktop/sdk/desktop/downloads";
import { nothingOpens } from "@domicile-desktop/system-apps/opens";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/ssr/ArrowSquareOut";
import { BroomIcon } from "@phosphor-icons/react/dist/ssr/Broom";
import { FileIcon } from "@phosphor-icons/react/dist/ssr/File";
import { FileAudioIcon } from "@phosphor-icons/react/dist/ssr/FileAudio";
import { FileImageIcon } from "@phosphor-icons/react/dist/ssr/FileImage";
import { FilePdfIcon } from "@phosphor-icons/react/dist/ssr/FilePdf";
import { FileVideoIcon } from "@phosphor-icons/react/dist/ssr/FileVideo";
import { FileZipIcon } from "@phosphor-icons/react/dist/ssr/FileZip";
import { FolderOpenIcon } from "@phosphor-icons/react/dist/ssr/FolderOpen";
import { WarningCircleIcon } from "@phosphor-icons/react/dist/ssr/WarningCircle";
import type { CSSProperties } from "react";
import { useMemo, useState } from "react";

import { css } from "../styled-system/css";
import { downloadProgress, timeLeft } from "./download-progress";
import { FileKind, fileKind } from "./file-kind";
import { ItemPhase, useFinish } from "./useFinish";
import { useSecondsLeft } from "./useSecondsLeft";

/** What opening a file came to. */
export enum OpenResult {
  Opened,
  /** No installed app opens files of its kind, so nothing ran. */
  NoApp,
}

type Props = {
  /**
   * The desk's downloads, oldest first. `undefined` until the engine lists
   * them.
   */
  downloads: readonly Download[] | undefined;
  /** Stops the download `id`. */
  onCancel: (id: string) => void;
  /** Forgets every download not in progress. */
  onClear: () => void;
  /** Opens the file at `path`, unless no app opens it. */
  onOpen: (path: string) => Promise<OpenResult>;
  /** Forgets the download `id`. */
  onRemove: (id: string) => void;
  /** Opens the folder the file at `path` is in. */
  onShowInFolder: (path: string) => void;
  /** Whether its panel opens by itself as a download starts. See `Bar`. */
  popsUp: boolean;
};

type Actions = Omit<Props, "downloads" | "popsUp">;

/**
 * The Downloads item on the bar, shown while the desk has downloads from any
 * window. It says how far the ones in progress have come, then, as the last
 * finishes, that it is done. Its panel lists every download, newest first,
 * with what to do with each.
 *
 * Its panel opens by itself as a download starts, as Chromium's download
 * bubble does, without taking the keyboard, and stays until dismissed. A row
 * removed while it shows slides out, as a cleared notification does.
 */
export const DownloadsItem = ({ downloads, popsUp, ...actions }: Props) => {
  const [open, setOpen] = useState(false);
  const [known, setKnown] = useState<ReadonlySet<string> | undefined>(
    undefined,
  );
  // Worked out while rendering, so the panel opens with the new row.
  if (downloads !== undefined) {
    const fresh = downloads.filter(({ id }) => known?.has(id) !== true);
    if (known === undefined || fresh.length > 0) {
      setKnown(new Set(downloads.map(({ id }) => id)));
      if (
        known !== undefined &&
        popsUp &&
        fresh.some(({ state }) => state === DownloadState.InProgress)
      ) {
        setOpen(true);
      }
    }
  }
  const newestFirst = useMemo(
    () => downloads?.toReversed() ?? NONE,
    [downloads],
  );
  const { onLeft, rows } = useLeavingRows(newestFirst, idOf, open);
  const phase = useFinish(downloads);
  if (rows.length === 0) {
    if (open) {
      setOpen(false);
    }
    return undefined;
  }
  const running = newestFirst.filter(
    ({ state }) => state === DownloadState.InProgress,
  );
  const percent = phase === ItemPhase.Full ? 100 : percentOf(running);
  const label = labelOf(phase, running.length, percent);
  return (
    <Popover
      // Its end stays put as the item grows and shrinks, being on the bar's
      // right; its center does not.
      align="end"
      onOpenChange={setOpen}
      open={open}
      quiet
      side="bottom"
      tone="overPhoto"
      tooltip={label}
      trigger={
        <button
          aria-label={label}
          className={triggerStyles}
          data-size-unknown={
            phase === ItemPhase.Running && percent === undefined
              ? ""
              : undefined
          }
          type="button"
        >
          <span aria-hidden className={stackStyles}>
            <span
              className={iconStyles}
              data-shown={phase === ItemPhase.Done ? undefined : ""}
            >
              <AnimatedDownloadIcon cue={downloads?.length} size={15} />
            </span>
            <span
              className={checkStyles}
              data-shown={phase === ItemPhase.Done ? "" : undefined}
            >
              {phase === ItemPhase.Done && <AnimatedCheckIcon size={15} />}
            </span>
          </span>
          <Status percent={percent} phase={phase} />
        </button>
      }
      wide
    >
      <DownloadsPanel
        downloads={downloads ?? NONE}
        onLeft={onLeft}
        rows={rows}
        {...actions}
      />
    </Popover>
  );
};

const NONE: readonly Download[] = [];

const idOf = ({ id }: Download): string => id;

/**
 * The words beside the icon: the percent, then "Done". It opens and closes
 * its width rather than jumping, and keeps the last percent while it closes,
 * so nothing blinks.
 */
const Status = ({
  percent,
  phase,
}: {
  percent: number | undefined;
  phase: ItemPhase;
}) => {
  const [shown, setShown] = useState(percent);
  if (percent !== undefined && percent !== shown) {
    setShown(percent);
  }
  const done = phase === ItemPhase.Done;
  const open =
    done ||
    ((phase === ItemPhase.Running || phase === ItemPhase.Full) &&
      percent !== undefined);
  return (
    <span
      aria-hidden
      className={statusStyles}
      data-open={open ? "" : undefined}
    >
      <span className={statusTextStyles}>
        <span className={wordStyles} data-shown={done ? undefined : ""}>
          {shown === undefined ? undefined : `${shown}%`}
        </span>
        <span className={doneStyles} data-shown={done ? "" : undefined}>
          Done
        </span>
      </span>
    </span>
  );
};

/** Every download, newest first, removed ones sliding out. */
const DownloadsPanel = ({
  downloads,
  onCancel,
  onClear,
  onLeft,
  onOpen,
  onRemove,
  onShowInFolder,
  rows,
}: Actions & {
  downloads: readonly Download[];
  onLeft: (id: string) => void;
  rows: readonly Row<Download>[];
}) => {
  const secondsLeft = useSecondsLeft(downloads);
  // The downloads whose file no app opens, since the user tried.
  const [unopenable, setUnopenable] = useState<ReadonlySet<string>>(new Set());
  const open = (download: Download) => {
    setUnopenable((was) => without(was, download.id));
    onOpen(download.path).then(
      (result) => {
        if (result === OpenResult.NoApp) {
          setUnopenable((was) => new Set([...was, download.id]));
        }
      },
      (error: unknown) => {
        // biome-ignore lint/suspicious/noConsole: surfacing a background failure
        console.error(`Failed to open ${download.path}`, error);
      },
    );
  };
  return (
    <Panel title="Downloads" width="standard">
      {downloads.some(({ state }) => state !== DownloadState.InProgress) && (
        <PanelAction>
          <Button
            beforeIcon={<BroomIcon aria-hidden size={14} />}
            onClick={onClear}
            rounded
            size="xs"
            variant="ghost"
          >
            Clear all
          </Button>
        </PanelAction>
      )}
      <List>
        {rows.map(({ arriving, item: download, leaving }) => {
          const name = fileName(download.path);
          return (
            <ListRow
              detail={detailOf(download, secondsLeft.get(download.id))}
              end={
                download.state === DownloadState.InProgress ? (
                  <Button
                    onClick={() => {
                      onCancel(download.id);
                    }}
                    size="xs"
                  >
                    Cancel
                  </Button>
                ) : (
                  <>
                    {download.state === DownloadState.Complete && (
                      <>
                        <IconButton
                          label="Open"
                          onClick={() => {
                            open(download);
                          }}
                        >
                          <ArrowSquareOutIcon aria-hidden size={14} />
                        </IconButton>
                        <IconButton
                          label="Show in folder"
                          onClick={() => {
                            onShowInFolder(download.path);
                          }}
                        >
                          <FolderOpenIcon aria-hidden size={14} />
                        </IconButton>
                      </>
                    )}
                    <IconButton
                      label="Remove from list"
                      onClick={() => {
                        onRemove(download.id);
                      }}
                    >
                      <AnimatedCloseIcon size={14} />
                    </IconButton>
                  </>
                )
              }
              endOnHover={download.state !== DownloadState.InProgress}
              icon={
                download.state === DownloadState.Failed ? (
                  <WarningCircleIcon size={16} />
                ) : (
                  <FileKindIcon kind={fileKind(download.path)} />
                )
              }
              key={download.id}
              label={name}
              motion={{
                arriving,
                leaving,
                onLeft: () => {
                  onLeft(download.id);
                },
              }}
              surface="filled"
            >
              {download.state === DownloadState.InProgress && (
                <ProgressBar download={download} name={name} />
              )}
              {unopenable.has(download.id) && (
                <PanelNote tone="warning">{nothingOpens(name)}</PanelNote>
              )}
            </ListRow>
          );
        })}
      </List>
    </Panel>
  );
};

/** `set` without `key`. */
const without = <T,>(set: ReadonlySet<T>, key: T): ReadonlySet<T> =>
  set.has(key) ? new Set([...set].filter((kept) => kept !== key)) : set;

/** How far `download` has come, pulsing while its size is unknown. */
const ProgressBar = ({
  download,
  name,
}: {
  download: Download;
  name: string;
}) => {
  const fraction =
    download.totalBytes === 0
      ? undefined
      : download.receivedBytes / download.totalBytes;
  return (
    <div
      aria-label={name}
      aria-valuenow={
        fraction === undefined ? undefined : Math.floor(fraction * 100)
      }
      className={barStyles}
      data-size-unknown={fraction === undefined ? "" : undefined}
      role="progressbar"
      style={filledTo(fraction ?? 1)}
    />
  );
};

/** The percent the downloads in progress have come, if every size is known. */
const percentOf = (running: readonly Download[]): number | undefined => {
  if (
    running.length === 0 ||
    running.some(({ totalBytes }) => totalBytes === 0)
  ) {
    return undefined;
  }
  const received = running.reduce(
    (sum, { receivedBytes }) => sum + receivedBytes,
    0,
  );
  const total = running.reduce((sum, { totalBytes }) => sum + totalBytes, 0);
  return Math.floor((received / total) * 100);
};

/** The item's name and tooltip. */
const labelOf = (
  phase: ItemPhase,
  running: number,
  percent: number | undefined,
): string => {
  if (phase === ItemPhase.Full || phase === ItemPhase.Done) {
    return "Downloads finished";
  } else if (running === 0) {
    return "Downloads";
  }
  const files = `Downloading ${running} ${running === 1 ? "file" : "files"}`;
  return percent === undefined ? files : `${files}, ${percent}%`;
};

/** How `download` is going, and where it came from once it stopped. */
const detailOf = (
  download: Download,
  secondsLeft: number | undefined,
): string => {
  switch (download.state) {
    case DownloadState.InProgress: {
      const progress = downloadProgress(
        download.receivedBytes,
        download.totalBytes,
      );
      return secondsLeft === undefined
        ? progress
        : `${progress} · ${timeLeft(secondsLeft)}`;
    }
    case DownloadState.Complete: {
      return fromSite(download.page) ?? "Downloaded";
    }
    case DownloadState.Failed: {
      const from = fromSite(download.page);
      return from === undefined ? "Failed" : `Failed · ${from}`;
    }
  }
};

/** "From mail.google.com", for the page a download came from. */
const fromSite = (page: string): string | undefined => {
  const host = URL.parse(page)?.hostname.replace(/^www\./, "") ?? "";
  return host === "" ? undefined : `From ${host}`;
};

const fileName = (path: string): string =>
  path.slice(path.lastIndexOf("/") + 1);

/** The icon for a file of `kind`. */
const FileKindIcon = ({ kind }: { kind: FileKind }) => {
  switch (kind) {
    case FileKind.Archive: {
      return <FileZipIcon size={16} />;
    }
    case FileKind.Audio: {
      return <FileAudioIcon size={16} />;
    }
    case FileKind.Image: {
      return <FileImageIcon size={16} />;
    }
    case FileKind.Other: {
      return <FileIcon size={16} />;
    }
    case FileKind.Pdf: {
      return <FilePdfIcon size={16} />;
    }
    case FileKind.Video: {
      return <FileVideoIcon size={16} />;
    }
  }
};

/**
 * Inline style handing `fraction` to `barStyles` as `--download-progress`.
 * Inline because Panda only extracts build-time literals.
 */
const filledTo = (
  fraction: number,
): CSSProperties & Record<`--${string}`, string> => ({
  "--download-progress": String(fraction),
});

// Not the library's `Button`: its ghost variant uses `muted` text, which is
// unreadable over the wallpaper. Matches the Cast item, widening for the
// percent. Fixed-width digits so the bar does not shift as it climbs.
const triggerStyles = css({
  _hoverOrOpen: { backgroundColor: "fillOverPhoto" },
  "&[data-size-unknown] [data-shown] svg": {
    animation: "pulse {durations.pulse} {easings.in-out} infinite",
  },
  alignItems: "center",
  backgroundColor: "transparent",
  blockSize: 7,
  borderRadius: "lg",
  borderStyle: "none",
  color: "inherit",
  cursor: "pointer",
  display: "inline-flex",
  flexShrink: 0,
  fontSize: "xs",
  fontVariantNumeric: "tabular-nums",
  justifyContent: "center",
  minInlineSize: 7,
  paddingBlock: 0,
  paddingInline: 1.5,
  transition: "background-color {durations.fast} {easings.default}",
});

// The download arrow and the check, one over the other, so one gives way to
// the other in place.
const stackStyles = css({
  "& > *": { gridArea: "1 / 1" },
  display: "grid",
  placeItems: "center",
});

// The arrow sinks away as the check comes, and drops back in after.
const iconStyles = css({
  "&:not([data-shown])": {
    opacity: 0,
    transform: "translateY({spacing.1})",
  },
  display: "inline-flex",
  opacity: 1,
  transform: "translateY(0)",
  transition:
    "opacity {durations.normal} {easings.default}, transform {durations.normal} {easings.out}",
});

const checkStyles = css({
  "&:not([data-shown])": { opacity: 0 },
  color: "success",
  display: "inline-flex",
  opacity: 1,
  transition: "opacity {durations.normal} {easings.default}",
});

// Opens to the words' width and closes to nothing: a one-column grid whose
// column grows, since a width of `auto` cannot be animated.
const statusStyles = css({
  "&[data-open]": { gridTemplateColumns: "1fr" },
  display: "grid",
  gridTemplateColumns: "0fr",
  // main-thread animation: opens to its words' width once per download, moving
  // the bar items beside it.
  transition: "grid-template-columns {durations.normal} {easings.in-out}",
});

// The percent and "Done", one over the other, so they cross-fade.
const statusTextStyles = css({
  "& > *": { gridArea: "1 / 1" },
  display: "grid",
  minInlineSize: 0,
  overflow: "hidden",
  whiteSpace: "nowrap",
});

// The gap from the icon is on the words, which the closed column clips away.
// On the column itself it would hold the column open.
const wordStyles = css({
  "&:not([data-shown])": { opacity: 0 },
  opacity: 1,
  paddingInlineStart: 1,
  transition: "opacity {durations.normal} {easings.default}",
});

const doneStyles = css({
  "&:not([data-shown])": {
    opacity: 0,
    transform: "translateX(calc(-1 * {spacing.1}))",
  },
  color: "success",
  fontWeight: "semibold",
  opacity: 1,
  paddingInlineStart: 1,
  transform: "translateX(0)",
  transition:
    "opacity {durations.normal} {easings.default}, transform {durations.normal} {easings.out}",
});

// A thin track filled as far as the download has come. Grows from the left:
// `transform-origin` takes no logical keyword.
const barStyles = css({
  _before: {
    backgroundColor: "accent",
    content: '""',
    inset: 0,
    position: "absolute",
    transform: "scaleX(var(--download-progress))",
    transformOrigin: "left",
    transition: "transform {durations.normal} {easings.out}",
  },
  "&[data-size-unknown]::before": {
    animation: "pulse {durations.pulse} {easings.in-out} infinite",
  },
  backgroundColor: "border",
  blockSize: 1,
  borderRadius: "full",
  overflow: "hidden",
  position: "relative",
});
