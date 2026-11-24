import { css } from "../../styled-system/css";
import { Hero as PageHero } from "../page/Hero";
import { LinkButton } from "../page/LinkButton";
import { CopyCommand } from "./CopyCommand";

/** The manganese page's opening: what it is, and how to try it. */
export const Hero = () => (
  <PageHero
    actions={
      <>
        <LinkButton href="#try" size="lg">
          Try manganese
        </LinkButton>
        <LinkButton href="#tour" size="lg" variant="outline">
          Take the tour
        </LinkButton>
      </>
    }
    lede="A complete tiling Wayland desktop that feels like Sway, where websites tile and tab right alongside your apps. Use it every day as it comes, or change its bar, launcher or anything else in React and CSS."
    tag={{
      href: "/docs/manganese/release-notes",
      label: "New: your Electron apps on the desktop's browser, and profiles →",
    }}
    title="Sway, with more <div>s."
  >
    <CopyCommand command="nix run github:cprussin/domicile/release#manganese" />
    <span className={noteStyles}>
      With Nix, try it in a window first. Packages for Debian, Ubuntu, Fedora,
      openSUSE and Arch are{" "}
      <a className={linkStyles} href="#install">
        below
      </a>
      .
    </span>
    <span className={noteStyles}>
      A trial's screen doesn't lock, not even when the computer sleeps.{" "}
      <a className={linkStyles} href="/docs/manganese/install#try-it-first">
        Why
      </a>
    </span>
  </PageHero>
);

const noteStyles = css({ color: "muted", fontSize: "sm" });

const linkStyles = css({ color: "accent" });
