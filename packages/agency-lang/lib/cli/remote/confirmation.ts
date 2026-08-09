// The remote commands' concrete terminal-prompt adapters: the raw yes/no
// readline lifecycle, the hidden secret-value prompt, and the deploy-specific
// "no callable endpoints?" gate built on top. This module owns terminal
// mechanics only — each command keeps its own policy (when to ask, what a
// decline means).

import * as readline from "node:readline/promises";
import prompts from "prompts";
import { terminalSafe } from "./secretsInput.js";

export type ConfirmDeployOptions = {
  dryRun?: boolean;
  isTty?: boolean;
  prompt?: (question: string) => Promise<boolean>;
};

/** The deploy policy: a dry-run and a non-TTY run bypass the prompt and
 *  proceed — only an interactive TTY asks. */
export async function confirmDeployWithoutExports(
  options: ConfirmDeployOptions = {},
): Promise<boolean> {
  if (options.dryRun) {
    return true;
  }
  const isTty = options.isTty ?? process.stdin.isTTY === true;
  if (!isTty) {
    return true;
  }
  const prompt = options.prompt ?? confirmQuestion;
  return prompt("Upload anyway?");
}

/** The raw readline yes/no lifecycle, policy-free. */
export async function confirmQuestion(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

/** Hidden-input prompt for a secret value. Resolves undefined on cancellation
 *  (ctrl-C / EOF) — `prompts` omits the answer key then — and preserves an
 *  empty entry as "" so the caller can distinguish "typed nothing" from
 *  "canceled". The name is untrusted display text and rendered terminal-safe. */
export async function promptSecretValue(name: string): Promise<string | undefined> {
  const response = await prompts({
    type: "invisible",
    name: "value",
    message: `Enter value for ${terminalSafe(name)}:`,
  });
  return typeof response.value === "string" ? response.value : undefined;
}
