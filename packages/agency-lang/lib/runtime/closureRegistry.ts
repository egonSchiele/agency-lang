import type { FuncParam } from "./agencyFunction.js";

export type ClosureRegistryEntry = {
  fn: Function;
  params: FuncParam[];
};

const globalClosureRegistry: Record<string, ClosureRegistryEntry> = {};

/** Register a closure implementation at module load time.
 * Keys are globally unique: "module:outer::inner". */
export function registerClosure(
  key: string,
  entry: ClosureRegistryEntry,
): void {
  globalClosureRegistry[key] = entry;
}

/** Look up a closure implementation by key. */
export function lookupClosure(
  key: string,
): ClosureRegistryEntry | undefined {
  return globalClosureRegistry[key];
}

/** Sentinel value used in closureData to represent a self-reference,
 * avoiding circular references during JSON serialization. */
export const CLOSURE_SELF_SENTINEL = "__self__";
