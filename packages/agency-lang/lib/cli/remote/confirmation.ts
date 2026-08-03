// The "deploy an agent with no callable endpoints?" gate. Owns the TTY/readline
// mechanics; `runDeploy` only asks whether it should proceed. Per Revision 2 a
// dry-run and a non-TTY run bypass the prompt and proceed — only an interactive
// TTY asks.

import * as readline from "node:readline/promises";

export type ConfirmDeployOptions = {
  dryRun?: boolean;
  isTty?: boolean;
  prompt?: (question: string) => Promise<boolean>;
};

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
  const prompt = options.prompt ?? defaultPrompt;
  return prompt("Upload anyway?");
}

async function defaultPrompt(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}
