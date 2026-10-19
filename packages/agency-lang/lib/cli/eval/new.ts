// `agency eval new <suite-dir>`: a form that writes a test folder. The form
// itself is pure state (lib/eval/newTest/form.ts); this file owns the
// terminal, the key tables per mode, and the two effects the form asks for:
// opening the editor and writing the folder.
import * as fs from "fs";
import * as path from "path";

import { editorCommand, openInEditor } from "@/eval/newTest/editor.js";
import {
  editActionFor,
  fieldSpec,
  initialForm,
  reduceForm,
  type FormAction,
  type FormState,
} from "@/eval/newTest/form.js";
import { renderForm } from "@/eval/newTest/formView.js";
import { nextCommands, validateForm, writeTest } from "@/eval/newTest/write.js";
import { formatKey } from "@/tui/input/format.js";
import { TerminalInput } from "@/tui/input/terminal.js";
import type { InputSource, KeyEvent } from "@/tui/input/types.js";
import { hintsFrom, runKey, type KeyBinding } from "@/tui/keymap.js";
import { TerminalOutput } from "@/tui/output/terminal.js";
import type { OutputTarget } from "@/tui/output/types.js";
import { Screen } from "@/tui/screen.js";

import { terminalDimension } from "./label.js";

/** Opens the user's editor on a field's text; null when `$EDITOR` is unset. */
export type OpenEditor = ((text: string) => string | null) | null;

export type EvalNewOptions = {
  suiteDir: string;
  input: InputSource;
  output: OutputTarget;
  size: { width: number; height: number };
  openEditor: OpenEditor;
};

/** Refuse anything the loader would not read as a directory of test folders:
 *  a file, a folder that is itself one test, or the file form of a suite. */
export function assertSuiteDirectory(suiteDir: string): void {
  if (!fs.existsSync(suiteDir) || !fs.statSync(suiteDir).isDirectory()) {
    throw new Error(`${suiteDir} is not a directory`);
  }
  if (fs.existsSync(path.join(suiteDir, "test.json"))) {
    throw new Error(
      `${suiteDir} holds a test.json, so it is one test, not a suite; pass its parent directory`,
    );
  }
  const jsonFiles = fs.readdirSync(suiteDir).filter((name) => name.endsWith(".json"));
  if (jsonFiles.length > 0) {
    throw new Error(
      `${suiteDir} holds ${jsonFiles.join(", ")}: a suite written as JSON files, which this form does not edit; use a directory of test folders`,
    );
  }
}

const NO_ACTION: FormAction | null = null;

function formBindings(state: FormState, openEditor: OpenEditor): KeyBinding<FormAction>[] {
  const longField = fieldSpec(state.cursor).long && openEditor !== null;
  return [
    { keys: ["Up", "k"], help: "previous field", hint: "↑↓ move", run: () => ({ kind: "moveUp" }) },
    { keys: ["Down", "j"], help: "next field", run: () => ({ kind: "moveDown" }) },
    {
      keys: ["Enter"],
      help: "edit the field",
      hint: "Enter edit",
      run: () => (longField ? { kind: "editInEditor" } : { kind: "beginEdit" }),
    },
    { keys: ["s"], help: "save the test", hint: "s save", run: () => ({ kind: "save" }) },
    {
      keys: ["q", "Escape", "Ctrl+C"],
      help: "quit",
      hint: "q quit",
      run: () => ({ kind: "requestQuit" }),
    },
  ];
}

const CONFIRM_BINDINGS: KeyBinding<FormAction>[] = [
  { keys: ["y", "Ctrl+C"], help: "discard and quit", run: () => ({ kind: "confirmQuit" }) },
  { keys: ["n", "Escape"], help: "back to the form", run: () => ({ kind: "cancelQuit" }) },
];

/** The hints the form footer shows, from the same table that handles the keys. */
export function formHints(state: FormState, openEditor: OpenEditor): string {
  return hintsFrom(formBindings(state, openEditor));
}

function actionFor(state: FormState, event: KeyEvent, openEditor: OpenEditor): FormAction | null {
  if (state.editor.kind === "field") {
    return editActionFor(event);
  }
  const key = formatKey(event);
  switch (state.mode.kind) {
    case "form":
      return runKey(formBindings(state, openEditor), key, NO_ACTION);
    case "confirmQuit":
      return runKey(CONFIRM_BINDINGS, key, NO_ACTION);
    case "wrote":
      return { kind: "dismiss" };
  }
}

/** The two actions that touch the world, each answered with its outcome. */
function performIntent(state: FormState, action: FormAction, openEditor: OpenEditor): FormState {
  if (action.kind === "editInEditor" && openEditor !== null) {
    const text = openEditor(state.values[state.cursor]);
    return reduceForm(state, { kind: "editorReturned", text });
  }
  if (action.kind === "save") {
    const problems = validateForm(state);
    if (problems.length > 0) {
      return reduceForm(state, { kind: "saveFailed", problems });
    }
    try {
      return reduceForm(state, { kind: "saved", testDir: writeTest(state) });
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      return reduceForm(state, { kind: "saveFailed", problems: [{ field: "id", text }] });
    }
  }
  return state;
}

export async function evalNew(options: EvalNewOptions): Promise<void> {
  assertSuiteDirectory(options.suiteDir);
  const screen = new Screen({ input: options.input, output: options.output, ...options.size });
  const { openEditor } = options;
  try {
    await screen.runLoop<FormState>({
      initialState: initialForm(options.suiteDir),
      render: (state) =>
        renderForm({
          state,
          width: options.size.width,
          height: options.size.height,
          hints: formHints(state, openEditor),
          nextCommands: nextCommands(options.suiteDir, state.values.id),
        }),
      handleKey: (state, event) => {
        const action = actionFor(state, event, openEditor);
        if (action === null) {
          return state;
        }
        return performIntent(reduceForm(state, action), action, openEditor);
      },
      isDone: (state) => state.done,
    });
  } finally {
    screen.destroy();
  }
}

const DEFAULT_COLUMNS = 100;
const DEFAULT_ROWS = 30;

/** The command as the CLI runs it: a real terminal, and `$EDITOR` when set. */
export async function runEvalNew(suiteDir: string): Promise<void> {
  // The directory is checked first, so a wrong path is reported even from
  // a pipe, where the terminal check below would otherwise speak first.
  assertSuiteDirectory(suiteDir);
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    throw new Error("eval new needs an interactive terminal");
  }
  const input = new TerminalInput({ suppressSigint: true });
  const output = new TerminalOutput();
  const editor = editorCommand(process.env);
  const openEditor: OpenEditor =
    editor === null ? null : (text) => openInEditor(text, editor, { input, output });
  await evalNew({
    suiteDir,
    input,
    output,
    size: {
      width: terminalDimension(process.stdout.columns, DEFAULT_COLUMNS),
      height: terminalDimension(process.stdout.rows, DEFAULT_ROWS),
    },
    openEditor,
  });
}
