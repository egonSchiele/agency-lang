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

  async awaitPending(keys: string[]): Promise<void> {
    const entries = keys
      .map((k) => ({ key: k, entry: this.pending[k] }))
      .filter((e) => e.entry !== undefined);

    if (entries.length === 0) return;

    const results = await Promise.all(entries.map((e) => e.entry!.promise));

    for (let i = 0; i < entries.length; i++) {
      const { key, entry } = entries[i];
      if (entry!.resolve) {
        entry!.resolve(results[i]);
      }
      delete this.pending[key];
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
