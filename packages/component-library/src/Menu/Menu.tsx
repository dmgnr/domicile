import { Menu as BaseMenu } from "@base-ui/react/menu";
import type { ReactElement, ReactNode } from "react";
import { useRef } from "react";
import { ContextMenu } from "../ContextMenu/ContextMenu";
import { popupStyles, positionerStyles } from "../ContextMenu/menu-popup";
import type { ExtendProps } from "../extend-props";
import { usePopupBoundary } from "../PopupBoundary/PopupBoundary";
import { useClosedWithScene } from "../PopupScene/PopupScene";
import "../stylesheet";

type Props = ExtendProps<
  typeof BaseMenu.Root,
  {
    children: ReactNode;
    /** The button that opens it, such as a `Button`. */
    trigger: ReactElement;
  }
>;

/**
 * A menu opened from a button, under its end, and named by it. Its items are
 * `ContextMenu`'s. It stays inside its `PopupBoundary`, such as its window,
 * and closes when its `PopupScene` changes.
 */
const MenuComponent = ({ children, trigger, ...rootProps }: Props) => {
  const { boundary } = usePopupBoundary(false);
  const ownActions = useRef<BaseMenu.Root.Actions | null>(null);
  const actions = rootProps.actionsRef ?? ownActions;
  const heard = useClosedWithScene(actions, rootProps);
  return (
    <BaseMenu.Root {...rootProps} actionsRef={actions} onOpenChange={heard}>
      <BaseMenu.Trigger render={trigger} />
      <BaseMenu.Portal>
        <BaseMenu.Positioner
          align="end"
          className={positionerStyles}
          collisionBoundary={boundary}
          sideOffset={4}
        >
          <BaseMenu.Popup className={popupStyles}>{children}</BaseMenu.Popup>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.Root>
  );
};

export const Menu = Object.assign(MenuComponent, {
  CheckboxItem: ContextMenu.CheckboxItem,
  Item: ContextMenu.Item,
  RadioGroup: ContextMenu.RadioGroup,
  RadioItem: ContextMenu.RadioItem,
  Separator: ContextMenu.Separator,
  Submenu: ContextMenu.Submenu,
});
