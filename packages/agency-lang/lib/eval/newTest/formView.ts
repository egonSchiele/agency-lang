// Draws the `agency eval new` form from its state: one row per field, the
// cursor row drawn as a text input since that is where typing lands, and a
// footer that is the key hints or the current message. The discard question
// and the "wrote" screen are the same state in other modes. Every string
// that came from outside, the suite path included, is sanitized before it
// is drawn.
import { wrapText } from "@/stdlib/layout/ansi.js";
import { column, line, lines, row, textInput } from "@/tui/builders.js";
import type { Element, Style } from "@/tui/elements.js";
import { sanitizeUntrusted, stripControlCharacters } from "@/tui/untrusted.js";

import { FIELDS, type FieldSpec, type FormState } from "./form.js";

/** The label column: the widest label plus a gap. */
const LABEL_WIDTH = Math.max(...FIELDS.map((field) => field.label.length)) + 3;
const INDENT = 2;
const CURSOR_BG = "#313244";
const CONFIRM_FOOTER = "discard this test?  y / n";
const WROTE_FOOTER = "press any key to finish";

export type FormViewArgs = {
  state: FormState;
  width: number;
  height: number;
  /** The key hints for the form mode, from its bindings. */
  hints: string;
  /** The commands to run next, shown on the "wrote" screen. */
  nextCommands: string[];
};

export function renderForm(args: FormViewArgs): Element {
  const { state } = args;
  if (state.mode.kind === "wrote") {
    return wroteScreen(state.mode.testDir, args.nextCommands, args.width);
  }
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
    return CONFIRM_FOOTER;
  }
  return state.message === "" ? args.hints : sanitizeUntrusted(state.message);
}

/** A field's label and value. A value that does not fit on one line
 *  continues on the lines below, under the value column. The cursor row is
 *  a text input, so the cursor looks like every other input in the toolkit:
 *  the value is wrapped first and handed over with a newline per row, since
 *  a text input clips a long line rather than wrapping it, and the cursor
 *  then sits at the end of the last row. An empty field shows its help dim
 *  after the cursor. A text input draws its value as is, with no style tags
 *  read, so the value only has its control characters removed; escaping
 *  braces there would show the backslashes. */
function fieldRows(field: FieldSpec, state: FormState, width: number): Element[] {
  const label = `${" ".repeat(INDENT)}${field.label.padEnd(LABEL_WIDTH)}`;
  const valueWidth = Math.max(1, width - label.length);
  const value = state.values[field.name];
  if (state.cursor === field.name) {
    const wrapped = wrapText(stripControlCharacters(value), valueWidth);
    // A text input leaves the cursor out when its last row is full, so a
    // row that fills the width gets an empty one after it for the cursor.
    const last = wrapped[wrapped.length - 1] ?? "";
    const rows = last.length >= valueWidth ? [...wrapped, ""] : wrapped;
    const height = rows.length;
    if (value === "") {
      // An empty input draws only the cursor, so it is one cell wide and the
      // help follows it.
      return [
        row(
          { height },
          line(label, { width: label.length, height, bg: CURSOR_BG }),
          textInput({ bg: CURSOR_BG, width: 1, height }, ""),
          line(` ${field.help}`, { dim: true, bg: CURSOR_BG }),
        ),
      ];
    }
    return [
      row(
        { height },
        line(label, { width: label.length, height, bg: CURSOR_BG }),
        textInput({ bg: CURSOR_BG, width: valueWidth, height }, rows.join("\n")),
      ),
    ];
  }
  const shown = value === "" ? field.help : sanitizeUntrusted(value);
  const wrapped = wrapText(shown, valueWidth);
  const style: Style = { dim: value === "" };
  const first = line(`${label}${wrapped[0] ?? ""}`, style);
  const rest = wrapped.slice(1).map((text) => line(`${" ".repeat(label.length)}${text}`, style));
  return [first, ...rest];
}

/** The lines the "wrote" screen shows, which the command prints again
 *  once the screen is gone. Not wrapped: the terminal wraps a printed line
 *  itself, and the screen wraps them with `wrapText`. */
export function wroteSummary(testDir: string, nextCommands: string[]): string[] {
  return [
    `wrote ${sanitizeUntrusted(testDir)}`,
    "",
    "run it with:",
    ...nextCommands.map((text) => `${" ".repeat(INDENT)}${sanitizeUntrusted(text)}`),
  ];
}

/** A command longer than the screen continues on the next row, indented,
 *  so a long suite path never hides the flags after it. */
function wroteScreen(testDir: string, nextCommands: string[], width: number): Element {
  const commands = nextCommands.flatMap((text) =>
    wrapText(sanitizeUntrusted(text), Math.max(1, width - 2 * INDENT)).map(
      (part, index) => `${" ".repeat(index === 0 ? INDENT : 2 * INDENT)}${part}`,
    ),
  );
  return column(
    { justifyContent: "space-between" },
    lines([`wrote ${sanitizeUntrusted(testDir)}`, "", "run it with:", ...commands], {
      justifyContent: "flex-start",
    }),
    line(WROTE_FOOTER, { dim: true }),
  );
}
