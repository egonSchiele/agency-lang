import { main, __setLLMClient } from "./agent.js";
import { writeFileSync } from "fs";
import { ToolCall } from "smoltalk";

// The LLM calls an interrupting tool 12 times in ONE round (> the
// MAX_HANDLER_CHAIN_DEPTH of 10). Each call's interrupt is resolved by the
// surrounding `with approve` handler, and all 12 handler dispatches run
// concurrently through the shared runtime context. The recursion guard must
// treat that as breadth, not depth.
//
// Asserting on the final answer alone is NOT enough: a failing tool becomes a
// Failure value, and the mocked LLM's final turn would still say "all read".
// So we capture the tool-response messages the runtime feeds back on the
// SECOND llm call and require all 12 to be the successful file names. Before
// the fix, each tool threw `HandlerRecursionError` (surfaced as a Failure in
// its tool response) and this check fails.

const N = 12;
const USAGE = { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, totalTokens: 2 };
const COST = { inputCost: 0, outputCost: 0, totalCost: 0, currency: "USD" };

let toolResponses = [];
let callIndex = 0;

const captureClient = {
  async text(config) {
    const idx = callIndex++;
    if (idx === 0) {
      return {
        success: true,
        value: {
          output: null,
          toolCalls: Array.from(
            { length: N },
            (_, i) => new ToolCall(`call-${i}`, "readFile", { name: `f${i}` }),
          ),
          model: "test",
          usage: USAGE,
          cost: COST,
        },
      };
    }
    // Second call: record every tool response the runtime pushed back.
    toolResponses = config.messages
      .map((m) => (typeof m.toJSON === "function" ? m.toJSON() : m))
      .filter((m) => m.role === "tool")
      .map((m) => m.content)
      .sort();
    return {
      success: true,
      value: {
        output: "all read",
        toolCalls: [],
        model: "test",
        usage: USAGE,
        cost: COST,
      },
    };
  },
  async *textStream(config) {
    const result = await this.text(config);
    if (result.success) yield { type: "done", result: result.value };
    else yield { type: "error", error: result.error };
  },
  async embed() {
    return { success: false, error: "captureClient does not implement embed" };
  },
};

__setLLMClient(captureClient);

const result = await main();

writeFileSync(
  "__result.json",
  JSON.stringify({ data: result.data, toolResponses }, null, 2),
);
