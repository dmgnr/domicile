import { css } from "../../styled-system/css";
import { flex } from "../../styled-system/patterns";
import { Backticked } from "../page/Backticked";
import { REPO, repoFile } from "../page/repo";
import { Section } from "../page/Section";
import { engineChromium } from "./chromium";

const CHROMIUM = engineChromium();

/** What people ask before they trust a desktop, each with where to read more. */
const QUESTIONS: readonly {
  question: string;
  answer: string;
  link: { href: string; label: string };
}[] = [
  {
    answer:
      "The goal is for Domicile to feel no slower than any other Wayland compositor, not to be the fastest or lightest one. Running Chromium has a natural overhead, but in most ways it's the same overhead as running Chromium inside another compositor.",
    link: {
      href: repoFile("docs/architecture/ENGINE-FORK-MEASUREMENTS.md"),
      label: "See the measurements",
    },
    question: "Is it faster than my current desktop?",
  },
  {
    answer:
      "They can. List an app in the config and it runs on the desktop's engine, with its menus and dialogs drawn by your shell. Apps you don't list bring their own Chromium, as on any desktop.",
    link: { href: "/docs/manganese/electron-apps", label: "Electron apps" },
    question: "Do Electron apps share the desktop's Chromium?",
  },
  {
    answer:
      "Yes, with extensive help from Claude, which wrote most of the code, tests and docs. The architecture, direction and technical decisions come from the project's human maintainer. Changes are checked by the test suite and by daily use, not by line-by-line human review. The source and its full history are public.",
    link: { href: REPO, label: "Source" },
    question: "Was Domicile built with AI?",
  },
  {
    answer:
      "No. Only your shell and app modules get `domicile`. A page in a browser window is an ordinary website.",
    link: { href: "/docs/shells/system-access", label: "System access" },
    question: "Can websites use the desktop APIs?",
  },
  {
    answer:
      "Anything you can. It runs as you, with your files, programs and D-Bus. Install shells and apps you trust, as you would any program.",
    link: { href: "/docs/apps/build", label: "Build an app" },
    question: "What can a shell or an app do?",
  },
  {
    answer:
      "No. A shell can be Rust, or any language that compiles to WebAssembly. The Dioxus example is the quickstart shell in Rust, with a 3-line JavaScript file that loads it.",
    link: { href: "/docs/shells/writing#in-rust", label: "Shells in Rust" },
    question: "Do I have to write my shell in JavaScript?",
  },
  {
    answer:
      "A reload or `domicile load-shell` keeps every window running and starts only the shell's page over. If the engine crashes, it restarts: your apps keep running with their state, but browser windows close. If the compositor crashes, browser windows stay, but apps lose their connection. Most exit, and the ones your shell launched start again fresh, without unsaved work.",
    link: {
      href: repoFile(
        "docs/architecture/THE-DOMICILE-BINARY.md#crashes-are-recovered",
      ),
      label: "Crash recovery",
    },
    question: "What happens if the desktop crashes or reloads?",
  },
  {
    answer: `The engine is Chromium ${CHROMIUM.version} (\`main\` at \`${CHROMIUM.revision.slice(0, 10)}\`) with Domicile's patches. Moving to a newer Chromium is a pull request that CI builds and tests, and it reaches you with the next Domicile release, through your package manager or a flake update. There is no fixed schedule, and no promise on how fast a Chromium security fix ships.`,
    link: {
      href: repoFile(
        "packages/domicile-engine/docs/RELEASES.md#which-chromium-ships",
      ),
      label: "Chromium updates",
    },
    question: "Which Chromium is it, and how does it get updates?",
  },
  {
    answer:
      "Wayland apps do, and Electron, SDL and Qt apps start in Wayland mode. X11-only apps run when you start xwayland-satellite.",
    link: { href: "/docs/manganese/compatibility#x11-apps", label: "X11 apps" },
    question: "Will my apps work?",
  },
];

/** Short answers to what people ask first, each linking to the detail. */
export const Faq = () => (
  <Section id="faq" title="Questions">
    <div className={listStyles}>
      {QUESTIONS.map(({ question, answer, link }) => (
        <details className={itemStyles} key={question}>
          <summary className={questionStyles}>{question}</summary>
          <p className={answerStyles}>
            <Backticked text={answer} />{" "}
            <a className={linkStyles} href={link.href}>
              {link.label}
            </a>
          </p>
        </details>
      ))}
    </div>
  </Section>
);

const listStyles = flex({ direction: "column", gap: 2 });

const itemStyles = css({
  backgroundColor: "card",
  border: "1px solid {colors.border}",
  borderRadius: "xl",
  paddingBlock: 4,
  paddingInline: 5,
});

const questionStyles = css({
  _focusVisible: {
    outline: "2px solid {colors.accent}",
    outlineOffset: "4px",
  },
  borderRadius: "sm",
  cursor: "pointer",
  fontFamily: "display",
  fontSize: "lg",
  fontWeight: "semibold",
});

const answerStyles = css({ color: "muted", marginBlockStart: 2 });

const linkStyles = css({ color: "foreground", textDecoration: "underline" });
