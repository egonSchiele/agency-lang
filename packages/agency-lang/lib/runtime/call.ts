import { AgencyFunction } from "./agencyFunction.js";
import type { CallType } from "./agencyFunction.js";
import {
  checkTsFunctionArgs,
  checkResultMethodCall,
  describeFailureCallTarget,
} from "./failurePropagation.js";
import { isFailure } from "./result.js";

/**
 * Runtime dispatcher for every Agency call site. Generated code emits
 * `__call(target, descriptor)` (or `__callMethod(obj, prop, descriptor)`)
 * and this helper figures out whether `target` is an `AgencyFunction`
 * (named-arg aware, preapprove handler wiring) or a plain TS callable.
 *
 * All execution context (`ctx`, `stack`, `threads`, per-call-site
 * `callsite`) is read from the active `agencyStore` ALS frame seeded
 * by `Runner.runInScope`. No state extras pass through this layer —
 * call sites that need to override the active branch stack (e.g. the
 * async-fork operator) install their own ALS frame around the
 * `__call(...)` invocation in codegen.
 */
export async function __call(
  target: unknown,
  descriptor: CallType,
  optional?: boolean,
): Promise<unknown> {
  if (optional && (target === null || target === undefined)) {
    return undefined;
  }
  if (AgencyFunction.isAgencyFunction(target)) {
    return target.invoke(descriptor);
  }
  if (typeof target !== "function") {
    if (isFailure(target)) {
      throw new Error(describeFailureCallTarget(target));
    }
    throw new Error(`Cannot call non-function value: ${String(target)}`);
  }
  if (descriptor.type === "named") {
    // A trailing `as x { ... }` block desugars to a "named" descriptor
    // carrying `blockArg`. JS callables can't receive trailing blocks
    // at all, so this would otherwise surface as the generic
    // "named arguments not supported" message — confusing because the
    // user didn't write any named args. Detect and report the actual
    // problem first.
    if (descriptor.blockArg !== undefined) {
      throw new Error(
        `Cannot pass a trailing block to non-Agency function '${target.name || "(anonymous)"}'. ` +
        `Trailing 'as x { ... }' blocks are only valid on Agency-defined functions.`,
      );
    }
    throw new Error(
      `Named arguments are not supported for non-Agency function '${target.name || "(anonymous)"}'`,
    );
  }
  checkTsFunctionArgs(target, target.name || "(anonymous)", descriptor.args);
  return target(...descriptor.args);
}

export async function __callMethod(
  obj: unknown,
  prop: string | number,
  descriptor: CallType,
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
    if (prop === "rename") {
      if (descriptor.type !== "positional" || descriptor.args.length !== 1) {
        throw new Error(".rename() requires exactly one string argument");
      }
      // The new name becomes the tool name the LLM sees and the key used
      // for tool-call dispatch, so a non-string would corrupt both. The
      // typechecker enforces this statically, but `any` values and direct
      // JS callers bypass it — guard at runtime too.
      if (typeof descriptor.args[0] !== "string") {
        throw new Error(
          `.rename() requires a string argument, got ${typeof descriptor.args[0]}`,
        );
      }
      return obj.rename(descriptor.args[0]);
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

  // A method call on a Result object is a forgotten-unwrap bug unless the
  // property is an own field holding a callable (`r.value()` on a
  // function-wrapping success). Throws a plain Error; the enclosing
  // auto-try converts it into a catchable failure.
  //
  // Deliberately the ONLY check in __callMethod: method ARGUMENTS are not
  // scanned, because native prototype methods are untagged plain functions
  // and `arr.push(someFailure)` / `arr.includes(f)` must keep working
  // (collecting Results into arrays is the pattern the shallow check
  // protects). The TS-function argument scan lives in __call only.
  checkResultMethodCall(obj, prop);

  const target = (obj as any)[prop];
  if (AgencyFunction.isAgencyFunction(target)) {
    return target.invoke(descriptor);
  }
  if (typeof target !== "function") {
    throw new Error(`Cannot call non-function value at property '${String(prop)}': ${String(target)}`);
  }
  if (descriptor.type === "named") {
    // See the matching branch in `__call` above. A trailing block on
    // a JS method desugars to a "named" descriptor with `blockArg`;
    // detect that case so the user gets the actual diagnostic.
    if (descriptor.blockArg !== undefined) {
      throw new Error(
        `Cannot pass a trailing block to non-Agency function '${String(prop)}'. ` +
        `Trailing 'as x { ... }' blocks are only valid on Agency-defined functions.`,
      );
    }
    throw new Error(
      `Named arguments are not supported for non-Agency function '${String(prop)}'`,
    );
  }
  // Reuse the single property lookup while preserving `this` binding.
  return Reflect.apply(target, obj, descriptor.args);
}
