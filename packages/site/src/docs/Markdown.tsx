import { posix } from "node:path";

import type { Link, RootContent } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

import { css } from "../../styled-system/css";
import { CodeBlock } from "../code/CodeBlock";
import type { Language } from "../code/highlight";
import { Carousel } from "../media/Carousel";
import { Media } from "../media/Media";
import { DocTabs } from "./DocTabs";
import type { Routed } from "./links";
import { linkLabel, resolveHref } from "./links";
import { slugger } from "./slugger";
import { textOf } from "./text-of";

type Props = {
  /** The markdown. */
  source: string;
  /** Its path in the repository, which its relative links start from. */
  from: string;
  /** The docs pages, which its links to them go to. */
  pages: readonly Routed[];
};

/** A repository markdown file as a docs page's body, rendered at build time. */
export const Markdown = ({ source, from, pages }: Props) => {
  const tree = fromMarkdown(source, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  const context: Context = { from, pages, slug: slugger() };
  return <div className={bodyStyles}>{nodes(tree.children, context)}</div>;
};

type Context = {
  from: string;
  pages: readonly Routed[];
  slug: (text: string) => string;
};

const nodes = (children: readonly RootContent[], context: Context) =>
  // Siblings never reorder, so their positions are stable keys.
  tabbed(children).map((child, at) =>
    "tabs" in child ? (
      <DocTabs
        key={at}
        tabs={child.tabs.map((tab) => ({
          content: <div className={bodyStyles}>{nodes(tab.body, context)}</div>,
          label: tab.label,
        }))}
      />
    ) : (
      <Node context={context} key={at} node={child} />
    ),
  );

/** A run of siblings between tab markers, one body per tab. */
type TabRun = { tabs: { label: string; body: RootContent[] }[] };

/**
 * `children`, with each run of `<!-- tab: Label -->` sections, ended by
 * `<!-- /tabs -->` or the end, gathered into one `TabRun`. On GitHub the
 * markers are invisible and the sections read one after the other.
 */
const tabbed = (children: readonly RootContent[]): (RootContent | TabRun)[] => {
  const out: (RootContent | TabRun)[] = [];
  let run: TabRun | undefined;
  for (const child of children) {
    const marker = child.type === "html" ? markerOf(child.value) : undefined;
    if (marker === "end") {
      run = undefined;
    } else if (marker !== undefined) {
      if (run === undefined) {
        run = { tabs: [] };
        out.push(run);
      }
      run.tabs.push({ body: [], label: marker.label });
    } else if (run === undefined) {
      out.push(child);
    } else {
      run.tabs.at(-1)?.body.push(child);
    }
  }
  return out;
};

const markerOf = (html: string): { label: string } | "end" | undefined => {
  if (/^<!--\s*\/tabs\s*-->$/.test(html.trim())) {
    return "end";
  }
  const label = /^<!--\s*tab:\s*(.+?)\s*-->$/.exec(html.trim())?.[1];
  return label === undefined ? undefined : { label };
};

const Node = ({ node, context }: { node: RootContent; context: Context }) => {
  switch (node.type) {
    case "heading": {
      const Tag = HEADINGS[node.depth - 1] ?? "h6";
      return (
        <Tag className={headingStyles} id={context.slug(textOf(node))}>
          {nodes(node.children, context)}
        </Tag>
      );
    }
    case "paragraph": {
      const pictures = node.children.filter((child) => child.type === "image");
      const onlyPictures = node.children.every(
        (child) =>
          child.type === "image" ||
          (child.type === "text" && child.value.trim() === ""),
      );
      return onlyPictures && pictures.length > 1 ? (
        <Carousel
          slides={pictures.map((picture) => ({
            caption: picture.alt ?? "",
            key: picture.url,
            media: <Node context={context} node={picture} />,
          }))}
        />
      ) : (
        <p className={paragraphStyles}>{nodes(node.children, context)}</p>
      );
    }
    case "text": {
      return node.value;
    }
    case "emphasis": {
      return <em>{nodes(node.children, context)}</em>;
    }
    case "strong": {
      return <strong>{nodes(node.children, context)}</strong>;
    }
    case "delete": {
      return <del>{nodes(node.children, context)}</del>;
    }
    case "inlineCode": {
      return <code className={inlineCodeStyles}>{node.value}</code>;
    }
    case "break": {
      return <br />;
    }
    case "link": {
      return (
        <a
          className={linkStyles}
          href={resolveHref(node.url, context.from, context.pages)}
        >
          <LinkText context={context} node={node} />
        </a>
      );
    }
    case "code": {
      return (
        <div className={blockStyles}>
          <CodeBlock code={node.value} copy language={languageOf(node.lang)} />
        </div>
      );
    }
    case "list": {
      return node.ordered === true ? (
        <ol className={listStyles} start={node.start ?? undefined}>
          {nodes(node.children, context)}
        </ol>
      ) : (
        <ul className={listStyles}>{nodes(node.children, context)}</ul>
      );
    }
    case "listItem": {
      // A tight list's items hold bare text, not paragraphs.
      return (
        <li className={itemStyles}>
          {node.spread
            ? nodes(node.children, context)
            : node.children.flatMap((child, at) =>
                child.type === "paragraph" ? (
                  nodes(child.children, context)
                ) : (
                  <Node context={context} key={at} node={child} />
                ),
              )}
        </li>
      );
    }
    case "blockquote": {
      return (
        <blockquote className={quoteStyles}>
          {nodes(node.children, context)}
        </blockquote>
      );
    }
    case "thematicBreak": {
      return <hr className={ruleStyles} />;
    }
    case "table": {
      const [head, ...body] = node.children;
      const cells = (row: typeof head, Cell: "td" | "th") =>
        row?.children.map((cell, at) => (
          <Cell
            className={cellStyles}
            data-align={node.align?.[at] ?? undefined}
            key={at}
          >
            {nodes(cell.children, context)}
          </Cell>
        ));
      return (
        <div className={tableWrapStyles}>
          <table className={tableStyles}>
            <thead>
              <tr>{cells(head, "th")}</tr>
            </thead>
            <tbody>
              {body.map((row, at) => (
                <tr key={at}>{cells(row, "td")}</tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    case "image": {
      // Only the captures in docs/media are on the site.
      const name = /(?:^|\/)docs\/media\/([^/]+)\.png$/.exec(
        posix.join(posix.dirname(context.from), node.url),
      )?.[1];
      return name === undefined ? undefined : (
        <span className={pictureStyles}>
          <Media alt={node.alt ?? ""} name={name} />
        </span>
      );
    }
    default: {
      // Raw HTML, footnotes and definitions: the docs use none.
      return undefined;
    }
  }
};

/**
 * A link's words. One named for its docs page's file, `[KEYS.md](KEYS.md)`
 * or in code, reads as the page's title instead.
 */
const LinkText = ({ node, context }: { node: Link; context: Context }) => {
  const [only, ...rest] = node.children;
  if (
    only === undefined ||
    rest.length > 0 ||
    (only.type !== "text" && only.type !== "inlineCode")
  ) {
    return nodes(node.children, context);
  }
  const label = linkLabel(only.value, node.url, context.from, context.pages);
  return label === only.value ? nodes(node.children, context) : label;
};

const HEADINGS = ["h1", "h2", "h3", "h4", "h5", "h6"] as const;

/** A fence's language as `CodeBlock` names it; anything else is plain. */
const languageOf = (lang: string | null | undefined): Language =>
  LANGUAGES[lang ?? ""] ?? "plain";

const LANGUAGES: Readonly<Record<string, Language>> = {
  bash: "bash",
  css: "css",
  // The TypeScript grammar reads JavaScript too.
  js: "tsx",
  json: "json",
  sh: "bash",
  ts: "tsx",
  tsx: "tsx",
};

const bodyStyles = css({
  color: "foreground",
  display: "flex",
  flexDirection: "column",
  fontSize: "md",
  gap: 4,
  lineHeight: "relaxed",
  minInlineSize: 0,
});

const headingStyles = css({
  "&:is(h1)": { fontSize: "4xl", marginBlockEnd: 2 },
  "&:is(h2)": {
    borderBlockStart: "1px solid {colors.border}",
    fontSize: "2xl",
    marginBlockStart: 6,
    paddingBlockStart: 6,
  },
  "&:is(h3)": { fontSize: "xl", marginBlockStart: 4 },
  "&:is(h4, h5, h6)": { fontSize: "lg", marginBlockStart: 2 },
  fontFamily: "display",
  fontWeight: "semibold",
  letterSpacing: "tight",
  lineHeight: "tight",
  scrollMarginBlockStart: 6,
});

const paragraphStyles = css({ margin: 0 });

const inlineCodeStyles = css({
  backgroundColor: "card",
  border: "1px solid {colors.border}",
  borderRadius: "sm",
  fontFamily: "code",
  fontSize: "0.875em",
  // Long paths break rather than widen a phone's page.
  overflowWrap: "anywhere",
  paddingInline: 1,
});

const linkStyles = css({
  _hover: { textDecorationThickness: "2px" },
  color: "accent",
  textDecoration: "underline",
  textUnderlineOffset: "2px",
});

const blockStyles = css({ minInlineSize: 0 });

const pictureStyles = css({ display: "block", marginBlock: 2 });

const listStyles = css({
  display: "flex",
  flexDirection: "column",
  gap: 1.5,
  margin: 0,
  "ol&": { listStyleType: "decimal" },
  paddingInlineStart: 6,
  "ul&": { listStyleType: "disc" },
});

const itemStyles = css({
  "& > :is(ul, ol)": { marginBlockStart: 1.5 },
});

const quoteStyles = css({
  borderInlineStart: "3px solid {colors.accent}",
  color: "muted",
  margin: 0,
  paddingInlineStart: 4,
});

const ruleStyles = css({
  border: 0,
  borderBlockStart: "1px solid {colors.border}",
  marginBlock: 2,
});

const tableWrapStyles = css({ overflowX: "auto" });

const tableStyles = css({
  borderCollapse: "collapse",
  fontSize: "sm",
  inlineSize: "full",
});

const cellStyles = css({
  "&[data-align=center]": { textAlign: "center" },
  "&[data-align=right]": { textAlign: "right" },
  borderBlockEnd: "1px solid {colors.border}",
  paddingBlock: 2,
  paddingInline: 3,
  textAlign: "left",
  verticalAlign: "top",
});
