import { stripAnsi, visualWidth, wrapText } from "@/stdlib/layout/ansi.js";
import { syntaxHighlight } from "@/stdlib/syntax.js";
import { column, line, lines, row } from "@/tui/builders.js";
import { escapeStyleTags } from "@/tui/styleParser.js";
import type { Element, Style } from "@/tui/elements.js";
import type { KeyEvent } from "@/tui/input/types.js";
import type { Screen } from "@/tui/screen.js";
import { followCursor } from "@/tui/scroll.js";
import { color } from "@/utils/termcolors.js";

import type { LabelingSessionController } from "./controller.js";
import type { SessionAction, SessionSnapshot } from "./session.js";
import type { Fields } from "./types.js";

/** Highlighting is a nice-to-have; showing the actual output is not. */
const CONTENT_KEEP_RATIO = 0.9;
const LEFT_PANE_FRACTION = 0.6;
/** Rows the header, rules and footer occupy, leaving the rest for the panes. */
const CHROME_ROWS = 7;

export { stripAnsi, visualWidth };

/**
 * Neutralize control characters in text this tool did not author.
 *
 * Agent output, task text, question text and notes are all untrusted: a model
 * can emit cursor movement, clear-screen, or OSC 52 clipboard writes, and
 * rendering those raw would let the thing being judged hide or forge the
 * evidence on screen. Only newline and tab survive, because the layout uses
 * them; everything else in C0, C1 and DEL becomes a visible replacement so the
 * reader can see something was there.
 *
 * Style tags are escaped too. The TUI parser reads `{black-fg}` as markup, so
 * plain text alone is enough to restyle or hide the very evidence being
 * judged — control characters are not the only way into a terminal.
 *
 * Styling is applied afterwards, so the tool's own colour is unaffected.
 */
export function stripControlCharacters(text: string): string {
  let out = "";
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (character === "\n" || character === "\t") {
      out += character;
      continue;
    }
    const isC0 = code < 0x20;
    const isDelete = code === 0x7f;
    const isC1 = code >= 0x80 && code <= 0x9f;
    out += isC0 || isDelete || isC1 ? "�" : character;
  }
  return out;
}

export function sanitizeUntrusted(text: string): string {
  return escapeStyleTags(stripControlCharacters(text));
}

/**
 * Clipboard text, made safe for a single-line editor.
 *
 * Newlines and tabs are collapsed to spaces because the draft renders on one
 * footer row, and every other control character is dropped rather than
 * replaced — a paste is the user's own text, so a visible replacement marker
 * would be noise rather than evidence.
 */
export function pastedText(text: string): string {
  let out = "";
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (character === "\n" || character === "\r" || character === "\t") {
      out += " ";
      continue;
    }
    const isControl = code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
    if (!isControl) {
      out += character;
    }
  }
  return out;
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

// --- rendering -----------------------------------------------------------

/** A deleted question keeps its place in the list, struck through, because it
 *  still holds every answer recorded against it. */
function checkbox(deleted: boolean, checked: boolean): string {
  if (deleted) {
    return color.brightBlack("[·]");
  }
  if (checked) {
    return color.bold.green("[✓]");
  }
  return color.brightBlack("[ ]");
}

/** Returns a styler rather than an escape prefix, so callers wrap text. */
function questionStyle(deleted: boolean, focused: boolean, checked: boolean) {
  if (deleted) {
    return color.strikethrough.brightBlack;
  }
  if (focused) {
    return color.bold;
  }
  if (checked) {
    return (text: string) => text;
  }
  return color.dim;
}

function scoreStyle(score: number) {
  if (score >= 0.75) {
    return color.bold.green;
  }
  if (score >= 0.4) {
    return color.bold.yellow;
  }
  return color.bold.magenta;
}

export type ChecklistRender = { lines: string[]; focusLine: number };

/** The right pane's lines, plus which line the focused question starts on so
 *  the viewport can keep it visible. */
export function renderChecklist(snapshot: SessionSnapshot, width: number): ChecklistRender {
  const out: string[] = [];
  let focusLine = 0;
  snapshot.questions.forEach((question, index) => {
    const checked = snapshot.answers[question.id] === true;
    const focused = index === snapshot.questionIndex;
    if (focused) {
      focusLine = out.length;
    }
    const style = questionStyle(question.deleted, focused, checked);
    const wrapped = wrapText(sanitizeUntrusted(question.text), Math.max(8, width - 7));
    const arrow = focused ? color.bold.cyan("▸") : " ";
    out.push(`${arrow} ${checkbox(question.deleted, checked)} ${style(wrapped[0] ?? "")}`);
    for (const continuation of wrapped.slice(1)) {
      out.push(`     ${style(continuation)}`);
    }
  });
  out.push("");
  out.push(`${color.bold.blue("note")} ${snapshot.note.length === 0 ? color.brightBlack("—") : ""}`);
  const noteLines = snapshot.note.length === 0
    ? []
    : wrapText(sanitizeUntrusted(snapshot.note), Math.max(8, width - 2));
  for (const noteLine of noteLines) {
    out.push(` ${noteLine}`);
  }
  return { lines: out, focusLine };
}

function statusChip(status: string): string {
  if (status === "reviewed") {
    return color.green("● reviewed");
  }
  if (status === "stale") {
    return color.yellow("⟳ stale — a question was added since");
  }
  return color.brightBlack("○ untouched");
}

function headerLine(snapshot: SessionSnapshot, storeLabel: string): string {
  const stale = snapshot.progress.stale > 0
    ? `  ${color.yellow(`⟳ ${snapshot.progress.stale} stale`)}`
    : "";
  return ` ${color.bgBlue.bold(" eval label ")} ${color.brightBlack(sanitizeUntrusted(storeLabel))}  ` +
    `${color.bold.green(String(snapshot.progress.reviewed))}` +
    `${color.dim(`/${snapshot.progress.total} reviewed`)}${stale}`;
}

function itemLine(snapshot: SessionSnapshot): string {
  const item = snapshot.currentItem;
  if (item === null) {
    return "";
  }
  const score = snapshot.scores[item.outputId];
  const scoreText = score === null || score === undefined
    ? color.brightBlack("—")
    : scoreStyle(score)(score.toFixed(2));
  return ` ${color.bold.cyan(item.outputId.slice(0, 12))} ` +
    `${color.brightBlack(`${snapshot.itemIndex + 1}/${snapshot.items.length}`)}  ` +
    `${statusChip(snapshot.statuses[item.outputId] ?? "untouched")}  ${scoreText}`;
}

function footerLines(snapshot: SessionSnapshot): string[] {
  if (snapshot.editor.kind === "question") {
    return [
      ` ${color.bold.yellow("new question")} ${sanitizeUntrusted(snapshot.editor.draft)}${color.cyan("▏")}`,
      ` ${color.dim("enter: add to every item   esc: cancel")}`,
    ];
  }
  if (snapshot.editor.kind === "note") {
    return [
      ` ${color.bold.blue("note")} ${sanitizeUntrusted(snapshot.editor.draft)}${color.cyan("▏")}`,
      ` ${color.dim("enter: save   esc: cancel")}`,
    ];
  }
  const key = (name: string, description: string) =>
    `${color.bold(name)}${color.brightBlack(` ${description}`)}`;
  const deleteLabel = snapshot.currentQuestion?.deleted === true ? "undelete" : "delete";
  return [
    ` ${key("space", "toggle")}  ${key("↑↓", "question")}  ${key("←→", "item")}  ` +
    `${key("enter", "reviewed+next")}  ${key("a", "add")}  ${key("d", deleteLabel)}  ` +
    `${key("m", "note")}  ${key("^f/^b", "scroll")}  ${key("q", "quit")}`,
  ];
}

export type RenderArgs = {
  snapshot: SessionSnapshot;
  storeLabel: string;
  width: number;
  height: number;
  /** Left-pane scroll position, owned by the loop. */
  scroll: number;
  /** The output body, already highlighted and wrapped to the left pane. */
  body: string[];
};

export function paneHeightFor(height: number): number {
  return Math.max(4, height - CHROME_ROWS);
}

export function leftPaneWidthFor(width: number): number {
  return Math.max(10, Math.floor(width * LEFT_PANE_FRACTION));
}

/**
 * Build the frame as an Element tree.
 *
 * Pure, and laid out by the same engine the terminal uses — so a test asserts
 * on the real frame rather than on a string this module assembled by hand.
 */
export function labelScreen(args: RenderArgs): Element {
  const { snapshot } = args;
  const leftWidth = leftPaneWidthFor(args.width);
  const rightWidth = Math.max(10, args.width - leftWidth - 1);
  const paneHeight = paneHeightFor(args.height);

  if (snapshot.currentItem === null) {
    return lines([headerLine(snapshot, args.storeLabel), "", " nothing to label"]);
  }

  const checklist = renderChecklist(snapshot, rightWidth);
  // followCursor is the library's keep-the-cursor-visible-without-jitter rule,
  // the same one the logs viewer uses. Without it, Space and Enter would act
  // on a checkbox scrolled off the bottom of the pane.
  const checklistScroll = followCursor(0, checklist.focusLine, paneHeight);

  return column(
    line(headerLine(snapshot, args.storeLabel)),
    line("", { fill: "━", fg: "gray" }),
    line(itemLine(snapshot)),
    row(
      { height: paneHeight },
      pane(args.body, { width: leftWidth, height: paneHeight, scrollOffset: args.scroll }),
      pane(
        Array.from({ length: paneHeight }, () => color.brightBlack("│")),
        { width: 1, height: paneHeight },
      ),
      pane(checklist.lines, { flex: 1, height: paneHeight, scrollOffset: checklistScroll }),
    ),
    line("", { fill: "━", fg: "gray" }),
    ...footerLines(snapshot).map((footer) => line(footer)),
  );
}

/**
 * A scrollable pane.
 *
 * The content is ONE text element joined by newlines rather than a column of
 * `line()` children, because `scrollOffset` slices an element's own content by
 * newline — a column of one-line children has nothing to slice, and the offset
 * is silently ignored.
 */
function pane(contentLines: string[], style: Style): Element {
  return { type: "text", content: contentLines.join("\n"), style };
}

// --- input ---------------------------------------------------------------

/**
 * Translate a keystroke into a domain action.
 *
 * Returns null for keys the loop handles itself (scrolling, quitting) or
 * ignores. Events arrive already parsed by the TUI input layer, which owns
 * escape-sequence reassembly and bracketed paste.
 */
export function actionForKey(event: KeyEvent, editing: boolean): SessionAction | null {
  if (editing) {
    if (event.key === "enter") return { kind: "submitEditor" };
    if (event.key === "escape") return { kind: "cancelEditor" };
    if (event.key === "backspace") return { kind: "backspaceEditor" };
    // Bracketed paste arrives as ONE event carrying the whole clipboard, not
    // as a stream of characters. Dropping it would make paste silently do
    // nothing, which is worse than the keystroke-at-a-time behaviour it
    // replaced.
    if (event.key === "paste") {
      const pasted = pastedText(event.text ?? "");
      return pasted.length === 0 ? null : { kind: "appendEditorText", text: pasted };
    }
    // A stray Ctrl-F while typing must not land in the text.
    if (event.ctrl === true) return null;
    if (event.key.length === 1 && event.key >= " ") {
      return { kind: "appendEditorText", text: event.key };
    }
    return null;
  }
  if (event.ctrl === true) {
    return null;
  }
  switch (event.key) {
    case "up": return { kind: "previousQuestion" };
    case "down": return { kind: "nextQuestion" };
    case "left": return { kind: "previousItem" };
    case "right": return { kind: "nextItem" };
    case "enter": return { kind: "signOff" };
    case " ": return { kind: "toggleAnswer" };
    case "a": return { kind: "beginQuestion" };
    case "d": return { kind: "toggleQuestionDeleted" };
    case "m": return { kind: "beginNote" };
    default: return null;
  }
}

/** Vim-style paging. Cmd+arrow is not bindable — terminals do not transmit the
 *  Cmd modifier. */
export function scrollDelta(event: KeyEvent, paneHeight: number): number {
  const page = Math.max(1, paneHeight - 1);
  const half = Math.max(1, Math.floor(page / 2));
  // Dedicated page keys, for keyboards that have them.
  if (event.key === "pageup") return -page;
  if (event.key === "pagedown") return page;
  if (event.ctrl !== true) {
    return 0;
  }
  if (event.key === "f") return page;
  if (event.key === "b") return -page;
  if (event.key === "d") return half;
  if (event.key === "u") return -half;
  return 0;
}

export function isQuitKey(event: KeyEvent): boolean {
  return event.key === "q" || (event.key === "c" && event.ctrl === true);
}

/**
 * Order the fields of one record for display.
 *
 * The store's `fieldOrder` decides what it knows about; anything else follows
 * alphabetically rather than in object-key order, so the layout does not depend
 * on which loader happened to build the record.
 */
export function orderFieldNames(
  fields: Fields,
  fieldOrder: readonly string[],
): string[] {
  const present = Object.keys(fields);
  const known = fieldOrder.filter((name) => present.includes(name));
  const rest = present.filter((name) => !known.includes(name)).sort();
  return [...known, ...rest];
}

/**
 * Every field as one scrollable block: a dim header, then the value.
 *
 * Field names come from a charset that cannot express a control character or a
 * style tag, but the values are arbitrary text from a model, so they go through
 * `sanitizeUntrusted` before anything else touches them.
 */
export function renderFields(
  fields: Fields,
  fieldOrder: readonly string[],
  width: number,
): string[] {
  const out: string[] = [];
  for (const name of orderFieldNames(fields, fieldOrder)) {
    if (out.length > 0) {
      out.push("");
    }
    out.push(color.brightBlack(`${name}:`));
    // Order matters and is not interchangeable. Controls come off first, so the
    // highlighter never sees them; style tags are escaped LAST, because the
    // markdown highlighter strips backslash escapes — sanitizing before it runs
    // hands the escaped text straight back as live markup.
    const rendered = renderMarkdownSafely(stripControlCharacters(fields[name]));
    for (const source of wrapText(escapeStyleTags(rendered), width)) {
      out.push(source);
    }
  }
  return out;
}

// --- the loop ------------------------------------------------------------

export type RunLabelTuiArgs = {
  controller: LabelingSessionController;
  screen: Screen;
  storeLabel?: string;
  /** Current terminal size, read before every draw. Screen stores its
   *  dimensions, so without this a resize leaves stale pane widths, wrapping
   *  and scroll bounds until restart. */
  currentSize?: () => { width: number; height: number };
  /** The store's display order for fields. Anything not listed renders after
   *  it, alphabetically, so a field added by a later ingest is never hidden. */
  fieldOrder?: readonly string[];
};

type BodyCache = { outputId: string; width: number; lines: string[] };

type LoopState = {
  scroll: number;
  done: boolean;
  /** Highlight and wrap are expensive enough that redoing them per keystroke
   *  shows, so the result is cached until the item or the width changes. */
  body: BodyCache | null;
};

export async function runLabelTui(args: RunLabelTuiArgs): Promise<void> {
  /** Adopt the terminal's current size, so a resize takes effect on the next
   *  draw rather than at restart. */
  const syncSize = (): { width: number; height: number } => {
    const current = args.currentSize?.();
    if (current !== undefined) {
      const stored = args.screen.size();
      if (current.width !== stored.width || current.height !== stored.height) {
        args.screen.resize(current.width, current.height);
      }
    }
    return args.screen.size();
  };

  const withBody = (state: LoopState): LoopState => {
    const item = args.controller.snapshot().currentItem;
    if (item === null) {
      return state;
    }
    const leftWidth = leftPaneWidthFor(args.screen.size().width);
    if (state.body?.outputId === item.outputId && state.body.width === leftWidth) {
      return state;
    }
    const wrapped = renderFields(item.fields, args.fieldOrder ?? [], leftWidth);
    return { ...state, body: { outputId: item.outputId, width: leftWidth, lines: wrapped } };
  };

  await args.screen.runLoop<LoopState>({
    initialState: withBody({ scroll: 0, done: false, body: null }),
    render: (state) => {
      const size = syncSize();
      return labelScreen({
        snapshot: args.controller.snapshot(),
        storeLabel: args.storeLabel ?? "",
        width: size.width,
        height: size.height,
        scroll: state.scroll,
        body: state.body?.lines ?? [],
      });
    },
    handleKey: async (state, event) => {
      const snapshot = args.controller.snapshot();
      const editing = snapshot.editor.kind !== "none";
      if (!editing && isQuitKey(event)) {
        return { ...state, done: true };
      }
      const previousItem = snapshot.currentItem?.outputId;
      let next = state;
      const action = actionForKey(event, editing);
      if (action !== null) {
        const after = await args.controller.dispatch(action);
        if (after.currentItem?.outputId !== previousItem) {
          next = { ...next, scroll: 0 };
        }
      }
      next = withBody(next);
      const paneHeight = paneHeightFor(args.screen.size().height);
      const maxScroll = Math.max(0, (next.body?.lines.length ?? 0) - paneHeight);
      const scrolled = next.scroll + scrollDelta(event, paneHeight);
      return { ...next, scroll: Math.min(Math.max(0, scrolled), maxScroll) };
    },
    isDone: (state) => state.done,
  });
}
