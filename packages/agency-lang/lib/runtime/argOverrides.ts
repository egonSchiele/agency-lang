import type { PendingArgOverrides } from "./state/context.js";

export type PendingOverridesHolder = {
  _pendingArgOverrides?: PendingArgOverrides;
};

export type OverridableFrame = {
  moduleId: string | null;
  scopeName: string | null;
  args: Record<string, unknown>;
};

/**
 * Apply the argument overrides a resume carries (`agency resume --arg`, or
 * `restore(cp, { args })`) when they name this frame. Each override that
 * names one of the function's `parameters` is written into the frame's
 * argument slot; the pending overrides are cleared either way.
 *
 * Returns the overridden parameter names in declaration order, or
 * `undefined` when no overrides were pending for this frame. A function
 * calls this before its step 0, so a frame paused at entry checks the
 * overridden value, not the one it paused with.
 */
export function __takeArgOverrides(
  ctx: PendingOverridesHolder,
  frame: OverridableFrame,
  parameters: string[],
): string[] | undefined {
  const pending = ctx._pendingArgOverrides;
  if (pending === undefined) return undefined;
  if (pending.moduleId !== frame.moduleId || pending.scopeName !== frame.scopeName) {
    return undefined;
  }
  ctx._pendingArgOverrides = undefined;
  const overridden: string[] = [];
  for (const name of parameters) {
    if (!Object.hasOwn(pending.values, name)) continue;
    frame.args[name] = pending.values[name];
    overridden.push(name);
  }
  return overridden;
}
