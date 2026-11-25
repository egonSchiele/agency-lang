import { mustExec, quote } from "./shell.js";
import type { Sandbox } from "./types.js";

const WORK_DIR = "/var/eval-daytona";
export const ENV_FILE = `${WORK_DIR}/env.sh`;
export const EXIT_FILE = `${WORK_DIR}/exit`;
export const PID_FILE = `${WORK_DIR}/pid`;
export const CONSOLE_LOG = `${WORK_DIR}/console.log`;

/** How long past `maxSeconds` to wait for the exit file before giving up. */
const GRACE_SECONDS = 300;
const MAX_FAILED_POLLS = 5;
/** What `timeout` itself exits with; used when the exit file never appears. */
const TIMED_OUT = 124;
const DEFAULT_POLL_SECONDS = 15;
const DEFAULT_INTERRUPT_GRACE_SECONDS = 60;
const MS_PER_SECOND = 1000;
const POLL_TIMEOUT_SEC = 60;

export type LongCommandArgs = {
  /** The command line, one entry per argument. */
  argv: string[];
  cwd: string;
  /** API keys and anything else the command needs. */
  env: Record<string, string>;
  /** `timeout` kills the command after this long. */
  maxSeconds: number;
  /** What the command printed since the last poll. */
  onOutput?: (chunk: string) => void;
  /** When aborted, the command is sent SIGINT, once. */
  signal?: AbortSignal;
  /** How long to go on waiting for the command after that. Default 60. */
  interruptGraceSeconds?: number;
  /** Default 15. */
  pollSeconds?: number;
  /** For tests. */
  sleep?: (ms: number) => Promise<void>;
  /** For tests. Default Date.now. */
  now?: () => number;
};

export type LongCommandResult = {
  exitCode: number;
  seconds: number;
  /** The exit file never appeared: the session died or the sandbox stopped. */
  timedOut: boolean;
  interrupted: boolean;
};

/** Sleeps, but wakes at once when the signal aborts, or is already
 *  aborted, so an interrupt is not held up by a poll interval. */
function sleepUntilAbort(signal: AbortSignal | undefined): (ms: number) => Promise<void> {
  return (ms) =>
    new Promise<void>((resolve) => {
      if (signal?.aborted === true) {
        resolve();
        return;
      }
      const wake = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", wake);
        resolve();
      };
      const timer = setTimeout(wake, ms);
      signal?.addEventListener("abort", wake, { once: true });
    });
}

/** The line started in the background. `timeout` enforces the limit, and its
 *  pid is written to PID_FILE so an interrupt can be sent to it.
 *
 *  `--foreground` matters. With it, `timeout` passes a signal on to the
 *  command, once, and to nothing else. Without it, `timeout` signals the
 *  command and then its whole process group, so the command gets the signal
 *  twice. `agency eval run` reads a second signal as "quit now" and would
 *  drop the run it was about to save. The command's own children are its
 *  business: `agency eval run` supervises the ones it starts. */
function backgroundLine(args: LongCommandArgs): string {
  const command = args.argv.map(quote).join(" ");
  const limited =
    `echo $$ > ${PID_FILE}; ` +
    `exec timeout --foreground ${args.maxSeconds} ${command} </dev/null > ${CONSOLE_LOG} 2>&1`;
  return `. ${ENV_FILE} && cd ${quote(args.cwd)} && sh -c ${quote(limited)}; echo $? > ${EXIT_FILE}`;
}

/** Runs a command that may take hours, as root, and waits for it by
 *  polling: one request held open that long would not survive. A non-zero
 *  exit is a result, not a throw. */
export async function runLongCommand(
  sandbox: Sandbox,
  args: LongCommandArgs,
): Promise<LongCommandResult> {
  const pollMs = (args.pollSeconds ?? DEFAULT_POLL_SECONDS) * MS_PER_SECOND;
  const sleep = args.sleep ?? sleepUntilAbort(args.signal);
  const now = args.now ?? Date.now;
  const interruptGraceMs =
    (args.interruptGraceSeconds ?? DEFAULT_INTERRUPT_GRACE_SECONDS) * MS_PER_SECOND;

  await mustExec(
    sandbox,
    "command directory",
    `mkdir -p ${WORK_DIR} && chmod 700 ${WORK_DIR} && rm -f ${EXIT_FILE} ${PID_FILE}`,
  );
  // The keys go in a file only root can read, never in a command's text:
  // the provider keeps the commands of a session with its records.
  const exports = Object.entries(args.env)
    .map(([name, value]) => `export ${name}=${quote(value)}\n`)
    .join("");
  await sandbox.upload(Buffer.from(exports), ENV_FILE);
  await mustExec(sandbox, "command env", `chmod 600 ${ENV_FILE}`);
  await sandbox.startBackground(backgroundLine(args));

  const started = now();
  const deadline = started + (args.maxSeconds + GRACE_SECONDS) * MS_PER_SECOND;
  let interruptDeadline: number | null = null;
  let offset = 0;
  let failedPolls = 0;
  let exited = false;
  while (!exited) {
    await sleep(pollMs);
    try {
      if (args.signal?.aborted === true && interruptDeadline === null) {
        await sandbox.exec(`kill -INT "$(cat ${PID_FILE})"`, { timeoutSec: POLL_TIMEOUT_SEC });
        // Set only once the interrupt was sent: if sending failed, the next
        // poll tries again.
        interruptDeadline = now() + interruptGraceMs;
      }
      exited =
        (await sandbox.exec(`test -f ${EXIT_FILE}`, { timeoutSec: POLL_TIMEOUT_SEC })).exitCode === 0;
      offset += await forwardOutput(sandbox, offset, args.onOutput);
      failedPolls = 0;
    } catch (error) {
      // One bad answer from the provider must not throw away an hour of work.
      failedPolls += 1;
      if (failedPolls >= MAX_FAILED_POLLS) {
        throw error;
      }
    }
    if (!exited && (now() > deadline || (interruptDeadline !== null && now() > interruptDeadline))) {
      break;
    }
  }

  const exitText = exited ? (await sandbox.exec(`cat ${EXIT_FILE}`)).output.trim() : "";
  const exitCode = exitText === "" || Number.isNaN(Number(exitText)) ? TIMED_OUT : Number(exitText);
  return {
    exitCode,
    seconds: Math.round((now() - started) / MS_PER_SECOND),
    timedOut: !exited && interruptDeadline === null,
    // A command that had finished cleanly by the time the interrupt arrived
    // was not cut short by it.
    interrupted: interruptDeadline !== null && !(exited && exitCode === 0),
  };
}

/** Passes on what the command printed since `offset` bytes into its log.
 *  Returns how many bytes that was. */
async function forwardOutput(
  sandbox: Sandbox,
  offset: number,
  onOutput: ((chunk: string) => void) | undefined,
): Promise<number> {
  const result = await sandbox.exec(`tail -c +${offset + 1} ${CONSOLE_LOG} 2>/dev/null`, {
    timeoutSec: POLL_TIMEOUT_SEC,
  });
  if (result.output !== "") {
    onOutput?.(result.output);
  }
  return Buffer.byteLength(result.output);
}
