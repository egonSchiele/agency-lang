// Draws the `agency eval new` form from its state: one row per field, the
// cursor row marked, the field being edited drawn as a text input, and a
// footer that is the key hints or the current message. The discard question
// and the "wrote" screen are the same state in other modes.
import { wrapText } from "@/stdlib/layout/ansi.js";
import { column, line, lines, row, textInput } from "@/tui/builders.js";
import type { Element, Style } from "@/tui/elements.js";
import { sanitizeUntrusted } from "@/tui/untrusted.js";

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
      line(`NEW TEST  ${state.suiteDir}`, { bold: true }),
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
  return state.message === "" ? args.hints : state.message;
}

/** A field's label and value. A value that does not fit on one line
 *  continues on the lines below, under the value column. The field being
 *  edited shows its draft as a text input, so the cursor looks like every
 *  other input in the toolkit. */
function fieldRows(field: FieldSpec, state: FormState, width: number): Element[] {
  const selected = state.cursor === field.name;
  const label = `${" ".repeat(INDENT)}${field.label.padEnd(LABEL_WIDTH)}`;
  const valueWidth = Math.max(1, width - label.length);
  if (state.editor.kind === "field" && state.editor.field === field.name) {
    return [
      row(
        { height: 1 },
        line(label, { width: label.length, bg: CURSOR_BG }),
        textInput({ bg: CURSOR_BG }, sanitizeUntrusted(state.editor.draft)),
      ),
    ];
  }
  const value = state.values[field.name];
  const shown = value === "" ? field.help : sanitizeUntrusted(value);
  const wrapped = wrapText(shown, valueWidth);
  const style = valueStyle(value === "", selected);
  const first = line(`${label}${wrapped[0] ?? ""}`, style);
  const rest = wrapped.slice(1).map((text) => line(`${" ".repeat(label.length)}${text}`, style));
  return [first, ...rest];
}

/** Help text is dim; the cursor row carries the cursor colour. */
function valueStyle(empty: boolean, selected: boolean): Style {
  if (selected) {
    return { dim: empty, bg: CURSOR_BG };
  }
  return { dim: empty };
}

/** A command longer than the screen continues on the next row, indented,
 *  so a long suite path never hides the flags after it. */
function wroteScreen(testDir: string, nextCommands: string[], width: number): Element {
  const commands = nextCommands.flatMap((text) =>
    wrapText(text, Math.max(1, width - 2 * INDENT)).map(
      (part, index) => `${" ".repeat(index === 0 ? INDENT : 2 * INDENT)}${part}`,
    ),
  );
  return column(
    { justifyContent: "space-between" },
    lines([`wrote ${testDir}`, "", "run it with:", ...commands], { justifyContent: "flex-start" }),
    line(WROTE_FOOTER, { dim: true }),
  );
}
