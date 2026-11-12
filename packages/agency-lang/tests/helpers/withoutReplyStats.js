// A real model reports different token counts and costs on every run, and a
// reasoning model's `reasoning` record holds encrypted text that also changes
// every run, so a test that compares messages from one exactly must drop them.
// Returns a copy; the value passed in is not changed.
export function withoutReplyStats(value) {
  return JSON.parse(JSON.stringify(value), (key, v) => {
    if (v !== null && typeof v === "object" && v.role === "assistant") {
      const { usage, cost, reasoning, ...rest } = v;
      return rest;
    }
    return v;
  });
}
