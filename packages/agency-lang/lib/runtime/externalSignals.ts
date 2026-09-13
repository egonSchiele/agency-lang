import { AgencyCancelledError } from "./errors.js";

/** The slice of an execution context the caller's signals act on. */
export type SignalTarget = {
  pauseRequested: boolean;
  cancel: (reason?: string) => void;
};

/** The two handles a host may pass into a run. */
export type ExternalSignals = {
  abortSignal?: AbortSignal;
  pauseSignal?: AbortSignal;
};

type Detach = () => void;

const noop: Detach = () => {};

/** Wire a caller's cancel signal to an execution context. An already-aborted
 *  signal throws at once; a later abort cancels the context, which tears
 *  down in-flight LLM requests. Returns a detach function the entry calls
 *  when it returns, so a host controller that outlives the run holds no
 *  reference to the context. */
export function attachAbortSignal(target: SignalTarget, signal?: AbortSignal): Detach {
  if (!signal) {
    return noop;
  }
  if (signal.aborted) {
    throw new AgencyCancelledError();
  }
  const onAbort = () => target.cancel();
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

/** Wire a caller's pause signal to an execution context. Firing it only sets
 *  a flag; the runner stops at its next statement boundary. Returns a detach
 *  function, as attachAbortSignal does. */
export function attachPauseSignal(target: SignalTarget, signal?: AbortSignal): Detach {
  if (!signal) {
    return noop;
  }
  if (signal.aborted) {
    target.pauseRequested = true;
    return noop;
  }
  const onAbort = () => {
    target.pauseRequested = true;
  };
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

/** Run `body` with the caller's signals wired to `target`, and unwire them
 *  however the body ends. This is the only way an entry point attaches
 *  signals, so no entry can forget the detach. */
export async function withExternalSignals<T>(
  target: SignalTarget,
  signals: ExternalSignals,
  body: () => Promise<T>,
): Promise<T> {
  const detachAbort = attachAbortSignal(target, signals.abortSignal);
  const detachPause = attachPauseSignal(target, signals.pauseSignal);
  try {
    return await body();
  } finally {
    detachAbort();
    detachPause();
  }
}
