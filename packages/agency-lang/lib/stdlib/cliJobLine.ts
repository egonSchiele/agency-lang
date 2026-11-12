// The line the REPL prints when a background job ends, and how it prints
// it without breaking whatever owns the terminal. See docs/dev/stdlib/jobs.md.
import * as readline from "readline";
import { describeJobState, type JobSummary } from "../runtime/jobs/jobTable.js";
import { formatElapsed } from "../utils/formatElapsed.js";
import { RESET, styles } from "../utils/termcolors.js";

/** "job-3fa9c1 finished after 41m 8s (exit 0): ./run-comparison.sh" */
export function jobEndedLine(job: JobSummary): string {
  const ranFor = formatElapsed((job.endedAt ?? job.startedAt) - job.startedAt);
  return `${job.id} finished after ${ranFor} (${describeJobState(job)}): ${job.command}`;
}

/** What owns the terminal: the plain prompt waiting for a line, a turn,
 *  or something else, such as the slash menu, `/paste`, or `$EDITOR`. */
export type TerminalOwner = "prompt" | "turn" | "other";

/** The part of the readline interface the prompt redraw uses. */
export type PromptLine = Pick<readline.Interface, "getCursorPos" | "prompt">;

export type JobEndLines = {
  /** Say who owns the terminal now. Call it with "prompt" before the
   *  prompt is drawn. Moving to the prompt or a turn prints the lines held
   *  while something else owned the terminal. */
  setOwner(owner: TerminalOwner): void;
  /** The job table's end listener. */
  jobEnded(job: JobSummary): void;
};

export function jobEndLines(
  rl: PromptLine,
  out: NodeJS.WritableStream,
  terminal: { useTTY: boolean; useColor: boolean },
): JobEndLines {
  let owner: TerminalOwner = "other";
  let held: string[] = [];
  const styled = (line: string) => (terminal.useColor ? `${styles.dim}${line}${RESET}` : line);
  return {
    setOwner(next) {
      owner = next;
      if (next === "other") {
        return;
      }
      for (const line of held) {
        out.write(`${styled(line)}\n`);
      }
      held = [];
    },
    jobEnded(job) {
      const line = jobEndedLine(job);
      if (!terminal.useTTY || owner === "turn") {
        out.write(`${styled(line)}\n`);
      } else if (owner === "other") {
        held.push(line);
      } else {
        writeAbovePrompt(rl, out, styled(line));
      }
    },
  };
}

/** Clear the prompt, write the line, and draw the prompt again below it
 *  with what was typed. */
function writeAbovePrompt(rl: PromptLine, out: NodeJS.WritableStream, text: string): void {
  // Typed text can wrap, so clear from the prompt's first row, not only
  // the cursor's row.
  const { rows } = rl.getCursorPos();
  readline.moveCursor(out, 0, -rows);
  readline.cursorTo(out, 0);
  readline.clearScreenDown(out);
  // Readline's redraw starts by moving up as many rows as the cursor was
  // below the prompt's first row. The blank rows written here are what it
  // moves back over, so it does not land on the line and clear it.
  out.write(`${text}\n${"\n".repeat(rows)}`);
  rl.prompt(true);
}
