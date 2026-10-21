// The state of the `agency eval new` form and every change it can go
// through. Pure: the command runs the two effects (the external editor and
// the write) and reports their outcomes back as actions, so each screen the
// form shows is a mode of this state and each transition is a reducer case.
// Every field is live: a typed key goes straight into the row under the
// cursor, so there is no draft to commit and nothing to lose by moving on.
// The cursor names a row: one of the five fields, or one question of one
// grader in the section below them.
import { applyLineEdit, lineEditAction, type LineEditAction } from "@/tui/lineEditor.js";
import type { KeyEvent } from "@/tui/input/types.js";

import {
  autoFill,
  choiceValue,
  KIND_NEEDED,
  questionsFor,
  type GraderDraft,
  type QuestionSpec,
} from "./graders.js";

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

/** Where the cursor can be: a field, or one question of one grader. */
export type Row =
  { kind: "field"; name: FieldName } | { kind: "grader"; index: number; question: string };

export function sameRow(a: Row, b: Row): boolean {
  if (a.kind === "field" && b.kind === "field") {
    return a.name === b.name;
  }
  if (a.kind === "grader" && b.kind === "grader") {
    return a.index === b.index && a.question === b.question;
  }
  return false;
}

export type Problem = { row: Row; text: string };

export type FormMode =
  | { kind: "form" }
  | { kind: "confirmQuit" }
  | { kind: "confirmSave" }
  | { kind: "confirmRemove"; index: number };

export type FormState = {
  suiteDir: string;
  values: Record<FieldName, string>;
  graders: GraderDraft[];
  cursor: Row;
  mode: FormMode;
  /** The footer message: the first problem, or what happened to the editor. */
  message: string;
  /** The first body line on screen; the command keeps the cursor in view. */
  scrollTop: number;
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
  | { kind: "saved"; testDir: string }
  | { kind: "addGrader" }
  | { kind: "requestRemove" }
  | { kind: "confirmRemove" }
  | { kind: "cancelRemove" }
  | { kind: "pickNext" }
  | { kind: "pickPrevious" }
  /** Enter on the last row while its grader has no kind picked yet. */
  | { kind: "kindNeeded" };

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
    graders: [],
    cursor: { kind: "field", name: FIELDS[0].name },
    mode: { kind: "form" },
    message: "",
    scrollTop: 0,
    done: false,
    written: null,
  };
}

/** Whether anything has been typed into a field, or a grader added. */
export function isDirty(state: FormState): boolean {
  return (
    state.graders.length > 0 ||
    FIELDS.some((field) => state.values[field.name] !== EMPTY_VALUES[field.name])
  );
}

/** Every row the cursor can visit, in order: the fields, then each
 *  grader's questions. */
export function rowsOf(state: FormState): Row[] {
  const fields = FIELDS.map((field): Row => ({ kind: "field", name: field.name }));
  const graders = state.graders.flatMap((draft, index) =>
    questionsFor(draft).map((question): Row => ({
      kind: "grader",
      index,
      question: question.name,
    })),
  );
  return [...fields, ...graders];
}

/** The question a grader row names; null for a field row. */
export function questionAt(state: FormState, row: Row): QuestionSpec | null {
  if (row.kind === "field") {
    return null;
  }
  const draft = state.graders[row.index];
  if (draft === undefined) {
    return null;
  }
  return questionsFor(draft).find((question) => question.name === row.question) ?? null;
}

/** The field's value, or the grader's answer (a choice reads its default). */
export function valueAt(state: FormState, row: Row): string {
  if (row.kind === "field") {
    return state.values[row.name];
  }
  const question = questionAt(state, row);
  const draft = state.graders[row.index];
  if (question === null || draft === undefined) {
    return "";
  }
  return choiceValue(draft.answers, question);
}

/** Whether the cursor is on the last row, where Enter saves instead of
 *  moving on. */
export function isLastRow(state: FormState, row: Row): boolean {
  const rows = rowsOf(state);
  return sameRow(rows[rows.length - 1], row);
}

export function isChoiceRow(state: FormState, row: Row): boolean {
  return questionAt(state, row)?.input.kind === "choice";
}

export function isKindRow(row: Row): boolean {
  return row.kind === "grader" && row.question === "kind";
}

/** A kind row whose grader has no kind picked yet: Enter there must not
 *  save, since the user has not said what the grader checks. */
export function isUnpickedKindRow(state: FormState, row: Row): boolean {
  return isKindRow(row) && valueAt(state, row) === "";
}

/** A long field, or a long text question: Ctrl+E opens `$EDITOR` on it. */
export function isLong(state: FormState, row: Row): boolean {
  if (row.kind === "field") {
    return fieldSpec(row.name).long;
  }
  const input = questionAt(state, row)?.input;
  return input?.kind === "text" && input.long;
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
      return { ...state, message: "", cursor: neighbour(state, -1) };
    case "moveDown":
      return { ...state, message: "", cursor: neighbour(state, 1) };
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
        : { ...state, mode: { kind: "form" }, message: first.text, cursor: first.row };
    }
    case "saved":
      return { ...state, done: true, written: action.testDir };
    case "addGrader":
      return {
        ...state,
        message: "",
        graders: [...state.graders, { answers: {} }],
        cursor: { kind: "grader", index: state.graders.length, question: "kind" },
      };
    case "requestRemove":
      return isKindRow(state.cursor) && state.cursor.kind === "grader"
        ? { ...state, mode: { kind: "confirmRemove", index: state.cursor.index } }
        : state;
    case "confirmRemove":
      return state.mode.kind === "confirmRemove" ? withoutGrader(state, state.mode.index) : state;
    case "cancelRemove":
      return { ...state, mode: { kind: "form" } };
    case "pickNext":
      return withPick(state, 1);
    case "pickPrevious":
      return withPick(state, -1);
    case "kindNeeded":
      return { ...state, message: KIND_NEEDED };
  }
}

/** What a typed key does to the row under the cursor; null for a key that
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

function neighbour(state: FormState, delta: number): Row {
  const rows = rowsOf(state);
  const index = rows.findIndex((row) => sameRow(row, state.cursor));
  const next = Math.min(rows.length - 1, Math.max(0, index + delta));
  return rows[next];
}

/** A keystroke lands in the row under the cursor and clears the footer
 *  message, since the user has moved on from whatever it reported. A
 *  choice row takes no typing. */
function withEdit(state: FormState, edit: LineEditAction): FormState {
  const cleared = { ...state, message: "" };
  if (isChoiceRow(state, state.cursor)) {
    return cleared;
  }
  return withValue(cleared, state.cursor, applyLineEdit(valueAt(state, state.cursor), edit));
}

function withValue(state: FormState, row: Row, value: string): FormState {
  if (row.kind === "field") {
    return { ...state, values: { ...state.values, [row.name]: value } };
  }
  if (isChoiceRow(state, row)) {
    return state;
  }
  return withAnswers(state, row.index, (answers) => ({ ...answers, [row.question]: value }));
}

function withAnswers(
  state: FormState,
  index: number,
  change: (answers: Record<string, string>) => Record<string, string>,
): FormState {
  const graders = state.graders.map((draft, i) =>
    i === index ? { answers: change(draft.answers) } : draft,
  );
  return { ...state, graders };
}

/** Move a choice row's answer to the next or previous option, clamped at
 *  the ends, then fill the defaults that follow from the pick. */
function withPick(state: FormState, delta: number): FormState {
  const row = state.cursor;
  const question = questionAt(state, row);
  if (row.kind !== "grader" || question === null || question.input.kind !== "choice") {
    return state;
  }
  const options = question.input.options;
  const draft = state.graders[row.index];
  const current = draft.answers[question.name] ?? "";
  const at = options.findIndex((option) => option.value === current);
  // An unanswered choice with help steps onto the first option; one that
  // defaults is already read as its first option.
  const from = at >= 0 ? at : question.input.unset === null ? 0 : -1;
  const next = Math.min(options.length - 1, Math.max(0, from + delta));
  return withAnswers({ ...state, message: "" }, row.index, (answers) =>
    autoFill({ ...answers, [question.name]: options[next].value }),
  );
}

/** Remove a grader and put the cursor on the row just before its first.
 *  That row is a field or an earlier grader's, so its index still holds. */
function withoutGrader(state: FormState, index: number): FormState {
  const rows = rowsOf(state);
  const first = rows.findIndex((row) => row.kind === "grader" && row.index === index);
  const cursor = rows[Math.max(0, first - 1)];
  return {
    ...state,
    mode: { kind: "form" },
    message: "",
    graders: state.graders.filter((_, i) => i !== index),
    cursor,
  };
}
