// Editing a long field in the user's own editor. The form hands the
// terminal to `$EDITOR` on a temp file and takes it back when the editor
// exits. The hand-off has an order that must not change, so it lives in one
// function here and nowhere else.
import { spawnSync } from "node:child_process";
import * as fs from "fs";
import * as path from "path";

import { safeDeleteFile } from "@/utils.js";
import { makeAgencyTempDir } from "@/utils/agencyTempDir.js";

/** The two halves of the terminal the form owns. */
export type ReleasableTerminal = {
  input: { release: () => void; reclaim: () => void };
  output: { suspend: () => void; resume: () => void };
};

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

/** Run `fn` with the terminal handed back to the shell, then take it back.
 *  The output leaves the alternate screen and drops its cached grid, so the
 *  next render is a full redraw; the input stops reading stdin, so the
 *  child is the only reader of the terminal while it runs. */
export function withTerminalReleased<T>(terminal: ReleasableTerminal, fn: () => T): T {
  terminal.output.suspend();
  terminal.input.release();
  try {
    return fn();
  } finally {
    terminal.input.reclaim();
    terminal.output.resume();
  }
}

/** Open `text` in the editor and return what was saved, or null when the
 *  editor exited with a non-zero status. */
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
    return fs.readFileSync(file, "utf8");
  } finally {
    safeDeleteFile(file, false);
    fs.rmdirSync(dir);
  }
}
