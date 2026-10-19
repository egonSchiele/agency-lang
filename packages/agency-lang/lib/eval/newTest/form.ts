// The state of the `agency eval new` form and every change it can go
// through. Pure: the command runs the two effects (the external editor and
// the write) and reports their outcomes back as actions, so each screen the
// form shows is a mode of this state and each transition is a reducer case.
import { applyLineEdit, lineEditAction } from "@/tui/lineEditor.js";
import type { KeyEvent } from "@/tui/input/types.js";

export type FieldName = "id" | "description" | "input" | "files" | "goal";

export type FieldSpec = {
  name: FieldName;
  label: string;
  required: boolean;
  /** Enter opens `$EDITOR` on this field when one is set. */
  long: boolean;
  /** Shown in place of the value while the field is empty. */
  help: string;
};

/** The one place a field is defined. The reducer, the view and the
 *  validator all read this table. */
export const FIELDS: FieldSpec[] = [
  {
    name: "id",
    label: "id",
    required: true,
    long: false,
    help: "folder name: letters, digits, - and _",
  },
  {
    name: "description",
    label: "description",
    required: false,
    long: false,
    help: "one line on why the test exists",
  },
  {
    name: "input",
    label: "input",
    required: false,
    long: true,
    help: "what the agent is told; empty for an agent that takes no input",
  },
  {
    name: "files",
    label: "files",
    required: false,
    long: false,
    help: "a directory to seed into the working directory, relative to the suite",
  },
  {
    name: "goal",
    label: "goal",
    required: true,
    long: true,
    help: "what a good answer looks like; the goal judge scores against it",
  },
];

export type FieldEditor = { kind: "none" } | { kind: "field"; field: FieldName; draft: string };

export type Problem = { field: FieldName; text: string };

export type FormMode =
  { kind: "form" } | { kind: "confirmQuit" } | { kind: "wrote"; testDir: string };

export type FormState = {
  suiteDir: string;
  values: Record<FieldName, string>;
  cursor: FieldName;
  editor: FieldEditor;
  mode: FormMode;
  /** The footer message: the first problem, or what happened to the editor. */
  message: string;
  done: boolean;
};

export type FormAction =
  | { kind: "moveUp" }
  | { kind: "moveDown" }
  | { kind: "beginEdit" }
  | { kind: "appendText"; text: string }
  | { kind: "backspace" }
  | { kind: "cancelEdit" }
  | { kind: "submitEdit" }
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
    editor: { kind: "none" },
    mode: { kind: "form" },
    message: "",
    done: false,
  };
}

/** Whether anything has been typed into a field. */
export function isDirty(state: FormState): boolean {
  return FIELDS.some((field) => state.values[field.name] !== EMPTY_VALUES[field.name]);
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
    case "beginEdit":
      return {
        ...state,
        message: "",
        editor: { kind: "field", field: state.cursor, draft: state.values[state.cursor] },
      };
    case "appendText":
      return withDraft(state, (draft) =>
        applyLineEdit(draft, { kind: "append", text: action.text }),
      );
    case "backspace":
      return withDraft(state, (draft) => applyLineEdit(draft, { kind: "backspace" }));
    case "cancelEdit":
      return { ...state, editor: { kind: "none" } };
    case "submitEdit":
      return state.editor.kind === "none"
        ? state
        : withValue(state, state.editor.field, state.editor.draft);
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

/** What a key means while a field is being edited; null for a key that does
 *  nothing there. */
export function editActionFor(event: KeyEvent): FormAction | null {
  const edit = lineEditAction(event);
  if (edit === null) return null;
  switch (edit.kind) {
    case "append":
      return { kind: "appendText", text: edit.text };
    case "backspace":
      return { kind: "backspace" };
    case "cancel":
      return { kind: "cancelEdit" };
    case "submit":
      return { kind: "submitEdit" };
  }
}

function neighbour(cursor: FieldName, delta: number): FieldName {
  const index = FIELDS.findIndex((field) => field.name === cursor);
  const next = Math.min(FIELDS.length - 1, Math.max(0, index + delta));
  return FIELDS[next].name;
}

function withDraft(state: FormState, update: (draft: string) => string): FormState {
  if (state.editor.kind === "none") {
    return state;
  }
  return { ...state, editor: { ...state.editor, draft: update(state.editor.draft) } };
}

function withValue(state: FormState, field: FieldName, value: string): FormState {
  return { ...state, values: { ...state.values, [field]: value }, editor: { kind: "none" } };
}
