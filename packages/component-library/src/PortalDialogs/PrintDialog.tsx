import type {
  PageRange,
  PortalAnswer,
  PrintBody,
  Printer,
  PrintOptions,
} from "@domicile-desktop/sdk/portal";
import {
  PortalAnswer as Answer,
  ColorMode,
  Orientation,
  PrintQuality,
  Sides,
} from "@domicile-desktop/sdk/portal";
import { FilePdfIcon } from "@phosphor-icons/react/dist/ssr/FilePdf";
import { PrinterIcon } from "@phosphor-icons/react/dist/ssr/Printer";
import { useState } from "react";
import { css } from "../../styled-system/css";
import { grid } from "../../styled-system/patterns";
import { Button } from "../Button/Button";
import { Field } from "../Field/Field";
import { ChooserMode } from "../FilePicker/file-request";
import type { Folders } from "../FilePicker/folders";
import { Input } from "../Input/Input";
import { ModalDialog } from "../ModalDialog/ModalDialog";
import { Select } from "../Select/Select";
import { ModalFilePicker } from "./ModalFilePicker";
import { pageRanges } from "./page-ranges";
import { usePicking } from "./picking";
import type { Presence } from "./presence";

const SIDES = {
  [Sides.OneSided]: "Off",
  [Sides.TwoSidedLongEdge]: "Long edge",
  [Sides.TwoSidedShortEdge]: "Short edge",
} as const;

const COLOR_MODES = {
  [ColorMode.Color]: "Color",
  [ColorMode.Monochrome]: "Black and white",
} as const;

const ORIENTATIONS = {
  [Orientation.Portrait]: "Portrait",
  [Orientation.Landscape]: "Landscape",
  [Orientation.ReverseLandscape]: "Landscape, upside down",
  [Orientation.ReversePortrait]: "Portrait, upside down",
} as const;

const QUALITIES = {
  [PrintQuality.Draft]: "Draft",
  [PrintQuality.Normal]: "Normal",
  [PrintQuality.High]: "High",
} as const;

/** Whether to print every page or the ones typed. */
enum PageChoice {
  All,
  Custom,
}

const PAGE_CHOICES = [
  { label: "All", value: PageChoice.All },
  { label: "Custom", value: PageChoice.Custom },
] as const;

type Props = {
  answer: (answer: PortalAnswer) => void;
  /** Who asks, as the dialog names them. */
  asker: string;
  body: PrintBody;
  /** The folders the PDF's file picker browses. */
  folders: Folders;
  /** Whether it is up; see {@link Presence}. */
  presence: Presence;
  screen: string | undefined;
};

/**
 * A print dialog: a printer or Save to PDF, and the options each supports.
 * Saving to a PDF picks its file after. Dismissing it cancels. No preview:
 * the document arrives only after it closes.
 */
export const PrintDialog = ({
  answer,
  asker,
  body,
  folders,
  presence,
  screen,
}: Props) => {
  const [chosen, setChosen] = useState(() => startingChoice(body));
  const { dialog, picker, setPicking } = usePicking(presence);
  const options = readOptions(chosen);
  const pdf = chosen.printer === body.pdf;
  return (
    <>
      {picker !== undefined && options !== undefined && (
        <PdfPicker
          answer={answer}
          back={() => {
            setPicking(false);
          }}
          body={body}
          folders={folders}
          options={options}
          presence={picker}
          screen={screen}
        />
      )}
      <ModalDialog
        closeButton={false}
        footer={
          <>
            <Button
              onClick={() => {
                answer(Answer.Canceled());
              }}
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              disabled={options === undefined}
              onClick={() => {
                if (options !== undefined) {
                  if (pdf) {
                    setPicking(true);
                  } else {
                    answer(Answer.Print(chosen.printer.name, options));
                  }
                }
              }}
              variant="accent"
            >
              {pdf ? "Save…" : (body.acceptLabel ?? "Print")}
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
        title="Print"
      >
        <p className={askerStyles}>{`${asker} prints “${body.title}”`}</p>
        <div className={formStyles}>
          <div className={wideStyles}>
            <Field
              hint={
                body.printers.length === 0
                  ? "No printers are set up."
                  : undefined
              }
              label="Destination"
            >
              <Select
                onValueChange={(picked) => {
                  if (picked !== null) {
                    setChosen(startOf(picked));
                  }
                }}
                options={[...body.printers, body.pdf].map((listed) => ({
                  label: (
                    <span className={destinationStyles}>
                      <DestinationIcon pdf={listed === body.pdf} />
                      {nameOf(listed)}
                    </span>
                  ),
                  textLabel: nameOf(listed),
                  value: listed,
                }))}
                prefixIcon={<DestinationIcon pdf={pdf} />}
                value={chosen.printer}
              />
            </Field>
          </div>
          <Options chosen={chosen} onChange={setChosen} />
        </div>
      </ModalDialog>
    </>
  );
};

const DestinationIcon = ({ pdf }: { pdf: boolean }) =>
  pdf ? <FilePdfIcon /> : <PrinterIcon />;

/** A printer and the options as the user has set them so far. */
type Chosen = {
  /** As typed. */
  copies: string;
  pageChoice: PageChoice;
  /** As typed. */
  pages: string;
  options: PrintOptions;
  printer: Printer;
};

/** The options `chosen.printer` supports, each in a labeled field. */
const Options = ({
  chosen,
  onChange,
}: {
  chosen: Chosen;
  onChange: (chosen: Chosen) => void;
}) => {
  const { options, printer } = chosen;
  const set = (changed: Partial<PrintOptions>) => {
    onChange({ ...chosen, options: { ...options, ...changed } });
  };
  const custom = chosen.pageChoice === PageChoice.Custom;
  return (
    <>
      {printer.pageRanges && (
        <div className={pagesStyles}>
          <Field label="Pages">
            <Select
              onValueChange={(pageChoice) => {
                if (pageChoice !== null) {
                  onChange({ ...chosen, pageChoice });
                }
              }}
              options={PAGE_CHOICES}
              value={chosen.pageChoice}
            />
          </Field>
          {custom && (
            <Field
              invalid={chosen.pages !== "" && pagesOf(chosen) === undefined}
            >
              <Input
                aria-label="Page range"
                autoFocus
                onChange={(event) => {
                  onChange({ ...chosen, pages: event.target.value });
                }}
                placeholder="e.g. 1-3, 5"
                value={chosen.pages}
              />
            </Field>
          )}
        </div>
      )}
      {printer.copiesMax > 1 && (
        <Field label="Copies">
          <Input
            max={printer.copiesMax}
            min={1}
            onChange={(event) => {
              onChange({ ...chosen, copies: event.target.value });
            }}
            type="number"
            value={chosen.copies}
          />
        </Field>
      )}
      {printer.media.length > 0 && (
        <Field label="Paper">
          <Select
            onValueChange={(media) => {
              set({ media: media ?? undefined });
            }}
            options={printer.media.map((media) => ({
              label: media.label,
              value: media.name,
            }))}
            placeholder="Default"
            value={options.media ?? null}
          />
        </Field>
      )}
      <Choice
        label="Layout"
        labels={ORIENTATIONS}
        offered={printer.orientations}
        onChange={(orientation) => {
          set({ orientation });
        }}
        value={options.orientation}
      />
      <Choice
        label="Two-sided"
        labels={SIDES}
        offered={printer.sides}
        onChange={(sides) => {
          set({ sides });
        }}
        value={options.sides}
      />
      <Choice
        label="Color"
        labels={COLOR_MODES}
        offered={printer.colorModes}
        onChange={(colorMode) => {
          set({ colorMode });
        }}
        value={options.colorMode}
      />
      <Choice
        label="Quality"
        labels={QUALITIES}
        offered={printer.qualities}
        onChange={(quality) => {
          set({ quality });
        }}
        value={options.quality}
      />
    </>
  );
};

/** A labeled select of the values a printer offers; none if it offers none. */
const Choice = <V extends number>({
  label,
  labels,
  offered,
  onChange,
  value,
}: {
  label: string;
  labels: Readonly<Record<V, string>>;
  offered: readonly V[];
  onChange: (value: V | undefined) => void;
  value: V | undefined;
}) =>
  offered.length > 0 && (
    <Field label={label}>
      <Select
        onValueChange={(picked) => {
          onChange(picked ?? undefined);
        }}
        options={offered.map((offer) => ({
          label: labels[offer],
          value: offer,
        }))}
        placeholder="Default"
        value={value ?? null}
      />
    </Field>
  );

/**
 * The file picker for a PDF, over `screen`, starting in the home with the
 * document's title as its name. Canceling goes back to the options.
 */
const PdfPicker = ({
  answer,
  back,
  body,
  folders,
  options,
  presence,
  screen,
}: {
  answer: (answer: PortalAnswer) => void;
  back: () => void;
  body: PrintBody;
  folders: Folders;
  options: PrintOptions;
  presence: Presence;
  screen: string | undefined;
}) => (
  <ModalFilePicker
    presence={presence}
    request={{
      accept: ["pdf"],
      acceptLabel: "Save",
      cancel: back,
      choose: ([path]) => {
        if (path === undefined) {
          throw new Error("a save chose no file");
        } else {
          answer(Answer.SaveToPdf(path, options));
        }
      },
      folders,
      home: body.home,
      mode: ChooserMode.Save,
      suggestedName: pdfName(body.title),
      title: "Save as PDF",
    }}
    screen={screen}
  />
);

const askerStyles = css({ color: "muted", fontSize: "sm", margin: 0 });

const formStyles = grid({
  columnGap: 3,
  columns: 2,
  marginBlockStart: 4,
  rowGap: 4,
});

const wideStyles = css({ gridColumn: "1 / -1" });

const destinationStyles = css({
  alignItems: "center",
  display: "inline-flex",
  gap: 2,
});

const pagesStyles = grid({
  alignItems: "end",
  columnGap: 3,
  columns: 2,
  gridColumn: "1 / -1",
});

/** `printer` for people. */
const nameOf = (printer: Printer): string =>
  printer.description ?? printer.name;

/** Where the dialog starts: the application's printer, else the first, else a PDF. */
const startingChoice = (body: PrintBody): Chosen =>
  startOf(
    body.printers.find((listed) => listed.name === body.printer) ??
      body.printers[0] ??
      body.pdf,
  );

/** `printer` with its initial options. */
const startOf = (printer: Printer): Chosen => ({
  copies: String(printer.initial.copies),
  options: printer.initial,
  pageChoice:
    printer.initial.pages.length === 0 ? PageChoice.All : PageChoice.Custom,
  pages: printer.initial.pages
    .map(({ first, last }) =>
      first === last ? `${first}` : `${first}-${last}`,
    )
    .join(", "),
  printer,
});

/** The pages chosen, or `undefined` while custom pages name none it reads. */
const pagesOf = (chosen: Chosen): readonly PageRange[] | undefined => {
  switch (chosen.pageChoice) {
    case PageChoice.All:
      return [];
    case PageChoice.Custom:
      return chosen.pages.trim() === "" ? undefined : pageRanges(chosen.pages);
  }
};

/** The options to print with, or `undefined` while copies or pages do not read. */
const readOptions = (chosen: Chosen): PrintOptions | undefined => {
  const copies = Number(chosen.copies);
  const pages = pagesOf(chosen);
  const copiesRead =
    Number.isInteger(copies) &&
    copies >= 1 &&
    copies <= chosen.printer.copiesMax;
  return copiesRead && pages !== undefined
    ? { ...chosen.options, copies, pages }
    : undefined;
};

/** A file name for a PDF of `title`: no slashes, and `Document` when blank. */
const pdfName = (title: string): string =>
  `${title.trim() === "" ? "Document" : title.replaceAll("/", "-")}.pdf`;
