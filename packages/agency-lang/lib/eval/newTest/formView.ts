// Draws the `agency eval new` form from its state: one row per field, the
// graders section under them, the cursor row drawn as a text input since
// that is where typing lands, and a footer that is the key hints, the
// current message, or one of the questions. Every string that came from
// outside, the suite path included, is sanitized before it is drawn.
//
// The body is a flat list of one-line elements, so scrolling is a slice of
// that list: the toolkit's `scrollable` style only shifts an element's own
// text, never a column's children.
import { visualWidth, wrapText } from "@/stdlib/layout/ansi.js";
import { column, line, row, textInput } from "@/tui/builders.js";
import type { Element, Style } from "@/tui/elements.js";
import { clampScroll, followCursor } from "@/tui/scroll.js";
import { escapeStyleTags } from "@/tui/styleParser.js";
import { sanitizeUntrusted, stripControlCharacters } from "@/tui/untrusted.js";

import { FIELDS, isKindRow, sameRow, type FormState, type Row } from "./form.js";
import {
  choiceValue,
  KIND_QUESTION,
  KIND_QUESTIONS,
  labelOf,
  questionsFor,
  TAIL_QUESTIONS,
  type GraderDraft,
  type QuestionSpec,
} from "./graders.js";

const INDENT = 2;
const LABEL_GAP = 3;
/** A grader's question labels sit two columns in from the field labels. */
const QUESTION_INDENT = 2;
const CURSOR_BG = "#313244";
const CONFIRM_QUIT_FOOTER = "discard this test?  y / n";
const CONFIRM_SAVE_FOOTER = "write this test?  y / n";
const CONFIRM_REMOVE_FOOTER = "remove this grader?  y / n";
const NO_GRADERS = "no graders: the goal above is judged by the bundled goal judge";
const GOAL_NOT_JUDGED = "not judged while the test has graders; add a goal grader to judge it";
/** The title, the blank line under it, and the footer: the lines around the body. */
const LINES_AROUND_BODY = 3;

function kindLabel(index: number): string {
  return `${index + 1}. ${KIND_QUESTION.label}`;
}

const ALL_QUESTIONS: QuestionSpec[] = [...Object.values(KIND_QUESTIONS).flat(), ...TAIL_QUESTIONS];

/** The label column: the widest label as drawn, plus a gap. */
export const LABEL_WIDTH =
  Math.max(
    ...FIELDS.map((field) => field.label.length),
    kindLabel(0).length,
    ...ALL_QUESTIONS.map((question) => QUESTION_INDENT + question.label.length),
  ) + LABEL_GAP;

export type FormViewArgs = {
  state: FormState;
  width: number;
  height: number;
  /** The key hints for the form mode, from its bindings. */
  hints: string;
};

/** Everything the drawing needs to know about one row of the body. `row`
 *  is null for a line the cursor never visits. `typed` is true when the
 *  cursor row takes typing, so it is drawn as a text input; a choice row
 *  is drawn on the cursor background with no block cursor. */
export type RowView = {
  row: Row | null;
  label: string;
  value: string;
  /** Shown dim in the value column while the value is empty. */
  help: string;
  cursor: boolean;
  typed: boolean;
  heading: boolean;
};

const BLANK: RowView = {
  row: null,
  label: "",
  value: "",
  help: "",
  cursor: false,
  typed: false,
  heading: false,
};

function noteView(help: string): RowView {
  return { ...BLANK, help };
}

/** The rows of the body, in order: the fields, then the graders section. */
export function rowViewsOf(state: FormState): RowView[] {
  const fields = FIELDS.flatMap((field): RowView[] => {
    const row: Row = { kind: "field", name: field.name };
    const lock = state.locks[field.name];
    // A locked field shows its lock text where its help would be: dim,
    // with no cursor, since the row cannot be reached.
    const view: RowView = {
      row,
      label: field.label,
      value: lock === undefined ? state.values[field.name] : "",
      help: lock ?? field.help,
      cursor: lock === undefined && sameRow(state.cursor, row),
      typed: true,
      heading: false,
    };
    const judged = field.name === "goal" && state.graders.length > 0;
    return judged ? [view, noteView(GOAL_NOT_JUDGED)] : [view];
  });
  // Each grader's questions are expanded once here, not once per row.
  const graders = state.graders.flatMap((draft, index) =>
    questionsFor(draft).map((question) => graderView(state, draft, index, question)),
  );
  const section =
    state.gradersLock !== null
      ? [noteView(state.gradersLock)]
      : graders.length === 0
        ? [noteView(NO_GRADERS)]
        : graders;
  return [...fields, BLANK, { ...BLANK, label: "graders", heading: true }, ...section];
}

function graderView(
  state: FormState,
  draft: GraderDraft,
  index: number,
  question: QuestionSpec,
): RowView {
  const row: Row = { kind: "grader", index, question: question.name };
  const answers = draft.answers;
  const answer = answers[question.name] ?? "";
  const label = isKindRow(row)
    ? kindLabel(row.index)
    : `${" ".repeat(QUESTION_INDENT)}${question.label}`;
  if (question.input.kind === "choice") {
    const picked = choiceValue(answers, question);
    return {
      row,
      label,
      value: picked === "" ? "" : labelOf(question, picked),
      help: question.input.unset ?? "",
      cursor: sameRow(state.cursor, row),
      typed: false,
      heading: false,
    };
  }
  return {
    row,
    label,
    value: answer,
    help: question.input.help,
    cursor: sameRow(state.cursor, row),
    typed: true,
    heading: false,
  };
}

/** Every line of the body in order, each tagged with the row it belongs
 *  to. One place computes the wrapping; drawing and scrolling both read it. */
export function bodyLines(
  state: FormState,
  width: number,
): { row: Row | null; element: Element }[] {
  return rowViewsOf(state).flatMap((view) =>
    drawRow(view, width).map((element) => ({ row: view.row, element })),
  );
}

export function renderForm(args: FormViewArgs): Element {
  const { state } = args;
  const footer = footerText(args);
  const viewport = Math.max(1, args.height - LINES_AROUND_BODY);
  const visible = bodyLines(state, args.width).slice(state.scrollTop, state.scrollTop + viewport);
  return column(
    { justifyContent: "space-between" },
    column(
      { justifyContent: "flex-start" },
      line(titleOf(state), { bold: true }),
      line(""),
      ...visible.map((entry) => entry.element),
    ),
    line(footer, { dim: footer === args.hints }),
  );
}

function titleOf(state: FormState): string {
  return state.editing === null
    ? `NEW TEST  ${sanitizeUntrusted(state.suiteDir)}`
    : `EDIT TEST  ${sanitizeUntrusted(state.editing.testDir)}`;
}

/** The state with `scrollTop` moved so the cursor row is on screen: its
 *  last line when the cursor came down onto it, its first line (the one
 *  with the label) when the cursor came up onto it or the row is taller
 *  than the screen. Run after every key, so a row that vanished is
 *  absorbed too. */
export function scrolledToCursor(state: FormState, width: number, height: number): FormState {
  const lines = bodyLines(state, width);
  const viewport = Math.max(1, height - LINES_AROUND_BODY);
  const onCursor = lines.map((entry) => entry.row !== null && sameRow(entry.row, state.cursor));
  const firstLine = onCursor.indexOf(true);
  const lastLine = onCursor.lastIndexOf(true);
  const clamped = clampScroll(state.scrollTop, lines.length, viewport);
  const scrollTop =
    firstLine < 0
      ? clamped
      : followCursor(followCursor(clamped, lastLine, viewport), firstLine, viewport);
  return scrollTop === state.scrollTop ? state : { ...state, scrollTop };
}

function footerText(args: FormViewArgs): string {
  const { state } = args;
  if (state.mode.kind === "confirmQuit") {
    return CONFIRM_QUIT_FOOTER;
  }
  if (state.mode.kind === "confirmSave") {
    return CONFIRM_SAVE_FOOTER;
  }
  if (state.mode.kind === "confirmRemove") {
    return CONFIRM_REMOVE_FOOTER;
  }
  return state.message === "" ? args.hints : sanitizeUntrusted(state.message);
}

/** One row as screen lines, each element exactly one line tall. A value
 *  that does not fit on one line continues on the lines below, under the
 *  value column. The typed cursor row is a text input, so the cursor looks
 *  like every other input in the toolkit; a choice cursor row is drawn on
 *  the cursor background with nothing to type into. An empty row shows its
 *  help dim. A text input draws its value as is, with no style tags read,
 *  so its line only has its control characters removed; escaping braces
 *  there would show the backslashes. The lines above it are ordinary
 *  lines, which do read style tags, so their braces are escaped. */
export function drawRow(view: RowView, width: number): Element[] {
  // A line with no label (a note, the no-graders line) runs from the
  // indent across the whole width.
  const label =
    view.label === ""
      ? " ".repeat(INDENT)
      : `${" ".repeat(INDENT)}${view.label.padEnd(LABEL_WIDTH)}`;
  const valueWidth = Math.max(1, width - label.length);
  const pad = " ".repeat(label.length);
  if (!view.cursor) {
    const shown = view.value === "" ? view.help : sanitizeUntrusted(view.value);
    const wrapped = wrapText(shown, valueWidth);
    const style: Style = { dim: view.value === "" && !view.heading, bold: view.heading };
    const first = line(`${label}${wrapped[0] ?? ""}`.trimEnd(), style);
    const rest = wrapped.slice(1).map((text) => line(`${pad}${text}`, style));
    return [first, ...rest];
  }
  if (!view.typed) {
    const shown = view.value === "" ? view.help : sanitizeUntrusted(view.value);
    const wrapped = wrapText(shown, valueWidth);
    const style: Style = { dim: view.value === "", bg: CURSOR_BG };
    const first = line(`${label}${wrapped[0] ?? ""}`, style);
    const rest = wrapped.slice(1).map((text) => line(`${pad}${text}`, style));
    return [first, ...rest];
  }
  if (view.value === "") {
    // An empty input draws only the cursor, so it is one cell wide and the
    // help follows it.
    const help = wrapText(view.help, Math.max(1, valueWidth - 2));
    return [
      row(
        { height: 1 },
        line(label, { width: label.length, bg: CURSOR_BG }),
        textInput({ bg: CURSOR_BG, width: 1 }, ""),
        line(` ${help[0] ?? ""}`, { dim: true, bg: CURSOR_BG }),
      ),
      ...help
        .slice(1)
        .map((text) => line(`${pad}  ${text}`, { dim: true, bg: CURSOR_BG, height: 1 })),
    ];
  }
  const rows = cursorRows(stripControlCharacters(view.value), valueWidth);
  const last = rows.length - 1;
  return rows.map((text, i) =>
    row(
      { height: 1 },
      line(i === 0 ? label : pad, { width: label.length, bg: CURSOR_BG }),
      i === last
        ? textInput({ bg: CURSOR_BG, width: valueWidth, height: 1 }, text)
        : line(escapeStyleTags(text), { bg: CURSOR_BG, width: valueWidth }),
    ),
  );
}

/** The rows a text input shows for the value under the cursor. The value
 *  is wrapped here, since a text input clips a long line rather than
 *  wrapping it, and the cursor then sits at the end of the last row.
 *
 *  `wrapText` drops the spaces at the end of a row once a value wraps, and
 *  a person typing a space at the end of a long goal would then see the
 *  cursor stay put. So the value is wrapped without its trailing spaces and
 *  they are put back on the last row. A row that fills the width gets an
 *  empty row after it, because a text input leaves the cursor out when its
 *  last row is full; the width is measured as drawn, so a row of wide
 *  characters counts its columns and not its code units. */
export function cursorRows(value: string, width: number): string[] {
  const trimmed = value.trimEnd();
  const trailing = value.slice(trimmed.length);
  const wrapped = wrapText(trimmed, width);
  const last = (wrapped[wrapped.length - 1] ?? "") + trailing;
  const rows = [...wrapped.slice(0, -1), last];
  return visualWidth(last) >= width ? [...rows, ""] : rows;
}

/** What the command prints once the screen is gone: the folder written and
 *  the commands to run next. These go to the terminal, not the style
 *  parser, so only control characters are removed: a `{` in a path must
 *  print as `{`, or the command could not be copied. */
export function wroteSummary(testDir: string, nextCommands: string[]): string[] {
  return [
    `wrote ${stripControlCharacters(testDir)}`,
    "",
    "run it with:",
    ...nextCommands.map((text) => `${" ".repeat(INDENT)}${stripControlCharacters(text)}`),
  ];
}
