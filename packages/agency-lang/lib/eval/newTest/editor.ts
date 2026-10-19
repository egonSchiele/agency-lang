// Editing a long field in the user's own editor. The form hands the
// terminal to `$EDITOR` on a temp file and takes it back when the editor
// exits. The hand-off has an order that must not change, so it lives in one
// function here and nowhere else.
import { spawnSync } from "node:child_process";
import * as fs from "fs";
import * as path from "path";

import { safeDeleteDirectory } from "@/utils.js";
import { makeAgencyTempDir } from "@/utils/agencyTempDir.js";

/** One half of the terminal: it can be handed to a child process and taken
 *  back. Both `TerminalInput` and `TerminalOutput` are one. */
export type Releasable = { release: () => void; reclaim: () => void };

/** The two halves of the terminal the form owns. */
export type ReleasableTerminal = { input: Releasable; output: Releasable };

export type EditorCommand = { command: string; args: string[] };

/** `$EDITOR`, split on spaces so `code --wait` works. A quoted path with a
 *  space in it is not supported. Null when the variable is unset or blank. */
export function editorCommand(env: Record<string, string | undefined>): EditorCommand | null {
  const parts = (env.EDITOR ?? "").split(" ").filter((part) => part !== "");
  if (parts.length === 0) {
    return null;
  }
  return { command: parts[0], args: parts.slice(1) };
}

/** Run `fn` with the terminal handed to a child process, then take it back.
 *  The output leaves the alternate screen and stops answering the signals
 *  the child's keys send; the input stops reading stdin, so the child is the
 *  only reader of the terminal while it runs. */
export function withTerminalReleased<T>(terminal: ReleasableTerminal, fn: () => T): T {
  terminal.output.release();
  terminal.input.release();
  try {
    return fn();
  } finally {
    terminal.input.reclaim();
    terminal.output.reclaim();
  }
}

/** Open `text` in the editor and return what was saved, or null when the
 *  editor exited with a non-zero status. Editors end a file with a newline;
 *  that one is dropped, so the value matches what typing it in place gives. */
export function openInEditor(
  text: string,
  editor: EditorCommand,
  terminal: ReleasableTerminal,
  spawn: typeof spawnSync = spawnSync,
): string | null {
  const dir = makeAgencyTempDir("eval-new");
  const file = path.join(dir, "field.md");
  fs.writeFileSync(file, text);
  try {
    const result = withTerminalReleased(terminal, () =>
      spawn(editor.command, [...editor.args, file], { stdio: "inherit", shell: false }),
    );
    if (result.error !== undefined) {
      throw result.error;
    }
    if (result.status !== 0) {
      return null;
    }
    return withoutFinalNewline(fs.readFileSync(file, "utf8"));
  } finally {
    // The whole folder goes, with any backup or swap file the editor left.
    safeDeleteDirectory(dir, false);
  }
}

function withoutFinalNewline(text: string): string {
  if (text.endsWith("\r\n")) return text.slice(0, -2);
  if (text.endsWith("\n")) return text.slice(0, -1);
  return text;
}
