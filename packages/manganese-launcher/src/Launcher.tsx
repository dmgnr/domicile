/// <reference types="@domicile-desktop/manganese-host/domicile-elements" />

import { Input } from "@domicile-desktop/component-library/Input";
import {
  highlightIn,
  pageOf,
  stepOf,
  steppedTo,
} from "@domicile-desktop/component-library/list-walk";
import { Marked } from "@domicile-desktop/component-library/Marked";
import { ModalDialog } from "@domicile-desktop/component-library/ModalDialog";
import {
  ResultList,
  resultId,
} from "@domicile-desktop/component-library/ResultList";
import { LogoTile, RowTile } from "@domicile-desktop/component-library/RowTile";
import { Engine } from "@domicile-desktop/manganese-address/search";
import type { FilePreview } from "@domicile-desktop/sdk/file-preview";
import { FilePreviewKind } from "@domicile-desktop/sdk/file-preview";
import {
  WEBVIEW_FAVICON_CHANGE_EVENT,
  WEBVIEW_GUEST_FOCUS_EVENT,
} from "@domicile-desktop/sdk/webview-element";
import { nothingOpens } from "@domicile-desktop/system-apps/opens";
import { AppWindowIcon } from "@phosphor-icons/react/dist/ssr/AppWindow";
import { BinaryIcon } from "@phosphor-icons/react/dist/ssr/Binary";
import { BookmarkSimpleIcon } from "@phosphor-icons/react/dist/ssr/BookmarkSimple";
import { CircleNotchIcon } from "@phosphor-icons/react/dist/ssr/CircleNotch";
import { DetectiveIcon } from "@phosphor-icons/react/dist/ssr/Detective";
import { FileIcon } from "@phosphor-icons/react/dist/ssr/File";
import { FileXIcon } from "@phosphor-icons/react/dist/ssr/FileX";
import { FolderIcon } from "@phosphor-icons/react/dist/ssr/Folder";
import { FolderDashedIcon } from "@phosphor-icons/react/dist/ssr/FolderDashed";
import { GithubLogoIcon } from "@phosphor-icons/react/dist/ssr/GithubLogo";
import { GlobeSimpleIcon } from "@phosphor-icons/react/dist/ssr/GlobeSimple";
import { GoogleLogoIcon } from "@phosphor-icons/react/dist/ssr/GoogleLogo";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/ssr/MagnifyingGlass";
import { WarningCircleIcon } from "@phosphor-icons/react/dist/ssr/WarningCircle";
import { YoutubeLogoIcon } from "@phosphor-icons/react/dist/ssr/YoutubeLogo";
import type { ReactNode, RefObject } from "react";
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { css } from "../styled-system/css";
import { hstack, vstack } from "../styled-system/patterns";
import { AppGlancePreview } from "./AppGlancePreview";
import { AudioPreview } from "./AudioPreview";
import type { AppGlance } from "./app-glance";
import type { Choice } from "./choices";
import {
  ChoiceKind,
  choicesFor,
  launchOf,
  openWithOf,
  PRIVATE_TAG,
} from "./choices";
import { FolderPreview } from "./FolderPreview";
import type { FileRow } from "./file-row";
import type { DesktopEntry, FoundApps } from "./found-apps";
import type { Launch } from "./launch";
import type { LearnedIcons } from "./learned-icons";
import { learnedIcons, learnIcon } from "./learned-icons";
import { homeUrl, MediaKind, mediaOf } from "./media";
import { TextPreview } from "./TextPreview";
import type { Found } from "./useFound";
import { useFound } from "./useFound";
import { useFoundApps } from "./useFoundApps";
import { usePreview } from "./usePreview";
import { useSettled } from "./useSettled";
import { VideoPreview } from "./VideoPreview";
import { WikipediaLogoIcon } from "./WikipediaLogoIcon";

/** The box's accessible name. */
const PROMPT = "Open an app, a file, a URL, or search";

/** The box's placeholder: the prompt, naming a few tags so people find them. */
const PLACEHOLDER = `${PROMPT}. Try !yt, !wiki or !gh.`;

/**
 * How long the highlight must rest on a row before it is previewed. Long
 * enough to skip previews while typing, short enough to feel immediate.
 */
const PREVIEW_SETTLE_MS = 200;

/** `WheelEvent.DOM_DELTA_PIXEL`. */
const DOM_DELTA_PIXEL = 0;

/** Glyph size in a preview pane with no image. */
const EMPTY_ICON_SIZE = 64;

/** No app has a glance. */
const NO_GLANCES: ReadonlyMap<string, AppGlance> = new Map();

/** Glyph size in the box and the indexing notice. */
const ICON_SIZE = 16;

type Props = {
  /** Whether it opened over a private browser, so the box starts with `!p`. */
  fromPrivate: boolean;
  /**
   * What the shell knows of some apps, by desktop entry id, such as an
   * inbox's unread mail. Their previews show it instead of what they run.
   */
  glances?: ReadonlyMap<string, AppGlance>;
  /** Called once it has finished closing, its exit animation included. */
  onClosed: () => void;
  /** Called on Escape or a backdrop click. The desktop decides what to do. */
  onDismiss: () => void;
  onLaunch: (launch: Launch) => void;
  open: boolean;
  /**
   * Whether an app opens the file at `path`, relative to home, asked before
   * opening one, so the launcher can say when none does instead.
   */
  opens: (path: string) => Promise<boolean>;
  /**
   * Results for the empty query, fetched before opening so they render with
   * the panel. See `useOpeningApps`.
   */
  opening: FoundApps;
  /** Reads a file's preview. */
  preview: Preview;
  /** Asks the host for files in home matching a query. */
  search: Search;
  /** Searches the applications and bookmarks for a query. */
  searchApps: SearchApps;
  /** The screen to open on: the one with keyboard focus. */
  screen: string;
};

/** Search home for files matching a query. */
type Search = (query: string) => Promise<Found>;

/** Search for applications matching a query. */
type SearchApps = (query: string) => Promise<FoundApps>;

/** Fetch a file's preview. */
type Preview = (path: string) => Promise<FilePreview>;

/** Record the icon a bookmark's page names. */
type Learn = (bookmark: string, icon: string) => void;

/**
 * The launcher: a search box that runs an application or opens a file, URL or
 * search. Opened with `mod+space`.
 *
 * It never closes itself. Open state lives in the desktop's reducer, so
 * Escape and backdrop clicks call `onDismiss`; a local copy of the state could
 * drift from the desktop's.
 */
export const Launcher = memo(
  ({
    fromPrivate,
    glances = NO_GLANCES,
    onClosed,
    onDismiss,
    onLaunch,
    open,
    opening,
    opens,
    preview,
    screen,
    search,
    searchApps,
  }: Props) => (
    <ModalDialog
      // Keyboard-driven, so no close button; Escape closes it.
      closeButton={false}
      onOpenChange={(next) => {
        if (!next) {
          onDismiss();
        }
      }}
      onOpenChangeComplete={(next) => {
        if (!next) {
          onClosed();
        }
      }}
      open={open}
      // The shell refocuses the focused window. Focusing a browser window's
      // view would read as a click in it and move the keyboard there.
      returnFocus={false}
      screen={screen}
      // Wide enough for the rows and a readable preview side by side.
      size="xl"
      // Translucent, so the desktop stays visible behind a brief overlay.
      surface="glass"
      // The search box heads the panel, so the title is for screen readers.
      title="Open"
      titleHidden
    >
      {/*
      Inside the dialog so it unmounts on close, and every open starts with an
      empty box without an effect to reset it.
    */}
      <Query
        fromPrivate={fromPrivate}
        glances={glances}
        onLaunch={onLaunch}
        opening={opening}
        opens={opens}
        preview={preview}
        search={search}
        searchApps={searchApps}
      />
    </ModalDialog>
  ),
);

type QueryProps = {
  fromPrivate: boolean;
  glances: ReadonlyMap<string, AppGlance>;
  onLaunch: (launch: Launch) => void;
  opens: (path: string) => Promise<boolean>;
  opening: FoundApps;
  preview: Preview;
  search: Search;
  searchApps: SearchApps;
};

/**
 * The search box, result list and preview.
 *
 * A combobox over a listbox: focus stays in the box and
 * `aria-activedescendant` marks the highlighted row.
 */
const Query = ({
  fromPrivate,
  glances,
  onLaunch,
  opening,
  opens,
  preview,
  search,
  searchApps,
}: QueryProps) => {
  const listId = useId();
  const [query, setQuery] = useState(fromPrivate ? `${PRIVATE_TAG} ` : "");
  // The requested highlight index. `highlightIn` clamps it to the current
  // list.
  const [stepped, setStepped] = useState(0);

  const found = useFound(search, query);
  const offered = useFoundApps(searchApps, query, opening);
  // Memoized, so a render that changes no input keeps the rows.
  const choices = useMemo(
    () => choicesFor(query, found.files, offered.apps, offered.bookmarks),
    [found.files, offered.apps, offered.bookmarks, query],
  );
  const highlighted = highlightIn(choices.length, stepped);
  const chosen = highlighted === undefined ? undefined : choices[highlighted];
  // The previewed row: the highlighted one once it has settled, else the
  // previous one. Settles by key, since a choice is a new object per search.
  const shown = useSettled(
    chosen,
    chosen === undefined ? undefined : keyOf(chosen),
    PREVIEW_SETTLE_MS,
  );
  const box = useRef<HTMLInputElement>(null);
  const pane = useRef<HTMLElement>(null);
  const results = useRef<HTMLDivElement>(null);
  // Icons learned from bookmark previews. Read on open and on each new icon.
  const [learned, setLearned] = useState(learnedIcons);
  const learn = useCallback((bookmark: string, icon: string) => {
    learnIcon(bookmark, icon);
    setLearned(learnedIcons());
  }, []);

  // The file the user tried to open that no app opens, which its row says.
  const [unopenable, setUnopenable] = useState<string | undefined>(undefined);

  // A tag fills in the box; any other row launches, asking what to open a
  // file with if `openWith`. A file no app opens stays, saying so.
  const choose = (choice: Choice, openWith: boolean) => {
    if (choice.kind === ChoiceKind.Tag) {
      setQuery(choice.line);
      setStepped(0);
    } else if (choice.kind === ChoiceKind.File && !openWith) {
      const { path } = choice.row;
      opens(path).then(
        (opened) => {
          if (opened) {
            onLaunch(launchOf(choice));
          } else {
            setUnopenable(path);
          }
        },
        (error: unknown) => {
          // biome-ignore lint/suspicious/noConsole: surfacing a background failure
          console.error(`Failed to tell what opens ${path}`, error);
        },
      );
    } else {
      onLaunch(openWith ? openWithOf(choice) : launchOf(choice));
    }
  };

  useEffect(() => keepKeyboardIn(mounted(box)), []);
  useEffect(() => scrollOnWheel(mounted(pane)), []);

  return (
    <div className={panelStyles}>
      <div className={searchStyles}>
        <Input
          aria-activedescendant={
            highlighted === undefined
              ? undefined
              : resultId(listId, highlighted)
          }
          aria-controls={listId}
          aria-expanded
          // A placeholder isn't an accessible name, and browser address bars are
          // comboboxes too, so this needs a label.
          aria-label={PROMPT}
          autoFocus
          flush
          onChange={(event) => {
            setQuery(event.target.value);
            // Reset, since the old index refers to the previous list.
            setStepped(0);
          }}
          onKeyDown={(event) => {
            const step = stepOf(event, pageOf(results.current));
            if (step !== undefined) {
              // Stop the box from moving the caret.
              event.preventDefault();
              // Step from the clamped highlight, since `stepped` may be past the
              // end of a narrowed list.
              setStepped(steppedTo(highlighted ?? 0, step, choices.length));
            } else if (event.key === "Enter" && chosen !== undefined) {
              // Taken, or the engine forwards it to the window the launch
              // focuses.
              event.preventDefault();
              choose(chosen, event.shiftKey);
            } else if (event.key === "Tab") {
              // Keep focus in the box (see `keepKeyboardIn`), and fill in a
              // highlighted tag as a shell completes a word.
              event.preventDefault();
              if (chosen?.kind === ChoiceKind.Tag) {
                choose(chosen, false);
              }
            }
          }}
          placeholder={PLACEHOLDER}
          prefixIcon={<MagnifyingGlassIcon size={ICON_SIZE} />}
          ref={box}
          role="combobox"
          size="lg"
          // File names would be flagged as misspellings.
          spellCheck={false}
          // Match count, like a find bar's.
          suffixIcon={
            <span aria-hidden="true" className={countStyles}>
              {`${found.matched.toString()} matched`}
            </span>
          }
          value={query}
        />
      </div>
      <div className={splitStyles}>
        {/*
          Fixed size, so the panel doesn't resize as results change while
          typing.
        */}
        <div className={resultsStyles} ref={results}>
          <ResultList
            highlighted={highlighted}
            id={listId}
            items={choices}
            keyOf={keyOf}
            onChoose={(choice) => {
              choose(choice, false);
            }}
            onHighlight={setStepped}
          >
            {(choice) => (
              <ChoiceRow
                choice={choice}
                learned={learned}
                query={query}
                unopenable={unopenable}
              />
            )}
          </ResultList>
          {/*
            After the rows, in the scroll area but outside the listbox, which
            may hold only options.
          */}
          {found.indexing && <StillIndexing />}
        </div>
        <section aria-label="Preview" className={previewStyles} ref={pane}>
          <PreviewOf
            choice={shown}
            glances={glances}
            onLearn={learn}
            preview={preview}
          />
        </section>
      </div>
    </div>
  );
};

/** A ref's element, which must be mounted (as it is inside an effect). */
const mounted = <T,>(ref: RefObject<T | null>): T => {
  if (ref.current === null) {
    throw new Error("An effect ran before its element was mounted");
  }
  return ref.current;
};

/**
 * Keep focus in `box`: block focus changes from presses anywhere in the
 * document, and reclaim it from a focused preview page. Returns a cleanup.
 *
 * Listens on the document because the dialog's title and footer are outside
 * the panel.
 */
const keepKeyboardIn = (box: HTMLInputElement): (() => void) => {
  const document = box.ownerDocument;
  const stayPut = (event: MouseEvent) => {
    if (event.target !== box) {
      event.preventDefault();
    }
  };
  const takeBack = () => {
    box.focus();
  };
  document.addEventListener("mousedown", stayPut);
  document.addEventListener(WEBVIEW_GUEST_FOCUS_EVENT, takeBack);
  return () => {
    document.removeEventListener("mousedown", stayPut);
    document.removeEventListener(WEBVIEW_GUEST_FOCUS_EVENT, takeBack);
  };
};

/**
 * Scroll `pane` on wheel events. The engine scrolls only a focused pane, not
 * one under the pointer. Returns a cleanup.
 *
 * Handles pixel deltas only, which is all Chromium sends.
 */
const scrollOnWheel = (pane: HTMLElement): (() => void) => {
  const scroll = (event: WheelEvent) => {
    if (event.deltaMode !== DOM_DELTA_PIXEL) {
      throw new RangeError(
        `unexpected WheelEvent.deltaMode: ${event.deltaMode.toString()}`,
      );
    }
    event.preventDefault();
    pane.scrollBy(event.deltaX, event.deltaY);
  };
  // Not passive, so it can cancel the engine's scroll and avoid doubling it.
  pane.addEventListener("wheel", scroll, { passive: false });
  return () => {
    pane.removeEventListener("wheel", scroll);
  };
};

/** One row's content, by choice kind. */
const ChoiceRow = ({
  choice,
  learned,
  query,
  unopenable,
}: {
  choice: Choice;
  learned: LearnedIcons;
  query: string;
  /** The file no app opens, if the user tried one. */
  unopenable: string | undefined;
}) => {
  switch (choice.kind) {
    case ChoiceKind.App: {
      return (
        <>
          <AppTile icon={choice.entry.icon} />
          <span className={rowNameStyles}>
            <Marked query={query} text={choice.entry.name} />
          </span>
        </>
      );
    }
    case ChoiceKind.Bookmark: {
      return (
        <>
          {/* Keyed on the icons, so a failed load doesn't stick when a new
              icon is learned. */}
          <BookmarkTile
            found={choice.icon}
            key={`${choice.url} ${learned[choice.url] ?? ""}`}
            learned={learned[choice.url]}
          />
          <span className={rowNameStyles}>
            <Marked query={query} text={choice.name} />
          </span>
        </>
      );
    }
    case ChoiceKind.File: {
      return (
        <FileChoice
          query={query}
          row={choice.row}
          unopenable={unopenable === choice.row.path}
        />
      );
    }
    case ChoiceKind.Site: {
      return (
        <>
          <RowTile icon={choice.isPrivate ? DetectiveIcon : GlobeSimpleIcon} />
          <span className={rowNameStyles}>
            <span className={rowVerbStyles}>Go to</span> {choice.url}
            <InPrivate isPrivate={choice.isPrivate} />
          </span>
        </>
      );
    }
    case ChoiceKind.Search: {
      return (
        <>
          <RowTile
            icon={choice.isPrivate ? DetectiveIcon : MagnifyingGlassIcon}
          />
          <span className={rowNameStyles}>
            <span className={rowVerbStyles}>Search for</span> {choice.query}
            <InPrivate isPrivate={choice.isPrivate} />
          </span>
        </>
      );
    }
    case ChoiceKind.Tag: {
      return (
        <>
          <RowTile icon={tagLogoOf(choice.engine)} />
          <span className={rowNameStyles}>
            <Marked query={query} text={choice.tag} />{" "}
            <span className={rowVerbStyles}>{tagDoesOf(choice.engine)}</span>
          </span>
        </>
      );
    }
    case ChoiceKind.TaggedSearch: {
      return (
        <>
          <RowTile icon={logoOf(choice.engine)} />
          <span className={rowNameStyles}>
            <span className={rowVerbStyles}>Search for</span> {choice.query}{" "}
            <span className={rowVerbStyles}>on</span> {nameOf(choice.engine)}
            <InPrivate isPrivate={choice.isPrivate} />
          </span>
        </>
      );
    }
    case ChoiceKind.TaggedSite: {
      return (
        <>
          <RowTile icon={logoOf(choice.engine)} />
          <span className={rowNameStyles}>
            <span className={rowVerbStyles}>Go to</span> {choice.path}{" "}
            <span className={rowVerbStyles}>on</span> {nameOf(choice.engine)}
            <InPrivate isPrivate={choice.isPrivate} />
          </span>
        </>
      );
    }
  }
};

/** The end of a web row that opens a private browser. */
const InPrivate = ({ isPrivate }: { isPrivate: boolean }) =>
  isPrivate && (
    <>
      {" "}
      <span className={rowVerbStyles}>in a private browser</span>
    </>
  );

/** A path's row: the directory it is in, over its name. */
const FileChoice = ({
  query,
  row,
  unopenable,
}: {
  query: string;
  row: FileRow;
  /** No app opens it, which the row says under its name. */
  unopenable: boolean;
}) => (
  <>
    <RowTile icon={row.isDirectory ? FolderIcon : FileIcon} />
    <span className={rowTextStyles}>
      {row.directory !== undefined && (
        <span className={rowDirectoryStyles}>
          <Marked query={query} text={row.directory} />
        </span>
      )}
      <span className={rowNameStyles}>
        <Marked query={query} text={row.name} />
      </span>
      {unopenable && (
        <span className={rowWarningStyles}>
          <WarningCircleIcon aria-hidden size={12} />
          {nothingOpens(row.name)}
        </span>
      )}
    </span>
  </>
);

/** An application's icon, or a generic glyph if none was found. */
const AppTile = ({ icon }: { icon: string | undefined }) =>
  icon === undefined ? (
    <RowTile icon={AppWindowIcon} />
  ) : (
    <LogoTile picture={icon} />
  );

/**
 * A bookmark's icon: the learned one, else the one its site names, else a
 * bookmark glyph. Falls back to the site's if the learned icon fails to load
 * (e.g. after the user signs out).
 */
const BookmarkTile = ({
  found,
  learned,
}: {
  found: string | undefined;
  learned: string | undefined;
}) => {
  const [failed, setFailed] = useState(false);
  const picture = failed || learned === undefined ? found : learned;
  return picture === undefined ? (
    <RowTile icon={BookmarkSimpleIcon} />
  ) : (
    <LogoTile
      onError={
        picture === learned
          ? () => {
              setFailed(true);
            }
          : undefined
      }
      picture={picture}
    />
  );
};

/**
 * The preview pane's content. Never blank, since that looks broken; with no
 * row highlighted it shows a hint.
 */
const PreviewOf = ({
  choice,
  glances,
  onLearn,
  preview,
}: {
  choice: Choice | undefined;
  glances: ReadonlyMap<string, AppGlance>;
  onLearn: Learn;
  preview: Preview;
}) =>
  choice === undefined ? (
    <Placeholder
      icon={MagnifyingGlassIcon}
      note="Type to find an app, a file, a site or a search"
      title="Nothing selected"
    />
  ) : (
    <ChoicePreview
      choice={choice}
      glances={glances}
      onLearn={onLearn}
      preview={preview}
    />
  );

/**
 * An application's glance, else its preview image, else its name, comment
 * and command. The command tells apart entries with the same name.
 */
const AppPreview = ({
  entry,
  glance,
}: {
  entry: DesktopEntry;
  glance: AppGlance | undefined;
}) => {
  if (glance !== undefined) {
    return (
      <AppGlancePreview
        glance={glance}
        icon={entry.icon}
        name={entry.name}
        picture={<AppWindowIcon size={32} weight="thin" />}
      />
    );
  } else if (entry.preview === undefined) {
    return <AppCard entry={entry} />;
  } else {
    return <img alt={entry.name} className={mediaStyles} src={entry.preview} />;
  }
};

/** An application's name, comment and command. */
const AppCard = ({ entry }: { entry: DesktopEntry }) => (
  <Placeholder
    icon={AppWindowIcon}
    note={
      <span className={appNoteStyles}>
        {entry.comment !== "" && <span>{entry.comment}</span>}
        <code className={commandStyles}>{entry.command.join(" ")}</code>
      </span>
    }
    picture={entry.icon}
    title={entry.name}
  />
);

/** A file's name and kind, with `note` explaining why there is no preview. */
const NamedFile = ({ note, row }: { note?: string; row: FileRow }) => (
  <Placeholder
    icon={row.isDirectory ? FolderIcon : FileIcon}
    note={note}
    title={row.name}
  />
);

/**
 * A large glyph (or small `picture`) over a title and a note, for a pane with
 * no full preview.
 */
const Placeholder = ({
  icon: Icon,
  note,
  picture,
  title,
}: {
  icon: typeof FileIcon;
  note?: ReactNode;
  picture?: string | undefined;
  title: string;
}) => (
  <div className={placeholderStyles}>
    {picture === undefined ? (
      <Icon size={EMPTY_ICON_SIZE} weight="thin" />
    ) : (
      <img alt="" className={placeholderPictureStyles} src={picture} />
    )}
    <span className={placeholderTitleStyles}>{title}</span>
    {note !== undefined && (
      <span className={placeholderNoteStyles}>{note}</span>
    )}
  </div>
);

/**
 * The preview of the highlighted row.
 *
 * - A site loads in a private `<webview>`, a bookmark in a signed-in one.
 *   `keepKeyboardIn` takes back focus from it.
 * - Images, videos, PDFs and songs load from `domicile://home/`. Song tags
 *   are read through the system calls.
 * - Other files show what `previewFile` reads of them.
 */
const ChoicePreview = ({
  choice,
  glances,
  onLearn,
  preview,
}: {
  choice: Choice;
  glances: ReadonlyMap<string, AppGlance>;
  onLearn: Learn;
  preview: Preview;
}) => {
  switch (choice.kind) {
    // The row already has everything to show.
    case ChoiceKind.App: {
      return (
        <AppPreview
          entry={choice.entry}
          glance={glances.get(choice.entry.id)}
        />
      );
    }
    case ChoiceKind.File: {
      // Keyed on the path, so state (a failed image, a playing song) resets
      // per row.
      return (
        <FileChoicePreview
          key={choice.row.path}
          preview={preview}
          row={choice.row}
        />
      );
    }
    case ChoiceKind.Bookmark: {
      // Keyed on the URL, so each bookmark gets its own guest and icons don't
      // leak between them.
      return (
        <BookmarkPreview
          // Keyed on the profile too: a view reads it once.
          key={`${choice.profile ?? ""} ${choice.url}`}
          onLearn={onLearn}
          profile={choice.profile}
          url={choice.url}
        />
      );
    }
    case ChoiceKind.Tag: {
      return (
        <Placeholder
          icon={tagLogoOf(choice.engine)}
          note={`Add ${choice.tag} anywhere in what you type to ${tagUseOf(choice.engine)}. Press Enter or Tab to add it.`}
          title={tagDoesOf(choice.engine)}
        />
      );
    }
    // Private, so a page the user only looked at leaves nothing behind.
    case ChoiceKind.Site:
    case ChoiceKind.Search:
    case ChoiceKind.TaggedSearch:
    case ChoiceKind.TaggedSite: {
      return (
        <webview
          className={viewStyles}
          private=""
          src={choice.url}
          title={choice.url}
        />
      );
    }
  }
};

/**
 * A bookmark's page. Loads with the user's sign-in, so it can learn icons the
 * compositor's anonymous lookup can't see.
 */
const BookmarkPreview = ({
  onLearn,
  profile,
  url,
}: {
  onLearn: Learn;
  /** The browser profile the bookmark opens in, so the preview is signed in as it will be. */
  profile: string | undefined;
  url: string;
}) => {
  // `null` because React passes it to a callback ref on unmount.
  const [view, setView] = useState<HTMLWebViewElement | null>(null);

  useEffect(() => {
    if (view === null) {
      return undefined;
    } else {
      // Only learn from the bookmark's own origin. A sign-in redirect or a
      // followed link would give another site's icon.
      const heard = () => {
        if (view.favicon !== "" && sameOrigin(view.url, url)) {
          onLearn(url, view.favicon);
        }
      };
      view.addEventListener(WEBVIEW_FAVICON_CHANGE_EVENT, heard);
      return () => {
        view.removeEventListener(WEBVIEW_FAVICON_CHANGE_EVENT, heard);
      };
    }
  }, [onLearn, url, view]);

  // `profile` is read as the view enters the document, so it is on the first
  // render, before `src`.
  return (
    <webview
      className={viewStyles}
      profile={profile}
      ref={setView}
      src={url}
      title={url}
    />
  );
};

/** Whether `a` and `b` are valid URLs with the same origin. */
const sameOrigin = (a: string, b: string) =>
  URL.canParse(a) && URL.canParse(b) && new URL(a).origin === new URL(b).origin;

/** A file's preview, by media kind. */
const FileChoicePreview = ({
  preview,
  row,
}: {
  preview: Preview;
  row: FileRow;
}) => {
  const media = mediaIn(row);
  switch (media) {
    case undefined: {
      return <FilePreviewPane preview={preview} row={row} />;
    }
    case MediaKind.Audio: {
      return <SongPane preview={preview} row={row} />;
    }
    case MediaKind.Image:
    case MediaKind.Video:
    case MediaKind.Pdf: {
      return <MediaPreview kind={media} row={row} />;
    }
  }
};

/**
 * A media file loaded from the engine, or a "cannot preview" placeholder if it
 * fails to load (the extension is only a guess).
 */
const MediaPreview = ({
  kind,
  row,
}: {
  kind: Exclude<MediaKind, MediaKind.Audio>;
  row: FileRow;
}) => {
  const [failed, setFailed] = useState(false);
  const url = homeUrl(row.path);
  const fail = () => {
    setFailed(true);
  };
  if (failed) {
    return <CannotPreview row={row} />;
  } else {
    switch (kind) {
      case MediaKind.Image: {
        return (
          // biome-ignore lint/a11y/noNoninteractiveElementInteractions: `error` is the image failing to load, not something a person does to it
          <img
            alt={row.name}
            className={mediaStyles}
            onError={fail}
            src={url}
          />
        );
      }
      case MediaKind.Video: {
        return <VideoPreview name={row.name} onError={fail} url={url} />;
      }
      case MediaKind.Pdf: {
        // PDF viewer parameters: hide the toolbar and sidebar in a small pane.
        return (
          <iframe
            className={viewStyles}
            src={`${url}#toolbar=0&navpanes=0`}
            title={row.name}
          />
        );
      }
    }
  }
};

/** Placeholder for a file that can't be previewed. */
const CannotPreview = ({ row }: { row: FileRow }) => (
  <Placeholder
    icon={BinaryIcon}
    note="No preview for this file"
    title={row.name}
  />
);

/**
 * The media kind of `row`, or `undefined` if `previewFile` previews it. Only
 * paths under home (all the engine serves), and never directories.
 */
const mediaIn = (row: FileRow): MediaKind | undefined =>
  row.isDirectory || row.path.startsWith("/") ? undefined : mediaOf(row.path);

/**
 * A song played by the engine, with its tags. Shown even if they can't be
 * read, since the engine may still play it.
 */
const SongPane = ({ preview, row }: { preview: Preview; row: FileRow }) => {
  const shown = usePreview(preview, row.path);
  return shown === undefined ? (
    <NamedFile row={row} />
  ) : (
    <AudioPreview
      row={row}
      tags={shown.kind === FilePreviewKind.Audio ? shown.tags : undefined}
    />
  );
};

/** A path's preview, by kind. */
const FilePreviewPane = ({
  preview,
  row,
}: {
  preview: Preview;
  row: FileRow;
}) => {
  const shown = usePreview(preview, row.path);
  switch (shown?.kind) {
    // Not read yet: show the name.
    case undefined: {
      return <NamedFile row={row} />;
    }
    case FilePreviewKind.Text: {
      return <TextPreview path={row.path} text={shown.text} />;
    }
    case FilePreviewKind.Directory: {
      // Say the folder is empty, since a blank pane looks like loading.
      return shown.entries.length === 0 ? (
        <Placeholder
          icon={FolderDashedIcon}
          note="Empty folder"
          title={row.name}
        />
      ) : (
        <FolderPreview entries={shown.entries} row={row} />
      );
    }
    case FilePreviewKind.Audio: {
      return <AudioPreview row={row} tags={shown.tags} />;
    }
    case FilePreviewKind.Binary: {
      return <CannotPreview row={row} />;
    }
    case FilePreviewKind.Unreadable: {
      return (
        <Placeholder
          icon={FileXIcon}
          note="This file can't be read"
          title={row.name}
        />
      );
    }
  }
};

/**
 * A notice that the home index is still building.
 *
 * `role="status"` so screen readers announce it.
 */
const StillIndexing = () => (
  <p className={indexingStyles} role="status">
    <span className={spinnerStyles}>
      <CircleNotchIcon size={ICON_SIZE} />
    </span>
    Still finding your files
  </p>
);

/** A stable key for a row across renders. */
const keyOf = (choice: Choice): string => {
  switch (choice.kind) {
    case ChoiceKind.App: {
      return `app:${choice.entry.id}`;
    }
    case ChoiceKind.Bookmark: {
      return `bookmark:${choice.name}:${choice.url}`;
    }
    case ChoiceKind.File: {
      return `file:${choice.row.path}`;
    }
    // Include the URL, so a changed search is a new row for the preview, and
    // privacy, since a private row sits beside its ordinary one.
    case ChoiceKind.Site: {
      return `site:${privacyOf(choice.isPrivate)}:${choice.url}`;
    }
    case ChoiceKind.Search: {
      return `search:${privacyOf(choice.isPrivate)}:${choice.url}`;
    }
    case ChoiceKind.Tag: {
      return `tag:${choice.tag}`;
    }
    case ChoiceKind.TaggedSearch: {
      return `tagged:${privacyOf(choice.isPrivate)}:${choice.url}`;
    }
    case ChoiceKind.TaggedSite: {
      return `tagged-site:${privacyOf(choice.isPrivate)}:${choice.url}`;
    }
  }
};

const privacyOf = (isPrivate: boolean): string =>
  isPrivate ? "private" : "ordinary";

/** The logo of a tagged search's site. Images and Maps use Google's. */
const logoOf = (engine: Engine): typeof FileIcon => {
  switch (engine) {
    case Engine.GitHub: {
      return GithubLogoIcon;
    }
    case Engine.Google:
    case Engine.GoogleImages:
    case Engine.GoogleMaps: {
      return GoogleLogoIcon;
    }
    case Engine.Wikipedia: {
      return WikipediaLogoIcon;
    }
    case Engine.YouTube: {
      return YoutubeLogoIcon;
    }
  }
};

const nameOf = (engine: Engine): string => {
  switch (engine) {
    case Engine.GitHub: {
      return "GitHub";
    }
    case Engine.Google: {
      return "Google";
    }
    case Engine.GoogleImages: {
      return "Google Images";
    }
    case Engine.GoogleMaps: {
      return "Google Maps";
    }
    case Engine.Wikipedia: {
      return "Wikipedia";
    }
    case Engine.YouTube: {
      return "YouTube";
    }
  }
};

/** A tag row's glyph: its site's logo, or the private browser's. */
const tagLogoOf = (engine: Engine | undefined): typeof FileIcon =>
  engine === undefined ? DetectiveIcon : logoOf(engine);

/** What a tag does, as its row says it. */
const tagDoesOf = (engine: Engine | undefined): string =>
  engine === undefined
    ? "Open in a private browser"
    : `Search ${nameOf(engine)}`;

/** What adding a tag does, for its preview. */
const tagUseOf = (engine: Engine | undefined): string => {
  if (engine === undefined) {
    return "open sites and searches in a private browser";
  } else {
    return engine === Engine.Google
      ? "search Google and skip the other matches"
      : `search ${nameOf(engine)} instead of Google`;
  }
};

// The search box is the panel's header, set off by a line under it.
const searchStyles = css({
  borderBlockEnd:
    "1px solid color-mix(in oklab, {colors.foreground} 10%, transparent)",
  // Up into the popup's top padding, which is sized for a title.
  marginBlockStart: -3,
  marginInline: -5,
  paddingBlockEnd: 2,
  paddingInline: 3,
});

const panelStyles = vstack({
  alignItems: "stretch",
  gap: 3,
});

// Rows and preview side by side; the preview gets more width.
const splitStyles = css({
  display: "grid",
  gap: 3,
  gridTemplateColumns: "minmax(0, 2fr) minmax(0, 3fr)",
});

// A fixed height, not a maximum, so the panel doesn't resize with the results
// (see the call site). Short enough to leave the backdrop visible.
const resultsStyles = css({
  // A slightly different background marks the empty space as part of the
  // list.
  backgroundColor: "color-mix(in oklab, {colors.foreground} 4%, transparent)",
  // Relative to the dialog's screen, not the page, which spans every monitor.
  // Leaves room for the box and top offset on any monitor.
  blockSize: "60cqh",
  borderRadius: "md",
  overflowY: "auto",
  padding: 1,
  // Thin, since the list is scrolled by keyboard; it only signals more rows.
  scrollbarColor: "{colors.border} transparent",
  scrollbarWidth: "thin",
  // Keeps a row scrolled by `keepInView` off the edge.
  scrollPaddingBlock: 1,
});

// Matches the results list's background and height. Sets `color` explicitly,
// since the document default is unreadable on the glass surface.
const previewStyles = css({
  backgroundColor: "color-mix(in oklab, {colors.foreground} 4%, transparent)",
  blockSize: "60cqh",
  borderRadius: "md",
  color: "foreground",
  overflowY: "auto",
  scrollbarColor: "{colors.border} transparent",
  scrollbarWidth: "thin",
});

// Fit within the pane, uncropped.
const mediaStyles = css({
  blockSize: "100%",
  display: "block",
  inlineSize: "100%",
  objectFit: "contain",
});

// Centered, muted glyph and text for a pane with no preview.
const placeholderStyles = vstack({
  blockSize: "100%",
  color: "muted",
  gap: 2,
  justifyContent: "center",
  padding: 6,
  textAlign: "center",
});

// Scale an application icon to the glyph's size.
const placeholderPictureStyles = css({
  blockSize: 16,
  inlineSize: 16,
  objectFit: "contain",
});

const placeholderTitleStyles = css({
  color: "foreground",
  fontSize: "md",
  maxInlineSize: "100%",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
});

const placeholderNoteStyles = css({
  fontSize: "sm",
});

const appNoteStyles = vstack({
  gap: 2,
});

// Break anywhere, since paths have no spaces to wrap at.
const commandStyles = css({
  color: "textTertiary",
  fontFamily: "mono",
  wordBreak: "break-all",
});

const viewStyles = css({
  blockSize: "100%",
  border: "none",
  display: "block",
  inlineSize: "100%",
});

// Directory over name, each truncating independently.
const rowTextStyles = css({
  display: "flex",
  flex: "1 1 auto",
  flexDirection: "column",
  minInlineSize: 0,
});

const rowNameStyles = css({
  fontSize: "md",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
});

// The action word on site and search rows, muted.
const rowVerbStyles = css({
  color: "muted",
});

// Smaller and muted, since it only disambiguates same-named files.
const rowDirectoryStyles = css({
  color: "muted",
  fontSize: "xs",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
});

// Under the name, in the warning color, as a panel's warning note.
const rowWarningStyles = css({
  alignItems: "center",
  color: "warning",
  display: "inline-flex",
  fontSize: "xs",
  gap: 1,
});

// Tabular figures, so the count doesn't shift as it changes.
const countStyles = css({
  color: "muted",
  fontSize: "xs",
  fontVariantNumeric: "tabular-nums",
  whiteSpace: "nowrap",
});

// Same inset as a row, so the glyph aligns with the row tiles.
const indexingStyles = hstack({
  color: "muted",
  fontSize: "xs",
  gap: 1.5,
  margin: 0,
  paddingBlock: 1.5,
  paddingInline: 2,
});

// Spins the wrapper rather than the Phosphor icon, which this file styles
// through its container. Stops under `prefers-reduced-motion`; the text
// already says what is happening.
const spinnerStyles = css({
  _motionReduce: { animationName: "none" },
  alignItems: "center",
  animation: "spin {durations.spin} {easings.linear} infinite",
  color: "accent",
  display: "inline-flex",
  flexShrink: 0,
});
