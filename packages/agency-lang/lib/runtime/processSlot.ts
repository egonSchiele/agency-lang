// One value kept on `globalThis`, so it is one per process. A process can
// hold more than one copy of the runtime (a test worker re-evaluates modules
// per file; a package can be under node_modules twice), and a value that is
// one per process, such as what its debug socket serves, must be the same
// value for every copy. A module variable would be one per copy.
// `globalThis` rather than `process`, so a browser bundle can use it too.

export type ProcessSlot<T> = {
  get(): T;
  set(value: T): void;
};

/** The value kept on `globalThis` under `name`, shared by every copy of the
 *  runtime in the process. `initial` makes the value on the first read. */
export function processSlot<T>(name: string, initial: () => T): ProcessSlot<T> {
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
