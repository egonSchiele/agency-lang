import type { KeyEvent, InputSource } from "./types.js";

export class ScriptedInput implements InputSource {
  private keyQueue: KeyEvent[] = [];
  private keyWaiters: ((key: KeyEvent) => void)[] = [];
  private lineQueue: string[] = [];
  private lineWaiters: ((line: string) => void)[] = [];

  /**
   * Optionally pre-load the input with a sequence of keys. Strings are
   * converted to `{ key }` events; `KeyEvent` objects are used as-is.
   */
  constructor(initial?: ReadonlyArray<KeyEvent | string>) {
    if (initial) {
      for (const item of initial) {
        this.feedKey(typeof item === "string" ? { key: item } : item);
      }
    }
  }

  feedKey(key: KeyEvent): void {
    const waiter = this.keyWaiters.shift();
    if (waiter) {
      waiter(key);
    } else {
      this.keyQueue.push(key);
    }
  }

  feedLine(line: string): void {
    const waiter = this.lineWaiters.shift();
    if (waiter) {
      waiter(line);
    } else {
      this.lineQueue.push(line);
    }
  }

  nextKey(): Promise<KeyEvent> {
    const queued = this.keyQueue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve) => {
      this.keyWaiters.push(resolve);
    });
  }

  nextLine(_prompt: string): Promise<string> {
    const queued = this.lineQueue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve) => {
      this.lineWaiters.push(resolve);
    });
  }

  destroy(): void {
    this.keyQueue = [];
    this.keyWaiters = [];
    this.lineQueue = [];
    this.lineWaiters = [];
  }
}
