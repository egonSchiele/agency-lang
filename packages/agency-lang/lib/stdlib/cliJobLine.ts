// The line the REPL prints when a background job ends, and how it prints
// it without breaking the prompt. See docs/dev/stdlib/jobs.md.
import * as readline from "readline";
import process from "process";
import { describeJobState, type JobSummary } from "../runtime/jobs/jobTable.js";
import { formatElapsed } from "../utils/formatElapsed.js";
import { RESET, styles } from "../utils/termcolors.js";

/** "job-1 finished after 41m 8s (exit 0): ./run-comparison.sh" */
export function jobEndedLine(job: JobSummary): string {
  const ranFor = formatElapsed((job.endedAt ?? job.startedAt) - job.startedAt);
  return `${job.id} finished after ${ranFor} (${describeJobState(job)}): ${job.command}`;
}

/** What the REPL is doing when a job ends, which decides how the line is
 *  printed. */
export type ReplMoment = { turnRunning: boolean; useTTY: boolean; useColor: boolean };

/** Print a job's finish line. During a turn the spinner's footer redraws
 *  below any write. At an idle prompt the line goes above the prompt,
 *  which is drawn again with what was typed. */
export function printJobEnded(rl: readline.Interface, line: string, at: ReplMoment): void {
  const shown = at.useColor ? `${styles.dim}${line}${RESET}` : line;
  if (!at.useTTY || at.turnRunning) {
    process.stdout.write(`${shown}\n`);
    return;
  }
  readline.clearLine(process.stdout, 0);
  readline.cursorTo(process.stdout, 0);
  process.stdout.write(`${shown}\n`);
  rl.prompt(true);
}
