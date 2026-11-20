// The line the REPL prints when a background job ends, how it prints it
// without breaking whatever owns the terminal, and which jobs it watches.
// See docs/dev/stdlib/jobs.md.
import * as readline from "readline";
import type { HeldJob } from "../runtime/jobs/heldJobs.js";
import { describeJobState, type JobRecord } from "../runtime/jobs/jobRecord.js";
import { processSlot } from "../runtime/processSlot.js";
import { formatElapsed } from "../utils/formatElapsed.js";
import { RESET, styles } from "../utils/termcolors.js";

/** Where the REPL's job watch reads the jobs to watch, for a REPL whose
 *  turns run in another run: the agent's terminal sets it to the session
 *  run's jobs. Kept for the process, outside Agency code, because each job
 *  carries its token and the watch reads the list synchronously. Null
 *  reads the REPL's own run. */
const replJobsSource = processSlot<(() => HeldJob[]) | null>("agency.replJobsSource", () => null);

/** Makes the REPL watch the jobs `source` returns, read on every poll, in
 *  place of the jobs its own run holds. Null goes back to its own run's. */
export function setReplJobsSource(source: (() => HeldJob[]) | null): void {
  replJobsSource.set(source);
}

/** The jobs the REPL's watch reads now: the source's, or `ownJobs` when
 *  none is set. A source that throws gives none this poll: it must not
 *  stop the watch. */
export function watchedJobs(ownJobs: HeldJob[]): HeldJob[] {
  const source = replJobsSource.get();
  if (source === null) {
    return ownJobs;
  }
  try {
    return source();
  } catch {
    return [];
  }
}

/** "job-3fa9c1 finished after 41m 8s (exit 0): ./run-comparison.sh" */
export function jobEndedLine(job: JobRecord): string {
  const ranFor = formatElapsed((job.endedAt ?? job.startedAt) - job.startedAt);
  return `${job.id} finished after ${ranFor} (${describeJobState(job)}): ${job.label}`;
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
  /** The listener `watchHeldJobs` calls when a held job ends. */
  jobEnded(job: JobRecord): void;
  /** Run a question asked through readline, such as a nested `input()`.
   *  The question is a prompt while it waits for its answer, and the
   *  terminal goes back to its owner after. */
  whileAsking<T>(ask: () => Promise<T>): Promise<T>;
};

export function jobEndLines(
  rl: PromptLine,
  out: NodeJS.WritableStream,
  terminal: { useTTY: boolean; useColor: boolean },
): JobEndLines {
  let owner: TerminalOwner = "other";
  let held: string[] = [];
  const styled = (line: string) => (terminal.useColor ? `${styles.dim}${line}${RESET}` : line);
  const setOwner = (next: TerminalOwner): void => {
    owner = next;
    if (next === "other") {
      return;
    }
    for (const line of held) {
      out.write(`${styled(line)}\n`);
    }
    held = [];
  };
  return {
    setOwner,
    async whileAsking(ask) {
      const before = owner;
      setOwner("prompt");
      try {
        return await ask();
      } finally {
        owner = before;
      }
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
