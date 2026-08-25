import * as os from "os";

/**
 * One process-wide supervisor for every live eval child, forked or spawned,
 * instead of listeners per child: under `-n 10`, or an optimizer scoring a
 * whole candidate at once, per-child listeners passed ten and Node's
 * MaxListenersExceededWarning printed into the status board.
 *
 * Signals are forwarded to every live child; the listeners exist only while
 * a child is live, so an idle process keeps default handling. The first
 * terminating signal is forwarded and the children get to settle (`eval run`
 * folds the interrupted test into the run directory). A second one is the
 * user asking to force quit: every child is killed with SIGKILL and the
 * process exits with the signal's conventional code, immediately. Exiting
 * that way instead of restoring default handling matters for spawned
 * command trees: they are detached, so nothing but this supervisor reaches
 * them, and a default signal death runs no `exit` hook to reap them.
 *
 * Any exit (normal, crash, uncaught throw) reaps live children with SIGKILL.
 * The one hole no supervisor can close is SIGKILL of this process; a
 * spawned tree's remaining protection is EPIPE on its next write to our
 * closed pipes, and forked children carry a disconnect watchdog.
 */

export type ChildKill = (signal: NodeJS.Signals) => void;

const TERMINATING = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/** The slice of `process` the supervisor uses; tests pass a stand-in. */
export type SupervisedProcess = {
  on(event: string, listener: (...args: any[]) => void): unknown;
  removeListener(event: string, listener: (...args: any[]) => void): unknown;
  exit(code: number): never;
};

export function makeChildSupervisor(proc: SupervisedProcess): (kill: ChildKill) => () => void {
  const live: ChildKill[] = [];
  let exitHookInstalled = false;
  let signalled = false;

  const onSignal = (signal: NodeJS.Signals) => {
    if (signalled) {
      for (const kill of live) kill("SIGKILL");
      proc.exit(128 + os.constants.signals[signal]);
      return;
    }
    signalled = true;
    for (const kill of live) kill(signal);
  };
  const listeners = Object.fromEntries(
    TERMINATING.map((signal) => [signal, () => onSignal(signal)]),
  );

  return (kill) => {
    if (live.length === 0) {
      signalled = false;
      for (const signal of TERMINATING) proc.on(signal, listeners[signal]);
    }
    if (!exitHookInstalled) {
      exitHookInstalled = true;
      proc.on("exit", () => {
        for (const k of live) k("SIGKILL");
      });
    }
    live.push(kill);
    return () => {
      const at = live.indexOf(kill);
      if (at === -1) return;
      live.splice(at, 1);
      if (live.length === 0) {
        for (const signal of TERMINATING) proc.removeListener(signal, listeners[signal]);
      }
    };
  };
}

/** Supervise a child until the returned function is called (on settle). */
export const supervise = makeChildSupervisor(process);
