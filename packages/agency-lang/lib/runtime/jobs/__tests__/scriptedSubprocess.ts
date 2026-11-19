// A subprocess part for the job tests: each started child prints and ends
// when the test says, and the process table is a pair of records the test
// can read and change.
import type {
  Command,
  DetachedOptions,
  HostSubprocess,
  RunOptions,
  RunResult,
} from "../../../host/host.js";

/** The start time `processStartedAt` reports for a pid the test did not
 *  set one for. */
export const SCRIPTED_START_TIME = 1_000_000;
const FIRST_PID = 100;

export type ScriptedChild = {
  pid: number;
  command: Command;
  options: RunOptions;
  /** What the child has printed so far. The test appends to these. */
  stdout: string;
  stderr: string;
  /** Ends the child. Fields left out are an exit with code 0. */
  finish(result?: Partial<RunResult>): void;
  /** Makes `wait()` reject, as a spawn that failed after it started does. */
  fail(error: Error): void;
};

export type ScriptedSubprocess = {
  subprocess: HostSubprocess;
  children: ScriptedChild[];
  detached: { command: Command; options: DetachedOptions | undefined; pid: number }[];
  /** Pids `processState` reads as something other than alive. */
  states: Record<number, "alive" | "gone" | "unknown">;
  /** Start times by pid, null for one `ps` cannot read. */
  startTimes: Record<number, number | null>;
  /** The pids `stopGroup` was called with. */
  stopped: number[];
  /** When set, `start` throws it. */
  startError: Error | null;
  /** Runs before `startDetached` answers, as the runner does once started. */
  onDetached: (pid: number) => Promise<void>;
  /** Runs before `processState` answers, so a test can change the world
   *  between a read of the record and the check. */
  beforeProcessState: (pid: number) => Promise<void> | void;
};

export function scriptedSubprocess(): ScriptedSubprocess {
  let nextPid = FIRST_PID;
  const scripted: ScriptedSubprocess = {
    children: [],
    detached: [],
    states: {},
    startTimes: {},
    stopped: [],
    startError: null,
    onDetached: async () => {},
    beforeProcessState: () => {},
    subprocess: {
      run: async () => {
        throw new Error("The scripted subprocess only starts commands.");
      },
      locate: async () => null,
      start: async (command, options = {}) => {
        if (scripted.startError !== null) {
          throw scripted.startError;
        }
        return startChild(command, options);
      },
      startDetached: async (command, options) => {
        const pid = nextPid++;
        scripted.detached.push({ command, options, pid });
        await scripted.onDetached(pid);
        return { pid };
      },
      processState: (pid) => {
        void scripted.beforeProcessState(pid);
        return scripted.states[pid] ?? "alive";
      },
      processStartedAt: (pid) => {
        if (scripted.states[pid] === "gone") {
          return null;
        }
        return pid in scripted.startTimes ? scripted.startTimes[pid] : SCRIPTED_START_TIME;
      },
      stopGroup: async (pid) => {
        scripted.stopped.push(pid);
        scripted.states[pid] = "gone";
      },
    },
  };

  function startChild(command: Command, options: RunOptions) {
    let settle: (result: RunResult) => void = () => {};
    let reject: (error: Error) => void = () => {};
    const ended = new Promise<RunResult>((resolve, rejectWith) => {
      settle = resolve;
      reject = rejectWith;
    });
    ended.catch(() => undefined);
    const child: ScriptedChild = {
      pid: nextPid++,
      command,
      options,
      stdout: "",
      stderr: "",
      finish: (result = {}) => {
        scripted.states[child.pid] = "gone";
        settle({
          exitCode: 0,
          signal: null,
          stdout: child.stdout,
          stderr: child.stderr,
          truncated: null,
          timedOut: false,
          aborted: false,
          ...result,
        });
      },
      fail: (error) => {
        scripted.states[child.pid] = "gone";
        reject(error);
      },
    };
    options.signal?.addEventListener(
      "abort",
      () => child.finish({ exitCode: null, signal: "SIGTERM", aborted: true }),
      { once: true },
    );
    scripted.children.push(child);
    return {
      pid: child.pid,
      kill: () => child.finish({ exitCode: null, signal: "SIGTERM" }),
      wait: () => ended,
      output: () => ({ stdout: child.stdout, stderr: child.stderr }),
    };
  }

  return scripted;
}

/** Lets every pending promise run. The memory host's files are promises
 *  with no real waiting, so this settles all of them. */
export async function settle(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}
