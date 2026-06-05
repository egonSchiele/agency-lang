import { markdownParser } from "tarsec/parsers/markdown";
import { __call } from "../runtime/call.js";
import { color } from "@/utils/termcolors.js";

export type MarkdownParseResult = {
  success: boolean;
  blocks: unknown[];
  error: string;
  rest: string;
};

/** Parse a Markdown string into an array of block nodes using tarsec's
 *  Markdown parser. Returns an object with `success`, the parsed `blocks`,
 *  a textual `error` message (empty on success), and any unconsumed input
 *  in `rest`. */
export function _parseMarkdown(input: string): MarkdownParseResult {
  const res = markdownParser(input);
  if (res.success) {
    return {
      success: true,
      blocks: res.result as unknown[],
      error: "",
      rest: res.rest ?? "",
    };
  }
  return {
    success: false,
    blocks: [],
    error: res.message,
    rest: res.rest ?? "",
  };
}

// ---------------------------------------------------------------------------
// Walk: top-down AST → AST transform.
//
// Calls `fn(node)` on every block and inline node. The callback returns a
// (possibly new) node, then we recurse into *its* children. Children live
// in `content` (paragraph/heading/inline-bold/...) and `items` (lists).
// Shallow-copies on the way down so the input AST is not mutated.
// ---------------------------------------------------------------------------

type Node = Record<string, unknown>;

async function callFn(fn: unknown, node: Node): Promise<Node> {
  return (await __call(fn, {
    type: "positional",
    args: [node],
  })) as Node;
}

async function walkChildren(nodes: unknown[], fn: unknown): Promise<unknown[]> {
  const out: unknown[] = [];
  for (const n of nodes) {
    if (n == null || typeof n !== "object") {
      out.push(n);
      continue;
    }
    out.push(await walkNode(n as Node, fn));
  }
  return out;
}

async function walkListItems(
  items: unknown[],
  fn: unknown,
): Promise<unknown[]> {
  const out: unknown[] = [];
  for (const raw of items) {
    if (raw == null || typeof raw !== "object") {
      out.push(raw);
      continue;
    }
    const item = { ...(raw as Node) };
    // ListItem.content is now an array of Blocks (was inline nodes before
    // tarsec's nested-blocks change). Walk each entry as a node either way.
    if (Array.isArray(item.content)) {
      item.content = await walkChildren(item.content as unknown[], fn);
    }
    out.push(item);
  }
  return out;
}

async function walkNode(node: Node, fn: unknown): Promise<Node> {
  const transformed = await callFn(fn, node);
  if (transformed == null || typeof transformed !== "object") {
    return transformed as unknown as Node;
  }
  const out: Node = { ...transformed };
  if (Array.isArray(out.content)) {
    out.content = await walkChildren(out.content as unknown[], fn);
  }
  if (Array.isArray(out.items)) {
    out.items = await walkListItems(out.items as unknown[], fn);
  }
  return out;
}

/** Walk a Markdown AST (array of block nodes), calling `fn` on every node
 *  top-down. `fn` returns a (possibly new) node; children of the returned
 *  node are then walked. The input AST is not mutated. */
export async function _walkMarkdown(
  blocks: unknown,
  fn: unknown,
): Promise<unknown[]> {
  if (!Array.isArray(blocks)) return [];
  const out: unknown[] = [];
  for (const b of blocks as unknown[]) {
    if (b == null || typeof b !== "object") {
      out.push(b);
      continue;
    }
    out.push(await walkNode(b as Node, fn));
  }
  return out;
}

// ---------------------------------------------------------------------------
// CLI renderer: AST → ANSI-styled string.
//
// VS Code Dark+ inspired palette (matches the `syntax` module's theme so
// the two modules look like the same product). Links use OSC 8 escapes so
// terminals that support them render clickable hyperlinks.
// ---------------------------------------------------------------------------

const HEADING_COLORS = [
  color.hex("#4EC9B0").bold, // h1: teal
  color.hex("#569CD6").bold, // h2: blue
  color.hex("#C586C0").bold, // h3: magenta
  color.hex("#DCDCAA").bold, // h4: yellow
  color.hex("#9CDCFE").bold, // h5: light blue
  color.hex("#D4D4D4").bold, // h6: gray
];
const INLINE_CODE = color.hex("#CE9178");
const LINK = color.hex("#569CD6").underline;
const QUOTE = color.hex("#6A9955");
const BULLET = color.hex("#D7BA7D");
const FAINT = color.dim;

// Strip ASCII control chars (and DEL) from a URL. Markdown is often
// LLM- or user-authored, so a link target like
// `https://x\x07injected\x1b[31mred` could close the OSC 8 escape
// early and inject terminal control codes. We strip rather than
// reject so a benign URL with a stray tab still renders; if every
// character was a control char the result is empty.
const URL_CONTROL_RE = /[\x00-\x1f\x7f]/g;

function sanitizeOsc8Url(url: string): string {
  return url.replace(URL_CONTROL_RE, "");
}

function osc8(url: string, text: string): string {
  const safe = sanitizeOsc8Url(url);
  if (safe.length === 0) return text;
  // BEL-terminated form is the most broadly supported variant.
  return `\x1b]8;;${safe}\x07${text}\x1b]8;;\x07`;
}

function isInlineType(t: unknown): boolean {
  return typeof t === "string" && (t as string).startsWith("inline-");
}

function renderInline(nodes: unknown[]): string {
  return nodes.map(renderInlineNode).join("");
}

function renderInlineNode(n: unknown): string {
  if (typeof n === "string") return n;
  if (n == null || typeof n !== "object") return "";
  const node = n as Node;
  const content = Array.isArray(node.content) ? (node.content as unknown[]) : [];
  switch (node.type) {
    case "inline-text":
      return (node.content as string) ?? "";
    case "inline-soft-break":
      return " ";
    case "inline-hard-break":
      return "\n";
    case "inline-bold":
      return color.bold(renderInline(content));
    case "inline-italic":
      return color.italic(renderInline(content));
    case "inline-bold-italic":
      return color.bold.italic(renderInline(content));
    case "inline-strike":
      // No real strikethrough in the palette; dim is a passable fallback.
      return FAINT(renderInline(content));
    case "inline-code":
      return INLINE_CODE(`\`${(node.content as string) ?? ""}\``);
    case "inline-link": {
      const url = (node.url as string) ?? "";
      const text = renderInline(content) || url;
      return osc8(url, LINK(text));
    }
    case "image": {
      const url = (node.url as string) ?? "";
      const alt = (node.alt as string) ?? "";
      return osc8(url, LINK(`[image: ${alt}]`));
    }
    case "inline-ref-link":
      return LINK((node.text as string) ?? "") + FAINT(`[${node.id}]`);
    case "inline-ref-image":
      return LINK(`[image: ${(node.alt as string) ?? ""}]`) +
        FAINT(`[${node.id}]`);
    case "inline-footnote-ref":
      return FAINT(`[^${node.id}]`);
    case "inline-html":
      return (node.content as string) ?? "";
    default:
      return "";
  }
}

function renderBlock(b: unknown, indent: string = ""): string {
  if (b == null || typeof b !== "object") return "";
  const node = b as Node;
  switch (node.type) {
    case "paragraph":
      return indent +
        renderInline((node.content as unknown[]) ?? []) +
        "\n";

    case "heading": {
      const lvl = Math.max(1, Math.min(6, (node.level as number) ?? 1));
      const styled = HEADING_COLORS[lvl - 1];
      const prefix = "#".repeat(lvl) + " ";
      return indent +
        styled(prefix + renderInline((node.content as unknown[]) ?? [])) +
        "\n";
    }

    case "code-block": {
      // `content` is a plain string. After a walk pass it may already
      // contain ANSI from an upstream highlighter — emit as-is.
      const lang = (node.language as string | null) ?? "";
      const body = ((node.content as string) ?? "").replace(/\n+$/, "");
      const openFence = FAINT(lang ? "```" + lang : "```");
      const closeFence = FAINT("```");
      const bodyLines = body.length === 0
        ? ""
        : body.split("\n").map((l) => indent + l).join("\n") + "\n";
      return indent + openFence + "\n" + bodyLines + indent + closeFence + "\n";
    }

    case "block-quote": {
      const children = (node.content as unknown[]) ?? [];
      const allInline = children.every(
        (c) =>
          typeof c === "string" ||
          (c != null && typeof c === "object" &&
            isInlineType((c as Node).type)),
      );
      const inner = allInline
        ? renderInline(children)
        : children.map((c) => renderBlock(c)).join("");
      const lines = inner.split("\n");
      if (lines[lines.length - 1] === "") lines.pop();
      return lines
        .map((l) => indent + QUOTE("│ ") + l)
        .join("\n") + "\n";
    }

    case "list": {
      const ordered = !!node.ordered;
      let n = (node.start as number) ?? 1;
      let out = "";
      for (const raw of (node.items as unknown[]) ?? []) {
        if (raw == null || typeof raw !== "object") continue;
        const item = raw as Node;
        let marker: string;
        if (typeof item.checked === "boolean") {
          marker = item.checked ? "[x] " : "[ ] ";
        } else {
          marker = ordered ? `${n}. ` : "• ";
        }
        // ListItem.content is an array of blocks. Render the first
        // paragraph's inlines on the bullet line; remaining blocks
        // (including nested lists) get indented underneath.
        const blocks = (item.content as unknown[]) ?? [];
        let firstLine = "";
        let rest: unknown[] = blocks;
        const first = blocks[0];
        if (
          first != null && typeof first === "object" &&
          (first as Node).type === "paragraph"
        ) {
          firstLine = renderInline(
            ((first as Node).content as unknown[]) ?? [],
          );
          rest = blocks.slice(1);
        }
        out += indent + BULLET(marker) + firstLine + "\n";
        for (const child of rest) {
          out += renderBlock(child, indent + "  ");
        }
        n++;
      }
      return out;
    }

    case "horizontal-rule":
      return indent + FAINT("─".repeat(60)) + "\n";

    case "table":
      return renderTable(node, indent);

    case "link-definition":
      // Reference definitions don't have a visible representation.
      return "";

    case "footnote-definition":
      return indent + FAINT(`[^${node.id}]: `) +
        ((node.content as string) ?? "") + "\n";

    case "html-block":
      return indent + ((node.content as string) ?? "") + "\n";

    case "frontmatter": {
      const data = (node.data as Record<string, unknown>) ?? {};
      const entries = Object.entries(data).map(
        ([k, v]) => `${k}: ${JSON.stringify(v)}`,
      );
      const lines = [FAINT("---"), ...entries.map((e) => FAINT(e)), FAINT("---")];
      return lines.map((l) => indent + l).join("\n") + "\n";
    }

    default:
      return "";
  }
}

function renderTable(node: Node, indent: string): string {
  const headers = ((node.headers as string[]) ?? []).slice();
  const rows = ((node.rows as string[][]) ?? []).map((r) => r.slice());
  const aligns = (node.alignments as (string | null)[]) ?? [];
  const widths = headers.map((h, i) => {
    let w = h.length;
    for (const r of rows) w = Math.max(w, (r[i] ?? "").length);
    return w;
  });
  const pad = (s: string, w: number, align: string | null): string => {
    if (align === "right") return s.padStart(w);
    if (align === "center") {
      const total = w - s.length;
      const left = Math.floor(total / 2);
      return " ".repeat(Math.max(0, left)) + s +
        " ".repeat(Math.max(0, total - left));
    }
    return s.padEnd(w);
  };
  const sepBar = FAINT(" │ ");
  const headLine = headers
    .map((h, i) => color.bold(pad(h, widths[i], aligns[i] ?? null)))
    .join(sepBar);
  const rule = widths.map((w) => "─".repeat(w)).join("─┼─");
  const body = rows
    .map((r) =>
      r
        .map((c, i) => pad(c ?? "", widths[i], aligns[i] ?? null))
        .join(sepBar)
    )
    .map((l) => indent + l)
    .join("\n");
  return indent + headLine + "\n" +
    indent + FAINT(rule) + "\n" +
    (body.length ? body + "\n" : "");
}

/** Render a Markdown AST (array of block nodes) to an ANSI-styled string
 *  suitable for direct printing in a terminal. Links use OSC 8 escapes so
 *  capable terminals render them as clickable hyperlinks. Code-block
 *  bodies are emitted verbatim — pre-walk them if you want syntax
 *  highlighting inside. */
export function _renderMarkdownForCli(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  // Each block's render output ends with a single "\n". Join with an
  // extra "\n" between blocks so paragraphs, headings, code blocks, etc.
  // get the customary blank line of separation in terminal output.
  return (blocks as unknown[])
    .map((b) => renderBlock(b))
    .filter((s) => s.length > 0)
    .join("\n");
}
