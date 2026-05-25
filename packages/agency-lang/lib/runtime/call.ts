import { AgencyFunction } from "./agencyFunction.js";
import type { CallType } from "./agencyFunction.js";
import { agencyStore } from "./asyncContext.js";

/**
 * Construct the `__state` bag that flows into AgencyFunction.invoke() from
 * the active ALS frame, merged with any caller-provided extras (e.g.
 * `moduleId`/`scopeName`/`stepPath` for checkpoint sites, or `{ ctx }`
 * when called from inside `__initializeGlobals` which runs before the
 * ALS frame is installed).
 *
 * Returning `undefined` here preserves the pre-ALS semantics where some
 * sites called `target.invoke(descriptor)` with no state.
 */
function buildStateFromALS(extras?: unknown): unknown {
  const store = agencyStore.getStore();
  if (!store) {
    // Outside an ALS frame (e.g., global init): rely entirely on
    // whatever the caller passed.
    return extras;
  }
  const base = {
    ctx: store.ctx,
    threads: store.threads,
    stateStack: store.stack,
  };
  if (!extras) return base;
  return { ...base, ...(extras as Record<string, unknown>) };
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
    return target.invoke(descriptor, buildStateFromALS(stateExtras));
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
    return target.invoke(descriptor, buildStateFromALS(stateExtras));
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
