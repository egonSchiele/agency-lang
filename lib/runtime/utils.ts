import { color } from "termcolors";

export function deepClone(obj: any): any {
  return JSON.parse(JSON.stringify(obj));
}

export function extractResponse(rawValue: any, schema: any): any {
  // 1. Direct match — try parsing as-is
  const direct = schema.safeParse(rawValue);

  if (direct.success) {
    if ("response" in direct.data) {
      return direct.data.response;
    }
    return direct.data;
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

export function createReturnObject(args: {
  result: any;
  stateStack: any;
}): any {
  const { result, stateStack } = args;
  // Note: we're *not* using structuredClone here because structuredClone
  // doesn't call `toJSON`, so it's not cloning our message objects correctly.
  return JSON.parse(
    JSON.stringify({
      messages: result.messages,
      data: result.data,
      tokens: stateStack.globals.__tokenStats,
    }),
  );
}

export function updateTokenStats(args: {
  stateStack: any;
  usage: any;
  cost: any;
}): void {
  const { stateStack, usage, cost } = args;
  if (!usage || !cost) return;
  const tokenStats = stateStack.globals.__tokenStats;
  tokenStats.usage.inputTokens += usage.inputTokens || 0;
  tokenStats.usage.outputTokens += usage.outputTokens || 0;
  tokenStats.usage.cachedInputTokens += usage.cachedInputTokens || 0;
  tokenStats.usage.totalTokens += usage.totalTokens || 0;

  tokenStats.cost.inputCost += cost.inputCost || 0;
  tokenStats.cost.outputCost += cost.outputCost || 0;
  tokenStats.cost.totalCost += cost.totalCost || 0;
}
