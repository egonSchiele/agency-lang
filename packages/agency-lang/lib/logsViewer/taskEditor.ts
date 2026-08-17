// The task-edit step of labeling a trace, as a full-screen prompt.
//
// Before a trace is labeled, the annotator gets one chance to set the "task" —
// the prompt this output should be judged against. This used to be a one-line
// readline prompt painted over the tree view, which read as broken garbage. It
// is now its own full-screen page: it explains what is being asked, shows the
// task the run recorded, and gives an editor line, so the step is unmistakable.
import { column, line } from "../tui/builders.js";
import type { Element } from "../tui/elements.js";
import type { Screen } from "../tui/screen.js";
import { wrapText } from "../stdlib/layout/ansi.js";
import { color } from "../utils/termcolors.js";
import { projectArtifactField } from "../eval/label/project.js";
import { sanitizeUntrusted } from "../eval/label/labelTui.js";
import type { TaskChoice } from "../eval/label/load/statelog.js";
import type { JsonValue } from "../utils/canonicalize.js";

/** At most this many wrapped lines of the recorded task are shown, so a huge
 *  prompt cannot push the editor line off the screen. */
const MAX_TASK_LINES = 10;

type EditorState = {
  draft: string;
  done: boolean;
  result: TaskChoice | null;
};

/** The recorded task as display lines, or a single dim "(none recorded)". The
 *  value is untrusted model output, so every line is sanitized. */
function recordedTaskLines(defaultTask: JsonValue | null, width: number): string[] {
  if (defaultTask === null) {
    return [`  ${color.brightBlack("(none recorded)")}`];
  }
  const wrapped = wrapText(sanitizeUntrusted(projectArtifactField(defaultTask)), Math.max(8, width - 2));
  const shown = wrapped.slice(0, MAX_TASK_LINES).map((l) => `  ${l}`);
  if (wrapped.length > MAX_TASK_LINES) {
    shown.push(`  ${color.brightBlack(`… ${wrapped.length - MAX_TASK_LINES} more line(s)`)}`);
  }
  return shown;
}

function editorScreen(state: EditorState, defaultTask: JsonValue | null, width: number): Element {
  const footer = [
    `${color.cyan("Enter")} accept`,
    `${color.cyan("type")} to replace`,
    `${color.cyan("\"-\"")} clears`,
    `${color.cyan("Esc")} cancel`,
  ].join(color.brightBlack("  ·  "));
  return column(
    { justifyContent: "flex-start", padding: 1 },
    line(color.bold("Label a trace") + color.brightBlack("  ·  set the task")),
    line(""),
    line(color.brightBlack("The task is the prompt this output should be judged against.")),
    line(color.brightBlack("Edit it if you like, or press Enter to keep what the run recorded.")),
    line(""),
    line(color.bold.yellow("Recorded task")),
    ...recordedTaskLines(defaultTask, width).map((l) => line(l)),
    line(""),
    line(color.bold.green("Your task")),
    line(`  ${sanitizeUntrusted(state.draft)}${color.cyan("▏")}`),
    line(""),
    line(footer),
  );
}

function finalize(draft: string): TaskChoice {
  const trimmed = draft.trim();
  if (trimmed === "") return { kind: "keep-default" };
  if (trimmed === "-") return { kind: "omit" };
  return { kind: "replace", value: draft };
}

/**
 * Run the full-screen task editor on the viewer's own screen and return the
 * annotator's choice, or `null` if they backed out with Esc.
 *
 * Keeps the same choice semantics the one-line prompt had — empty keeps the
 * recorded task, "-" clears it, anything else replaces it — so only the
 * presentation changes.
 */
export async function editTaskOnScreen(screen: Screen, defaultTask: JsonValue | null): Promise<TaskChoice | null> {
  const final = await screen.runLoop<EditorState>({
    initialState: { draft: "", done: false, result: null },
    render: (state) => editorScreen(state, defaultTask, screen.size().width),
    handleKey: (state, event) => {
      if (event.key === "escape") return { ...state, done: true, result: null };
      if (event.key === "enter") return { ...state, done: true, result: finalize(state.draft) };
      if (event.key === "backspace") return { ...state, draft: state.draft.slice(0, -1) };
      // Bracketed paste arrives as one event carrying the whole clipboard.
      if (event.key === "paste") return { ...state, draft: state.draft + (event.text ?? "") };
      // A stray Ctrl-key while typing must not land in the text.
      if (event.ctrl === true) return state;
      if (event.key.length === 1 && event.key >= " ") return { ...state, draft: state.draft + event.key };
      return state;
    },
    isDone: (state) => state.done,
  });
  return final.result;
}
