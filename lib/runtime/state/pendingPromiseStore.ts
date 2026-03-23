import { isInterrupt, Interrupt } from "../interrupts.js";

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

  // Returns the counter value at the current moment. Used to create a scope
  // marker so that awaitScope can await only promises added after this point.
  scopeMarker(): number {
    return this.counter;
  }

  // Await all promises added since the given scope marker.
  // Returns true if any resolved to an interrupt.
  async awaitScope(marker: number): Promise<boolean> {
    const keys = Object.keys(this.pending).filter((k) => {
      const num = parseInt(k.replace("__pending_", ""), 10);
      return num >= marker;
    });
    return this.awaitPending(keys);
  }

  // Await specific promises by key. Resolves them and calls their setters.
  // Interrupt results are left in the store for awaitAll() to collect later.
  // Returns true if any resolved to an interrupt.
  async awaitPending(keys: string[]): Promise<boolean> {
    const entries = keys
      .map((k) => ({ key: k, entry: this.pending[k] }))
      .filter((e) => e.entry !== undefined);

    if (entries.length === 0) return false;

    const results = await Promise.all(entries.map((e) => e.entry!.promise));

    let hasInterrupts = false;
    for (let i = 0; i < entries.length; i++) {
      const { key, entry } = entries[i];
      const result = results[i];

      if (isInterrupt(result)) {
        if (entry!.resolve) {
          entry!.resolve(result);
        }
        // Replace with an already-resolved promise so awaitAll can collect it.
        this.pending[key] = { promise: Promise.resolve(result) };
        hasInterrupts = true;
      } else {
        if (entry!.resolve) {
          entry!.resolve(result);
        }
        delete this.pending[key];
      }
    }
    return hasInterrupts;
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
