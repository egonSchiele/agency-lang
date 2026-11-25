import * as os from "os";

const TERMINATING = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
/** A repeat this soon after the first is the same signal delivered twice (a
 *  wrapper such as `tsx` resends one its child was slow to acknowledge),
 *  not a person asking again. */
const DUPLICATE_WINDOW_MS = 1000;

/** The slice of `process` this needs; tests pass a stand-in. */
export type SignalProcess = {
  on(event: string, listener: () => void): unknown;
  removeListener(event: string, listener: () => void): unknown;
  exit(code: number): never;
};

/** The command's answer to Ctrl-C. The first terminating signal calls
 *  `onFirst`: stop starting jobs, and let the running ones save what they
 *  have. A second one calls `onSecond` (delete every container) and then
 *  exits with the signal's usual code. A third exits at once. Returns a
 *  function that removes the handlers. */
export function onSignals(
  handlers: { onFirst(): void; onSecond(): Promise<void> },
  deps: { process?: SignalProcess; now?: () => number } = {},
): () => void {
  const proc = deps.process ?? (process as unknown as SignalProcess);
  const now = deps.now ?? Date.now;
  let firstAt: number | null = null;
  let quitting = false;
  const handle = (signal: (typeof TERMINATING)[number]): void => {
    if (firstAt === null) {
      firstAt = now();
      handlers.onFirst();
      return;
    }
    if (now() - firstAt < DUPLICATE_WINDOW_MS) {
      return;
    }
    const exit = (): never => proc.exit(128 + os.constants.signals[signal]);
    // A third: the deletes can wait minutes on a container still being
    // created, and the person has now asked three times.
    if (quitting) {
      exit();
      return;
    }
    quitting = true;
    firstAt = now();
    handlers.onSecond().then(exit, exit);
  };
  const listeners = TERMINATING.map((signal) => ({ signal, listener: () => handle(signal) }));
  for (const { signal, listener } of listeners) {
    proc.on(signal, listener);
  }
  return () => {
    for (const { signal, listener } of listeners) {
      proc.removeListener(signal, listener);
    }
  };
}
