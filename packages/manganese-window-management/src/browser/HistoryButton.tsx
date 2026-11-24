import { Button } from "@domicile-desktop/component-library/Button";
import type { Point } from "@domicile-desktop/component-library/ContextMenu";
import { ContextMenu } from "@domicile-desktop/component-library/ContextMenu";
import { newTabClick } from "@domicile-desktop/component-library/new-tab-click";
import { ClockCounterClockwiseIcon } from "@phosphor-icons/react/dist/ssr/ClockCounterClockwise";
import { GlobeSimpleIcon } from "@phosphor-icons/react/dist/ssr/GlobeSimple";
import type { MouseEvent, ReactElement } from "react";
import { useState } from "react";
import { css } from "../../styled-system/css";
import type { PageHistoryChoice, PageHistoryEntry } from "./page-history";
import { useLongPress } from "./useLongPress";

/** How many pages a menu lists, as Chrome's. */
const MENU_LENGTH = 12;

type Props = {
  /** The arrow. */
  children: ReactElement;
  disabled: boolean;
  /** The history, or nothing from an engine without history entries. */
  history: PageHistoryChoice | undefined;
  label: "Back" | "Forward";
  /** Takes one step, for a click. */
  onStep: () => void;
  /** Takes one step in a new window, for a middle click or a Ctrl+click. */
  onStepInNewWindow: () => void;
  /** Opens the History app. */
  onShowAllHistory: () => void;
};

/**
 * Back or Forward: a click takes one step, and a long press or a right click
 * lists the pages that way to jump to, as Chrome's buttons do.
 */
export const HistoryButton = ({
  children,
  disabled,
  history,
  label,
  onShowAllHistory,
  onStep,
  onStepInNewWindow,
}: Props) => {
  const [menu, setMenu] = useState<Menu | undefined>(undefined);
  const [button, setButton] = useState<HTMLElement | undefined>(undefined);

  /** Opens the menu, answering whether it will open. */
  const openMenu = (): boolean => {
    if (disabled || history === undefined || button === undefined) {
      return false;
    } else {
      // Under the button, as Chrome's, wherever the pointer is.
      const box = button.getBoundingClientRect();
      const at = { x: box.left, y: box.bottom };
      history
        .list()
        .then((listed) => {
          setMenu({
            at,
            pages: (label === "Back" ? listed.back : listed.forward).slice(
              0,
              MENU_LENGTH,
            ),
          });
        })
        .catch((error: unknown) => {
          // biome-ignore lint/suspicious/noConsole: the menu stays shut; the button still steps
          console.error(`Couldn't list the ${label} history`, error);
        });
      return true;
    }
  };

  const step = newTabClick(onStep, onStepInNewWindow);
  const press = useLongPress(openMenu, step.onClick);

  return (
    <>
      <Button
        disabled={disabled}
        label={label}
        onAuxClick={step.onAuxClick}
        onContextMenu={(event: MouseEvent) => {
          event.preventDefault();
          openMenu();
        }}
        // React passes `null` on unmount.
        ref={(element: HTMLButtonElement | null) => {
          setButton(element ?? undefined);
        }}
        rounded
        size="sm"
        variant="ghost"
        {...press}
      >
        {children}
      </Button>
      {menu !== undefined && history !== undefined && (
        <ContextMenu
          at={menu.at}
          label={`${label} history`}
          onOpenChange={(open) => {
            if (!open) {
              setMenu(undefined);
            }
          }}
          open
        >
          {menu.pages.map((page) => (
            <ContextMenu.Item
              icon={<PageIcon page={page} />}
              key={page.id}
              {...newTabClick(
                () => {
                  history.go(page.id);
                },
                () => {
                  setMenu(undefined);
                  history.goInNewWindow(page.id);
                },
              )}
            >
              {page.title}
            </ContextMenu.Item>
          ))}
          <ContextMenu.Separator />
          <ContextMenu.Item
            icon={<ClockCounterClockwiseIcon />}
            onClick={onShowAllHistory}
          >
            Show full history
          </ContextMenu.Item>
        </ContextMenu>
      )}
    </>
  );
};

/** An open menu: where, and the pages it lists. */
type Menu = { at: Point; pages: readonly PageHistoryEntry[] };

/** A page's favicon, or a globe for a page with none, as the tabs draw. */
const PageIcon = ({ page }: { page: PageHistoryEntry }) =>
  page.favicon === "" ? (
    <GlobeSimpleIcon />
  ) : (
    <img alt="" className={faviconStyles} src={page.favicon} />
  );

const faviconStyles = css({ objectFit: "contain" });
