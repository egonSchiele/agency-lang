/**
 * Naming the terminal tab a command is running in, and driving that tab's
 * progress indicator.
 *
 * Without this, iTerm2 (and friends) name the tab after the foreground job, so
 * every Agency command shows up as "node". While a long command runs, the tab
 * gets a spinner instead of the "unread output" dot, and a failed command
 * leaves the indicator red.
 *
 * Two escape-sequence families do the work, and this file is the only place
 * that knows them. See docs/dev/terminal-status.md.
 */
import { AGENCY_NO_TERM_STATUS, AGENCY_TERM_STATUS_OWNED } from "@/constants.js";
import type { Command } from "@/vendor/commander/index.js";
import * as path from "path";

/** Push the current tab title onto the terminal's title stack (XTerm CSI 22 t). */
const PUSH_TITLE = "\x1b[22;0t";

/** Pop it back off (CSI 23 t), undoing our rename when the command exits. */
const POP_TITLE = "\x1b[23;0t";

/** OSC 1 sets the icon/tab title; OSC 2 would set the window title instead. */
const setTitleSequence = (text: string): string => `\x1b]1;${text}\x07`;

/**
 * ConEmu-style progress states, which iTerm2 draws in the tab's indicator slot:
 * 0 clears it, 2 is an error, 3 is "working, no percentage known".
 */
const progressSequence = (state: 0 | 2 | 3): string => `\x1b]9;4;${state};0\x1b\\`;

/** Tab titles are shown in a few dozen columns; anything longer is wasted bytes. */
const MAX_TITLE_LENGTH = 80;

export type TerminalStatus = {
  /** Name the tab and start the spinner. Does nothing when we should stay quiet. */
  begin: (title: string) => void;
  /** Stop the spinner — red when `ok` is false — and restore the tab's old name. */
  end: (ok: boolean) => void;
  /** Stop the spinner but keep the name, for full-screen views that take over the terminal. */
  stopProgress: () => void;
};

export type TerminalStatusDeps = {
  write: (text: string) => void;
  env: NodeJS.ProcessEnv;
  isTty: () => boolean;
};

/**
 * A title can carry a filename, so strip anything that would be read as an
 * escape sequence rather than as text. Control characters go, including the
 * BEL that terminates the sequence and the C1 introducer.
 */
export function sanitizeTitle(text: string): string {
  const printable = text.replace(/[\x00-\x1f\x7f-\x9f]/g, "").trim();
  return printable.length > MAX_TITLE_LENGTH ? printable.slice(0, MAX_TITLE_LENGTH) : printable;
}

/**
 * Whether to touch the terminal at all. `NO_COLOR` is honoured because someone
 * who wants a plain-bytes terminal wants this off too, and a claimed tab means
 * an outer `agency` process already owns it.
 *
 * Deliberately not `autoUseColor()`: that one lets `FORCE_COLOR` override a
 * non-TTY, which is right for color in a captured log and wrong here — there is
 * no tab to name at the other end of a pipe.
 */
function isEligible(deps: TerminalStatusDeps): boolean {
  const off = (name: string): boolean => {
    const value = deps.env[name];
    return value !== undefined && value !== "";
  };
  if (off("NO_COLOR") || off(AGENCY_NO_TERM_STATUS) || off(AGENCY_TERM_STATUS_OWNED)) return false;
  return deps.isTty();
}

export function createTerminalStatus(deps: TerminalStatusDeps): TerminalStatus {
  // Only a `begin` that actually wrote may write again: `end` after a skipped
  // `begin` would pop a title nobody pushed.
  let claimed = false;

  return {
    begin(title: string): void {
      if (claimed || !isEligible(deps)) return;
      const text = sanitizeTitle(title);
      if (text === "") return;
      claimed = true;
      // Children inherit this and stay quiet, so one tab has one owner.
      deps.env[AGENCY_TERM_STATUS_OWNED] = "1";
      deps.write(PUSH_TITLE + setTitleSequence(text) + progressSequence(3));
    },
    end(ok: boolean): void {
      if (!claimed) return;
      claimed = false;
      deps.write(progressSequence(ok ? 0 : 2) + POP_TITLE);
    },
    stopProgress(): void {
      if (!claimed) return;
      deps.write(progressSequence(0));
    },
  };
}

/**
 * The process-wide instance the CLI wires up. Writes are synchronous to a TTY,
 * which is what lets `end` run from an `exit` handler.
 */
export const terminalStatus: TerminalStatus = createTerminalStatus({
  write: (text) => process.stdout.write(text),
  env: process.env,
  isTty: () => process.stdout.isTTY === true,
});

/**
 * What to call the tab: the command as typed, plus its first operand. So
 * `agency eval run fib` and `agency run investment.agency`, which is enough to
 * tell two tabs apart. A path operand shows as its basename, since a tab has
 * room for a filename but not for a directory tree.
 */
export function commandTitle(command: Command): string {
  const names: string[] = [];
  for (let node: Command | null = command; node !== null; node = node.parent) {
    names.unshift(node.name());
  }
  const operand = command.args[0];
  if (operand !== undefined && operand !== "" && !operand.startsWith("-")) {
    names.push(operand.includes(path.sep) ? path.basename(operand) : operand);
  }
  return names.join(" ");
}

/**
 * Wire the tab status to a CLI program: every command names the tab while it
 * runs, and gives the name back on the way out.
 *
 * The signal handlers deliberately do not exit. Other parts of the CLI (the
 * eval runner, the logs viewer) install their own SIGINT handling for graceful
 * shutdown, and exiting here would preempt them. Instead we clean up, step out
 * of the way, and re-raise only when nobody else was listening — which is what
 * keeps Ctrl-C working when we are the only handler.
 */
export function installTerminalStatus(program: Command, status: TerminalStatus): void {
  program.hook("preAction", (_program, actionCommand) => {
    status.begin(commandTitle(actionCommand));
  });

  process.on("exit", (code) => status.end(code === 0));

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const handler = (): void => {
      status.end(false);
      process.removeListener(signal, handler);
      if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
    };
    process.on(signal, handler);
  }
}
