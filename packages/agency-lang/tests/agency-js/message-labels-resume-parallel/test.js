import {
  main,
  hasInterrupts,
  approve,
  respondToInterrupts,
  __setLLMClient,
} from "./agent.js";
import { readFileSync, writeFileSync, unlinkSync } from "fs";
import { ToolCall } from "smoltalk";

// Labels must survive interrupt/resume through the PARALLEL tool path.
//
// runPrompt bails out mid-tool-loop and snapshots the thread into
// `self.messagesJSON`; resume revives it via MessageThread.fromJSON.
// Snapshotting only `toJSON().messages` would revive through fromJSON's
// legacy (bare-array) branch, which has no labels to read — so every
// label would be gone after resume, and the promptCompletion logged by
// the post-resume round would be silently unlabeled.
//
// This asserts on the LAST promptCompletion (the round after resume),
// so it reads the labels as they exist on the far side of the round-trip.

const USAGE = { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, totalTokens: 2 };
const COST = { inputCost: 0, outputCost: 0, totalCost: 0, currency: "USD" };

let callIndex = 0;
const client = {
  async text() {
    const idx = callIndex++;
    if (idx === 0) {
      return {
        success: true,
        value: {
          output: null,
          toolCalls: [new ToolCall("call-ok", "okTool", {}), new ToolCall("call-ask", "askTool", {})],
          model: "test",
          usage: USAGE,
          cost: COST,
        },
      };
    }
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

const initial = await main();
if (!hasInterrupts(initial.data)) {
  throw new Error(`Expected an interrupt from askTool, got: ${JSON.stringify(initial.data)}`);
}
const final = await respondToInterrupts(initial.data, [approve()]);

const events = readFileSync("statelog.log", "utf-8")
  .split("\n")
  .filter((l) => l.trim() !== "")
  .map((l) => JSON.parse(l));

const completions = events.filter((e) => e.data?.type === "promptCompletion");
// The round AFTER resume — the one that had to survive the round-trip.
const afterResume = completions[completions.length - 1];

const labeled = (afterResume?.data?.messages ?? [])
  .map((m) => ({
    content: typeof m.content === "string" ? m.content : null,
    label: m.label ?? null,
  }))
  .filter((m) => m.label !== null);

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      finalData: final.data,
      promptCompletionCount: completions.length,
      labeledAfterResume: labeled,
    },
    null,
    2,
  ),
);
