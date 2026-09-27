// A real model reports different token counts and costs on every run, so a
// test that compares messages from one exactly must drop them first.
// Returns a copy; the value passed in is not changed.
export function withoutReplyStats(value) {
  return JSON.parse(JSON.stringify(value), (key, v) => {
    if (v !== null && typeof v === "object" && v.role === "assistant") {
      const { usage, cost, ...rest } = v;
      return rest;
    }
    return v;
  });
}
