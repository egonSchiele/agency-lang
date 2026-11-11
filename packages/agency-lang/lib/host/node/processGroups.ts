// Signals for a child and everything it started, and the list of children
// still running. Node-only. See "Stopping a command" in
// docs/dev/runtime/host.md.

import { spawn, type ChildProcess } from "child_process";

const IS_WINDOWS = process.platform === "win32";

/** Whether a child is started as the leader of its own process group, so
 *  one signal reaches it and what it started. Windows has no groups;
 *  `taskkill /T` walks the tree there. */
export const OWN_GROUP = !IS_WINDOWS;

/** How long a stopped child has to end after SIGTERM before SIGKILL. */
export const TERM_GRACE_MS = 2000;

/** How long a stopped child's output pipes are read after it exits. */
export const PIPE_GRACE_MS = 500;

type GroupSignal = "SIGTERM" | "SIGKILL" | "SIGSTOP";

/** Send `signal` to the child's whole group, or to its tree on Windows. */
export function signalGroup(child: ChildProcess, signal: GroupSignal): void {
  const pid = child.pid;
  if (pid === undefined) {
    return;
  }
  if (IS_WINDOWS) {
    const taskkill = spawn("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" });
    taskkill.on("error", () => child.kill());
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch (err) {
    // ESRCH: every process in the group has ended.
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") {
      child.kill(signal === "SIGSTOP" ? "SIGKILL" : signal);
    }
  }
}

/** Kill the group with a signal no process can catch. The stop comes
 *  first so a shell cannot start its next command while the kill is
 *  being delivered to the group one process at a time. */
export function killGroup(child: ChildProcess): void {
  if (!IS_WINDOWS) {
    signalGroup(child, "SIGSTOP");
  }
  signalGroup(child, "SIGKILL");
}

const EXIT_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/** The children started and not yet closed. One list for the process and
 *  not one per run, because its reader is the process's exit. */
const running: ChildProcess[] = [];
let exitHooked = false;

/** Kill the group of every child still running. */
export function killTrackedChildren(): void {
  for (const child of running) {
    killGroup(child);
  }
}

/** A child in its own group is outside the terminal's foreground group,
 *  so Ctrl+C no longer reaches it. When nothing else handles the signal,
 *  kill the children and end the way the signal would have. When
 *  something else does, it decides, and the exit hook is the backstop. */
function onExitSignal(signal: NodeJS.Signals): void {
  if (process.listenerCount(signal) > 1) {
    return;
  }
  killTrackedChildren();
  process.removeListener(signal, onExitSignal);
  process.kill(process.pid, signal);
}

/** Record a started child, so the process's end kills its group. */
export function trackChild(child: ChildProcess): void {
  if (!exitHooked) {
    process.on("exit", killTrackedChildren);
    exitHooked = true;
  }
  if (running.length === 0) {
    for (const signal of EXIT_SIGNALS) {
      process.on(signal, onExitSignal);
    }
  }
  running.push(child);
}

/** Forget a child that has closed. */
export function untrackChild(child: ChildProcess): void {
  const index = running.indexOf(child);
  if (index === -1) {
    return;
  }
  running.splice(index, 1);
  if (running.length === 0) {
    for (const signal of EXIT_SIGNALS) {
      process.removeListener(signal, onExitSignal);
    }
  }
}
