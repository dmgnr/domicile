import type { Domicile } from "@domicile-desktop/sdk/desktop/desktop";
import type {
  Extension,
  ExtensionPopup,
} from "@domicile-desktop/sdk/extension";
import type { TrayItem } from "@domicile-desktop/sdk/tray";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";

import { css } from "../styled-system/css";
import { hstack } from "../styled-system/patterns";
import { ExtensionAction } from "./extensions/ExtensionAction";
import { TrayIcon } from "./TrayIcon";
import type { TrayEntry } from "./tray-entry";
import { TrayEntryKind, trayEntries } from "./tray-entry";

/** The primary button, as `PointerEvent.button` numbers it. */
const PRIMARY_BUTTON = 0;

type Props = {
  /** Where clicks are sent. */
  domicile: Domicile;
  /** Every extension with an action, as the engine last described them. */
  extensions: readonly Extension[];
  /** The applications' icons, as the compositor last described them. */
  items: readonly TrayItem[];
  /** Move `dragged` onto `target` among the `shown` keys; see `moveTo`. */
  onMove: (shown: readonly string[], dragged: string, target: string) => void;
  /** Extension `id`'s action was clicked. */
  onActivate: (id: string) => void;
  /** Open an extension's popup, or close the open one with `undefined`. */
  onOpen: (popup: ExtensionPopup | undefined) => void;
  /** The open extension popup, or `undefined`. */
  opened: ExtensionPopup | undefined;
  /** The user's icon order; see `useTrayOrder`. */
  order: readonly string[];
  /** After the icons: the button for the menu of every icon. */
  end?: ReactNode | undefined;
  /** An icon was dragged onto `end`: keep icon `key` out of the tray. */
  onUnpin?: ((key: string) => void) | undefined;
  /** The keys of the icons kept out of the tray; see `useTrayPins`. */
  unpinned?: ReadonlySet<string> | undefined;
};

/**
 * The tray: application StatusNotifierItems and extension actions, in one row,
 * in the user's order. See docs/architecture/SYSTEM-TRAY.md.
 *
 * One row because to the user both are icons for something running; the kind
 * only decides what a click does.
 *
 * Reordering uses pointer events, not native drag and drop, which needs a
 * platform drag controller that a bare tty lacks. A press that moved an icon
 * does not also activate it.
 *
 * Disabled actions are hidden. The state is each action's default, not the
 * focused tab's; see docs/architecture/EXTENSIONS.md.
 *
 * Unpinned icons are left out, except an extension whose popup is open, which
 * shows while it is so the popup hangs from it. An icon dragged onto `end` is
 * unpinned.
 */
export const Tray = ({
  domicile,
  end,
  extensions,
  items,
  onMove,
  onActivate,
  onOpen,
  onUnpin = () => undefined,
  opened,
  order,
  unpinned = new Set(),
}: Props) => {
  const entries = trayEntries(items, extensions, order).filter(
    (entry) =>
      !unpinned.has(entry.key) ||
      (entry.kind === TrayEntryKind.Extension &&
        opened?.id === entry.extension.id),
  );
  const shown = entries.map(({ key }) => key);

  // The key of the icon being dragged while the button is down.
  const [dragged, setDragged] = useState<string | undefined>(undefined);
  // Whether this press moved an icon, which suppresses its click. A ref because
  // the click fires in the same turn as the release and nothing renders from
  // it.
  const moved = useRef(false);

  // Ends wherever the button is released, on the bar or not.
  useEffect(() => {
    if (dragged === undefined) {
      return undefined;
    } else {
      const end = () => {
        setDragged(undefined);
      };
      globalThis.addEventListener("pointerup", end);
      globalThis.addEventListener("pointercancel", end);
      return () => {
        globalThis.removeEventListener("pointerup", end);
        globalThis.removeEventListener("pointercancel", end);
      };
    }
  }, [dragged]);

  return (
    <div
      className={trayStyles}
      onClickCapture={(event) => {
        if (moved.current) {
          event.stopPropagation();
        }
      }}
      // Any press starts afresh, the menu's button's too, so a drag
      // suppresses only its own release's click.
      onPointerDownCapture={() => {
        moved.current = false;
      }}
    >
      {entries.map((entry) => (
        <div
          className={entryStyles}
          key={entry.key}
          onPointerDown={(event) => {
            if (event.button === PRIMARY_BUTTON) {
              setDragged(entry.key);
            }
          }}
          onPointerOver={() => {
            if (dragged !== undefined && dragged !== entry.key) {
              moved.current = true;
              onMove(shown, dragged, entry.key);
            }
          }}
        >
          <Entry
            domicile={domicile}
            entry={entry}
            onActivate={onActivate}
            onOpen={onOpen}
            opened={opened}
          />
        </div>
      ))}
      {end !== undefined && (
        <div
          className={entryStyles}
          onPointerOver={() => {
            if (dragged !== undefined) {
              moved.current = true;
            }
          }}
          onPointerUp={() => {
            if (dragged !== undefined) {
              onUnpin(dragged);
            }
          }}
        >
          {end}
        </div>
      )}
    </div>
  );
};

type EntryProps = Pick<
  Props,
  "domicile" | "onActivate" | "onOpen" | "opened"
> & {
  entry: TrayEntry;
};

/** One icon, rendered by kind. */
const Entry = ({ domicile, entry, onActivate, onOpen, opened }: EntryProps) => {
  switch (entry.kind) {
    case TrayEntryKind.Extension: {
      return (
        <ExtensionAction
          domicile={domicile}
          extension={entry.extension}
          onActivate={() => {
            onActivate(entry.extension.id);
          }}
          onOpen={onOpen}
          opened={opened}
        />
      );
    }
    case TrayEntryKind.StatusNotifier: {
      return <TrayIcon domicile={domicile} item={entry.item} />;
    }
  }
};

const trayStyles = hstack({ gap: 0.5 });

// A box the icon's size, so the row layout does not change.
const entryStyles = css({ display: "flex" });
