import { syntaxHighlight } from "@/stdlib/syntax.js";

import type { LabelingSessionController } from "./controller.js";
import type { SessionAction, SessionSnapshot } from "./session.js";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";
const MAGENTA = "\x1b[35m";
const CYAN = "\x1b[36m";
const GREY = "\x1b[90m";
const ON_BLUE = "\x1b[44m";
const STRIKE = "\x1b[9m";

/**
 * Two kinds of zero-width escape appear in highlighted markdown: SGR colour
 * codes, and OSC 8 hyperlinks, which carry a whole URL that occupies no
 * columns. Counting either as visible text throws the column arithmetic off
 * badly, and the outputs being labelled are link-dense.
 */
const ESCAPE_SOURCE = "\\x1b\\[[0-9;]*m|\\x1b\\]8;;[^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)";

/** Highlighting is a nice-to-have; showing the actual output is not. */
const CONTENT_KEEP_RATIO = 0.9;
const SCROLL_PAGE_MARGIN = 12;

export function stripAnsi(text: string): string {
  return text.replace(new RegExp(ESCAPE_SOURCE, "g"), "");
}

export function visibleLength(text: string): number {
  return stripAnsi(text).length;
}

/** Split into units of one escape sequence or one visible character, so
 *  wrapping counts what the eye sees. */
function units(text: string): string[] {
  // The (?:...) group is load-bearing: "^a|b" parses as "(^a)|(b)", so without
  // it the second alternative is unanchored and matches anywhere in the rest
  // of the string, eating every visible character in between.
  const anchored = new RegExp(`^(?:${ESCAPE_SOURCE})`);
  const out: string[] = [];
  let index = 0;
  while (index < text.length) {
    const match = text.slice(index).match(anchored);
    if (match !== null) {
      out.push(match[0]);
      index += match[0].length;
    } else {
      out.push(text[index]);
      index += 1;
    }
  }
  return out;
}

/** Wrap highlighted text, breaking at spaces where possible and hard-breaking
 *  tokens longer than the column. Styles reset at each break rather than being
 *  carried, which keeps colour from bleeding down the pane. */
export function wrapAnsi(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let current: string[] = [];
    let visible = 0;
    let lastBreak = -1;
    for (const unit of units(paragraph)) {
      const isEscape = unit.length > 1;
      if (!isEscape && unit === " ") {
        lastBreak = current.length;
      }
      current.push(unit);
      if (!isEscape) {
        visible += 1;
      }
      if (visible >= width) {
        const cut = lastBreak > 0 ? lastBreak : current.length;
        lines.push(current.slice(0, cut).join("") + RESET);
        current = current.slice(lastBreak > 0 ? cut + 1 : cut);
        visible = current.filter((entry) => entry.length === 1).length;
        lastBreak = -1;
      }
    }
    lines.push(current.join("") + RESET);
  }
  return lines;
}

function contentWords(text: string): string[] {
  const withoutUrls = text.replace(/https?:\/\/\S+/g, " ");
  return (withoutUrls.match(/[A-Za-z]{5,}/g) ?? []).map((word) => word.toLowerCase());
}

/**
 * Highlight markdown, but fall back to plain text if the render lost content.
 *
 * A renderer that silently drops most of a document still produces a screen
 * that looks plausible, which is the worst possible failure for a tool whose
 * whole job is showing you what to judge.
 */
export function renderMarkdownSafely(source: string): string {
  let rendered: string;
  try {
    rendered = syntaxHighlight(source, "markdown");
  } catch {
    return source;
  }
  const wanted = contentWords(source);
  if (wanted.length === 0) {
    return rendered;
  }
  const present = new Set(contentWords(stripAnsi(rendered)));
  const kept = wanted.filter((word) => present.has(word)).length;
  return kept / wanted.length >= CONTENT_KEEP_RATIO ? rendered : source;
}

function pad(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleLength(text)));
}

export type RenderArgs = {
  snapshot: SessionSnapshot;
  storeLabel: string;
  columns: number;
  rows: number;
  scroll: number;
  body: string[];
};

/** Build the whole frame as a string. Pure, so the layout is testable without
 *  a terminal. */
export function renderLabelScreen(args: RenderArgs): string {
  const { snapshot } = args;
  const leftWidth = Math.floor(args.columns * 0.6);
  const rightWidth = args.columns - leftWidth - 3;
  const bodyHeight = Math.max(8, args.rows - 10);

  const out: string[] = [];
  const staleNote = snapshot.progress.stale > 0
    ? `  ${YELLOW}⟳ ${snapshot.progress.stale} stale${RESET}`
    : "";
  out.push(
    ` ${ON_BLUE}${BOLD} eval label ${RESET} ${GREY}${args.storeLabel}${RESET}  ` +
    `${BOLD}${GREEN}${snapshot.progress.reviewed}${RESET}${DIM}/${snapshot.progress.total} reviewed${RESET}${staleNote}`,
  );
  out.push(`${GREY}${"━".repeat(args.columns)}${RESET}`);

  const item = snapshot.currentItem;
  if (item === null) {
    out.push(" nothing to label");
    return out.join("\n");
  }

  const status = snapshot.statuses[item.outputId] ?? "untouched";
  const chip = {
    untouched: `${GREY}○ untouched${RESET}`,
    reviewed: `${GREEN}● reviewed${RESET}`,
    stale: `${YELLOW}⟳ stale — a question was added since${RESET}`,
  }[status];
  const score = snapshot.scores[item.outputId];
  const scoreText = score === null || score === undefined
    ? `${GREY}—${RESET}`
    : `${scoreColour(score)}${BOLD}${score.toFixed(2)}${RESET}`;
  out.push(
    ` ${BOLD}${CYAN}${item.outputId.slice(0, 12)}${RESET} ` +
    `${GREY}${snapshot.itemIndex + 1}/${snapshot.items.length}${RESET}  ${chip}  ${scoreText}`,
  );
  out.push(` ${DIM}${item.task.slice(0, args.columns - 4)}${RESET}`);
  out.push("");

  const checklist = renderChecklist(snapshot, rightWidth);
  const visibleBody = args.body.slice(args.scroll, args.scroll + bodyHeight);
  for (let row = 0; row < bodyHeight; row += 1) {
    out.push(`${pad(visibleBody[row] ?? "", leftWidth)}${GREY}│${RESET} ${checklist[row] ?? ""}`);
  }

  out.push(`${GREY}${"━".repeat(args.columns)}${RESET}`);
  out.push(renderFooter(snapshot));
  return out.join("\n");
}

function scoreColour(score: number): string {
  if (score >= 0.75) {
    return GREEN;
  }
  if (score >= 0.4) {
    return YELLOW;
  }
  return MAGENTA;
}

/** A deleted question keeps its place in the list, struck through, because it
 *  still holds every answer recorded against it. */
function checkbox(deleted: boolean, checked: boolean): string {
  if (deleted) {
    return `${GREY}[·]${RESET}`;
  }
  if (checked) {
    return `${GREEN}${BOLD}[✓]${RESET}`;
  }
  return `${GREY}[ ]${RESET}`;
}

function questionStyle(deleted: boolean, focused: boolean, checked: boolean): string {
  if (deleted) {
    return `${STRIKE}${GREY}`;
  }
  if (focused) {
    return BOLD;
  }
  if (checked) {
    return "";
  }
  return DIM;
}

function renderChecklist(snapshot: SessionSnapshot, width: number): string[] {
  const lines: string[] = [];
  snapshot.questions.forEach((question, index) => {
    const checked = snapshot.answers[question.id] === true;
    const deleted = question.deleted;
    const focused = index === snapshot.questionIndex;
    const box = checkbox(deleted, checked);
    const arrow = focused ? `${CYAN}${BOLD}▸${RESET}` : " ";
    const style = questionStyle(deleted, focused, checked);
    const wrapped = wrapAnsi(question.text, Math.max(8, width - 7));
    lines.push(`${arrow} ${box} ${style}${wrapped[0] ?? ""}${RESET}`);
    for (const continuation of wrapped.slice(1)) {
      lines.push(`     ${style}${continuation}${RESET}`);
    }
  });
  lines.push("");
  lines.push(`${BLUE}${BOLD}note${RESET} ${snapshot.note.length === 0 ? `${GREY}—${RESET}` : ""}`);
  for (const line of snapshot.note.length === 0 ? [] : wrapAnsi(snapshot.note, Math.max(8, width - 2))) {
    lines.push(` ${line}`);
  }
  return lines;
}

function renderFooter(snapshot: SessionSnapshot): string {
  if (snapshot.editor.kind === "question") {
    return ` ${BOLD}${YELLOW}new question${RESET} ${snapshot.editor.draft}${CYAN}▏${RESET}\n` +
      ` ${DIM}enter: add to every item   esc: cancel${RESET}`;
  }
  if (snapshot.editor.kind === "note") {
    return ` ${BOLD}${BLUE}note${RESET} ${snapshot.editor.draft}${CYAN}▏${RESET}\n` +
      ` ${DIM}enter: save   esc: cancel${RESET}`;
  }
  const deleteLabel = snapshot.currentQuestion?.deleted === true ? "undelete" : "delete";
  return ` ${BOLD}space${RESET}${GREY} toggle${RESET}  ${BOLD}↑↓${RESET}${GREY} question${RESET}  ` +
    `${BOLD}←→${RESET}${GREY} item${RESET}  ${BOLD}enter${RESET}${GREY} reviewed+next${RESET}  ` +
    `${BOLD}a${RESET}${GREY} add${RESET}  ${BOLD}d${RESET}${GREY} ${deleteLabel}${RESET}  ` +
    `${BOLD}m${RESET}${GREY} note${RESET}  ${BOLD}^f/^b${RESET}${GREY} scroll${RESET}  ` +
    `${BOLD}q${RESET}${GREY} quit${RESET}`;
}

// --- input ---------------------------------------------------------------

export type Key =
  | { kind: "up" } | { kind: "down" } | { kind: "left" } | { kind: "right" }
  | { kind: "pageUp" } | { kind: "pageDown" }
  | { kind: "enter" } | { kind: "escape" } | { kind: "backspace" }
  | { kind: "char"; value: string };

/** Escape sequences arrive as one chunk, so parse the chunk rather than
 *  inspecting characters in isolation. */
export function parseKeys(chunk: string): Key[] {
  const keys: Key[] = [];
  let index = 0;
  while (index < chunk.length) {
    const rest = chunk.slice(index);
    if (rest.startsWith("\x1b[5~")) { keys.push({ kind: "pageUp" }); index += 4; continue; }
    if (rest.startsWith("\x1b[6~")) { keys.push({ kind: "pageDown" }); index += 4; continue; }
    if (rest.startsWith("\x1b[A")) { keys.push({ kind: "up" }); index += 3; continue; }
    if (rest.startsWith("\x1b[B")) { keys.push({ kind: "down" }); index += 3; continue; }
    if (rest.startsWith("\x1b[C")) { keys.push({ kind: "right" }); index += 3; continue; }
    if (rest.startsWith("\x1b[D")) { keys.push({ kind: "left" }); index += 3; continue; }
    const character = chunk[index];
    if (character === "\x1b") { keys.push({ kind: "escape" }); index += 1; continue; }
    if (character === "\r" || character === "\n") { keys.push({ kind: "enter" }); index += 1; continue; }
    if (character === "\x7f") { keys.push({ kind: "backspace" }); index += 1; continue; }
    keys.push({ kind: "char", value: character });
    index += 1;
  }
  return keys;
}

/** Translate a keystroke into a domain action. Returns null for keys that are
 *  handled by the loop itself (scrolling, quitting) or ignored. */
export function actionForKey(key: Key, editing: boolean): SessionAction | null {
  if (editing) {
    if (key.kind === "enter") return { kind: "submitEditor" };
    if (key.kind === "escape") return { kind: "cancelEditor" };
    if (key.kind === "backspace") return { kind: "backspaceEditor" };
    if (key.kind === "char" && key.value >= " ") {
      return { kind: "appendEditorText", text: key.value };
    }
    return null;
  }
  switch (key.kind) {
    case "up": return { kind: "previousQuestion" };
    case "down": return { kind: "nextQuestion" };
    case "left": return { kind: "previousItem" };
    case "right": return { kind: "nextItem" };
    case "enter": return { kind: "signOff" };
    case "char":
      if (key.value === " ") return { kind: "toggleAnswer" };
      if (key.value === "a") return { kind: "beginQuestion" };
      if (key.value === "d") return { kind: "toggleQuestionDeleted" };
      if (key.value === "m") return { kind: "beginNote" };
      return null;
    default:
      return null;
  }
}

export function scrollDelta(key: Key, rows: number): number {
  const page = Math.max(4, rows - SCROLL_PAGE_MARGIN);
  const half = Math.max(2, Math.floor(page / 2));
  if (key.kind === "pageDown") return page;
  if (key.kind === "pageUp") return -page;
  if (key.kind !== "char") return 0;
  if (key.value === "\x06") return page;
  if (key.value === "\x02") return -page;
  if (key.value === "\x04") return half;
  if (key.value === "\x15") return -half;
  return 0;
}

export function isQuitKey(key: Key): boolean {
  return key.kind === "char" && (key.value === "q" || key.value === "\x03");
}

// --- the loop ------------------------------------------------------------

export type RunLabelTuiArgs = {
  controller: LabelingSessionController;
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
};

export async function runLabelTui(args: RunLabelTuiArgs): Promise<void> {
  assertInteractiveTerminal(args.input, args.output);
  const restore = enterTerminalMode(args.input);
  try {
    await runInputLoop(args);
  } finally {
    restore();
  }
}

function assertInteractiveTerminal(input: NodeJS.ReadStream, output: NodeJS.WriteStream): void {
  if (input.isTTY !== true || output.isTTY !== true) {
    throw new Error(
      "agency eval label needs an interactive terminal: it shows outputs and reads keystrokes. " +
      "Run it directly rather than through a pipe.",
    );
  }
}

function enterTerminalMode(input: NodeJS.ReadStream): () => void {
  const wasRaw = input.isRaw === true;
  input.setRawMode(true);
  input.resume();
  input.setEncoding("utf8");
  return () => {
    // Restoring must happen even when the loop threw, or the caller's shell is
    // left in raw mode with no echo.
    input.setRawMode(wasRaw);
    input.pause();
  };
}

async function runInputLoop(args: RunLabelTuiArgs): Promise<void> {
  let scroll = 0;
  let bodyCache: { outputId: string; width: number; lines: string[] } | undefined;

  const draw = (): void => {
    const snapshot = args.controller.snapshot();
    const columns = args.output.columns ?? 100;
    const rows = args.output.rows ?? 30;
    const leftWidth = Math.floor(columns * 0.6) - 1;
    const item = snapshot.currentItem;
    if (item !== null && (bodyCache?.outputId !== item.outputId || bodyCache?.width !== leftWidth)) {
      // Highlighting parses the whole document, which is far too slow to redo
      // on every keystroke.
      bodyCache = {
        outputId: item.outputId,
        width: leftWidth,
        lines: renderMarkdownSafely(item.text).split("\n")
          .flatMap((line) => wrapAnsi(line, leftWidth)),
      };
    }
    args.output.write(`\x1b[2J\x1b[H${renderLabelScreen({
      snapshot, storeLabel: "", columns, rows, scroll, body: bodyCache?.lines ?? [],
    })}\n`);
  };

  draw();

  await new Promise<void>((resolve, reject) => {
    const onData = (chunk: string): void => {
      void (async () => {
        try {
          for (const key of parseKeys(chunk)) {
            const snapshot = args.controller.snapshot();
            const editing = snapshot.editor.kind !== "none";
            if (!editing && isQuitKey(key)) {
              args.input.off("data", onData);
              resolve();
              return;
            }
            const previousItem = snapshot.currentItem?.outputId;
            const action = actionForKey(key, editing);
            if (action !== null) {
              const next = await args.controller.dispatch(action);
              if (next.currentItem?.outputId !== previousItem) {
                scroll = 0;
              }
            }
            scroll = Math.max(0, scroll + scrollDelta(key, args.output.rows ?? 30));
          }
          draw();
        } catch (error) {
          args.input.off("data", onData);
          reject(error);
        }
      })();
    };
    args.input.on("data", onData);
  });
}
