// The runner's half of the capability log (lib/runtime/capabilityLog.ts):
// what a test's subprocess asked the host for, against the @capabilities
// tags of the functions that were running at the time.

import { CAPABILITIES, type Capability } from "../host/host.js";
import type { CapabilityLogEntry } from "../runtime/capabilityLog.js";

/** The capabilities the check leaves out. `llm`: both platforms have it,
 *  and a model call is made by `llm()`, which is not a function a tag can
 *  sit on. */
const UNCHECKED_CAPABILITIES: Capability[] = ["llm"];

/** The capabilities the check covers: every one in `CAPABILITIES` that is
 *  not left out above, so a new capability is checked unless someone
 *  decides otherwise. */
export const CHECKED_CAPABILITIES: Capability[] = CAPABILITIES.filter(
  (capability) => !UNCHECKED_CAPABILITIES.includes(capability),
);

/** What the log says about one test case. Each entry of `uncovered` is a
 *  host use no running function's tag covers: the host function, the
 *  capability, and the innermost function that was running. */
export type CapabilityCheckResult = { uncovered: string[] };

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
  for (const entry of entries) {
    if (entry.kind === "enter") {
      stack.push({ name: entry.name, capabilities: entry.capabilities });
    } else if (entry.kind === "exit") {
      const index = stack.map((frame) => frame.name).lastIndexOf(entry.name);
      if (index !== -1) {
        stack.splice(index, 1);
      }
    } else if (CHECKED_CAPABILITIES.includes(entry.capability)) {
      const covered = stack.some((frame) => frame.capabilities.includes(entry.capability));
      if (!covered) {
        const problem = describeUncovered(entry.functionName, entry.capability, stack);
        if (!uncovered.includes(problem)) {
          uncovered.push(problem);
        }
      }
    }
  }
  return { uncovered };
}

function describeUncovered(functionName: string, capability: Capability, stack: Frame[]): string {
  const innermost = stack[stack.length - 1];
  const where =
    innermost === undefined
      ? "outside any function"
      : `inside ${innermost.name}, whose tag does not name it`;
  return `${functionName} used the ${capability} capability ${where}`;
}
