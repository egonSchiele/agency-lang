import { AgencyFunction } from "./agencyFunction.js";
import type { CallType } from "./agencyFunction.js";
import { agencyStore } from "./asyncContext.js";
import type { StateStack } from "./state/stateStack.js";

/**
 * Post-`__state`-drop migration: generated functions read `ctx` /
 * `threads` / `stateStack` from the active `agencyStore` frame and no
 * longer accept a trailing `__state` positional. The runtime call
 * dispatcher therefore no longer constructs a merged state bag for
 * every call — it just hands the caller-provided `extras` (when
 * present) to `AgencyFunction.invoke()` as the optional `state` arg.
 *
 * Two narrow special cases survive:
 *
 *  1. **`checkpoint()` / `getCheckpoint()` / `restore()` location info.**
 *     The codegen emits `{ moduleId, scopeName, stepPath }` as `extras`
 *     so the checkpoint-creation site records the source location.
 *     These stdlib helpers still accept a trailing `__state` arg, but
 *     read `ctx` / `stateStack` from ALS — the bag is consulted only
 *     for the per-call-site location fields.
 *
 *  2. **Async-fork `stateStack` override.** Codegen for `async helper()`
 *     unassigned calls emits `{ stateStack: __forked }` so the branch
 *     runs on an isolated stack. We install a new ALS frame with the
 *     forked stack before invoking, so the callee's
 *     `getRuntimeContext().ctx.stateStack`-equivalent reads see the
 *     branch stack instead of the parent's. (The async-unassigned
 *     operator is slated for removal in favor of `fork` / `parallel`,
 *     which carry their own per-branch ALS frames via
 *     `runBatch.runInBranchAlsFrame`.)
 */
function maybeRunWithForkedStack(
  extras: unknown,
  fn: () => Promise<unknown>,
): Promise<unknown> {
  const e = extras as Record<string, unknown> | undefined;
  if (!e || !e.stateStack) return fn();
  const store = agencyStore.getStore();
  if (!store) return fn();
  return agencyStore.run(
    { ...store, stack: e.stateStack as StateStack },
    fn,
  );
}

export async function __call(
  target: unknown,
  descriptor: CallType,
  stateExtras?: unknown,
  optional?: boolean,
): Promise<unknown> {
  if (optional && (target === null || target === undefined)) {
    return undefined;
  }
  if (AgencyFunction.isAgencyFunction(target)) {
    return maybeRunWithForkedStack(stateExtras, () =>
      target.invoke(descriptor, stateExtras),
    );
  }
  if (typeof target !== "function") {
    throw new Error(`Cannot call non-function value: ${String(target)}`);
  }
  if (descriptor.type === "named") {
    throw new Error(
      `Named arguments are not supported for non-Agency function '${target.name || "(anonymous)"}'`,
    );
  }
  return target(...descriptor.args);
}

export async function __callMethod(
  obj: unknown,
  prop: string | number,
  descriptor: CallType,
  stateExtras?: unknown,
  optional?: boolean,
): Promise<unknown> {
  if (optional && (obj === null || obj === undefined)) {
    return undefined;
  }

  // AgencyFunction methods: .partial() and .describe() are handled directly
  if (AgencyFunction.isAgencyFunction(obj)) {
    if (prop === "partial") {
      if (descriptor.type !== "named") {
        throw new Error(".partial() requires named arguments, e.g. fn.partial(a: 5)");
      }
      return obj.partial(descriptor.namedArgs);
    }
    if (prop === "describe") {
      if (descriptor.type !== "positional" || descriptor.args.length !== 1) {
        throw new Error(".describe() requires exactly one string argument");
      }
      return obj.describe(descriptor.args[0] as string);
    }
    if (prop === "preapprove") {
      const hasArgs =
        descriptor.type === "named"
          ? descriptor.positionalArgs.length > 0 ||
            Object.keys(descriptor.namedArgs).length > 0
          : descriptor.args.length > 0;
      if (hasArgs) {
        throw new Error(".preapprove() takes no arguments");
      }
      return obj.preapprove();
    }
  }

  const target = (obj as any)[prop];
  if (AgencyFunction.isAgencyFunction(target)) {
    return maybeRunWithForkedStack(stateExtras, () =>
      target.invoke(descriptor, stateExtras),
    );
  }
  if (typeof target !== "function") {
    throw new Error(`Cannot call non-function value at property '${String(prop)}': ${String(target)}`);
  }
  if (descriptor.type === "named") {
    throw new Error(
      `Named arguments are not supported for non-Agency function '${String(prop)}'`,
    );
  }
  // Reuse the single property lookup while preserving `this` binding.
  return Reflect.apply(target, obj, descriptor.args);
}
