import { agencyStore } from "./asyncContext.js";
import {
  failure,
  isFailure,
  isSuccess,
  propagateFailure,
  success,
  type ResultFailure,
} from "./result.js";
import { truncate } from "./truncate.js";
import type { FuncParam } from "./agencyFunction.js";

/** Runtime mode for the failure-propagation feature. "on": skip/throw.
 *  "warn": warnings only, legacy behavior otherwise. "off": no checks. */
export type FailurePropagationMode = "off" | "warn" | "on";

/** Resolve the active mode. Two defaults exist ON PURPOSE and only the
 *  other one flips at Stage 2: real compiled programs read the mode off
 *  their ExecutionContext (whose constructor default is the staged
 *  rollout value — "warn" in Stage 1); the `?? "on"` here applies only
 *  OUTSIDE an execution frame, i.e. bare unit tests and direct runtime
 *  callers, which have no config to honor and no corpus at risk, so they
 *  always get the strict rule. Do not change this fallback when flipping
 *  the rollout default. */
export function getFailurePropagationMode(): FailurePropagationMode {
  return agencyStore.getStore()?.ctx?.failurePropagation ?? "on";
}

/** Symbol.for so the tag survives duplicated module instances (e.g. a
 *  test importing both src and dist copies of the runtime). */
const ACCEPTS_FAILURES = Symbol.for("agency.acceptsFailures");

/** Tag a plain TypeScript function as legitimately receiving failure
 *  values, exempting it from the dispatcher's failure-argument check. */
export function acceptsFailures<T extends (...args: any[]) => any>(fn: T): T {
  (fn as any)[ACCEPTS_FAILURES] = true;
  return fn;
}

export function isFailureTolerant(fn: unknown): boolean {
  if (typeof fn !== "function") {
    return false;
  }
  // An ALIASED JSON.stringify (`const s = JSON.stringify; s(f)`) routes
  // through __call; stringifying a failure is a legitimate debugging move,
  // and the function is native, so tag by identity. (Direct
  // `JSON.stringify(f)` goes through __callMethod, which does not scan
  // arguments at all — the TS-function argument scan lives in __call only.)
  if (fn === JSON.stringify) {
    return true;
  }
  return (fn as any)[ACCEPTS_FAILURES] === true;
}

// These four are DIRECT_CALL_FUNCTIONS (nameClassifier.ts), so by-name
// calls never reach the dispatcher. Tag them anyway: aliased and
// higher-order uses (`const f = isFailure; f(x)`, `const mk = failure;
// mk(inner)`) route through __call like any other value.
acceptsFailures(isSuccess);
acceptsFailures(isFailure);
acceptsFailures(success);
acceptsFailures(failure);

function origin(f: ResultFailure): string {
  return f.functionName ?? "(unknown)";
}

function logWarn(mode: FailurePropagationMode, message: string, detail: {
  functionName?: string;
  param?: string;
  error?: unknown;
}): void {
  const ctx = agencyStore.getStore()?.ctx;
  // Fire-and-forget, like handlerDecision in interrupts.ts. Optional-chained
  // end to end: unit tests and mock contexts may lack a statelog client.
  void ctx?.statelogClient?.warn?.({
    warnType: "failurePropagation",
    message,
    functionName: detail.functionName,
    param: detail.param,
    error: detail.error,
  });
  // Warn mode exists to be SEEN: without observability config the statelog
  // event goes nowhere, so echo to stderr. "on" mode stays quiet here — its
  // skip/throw is the signal. (statelogClient itself uses console.warn, so
  // this is an allowed pattern.)
  if (mode === "warn") {
    console.warn(`failurePropagation: ${message}`);
  }
}

/** The failure carried by this argument slot, if any. A variadic slot
 *  holds the gathered array, so scan its elements; any other array is
 *  opaque (shallow check — collecting Results into arrays is legitimate). */
function findFailureInArg(param: FuncParam, arg: unknown): ResultFailure | undefined {
  if (param.variadic && Array.isArray(arg)) {
    return arg.find(isFailure);
  }
  if (isFailure(arg)) {
    return arg;
  }
  return undefined;
}

/**
 * Scan resolved call arguments for failures landing on params that do not
 * accept Results. `args` is aligned index-for-index with `params` (invoke
 * passes the merged, resolved list; the variadic slot holds the gathered
 * array). Returns the failure to propagate, or null to proceed with the
 * call. Only `acceptsResult === false` rejects — absent means a legacy or
 * handcrafted param, which fails open.
 */
export function checkFailureArgs(
  fnName: string,
  params: FuncParam[],
  args: unknown[],
): ResultFailure | null {
  const mode = getFailurePropagationMode();
  if (mode === "off") {
    return null;
  }
  const count = Math.min(params.length, args.length);
  for (let i = 0; i < count; i++) {
    const param = params[i];
    if (param.acceptsResult !== false) {
      continue;
    }
    const hit = findFailureInArg(param, args[i]);
    if (hit === undefined) {
      continue;
    }
    logWarn(
      mode,
      `call to '${fnName}' skipped: parameter '${param.name}' received a failure produced by '${origin(hit)}' (${truncate(hit.error)})`,
      { functionName: fnName, param: param.name, error: hit.error },
    );
    if (mode === "warn") {
      // Census semantics: warn mode exists to MEASURE, so log every
      // rejecting hit in the call rather than stopping at the first.
      // "on" mode acts on the first (leftmost) hit only.
      continue;
    }
    return propagateFailure(hit, { name: fnName, param: param.name });
  }
  return null;
}

/**
 * A failure passed to a plain TypeScript function is always a mistake
 * unless the function is tagged. Throws a plain Error (NEVER AgencyAbort —
 * the enclosing auto-try must convert it into a catchable failure).
 */
export function checkTsFunctionArgs(
  target: (...args: unknown[]) => unknown,
  fnName: string,
  args: unknown[],
): void {
  const mode = getFailurePropagationMode();
  if (mode === "off" || isFailureTolerant(target)) {
    return;
  }
  for (const arg of args) {
    if (!isFailure(arg)) {
      continue;
    }
    const message =
      `'${fnName}' received a failure produced by '${origin(arg)}' (${truncate(arg.error)}). ` +
      `TypeScript functions cannot receive failures. Check the Result before passing it, ` +
      `or tag the function with acceptsFailures().`;
    logWarn(mode, message, { functionName: fnName, error: arg.error });
    if (mode === "on") {
      throw new Error(message);
    }
    // warn mode: census — keep scanning so every failure arg is logged.
  }
}

/**
 * A method call on a Result throws, unless the property is an own field
 * holding a callable (`r.value()` when the success wraps a function or
 * AgencyFunction). Prototype methods like .toString() throw too. Plain
 * Error only — see checkTsFunctionArgs.
 */
export function checkResultMethodCall(
  obj: unknown,
  prop: string | number,
): void {
  const isFailureObj = isFailure(obj);
  if (!isFailureObj && !isSuccess(obj)) {
    return;
  }
  const mode = getFailurePropagationMode();
  if (mode === "off") {
    return;
  }
  if (Object.hasOwn(obj as object, prop)) {
    const own = (obj as any)[prop];
    if (typeof own === "function" || (own as any)?.__agencyFunction === true) {
      return;
    }
  }
  const message = isFailureObj
    ? `called '.${String(prop)}()' on a failure produced by '${origin(obj as ResultFailure)}' (${truncate((obj as ResultFailure).error)}). Check the Result before using it.`
    : `called '.${String(prop)}()' on a success Result. Did you mean .value.${String(prop)}(...)?`;
  logWarn(mode, message, { param: String(prop) });
  if (mode === "on") {
    throw new Error(message);
  }
  // warn mode: the call falls through to today's generic "Cannot call
  // non-function value at property ..." error downstream. That IS the
  // legacy behavior warn mode promises — do not "fix" it.
}

/** Message for `__call` when the call TARGET itself is a failure value.
 *  Deliberately NOT mode-gated: this path already threw ("Cannot call
 *  non-function value") before this feature, so enriching the message is
 *  not a behavior change and warn mode's legacy-behavior promise holds. */
export function describeFailureCallTarget(f: ResultFailure): string {
  return (
    `Cannot call a failure value produced by '${origin(f)}' (${truncate(f.error)}). ` +
    `Check the Result before calling it.`
  );
}
