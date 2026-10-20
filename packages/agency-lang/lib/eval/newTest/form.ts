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
    help: "what the agent is given: the entry node's one parameter, or {input} in a command (optional)",
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

export type FormMode = { kind: "form" } | { kind: "confirmQuit" } | { kind: "confirmSave" };

export type FormState = {
  suiteDir: string;
  values: Record<FieldName, string>;
  cursor: FieldName;
  mode: FormMode;
  /** The footer message: the first problem, or what happened to the editor. */
  message: string;
  done: boolean;
  /** The test folder, once it is written. The command prints it after the
   *  screen closes. */
  written: string | null;
};

export type FormAction =
  | { kind: "moveUp" }
  | { kind: "moveDown" }
  | { kind: "appendText"; text: string }
  | { kind: "backspace" }
  | { kind: "backspaceWord" }
  /** An intent: the command opens the editor and reports `editorReturned`. */
  | { kind: "editInEditor" }
  | { kind: "editorReturned"; text: string | null }
  | { kind: "editorFailed"; text: string }
  | { kind: "requestQuit" }
  | { kind: "confirmQuit" }
  | { kind: "cancelQuit" }
  /** An intent: the command validates, then reports `saveFailed` or `askSave`. */
  | { kind: "requestSave" }
  | { kind: "askSave" }
  | { kind: "cancelSave" }
  /** An intent: the command writes, then reports one of the next two. */
  | { kind: "save" }
  | { kind: "saveFailed"; problems: Problem[] }
  | { kind: "saved"; testDir: string };

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
    written: null,
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
      return { ...state, message: "", cursor: neighbour(state.cursor, -1) };
    case "moveDown":
      return { ...state, message: "", cursor: neighbour(state.cursor, 1) };
    case "appendText":
      return withEdit(state, { kind: "append", text: action.text });
    case "backspace":
      return withEdit(state, { kind: "backspace" });
    case "backspaceWord":
      return withEdit(state, { kind: "backspaceWord" });
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
    case "requestSave":
    case "save":
      return { ...state, message: "" };
    case "askSave":
      return { ...state, mode: { kind: "confirmSave" } };
    case "cancelSave":
      return { ...state, mode: { kind: "form" } };
    case "saveFailed": {
      const first = action.problems[0];
      return first === undefined
        ? state
        : { ...state, mode: { kind: "form" }, message: first.text, cursor: first.field };
    }
    case "saved":
      return { ...state, done: true, written: action.testDir };
  }
}

/** What a typed key does to the field under the cursor; null for a key that
 *  types nothing. Enter and Escape type nothing either: Enter belongs to
 *  the mode's key table, which the caller consults first, and a bare
 *  Escape is what the terminal sends for an Option chord it does not know,
 *  so it is dropped rather than quitting the form. */
export function editActionFor(event: KeyEvent): FormAction | null {
  const edit = lineEditAction(event);
  if (edit === null) return null;
  switch (edit.kind) {
    case "append":
      return { kind: "appendText", text: edit.text };
    case "backspace":
      return { kind: "backspace" };
    case "backspaceWord":
      return { kind: "backspaceWord" };
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
