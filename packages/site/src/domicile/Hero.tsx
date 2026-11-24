import { css } from "../../styled-system/css";
import { Hero as PageHero } from "../page/Hero";
import { LinkButton } from "../page/LinkButton";

/** The Domicile page's opening: the idea, and where to go next. */
export const Hero = () => (
  <PageHero
    actions={
      <>
        <LinkButton href="#possible" size="lg">
          See what's possible
        </LinkButton>
        <LinkButton href="#build" size="lg" variant="outline">
          Build something weird
        </LinkButton>
      </>
    }
    lede={
      <>
        For years we've run Chromium's compositor inside another compositor.
        Domicile makes them one: your desktop lays out websites, native apps
        become DOM elements, and browser features like casting, extensions and
        notifications become desktop features.
        <span className={experimentStyles}>
          An experiment in what becomes possible when the boundaries disappear.
        </span>
      </>
    }
    tag={{
      href: "/docs/release-notes",
      label: "New: Electron apps on the engine, and browser profiles →",
    }}
    title={
      <>
        You're already running two compositors.{" "}
        <span className={questionStyles}>Why not make it one?</span>
      </>
    }
  >
    {/* A window needs a Wayland session: there is no X11 backend. */}
    <p className={trialStyles}>
      <a className={trialLinkStyles} href="/docs/install#try-it-first">
        Try it in a window
      </a>{" "}
      on your current Wayland desktop.
    </p>
  </PageHero>
);

// The headline's question, on its own line in the accent.
const questionStyles = css({ color: "accent", display: "block" });

const experimentStyles = css({
  color: "foreground",
  display: "block",
  marginBlockStart: 3,
});

// Pulled toward the buttons it qualifies, past the hero's gap.
const trialStyles = css({
  color: "muted",
  fontSize: "sm",
  marginBlockStart: -2,
});

const trialLinkStyles = css({
  _hover: { color: "accent" },
  color: "foreground",
  textDecoration: "underline",
});
