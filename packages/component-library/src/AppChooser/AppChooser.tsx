import type { AppsDesktop } from "@domicile-desktop/system-apps/apps-desktop";
import type { DescribedApp } from "@domicile-desktop/system-apps/describe-apps";
import { AppWindowIcon } from "@phosphor-icons/react/dist/ssr/AppWindow";
import { useId, useState } from "react";
import { css } from "../../styled-system/css";
import { flex, hstack } from "../../styled-system/patterns";
import { Button } from "../Button/Button";
import { keepInView, pageOf, stepOf, steppedTo } from "../list-walk";
import { ModalDialog } from "../ModalDialog/ModalDialog";
import { LogoTile, RowTile } from "../ResultList/RowTile";
import { preselected } from "./app-choices";
import { useDescribedChoices } from "./useDescribedChoices";
import "../stylesheet";

/** The one application's icon, beside the title. */
const TITLE_ICON_SIZE = 32;

type Props = {
  /** The URI opened, shown on one line at the bottom. */
  address?: string | undefined;
  /**
   * Who wants it opened, such as "Chromium". `undefined` when the user asked
   * to choose, which always lists the applications.
   */
  asker?: string | undefined;
  /** Desktop file IDs without `.desktop`, in the order offered. */
  choices: readonly string[];
  /** The type opened, whose defaults start picked; none when `undefined`. */
  contentType: string | undefined;
  /** The application chosen last time, which starts picked. */
  lastChoice?: string | undefined;
  onCancel: () => void;
  /** Called with the ID of the application to open with. */
  onChoose: (id: string) => void;
  /** Called once it has animated in or out; see `open`. */
  onOpenChangeComplete?: ((open: boolean) => void) | undefined;
  /** Whether it is up. Turned off, it animates out. */
  open?: boolean | undefined;
  /** What is opened, as a phrase: "this link", "report.pdf". */
  opened: string;
  screen: string | undefined;
  /** Where the applications' desktop entries are read. */
  domicile: AppsDesktop;
};

/**
 * Pick an application to open a file or URI with. With one application and an
 * asker, it asks whether to open that one, as a browser's "Open Zoom?" does.
 * The last choice, else the type's default, else the first offered, starts
 * picked. Dismissing it cancels.
 */
export const AppChooser = ({
  address,
  asker,
  choices,
  contentType,
  lastChoice,
  onCancel,
  onChoose,
  onOpenChangeComplete,
  open = true,
  opened,
  screen,
  domicile,
}: Props) => {
  const listId = useId();
  const described = useDescribedChoices(domicile, choices, contentType);
  const [picked, setPicked] = useState<string | undefined>();
  const apps = described?.apps ?? [];
  const first =
    described === undefined
      ? undefined
      : preselected(choices, lastChoice, described.defaults);
  // A pick the caller has since taken away no longer counts.
  const chosen =
    picked !== undefined && choices.includes(picked) ? picked : first;
  const at = apps.findIndex(({ id }) => id === chosen);
  const offer = offerOf(described === undefined, apps, asker);
  const { text, title } = wording(offer, opened);
  const choose = (id: string | undefined) => {
    if (id !== undefined) {
      onChoose(id);
    }
  };
  return (
    <ModalDialog
      closeButton={false}
      footer={
        <>
          {asker !== undefined && (
            <p className={askerStyles}>{`${asker} asks`}</p>
          )}
          {offer.kind === "none" ? (
            // The only button, so it reads as the answer rather than a way out.
            <Button onClick={onCancel}>Close</Button>
          ) : (
            <>
              <Button onClick={onCancel} variant="outline">
                Cancel
              </Button>
              <Button
                disabled={chosen === undefined}
                onClick={() => {
                  choose(chosen);
                }}
                variant="accent"
              >
                {offer.kind === "one" ? `Open ${offer.app.name}` : "Open"}
              </Button>
            </>
          )}
        </>
      }
      onOpenChange={(opening) => {
        if (!opening) {
          onCancel();
        }
      }}
      onOpenChangeComplete={onOpenChangeComplete}
      open={open}
      screen={screen}
      title={
        offer.kind === "one" ? (
          <span className={titleStyles}>
            <TitleIcon app={offer.app} />
            {title}
          </span>
        ) : (
          title
        )
      }
    >
      {text !== undefined && <p className={textStyles}>{text}</p>}
      {offer.kind === "several" && (
        <div
          aria-activedescendant={at === -1 ? undefined : optionId(listId, at)}
          aria-label="Applications"
          className={listStyles}
          onKeyDown={(event) => {
            // The listbox is its own scroller.
            const step = stepOf(event, pageOf(event.currentTarget));
            const next = apps[steppedTo(at, step ?? 0, apps.length)];
            if (event.key === "Enter") {
              event.preventDefault();
              choose(chosen);
            } else if (step !== undefined && next !== undefined) {
              event.preventDefault();
              setPicked(next.id);
            }
          }}
          role="listbox"
          tabIndex={0}
        >
          {apps.map((app, index) => (
            // biome-ignore lint/a11y/useKeyWithClickEvents: the listbox handles the keyboard via `aria-activedescendant`
            <div
              aria-selected={app.id === chosen}
              className={optionStyles}
              data-highlighted={app.id === chosen ? "" : undefined}
              id={optionId(listId, index)}
              key={app.id}
              onClick={() => {
                setPicked(app.id);
              }}
              onDoubleClick={() => {
                choose(app.id);
              }}
              ref={app.id === chosen ? keepInView : undefined}
              role="option"
              tabIndex={-1}
            >
              <AppTile app={app} />
              <span className={nameStyles}>{app.name}</span>
            </div>
          ))}
        </div>
      )}
      {address !== undefined && <p className={addressStyles}>{address}</p>}
    </ModalDialog>
  );
};

/** `app`'s icon beside the title, else a generic window. */
const TitleIcon = ({ app }: { app: DescribedApp }) =>
  app.icon === undefined ? (
    <AppWindowIcon size={TITLE_ICON_SIZE} />
  ) : (
    <img
      alt=""
      className={iconStyles}
      height={TITLE_ICON_SIZE}
      src={app.icon}
      width={TITLE_ICON_SIZE}
    />
  );

/** `app`'s icon at the start of its row, as in the launcher. */
const AppTile = ({ app }: { app: DescribedApp }) =>
  app.icon === undefined ? (
    <RowTile icon={AppWindowIcon} />
  ) : (
    <LogoTile picture={app.icon} />
  );

/** How many applications the dialog offers, and how it asks. */
type Offer =
  | { kind: "none" }
  | { kind: "one"; app: DescribedApp }
  | { kind: "several" };

/**
 * `none` once read and empty; `one` when someone asks and one application
 * can open it; else `several`, which lists them.
 */
const offerOf = (
  reading: boolean,
  apps: readonly DescribedApp[],
  asker: string | undefined,
): Offer => {
  const [only] = apps;
  if (!reading && only === undefined) {
    return { kind: "none" };
  } else {
    return asker !== undefined && only !== undefined && apps.length === 1
      ? { app: only, kind: "one" }
      : { kind: "several" };
  }
};

/**
 * The title, and the line under it, for `offer`. Who asks is in the footer,
 * as in the other dialogs.
 */
const wording = (
  offer: Offer,
  opened: string,
): { text: string | undefined; title: string } => {
  switch (offer.kind) {
    case "none": {
      return {
        text: "No app on this computer can open it.",
        title: `No app can open ${opened}`,
      };
    }
    case "one": {
      return {
        text: `Opens ${opened} in ${offer.app.name}.`,
        title: `Open ${offer.app.name}?`,
      };
    }
    case "several": {
      return {
        text: undefined,
        title: `Choose an app to open ${opened}`,
      };
    }
  }
};

const titleStyles = hstack({ gap: 3 });

const textStyles = css({ color: "muted", margin: 0 });

// Who asks sits opposite the buttons, as in the access dialog.
const askerStyles = css({
  color: "muted",
  fontSize: "ui",
  margin: 0,
  marginInlineEnd: "auto",
});

// A URI can be hundreds of characters with no spaces, such as a sign-in link.
const addressStyles = css({
  color: "muted",
  fontFamily: "mono",
  fontSize: "xs",
  marginBlockEnd: 0,
  marginBlockStart: 3,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
});

// The picked row's wash shows where the keyboard is, as in the launcher and
// the file picker, so the list draws no focus ring of its own.
const listStyles = flex({
  _focusVisible: { outline: "none" },
  // Under the line of text, when there is one.
  "&:not(:first-child)": { marginBlockStart: 3 },
  direction: "column",
  gap: 0.5,
  maxBlockSize: 80,
  overflowY: "auto",
});

// As the launcher's and the file picker's rows: a neutral wash, color kept
// for the main action.
const optionStyles = hstack({
  _hover: {
    backgroundColor: "color-mix(in oklab, {colors.foreground} 5%, transparent)",
  },
  "&[data-highlighted]": {
    backgroundColor:
      "color-mix(in oklab, {colors.foreground} 10%, transparent)",
  },
  borderRadius: "md",
  color: "foreground",
  cursor: "pointer",
  gap: 3,
  paddingBlock: 1.5,
  paddingInline: 2,
  transition: "background-color {durations.fast} {easings.out}",
  userSelect: "none",
});

const iconStyles = css({ flexShrink: 0, objectFit: "contain" });

// As the launcher's rows.
const nameStyles = css({
  fontSize: "md",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
});

const optionId = (listId: string, index: number): string =>
  `${listId}-${String(index)}`;
