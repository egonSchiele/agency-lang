// The real terminal the test form draws on, and `$EDITOR` when set. Shared
// by `eval new` and `eval edit`.
import { editorCommand, openInEditor } from "@/eval/newTest/editor.js";
import { TerminalInput } from "@/tui/input/terminal.js";
import type { InputSource } from "@/tui/input/types.js";
import { TerminalOutput } from "@/tui/output/terminal.js";
import type { OutputTarget } from "@/tui/output/types.js";

import { terminalDimension } from "./label.js";

/** Opens the user's editor on a row's text; null when `$EDITOR` is unset. */
export type OpenEditor = ((text: string) => string | null) | null;

/** Where the form draws and reads keys, and how it opens an editor. */
export type FormTerminal = {
  input: InputSource;
  output: OutputTarget;
  size: { width: number; height: number };
  openEditor: OpenEditor;
};

const DEFAULT_COLUMNS = 100;
const DEFAULT_ROWS = 30;

/** The real terminal; `command` names the caller in the refusal. */
export function openRealTerminal(command: string): FormTerminal {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    throw new Error(`${command} needs an interactive terminal`);
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
