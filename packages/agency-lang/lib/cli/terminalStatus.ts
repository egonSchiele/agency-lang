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
 * that knows them. See docs/dev/cli/terminal-status.md.
 */
import { AGENCY_NO_TERM_STATUS, AGENCY_TERM_STATUS_OWNED } from "@/constants.js";
import type { Command } from "@/vendor/commander/index.js";
import * as fs from "fs";
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
      delete deps.env[AGENCY_TERM_STATUS_OWNED];
      deps.write(progressSequence(ok ? 0 : 2) + POP_TITLE);
    },
  };
}

/**
 * Write to stdout by descriptor, and never let that failure matter.
 *
 * `fs.writeSync` rather than `process.stdout.write` because `end` runs from an
 * `exit` handler and the bytes must land before the process is gone: Node's
 * stdout is synchronous to a TTY on POSIX but asynchronous to one on Windows,
 * where the write would simply be dropped.
 */
export function writeToTerminal(text: string): void {
  try {
    fs.writeSync(1, text);
  } catch {
    // Deliberately silent, and the one place here where an empty catch is the
    // point: the failure IS that the terminal is unreachable, so there is
    // nowhere to log it. A closed window or a dropped SSH session leaves fd 1
    // throwing EIO/EPIPE, and fs.writeSync throws where process.stdout.write
    // would have swallowed it. Unguarded, that throw escapes the `exit`
    // handler and ends a clean run with a stack trace and
    // a changed exit code, over a cosmetic tab title.
  }
}

/** The process-wide instance the CLI wires up. */
export const terminalStatus: TerminalStatus = createTerminalStatus({
  write: writeToTerminal,
  env: process.env,
  isTty: () => process.stdout.isTTY === true,
});

/**
 * A path, for the purpose of shortening it: it has a separator and no
 * whitespace. Both halves matter. `agency agent` forwards free-form arguments,
 * so its first operand is usually a prompt, and "fix lib/parsers/foo.ts" would
 * otherwise be shortened to "foo.ts" — the prompt cut at its last slash. Real
 * paths on the command line rarely contain spaces; prompts nearly always do.
 *
 * The character class covers both separators rather than `path.sep`, since a
 * forward-slash path works on Windows too, where `path.sep` is a backslash.
 * `path.basename` itself is already per-platform and needs no such help.
 */
function looksLikePath(operand: string): boolean {
  return /[/\\]/.test(operand) && !/\s/.test(operand);
}

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
    names.push(looksLikePath(operand) ? path.basename(operand) : operand);
  }
  return names.join(" ");
}

/**
 * Exit codes of the form 128 + signal number, the shell's convention for "ended
 * by a signal". Ctrl-C out of the log viewer or a `compile --watch` is a normal
 * way to stop, so it clears the indicator rather than turning it red.
 */
const INTERRUPTED_EXIT_CODES = [130, 143];

export function commandFailed(exitCode: number): boolean {
  return exitCode !== 0 && !INTERRUPTED_EXIT_CODES.includes(exitCode);
}

// Latched so repeated installs in one process do not stack up `exit` listeners:
// `runCli` is called several times over in scripts/agency.test.ts.
let processListenerInstalled = false;

/**
 * Wire the tab status to a CLI program: every command names the tab while it
 * runs, and gives the name back on the way out.
 *
 * Cleanup hangs off `exit` alone, with no `SIGINT` handler of its own. That is
 * deliberate. Registering any JS signal listener takes SIGINT off its default
 * disposition, where the kernel ends the process at once, and defers it to the
 * event loop — so `agency compile` on a big file, which is synchronous and is
 * the case where Ctrl-C responsiveness matters most, would stop dying on the
 * first Ctrl-C.
 *
 * What that costs: a hard Ctrl-C on a command with no signal handler of its own
 * kills the process before any cleanup runs. The spinner clears itself the next
 * time an Agency command runs in that tab. The title does not — `begin` pushed
 * onto the terminal's title stack and only `end` pops — so the tab keeps the
 * dead command's name at the shell prompt, and each interrupted command leaves
 * one more unbalanced entry on that stack (terminals cap its depth, so this
 * accumulates to a limit rather than without bound). The pair stays anyway:
 * dropping it would make every command leave its name behind, trading a rare
 * stranded title for a permanent one.
 *
 * Leaving signals alone also keeps us from mistaking one for a verdict. The
 * eval runner treats the first Ctrl-C as non-fatal and keeps working for
 * minutes afterwards; a signal handler here would have reported that run failed
 * while it was still going.
 */
export function installTerminalStatus(program: Command, status: TerminalStatus): void {
  program.hook("preAction", (_program, actionCommand) => {
    status.begin(commandTitle(actionCommand));
  });

  if (processListenerInstalled) return;
  processListenerInstalled = true;
  process.on("exit", (code) => status.end(!commandFailed(code)));
}
