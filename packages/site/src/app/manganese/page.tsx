import { BuiltOnDomicile } from "../../manganese/BuiltOnDomicile";
import { Configure } from "../../manganese/Configure";
import { Customize } from "../../manganese/Customize";
import { DOCS } from "../../manganese/docs";
import { FromSway } from "../../manganese/FromSway";
import { Hero } from "../../manganese/Hero";
import { Install } from "../../manganese/Install";
import { Keys } from "../../manganese/Keys";
import { ManganeseMark } from "../../manganese/ManganeseMark";
import { EverythingElse, Tour } from "../../manganese/Tour";
import { Try } from "../../manganese/Try";
import { Media } from "../../media/Media";
import { Accent } from "../../page/Accent";
import { LinkColumns } from "../../page/LinkColumns";
import { repoFile } from "../../page/repo";
import { Section } from "../../page/Section";
import { SiteFooter } from "../../page/SiteFooter";
import { SiteHeader } from "../../page/SiteHeader";
import { shared } from "../../page/shared";

export const metadata = shared({
  description:
    "A complete tiling Wayland desktop that feels like Sway, where websites tile and tab right alongside your apps. Built on Domicile, and customizable in React and CSS.",
  path: "/manganese",
  title: "Manganese: a tiling Wayland desktop",
});

/** domicile-desktop.com/manganese: the reference shell, for its users. */
const ManganesePage = () => (
  <Accent product="manganese">
    <SiteHeader
      action={{ href: "#install", label: "Install" }}
      brand={<ManganeseMark />}
      links={[
        { href: "#tour", label: "Tour" },
        { href: "#customize", label: "Customize" },
        { href: "#sway", label: "From Sway" },
        { href: "#keys", label: "Keys" },
        { href: "#docs", label: "Docs" },
      ]}
      sticky
    />
    <main>
      <Hero />
      <Section>
        <Media
          alt="Manganese opening Blender and a browser from the launcher, tiling them, opening Settings, then showing a notification"
          name="manganese-hero"
        />
      </Section>
      <Tour />
      <Customize />
      <EverythingElse />
      <FromSway />
      <Try />
      <Keys />
      <Install />
      <Configure />
      <BuiltOnDomicile />
      <Section id="docs" title="Docs">
        <LinkColumns columns={DOCS} />
      </Section>
    </main>
    <SiteFooter
      links={[
        { href: "/docs/manganese/release-notes", label: "Release notes" },
        { href: repoFile("LICENSE"), label: "MIT license" },
      ]}
    >
      <span>
        Manganese is one desktop built on <a href="/">Domicile</a>.
      </span>
    </SiteFooter>
  </Accent>
);

export default ManganesePage;
