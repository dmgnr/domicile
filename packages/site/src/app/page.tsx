import { css } from "../../styled-system/css";
import { Apps } from "../domicile/Apps";
import { Batteries } from "../domicile/Batteries";
import { Build } from "../domicile/Build";
import { DomicileMark } from "../domicile/DomicileMark";
import { DOCS } from "../domicile/docs";
import { Electron } from "../domicile/Electron";
import { Explore } from "../domicile/Explore";
import { Faq } from "../domicile/Faq";
import { Hero } from "../domicile/Hero";
import { HeroDemo } from "../domicile/HeroDemo";
import { Make } from "../domicile/Make";
import { Npm } from "../domicile/Npm";
import { Possible } from "../domicile/Possible";
import { Quickstart } from "../domicile/Quickstart";
import { ReferenceShell } from "../domicile/ReferenceShell";
import { Swap } from "../domicile/Swap";
import { Why } from "../domicile/Why";
import { Accent } from "../page/Accent";
import { LinkColumns } from "../page/LinkColumns";
import { repoFile } from "../page/repo";
import { Section } from "../page/Section";
import { SiteFooter } from "../page/SiteFooter";
import { SiteHeader } from "../page/SiteHeader";
import { shared } from "../page/shared";

export const metadata = shared({
  description:
    "For years we've run Chromium's compositor inside another compositor. Domicile makes them one: your desktop lays out websites, native apps become DOM elements, and browser features like casting, extensions and notifications become desktop features.",
  path: "/",
  title:
    "Domicile: you're already running two compositors, why not make it one?",
});

/** domicile-desktop.com: Domicile, and building on it. */
const DomicilePage = () => (
  <Accent product="domicile">
    <SiteHeader
      action={{ href: "#quickstart", label: "Quickstart" }}
      brand={<DomicileMark />}
      links={[
        { href: "/docs/how-it-works", label: "How it works" },
        { href: "#docs", label: "Docs" },
        { href: "/manganese", label: "Manganese" },
        { href: "/docs/release-notes", label: "Release notes" },
      ]}
      sticky
    />
    <main>
      <Hero />
      <HeroDemo />
      <Why />
      <Possible />
      <Electron />
      <Build />
      <Make />
      <Swap />
      <Npm />
      <ReferenceShell />
      <Batteries />
      <Quickstart />
      <Apps />
      <Explore />
      <Faq />
      <Section id="docs" title="Docs">
        <LinkColumns columns={DOCS} />
      </Section>
    </main>
    <SiteFooter
      links={[
        { href: "#faq", label: "Built with AI" },
        { href: "/manganese", label: "Manganese" },
        { href: repoFile("LICENSE"), label: "MIT license" },
      ]}
    >
      <blockquote className={quoteStyles}>
        "Your scientists were so preoccupied with whether they could, they
        didn't stop to think if they should."
      </blockquote>
    </SiteFooter>
  </Accent>
);

export default DomicilePage;

const quoteStyles = css({ fontStyle: "italic", maxInlineSize: "xl" });
