import { CodeIcon } from "@phosphor-icons/react/dist/ssr/Code";
import { CookieIcon } from "@phosphor-icons/react/dist/ssr/Cookie";
import { GearSixIcon } from "@phosphor-icons/react/dist/ssr/GearSix";
import { HandPalmIcon } from "@phosphor-icons/react/dist/ssr/HandPalm";
import { KeyboardIcon } from "@phosphor-icons/react/dist/ssr/Keyboard";
import { LifebuoyIcon } from "@phosphor-icons/react/dist/ssr/Lifebuoy";
import { LockIcon } from "@phosphor-icons/react/dist/ssr/Lock";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/ssr/MagnifyingGlass";
import { MonitorIcon } from "@phosphor-icons/react/dist/ssr/Monitor";
import { PaletteIcon } from "@phosphor-icons/react/dist/ssr/Palette";
import { PuzzlePieceIcon } from "@phosphor-icons/react/dist/ssr/PuzzlePiece";
import { RobotIcon } from "@phosphor-icons/react/dist/ssr/Robot";
import { RocketLaunchIcon } from "@phosphor-icons/react/dist/ssr/RocketLaunch";
import { ShieldCheckIcon } from "@phosphor-icons/react/dist/ssr/ShieldCheck";
import { SlidersHorizontalIcon } from "@phosphor-icons/react/dist/ssr/SlidersHorizontal";
import { UserCircleIcon } from "@phosphor-icons/react/dist/ssr/UserCircle";

import { css } from "../styled-system/css";
import { flex, hstack } from "../styled-system/patterns";
import { PAGES, PageId } from "./pages";

type Props = {
  page: PageId;
  onPage: (page: PageId) => void;
};

/** The list of pages. */
export const Sidebar = ({ onPage, page }: Props) => (
  <nav aria-label="Settings" className={sidebarStyles}>
    <div className={brandStyles}>
      <span className={brandIconStyles}>
        <GearSixIcon size={18} weight="bold" />
      </span>
      Settings
    </div>
    <ul className={listStyles}>
      {PAGES.map(({ id, title }) => (
        <li key={id}>
          <button
            aria-current={id === page ? "page" : undefined}
            className={itemStyles}
            onClick={() => {
              onPage(id);
            }}
            type="button"
          >
            <PageIcon page={id} />
            {title}
          </button>
        </li>
      ))}
    </ul>
  </nav>
);

const PageIcon = ({ page }: { page: PageId }) => {
  switch (page) {
    case PageId.Appearance:
      return <PaletteIcon size={18} />;
    case PageId.Keyboard:
      return <KeyboardIcon size={18} />;
    case PageId.Displays:
      return <MonitorIcon size={18} />;
    case PageId.Power:
      return <LockIcon size={18} />;
    case PageId.Privacy:
      return <ShieldCheckIcon size={18} />;
    case PageId.Launcher:
      return <MagnifyingGlassIcon size={18} />;
    case PageId.Startup:
      return <RocketLaunchIcon size={18} />;
    case PageId.Shell:
      return <SlidersHorizontalIcon size={18} />;
    case PageId.Extensions:
      return <PuzzlePieceIcon size={18} />;
    case PageId.Profiles:
      return <UserCircleIcon size={18} />;
    case PageId.Agents:
      return <RobotIcon size={18} />;
    case PageId.Permissions:
      return <HandPalmIcon size={18} />;
    case PageId.SiteData:
      return <CookieIcon size={18} />;
    case PageId.Code:
      return <CodeIcon size={18} />;
    case PageId.Troubleshooting:
      return <LifebuoyIcon size={18} />;
  }
};

const sidebarStyles = flex({
  backgroundColor: "color-mix(in oklab, {colors.card} 60%, transparent)",
  borderInlineEnd: "1px solid {colors.border}",
  direction: "column",
  gap: 4,
  overflowY: "auto",
  paddingBlock: 5,
  paddingInline: 3,
});

const brandStyles = hstack({
  color: "foreground",
  fontSize: "md",
  fontWeight: "semibold",
  gap: 2.5,
  paddingInline: 2,
});

const brandIconStyles = css({
  alignItems: "center",
  backgroundImage:
    "linear-gradient(135deg, color-mix(in oklab, {colors.accent} 70%, {colors.foreground}), {colors.accent})",
  blockSize: 8,
  borderRadius: "lg",
  color: "background",
  display: "inline-flex",
  inlineSize: 8,
  justifyContent: "center",
});

const listStyles = flex({
  direction: "column",
  gap: 0.5,
  listStyle: "none",
  margin: 0,
  padding: 0,
});

const itemStyles = hstack({
  "&[aria-current=page]": {
    backgroundColor: "color-mix(in oklab, {colors.accent} 16%, transparent)",
    color: "foreground",
    fontWeight: "medium",
  },
  "&[aria-current=page] svg": { color: "accent" },
  backgroundColor: {
    _hover: "color-mix(in oklab, {colors.foreground} 6%, transparent)",
    base: "transparent",
  },
  borderRadius: "md",
  borderStyle: "none",
  color: { _hover: "foreground", base: "muted" },
  cursor: "pointer",
  fontFamily: "inherit",
  fontSize: "sm",
  gap: 2.5,
  inlineSize: "100%",
  paddingBlock: 2,
  paddingInline: 2.5,
  textAlign: "start",
  transition:
    "background-color {durations.fast} {easings.out}, color {durations.fast} {easings.out}",
});
