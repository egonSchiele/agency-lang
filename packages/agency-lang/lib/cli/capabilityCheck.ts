// The runner's half of the capability log (lib/runtime/capabilityLog.ts):
// what a test's subprocess asked the host for, against the @capabilities
// tags of the functions that were running at the time.

import { CAPABILITIES, type Capability } from "../host/host.js";
import type { CapabilityLogEntry } from "../runtime/capabilityLog.js";

/** The capabilities the check leaves out. `llm`: both platforms have it,
 *  and a model call is made by `llm()`, which is not a function a tag can
 *  sit on. `terminal`: the runtime itself asks the terminal its size and
 *  colour support from whatever function happens to print first, so the
 *  use lands on a function whose tag has nothing to do with it. */
const UNCHECKED_CAPABILITIES: Capability[] = ["llm", "terminal"];

/** The capabilities the check covers: every one in `CAPABILITIES` that is
 *  not left out above, so a new capability is checked unless someone
 *  decides otherwise. */
export const CHECKED_CAPABILITIES: Capability[] = CAPABILITIES.filter(
  (capability) => !UNCHECKED_CAPABILITIES.includes(capability),
);

/** What the log says about one test case. Each entry of `uncovered` is a
 *  host use no running function's tag covers: the host function, the
 *  capability, and the innermost function that was running. `outside` is
 *  a host use made while no function was running: the runtime's own work
 *  after a node returned (a memory frame being saved), or top-level code.
 *  No tag can cover those, so they are notes and do not fail the case. */
export type CapabilityCheckResult = { uncovered: string[]; outside: string[] };

type Frame = { name: string; capabilities: Capability[] };

/**
 * Replay the log. `enter` pushes a frame and `exit` pops the innermost
 * frame with that name; a `use` is covered when any frame on the stack
 * declares its capability.
 *
 * Concurrent branches interleave their lines, so the stack is really the
 * set of every in-flight function across branches, and a use is covered if
 * any of them declares the capability. The errors this produces are false
 * passes: a wrong tag can hide behind a concurrent function with the right
 * one, so a green run does not prove the tags complete.
 */
export function checkCapabilityLog(entries: CapabilityLogEntry[]): CapabilityCheckResult {
  const stack: Frame[] = [];
  const uncovered: string[] = [];
  const outside: string[] = [];
  for (const entry of entries) {
    if (entry.kind === "enter") {
      stack.push({ name: entry.name, capabilities: entry.capabilities });
    } else if (entry.kind === "exit") {
      const index = stack.map((frame) => frame.name).lastIndexOf(entry.name);
      if (index !== -1) {
        stack.splice(index, 1);
      }
    } else if (CHECKED_CAPABILITIES.includes(entry.capability)) {
      const innermost = stack[stack.length - 1];
      if (innermost === undefined) {
        addOnce(
          outside,
          `${entry.functionName} used the ${entry.capability} capability outside any function`,
        );
      } else if (!stack.some((frame) => frame.capabilities.includes(entry.capability))) {
        addOnce(
          uncovered,
          `${entry.functionName} used the ${entry.capability} capability inside ${innermost.name}, whose tag does not name it`,
        );
      }
    }
  }
  return { uncovered, outside };
}

function addOnce(list: string[], item: string): void {
  if (!list.includes(item)) {
    list.push(item);
  }
}
