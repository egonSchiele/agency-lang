/**
 * The CLI's yes-or-no question: `remote deploy` asks it, and so does
 * `agency workflow run`. Each command keeps its own rule for when to ask
 * and what a no means.
 */
import * as readline from "node:readline/promises";

/** Asks `question` with ` [y/N] ` after it. Only `y` or `yes`, in any case,
 *  is a yes. `output` is where the question is written. A command whose
 *  standard output must hold only its result, such as
 *  `agency workflow run --json`, passes stderr. */
export async function confirmQuestion(
  question: string,
  output: NodeJS.WritableStream = process.stdout,
): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output });
  try {
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}
