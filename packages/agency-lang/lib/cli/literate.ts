import { AgencyConfig } from "@/config.js";
import { generateAgency } from "@/backends/agencyGenerator.js";
import { parse, readFile } from "./commands.js";
import { findRecursively } from "./util.js";
import { AgencyNode, AgencyProgram, AgencyMultiLineComment } from "@/types.js";
import { codeFence } from "@/utils/markdown.js";
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
  return codeFence(code, lang); // codeFence handles trimEnd + fence escalation
}

function render(segments: Segment[], lang: string): string {
  if (segments.length === 0) return "";
  return segments.map((s) => renderSegment(s, lang)).join("\n\n") + "\n";
}

// --- I/O ------------------------------------------------------------------

function weaveFile(
  inputPath: string,
  outputPath: string,
  config: AgencyConfig,
  lang: string,
): void {
  // `applyTemplate: false` skips the implicit `import { ... } from "std::index"`
  // prelude that the parser normally injects. For literate output we want to
  // render exactly what the user wrote, nothing more.
  const program = parse(readFile(inputPath), config, false);
  const md = render(classify(program), lang);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, md);
}

export function generateLiterate(
  config: AgencyConfig,
  inputPath: string,
  outputDir: string,
  ignoreDirs: string[] = [],
  lang: string = "agency",
): void {
  if (fs.statSync(inputPath).isDirectory()) {
    for (const { path: filePath } of findRecursively(
      inputPath,
      ".agency",
      [],
      ignoreDirs,
    )) {
      const rel = path
        .relative(inputPath, filePath)
        .replace(/\.agency$/, ".md");
      weaveFile(filePath, path.join(outputDir, rel), config, lang);
    }
  } else {
    const base = path.basename(inputPath).replace(/\.agency$/, ".md");
    weaveFile(inputPath, path.join(outputDir, base), config, lang);
  }
}
