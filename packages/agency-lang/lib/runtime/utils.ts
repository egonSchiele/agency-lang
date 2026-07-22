import { color } from "@/utils/termcolors.js";
import { GlobalStore } from "./state/globalStore.js";
import { ThreadStore } from "./index.js";
import { RunNodeResult } from "./types.js";
import { nativeTypeReplacer, nativeTypeReviver } from "./revivers/index.js";
import { failure, isSuccess, success, ResultValue } from "./result.js";

export function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj, nativeTypeReplacer), nativeTypeReviver);
}

export function deepFreeze<T>(obj: T, seen: WeakSet<object> = new WeakSet()): T {
  if (obj === null || obj === undefined || typeof obj !== "object") {
    return obj;
  }
  if (seen.has(obj)) {
    return obj;
  }
  seen.add(obj);
  Object.freeze(obj);
  // Only recurse into plain objects and arrays — class instances get
  // top-level freeze only (their internal state via methods like .add()
  // may still be mutable, which is a known limitation).
  if (Array.isArray(obj) || Object.getPrototypeOf(obj) === Object.prototype) {
    for (const value of Object.values(obj)) {
      if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
        deepFreeze(value, seen);
      }
    }
  }
  return obj;
}

/** Pull JSON out of a markdown code fence. Returns the contents of the first
 *  ```json … ``` (or ``` … ```) block found ANYWHERE in the string, or the
 *  trimmed input unchanged when no fence is present. Non-anchored on purpose:
 *  models routinely emit prose *around* the fenced block ("Here's the
 *  classification:\n```json\n{…}\n```\nThis is complex because…"), so an
 *  anchored ^```/```$ strip is not enough — the trailing prose defeats it and
 *  JSON.parse throws. Non-greedy so the first block wins. */
function stripCodeFence(s: string): string {
  const trimmed = s.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return fenced ? fenced[1].trim() : trimmed;
}

/** Strict structured-output extraction: unwrap the provider's response
 *  shape and validate against the schema. Returns success(value) with the
 *  validated value, or failure(schemaError) — never the raw content. The
 *  unwrap heuristics mirror the shapes providers actually return: the
 *  { response: ... } wrapper for primitive schemas, single-key wrappers,
 *  stringified JSON, and single-element arrays. */
export function extractStructuredResponse(
  rawValue: any,
  schema: any,
): ResultValue {
  // 1. Direct match — try parsing as-is
  const direct = schema.safeParse(rawValue);
  if (direct.success) {
    if (direct.data !== null && typeof direct.data === "object" && "response" in direct.data) {
      return success(direct.data.response);
    }
    return success(direct.data);
  }
  const schemaError = direct.error?.message ?? "schema mismatch";

  // 1.25 Envelope-skipping recovery. The codegen always requests the
  // { response: T } envelope, and models routinely return bare T anyway.
  // Validate the raw value against the INNER schema — this is schema-
  // checked recovery, not a fail-open.
  const responseShape = (schema as any).shape?.response;
  if (responseShape && typeof responseShape.safeParse === "function") {
    const inner = responseShape.safeParse(rawValue);
    if (inner.success) {
      return success(inner.data);
    }
  }

  // 1.5 Look for { type: "object", properties: { response: { ... } } } pattern
  if (rawValue != null && rawValue.type === "object" && rawValue.properties) {
    return extractStructuredResponse(rawValue.properties, schema);
  }

  // 2. String → strip any markdown code fence, JSON.parse, then recurse.
  // Models routinely wrap JSON in a ```json … ``` fence despite being asked
  // for raw output; stripping here (before the parse) lets the strict
  // validator accept fenced JSON the same way smoltalk's lenient client
  // path does. A string that is not JSON cannot satisfy an object/wrapped
  // schema that already failed step 1.
  if (typeof rawValue === "string") {
    try {
      return extractStructuredResponse(JSON.parse(stripCodeFence(rawValue)), schema);
    } catch {
      return failure(schemaError);
    }
  }

  // 3. Null/undefined/primitive — nothing to unwrap
  if (rawValue == null || typeof rawValue !== "object") {
    return failure(schemaError);
  }

  // 4. Array with one element — unwrap
  if (Array.isArray(rawValue) && rawValue.length === 1) {
    const inner = schema.safeParse(rawValue[0]);
    if (inner.success) return success(inner.data);
  }

  // 5. Object with "response" or "properties" key — strip the wrapper and
  // recurse, so step 1's direct-match (and its envelope unwrap) does the
  // extraction. The old form indexed the validated value by the SAME key
  // again (`inner.data[key]`), which returned undefined for shapes like
  // { properties: { response: 42 } } (PR #500 review). Terminates: each
  // recursion strips one layer of a finite, acyclic provider payload.
  const wrapKeys = ["response", "properties"];
  for (const key of wrapKeys) {
    if (key in rawValue) {
      const inner = extractStructuredResponse(rawValue[key], schema);
      if (isSuccess(inner)) return inner;
    }
  }

  // 6. Object with a single key whose value matches — unwrap
  const keys = Object.keys(rawValue);
  if (keys.length === 1) {
    const inner = schema.safeParse(rawValue[keys[0]]);
    if (inner.success) return success(inner.data);
  }

  // 7. Shallow search — check every value of the object
  for (const key of keys) {
    const inner = schema.safeParse(rawValue[key]);
    if (inner.success) return success(inner.data);
  }

  // 8. Nothing matched the schema.
  return failure(schemaError);
}

// not as necessary, smoltalk does this, though only when strict = true.
// Back-compat lenient wrapper: kept because it is publicly re-exported.
// New code should use extractStructuredResponse, which can say NO.
export function extractResponse(rawValue: any, schema: any): any {
  const extracted = extractStructuredResponse(rawValue, schema);
  if (isSuccess(extracted)) {
    return extracted.value;
  }
  return rawValue;
}

export function createReturnObject<T>({
  result,
  globals,
}: {
  result: { data: T; messages?: ThreadStore };
  globals: GlobalStore;
}): RunNodeResult<T> {
  // Note: we're *not* using structuredClone here because structuredClone
  // doesn't call `toJSON`, so it's not cloning our message objects correctly.
  return JSON.parse(
    JSON.stringify({
      messages: result.messages,
      data: result.data,
      tokens: globals.get(GlobalStore.INTERNAL_MODULE, "__tokenStats"),
    }, nativeTypeReplacer),
    nativeTypeReviver,
  );
}

export type ModelUsage = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Tokens read back from an existing cache entry. */
  cachedInputTokens: number;
  /** Tokens written to a new cache entry. */
  cacheCreationInputTokens: number;
  cost: number;
};

/**
 * Normalize the raw `__tokenStats.models` map into a typed, defensively
 * narrowed array sorted by cost descending (model name as the tiebreak).
 * Single source of truth for reading the per-model breakdown — shared by
 * std::thread's `getModelCosts` and the REPL footer's token snapshot so
 * the field narrowing and ordering live in one place.
 */
export function normalizeModelUsage(rawModels: unknown): ModelUsage[] {
  if (!rawModels || typeof rawModels !== "object") return [];
  const out: ModelUsage[] = [];
  for (const [model, v] of Object.entries(rawModels as Record<string, any>)) {
    out.push({
      model,
      inputTokens: typeof v?.inputTokens === "number" ? v.inputTokens : 0,
      outputTokens: typeof v?.outputTokens === "number" ? v.outputTokens : 0,
      cachedInputTokens:
        typeof v?.cachedInputTokens === "number" ? v.cachedInputTokens : 0,
      cacheCreationInputTokens:
        typeof v?.cacheCreationInputTokens === "number"
          ? v.cacheCreationInputTokens
          : 0,
      cost: typeof v?.totalCost === "number" ? v.totalCost : 0,
    });
  }
  out.sort((a, b) => b.cost - a.cost || (a.model < b.model ? -1 : 1));
  return out;
}

/** The token-usage fields `updateTokenStats` reads (all optional — providers
 *  vary, and a free/local model has no cost). */
type StatUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
  totalTokens?: number;
};
type StatCost = {
  inputCost?: number;
  outputCost?: number;
  cachedInputCost?: number;
  cacheCreationInputCost?: number;
  totalCost?: number;
};

/** Add to a counter that may be absent. Token-stats objects restored from a
 *  checkpoint written before a field existed have `undefined` there, and
 *  `undefined += n` is NaN — which then poisons every later total. */
function addTo(target: Record<string, number>, key: string, amount: number | undefined): void {
  target[key] = (target[key] || 0) + (amount || 0);
}

export function updateTokenStats(args: {
  globals: GlobalStore;
  usage: StatUsage | null | undefined;
  cost?: StatCost | null;
  model?: string;
}): void {
  const { globals, usage, model } = args;
  // `usage` is required, but `cost` may legitimately be absent: a free/local
  // model (e.g. llama-cpp) has no pricing, so the completion carries token
  // usage with no cost. Treat a missing cost as zero rather than dropping the
  // usage — otherwise the agent footer shows ↑0 ↓0 and no model name.
  if (!usage) return;
  const cost = args.cost ?? {};
  const tokenStats = globals.get(GlobalStore.INTERNAL_MODULE, "__tokenStats");
  // Accumulate a per-model usage breakdown. Every LLM call (including
  // subagent/tool branches, which pointer-share this object) lands here,
  // so the footer can list which models a turn touched and `/cost` can
  // attribute spend per model. Defensive against an absent `models` slot
  // for token-stats objects restored from older checkpoints.
  if (model) {
    // Null-prototype so a provider-supplied model name like `__proto__` becomes
    // a plain own key instead of mutating the object's prototype. Migrate a
    // plain-`{}` map (fresh or restored-from-JSON) the first time we write.
    if (!tokenStats.models || Object.getPrototypeOf(tokenStats.models) !== null) {
      tokenStats.models = Object.assign(Object.create(null), tokenStats.models);
    }
    const m = tokenStats.models[model] ??
      (tokenStats.models[model] = { inputTokens: 0, outputTokens: 0, totalCost: 0 });
    addTo(m, "inputTokens", usage.inputTokens);
    addTo(m, "outputTokens", usage.outputTokens);
    addTo(m, "cachedInputTokens", usage.cachedInputTokens);
    addTo(m, "cacheCreationInputTokens", usage.cacheCreationInputTokens);
    addTo(m, "totalCost", cost.totalCost);
  }
  // Cache reads and cache writes are tracked separately from ordinary input.
  // Without them the breakdown does not reconcile with its own total: on a
  // long agent run most of the money goes to cache writes, and most of the
  // tokens to cache reads, so a report of input + output alone can account
  // for well under half the bill.
  addTo(tokenStats.usage, "inputTokens", usage.inputTokens);
  addTo(tokenStats.usage, "outputTokens", usage.outputTokens);
  addTo(tokenStats.usage, "cachedInputTokens", usage.cachedInputTokens);
  addTo(tokenStats.usage, "cacheCreationInputTokens", usage.cacheCreationInputTokens);
  addTo(tokenStats.usage, "totalTokens", usage.totalTokens);

  addTo(tokenStats.cost, "inputCost", cost.inputCost);
  addTo(tokenStats.cost, "outputCost", cost.outputCost);
  addTo(tokenStats.cost, "cachedInputCost", cost.cachedInputCost);
  addTo(tokenStats.cost, "cacheCreationInputCost", cost.cacheCreationInputCost);
  addTo(tokenStats.cost, "totalCost", cost.totalCost);
}
