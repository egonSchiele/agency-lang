// One value kept on `globalThis`, for code a browser bundle contains.
// `processSlot` does the same on `process`, which is Node-only; this one
// reaches no Node name. A process can hold more than one copy of the
// runtime, and a module variable would be one per copy.

import type { ProcessSlot } from "./processSlot.js";

/** The value kept on `globalThis` under `name`, shared by every copy of the
 *  runtime in the process. `initial` makes the value on the first read. */
export function globalSlot<T>(name: string, initial: () => T): ProcessSlot<T> {
  const key = Symbol.for(name);
  const slots = globalThis as unknown as Record<symbol, { value: T } | undefined>;
  return {
    get() {
      const held = slots[key] ?? { value: initial() };
      slots[key] = held;
      return held.value;
    },
    set(value) {
      slots[key] = { value };
    },
  };
}
