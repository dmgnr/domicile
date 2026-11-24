import { css } from "../../styled-system/css";
import { flex, grid } from "../../styled-system/patterns";
import { CodeBlock } from "../code/CodeBlock";
import { Media } from "../media/Media";
import { LinkButton } from "../page/LinkButton";
import { Section } from "../page/Section";

const CONFIG = `{
  "electron": {
    "apps": ["slack.desktop", "element-desktop.desktop"]
  }
}`;

/** What an Electron app on the engine hands the shell. */
const PARTS: readonly { title: string; body: string }[] = [
  {
    body: "Each of the app's windows is a window like any other. Tile it, tab it, or give it a frame.",
    title: "Windows your shell lays out",
  },
  {
    body: "File, Edit, View: the app's menu reaches your shell as a list. Draw it as a bar, a button, or nothing.",
    title: "Menus your shell draws",
  },
  {
    body: "“Quit Slack?” and the app's file pickers come to the same dialogs every other app uses.",
    title: "Dialogs your shell draws",
  },
];

/** Electron apps running on the desktop's own Chromium. */
export const Electron = () => (
  <Section
    id="electron"
    lede="List Slack, Element or Claude in the config, and they run on the Chromium your desktop is already running, instead of the one each app bundles."
    title="Your Electron apps, on the desktop's engine."
  >
    <div className={layoutStyles}>
      <Media
        alt="Element running on the desktop's engine, its File, Edit and View menu drawn by the shell under its tab"
        name="release-electron"
      />
      <ul className={partsStyles}>
        {PARTS.map((part) => (
          <li className={partStyles} key={part.title}>
            <span className={partTitleStyles}>{part.title}</span>
            <span className={mutedStyles}>{part.body}</span>
          </li>
        ))}
      </ul>
      <div className={turnOnStyles}>
        <CodeBlock code={CONFIG} language="json" />
        <div className={noteStyles}>
          <p className={mutedStyles}>
            Pages that ask for Node.js get it, as Electron gives it. A few apps,
            such as Signal, still run on their own Chromium until each is
            checked.
          </p>
          <div className={actionsStyles}>
            <LinkButton href="/docs/shells/browser-windows#menu-bars">
              Draw app menus
            </LinkButton>
            <LinkButton href="/docs/manganese/electron-apps" variant="outline">
              Turn it on in manganese
            </LinkButton>
          </div>
        </div>
      </div>
    </div>
  </Section>
);

const layoutStyles = flex({ direction: "column", gap: 4 });

const partsStyles = grid({
  gap: 3,
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 16rem), 1fr))",
  listStyle: "none",
});

const partStyles = flex({
  backgroundColor: "card",
  border: "1px solid {colors.border}",
  borderRadius: "xl",
  direction: "column",
  gap: 1,
  padding: 4,
});

const partTitleStyles = css({ fontFamily: "display", fontWeight: "bold" });

const mutedStyles = css({ color: "muted" });

const turnOnStyles = grid({
  alignItems: "center",
  gap: 4,
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 20rem), 1fr))",
});

const noteStyles = flex({ direction: "column", gap: 3 });

const actionsStyles = flex({ gap: 3, wrap: "wrap" });
