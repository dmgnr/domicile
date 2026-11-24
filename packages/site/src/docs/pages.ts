// The docs pages: which repository markdown files the site renders, under
// which routes, in which sidebar sections.

import { join } from "node:path";

import type { ProductName } from "../page/Accent";

/** A docs page: its route under `/docs/`, its sidebar title and its file. */
export type DocPage = { slug: string; title: string; source: string };

/** A sidebar section, colored for the product it documents. */
export type DocSection = {
  title: string;
  product: ProductName;
  pages: readonly DocPage[];
};

/** The repository, which `source` paths start from, at build time. */
export const REPO_ROOT = join(process.cwd(), "..", "..");

const USE = "docs/use";

/** A page, by its route, its file and its sidebar title. */
const doc = (slug: string, source: string, title: string): DocPage => ({
  slug,
  source,
  title,
});

/** A user guide page, by its route under `manganese/` and its file's name. */
const page = (slug: string, file: string, title: string): DocPage =>
  doc(`manganese/${slug}`, `${USE}/${file}.md`, title);

/** The user guide's sections. */
const SECTIONS: readonly DocSection[] = [
  {
    pages: [
      page("install", "INSTALL", "Install"),
      page("compatibility", "COMPATIBILITY", "What it runs on"),
      page("first-steps", "FIRST-STEPS", "First steps"),
      page("keys", "KEYS", "Keys"),
    ],
    product: "manganese",
    title: "Get started",
  },
  {
    pages: [
      page("windows", "WINDOWS", "Windows and workspaces"),
      page("browser", "BROWSER", "Browsing and web apps"),
      page("electron-apps", "ELECTRON-APPS", "Electron apps"),
      page("agents", "AGENTS", "Agents"),
      page("launcher", "LAUNCHER", "The launcher"),
      page("top-bar", "TOP-BAR", "The top bar"),
      page("notifications", "NOTIFICATIONS", "Notifications"),
      page("clipboard", "CLIPBOARD", "Clipboard"),
      page("screenshots", "SCREENSHOTS", "Screenshots and recordings"),
      page("lock", "LOCK-AND-IDLE", "Locking and sleep"),
      page("monitors", "MONITORS", "Monitors and casting"),
    ],
    product: "manganese",
    title: "Use it",
  },
  {
    pages: [
      page("settings", "CONFIGURE", "Settings and the config file"),
      page("appearance", "APPEARANCE", "Appearance"),
    ],
    product: "manganese",
    title: "Make it yours",
  },
  {
    pages: [
      page("troubleshooting", "TROUBLESHOOTING", "Troubleshooting"),
      doc(
        "manganese/gpu-and-displays",
        "docs/TTY-DEBUGGING.md",
        "GPU and display issues",
      ),
    ],
    product: "manganese",
    title: "Help",
  },
  {
    pages: [page("release-notes", "RELEASE-NOTES", "Release notes")],
    product: "manganese",
    title: "What's new",
  },
];

const AUTHOR_SECTIONS: readonly DocSection[] = [
  {
    pages: [doc("how-it-works", "docs/HOW-IT-WORKS.md", "How it works")],
    product: "domicile",
    title: "Understand it",
  },
  {
    pages: [
      doc("install", "docs/INSTALL.md", "Install"),
      doc("shells/quickstart", "docs/SHELL-QUICKSTART.md", "Quickstart"),
      doc(
        "shells/from-manganese",
        "docs/SHELL-FROM-MANGANESE.md",
        "Start from manganese",
      ),
      doc("shells/writing", "docs/WRITING-A-SHELL.md", "How a shell works"),
      doc("apps/build", "docs/BUILD-AN-APP.md", "Build an app"),
    ],
    product: "domicile",
    title: "Write a shell",
  },
  {
    pages: [
      doc(
        "shells/browser-windows",
        "docs/SHELL-BROWSER-WINDOWS.md",
        "Browser windows",
      ),
      doc("shells/extensions", "docs/SHELL-EXTENSIONS.md", "Extensions"),
      doc(
        "shells/desktop-events",
        "docs/SHELL-DESKTOP-EVENTS.md",
        "Displays, theme, tray, notifications",
      ),
      doc(
        "shells/idle-and-lock",
        "docs/SHELL-IDLE-AND-LOCK.md",
        "Idle and lock",
      ),
      doc(
        "shells/system-access",
        "docs/SHELL-SYSTEM-ACCESS.md",
        "System access",
      ),
      doc("shells/dialogs", "docs/PORTALS.md", "Dialogs and portals"),
      doc("shells/packaging", "docs/SHELL-PACKAGING.md", "Packaging"),
      doc("shells/logs", "docs/LOGGING.md", "Logs"),
    ],
    product: "domicile",
    title: "Guides",
  },
  {
    pages: [
      doc(
        "reference/react",
        "packages/react/README.md",
        "@domicile-desktop/react",
      ),
      doc(
        "reference/sdk",
        "packages/chrome-sdk/README.md",
        "@domicile-desktop/sdk",
      ),
      doc(
        "reference/elements",
        "packages/chrome-sdk/docs/ELEMENTS.md",
        "<app> and <webview>",
      ),
      doc("reference/config", "docs/SHELL-CONFIG.md", "The config file"),
      doc("reference/cli", "docs/CLI.md", "The domicile command"),
    ],
    product: "domicile",
    title: "Reference",
  },
  {
    pages: [doc("release-notes", "docs/RELEASE-NOTES.md", "Release notes")],
    product: "domicile",
    title: "What's new",
  },
];

const ALL_SECTIONS: readonly DocSection[] = [...SECTIONS, ...AUTHOR_SECTIONS];

/** One product's sidebar sections. */
export const sectionsFor = (product: ProductName): readonly DocSection[] =>
  ALL_SECTIONS.filter((section) => section.product === product);

/** The product whose section has the page at `slug`, a route a page has. */
export const productOf = (slug: string): ProductName => {
  const section = ALL_SECTIONS.find((candidate) =>
    candidate.pages.some((page) => page.slug === slug),
  );
  if (section === undefined) {
    throw new Error(`no docs page at /docs/${slug}`);
  }
  return section.product;
};

export const PAGES: readonly DocPage[] = ALL_SECTIONS.flatMap(
  (section) => section.pages,
);

/** The page at `/docs/<segments>`, if there is one. */
export const pageAt = (segments: readonly string[]): DocPage | undefined =>
  PAGES.find((page) => page.slug === segments.join("/"));
