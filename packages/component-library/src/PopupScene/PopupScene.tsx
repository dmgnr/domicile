import type { ReactNode, RefObject } from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import "../stylesheet";

type Props = {
  children: ReactNode;
  /** What the popups inside are drawn over, as a key. Any change closes them. */
  scene: string;
};

/**
 * Closes every popup opened inside whenever `scene` changes: popovers, menus,
 * tooltips and lists. A shell keys it on whatever moves or covers what popups
 * point at, such as an overview opening or a window going fullscreen, so no
 * popup is left over the wrong thing.
 *
 * Scenes nest: a popup closes when its own scene or any outer one changes.
 * `PopupBoundary` is one, keyed on its box.
 */
export const PopupScene = ({ children, scene }: Props) => {
  const outer = useContext(Scene);
  return <Scene value={JSON.stringify([outer, scene])}>{children}</Scene>;
};

/** The scenes around a popup, outermost first, as one key. */
const Scene = createContext("");

/** A popup root's imperative close, from its `actionsRef`. */
type Closer = { close: () => void };

/** Whether a popup root is open, as its props say. */
type Openness<Details> = {
  defaultOpen?: boolean | undefined;
  onOpenChange?: ((open: boolean, details: Details) => void) | undefined;
  /** Set for a controlled popup. */
  open?: boolean | undefined;
};

/**
 * Closes a popup when the scene around it changes while it is open. See
 * {@link PopupScene}.
 *
 * Returns the `onOpenChange` to give its root, which hears whether an
 * uncontrolled popup is open. A closed one is left alone, so its owner hears
 * no close it did not ask for.
 */
export const useClosedWithScene = <Details,>(
  actions: RefObject<Closer | null>,
  { defaultOpen = false, onOpenChange, open }: Openness<Details>,
): ((open: boolean, details: Details) => void) => {
  const scene = useContext(Scene);
  const [heard, setHeard] = useState(defaultOpen);
  const shown = open ?? heard;
  const drawnIn = useRef(scene);
  useEffect(() => {
    if (drawnIn.current !== scene) {
      drawnIn.current = scene;
      if (shown) {
        closeWith(actions);
      }
    }
  }, [actions, scene, shown]);
  return useCallback(
    (next: boolean, details: Details) => {
      setHeard(next);
      onOpenChange?.(next, details);
    },
    [onOpenChange],
  );
};

/** Closes the popup whose root holds `actions`, which is mounted with it. */
const closeWith = (actions: RefObject<Closer | null>) => {
  if (actions.current === null) {
    throw new Error("PopupScene: an open popup has no actions to close it");
  } else {
    actions.current.close();
  }
};
