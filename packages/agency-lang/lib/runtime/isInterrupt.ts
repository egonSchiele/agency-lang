import type { Interrupt } from "./interrupts.js";

/*
 * Kept apart from `interrupts.ts` so the statelog client can tell a paused
 * node from a finished one without importing it: `interrupts.ts` imports the
 * execution context, which imports the client. The only import here is a
 * type, which disappears at runtime.
 */

export function isInterrupt(obj: any): obj is Interrupt {
  return obj && obj.type === "interrupt";
}

export function hasInterrupts(data: any): data is Interrupt[] {
  return Array.isArray(data) && data.length > 0 && data.every(isInterrupt);
}
