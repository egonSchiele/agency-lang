import { describe, it, expect } from "vitest";
import { _parseMarkdown, _renderMarkdownForHtml } from "../markdown.js";

/** Parse Markdown and render it to HTML. Both halves are pure, so these stay
 *  unit tests with no mocks and no I/O. */
function md2html(src: string): string {
  const parsed = _parseMarkdown(src);
  expect(parsed.success).toBe(true);
  return _renderMarkdownForHtml(parsed.blocks);
}

describe("_renderMarkdownForHtml", () => {
  describe("headings", () => {
    it("renders each level", () => {
      expect(md2html("# One")).toBe("<h1>One</h1>");
      expect(md2html("## Two")).toBe("<h2>Two</h2>");
      expect(md2html("###### Six")).toBe("<h6>Six</h6>");
    });
  });

  describe("inline formatting", () => {
    it("renders a paragraph", () => {
      expect(md2html("hello")).toBe("<p>hello</p>");
    });

    it("renders bold and italic", () => {
      expect(md2html("**b**")).toBe("<p><strong>b</strong></p>");
      expect(md2html("*i*")).toBe("<p><em>i</em></p>");
    });

    it("renders strikethrough", () => {
      expect(md2html("~~gone~~")).toBe("<p><del>gone</del></p>");
    });

    it("renders inline code", () => {
      expect(md2html("`x`")).toBe("<p><code>x</code></p>");
    });

    it("nests emphasis", () => {
      expect(md2html("***both***")).toContain("<strong><em>both</em></strong>");
    });
  });

  describe("escaping", () => {
    it("escapes angle brackets in text", () => {
      expect(md2html("a < b")).toBe("<p>a &lt; b</p>");
    });

    it("escapes ampersands", () => {
      expect(md2html("a & b")).toBe("<p>a &amp; b</p>");
    });

    it("escapes inside inline code", () => {
      expect(md2html("`<script>`")).toBe("<p><code>&lt;script&gt;</code></p>");
    });

    it("escapes inside code blocks", () => {
      const html = md2html("```\n<script>alert(1)</script>\n```");
      expect(html).toContain("&lt;script&gt;");
      expect(html).not.toContain("<script>");
    });
  });

  describe("raw HTML is dropped, not passed through", () => {
    // The Markdown reaching this renderer is typically model-authored, so raw
    // HTML in the source is untrusted input rather than an authoring choice.
    it("drops an html block", () => {
      const html = md2html("<div onclick='steal()'>hi</div>");
      expect(html).not.toContain("<div");
      expect(html).not.toContain("onclick");
    });

    it("drops a raw script block", () => {
      const html = md2html("<script>alert(1)</script>");
      expect(html).not.toContain("<script");
      expect(html).not.toContain("alert(1)");
    });
  });

  describe("URL schemes", () => {
    it("keeps http and https links", () => {
      expect(md2html("[x](https://example.com)")).toBe(
        '<p><a href="https://example.com">x</a></p>',
      );
    });

    it("keeps mailto links", () => {
      expect(md2html("[m](mailto:a@b.com)")).toContain('href="mailto:a@b.com"');
    });

    it("keeps path-relative links", () => {
      expect(md2html("[r](/docs/x.html)")).toContain('href="/docs/x.html"');
    });

    // A protocol-relative URL has no scheme, so it looks relative to a naive
    // check, but it is not: a renderer resolves it against the current protocol
    // and fetches from the remote host. In a note that is a tracking pixel.
    it("drops a protocol-relative link", () => {
      const html = md2html("[x](//evil.example.com/x)");
      expect(html).not.toContain("evil.example.com");
      expect(html).not.toContain("<a ");
      expect(html).toContain("x");
    });

    it("drops a protocol-relative image", () => {
      const html = md2html("![x](//evil.example.com/track.gif)");
      expect(html).not.toContain("evil.example.com");
      expect(html).not.toContain("<img");
    });

    it("drops a scheme reformed by a control character", () => {
      // Control chars are stripped before the scheme test, so this must not
      // slip through as a schemeless "relative" URL and re-form later.
      const html = md2html("[x](java\nscript:alert(1))");
      expect(html).not.toContain("<a ");
    });

    it("drops a javascript: link but keeps its text", () => {
      const html = md2html("[click](javascript:alert(1))");
      expect(html).not.toContain("javascript:");
      expect(html).not.toContain("<a ");
      expect(html).toContain("click");
    });

    it("drops a data: link", () => {
      const html = md2html("[x](data:text/html;base64,PHNjcmlwdD4=)");
      expect(html).not.toContain("data:");
      expect(html).not.toContain("<a ");
    });

    it("is case-insensitive about the scheme", () => {
      const html = md2html("[x](JaVaScRiPt:alert(1))");
      expect(html).not.toContain("<a ");
    });

    it("drops an unsafe image src but keeps the alt text", () => {
      const html = md2html("![alt](javascript:alert(1))");
      expect(html).not.toContain("<img");
      expect(html).toContain("alt");
    });
  });

  describe("code blocks", () => {
    it("renders without a language", () => {
      expect(md2html("```\nx = 1\n```")).toBe("<pre><code>x = 1</code></pre>");
    });

    it("renders with a language class", () => {
      expect(md2html("```ts\nx = 1\n```")).toBe(
        '<pre><code class="language-ts">x = 1</code></pre>',
      );
    });
  });

  describe("lists", () => {
    it("renders an unordered list", () => {
      expect(md2html("- one\n- two")).toBe("<ul><li>one</li><li>two</li></ul>");
    });

    it("renders an ordered list", () => {
      expect(md2html("1. one\n2. two")).toBe("<ol><li>one</li><li>two</li></ol>");
    });

    it("keeps a non-1 start", () => {
      expect(md2html("3. three\n4. four")).toContain('<ol start="3">');
    });

    it("renders task list items as checkboxes", () => {
      const html = md2html("- [x] done\n- [ ] todo");
      expect(html).toContain('<input type="checkbox" checked disabled> done');
      expect(html).toContain('<input type="checkbox" disabled> todo');
    });
  });

  describe("other blocks", () => {
    it("renders a block quote", () => {
      expect(md2html("> quoted")).toBe("<blockquote><p>quoted</p></blockquote>");
    });

    it("renders a horizontal rule", () => {
      expect(md2html("---\n")).toBe("<hr>");
    });

    it("renders a table with alignment", () => {
      const html = md2html("| a | b |\n| :-- | --: |\n| 1 | 2 |");
      expect(html).toContain("<table>");
      expect(html).toContain("<th style=\"text-align:left\">a</th>");
      expect(html).toContain("<th style=\"text-align:right\">b</th>");
      expect(html).toContain("<td style=\"text-align:left\">1</td>");
    });

    it("escapes table cell content", () => {
      const html = md2html("| a |\n| --- |\n| <b>x</b> |");
      expect(html).toContain("&lt;b&gt;");
      expect(html).not.toContain("<b>x</b>");
    });

    it("omits frontmatter", () => {
      const html = md2html("---\ntitle: x\n---\n\nbody");
      expect(html).not.toContain("title");
      expect(html).toContain("<p>body</p>");
    });
  });

  // The parser never emits these shapes, so `parse |> renderForHtml` is safe
  // without them. They matter because the renderer's stated contract is that
  // the AST is untrusted: the Agency signature is `renderForHtml(blocks: any[])`,
  // and `walk` is a documented API in this same module for transforming an AST.
  // `parse -> walk -> renderForHtml` is an intended pipeline, and a walk block
  // acting on model-influenced content can set any field to any value.
  describe("malicious ASTs", () => {
    it("does not let table alignment escape its attribute", () => {
      const html = _renderMarkdownForHtml([{
        type: "table",
        headers: ["a"],
        rows: [["1"]],
        alignments: ['left" onmouseover="alert(1)'],
      }]);
      expect(html).not.toContain("onmouseover");
      expect(html).toContain("<th>a</th>");
    });

    it("keeps the known alignments while rejecting the rest", () => {
      const html = _renderMarkdownForHtml([{
        type: "table",
        headers: ["a", "b"],
        rows: [],
        alignments: ["center", "bogus"],
      }]);
      expect(html).toContain('<th style="text-align:center">a</th>');
      expect(html).toContain("<th>b</th>");
    });

    it("does not let an ordered list's start escape its attribute", () => {
      const html = _renderMarkdownForHtml([{
        type: "list",
        ordered: true,
        start: '2"><script>alert(1)</script><ol x="',
        items: [{ content: [{ type: "paragraph", content: [{ type: "inline-text", content: "hi" }] }] }],
      }]);
      expect(html).not.toContain("<script");
      expect(html).not.toContain("alert(1)");
      expect(html).toBe("<ol><li>hi</li></ol>");
    });

    it("does not let a heading level escape its tag", () => {
      const html = _renderMarkdownForHtml([{
        type: "heading",
        level: '1 onload="alert(1)"',
        content: [{ type: "inline-text", content: "x" }],
      }]);
      expect(html).not.toContain("onload");
      expect(html).toBe("<h1>x</h1>");
    });

    it("clamps an out-of-range heading level", () => {
      expect(_renderMarkdownForHtml([{ type: "heading", level: 99, content: [] }]))
        .toBe("<h6></h6>");
      expect(_renderMarkdownForHtml([{ type: "heading", level: -5, content: [] }]))
        .toBe("<h1></h1>");
    });

    it("does not throw on non-string text content", () => {
      // The renderer's contract is to skip junk, not to throw.
      expect(() =>
        _renderMarkdownForHtml([{
          type: "paragraph",
          content: [{ type: "inline-text", content: 42 }],
        }])
      ).not.toThrow();
    });

    it("does not throw on a non-string code block body", () => {
      expect(() =>
        _renderMarkdownForHtml([{ type: "code-block", content: 42, language: null }])
      ).not.toThrow();
    });

    it("does not throw on a non-string url", () => {
      expect(() =>
        _renderMarkdownForHtml([{
          type: "paragraph",
          content: [{ type: "inline-link", url: 42, content: [] }],
        }])
      ).not.toThrow();
    });

    it("escapes a coerced non-string body rather than emitting it raw", () => {
      const html = _renderMarkdownForHtml([{
        type: "code-block",
        content: { toString: () => "<script>alert(1)</script>" },
        language: null,
      }]);
      expect(html).not.toContain("<script>");
      expect(html).toContain("&lt;script&gt;");
    });
  });

  describe("input handling", () => {
    it("returns empty string for a non-array", () => {
      expect(_renderMarkdownForHtml(null)).toBe("");
      expect(_renderMarkdownForHtml("nope")).toBe("");
      expect(_renderMarkdownForHtml(undefined)).toBe("");
    });

    it("returns empty string for an empty array", () => {
      expect(_renderMarkdownForHtml([])).toBe("");
    });

    it("skips junk nodes rather than throwing", () => {
      expect(_renderMarkdownForHtml([null, { type: "bogus" }])).toBe("");
    });
  });

  describe("documents", () => {
    it("renders a realistic agent-written note", () => {
      const html = md2html(
        "## Findings\n\nThe **key** result.\n\n- one\n- two\n",
      );
      expect(html).toContain("<h2>Findings</h2>");
      expect(html).toContain("<p>The <strong>key</strong> result.</p>");
      expect(html).toContain("<ul><li>one</li><li>two</li></ul>");
    });
  });
});
