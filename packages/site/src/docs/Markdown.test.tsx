import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { Markdown } from "./Markdown";

const PAGES = [
  { slug: "manganese/idle", source: "docs/IDLE.md", title: "Idle and sleep" },
];

const render = (source: string) =>
  renderToStaticMarkup(
    <Markdown from="docs/LOCK.md" pages={PAGES} source={source} />,
  );

describe("Markdown", () => {
  test("headings carry GitHub's ids", () => {
    expect(render("# The lock\n\n## Sleep and logind")).toMatch(
      /<h2[^>]*id="sleep-and-logind"/,
    );
  });

  test("links go where the site serves them", () => {
    const html = render(
      "See [idle](IDLE.md#clocks) and [the source](../src/).",
    );
    expect(html).toContain('href="/docs/manganese/idle#clocks"');
    expect(html).toContain(
      'href="https://github.com/cprussin/domicile/blob/release/src/"',
    );
  });

  test("a link named for its page's file reads as the page's title", () => {
    const html = render(
      "See [IDLE.md](IDLE.md#clocks), [`IDLE.md`](./IDLE.md) and [docs/IDLE.md](/docs/IDLE.md).",
    );
    expect(html).not.toContain("IDLE.md");
    expect(html.match(/>Idle and sleep<\/a>/g)).toHaveLength(3);
  });

  test("a link with its own words, or to a file, keeps them", () => {
    const html = render("See [idle](IDLE.md) and [RUNNING.md](RUNNING.md).");
    expect(html).toContain(">idle</a>");
    expect(html).toContain(">RUNNING.md</a>");
  });

  test("inline text keeps its emphasis and code", () => {
    expect(render("**Meta+L** locks, *now*, with `lock`.")).toMatch(
      /<strong[^>]*>Meta\+L<\/strong> locks, <em[^>]*>now<\/em>, with <code[^>]*>lock<\/code>\./,
    );
  });

  test("code blocks are highlighted in their language", () => {
    const html = render("```ts\nconst a = 1;\n```");
    expect(html).toContain("<pre");
    expect(html).toContain(">const<");
  });

  test("code blocks can be copied", () => {
    expect(render("```sh\nls\n```")).toMatch(
      /<button[^>]*>(<span[^>]*>)?Copy</,
    );
  });

  test("JavaScript code blocks are highlighted", () => {
    expect(render("```js\nconst a = 1;\n```")).toContain(">const<");
  });

  test("a code block in an unknown language is plain", () => {
    expect(render("```nix\n{ a = 1; }\n```")).toContain(">{ a = 1; }<");
  });

  test("lists keep their order and start", () => {
    const html = render("3. three\n4. four\n\n- a\n- b");
    expect(html).toMatch(/<ol[^>]*start="3"/);
    expect(html).toMatch(/<ul[^>]*><li[^>]*>a<\/li><li[^>]*>b<\/li><\/ul>/);
  });

  test("tables have a head, a body and alignment", () => {
    const html = render("| Key | Does |\n|:--|--:|\n| `a` | b |");
    expect(html).toMatch(/<thead[^>]*><tr[^>]*><th[^>]*>Key<\/th>/);
    expect(html).toMatch(/<td[^>]*data-align="right"[^>]*>b<\/td>/);
  });

  test("quotes and rules", () => {
    const html = render("> careful\n\n---");
    expect(html).toMatch(/<blockquote[^>]*><p[^>]*>careful<\/p><\/blockquote>/);
    expect(html).toContain("<hr");
  });

  test("a picture from docs/media shows as its capture", () => {
    const html = renderToStaticMarkup(
      <Markdown
        from="docs/use/LAUNCHER.md"
        pages={PAGES}
        source="![The launcher over a browser](../media/tour-launcher.png)"
      />,
    );
    expect(html).toMatch(/<video[^>]*aria-label="The launcher over a browser"/);
    expect(html).toMatch(
      /src="https:\/\/media\.domicile-desktop\.com\/[0-9a-f]{16}\/tour-launcher\.webm"/,
    );
  });

  test("tab markers make tabs, the first one open", () => {
    const html = render(
      [
        "<!-- tab: Settings app -->",
        "Open **Appearance**.",
        "<!-- tab: Config file -->",
        "Set `theme.mode`.",
        "<!-- /tabs -->",
        "After.",
      ].join("\n\n"),
    );
    expect(html).toContain('role="tablist"');
    expect(html).toMatch(/role="tab"[^>]*>Settings app</);
    expect(html).toMatch(/role="tab"[^>]*>Config file</);
    expect(html).toContain("Appearance");
    expect(html).toMatch(/<p[^>]*>After\.<\/p>/);
  });
  test("pictures side by side in one paragraph are a carousel", () => {
    const html = render(
      "![The menu](media/tour-launcher.png)\n![The bar](media/tour-bar.png)",
    );
    expect(html).toContain('aria-roledescription="carousel"');
    expect(html).toContain('aria-label="2 of 2"');
  });

  test("a picture on its own is not a carousel", () => {
    expect(render("![The menu](media/tour-launcher.png)")).not.toContain(
      "carousel",
    );
  });
});
