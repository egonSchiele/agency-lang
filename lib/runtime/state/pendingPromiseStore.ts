import { isInterrupt, Interrupt } from "../interrupts.js";
import { InterruptBatchSignal } from "../errors.js";

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

  async awaitPending(keys: string[]): Promise<void> {
    const entries = keys
      .map((k) => ({ key: k, entry: this.pending[k] }))
      .filter((e) => e.entry !== undefined);

    if (entries.length === 0) return;

    const results = await Promise.all(entries.map((e) => e.entry!.promise));

    let hasInterrupts = false;
    for (let i = 0; i < entries.length; i++) {
      const { key, entry } = entries[i];
      const result = results[i];
      if (isInterrupt(result)) {
        // Keep interrupts in the pending store so awaitAll() can collect them.
        // Replace the promise with an already-resolved one holding the interrupt.
        this.pending[key] = { promise: Promise.resolve(result), resolve: entry!.resolve };
        hasInterrupts = true;
      } else {
        if (entry!.resolve) {
          entry!.resolve(result);
        }
        delete this.pending[key];
      }
    }
    if (hasInterrupts) {
      throw new InterruptBatchSignal();
    }
  }

  async awaitAll(): Promise<Interrupt[]> {
    const keys = Object.keys(this.pending);
    if (keys.length === 0) return [];

    const entries = keys.map((k) => ({ key: k, entry: this.pending[k] }));
    this.pending = {};

    const results = await Promise.all(entries.map((e) => e.entry.promise));

    const interrupts: Interrupt[] = [];
    for (let i = 0; i < entries.length; i++) {
      const { entry } = entries[i];
      const result = results[i];

      if (isInterrupt(result)) {
        interrupts.push(result);
      } else if (entry.resolve) {
        entry.resolve(result);
      }
    }
    return interrupts;
  }

  clear(): void {
    this.pending = {};
  }
}
