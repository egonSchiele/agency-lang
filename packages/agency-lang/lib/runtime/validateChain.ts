import { z } from "zod";
import { success, failure, isFailure, isSuccess } from "./result.js";
import type { ResultValue } from "./result.js";
import { AgencyFunction } from "./agencyFunction.js";

/**
 * Async validator used by `@validate(...)` chains. May be:
 *  - a plain async function `(value) => Result` (the simplest shape;
 *    users can import `success` / `failure` from the agency-lang runtime
 *    and return whichever applies);
 *  - an `AgencyFunction` (an Agency `def` referenced by name), which is
 *    invoked via `.invoke({ type: "positional", args: [value] })` so we
 *    go through the same call infrastructure as `__call(...)`.
 *
 * Validators that need access to the execution context read it from the
 * active `agencyStore` ALS frame via `getRuntimeContext()`. There is no
 * `ctx` arg to thread through.
 */
export type AgencyValidator =
  | ((value: unknown) => Promise<ResultValue> | ResultValue)
  | AgencyFunction;

async function callValidator(
  v: AgencyValidator,
  value: unknown,
): Promise<ResultValue> {
  if (AgencyFunction.isAgencyFunction(v)) {
    return (await (v as AgencyFunction).invoke({
      type: "positional",
      args: [value],
    })) as ResultValue;
  }
  return (v as (x: unknown) => Promise<ResultValue> | ResultValue)(value);
}

/**
 * Run Zod parse then thread the result through validators in order,
 * stopping on the first failure. Validators may transform: the value
 * passed to validator N+1 is whatever validator N returned with success.
 *
 * Why outside Zod? See spec § "Why run validators outside Zod" —
 * keeping validators out of the sync Zod path lets them be async,
 * call other Agency functions, hit the network, etc.
 */
export async function __validateChain(
  value: unknown,
  schema: z.ZodType,
  validators: AgencyValidator[],
): Promise<ResultValue> {
  // Don't validate failures — surface the original error unchanged.
  if (isFailure(value)) return value as ResultValue;

  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    return failure(parsed.error.message);
  }
  let raw: unknown = parsed.data;

  // If the parsed value is itself a Result, unwrap on success / forward
  // failure unchanged, matching the convention in __validateType.
  if (isSuccess(raw)) raw = (raw as { value: unknown }).value;
  else if (isFailure(raw)) return raw as ResultValue;

  let current: ResultValue = success(raw);
  for (const v of validators) {
    if (!isSuccess(current)) return current;
    current = await callValidator(v, (current as { value: unknown }).value);
  }
  return current;
}

/**
 * Structural descriptor for nested validation. Built at codegen time
 * from the resolved type tree. The walker uses this descriptor to know
 * which validator list to apply at each depth and how to dispatch
 * unions / arrays / objects / nullables.
 */
export type TypeValidationDescriptor =
  | {
      kind: "leaf";
      schema: z.ZodType;
      validators: AgencyValidator[];
    }
  | {
      kind: "object";
      schema: z.ZodType;
      validators: AgencyValidator[];
      properties: Record<string, TypeValidationDescriptor>;
    }
  | {
      kind: "array";
      schema: z.ZodType;
      validators: AgencyValidator[];
      element: TypeValidationDescriptor;
    }
  | {
      kind: "union";
      schema: z.ZodType;
      validators: AgencyValidator[];
      branches: Array<{
        test: (v: unknown) => boolean;
        descriptor: TypeValidationDescriptor;
      }>;
    }
  | {
      kind: "nullable";
      schema: z.ZodType;
      validators: AgencyValidator[];
      inner: TypeValidationDescriptor;
    };

export type RecursiveValidationOpts = {
  /** Hard cap on traversal depth. Default 64. */
  maxDepth?: number;
};

/**
 * Walk `value` alongside `descriptor`, running per-node validator chains
 * and recursing into nested types. Bails with a failure once depth
 * exceeds `opts.maxDepth ?? 64`.
 */
export async function __validateChainRecursive(
  value: unknown,
  descriptor: TypeValidationDescriptor,
  opts?: RecursiveValidationOpts,
): Promise<ResultValue> {
  const maxDepth = opts?.maxDepth ?? 64;
  return walk(value, descriptor, 0, maxDepth);
}

async function walk(
  value: unknown,
  descriptor: TypeValidationDescriptor,
  depth: number,
  maxDepth: number,
): Promise<ResultValue> {
  if (depth > maxDepth) {
    return failure({
      reason: "validation recursion depth exceeded",
      limit: maxDepth,
      kind: descriptor.kind,
      valuePreview: previewValue(value),
    });
  }
  if (isFailure(value)) return value as ResultValue;

  // Step 1: parse + own validators at this node.
  const own = await __validateChain(
    value,
    descriptor.schema,
    descriptor.validators,
  );
  if (!isSuccess(own)) return own;
  const parsed = (own as { value: unknown }).value;

  // Step 2: structural recursion.
  switch (descriptor.kind) {
    case "leaf":
      return success(parsed);

    case "nullable": {
      if (parsed === null || parsed === undefined) {
        return success(parsed);
      }
      const inner = await walk(parsed, descriptor.inner, depth + 1, maxDepth);
      return inner;
    }

    case "array": {
      if (!Array.isArray(parsed)) return success(parsed);
      const out: unknown[] = [];
      for (const el of parsed) {
        const r = await walk(el, descriptor.element, depth + 1, maxDepth);
        if (!isSuccess(r)) return r;
        out.push((r as { value: unknown }).value);
      }
      return success(out);
    }

    case "object": {
      if (parsed === null || typeof parsed !== "object") {
        return success(parsed);
      }
      const out: Record<string, unknown> = { ...(parsed as Record<string, unknown>) };
      for (const [key, childDesc] of Object.entries(descriptor.properties)) {
        const r = await walk(
          (parsed as Record<string, unknown>)[key],
          childDesc,
          depth + 1,
          maxDepth,
        );
        if (!isSuccess(r)) return r;
        out[key] = (r as { value: unknown }).value;
      }
      return success(out);
    }

    case "union": {
      const branch = descriptor.branches.find((b) => b.test(parsed));
      if (!branch) return success(parsed);
      return walk(parsed, branch.descriptor, depth + 1, maxDepth);
    }
  }
}

/**
 * Return a short, cycle-safe, JSON-friendly preview of a value for use
 * inside error payloads. We don't want huge or self-referential structures
 * to blow up the failure message.
 */
function previewValue(value: unknown, maxLen = 200): unknown {
  const seen = new WeakSet<object>();
  const replacer = (_k: string, v: unknown): unknown => {
    if (typeof v === "object" && v !== null) {
      if (seen.has(v)) return "[cycle]";
      seen.add(v);
    }
    return v;
  };
  let str: string;
  try {
    str = JSON.stringify(value, replacer);
  } catch {
    return String(value).slice(0, maxLen);
  }
  if (str === undefined) return String(value).slice(0, maxLen);
  return str.length > maxLen ? `${str.slice(0, maxLen)}…` : str;
}
