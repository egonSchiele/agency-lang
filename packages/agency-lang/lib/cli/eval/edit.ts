// `agency eval edit <test-dir>`: the `eval new` form over an existing test
// folder, loaded from `test.json` and `graders.json` and saved back in
// place. The folder is loaded before the terminal is touched, so a folder
// the form cannot edit is refused as a plain error.
import { loadTestForm } from "@/eval/newTest/load.js";

import { openRealTerminal, type FormTerminal } from "./formTerminal.js";
import { runForm } from "./new.js";

export type EvalEditOptions = {
  testDir: string;
  openTerminal: () => FormTerminal;
  print: (text: string) => void;
};

export async function evalEdit(options: EvalEditOptions): Promise<void> {
  const initial = loadTestForm(options.testDir);
  await runForm({ initial, openTerminal: options.openTerminal, print: options.print });
}

/** The command as the CLI runs it. */
export async function runEvalEdit(testDir: string): Promise<void> {
  await evalEdit({
    testDir,
    openTerminal: () => openRealTerminal("eval edit"),
    print: (text) => console.log(text),
  });
}
