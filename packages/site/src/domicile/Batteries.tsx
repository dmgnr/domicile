import { ApertureIcon } from "@phosphor-icons/react/dist/ssr/Aperture";
import { AppWindowIcon } from "@phosphor-icons/react/dist/ssr/AppWindow";
import { ClipboardTextIcon } from "@phosphor-icons/react/dist/ssr/ClipboardText";
import { CodeIcon } from "@phosphor-icons/react/dist/ssr/Code";
import { CommandIcon } from "@phosphor-icons/react/dist/ssr/Command";
import { GlobeIcon } from "@phosphor-icons/react/dist/ssr/Globe";
import { HighDefinitionIcon } from "@phosphor-icons/react/dist/ssr/HighDefinition";
import { KeyboardIcon } from "@phosphor-icons/react/dist/ssr/Keyboard";
import { LockKeyIcon } from "@phosphor-icons/react/dist/ssr/LockKey";
import { MonitorIcon } from "@phosphor-icons/react/dist/ssr/Monitor";
import { PrinterIcon } from "@phosphor-icons/react/dist/ssr/Printer";
import { TrayIcon } from "@phosphor-icons/react/dist/ssr/Tray";
import { UserCircleIcon } from "@phosphor-icons/react/dist/ssr/UserCircle";
import { VideoCameraIcon } from "@phosphor-icons/react/dist/ssr/VideoCamera";
import { WifiHighIcon } from "@phosphor-icons/react/dist/ssr/WifiHigh";
import type { ReactNode } from "react";

import { css } from "../../styled-system/css";
import { flex, grid } from "../../styled-system/patterns";
import { IconTile } from "../page/IconTile";
import { Section } from "../page/Section";
import {
  CastPicture,
  ExtensionsPicture,
  NightLightPicture,
  NotificationsPicture,
  SharingPicture,
  ThemePicture,
} from "./BatteryPictures";

const SHOWN: readonly { picture: ReactNode; title: string; body: string }[] = [
  {
    body: "Install extensions from the Chrome Web Store. They work in browser windows, and their buttons can sit in your bar.",
    picture: <ExtensionsPicture />,
    title: "Chrome extensions",
  },
  {
    body: "Native apps and web pages land in the same list, and one button pauses them all.",
    picture: <NotificationsPicture />,
    title: "One place for notifications",
  },
  {
    body: "Share a window, a monitor or a region with video calls and OBS, with its sound. Your shell draws the picker.",
    picture: <SharingPicture />,
    title: "Screen sharing",
  },
  {
    body: "Mirror to Chromecast and Miracast TVs, or use the TV as one more monitor.",
    picture: <CastPicture />,
    title: "Cast to a TV",
  },
  {
    body: "Warm every screen in the evening with one call. Brightness can follow the light sensor, the way a Mac does.",
    picture: <NightLightPicture />,
    title: "Night light and auto brightness",
  },
  {
    body: "GTK, Qt and Chromium apps follow your light or dark theme and your accent color. Websites can go dark too.",
    picture: <ThemePicture />,
    title: "Dark mode everywhere",
  },
];

const LISTED: readonly { icon: ReactNode; title: string; body: string }[] = [
  {
    body: "Capture a window, a monitor or a region, to a file or the clipboard.",
    icon: <ApertureIcon />,
    title: "Screenshots and recording",
  },
  {
    body: "Write real desktop apps with HTML, CSS and JavaScript. They run on the engine Domicile already has, so there is no browser to bundle.",
    icon: <CodeIcon />,
    title: "Apps without Electron",
  },
  {
    body: "List Slack, Element or Claude in the config and they run on the desktop's engine, with menus and dialogs your shell draws.",
    icon: <AppWindowIcon />,
    title: "Electron apps on the engine",
  },
  {
    body: "Install any website as an app, with its own window and icon.",
    icon: <GlobeIcon />,
    title: "Sites as apps",
  },
  {
    body: "Keep work and personal apart. Each profile has its own sign-ins and extensions, and sites open in the profile you give them.",
    icon: <UserCircleIcon />,
    title: "Browser profiles",
  },
  {
    body: "Open and save dialogs, print or save as PDF, open with, remote desktop and the keyring, all in your look.",
    icon: <PrinterIcon />,
    title: "File pickers, printing and more",
  },
  {
    body: "Copied something a while ago? Find it again and paste it, whether it came from an app or a website.",
    icon: <ClipboardTextIcon />,
    title: "Clipboard history",
  },
  {
    body: "Plug into a dock and your monitors snap back to where you left them.",
    icon: <MonitorIcon />,
    title: "Monitor profiles",
  },
  {
    body: "HDR on the monitors that have it, 10-bit panels without banding, and wide-gamut apps in their true colors.",
    icon: <HighDefinitionIcon />,
    title: "HDR and 10-bit color",
  },
  {
    body: "Discord, Slack and other apps that put an icon in the tray show it in yours.",
    icon: <TrayIcon />,
    title: "Tray icons",
  },
  {
    body: "Ready-made packages for the controls every desktop needs. Add the menus, not the plumbing.",
    icon: <WifiHighIcon />,
    title: "Wi-Fi, Bluetooth, sound and battery",
  },
  {
    body: "When a site asks for your camera, microphone or location, your shell asks you, and remembers the answer.",
    icon: <VideoCameraIcon />,
    title: "Website permissions",
  },
  {
    body: "The compositor holds the lock and checks your password, so even a shell that crashes never unlocks the desktop.",
    icon: <LockKeyIcon />,
    title: "A lock screen that stays locked",
  },
  {
    body: "Switch between layouts on the fly, and type in any language with an input method.",
    icon: <KeyboardIcon />,
    title: "Keyboard layouts",
  },
  {
    body: "Push to talk in Discord, or a hotkey for your music app, works even when the app is in the background.",
    icon: <CommandIcon />,
    title: "Global shortcuts",
  },
];

/** Who provides what: Domicile, a ready-made component, or the shell. */
const GROUPS: readonly { title: string; items: readonly string[] }[] = [
  {
    items: [
      "Screen sharing and screenshots",
      "Notifications, tray icons and global shortcuts",
      "Chrome extensions in browser windows",
      "Browser profiles",
      "Electron apps on the engine",
      "Night light, monitor profiles and dark mode for apps",
      "A lock screen that stays locked",
    ],
    title: "Domicile does it",
  },
  {
    items: [
      "Dialogs for file pickers, sharing and printing",
      "Wi-Fi, Bluetooth, sound and battery controls",
      "A launcher, a notification drawer and clipboard history",
    ],
    title: "Ready-made components",
  },
  {
    items: [
      "The bar, the window layout and the look",
      "Which dialogs to show, and how. Draw them, or refuse them.",
    ],
    title: "Your shell draws it",
  },
];

/** What Domicile builds in, what's ready-made, and what a shell draws. */
export const Batteries = () => (
  <Section
    id="batteries"
    lede="Domicile does the hard parts. Your shell decides how they look, or uses a ready-made component."
    title="Batteries included."
  >
    <div className={groupsStyles}>
      {GROUPS.map((group) => (
        <div className={listedCardStyles} key={group.title}>
          <h3 className={listedTitleStyles}>{group.title}</h3>
          <ul className={itemsStyles}>
            {group.items.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      ))}
    </div>
    <details className={moreStyles}>
      <summary className={summaryStyles}>
        Everything Domicile handles for you
      </summary>
      <div className={shownStyles}>
        {SHOWN.map((feature) => (
          <div className={shownCardStyles} key={feature.title}>
            {feature.picture}
            <h3 className={shownTitleStyles}>{feature.title}</h3>
            <p className={bodyStyles}>{feature.body}</p>
          </div>
        ))}
      </div>
      <div className={listedStyles}>
        {LISTED.map((feature) => (
          <div className={listedCardStyles} key={feature.title}>
            <IconTile>{feature.icon}</IconTile>
            <h3 className={listedTitleStyles}>{feature.title}</h3>
            <p className={bodyStyles}>{feature.body}</p>
          </div>
        ))}
      </div>
    </details>
  </Section>
);

const groupsStyles = grid({
  gap: 4,
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 18rem), 1fr))",
});

const itemsStyles = css({
  "& li + li": { marginBlockStart: 1 },
  color: "muted",
  fontSize: "sm",
  listStyle: "disc",
  paddingInlineStart: 5,
});

const moreStyles = css({ marginBlockStart: 4 });

// The marker is the browser's own disclosure triangle.
const summaryStyles = css({
  _focusVisible: {
    outline: "2px solid {colors.accent}",
    outlineOffset: "2px",
  },
  borderRadius: "md",
  color: "accent",
  cursor: "pointer",
  fontWeight: "semibold",
  marginBlockEnd: 4,
  width: "fit-content",
});

const shownStyles = grid({
  gap: 4,
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 26rem), 1fr))",
  marginBlockEnd: 4,
});

const shownCardStyles = flex({
  backgroundColor: "card",
  border: "1px solid {colors.border}",
  borderRadius: "xl",
  direction: "column",
  gap: 2,
  padding: 6,
});

const shownTitleStyles = css({
  fontFamily: "display",
  fontSize: "xl",
  fontWeight: "semibold",
  marginBlockStart: 2,
});

const listedStyles = grid({
  gap: 4,
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 20rem), 1fr))",
});

const listedCardStyles = flex({
  backgroundColor: "card",
  border: "1px solid {colors.border}",
  borderRadius: "xl",
  direction: "column",
  gap: 2,
  padding: 5,
});

const listedTitleStyles = css({
  fontFamily: "display",
  fontSize: "lg",
  fontWeight: "semibold",
});

const bodyStyles = css({ color: "muted", fontSize: "sm" });
