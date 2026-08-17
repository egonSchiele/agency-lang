// The task-edit step of labeling a trace, as a full-screen prompt.
//
// Before a trace is labeled, the annotator sets the "task" — the prompt this
// output should be judged against. The field is pre-filled with the task the
// run recorded and shown gray, the way web forms show a default value: press
// Enter to accept it, or edit it in place. The moment it is edited it turns
// white, so it is obvious the text is now the annotator's own.
import { column, line } from "../tui/builders.js";
import type { Element } from "../tui/elements.js";
import type { Screen } from "../tui/screen.js";
import { wrapText } from "../stdlib/layout/ansi.js";
import { color } from "../utils/termcolors.js";
import { projectArtifactField } from "../eval/label/project.js";
import { sanitizeUntrusted } from "../eval/label/labelTui.js";
import type { TaskChoice } from "../eval/label/load/statelog.js";
import type { JsonValue } from "../utils/canonicalize.js";

const CURSOR = color.cyan("▏");

type EditorState = {
  /** The field's current text. Starts as the recorded task (or empty). */
  draft: string;
  /** Whether the annotator has changed the field. Drives gray-vs-white and
   *  keep-default-vs-replace: an untouched field keeps the recorded task. */
  touched: boolean;
  done: boolean;
  result: TaskChoice | null;
};

/** The recorded task as its editable starting text: a string the annotator can
 *  edit directly. `null` (no recorded task) starts the field empty. */
function defaultDraft(defaultTask: JsonValue | null): string {
  return defaultTask === null ? "" : projectArtifactField(defaultTask);
}

/**
 * The field as display lines, wrapped to the width. Gray (a pre-filled default
 * you can accept) until touched, plain white (your own text) after. The cursor
 * sits at the end. An empty, untouched field shows a gray typing hint so it
 * never looks blank — whether the run recorded no task or recorded an empty one.
 *
 * Exported so a test can assert the gray-then-white behavior directly.
 */
export function fieldLines(draft: string, touched: boolean, width: number): string[] {
  const inner = Math.max(8, width - 2);
  if (!touched && draft === "") {
    const hint = "type a task to judge this output against, or press Enter to skip";
    return [`  ${CURSOR}${color.brightBlack(hint)}`];
  }
  const wrapped = wrapText(sanitizeUntrusted(draft), inner);
  const painted = touched ? wrapped : wrapped.map((l) => color.brightBlack(l));
  const out = painted.map((l) => `  ${l}`);
  out[out.length - 1] = `${out[out.length - 1]}${CURSOR}`;
  return out;
}

/** Keep the field within `budget` display rows, showing the tail so the cursor
 *  (always at the end) stays visible and the footer below is never pushed off
 *  screen for a task that wraps very long. A hidden head is marked with a
 *  leading ellipsis. */
function clampField(all: string[], budget: number): string[] {
  if (all.length <= budget) return all;
  if (budget <= 1) return [all[all.length - 1]];
  return [`  ${color.brightBlack("⋯")}`, ...all.slice(all.length - (budget - 1))];
}

function explanation(hasDefault: boolean): string {
  return hasDefault
    ? "This output will be judged against a task. We filled in the task this run recorded, shown gray — edit it to change it, or press Enter to accept it."
    : "This output will be judged against a task, but this run recorded none. Type one below, or press Enter to skip and judge without a task.";
}

function editorScreen(
  state: EditorState,
  hasDefault: boolean,
  width: number,
  height: number,
): Element {
  const footer = [
    `${color.cyan("Enter")} accept`,
    `${color.cyan("edit")} to change`,
    `${color.cyan("empty")} = no task`,
    `${color.cyan("Esc")} cancel`,
  ].join(color.brightBlack("  ·  "));
  const prose = wrapText(explanation(hasDefault), Math.max(8, width - 2));
  const top = [
    line(color.bold("Set the task")),
    line(""),
    ...prose.map((l) => line(color.brightBlack(l))),
    line(""),
    line(color.bold.yellow("Task")),
  ];
  const bottom = [line(""), line(footer)];
  // padding:1 costs a row top and bottom; the field takes whatever rows are
  // left, windowed to its tail, so the footer stays on screen no matter how
  // long the task wraps.
  const budget = Math.max(1, height - 2 - top.length - bottom.length);
  const field = clampField(fieldLines(state.draft, state.touched, width), budget);
  return column(
    { justifyContent: "flex-start", padding: 1 },
    ...top,
    ...field.map((l) => line(l)),
    ...bottom,
  );
}

function finalize(state: EditorState): TaskChoice {
  if (!state.touched) return { kind: "keep-default" };
  if (state.draft.trim() === "") return { kind: "omit" };
  return { kind: "replace", value: state.draft };
}

/**
 * Run the full-screen task editor on the viewer's own screen and return the
 * annotator's choice, or `null` if they backed out with Esc.
 *
 * Leaving the pre-filled default untouched keeps the recorded task; editing it
 * to some text replaces it; clearing it out means judge with no task.
 */
export async function editTaskOnScreen(
  screen: Screen,
  defaultTask: JsonValue | null,
): Promise<TaskChoice | null> {
  const hasDefault = defaultTask !== null;
  const start = defaultDraft(defaultTask);
  const final = await screen.runLoop<EditorState>({
    initialState: { draft: start, touched: false, done: false, result: null },
    render: (state) => editorScreen(state, hasDefault, screen.size().width, screen.size().height),
    handleKey: (state, event) => {
      if (event.key === "escape") return { ...state, done: true, result: null };
      // Shift/Option+Enter inserts a newline (the TUI's editable-buffer
      // contract, per ui-smoke); only a plain Enter finalizes.
      if (event.key === "enter" && event.shift === true)
        return { ...state, draft: state.draft + "\n", touched: true };
      if (event.key === "enter") return { ...state, done: true, result: finalize(state) };
      if (event.key === "backspace")
        return { ...state, draft: state.draft.slice(0, -1), touched: true };
      // Bracketed paste arrives as one event carrying the whole clipboard.
      if (event.key === "paste")
        return { ...state, draft: state.draft + (event.text ?? ""), touched: true };
      // A stray Ctrl-key while typing must not land in the text.
      if (event.ctrl === true) return state;
      if (event.key.length === 1 && event.key >= " ")
        return { ...state, draft: state.draft + event.key, touched: true };
      return state;
    },
    isDone: (state) => state.done,
  });
  return final.result;
}
