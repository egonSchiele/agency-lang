// Draws the `agency eval new` form from its state: one row per field, the
// cursor row drawn as a text input since that is where typing lands, and a
// footer that is the key hints, the current message, or one of the two
// questions. Every string that came from outside, the suite path included,
// is sanitized before it is drawn.
import { visualWidth, wrapText } from "@/stdlib/layout/ansi.js";
import { column, line, row, textInput } from "@/tui/builders.js";
import type { Element, Style } from "@/tui/elements.js";
import { sanitizeUntrusted, stripControlCharacters } from "@/tui/untrusted.js";

import { FIELDS, type FieldSpec, type FormState } from "./form.js";

/** The label column: the widest label plus a gap. */
const LABEL_WIDTH = Math.max(...FIELDS.map((field) => field.label.length)) + 3;
const INDENT = 2;
const CURSOR_BG = "#313244";
const CONFIRM_QUIT_FOOTER = "discard this test?  y / n";
const CONFIRM_SAVE_FOOTER = "write this test?  y / n";

export type FormViewArgs = {
  state: FormState;
  width: number;
  height: number;
  /** The key hints for the form mode, from its bindings. */
  hints: string;
};

export function renderForm(args: FormViewArgs): Element {
  const { state } = args;
  const footer = footerText(args);
  return column(
    { justifyContent: "space-between" },
    column(
      { justifyContent: "flex-start" },
      line(`NEW TEST  ${sanitizeUntrusted(state.suiteDir)}`, { bold: true }),
      line(""),
      ...FIELDS.flatMap((field) => fieldRows(field, state, args.width)),
    ),
    line(footer, { dim: footer === args.hints }),
  );
}

function footerText(args: FormViewArgs): string {
  const { state } = args;
  if (state.mode.kind === "confirmQuit") {
    return CONFIRM_QUIT_FOOTER;
  }
  if (state.mode.kind === "confirmSave") {
    return CONFIRM_SAVE_FOOTER;
  }
  return state.message === "" ? args.hints : sanitizeUntrusted(state.message);
}

/** A field's label and value. A value that does not fit on one line
 *  continues on the lines below, under the value column. The cursor row is
 *  a text input, so the cursor looks like every other input in the toolkit.
 *  An empty field shows its help dim after the cursor, wrapped like a
 *  value. A text input draws its value as is, with no style tags read, so
 *  the value only has its control characters removed; escaping braces there
 *  would show the backslashes. */
function fieldRows(field: FieldSpec, state: FormState, width: number): Element[] {
  const label = `${" ".repeat(INDENT)}${field.label.padEnd(LABEL_WIDTH)}`;
  const valueWidth = Math.max(1, width - label.length);
  const value = state.values[field.name];
  if (state.cursor !== field.name) {
    const shown = value === "" ? field.help : sanitizeUntrusted(value);
    const wrapped = wrapText(shown, valueWidth);
    const style: Style = { dim: value === "" };
    const first = line(`${label}${wrapped[0] ?? ""}`, style);
    const rest = wrapped.slice(1).map((text) => line(`${" ".repeat(label.length)}${text}`, style));
    return [first, ...rest];
  }
  if (value === "") {
    // An empty input draws only the cursor, so it is one cell wide and the
    // help follows it.
    const help = wrapText(field.help, Math.max(1, valueWidth - 2));
    return [
      row(
        { height: 1 },
        line(label, { width: label.length, bg: CURSOR_BG }),
        textInput({ bg: CURSOR_BG, width: 1 }, ""),
        line(` ${help[0] ?? ""}`, { dim: true, bg: CURSOR_BG }),
      ),
      ...help
        .slice(1)
        .map((text) =>
          line(`${" ".repeat(label.length + 2)}${text}`, { dim: true, bg: CURSOR_BG }),
        ),
    ];
  }
  const rows = cursorRows(stripControlCharacters(value), valueWidth);
  return [
    row(
      { height: rows.length },
      line(label, { width: label.length, height: rows.length, bg: CURSOR_BG }),
      textInput({ bg: CURSOR_BG, width: valueWidth, height: rows.length }, rows.join("\n")),
    ),
  ];
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
