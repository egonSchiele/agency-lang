import { hasInterrupts, isInterrupt } from "../interrupts.js";
import { ConcurrentInterruptError } from "../errors.js";

type PendingPromiseEntry = {
  promise: Promise<any>;
  resolve?: (value: any) => void;
};

export class PendingPromiseStore {
  private pending: Record<string, PendingPromiseEntry> = {};
  private counter: number = 0;

  add(promise: Promise<any>, resolve?: (value: any) => void): string {
    const key = `__pending_${this.counter++}`;
    this.pending[key] = { promise, resolve };
    return key;
  }

  async awaitPending(
    keys: string[],
    opts?: { rejectInterrupts?: boolean },
  ): Promise<void> {
    const entries = keys
      .map((k) => ({ key: k, entry: this.pending[k] }))
      .filter((e) => e.entry !== undefined);

    if (entries.length === 0) return;

    const results = await Promise.all(entries.map((e) => e.entry!.promise));

    for (let i = 0; i < entries.length; i++) {
      const { key, entry } = entries[i];
      // Same guard awaitAll applies: a result that IS an interrupt
      // means an async function paused while we were awaiting it, which
      // this code path cannot transport. The handler-exit await opts in
      // so an in-handler straggler cannot be silently consumed here.
      if (
        opts?.rejectInterrupts &&
        (hasInterrupts(results[i]) || isInterrupt(results[i]))
      ) {
        throw new ConcurrentInterruptError(
          "An async function launched inside a handler returned an interrupt. " +
            "Handlers cannot pause, so this interrupt cannot be delivered. " +
            "Await the async call inside the handler body, or move it outside the handler.",
        );
      }
      if (entry!.resolve) {
        entry!.resolve(results[i]);
      }
      delete this.pending[key];
    }
  }

  async awaitAll(): Promise<void> {
    const keys = Object.keys(this.pending);
    if (keys.length === 0) return;

    const entries = keys.map((k) => ({ key: k, entry: this.pending[k] }));
    this.pending = {};

    const results = await Promise.all(entries.map((e) => e.entry.promise));

    for (let i = 0; i < entries.length; i++) {
      const { entry } = entries[i];
      const result = results[i];

      // Catch both shapes: a single Interrupt object (legacy) and an
      // Interrupt[] (current model). Either form here means an async
      // function paused via interrupt while we were awaiting it, which
      // isn't supported on this code path.
      if (hasInterrupts(result) || isInterrupt(result)) {
        throw new ConcurrentInterruptError(
          "An async function returned an interrupt while awaiting pending promises. " +
          "Async interrupts from pending promises are not yet supported. " +
          "Assign the async call to a variable if it may trigger an interrupt.",
        );
      }

      if (entry.resolve) {
        entry.resolve(result);
      }
    }
  }

  clear(): void {
    this.pending = {};
  }

  /** Position marker for keysSince. Handler dispatch records this
   *  before running a handler body so handler exit can await exactly
   *  the promises the handler launched — awaiting the full set would
   *  deadlock on the async call whose raise is being dispatched. */
  watermark(): number {
    return this.counter;
  }

  /** Still-pending keys registered at or after the given watermark. */
  keysSince(mark: number): string[] {
    return Object.keys(this.pending).filter(
      (k) => Number(k.slice("__pending_".length)) >= mark,
    );
  }
}
