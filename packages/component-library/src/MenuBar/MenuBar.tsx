import { Menu as BaseMenu } from "@base-ui/react/menu";
import { Menubar as BaseMenubar } from "@base-ui/react/menubar";
import type { ReactNode } from "react";
import { useRef } from "react";
import { css } from "../../styled-system/css";
import { ContextMenu, chooseByMnemonic } from "../ContextMenu/ContextMenu";
import { popupStyles, positionerStyles } from "../ContextMenu/menu-popup";
import type { ExtendProps } from "../extend-props";
import { usePopupBoundary } from "../PopupBoundary/PopupBoundary";
import { useClosedWithScene } from "../PopupScene/PopupScene";
import "../stylesheet";

type Props = ExtendProps<
  typeof BaseMenubar,
  {
    /** Its menus, each a `MenuBar.Menu`. */
    children: ReactNode;
    /** What the bar is called, to assistive technology. */
    label: string;
  }
>;

/**
 * A row of menus across the top of a window (File, Edit, View, ...), as an
 * app's menu bar. Arrow keys move between them, and pointing at another one
 * while one is open opens it instead.
 */
const MenuBarComponent = ({ children, label, ...barProps }: Props) => (
  <BaseMenubar aria-label={label} className={barStyles} {...barProps}>
    {children}
  </BaseMenubar>
);

type MenuProps = ExtendProps<
  typeof BaseMenu.Root,
  {
    /** Its items: `ContextMenu`'s. */
    children: ReactNode;
    disabled?: boolean | undefined;
    /** Its name on the bar. */
    label: string;
    /**
     * Where in `label` the access key is. It is underlined, and Alt with it
     * opens the menu where the caller binds that.
     */
    mnemonic?: number | undefined;
  }
>;

/**
 * One menu on the bar: its name, and the items under it when open. Closes when
 * its `PopupScene` changes.
 */
const Menu = ({
  children,
  disabled,
  label,
  mnemonic,
  ...rootProps
}: MenuProps) => {
  const { boundary } = usePopupBoundary(false);
  const ownActions = useRef<BaseMenu.Root.Actions | null>(null);
  const actions = rootProps.actionsRef ?? ownActions;
  const heard = useClosedWithScene(actions, rootProps);
  return (
    <BaseMenu.Root {...rootProps} actionsRef={actions} onOpenChange={heard}>
      {/* Named outright: the mnemonic's span splits the text for some readers. */}
      <BaseMenu.Trigger
        aria-label={label}
        className={triggerStyles}
        disabled={disabled}
      >
        {mnemonic === undefined ? (
          label
        ) : (
          <>
            {label.slice(0, mnemonic)}
            <span className={mnemonicStyles}>{label.charAt(mnemonic)}</span>
            {label.slice(mnemonic + 1)}
          </>
        )}
      </BaseMenu.Trigger>
      <BaseMenu.Portal>
        <BaseMenu.Positioner
          align="start"
          className={positionerStyles}
          collisionBoundary={boundary}
          sideOffset={2}
        >
          <BaseMenu.Popup
            aria-label={label}
            className={popupStyles}
            onKeyDown={chooseByMnemonic}
          >
            {children}
          </BaseMenu.Popup>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.Root>
  );
};

export const MenuBar = Object.assign(MenuBarComponent, {
  CheckboxItem: ContextMenu.CheckboxItem,
  Item: ContextMenu.Item,
  Menu,
  RadioGroup: ContextMenu.RadioGroup,
  RadioItem: ContextMenu.RadioItem,
  Separator: ContextMenu.Separator,
  Submenu: ContextMenu.Submenu,
});

const barStyles = css({
  alignItems: "center",
  borderBlockEnd: "1px solid {colors.border}",
  display: "flex",
  gap: 0.5,
  paddingBlock: 0.5,
  paddingInline: 1.5,
});

// The highlight is `ContextMenu`'s item's, so the bar and its menus match.
const triggerStyles = css({
  "&:focus-visible, &[data-popup-open], &:hover:not([data-disabled])": {
    backgroundColor: "color-mix(in oklab, {colors.foreground} 8%, transparent)",
  },
  "&[data-disabled]": {
    color: "muted",
    opacity: "disabled",
  },
  backgroundColor: "transparent",
  border: "none",
  borderRadius: "sm",
  color: "foreground",
  cursor: { _disabled: "not-allowed", base: "pointer" },
  fontFamily: "inherit",
  fontSize: "sm",
  outlineStyle: "none",
  paddingBlock: 0.5,
  paddingInline: 2,
  userSelect: "none",
});

const mnemonicStyles = css({ textDecoration: "underline" });
