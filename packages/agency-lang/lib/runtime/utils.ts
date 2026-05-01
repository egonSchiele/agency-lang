import { color } from "termcolors";
import { GlobalStore } from "./state/globalStore.js";
import { ThreadStore } from "./index.js";
import { RunNodeResult } from "./types.js";
import { nativeTypeReplacer, nativeTypeReviver } from "./revivers/index.js";

export function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj, nativeTypeReplacer), nativeTypeReviver);
}

export function deepFreeze<T>(obj: T): T {
  if (obj === null || obj === undefined || typeof obj !== "object") {
    return obj;
  }
  Object.freeze(obj);
  for (const value of Object.values(obj)) {
    if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
      deepFreeze(value);
    }
  }
  return obj;
}

// not as necessary, smoltalk does this, though only when strict = true
export function extractResponse(rawValue: any, schema: any): any {
  // 1. Direct match — try parsing as-is
  const direct = schema.safeParse(rawValue);
  if (direct.success) {
    if ("response" in direct.data) {
      return direct.data.response;
    }
    return direct.data;
  }

  // 1.5 Look for { type: "object", properties: { response: { ... } } } pattern
  if (rawValue.type === "object" && rawValue.properties) {
    return extractResponse(rawValue.properties, schema);
  }

  // 2. String → try JSON.parse, then recurse
  if (typeof rawValue === "string") {
    const stripped = rawValue;
    try {
      return extractResponse(JSON.parse(stripped), schema);
    } catch {}
    return rawValue;
  }

  // 3. Null/undefined/primitive — nothing to unwrap
  if (rawValue == null || typeof rawValue !== "object") {
    return rawValue;
  }

  // 4. Array with one element — unwrap
  if (Array.isArray(rawValue) && rawValue.length === 1) {
    const inner = schema.safeParse(rawValue[0]);
    if (inner.success) return inner.data;
  }

  // 5. Object with "response" or "properties" key — unwrap
  const wrapKeys = ["response", "properties"];
  for (const key of wrapKeys) {
    if (key in rawValue) {
      const inner = schema.safeParse(rawValue[key]);
      if (inner.success) return inner.data[key];
    }
  }

  // 6. Object with a single key whose value matches — unwrap
  const keys = Object.keys(rawValue);
  if (keys.length === 1) {
    const inner = schema.safeParse(rawValue[keys[0]]);
    if (inner.success) return inner.data;
  }

  // 7. Shallow search — check every value of the object
  for (const key of keys) {
    const inner = schema.safeParse(rawValue[key]);
    if (inner.success) return inner.data;
  }

  // 8. Nothing worked — return the original value as-is
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

export function updateTokenStats(args: {
  globals: GlobalStore;
  usage: any;
  cost: any;
}): void {
  const { globals, usage, cost } = args;
  if (!usage || !cost) return;
  const tokenStats = globals.get(GlobalStore.INTERNAL_MODULE, "__tokenStats");
  tokenStats.usage.inputTokens += usage.inputTokens || 0;
  tokenStats.usage.outputTokens += usage.outputTokens || 0;
  tokenStats.usage.cachedInputTokens += usage.cachedInputTokens || 0;
  tokenStats.usage.totalTokens += usage.totalTokens || 0;

  tokenStats.cost.inputCost += cost.inputCost || 0;
  tokenStats.cost.outputCost += cost.outputCost || 0;
  tokenStats.cost.totalCost += cost.totalCost || 0;
}
