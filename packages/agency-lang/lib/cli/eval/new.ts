// `agency eval new <suite-dir>`: a form that writes a test folder. The form
// itself is pure state (lib/eval/newTest/form.ts); this file owns the
// terminal, the key tables per mode, and the two effects the form asks for:
// opening the editor and writing the folder.
import * as fs from "fs";
import * as path from "path";

import { editorCommand, openInEditor } from "@/eval/newTest/editor.js";
import {
  editActionFor,
  initialForm,
  isChoiceRow,
  isKindRow,
  isLastRow,
  isLong,
  reduceForm,
  valueAt,
  type FormAction,
  type FormState,
  type Row,
} from "@/eval/newTest/form.js";
import { renderForm, scrolledToCursor, wroteSummary } from "@/eval/newTest/formView.js";
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
  /** Prints a line once the screen is gone: the folder written and the
   *  commands to run next. They stay in the terminal's scrollback, which a
   *  screen that any key dismisses could not promise. */
  print: (text: string) => void;
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
 *  letter goes into the row under the cursor. Escape is not bound either:
 *  the terminal sends a bare Escape for any Alt or Option chord it does
 *  not know, such as Option+Backspace, and quitting on one of those
 *  partway through a word would throw the form away. Remove is Ctrl+X and
 *  not Ctrl+D: `cursorBindings` in `lib/tui/keymap.ts` pages down on
 *  Ctrl+D in every other Agency TUI. */
function formBindings(state: FormState, openEditor: OpenEditor): KeyBinding<FormAction>[] {
  const longField = isLong(state, state.cursor) && openEditor !== null;
  const last = isLastRow(state, state.cursor);
  const choice = isChoiceRow(state, state.cursor);
  const kindRow = isKindRow(state.cursor);
  return [
    { keys: ["Up"], help: "previous field", hint: "↑↓ move", run: () => ({ kind: "moveUp" }) },
    { keys: ["Down"], help: "next field", run: () => ({ kind: "moveDown" }) },
    {
      keys: ["Enter"],
      help: "next field",
      hint: "Enter next",
      when: () => !last,
      run: () => ({ kind: "moveDown" }),
    },
    {
      keys: ["Enter"],
      help: "save the test",
      hint: "Enter save",
      when: () => last,
      run: () => ({ kind: "requestSave" }),
    },
    {
      keys: ["Ctrl+E"],
      help: "open the field in $EDITOR",
      hint: "Ctrl+E editor",
      when: () => longField,
      run: () => ({ kind: "editInEditor" }),
    },
    {
      keys: ["Ctrl+S"],
      help: "save the test",
      hint: "Ctrl+S save",
      run: () => ({ kind: "requestSave" }),
    },
    {
      keys: ["Left"],
      help: "previous option",
      when: () => choice,
      run: () => ({ kind: "pickPrevious" }),
    },
    {
      keys: ["Right"],
      help: "next option",
      hint: "←→ pick",
      when: () => choice,
      run: () => ({ kind: "pickNext" }),
    },
    {
      keys: ["Ctrl+N"],
      help: "add a grader",
      hint: "Ctrl+N grader",
      run: () => ({ kind: "addGrader" }),
    },
    {
      keys: ["Ctrl+X"],
      help: "remove this grader",
      hint: "Ctrl+X remove",
      when: () => kindRow,
      run: () => ({ kind: "requestRemove" }),
    },
    { keys: ["Ctrl+C"], help: "quit", hint: "Ctrl+C quit", run: () => ({ kind: "requestQuit" }) },
  ];
}

/** The two questions answer to `y` alone, never to the key that asked
 *  them: a held Ctrl+C or Enter would otherwise ask and answer in one go. */
const CONFIRM_QUIT_BINDINGS: KeyBinding<FormAction>[] = [
  { keys: ["y"], help: "discard and quit", run: () => ({ kind: "confirmQuit" }) },
  { keys: ["n", "Escape"], help: "back to the form", run: () => ({ kind: "cancelQuit" }) },
];

const CONFIRM_SAVE_BINDINGS: KeyBinding<FormAction>[] = [
  { keys: ["y"], help: "write the test", run: () => ({ kind: "save" }) },
  { keys: ["n", "Escape"], help: "back to the form", run: () => ({ kind: "cancelSave" }) },
];

const CONFIRM_REMOVE_BINDINGS: KeyBinding<FormAction>[] = [
  { keys: ["y"], help: "remove the grader", run: () => ({ kind: "confirmRemove" }) },
  { keys: ["n", "Escape"], help: "back to the form", run: () => ({ kind: "cancelRemove" }) },
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
      return runKey(CONFIRM_QUIT_BINDINGS, key, NO_ACTION);
    case "confirmSave":
      return runKey(CONFIRM_SAVE_BINDINGS, key, NO_ACTION);
    case "confirmRemove":
      return runKey(CONFIRM_REMOVE_BINDINGS, key, NO_ACTION);
  }
}

/** The actions that touch the world, each answered with its outcome. A
 *  failure becomes the footer message; nothing typed is lost to it. A save
 *  is asked for in two steps: `requestSave` validates and, when the form
 *  is complete, asks "write this test?", and `save` is the `y` to that. So
 *  an Enter meant as a line break, or a pasted newline, cannot write a
 *  half-finished test by itself. */
function performIntent(state: FormState, action: FormAction, openEditor: OpenEditor): FormState {
  if (action.kind === "editInEditor" && openEditor !== null) {
    try {
      const text = openEditor(valueAt(state, state.cursor));
      return reduceForm(state, { kind: "editorReturned", text });
    } catch (error) {
      return reduceForm(state, { kind: "editorFailed", text: messageOf(error) });
    }
  }
  if (action.kind === "requestSave") {
    const problems = validateForm(state);
    return problems.length > 0
      ? reduceForm(state, { kind: "saveFailed", problems })
      : reduceForm(state, { kind: "askSave" });
  }
  if (action.kind === "save") {
    try {
      return reduceForm(state, { kind: "saved", testDir: writeTest(state) });
    } catch (error) {
      const row: Row = error instanceof TestWriteError ? error.row : { kind: "field", name: "id" };
      const problems = [{ row, text: messageOf(error) }];
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
  let final: FormState | null = null;
  try {
    final = await screen.runLoop<FormState>({
      initialState: initialForm(options.suiteDir),
      render: (state) =>
        renderForm({
          state,
          width: size.width,
          height: size.height,
          hints: formHints(state, openEditor),
        }),
      handleKey: (state, event) => {
        const action = actionFor(state, event, openEditor);
        if (action === null) {
          return state;
        }
        const next = performIntent(reduceForm(state, action), action, openEditor);
        return scrolledToCursor(next, size.width, size.height);
      },
      isDone: (state) => state.done,
    });
  } finally {
    screen.destroy();
  }
  if (final !== null && final.written !== null) {
    for (const text of wroteSummary(
      final.written,
      nextCommands(options.suiteDir, final.values.id),
    )) {
      options.print(text);
    }
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
  await evalNew({ suiteDir, openTerminal: openRealTerminal, print: (text) => console.log(text) });
}
