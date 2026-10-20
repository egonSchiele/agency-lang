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
  isLastField,
  reduceForm,
  type FormAction,
  type FormState,
} from "@/eval/newTest/form.js";
import { renderForm } from "@/eval/newTest/formView.js";
import { nextCommands, TestWriteError, validateForm, writeTest } from "@/eval/newTest/write.js";
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

/** Where the form draws and reads keys, and how it opens an editor. */
export type FormTerminal = {
  input: InputSource;
  output: OutputTarget;
  size: { width: number; height: number };
  openEditor: OpenEditor;
};

export type EvalNewOptions = {
  suiteDir: string;
  /** Called once the suite directory has passed its check, so a wrong path
   *  is reported before the terminal is touched or refused. */
  openTerminal: () => FormTerminal;
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

/** The keys that are not typing. Letters are never bound here, because a
 *  letter goes into the field under the cursor. */
function formBindings(state: FormState, openEditor: OpenEditor): KeyBinding<FormAction>[] {
  const longField = fieldSpec(state.cursor).long && openEditor !== null;
  const last = isLastField(state.cursor);
  return [
    { keys: ["Up"], help: "previous field", hint: "↑↓ move", run: () => ({ kind: "moveUp" }) },
    { keys: ["Down"], help: "next field", run: () => ({ kind: "moveDown" }) },
    {
      keys: ["Enter"],
      help: last ? "save the test" : "next field",
      hint: last ? "Enter save" : "Enter next",
      run: () => (last ? { kind: "save" } : { kind: "moveDown" }),
    },
    {
      keys: ["Ctrl+E"],
      help: "open the field in $EDITOR",
      hint: longField ? "Ctrl+E editor" : undefined,
      run: () => (longField ? { kind: "editInEditor" } : undefined),
    },
    { keys: ["Ctrl+S"], help: "save the test", hint: "Ctrl+S save", run: () => ({ kind: "save" }) },
    {
      keys: ["Escape", "Ctrl+C"],
      help: "quit",
      hint: "Esc quit",
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

/** The mode's key table first, then the line editor: a key the table does
 *  not name is typed into the field under the cursor. */
function actionFor(state: FormState, event: KeyEvent, openEditor: OpenEditor): FormAction | null {
  const key = formatKey(event);
  switch (state.mode.kind) {
    case "form":
      return runKey(formBindings(state, openEditor), key, NO_ACTION) ?? editActionFor(event);
    case "confirmQuit":
      return runKey(CONFIRM_BINDINGS, key, NO_ACTION);
    case "wrote":
      return { kind: "dismiss" };
  }
}

/** The two actions that touch the world, each answered with its outcome.
 *  A failure becomes the footer message; nothing typed is lost to it. */
function performIntent(state: FormState, action: FormAction, openEditor: OpenEditor): FormState {
  if (action.kind === "editInEditor" && openEditor !== null) {
    try {
      const text = openEditor(state.values[state.cursor]);
      return reduceForm(state, { kind: "editorReturned", text });
    } catch (error) {
      return reduceForm(state, { kind: "editorFailed", text: messageOf(error) });
    }
  }
  if (action.kind === "save") {
    const problems = validateForm(state);
    if (problems.length > 0) {
      return reduceForm(state, { kind: "saveFailed", problems });
    }
    try {
      return reduceForm(state, { kind: "saved", testDir: writeTest(state) });
    } catch (error) {
      const field = error instanceof TestWriteError ? error.field : "id";
      const problems = [{ field, text: messageOf(error) }];
      return reduceForm(state, { kind: "saveFailed", problems });
    }
  }
  return state;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function evalNew(options: EvalNewOptions): Promise<void> {
  assertSuiteDirectory(options.suiteDir);
  const terminal = options.openTerminal();
  const { openEditor, size } = terminal;
  const screen = new Screen({ input: terminal.input, output: terminal.output, ...size });
  try {
    await screen.runLoop<FormState>({
      initialState: initialForm(options.suiteDir),
      render: (state) =>
        renderForm({
          state,
          width: size.width,
          height: size.height,
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

/** The real terminal, and `$EDITOR` when set. */
function openRealTerminal(): FormTerminal {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    throw new Error("eval new needs an interactive terminal");
  }
  const input = new TerminalInput({ suppressSigint: true });
  const output = new TerminalOutput();
  const editor = editorCommand(process.env);
  const openEditor: OpenEditor =
    editor === null ? null : (text) => openInEditor(text, editor, { input, output });
  return {
    input,
    output,
    size: {
      width: terminalDimension(process.stdout.columns, DEFAULT_COLUMNS),
      height: terminalDimension(process.stdout.rows, DEFAULT_ROWS),
    },
    openEditor,
  };
}

/** The command as the CLI runs it. */
export async function runEvalNew(suiteDir: string): Promise<void> {
  await evalNew({ suiteDir, openTerminal: openRealTerminal });
}
