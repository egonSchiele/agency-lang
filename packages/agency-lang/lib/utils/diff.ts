import DiffMatchPatch from "diff-match-patch";
import { color } from "./termcolors.js";

const DIFF_DELETE = -1;
const DIFF_INSERT = 1;
const DIFF_EQUAL = 0;

const dmp = new DiffMatchPatch();

type Diff = [number, string];

export type DiffLine = {
  kind: "context" | "delete" | "insert";
  text: string;
  oldNum: number | null;
  newNum: number | null;
};

export type Hunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
};

export type RenderDiffOpts = {
  lineNumbers?: boolean;
  colored?: boolean;
  oldLabel?: string;
  newLabel?: string;
  hunkHeaders?: boolean;
  summary?: boolean;
  // When present and `colored`, renderDiff uses the highlighted code path:
  // each line's body is produced by this function (syntax highlighting +
  // background tint for changed lines), padded to `width` columns.
  renderBody?: (code: string, kind: DiffLine["kind"], width: number) => string;
};

// Collapse runs of whitespace and trim, for comparison only (the original
// line text is preserved for rendering).
function normalizeLine(line: string): string {
  return line.replace(/\s+/g, " ").trim();
}

// "" is zero lines; otherwise split on newline, KEEPING a trailing empty
// element so a trailing newline survives a patch round-trip.
function splitTextLines(text: string): string[] {
  return text === "" ? [] : text.split("\n");
}

// Encode each unique line as a single char so diff_main runs at line
// granularity. Caps at ~65k unique lines, plenty for stdlib diffs.
function encodeLines(lines: string[], map: Map<string, number>, arr: string[]): string {
  let s = "";
  for (const line of lines) {
    let idx = map.get(line);
    if (idx === undefined) {
      if (arr.length >= 0x10000) {
        // One char per unique line; beyond 0xFFFF, String.fromCharCode wraps
        // into already-used code units and silently corrupts the diff.
        throw new Error(
          "diff: inputs have more than 65535 unique lines, which exceeds the line-diff limit",
        );
      }
      idx = arr.length;
      arr.push(line);
      map.set(line, idx);
    }
    s += String.fromCharCode(idx);
  }
  return s;
}

// Flat, line-by-line diff with old/new line numbers attached.
function diffLines(oldText: string, newText: string, ignoreWhitespace: boolean): DiffLine[] {
  const oldLines = splitTextLines(oldText);
  const newLines = splitTextLines(newText);
  const key = ignoreWhitespace ? normalizeLine : (s: string) => s;

  const map = new Map<string, number>();
  const arr: string[] = [];
  const enc1 = encodeLines(oldLines.map(key), map, arr);
  const enc2 = encodeLines(newLines.map(key), map, arr);
  const diffs = dmp.diff_main(enc1, enc2, false) as Diff[];

  const out: DiffLine[] = [];
  let oi = 0;
  let ni = 0;
  for (const [op, chunk] of diffs) {
    for (let k = 0; k < chunk.length; k++) {
      if (op === DIFF_EQUAL) {
        out.push({ kind: "context", text: newLines[ni], oldNum: oi + 1, newNum: ni + 1 });
        oi++;
        ni++;
      } else if (op === DIFF_DELETE) {
        out.push({ kind: "delete", text: oldLines[oi], oldNum: oi + 1, newNum: null });
        oi++;
      } else {
        out.push({ kind: "insert", text: newLines[ni], oldNum: null, newNum: ni + 1 });
        ni++;
      }
    }
  }
  return out;
}

// The old/new line number of the last numbered line before `start`, or 0 if
// none. Used to anchor the hunk header for insert-only / delete-only hunks,
// which carry no line number of their own on one side.
function anchorsBefore(lines: DiffLine[], start: number): { prevOld: number; prevNew: number } {
  let prevOld = 0;
  let prevNew = 0;
  for (let k = start - 1; k >= 0; k--) {
    if (prevOld === 0 && lines[k].oldNum !== null) prevOld = lines[k].oldNum as number;
    if (prevNew === 0 && lines[k].newNum !== null) prevNew = lines[k].newNum as number;
    if (prevOld !== 0 && prevNew !== 0) break;
  }
  return { prevOld, prevNew };
}

function makeHunk(lines: DiffLine[], prevOld: number, prevNew: number): Hunk {
  const oldNos = lines.filter((l) => l.oldNum !== null).map((l) => l.oldNum as number);
  const newNos = lines.filter((l) => l.newNum !== null).map((l) => l.newNum as number);
  return {
    // For a side with no lines of its own (pure insertion / deletion), the
    // unified-diff start is the line number it sits *after*: the preceding
    // numbered line, or 0 at the start of file.
    oldStart: oldNos.length ? oldNos[0] : prevOld,
    oldLines: oldNos.length,
    newStart: newNos.length ? newNos[0] : prevNew,
    newLines: newNos.length,
    lines,
  };
}

/**
 * Compute a line-level diff grouped into hunks.
 * `context < 0` -> one hunk spanning everything (full context).
 * `context >= 0` -> keep only changed lines plus `context` unchanged lines on
 * each side; runs separated by more than 2*context unchanged lines split into
 * separate hunks.
 */
export function computeHunks(
  oldText: string,
  newText: string,
  context: number,
  ignoreWhitespace: boolean,
): Hunk[] {
  const lines = diffLines(oldText, newText, ignoreWhitespace);
  if (lines.length === 0) return [];
  if (context < 0) return [makeHunk(lines, 0, 0)];

  const include: boolean[] = new Array(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].kind !== "context") {
      const lo = Math.max(0, i - context);
      const hi = Math.min(lines.length - 1, i + context);
      for (let j = lo; j <= hi; j++) include[j] = true;
    }
  }

  const hunks: Hunk[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!include[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < lines.length && include[j]) j++;
    const { prevOld, prevNew } = anchorsBefore(lines, i);
    hunks.push(makeHunk(lines.slice(i, j), prevOld, prevNew));
    i = j;
  }
  return hunks;
}

// Render one side of a replacement with the changed words highlighted.
function highlightLine(oldLine: string, newLine: string, side: number): string {
  const prefix = side === DIFF_DELETE ? "- " : "+ ";
  const sideColor = side === DIFF_DELETE ? color.red : color.green;
  const wordDiffs = dmp.diff_main(oldLine, newLine) as Diff[];
  dmp.diff_cleanupSemantic(wordDiffs);

  let body = "";
  for (const [op, text] of wordDiffs) {
    if (op === DIFF_EQUAL) body += color.dim(text);
    else if (op === side) body += sideColor(text);
  }
  return sideColor(prefix) + body;
}

function renderReplacement(
  dels: DiffLine[],
  inss: DiffLine[],
  out: string[],
  colored: boolean,
  gutter: (l: DiffLine) => string,
): void {
  const paired = Math.min(dels.length, inss.length);
  for (let k = 0; k < dels.length; k++) {
    const body =
      colored && k < paired
        ? highlightLine(dels[k].text, inss[k].text, DIFF_DELETE)
        : colored
          ? color.red(`- ${dels[k].text}`)
          : `- ${dels[k].text}`;
    out.push(gutter(dels[k]) + body);
  }
  for (let k = 0; k < inss.length; k++) {
    const body =
      colored && k < paired
        ? highlightLine(dels[k].text, inss[k].text, DIFF_INSERT)
        : colored
          ? color.green(`+ ${inss[k].text}`)
          : `+ ${inss[k].text}`;
    out.push(gutter(inss[k]) + body);
  }
}

function renderHunkBody(
  lines: DiffLine[],
  out: string[],
  colored: boolean,
  gutter: (l: DiffLine) => string,
): void {
  const paint = (fn: (t: string) => string, t: string) => (colored ? fn(t) : t);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.kind === "context") {
      out.push(gutter(line) + paint(color.dim, `  ${line.text}`));
      i++;
    } else if (line.kind === "delete") {
      let d = i;
      while (d < lines.length && lines[d].kind === "delete") d++;
      let n = d;
      while (n < lines.length && lines[n].kind === "insert") n++;
      renderReplacement(lines.slice(i, d), lines.slice(d, n), out, colored, gutter);
      i = n;
    } else {
      out.push(gutter(line) + paint(color.green, `+ ${line.text}`));
      i++;
    }
  }
}

function gutterWidth(hunks: Hunk[]): number {
  let max = 0;
  for (const h of hunks)
    for (const l of h.lines) {
      const n = l.kind === "delete" ? l.oldNum : l.newNum;
      if (n !== null) max = Math.max(max, n);
    }
  return String(max).length;
}

// Widest raw line in display columns (line text is ANSI-free, so length is the
// visible width). Changed-line backgrounds pad to this so the bars align.
function blockWidth(hunks: Hunk[]): number {
  let max = 0;
  for (const h of hunks) for (const l of h.lines) max = Math.max(max, l.text.length);
  return max;
}

// Gutter for the highlighted path: line number (per side) + the -/+/space
// marker, colored by change kind (sits on the default background, left of the
// tinted code).
function highlightGutter(line: DiffLine, numWidth: number, lineNumbers: boolean): string {
  const marker = line.kind === "delete" ? "-" : line.kind === "insert" ? "+" : " ";
  const num = line.kind === "delete" ? line.oldNum : line.newNum;
  const numStr = lineNumbers ? `${(num === null ? "" : String(num)).padStart(numWidth)} ` : "";
  const cell = `${numStr}${marker} `;
  if (line.kind === "delete") return color.red(cell);
  if (line.kind === "insert") return color.green(cell);
  return color.dim(cell);
}

/** Render hunks as a human-readable diff string. */
export function renderDiff(hunks: Hunk[], opts: RenderDiffOpts = {}): string {
  const colored = opts.colored ?? false;
  const paint = (fn: (t: string) => string, t: string) => (colored ? fn(t) : t);
  const out: string[] = [];

  if (opts.summary) {
    let ins = 0;
    let del = 0;
    for (const h of hunks)
      for (const l of h.lines) {
        if (l.kind === "insert") ins++;
        else if (l.kind === "delete") del++;
      }
    out.push(`${ins} insertion${ins === 1 ? "" : "s"}, ${del} deletion${del === 1 ? "" : "s"}`);
  }
  if (opts.oldLabel) out.push(paint(color.red, `--- ${opts.oldLabel}`));
  if (opts.newLabel) out.push(paint(color.green, `+++ ${opts.newLabel}`));

  const useHighlight = colored && !!opts.renderBody;
  const numWidth = opts.lineNumbers ? gutterWidth(hunks) : 0;
  const blockW = useHighlight ? blockWidth(hunks) : 0;

  const gutter = (l: DiffLine): string => {
    if (!opts.lineNumbers) return "";
    const n = l.kind === "delete" ? l.oldNum : l.newNum;
    return `${(n === null ? "" : String(n)).padStart(numWidth)} `;
  };

  for (const h of hunks) {
    if (opts.hunkHeaders) {
      out.push(paint(color.cyan, `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`));
    }
    if (useHighlight) {
      for (const line of h.lines) {
        out.push(
          highlightGutter(line, numWidth, opts.lineNumbers ?? false) +
            opts.renderBody!(line.text, line.kind, blockW),
        );
      }
    } else {
      renderHunkBody(h.lines, out, colored, gutter);
    }
  }
  return out.join("\n");
}

/** Render hunks as a standard unified diff that std::fs::applyPatch can apply. */
export function renderPatch(hunks: Hunk[], oldLabel: string, newLabel: string): string {
  if (hunks.length === 0) return "";
  const out: string[] = [`--- ${oldLabel}`, `+++ ${newLabel}`];
  for (const h of hunks) {
    out.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`);
    for (const l of h.lines) {
      if (l.kind === "context") out.push(` ${l.text}`);
      else if (l.kind === "delete") out.push(`-${l.text}`);
      else out.push(`+${l.text}`);
    }
  }
  return out.join("\n") + "\n";
}

/**
 * Back-compat shim: full-context, colored-by-default inline diff. Existing
 * callers (optimizer reporter, test runner, sourceMutator) rely on this exact
 * output, so it must not change.
 */
export function formatDiff(
  expected: string,
  actual: string,
  opts: { colorize?: boolean } = {},
): string {
  const hunks = computeHunks(expected, actual, -1, false);
  return renderDiff(hunks, { colored: opts.colorize ?? true });
}
