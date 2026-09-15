const EVENTS = ["uncaughtException", "unhandledRejection"] as const;

type ProcessEvent = (typeof EVENTS)[number];
type Listener = (...args: any[]) => void;
export type ListenerSnapshot = Record<ProcessEvent, Listener[]>;

export function snapshotListeners(): ListenerSnapshot {
  return {
    uncaughtException: process.listeners("uncaughtException"),
    unhandledRejection: process.listeners("unhandledRejection"),
  };
}

/** Removes every uncaughtException and unhandledRejection listener that
 *  was not in `before`. */
export function removeListenersAddedSince(before: ListenerSnapshot): void {
  for (const event of EVENTS) {
    const added = (process.listeners(event) as Listener[]).filter(
      (listener) => !before[event].includes(listener),
    );
    added.forEach((listener) => process.removeListener(event, listener));
  }
}
