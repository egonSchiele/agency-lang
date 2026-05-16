import type { MemoryManager } from "./memory/index.js";

/**
 * Narrow, user-facing view of `RuntimeContext`. Returned by the
 * `getContext()` builtin. Only fields safe for user code go here;
 * anything internal (debugger, statelog, abort controller, ...)
 * stays off this type and remains accessible only to runtime code
 * that has the full `RuntimeContext`.
 *
 * `RuntimeContext` is structurally a superset of this type, so the
 * `__ctx` reference that `getContext()` lowers to satisfies the type
 * without any wrapping or copying at runtime.
 */
export type Context = {
  /** Active memory manager, if memory is configured. */
  memoryManager?: MemoryManager;
};
