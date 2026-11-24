import { readFileSync } from "node:fs";
import { join } from "node:path";

import { css } from "../../styled-system/css";
import { Markdown } from "../docs/Markdown";
import { PAGES, REPO_ROOT } from "../docs/pages";
import { DomicileMark } from "../domicile/DomicileMark";
import { Accent } from "../page/Accent";
import { repoFile } from "../page/repo";
import { SiteFooter } from "../page/SiteFooter";
import { SiteHeader } from "../page/SiteHeader";

type Props = {
  /** The markdown file, from the repository root. */
  source: string;
};

/** A policy page: one markdown file under the Domicile header. */
export const LegalPage = ({ source }: Props) => (
  <Accent product="domicile">
    <SiteHeader
      action={{ href: "/docs/shells/quickstart", label: "Quickstart" }}
      brand={<DomicileMark />}
      links={[
        { href: "/", label: "Domicile" },
        { href: "/manganese", label: "Manganese" },
      ]}
    />
    <main className={mainStyles}>
      <Markdown
        from={source}
        pages={PAGES}
        source={readFileSync(join(REPO_ROOT, source), "utf8")}
      />
    </main>
    <SiteFooter links={[{ href: repoFile("LICENSE"), label: "MIT license" }]}>
      <span>
        Domicile runs <a href="/manganese">manganese</a>, its reference shell.
      </span>
    </SiteFooter>
  </Accent>
);

const mainStyles = css({
  marginInline: "auto",
  maxInlineSize: "3xl",
  paddingBlock: 8,
  paddingInline: 6,
});
