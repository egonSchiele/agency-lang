// The state of the `agency eval new` form and every change it can go
// through. Pure: the command runs the two effects (the external editor and
// the write) and reports their outcomes back as actions, so each screen the
// form shows is a mode of this state and each transition is a reducer case.
// Every field is live: a typed key goes straight into the field under the
// cursor, so there is no draft to commit and nothing to lose by moving on.
import { applyLineEdit, lineEditAction, type LineEditAction } from "@/tui/lineEditor.js";
import type { KeyEvent } from "@/tui/input/types.js";

export type FieldName = "id" | "description" | "input" | "files" | "goal";

export type FieldSpec = {
  name: FieldName;
  label: string;
  required: boolean;
  /** Ctrl+E opens `$EDITOR` on this field when one is set. */
  long: boolean;
  /** Shown in place of the value while the field is empty. */
  help: string;
};

/** The one place a field is defined. The reducer, the view and the
 *  validator all read this table. */
export const FIELDS: FieldSpec[] = [
  {
    name: "id",
    label: "folder name",
    required: true,
    long: false,
    help: "letters, digits, - and _",
  },
  {
    name: "description",
    label: "description",
    required: false,
    long: false,
    help: "one-line description (optional)",
  },
  {
    name: "input",
    label: "input",
    required: false,
    long: true,
    help: "passed to the main node as its one parameter; empty for an agent that takes none (optional)",
  },
  {
    name: "files",
    label: "files",
    required: false,
    long: false,
    help: "a directory of files to seed into the working directory, relative to the suite (optional)",
  },
  {
    name: "goal",
    label: "goal",
    required: true,
    long: true,
    help: "instructions for the LLM judge",
  },
];

export type Problem = { field: FieldName; text: string };

export type FormMode =
  { kind: "form" } | { kind: "confirmQuit" } | { kind: "wrote"; testDir: string };

export type FormState = {
  suiteDir: string;
  values: Record<FieldName, string>;
  cursor: FieldName;
  mode: FormMode;
  /** The footer message: the first problem, or what happened to the editor. */
  message: string;
  done: boolean;
};

export type FormAction =
  | { kind: "moveUp" }
  | { kind: "moveDown" }
  | { kind: "appendText"; text: string }
  | { kind: "backspace" }
  /** An intent: the command opens the editor and reports `editorReturned`. */
  | { kind: "editInEditor" }
  | { kind: "editorReturned"; text: string | null }
  | { kind: "editorFailed"; text: string }
  | { kind: "requestQuit" }
  | { kind: "confirmQuit" }
  | { kind: "cancelQuit" }
  /** An intent: the command validates and writes, then reports one of the next two. */
  | { kind: "save" }
  | { kind: "saveFailed"; problems: Problem[] }
  | { kind: "saved"; testDir: string }
  | { kind: "dismiss" };

const EMPTY_VALUES: Record<FieldName, string> = {
  id: "",
  description: "",
  input: "",
  files: "",
  goal: "",
};

export const EDITOR_EXITED_MESSAGE = "editor exited without saving; the field is unchanged";

export function initialForm(suiteDir: string): FormState {
  return {
    suiteDir,
    values: { ...EMPTY_VALUES },
    cursor: FIELDS[0].name,
    mode: { kind: "form" },
    message: "",
    done: false,
  };
}

/** Whether anything has been typed into a field. */
export function isDirty(state: FormState): boolean {
  return FIELDS.some((field) => state.values[field.name] !== EMPTY_VALUES[field.name]);
}

/** Whether the cursor is on the last field, where Enter saves instead of
 *  moving on. */
export function isLastField(name: FieldName): boolean {
  return FIELDS[FIELDS.length - 1].name === name;
}

export function fieldSpec(name: FieldName): FieldSpec {
  const spec = FIELDS.find((field) => field.name === name);
  if (spec === undefined) {
    throw new Error(`no field named ${name}`);
  }
  return spec;
}

export function reduceForm(state: FormState, action: FormAction): FormState {
  switch (action.kind) {
    case "moveUp":
      return { ...state, cursor: neighbour(state.cursor, -1) };
    case "moveDown":
      return { ...state, cursor: neighbour(state.cursor, 1) };
    case "appendText":
      return withEdit(state, { kind: "append", text: action.text });
    case "backspace":
      return withEdit(state, { kind: "backspace" });
    case "editInEditor":
      return { ...state, message: "" };
    case "editorReturned":
      return action.text === null
        ? { ...state, message: EDITOR_EXITED_MESSAGE }
        : withValue(state, state.cursor, action.text);
    case "editorFailed":
      return { ...state, message: `could not run the editor: ${action.text}` };
    case "requestQuit":
      return isDirty(state)
        ? { ...state, mode: { kind: "confirmQuit" } }
        : { ...state, done: true };
    case "confirmQuit":
      return { ...state, done: true };
    case "cancelQuit":
      return { ...state, mode: { kind: "form" } };
    case "save":
      return { ...state, message: "" };
    case "saveFailed": {
      const first = action.problems[0];
      return first === undefined ? state : { ...state, message: first.text, cursor: first.field };
    }
    case "saved":
      return { ...state, mode: { kind: "wrote", testDir: action.testDir } };
    case "dismiss":
      return state.mode.kind === "wrote" ? { ...state, done: true } : state;
  }
}

/** What a typed key does to the field under the cursor; null for a key that
 *  types nothing. Enter and Escape type nothing either: the mode's key table
 *  owns them, so the caller consults that table first. */
export function editActionFor(event: KeyEvent): FormAction | null {
  const edit = lineEditAction(event);
  if (edit === null) return null;
  switch (edit.kind) {
    case "append":
      return { kind: "appendText", text: edit.text };
    case "backspace":
      return { kind: "backspace" };
    case "cancel":
    case "submit":
      return null;
  }
}

function neighbour(cursor: FieldName, delta: number): FieldName {
  const index = FIELDS.findIndex((field) => field.name === cursor);
  const next = Math.min(FIELDS.length - 1, Math.max(0, index + delta));
  return FIELDS[next].name;
}

/** A keystroke lands in the field under the cursor and clears the footer
 *  message, since the user has moved on from whatever it reported. */
function withEdit(state: FormState, edit: LineEditAction): FormState {
  return withValue(
    { ...state, message: "" },
    state.cursor,
    applyLineEdit(state.values[state.cursor], edit),
  );
}

function withValue(state: FormState, field: FieldName, value: string): FormState {
  return { ...state, values: { ...state.values, [field]: value } };
}
