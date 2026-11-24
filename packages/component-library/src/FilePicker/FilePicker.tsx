import type { SystemError } from "@domicile-desktop/sdk/system";
import { SystemErrorKind } from "@domicile-desktop/sdk/system";
import { ArrowBendLeftUpIcon } from "@phosphor-icons/react/dist/ssr/ArrowBendLeftUp";
import { CaretRightIcon } from "@phosphor-icons/react/dist/ssr/CaretRight";
import { CheckIcon } from "@phosphor-icons/react/dist/ssr/Check";
import { DesktopIcon } from "@phosphor-icons/react/dist/ssr/Desktop";
import { DownloadSimpleIcon } from "@phosphor-icons/react/dist/ssr/DownloadSimple";
import { EyeIcon } from "@phosphor-icons/react/dist/ssr/Eye";
import { EyeSlashIcon } from "@phosphor-icons/react/dist/ssr/EyeSlash";
import { FileIcon } from "@phosphor-icons/react/dist/ssr/File";
import { FileArrowUpIcon } from "@phosphor-icons/react/dist/ssr/FileArrowUp";
import { FileAudioIcon } from "@phosphor-icons/react/dist/ssr/FileAudio";
import { FileCodeIcon } from "@phosphor-icons/react/dist/ssr/FileCode";
import { FileDashedIcon } from "@phosphor-icons/react/dist/ssr/FileDashed";
import { FileImageIcon } from "@phosphor-icons/react/dist/ssr/FileImage";
import { FilePdfIcon } from "@phosphor-icons/react/dist/ssr/FilePdf";
import { FilesIcon } from "@phosphor-icons/react/dist/ssr/Files";
import { FileTextIcon } from "@phosphor-icons/react/dist/ssr/FileText";
import { FileVideoIcon } from "@phosphor-icons/react/dist/ssr/FileVideo";
import { FileZipIcon } from "@phosphor-icons/react/dist/ssr/FileZip";
import { FilmStripIcon } from "@phosphor-icons/react/dist/ssr/FilmStrip";
import { FloppyDiskIcon } from "@phosphor-icons/react/dist/ssr/FloppyDisk";
import { FolderIcon } from "@phosphor-icons/react/dist/ssr/Folder";
import { FolderOpenIcon } from "@phosphor-icons/react/dist/ssr/FolderOpen";
import { FolderPlusIcon } from "@phosphor-icons/react/dist/ssr/FolderPlus";
import { HardDrivesIcon } from "@phosphor-icons/react/dist/ssr/HardDrives";
import { HouseIcon } from "@phosphor-icons/react/dist/ssr/House";
import { ImageIcon } from "@phosphor-icons/react/dist/ssr/Image";
import { LockIcon } from "@phosphor-icons/react/dist/ssr/Lock";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/ssr/MagnifyingGlass";
import { MusicNotesIcon } from "@phosphor-icons/react/dist/ssr/MusicNotes";
import { UsersIcon } from "@phosphor-icons/react/dist/ssr/Users";
import { WarningIcon } from "@phosphor-icons/react/dist/ssr/Warning";
import type { FocusEvent, KeyboardEvent, ReactNode, Ref } from "react";
import { useId, useRef, useState } from "react";

import { css } from "../../styled-system/css";
import { flex, grid, hstack, vstack } from "../../styled-system/patterns";
import { focusOnAttach } from "../_control/focusOnAttach";
import { useStableRef } from "../_control/useStableRef";
import { Button } from "../Button/Button";
import { Input } from "../Input/Input";
import {
  highlightIn,
  keepInView,
  pageOf,
  stepOf,
  steppedTo,
} from "../list-walk";
import { Select } from "../Select/Select";
import { Clash, clashOf } from "./clash";
import { FileKind, fileKindOf, kindLabel } from "./file-kind";
import type { FileFilter, FileRequest } from "./file-request";
import { ChooserMode } from "./file-request";
import { pathIn } from "./path-in";
import type { Row } from "./rows";
import { RowKind, rowsIn } from "./rows";
import { stemEnd } from "./stem";
import { ListingState, useListing } from "./useListing";
import type { UserPlace } from "./user-folders";
import { UserFolder } from "./user-folders";
import { useUserFolders } from "./useUserFolders";
import { crumbsOf, parentOf, shownPath, walked } from "./walk-path";
import "../stylesheet";

/** The filter box's accessible name. */
const PROMPT = "Filter or go to a path";

/** The icon size for buttons and the filter box. */
const ICON_SIZE = 16;

/**
 * The icon size for list rows: larger than {@link ICON_SIZE} since the glyph
 * has no tile frame, but fits the same tile so rows match the launcher's.
 */
const ROW_ICON_SIZE = 20;

/** The icon size for empty-state placeholders. */
const PLACEHOLDER_ICON_SIZE = 40;

/** Each user folder's sidebar icon. */
const USER_FOLDER_GLYPHS: Record<UserFolder, typeof FolderIcon> = {
  [UserFolder.Desktop]: DesktopIcon,
  [UserFolder.Documents]: FileTextIcon,
  [UserFolder.Downloads]: DownloadSimpleIcon,
  [UserFolder.Music]: MusicNotesIcon,
  [UserFolder.Pictures]: ImageIcon,
  [UserFolder.Public]: UsersIcon,
  [UserFolder.Templates]: FileDashedIcon,
  [UserFolder.Videos]: FilmStripIcon,
};

type Props = {
  /**
   * The box that has the keyboard: the filter, or the name when saving. The
   * caller focuses it while the picker is open.
   */
  ref?: Ref<HTMLInputElement> | undefined;
  /** What to pick and how to answer. */
  request: FileRequest;
};

/** A sidebar entry. */
type Place = { glyph: typeof FolderIcon; label: string; path: string };

/** A folder being named, and why the last try to make it failed. */
type NewFolder = { failure: string | undefined; name: string };

/**
 * A file picker drawn over its positioned parent only, so the rest of the
 * screen stays usable.
 *
 * Starts in `currentFolder`, or the home, and lists one directory at a time,
 * again whenever it changes; nothing is indexed. One box has the keyboard:
 * the filter, or the file name when saving. A `/` in the filter walks the
 * path like a shell (see `walked`).
 * Opening, a click or arrow key selects a file; Enter, a double click or the
 * button chooses it. Saving, the arrows pick a folder to enter and Enter
 * saves, asking first before replacing a file. Clicking a directory enters
 * it.
 *
 * Keys: arrows move, Enter opens, Backspace in an empty box goes up,
 * Ctrl+Enter confirms, Ctrl+H shows hidden files, Escape cancels, and Tab marks a file in multi-select, as in fzf.
 */
export const FilePicker = ({ ref, request }: Props) => {
  const titleId = useId();
  const listId = useId();
  const results = useRef<HTMLDivElement>(null);
  const replaceTitleId = useId();
  const replaceNoteId = useId();
  const failureId = useId();
  const [box, setBox] = useStableRef(ref);
  const [directory, setDirectory] = useState(
    request.currentFolder ?? request.home,
  );
  const [query, setQuery] = useState("");
  // The highlighted row, or `undefined` for the default: the first row below
  // `..`, or none when saving, so Enter saves.
  const [stepped, setStepped] = useState<number | undefined>(undefined);
  // Marked file paths for multi-select, in marking order.
  const [marks, setMarks] = useState<readonly string[]>([]);
  const [name, setName] = useState(request.suggestedName);
  // Whether the user is asked to confirm replacing a file.
  const [replacing, setReplacing] = useState(false);
  // Whether dotfiles show without a dot typed.
  const [hidden, setHidden] = useState(false);
  const [newFolder, setNewFolder] = useState<NewFolder | undefined>(undefined);
  const [filter, setFilter] = useState<FileFilter | undefined>(
    request.filters?.[request.currentFilter ?? 0],
  );
  const filterIndex =
    filter === undefined ? undefined : request.filters?.indexOf(filter);
  const choose = (paths: readonly string[]) => {
    request.choose(paths, filterIndex);
  };

  const saving = request.mode === ChooserMode.Save;
  const listing = useListing(request.folders, directory);
  const entries = listing.state === ListingState.Listed ? listing.entries : [];
  const userFolders = useUserFolders(request.folders, request.home);
  const clash = saving ? clashOf(entries, name) : Clash.None;
  const rows = rowsIn({
    accept: filter === undefined ? request.accept : filter.extensions,
    directory,
    entries,
    filter: query,
    hidden,
    mode: request.mode,
  });
  const highlighted =
    saving && stepped === undefined
      ? undefined
      : highlightIn(rows.length, stepped ?? firstOf(rows));
  const current = highlighted === undefined ? undefined : rows[highlighted];
  const multiple = request.mode === ChooserMode.OpenMultiple;
  const answer = answerOf({
    clash,
    current,
    directory,
    marks,
    mode: request.mode,
    name,
  });
  const asking = replacing && clash === Clash.File;

  const go = (to: string) => {
    setDirectory(to);
    setQuery("");
    setStepped(undefined);
  };

  // Chooses the answer, asking first if it replaces a file.
  const confirm = () => {
    if (answer !== undefined) {
      if (clash === Clash.File) {
        setReplacing(true);
      } else {
        choose(answer);
      }
    }
  };

  // Back from the replace question to the name.
  const reconsider = () => {
    setReplacing(false);
    box.current?.focus();
  };

  const closeNewFolder = () => {
    setNewFolder(undefined);
    box.current?.focus();
  };

  // Makes the folder named here and enters it, or says why it could not.
  const make = (named: string) => {
    const path = pathIn(directory, named);
    request.folders
      .create(path)
      .then((made) => {
        made.match({
          Err: (error) => {
            setNewFolder({ failure: failureOf(error), name: named });
          },
          Ok: () => {
            go(path);
            closeNewFolder();
          },
        });
      })
      .catch((error: unknown) => {
        // biome-ignore lint/suspicious/noConsole: reports an unexpected failure to make a folder
        console.error("The file picker could not make a folder", error);
      });
  };

  // Enter or double click: enters a directory, or chooses a file (or names
  // it, when saving).
  const open = (row: Row) => {
    switch (row.kind) {
      case RowKind.Parent:
      case RowKind.Directory: {
        go(row.path);
        break;
      }
      case RowKind.File: {
        openFile(row);
        break;
      }
    }
  };

  const openFile = (row: Row) => {
    switch (request.mode) {
      case ChooserMode.Open:
      case ChooserMode.OpenFolder: {
        choose([row.path]);
        break;
      }
      case ChooserMode.OpenMultiple: {
        choose(marks.length > 0 ? marks : [row.path]);
        break;
      }
      case ChooserMode.Save: {
        setName(row.name);
        setStepped(undefined);
        break;
      }
    }
  };

  // A single click: enters a directory, or selects a file and marks or names
  // it as the mode requires.
  const pick = (row: Row, at: number) => {
    if (row.kind === RowKind.File) {
      if (multiple) {
        setStepped(at);
        setMarks(toggled(marks, row.path));
      } else if (saving) {
        openFile(row);
      } else {
        setStepped(at);
      }
    } else {
      go(row.path);
    }
  };

  return (
    <dialog
      aria-labelledby={titleId}
      className={scrimStyles}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          if (asking) {
            reconsider();
          } else if (newFolder === undefined) {
            request.cancel();
          } else {
            closeNewFolder();
          }
        }
      }}
      open
    >
      <div className={panelStyles}>
        <header className={headerStyles}>
          <span className={modeGlyphStyles}>
            <ModeGlyph mode={request.mode} />
          </span>
          <h2 className={titleStyles} id={titleId}>
            {request.title ?? titleOf(request.mode)}
          </h2>
        </header>
        <aside className={sidebarStyles}>
          <nav aria-label="Places" className={placesStyles}>
            {placesOf(request.home, userFolders).map(
              ({ glyph: Glyph, label, path }) => (
                <Button
                  aria-current={path === directory ? "location" : undefined}
                  beforeIcon={
                    <Glyph
                      size={ICON_SIZE}
                      weight={path === directory ? "fill" : "duotone"}
                    />
                  }
                  key={path}
                  onClick={() => {
                    go(path);
                  }}
                  // The keyboard stays in the box.
                  onMouseDown={(event) => {
                    event.preventDefault();
                  }}
                  variant="ghost"
                >
                  {label}
                </Button>
              ),
            )}
          </nav>
        </aside>
        <section className={mainStyles}>
          <div className={locationStyles}>
            <nav aria-label="Path" className={pathBarStyles}>
              {crumbsOf(directory, request.home).map((crumb, at, crumbs) => (
                <span className={crumbStyles} key={crumb.path}>
                  {at > 0 && (
                    <span aria-hidden className={crumbSeparatorStyles}>
                      <CaretRightIcon size={12} weight="bold" />
                    </span>
                  )}
                  <Button
                    aria-current={
                      at === crumbs.length - 1 ? "location" : undefined
                    }
                    beforeIcon={
                      at === 0 ? <CrumbGlyph label={crumb.label} /> : undefined
                    }
                    onClick={() => {
                      go(crumb.path);
                    }}
                    // The keyboard stays in the box.
                    onMouseDown={(event) => {
                      event.preventDefault();
                    }}
                    size="sm"
                    variant="ghost"
                  >
                    {crumb.label}
                  </Button>
                </span>
              ))}
            </nav>
            <div className={toolsStyles}>
              <Button
                aria-pressed={hidden}
                beforeIcon={
                  hidden ? (
                    <EyeIcon size={ICON_SIZE} />
                  ) : (
                    <EyeSlashIcon size={ICON_SIZE} />
                  )
                }
                onClick={() => {
                  setHidden(!hidden);
                }}
                // The keyboard stays in the box.
                onMouseDown={(event) => {
                  event.preventDefault();
                }}
                size="sm"
                variant="ghost"
              >
                Hidden files
              </Button>
              <Button
                beforeIcon={<FolderPlusIcon size={ICON_SIZE} />}
                onClick={() => {
                  setNewFolder({ failure: undefined, name: "" });
                }}
                onMouseDown={(event) => {
                  event.preventDefault();
                }}
                size="sm"
                variant="ghost"
              >
                New folder
              </Button>
            </div>
          </div>
          <Input
            aria-activedescendant={
              highlighted === undefined ? undefined : rowId(listId, highlighted)
            }
            aria-controls={listId}
            aria-expanded
            aria-label={saving ? "Name" : PROMPT}
            onChange={(event) => {
              if (saving) {
                setName(event.target.value);
              } else {
                const to = walked({
                  directory,
                  home: request.home,
                  typed: event.target.value,
                });
                setDirectory(to.directory);
                setQuery(to.filter);
              }
              setStepped(undefined);
            }}
            onFocus={saving ? selectStem : undefined}
            onKeyDown={(event) => {
              const step = stepOf(event, pageOf(results.current));
              const up = parentOf(directory);
              if (step !== undefined) {
                event.preventDefault();
                setStepped(steppedTo(highlighted ?? 0, step, rows.length));
              } else if (isChord(event, "h")) {
                event.preventDefault();
                setHidden(!hidden);
              } else if (
                event.key === "Enter" &&
                !event.ctrlKey &&
                !event.metaKey
              ) {
                event.preventDefault();
                if (current === undefined) {
                  confirm();
                } else {
                  open(current);
                }
              } else if (event.key === "Tab" && multiple) {
                // fzf's mark: this file, and on to the next.
                event.preventDefault();
                if (
                  current?.kind === RowKind.File &&
                  highlighted !== undefined
                ) {
                  setMarks(toggled(marks, current.path));
                  setStepped(steppedTo(highlighted, 1, rows.length));
                }
              } else if (
                event.key === "Backspace" &&
                event.currentTarget.value === "" &&
                up !== undefined
              ) {
                event.preventDefault();
                go(up);
              } else if (isConfirmChord(event)) {
                event.preventDefault();
                confirm();
              }
            }}
            placeholder={saving ? "Name the file" : "Filter, or type a path"}
            prefixIcon={
              saving ? (
                <NameGlyph name={name} />
              ) : (
                <MagnifyingGlassIcon size={ICON_SIZE} />
              )
            }
            ref={setBox}
            role="combobox"
            size={saving ? "lg" : "md"}
            // File names are not prose.
            spellCheck={false}
            value={saving ? name : query}
          />
          {newFolder !== undefined && (
            <div className={newFolderStyles}>
              <Input
                aria-describedby={
                  newFolder.failure === undefined ? undefined : failureId
                }
                aria-invalid={newFolder.failure !== undefined}
                aria-label="Folder name"
                onChange={(event) => {
                  setNewFolder({
                    failure: undefined,
                    name: event.target.value,
                  });
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    if (event.currentTarget.value !== "") {
                      make(event.currentTarget.value);
                    }
                  }
                }}
                placeholder="Name the new folder"
                prefixIcon={<FolderPlusIcon size={ICON_SIZE} />}
                ref={focusOnAttach}
                spellCheck={false}
                value={newFolder.name}
              />
              {newFolder.failure !== undefined && (
                <span className={failureStyles} id={failureId}>
                  {newFolder.failure}
                </span>
              )}
            </div>
          )}
          <div className={resultsStyles} ref={results}>
            <div aria-hidden className={columnsStyles}>
              <span>Name</span>
              <span>Kind</span>
            </div>
            <div
              aria-label={`Contents of ${shownPath(directory, request.home)}`}
              aria-multiselectable={multiple}
              className={listStyles}
              id={listId}
              role="listbox"
            >
              {rows.map((row, at) => {
                const marked = marks.includes(row.path);
                return (
                  // biome-ignore lint/a11y/useKeyWithClickEvents: the combobox handles the keyboard via `aria-activedescendant`
                  <div
                    // Excludes the kind column.
                    aria-label={row.name}
                    // In multi-select, the marks are the selection; the
                    // highlight is only the cursor.
                    aria-selected={multiple ? marked : at === highlighted}
                    className={rowStyles}
                    data-highlighted={at === highlighted ? "" : undefined}
                    data-marked={marked ? "" : undefined}
                    data-replaced={
                      clash === Clash.File &&
                      row.kind === RowKind.File &&
                      row.name === name
                        ? ""
                        : undefined
                    }
                    data-tone={toneOf(row)}
                    id={rowId(listId, at)}
                    key={`${toneOf(row)}:${row.path}`}
                    onClick={() => {
                      pick(row, at);
                    }}
                    onDoubleClick={() => {
                      if (row.kind === RowKind.File) {
                        openFile(row);
                      }
                    }}
                    // Keeps focus in the box.
                    onMouseDown={(event) => {
                      event.preventDefault();
                    }}
                    ref={at === highlighted ? keepInView : undefined}
                    role="option"
                    tabIndex={-1}
                  >
                    <span className={rowTileStyles} data-row-tile="">
                      <RowGlyph
                        highlighted={at === highlighted}
                        marked={marked}
                        row={row}
                      />
                    </span>
                    <span className={rowNameStyles}>{row.name}</span>
                    <span className={rowKindStyles}>{describe(row)}</span>
                  </div>
                );
              })}
            </div>
            <Emptiness
              listing={listing.state}
              query={query}
              shown={rows.some(({ kind }) => kind !== RowKind.Parent)}
            />
          </div>
        </section>
        {asking && answer !== undefined ? (
          <footer
            aria-describedby={replaceNoteId}
            aria-labelledby={replaceTitleId}
            className={replaceStyles}
            role="alertdialog"
          >
            <span className={replaceGlyphStyles}>
              <WarningIcon size={20} weight="fill" />
            </span>
            <div className={replaceTextStyles}>
              <strong className={replaceTitleStyles} id={replaceTitleId}>
                {`Replace “${name}”?`}
              </strong>
              <span className={replaceNoteStyles} id={replaceNoteId}>
                {`It is already in ${shownPath(directory, request.home)}. Its contents will be lost.`}
              </span>
            </div>
            <div className={actionsStyles}>
              <Button onClick={reconsider} variant="ghost">
                Go back
              </Button>
              <Button
                onClick={() => {
                  choose(answer);
                }}
                ref={focusOnAttach}
                variant="danger"
              >
                Replace
              </Button>
            </div>
          </footer>
        ) : (
          <footer className={footerStyles}>
            {saving ? (
              <NameHint clash={clash} name={name} />
            ) : (
              <output
                aria-label="Selection"
                className={selectionStyles}
                data-empty={answer === undefined ? "" : undefined}
              >
                <Selection
                  answer={answer}
                  home={request.home}
                  marks={marks}
                  mode={request.mode}
                />
              </output>
            )}
            <div className={actionsStyles}>
              {request.controls}
              {request.filters !== undefined && filter !== undefined && (
                <Select
                  aria-label="File type"
                  onValueChange={(picked) => {
                    if (picked !== null) {
                      setFilter(picked);
                    }
                  }}
                  options={request.filters.map((group) => ({
                    label: group.name,
                    value: group,
                  }))}
                  value={filter}
                />
              )}
              <Button onClick={request.cancel} variant="ghost">
                Cancel
              </Button>
              <Button
                disabled={answer === undefined}
                onClick={confirm}
                variant="accent"
              >
                {request.acceptLabel ?? confirmOf(request.mode)}
              </Button>
            </div>
          </footer>
        )}
      </div>
    </dialog>
  );
};

// Covers the parent so it cannot be clicked while it waits for an answer. Uses
// the library's glass scrim (see `ModalDialog`) and resets the native
// `dialog` box.
const scrimStyles = css({
  _starting: { opacity: 0 },
  backdropFilter: "blur({spacing.2.5}) saturate(140%)",
  backgroundColor: "color-mix(in oklab, {colors.backdrop} 55%, transparent)",
  blockSize: "auto",
  border: "none",
  color: "foreground",
  display: "grid",
  inlineSize: "auto",
  inset: 0,
  margin: 0,
  maxBlockSize: "none",
  maxInlineSize: "none",
  opacity: 1,
  padding: 4,
  placeItems: "center",
  position: "absolute",
  transition: "opacity {durations.normal} {easings.out}",
});

// The library's glass surface (see `ModalDialog`). A header and footer across
// two columns, places and folder.
const panelStyles = grid({
  _before: {
    background:
      "linear-gradient(90deg, transparent, color-mix(in oklab, {colors.foreground} 40%, transparent), transparent)",
    blockSize: "1px",
    content: '""',
    insetBlockStart: 0,
    insetInline: 0,
    position: "absolute",
    zIndex: 1,
  },
  _starting: {
    opacity: 0,
    transform: "translateY({spacing.3}) scale(0.96)",
  },
  // Fields sit on the panel as a soft fill, edged only under the pointer or
  // focus.
  "& :has(> [data-control])": {
    backgroundColor: "fill",
    borderRadius: "lg",
  },
  "& :has(> [data-control]):not(:hover, :focus-within)": {
    borderColor: "transparent",
  },
  backdropFilter: "blur({spacing.5}) saturate(180%)",
  // More opaque than `ModalDialog`'s glass, for readable rows over anything.
  backgroundColor: "color-mix(in oklab, {colors.card} 86%, transparent)",
  blockSize: "min(86vh, {spacing.168})",
  border: "1px solid color-mix(in oklab, {colors.foreground} 16%, transparent)",
  borderRadius: "xl",
  boxShadow: "modal",
  gap: 0,
  gridTemplateColumns: "{spacing.52} minmax(0, 1fr)",
  gridTemplateRows: "auto minmax(0, 1fr) auto",
  inlineSize: "100%",
  maxInlineSize: 240,
  overflow: "hidden",
  position: "relative",
  transition:
    "opacity {durations.normal} {easings.out}, transform {durations.normal} {easings.out}",
});

const headerStyles = hstack({
  borderBlockEnd: "1px solid {colors.border}",
  gap: 2.5,
  gridColumn: "1 / -1",
  paddingBlock: 3.5,
  paddingInline: 5,
});

const modeGlyphStyles = css({
  color: "accent",
  display: "inline-flex",
});

const titleStyles = css({
  fontSize: "md",
  fontWeight: "semibold",
  lineHeight: "tight",
  margin: 0,
});

const sidebarStyles = flex({
  backgroundColor: "color-mix(in oklab, {colors.foreground} 3%, transparent)",
  borderInlineEnd: "1px solid {colors.border}",
  direction: "column",
  gap: 6,
  minBlockSize: 0,
  overflowY: "auto",
  padding: 3,
});

const placesStyles = flex({
  "& > button": {
    fontSize: "sm",
    gap: 2.5,
    inlineSize: "100%",
    justifyContent: "flex-start",
  },
  "& > button[aria-current=location]": {
    backgroundColor:
      "color-mix(in oklab, {colors.foreground} 10%, transparent)",
    color: "foreground",
    fontWeight: "semibold",
  },
  direction: "column",
  gap: 0.5,
});

const mainStyles = flex({
  direction: "column",
  gap: 3,
  minBlockSize: 0,
  minInlineSize: 0,
  padding: 4,
});

const pathBarStyles = flex({
  "& [aria-current=location]": { color: "foreground", fontWeight: "semibold" },
  alignItems: "center",
  color: "muted",
  flexWrap: "wrap",
  marginInlineStart: -2,
  rowGap: 0.5,
});

// The path bar, then the folder's tools.
const locationStyles = hstack({
  gap: 2,
  justifyContent: "space-between",
  minInlineSize: 0,
});

const toolsStyles = hstack({
  flexShrink: 0,
  gap: 0.5,
});

const newFolderStyles = flex({
  direction: "column",
  gap: 1,
});

const failureStyles = css({
  color: "danger",
  fontSize: "sm",
});

const crumbStyles = hstack({
  gap: 0,
});

const crumbSeparatorStyles = css({
  color: "textTertiary",
  display: "inline-flex",
  marginInline: 0.5,
});

const resultsStyles = css({
  // White in light mode, as a document is.
  backgroundColor: {
    _light: "color-mix(in oklab, {colors.white} 80%, transparent)",
    base: "color-mix(in oklab, {colors.background} 30%, transparent)",
  },
  border: "1px solid {colors.border}",
  borderRadius: "lg",
  flex: "1 1 auto",
  minBlockSize: 40,
  overflowY: "auto",
  paddingBlockEnd: 1.5,
  paddingInline: 1.5,
  position: "relative",
  scrollbarColor: "{colors.border} transparent",
  scrollbarWidth: "thin",
  scrollPaddingBlockStart: 9,
});

const columnsStyles = grid({
  backdropFilter: "blur({spacing.3})",
  backgroundColor: "color-mix(in oklab, {colors.card} 70%, transparent)",
  color: "textTertiary",
  columnGap: 3,
  // 11px, which has no scale token.
  fontSize: "0.6875rem",
  fontWeight: "semibold",
  gridTemplateColumns: "minmax(0, 1fr) {spacing.32}",
  insetBlockStart: 0,
  letterSpacing: "widest",
  marginBlockEnd: 1,
  marginInline: -1.5,
  paddingBlock: 2,
  // Matches the rows' insets so headers align with their columns.
  paddingInlineEnd: 3.5,
  paddingInlineStart: 13.5,
  position: "sticky",
  textTransform: "uppercase",
  zIndex: 1,
});

const listStyles = flex({
  direction: "column",
  gap: 0.5,
});

const rowStyles = grid({
  _hoverEnabled: {
    backgroundColor: "color-mix(in oklab, {colors.foreground} 5%, transparent)",
  },
  "--tone": "{colors.muted}",
  // A plain glyph, teal for a folder and gray for anything else, so folders
  // stand out without a tile behind every row.
  "& [data-row-tile]": { color: "var(--tone)" },
  // A neutral wash: color is kept for focus and the main action.
  "&[data-highlighted]": {
    backgroundColor:
      "color-mix(in oklab, {colors.foreground} 10%, transparent)",
  },
  "&[data-marked] [data-row-tile]": {
    backgroundColor: "accent",
    borderColor: "accent",
    color: "background",
  },
  // The file a save would replace.
  "&[data-replaced]": {
    backgroundColor: "color-mix(in oklab, {colors.warning} 14%, transparent)",
  },
  "&[data-tone=folder]": { "--tone": "{colors.accent}" },
  "&[data-tone=parent]": { color: "muted" },
  alignItems: "center",
  borderRadius: "md",
  color: "foreground",
  columnGap: 3,
  cursor: "pointer",
  gridTemplateColumns: "auto minmax(0, 1fr) {spacing.32}",
  paddingBlock: 1.5,
  paddingInline: 2,
  transition: "background-color {durations.fast} {easings.out}",
  userSelect: "none",
});

const rowTileStyles = css({
  blockSize: 7,
  border: "1px solid transparent",
  borderRadius: "sm",
  display: "grid",
  inlineSize: 7,
  placeItems: "center",
  transition:
    "background-color {durations.fast} {easings.out}, border-color {durations.fast} {easings.out}, color {durations.fast} {easings.out}",
});

const rowNameStyles = css({
  // As the launcher's rows.
  fontSize: "md",
  fontWeight: "medium",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
});

const rowKindStyles = css({
  color: "muted",
  fontSize: "sm",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
});

const placeholderStyles = vstack({
  color: "muted",
  gap: 1.5,
  inset: 0,
  justifyContent: "center",
  padding: 6,
  pointerEvents: "none",
  position: "absolute",
  textAlign: "center",
});

const placeholderGlyphStyles = css({
  backgroundColor: "color-mix(in oklab, {colors.foreground} 5%, transparent)",
  borderRadius: "full",
  color: "textTertiary",
  display: "inline-flex",
  marginBlockEnd: 2,
  padding: 4,
});

const placeholderTitleStyles = css({
  color: "foreground",
  fontSize: "md",
  fontWeight: "semibold",
});

const placeholderNoteStyles = css({
  fontSize: "sm",
});

// Both footers share a height, so the list keeps its size between them.
const footerStyles = hstack({
  borderBlockStart: "1px solid {colors.border}",
  gap: 4,
  gridColumn: "1 / -1",
  justifyContent: "space-between",
  minBlockSize: 16,
  paddingBlock: 3,
  paddingInline: 4,
});

// The footer while asking whether to replace a file.
const replaceStyles = hstack({
  backgroundColor: "color-mix(in oklab, {colors.warning} 12%, transparent)",
  borderBlockStart:
    "1px solid color-mix(in oklab, {colors.warning} 40%, transparent)",
  gap: 3,
  gridColumn: "1 / -1",
  minBlockSize: 16,
  paddingBlock: 3,
  paddingInline: 4,
});

const replaceGlyphStyles = css({
  color: "warning",
  display: "inline-flex",
  flexShrink: 0,
});

const replaceTextStyles = flex({
  direction: "column",
  flex: "1 1 auto",
  minInlineSize: 0,
});

const replaceTitleStyles = css({
  fontSize: "sm",
  fontWeight: "semibold",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
});

const replaceNoteStyles = css({
  color: "muted",
  fontSize: "xs",
});

const clashHintStyles = hstack({
  "&[data-clash=file]": { color: "warning" },
  color: "muted",
  fontSize: "sm",
  gap: 2,
});

// Drawn as a chip only when there is a selection.
const selectionStyles = hstack({
  "&[data-empty]": {
    backgroundColor: "transparent",
    borderColor: "transparent",
    paddingInline: 0,
  },
  backgroundColor: "color-mix(in oklab, {colors.accent} 12%, transparent)",
  border: "1px solid color-mix(in oklab, {colors.accent} 30%, transparent)",
  borderRadius: "full",
  flex: "0 1 auto",
  fontSize: "sm",
  gap: 2,
  minInlineSize: 0,
  paddingBlock: 1,
  paddingInline: 3,
  transition:
    "background-color {durations.fast} {easings.out}, border-color {durations.fast} {easings.out}",
});

const selectionGlyphStyles = css({
  color: "accent",
  display: "inline-flex",
  flexShrink: 0,
});

const selectionCountStyles = css({
  color: "accent",
  flexShrink: 0,
  fontWeight: "semibold",
});

const selectionPathStyles = css({
  display: "flex",
  minInlineSize: 0,
  overflow: "hidden",
  whiteSpace: "nowrap",
});

// Truncates before the file name does.
const selectionFolderStyles = css({
  color: "muted",
  flexShrink: 1,
  minInlineSize: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
});

const selectionNameStyles = css({
  flexShrink: 0,
  fontWeight: "semibold",
  maxInlineSize: "100%",
  overflow: "hidden",
  textOverflow: "ellipsis",
});

const selectionNoneStyles = css({
  color: "muted",
});

const actionsStyles = hstack({
  flexShrink: 0,
  gap: 2,
});

/** The sidebar icon for the request mode. */
const ModeGlyph = ({ mode }: { mode: ChooserMode }) => {
  switch (mode) {
    case ChooserMode.Open: {
      return <FileArrowUpIcon size={20} weight="fill" />;
    }
    case ChooserMode.OpenMultiple: {
      return <FilesIcon size={20} weight="fill" />;
    }
    case ChooserMode.OpenFolder: {
      return <FolderOpenIcon size={20} weight="fill" />;
    }
    case ChooserMode.Save: {
      return <FloppyDiskIcon size={20} weight="fill" />;
    }
  }
};

/** The icon for the path bar's first crumb: home or root. */
const CrumbGlyph = ({ label }: { label: string }) =>
  label === "~" ? (
    <HouseIcon size={14} weight="fill" />
  ) : (
    <HardDrivesIcon size={14} weight="fill" />
  );

/** The name box's icon: the kind of file the name makes. */
const NameGlyph = ({ name }: { name: string }) => {
  const Glyph = glyphOf(fileKindOf(name));
  return <Glyph size={ICON_SIZE} weight="duotone" />;
};

/** What is wrong with the name, if anything. Holds its place when empty. */
const NameHint = ({ clash, name }: { clash: Clash; name: string }) =>
  name.includes("/") ? (
    <span className={clashHintStyles} data-clash="file">
      <WarningIcon size={14} weight="fill" />A name can't have a /
    </span>
  ) : (
    <ClashHint clash={clash} />
  );

/** What saving under the name would hit. Holds its place when empty. */
const ClashHint = ({ clash }: { clash: Clash }) => {
  switch (clash) {
    case Clash.None: {
      return <span />;
    }
    case Clash.File: {
      return (
        <span className={clashHintStyles} data-clash="file">
          <WarningIcon size={14} weight="fill" />
          Replaces the file with this name
        </span>
      );
    }
    case Clash.Folder: {
      return (
        <span className={clashHintStyles} data-clash="folder">
          <FolderIcon size={14} weight="fill" />A folder has this name
        </span>
      );
    }
  }
};

/**
 * A row's icon: a check if marked, else its kind. Filled when highlighted,
 * since an outline icon loses contrast on the highlight, as in the launcher.
 */
const RowGlyph = ({
  highlighted,
  marked,
  row,
}: {
  highlighted: boolean;
  marked: boolean;
  row: Row;
}) => {
  if (marked) {
    return <CheckIcon size={ROW_ICON_SIZE} weight="bold" />;
  } else {
    switch (row.kind) {
      case RowKind.Parent: {
        return <ArrowBendLeftUpIcon size={ROW_ICON_SIZE} weight="bold" />;
      }
      case RowKind.Directory: {
        return highlighted ? (
          <FolderOpenIcon size={ROW_ICON_SIZE} weight="fill" />
        ) : (
          <FolderIcon size={ROW_ICON_SIZE} weight="fill" />
        );
      }
      case RowKind.File: {
        const Glyph = glyphOf(fileKindOf(row.name));
        return (
          <Glyph
            size={ROW_ICON_SIZE}
            weight={highlighted ? "fill" : "duotone"}
          />
        );
      }
    }
  }
};

/**
 * The empty-state message for an unreadable folder, an empty folder or a
 * filter with no matches. Shows nothing while loading, to avoid a flash.
 */
const Emptiness = ({
  listing,
  query,
  shown,
}: {
  listing: ListingState;
  query: string;
  shown: boolean;
}) => {
  switch (listing) {
    case ListingState.Loading: {
      return undefined;
    }
    case ListingState.Unreadable: {
      return (
        <Placeholder
          glyph={<LockIcon size={PLACEHOLDER_ICON_SIZE} weight="duotone" />}
          note="It isn't there, or it isn't yours to read."
          title="Can't open this folder"
        />
      );
    }
    case ListingState.Listed: {
      if (shown) {
        return undefined;
      } else {
        return query === "" ? (
          <Placeholder
            glyph={
              <FolderOpenIcon size={PLACEHOLDER_ICON_SIZE} weight="duotone" />
            }
            note="Nothing here to pick."
            title="This folder is empty"
          />
        ) : (
          <Placeholder
            glyph={
              <MagnifyingGlassIcon
                size={PLACEHOLDER_ICON_SIZE}
                weight="duotone"
              />
            }
            note="Type a / to go somewhere else."
            title={`Nothing here matches “${query}”`}
          />
        );
      }
    }
  }
};

const Placeholder = ({
  glyph,
  note,
  title,
}: {
  glyph: ReactNode;
  note: string;
  title: string;
}) => (
  <div className={placeholderStyles}>
    <span className={placeholderGlyphStyles}>{glyph}</span>
    <span className={placeholderTitleStyles}>{title}</span>
    <span className={placeholderNoteStyles}>{note}</span>
  </div>
);

/** The footer chip showing what the confirm button would choose. */
const Selection = ({
  answer,
  home,
  marks,
  mode,
}: {
  answer: readonly string[] | undefined;
  home: string;
  marks: readonly string[];
  mode: ChooserMode;
}) => {
  if (answer === undefined) {
    return (
      <span className={selectionNoneStyles}>
        {mode === ChooserMode.Save ? "Name the file" : "Nothing selected"}
      </span>
    );
  } else if (marks.length > 0) {
    return (
      <>
        <span className={selectionCountStyles}>
          {marks.length === 1 ? "1 file" : `${marks.length.toString()} files`}
        </span>
        <span className={selectionFolderStyles}>
          {marks
            .map((path) => path.slice(path.lastIndexOf("/") + 1))
            .join(", ")}
        </span>
      </>
    );
  } else {
    return (
      <>
        <span className={selectionGlyphStyles}>
          {mode === ChooserMode.OpenFolder ? (
            <FolderIcon size={ICON_SIZE} weight="fill" />
          ) : (
            <CheckIcon size={ICON_SIZE} weight="bold" />
          )}
        </span>
        {answer.map((path) => (
          <SelectedPath key={path} path={shownPath(path, home)} />
        ))}
      </>
    );
  }
};

/**
 * A selected path, with the folder dimmed and truncated first so the file
 * name stays visible.
 */
const SelectedPath = ({ path }: { path: string }) => {
  const cut = path.lastIndexOf("/") + 1;
  return (
    <span className={selectionPathStyles}>
      <span className={selectionFolderStyles}>{path.slice(0, cut)}</span>
      <span className={selectionNameStyles}>{path.slice(cut)}</span>
    </span>
  );
};

/**
 * The sidebar entries: home, the user's folders, and root. Each user folder
 * goes by its own name, which may be in the user's language.
 */
const placesOf = (
  home: string,
  userFolders: readonly UserPlace[],
): readonly Place[] => [
  { glyph: HouseIcon, label: "Home", path: home },
  ...userFolders.map(({ folder, path }) => ({
    glyph: USER_FOLDER_GLYPHS[folder],
    label: path.slice(path.lastIndexOf("/") + 1),
    path,
  })),
  { glyph: HardDrivesIcon, label: "Computer", path: "/" },
];

/** The default highlight: the first row below `..`. */
const firstOf = (rows: readonly Row[]): number =>
  rows[0]?.kind === RowKind.Parent && rows.length > 1 ? 1 : 0;

/**
 * The paths the picker would return now, or `undefined` if nothing valid is
 * selected. A folder request returns the current directory; multi-select
 * returns the marks, or the highlighted file if none; a save returns the name
 * in the current directory, unless a folder has it.
 */
const answerOf = ({
  clash,
  current,
  directory,
  marks,
  mode,
  name,
}: {
  clash: Clash;
  current: Row | undefined;
  directory: string;
  marks: readonly string[];
  mode: ChooserMode;
  name: string;
}): readonly string[] | undefined => {
  const file = current?.kind === RowKind.File ? [current.path] : undefined;
  switch (mode) {
    case ChooserMode.Open: {
      return file;
    }
    case ChooserMode.OpenMultiple: {
      return marks.length > 0 ? marks : file;
    }
    case ChooserMode.OpenFolder: {
      return [directory];
    }
    case ChooserMode.Save: {
      return name === "" || name.includes("/") || clash === Clash.Folder
        ? undefined
        : [pathIn(directory, name)];
    }
  }
};

/** `marks` with `path` toggled. */
const toggled = (marks: readonly string[], path: string): readonly string[] =>
  marks.includes(path)
    ? marks.filter((marked) => marked !== path)
    : [...marks, path];

/** The Kind column text for a row. */
const describe = (row: Row): string => {
  switch (row.kind) {
    case RowKind.Parent: {
      return "Up a folder";
    }
    case RowKind.Directory: {
      return "Folder";
    }
    case RowKind.File: {
      return kindLabel(row.name);
    }
  }
};

const glyphOf = (kind: FileKind): typeof FileIcon => {
  switch (kind) {
    case FileKind.Archive: {
      return FileZipIcon;
    }
    case FileKind.Audio: {
      return FileAudioIcon;
    }
    case FileKind.Code: {
      return FileCodeIcon;
    }
    case FileKind.Document: {
      return FileTextIcon;
    }
    case FileKind.Image: {
      return FileImageIcon;
    }
    case FileKind.Pdf: {
      return FilePdfIcon;
    }
    case FileKind.Video: {
      return FileVideoIcon;
    }
    case FileKind.Other: {
      return FileIcon;
    }
  }
};

/** A row's `data-tone`, which sets its tile color. */
const toneOf = (row: Row): string => {
  switch (row.kind) {
    case RowKind.Parent: {
      return "parent";
    }
    case RowKind.Directory: {
      return "folder";
    }
    case RowKind.File: {
      return fileToneOf(fileKindOf(row.name));
    }
  }
};

const fileToneOf = (kind: FileKind): string => {
  switch (kind) {
    case FileKind.Archive: {
      return "archive";
    }
    case FileKind.Audio: {
      return "audio";
    }
    case FileKind.Code: {
      return "code";
    }
    case FileKind.Document: {
      return "document";
    }
    case FileKind.Image: {
      return "image";
    }
    case FileKind.Pdf: {
      return "pdf";
    }
    case FileKind.Video: {
      return "video";
    }
    case FileKind.Other: {
      return "other";
    }
  }
};

const titleOf = (mode: ChooserMode): string => {
  switch (mode) {
    case ChooserMode.Open: {
      return "Open a file";
    }
    case ChooserMode.OpenMultiple: {
      return "Open files";
    }
    case ChooserMode.OpenFolder: {
      return "Choose a folder";
    }
    case ChooserMode.Save: {
      return "Save as";
    }
  }
};

const confirmOf = (mode: ChooserMode): string => {
  switch (mode) {
    case ChooserMode.Open:
    case ChooserMode.OpenMultiple: {
      return "Open";
    }
    case ChooserMode.OpenFolder: {
      return "Choose";
    }
    case ChooserMode.Save: {
      return "Save";
    }
  }
};

/** A row's id, for `aria-activedescendant`. */
const rowId = (listId: string, at: number): string =>
  `${listId}-${at.toString()}`;

/** Ctrl+Enter, or Cmd+Enter: confirms whatever is highlighted. */
const isConfirmChord = (event: KeyboardEvent): boolean =>
  event.key === "Enter" && (event.ctrlKey || event.metaKey);

/** Selects the name up to its extension, so typing keeps the extension. */
const selectStem = (event: FocusEvent<HTMLInputElement>) => {
  event.currentTarget.setSelectionRange(0, stemEnd(event.currentTarget.value));
};

/** Ctrl, or Cmd, and `key`. */
const isChord = (event: KeyboardEvent, key: string): boolean =>
  event.key === key && (event.ctrlKey || event.metaKey);

/** Why a folder could not be made, for the user. */
const failureOf = (error: SystemError): string => {
  switch (error.kind) {
    case SystemErrorKind.AlreadyExists: {
      return "Something here already has that name";
    }
    case SystemErrorKind.PermissionDenied: {
      return "You can't make folders here";
    }
    default: {
      return error.message;
    }
  }
};
