import { AgencyConfig } from "@/config.js";
import { generateAgency } from "@/backends/agencyGenerator.js";
import { parse, readFile } from "./commands.js";
import { findRecursively } from "./util.js";
import { AgencyNode, AgencyProgram, AgencyMultiLineComment } from "@/types.js";
import { codeFence } from "@/utils/markdown.js";
import { multiLineCommentParser } from "@/parsers/parsers.js";
import * as fs from "fs";
import * as path from "path";

type Kind = "prose" | "empty" | "code";
type Tagged = { kind: "prose" | "code"; node: AgencyNode };
type Segment =
  | { kind: "prose"; text: string }
  | { kind: "code"; nodes: AgencyNode[] };

// --- classification pipeline (declarative) -------------------------------

/** Base kind of a single node, ignoring context. */
function kindOf(node: AgencyNode): Kind {
  if (node.type === "multiLineComment") return "prose"; // /* */ and /** */
  if (node.type === "newLine") return "empty";
  return "code";
}

/** Nearest non-empty neighbor in `dir` direction. */
function neighbor(
  nodes: AgencyNode[],
  from: number,
  dir: 1 | -1,
): AgencyNode | undefined {
  for (let i = from + dir; i >= 0 && i < nodes.length; i += dir) {
    if (kindOf(nodes[i]) !== "empty") return nodes[i];
  }
  return undefined;
}

/**
 * Promote `empty` nodes to `code` when both neighbors are code (blank lines
 * inside a code run are preserved). Drop empty nodes everywhere else.
 */
function resolveEmpty(nodes: AgencyNode[]): Tagged[] {
  return nodes.flatMap((node, i): Tagged[] => {
    const k = kindOf(node);
    if (k === "prose" || k === "code") return [{ kind: k, node }];
    const prev = neighbor(nodes, i, -1);
    const next = neighbor(nodes, i, +1);
    const sandwichedByCode =
      !!prev && !!next && kindOf(prev) === "code" && kindOf(next) === "code";
    return sandwichedByCode ? [{ kind: "code", node }] : [];
  });
}

/** Collapse consecutive same-kind items into runs. */
function groupRuns(
  items: Tagged[],
): { kind: "prose" | "code"; items: Tagged[] }[] {
  return items.reduce<{ kind: "prose" | "code"; items: Tagged[] }[]>(
    (runs, item) => {
      const last = runs[runs.length - 1];
      if (last && last.kind === item.kind) last.items.push(item);
      else runs.push({ kind: item.kind, items: [item] });
      return runs;
    },
    [],
  );
}

/**
 * Strip the JSDoc-style ` * ` decoration that prefixes each line of a
 * multi-line block comment. Single-line comments are returned unchanged.
 *
 *   /**
 *    * Line one
 *    *
 *    * Line two
 *    *\/
 *
 * has raw content `"\n * Line one\n *\n * Line two\n "` which we want to
 * render as the prose `"Line one\n\nLine two"`.
 */
function stripJsdocStars(content: string): string {
  if (!content.includes("\n")) return content;
  return content
    .split("\n")
    .map((line) => line.replace(/^\s*\*\s?/, ""))
    .join("\n");
}

function classify(program: AgencyProgram): Segment[] {
  // NOTE: program.docComment is only populated by TypescriptPreprocessor,
  // which we deliberately skip. A module-level `/** */` is present as an
  // ordinary `multiLineComment` node in `program.nodes` and flows through
  // the prose branch below. Do NOT consult program.docComment — doing so
  // would double-emit the module doc.
  return groupRuns(resolveEmpty(program.nodes)).map((run): Segment => {
    if (run.kind === "prose") {
      return {
        kind: "prose",
        text: run.items
          .map((it) =>
            stripJsdocStars(
              (it.node as AgencyMultiLineComment).content,
            ).trim(),
          )
          .join("\n\n"),
      };
    }
    return { kind: "code", nodes: run.items.map((it) => it.node) };
  });
}

// --- rendering ------------------------------------------------------------

// One left-to-right pass over rendered code, matching whichever comes first:
// a string literal, a `//` line comment, or a `/* */` block comment. Strings
// and line comments are matched only so that a `/*` inside them is never read
// as the start of a block comment — the block comment is the only token we act
// on. Everything the regex does not match is ordinary code.
const CODE_TOKEN =
  /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;

/** Prose for a matched block-comment token, or "" for an empty comment. */
function commentProse(token: string): string {
  const parsed = multiLineCommentParser(token);
  if (!parsed.success) return "";
  return stripJsdocStars(parsed.result.content).trim();
}

/**
 * Split a rendered code string into markdown, pulling every multi-line comment
 * (`/* *\/` and `/** *\/`) out of the code and rendering it as prose between
 * two code fences. This is what lets a comment nested inside a `node` or `def`
 * body — one the segment classifier never sees, because it only inspects the
 * top-level nodes — read as literate prose. Single-line `//` comments are left
 * in the code, matching the convention that block comments narrate and inline
 * comments annotate.
 */
function weaveComments(code: string, lang: string): string {
  const parts: string[] = [];
  let codeBuf = "";

  const flushCode = (): void => {
    // The newline that ends the line *before* a lifted comment belongs to the
    // next code run, so after a comment is pulled out that run can start with a
    // blank line. Drop those leading blank lines (but keep the first real
    // line's indentation) so the reopened fence looks clean.
    const trimmed = codeBuf.replace(/^(?:[ \t]*\n)+/, "");
    if (trimmed.trim() !== "") parts.push(codeFence(trimmed, lang));
    codeBuf = "";
  };

  const token = new RegExp(CODE_TOKEN);
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = token.exec(code)) !== null) {
    codeBuf += code.slice(last, match.index);
    last = token.lastIndex;
    const tok = match[0];
    if (!tok.startsWith("/*")) {
      // A string literal or `//` comment: keep it in the code verbatim.
      codeBuf += tok;
      continue;
    }
    const prose = commentProse(tok);
    // An empty comment (`/**/`) leaves no prose. Drop just the comment token —
    // the surrounding whitespace stayed in the code runs — without splitting
    // the fence.
    if (prose === "") continue;
    flushCode();
    parts.push(prose);
  }
  codeBuf += code.slice(last);
  flushCode();
  return parts.join("\n\n");
}

function renderSegment(seg: Segment, lang: string): string {
  if (seg.kind === "prose") return seg.text;
  // `preserveOrder: true` keeps imports in their source position rather
  // than hoisting them to the top of the segment and sorting them. We
  // need this for literate output to faithfully reproduce the file in
  // source order.
  const code = generateAgency(
    { type: "agencyProgram", nodes: seg.nodes },
    { preserveOrder: true },
  );
  return weaveComments(code, lang);
}

function render(segments: Segment[], lang: string): string {
  if (segments.length === 0) return "";
  return segments.map((s) => renderSegment(s, lang)).join("\n\n") + "\n";
}

/** Windows paths use `\`; markdown URLs must use `/`. */
function toPosixPath(p: string): string {
  return p.split(path.sep).join("/");
}

/**
 * "View source" link placed at the top of a woven file. `baseUrl` points at
 * the root the source paths are relative to (e.g. a GitHub tree URL); `relPath`
 * is the source file's path within that root.
 */
function sourceLink(baseUrl: string, relPath: string): string {
  return `[View source](${baseUrl}/${toPosixPath(relPath)})`;
}

// --- I/O ------------------------------------------------------------------

function weaveFile(
  inputPath: string,
  outputPath: string,
  config: AgencyConfig,
  lang: string,
  source?: { baseUrl: string; relPath: string },
): void {
  // `applyTemplate: false` skips the implicit `import { ... } from "std::index"`
  // prelude that the parser normally injects. For literate output we want to
  // render exactly what the user wrote, nothing more.
  const program = parse(readFile(inputPath), config, false);
  const body = render(classify(program), lang);
  const parts: string[] = [];
  if (source) parts.push(sourceLink(source.baseUrl, source.relPath));
  if (body) parts.push(body.trimEnd());
  const md = parts.length > 0 ? parts.join("\n\n") + "\n" : "";
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, md);
}

export function generateLiterate(
  config: AgencyConfig,
  inputPath: string,
  outputDir: string,
  ignoreDirs: string[] = [],
  lang: string = "agency",
  baseUrlOverride?: string,
): void {
  // Trailing slashes are stripped so we can join with `/` unconditionally.
  const baseUrl = baseUrlOverride?.replace(/\/+$/, "");
  if (fs.statSync(inputPath).isDirectory()) {
    for (const { path: filePath } of findRecursively(
      inputPath,
      ".agency",
      [],
      ignoreDirs,
    )) {
      const relPath = path.relative(inputPath, filePath);
      const rel = relPath.replace(/\.agency$/, ".md");
      weaveFile(
        filePath,
        path.join(outputDir, rel),
        config,
        lang,
        baseUrl ? { baseUrl, relPath } : undefined,
      );
    }
  } else {
    const base = path.basename(inputPath).replace(/\.agency$/, ".md");
    weaveFile(
      inputPath,
      path.join(outputDir, base),
      config,
      lang,
      baseUrl ? { baseUrl, relPath: path.basename(inputPath) } : undefined,
    );
  }
}
