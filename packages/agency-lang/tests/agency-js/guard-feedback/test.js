import { main, __setLLMClient } from "./agent.js";
import { readFileSync, writeFileSync, unlinkSync } from "fs";

// approve({message}) feedback delivery (resumable guards PR 4). The
// program (see agent.agency) produces three approvals with messages:
// "clock" from a step-boundary time trip in plain code, then "inner"
// and "outer" from nested cost guards tripping together after the
// first llm() call's charge.
//
// Assertions, all from statelog promptCompletion payloads (the REQUEST
// message array as sent, with per-message labels):
//   - request 1 carries the "clock" message BEFORE the "first" prompt:
//     feedback queued outside any LLM loop waits for the branch's next
//     llm() call, and reviews past work so it precedes the new prompt.
//   - request 2 carries "inner" and "outer" as ONE newline-joined user
//     message (a drain must not emit consecutive user messages), in
//     ask order (the gate asks innermost-first), after round 1's
//     exchange and before "second" — labeled with BOTH guards.
//   - every injected message is user-role and wears its guard label.
//   - no `label` key ever reaches the provider config.

const USAGE = { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, totalTokens: 2 };
// Non-zero cost is load-bearing: each call charges $0.000002, which is
// what trips the $0.000001/$0.0000015 nested guards after call 1.
const COST = { inputCost: 0.000001, outputCost: 0.000001, totalCost: 0.000002, currency: "USD" };

const seenConfigs = [];
const client = {
  async text(config) {
    seenConfigs.push(config);
    return {
      success: true,
      value: { output: "answer", toolCalls: [], model: "test", usage: USAGE, cost: COST },
    };
  },
  async *textStream(config) {
    const r = await this.text(config);
    if (r.success) yield { type: "done", result: r.value };
    else yield { type: "error", error: r.error };
  },
  async embed() {
    return { success: false, error: "embed not implemented" };
  },
};

__setLLMClient(client);

try {
  unlinkSync("statelog.log");
} catch {
  // ignore ENOENT
}

const result = await main();

const events = readFileSync("statelog.log", "utf-8")
  .split("\n")
  .filter((l) => l.trim() !== "")
  .map((l) => JSON.parse(l));

// One promptCompletion per request, in request order.
const requests = events
  .filter((e) => e.data?.type === "promptCompletion")
  .map((e) =>
    (e.data?.messages ?? []).map((m) => ({
      role: m.role,
      content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      label: m.label ?? null,
    })),
  );

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      returnValue: result?.data ?? result,
      requests,
      labelReachedProvider: seenConfigs.some((c) => "label" in c),
    },
    null,
    2,
  ),
);
