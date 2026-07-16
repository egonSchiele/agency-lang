import { main, __setLLMClient } from "./agent.js";
import { readFileSync, writeFileSync, unlinkSync } from "fs";

// Debug labels are observability-only: they ride the thread and surface
// in statelog, and never reach the provider. This pins both halves.
//
// The program pushes an UNLABELED system message first, then a "seed"
// user message, then a "coder"-labeled llm() call. Assertions check
// label-to-message PAIRING, not mere presence — a shifted array would
// still contain both labels while attaching them to the wrong messages.
//
// promptCompletion logs the REQUEST payload, so its message array holds
// sys + context + go, but NOT this round's assistant reply (pushed after
// the event is emitted).

const USAGE = { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, totalTokens: 2 };
const COST = { inputCost: 0, outputCost: 0, totalCost: 0, currency: "USD" };

// Records the config the provider is handed, so a leaked `label` shows up.
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

await main();

const events = readFileSync("statelog.log", "utf-8")
  .split("\n")
  .filter((l) => l.trim() !== "")
  .map((l) => JSON.parse(l));

const promptStart = events.find((e) => e.data?.type === "promptStart");
const promptCompletion = events.find((e) => e.data?.type === "promptCompletion");

// The message array as logged, reduced to (content, label) pairs.
const logged = (promptCompletion?.data?.messages ?? []).map((m) => ({
  content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
  label: m.label ?? null,
}));

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      promptStartLabel: promptStart?.data?.label ?? null,
      loggedMessages: logged,
      labelReachedProvider: seenConfigs.some((c) => "label" in c),
    },
    null,
    2,
  ),
);
