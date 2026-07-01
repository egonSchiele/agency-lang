import {
  main,
  hasInterrupts,
  approve,
  respondToInterrupts,
  __setLLMClient,
} from "./agent.js";
import { writeFileSync } from "fs";
import { ToolCall } from "smoltalk";

// Interrupt/resume regression for id-less tool calls (e.g. Google Gemini,
// whose function-calling protocol returns NO tool-call id — smoltalk
// defaults the missing id to ""). A single parallel-tool round has one
// tool succeed and a sibling interrupt. This exercises BOTH halves of the
// id-less fix in prompt.ts:
//
//   1. Branch key: `tool_${index}_${id}` — without the index, both id-less
//      branches key on "tool_" and runBatch throws `duplicate child key`,
//      so `main()` would never surface interrupts at all.
//
//   2. Per-tool resume step paths (`completedSteps`): keyed by the same
//      index-based slug. If they instead collided on the empty id,
//      succeedTool completing on the FIRST pass would mark the shared
//      `round.0.tool..invoke` step done, so on RESUME interruptTool's
//      invoke step is skipped — interruptTool never returns and its
//      tool_response is dropped. The post-resume LLM call would then see
//      only ONE tool response instead of two.
//
// The assertion that the SECOND (post-resume) llm call carries exactly two
// tool responses — one per tool, each invoked exactly once — is what pins
// down the step-path half of the fix.

const captured = [];
let callIndex = 0;

const SYNTHETIC_USAGE = {
  inputTokens: 1,
  outputTokens: 1,
  cachedInputTokens: 0,
  totalTokens: 2,
};
const SYNTHETIC_COST = {
  inputCost: 0,
  outputCost: 0,
  totalCost: 0,
  currency: "USD",
};

const captureClient = {
  async text(config) {
    captured.push({
      messages: config.messages.map((m) => {
        const json = typeof m.toJSON === "function" ? m.toJSON() : m;
        return {
          role: json.role,
          tool_call_id: json.tool_call_id ?? null,
          content: json.content ?? null,
        };
      }),
    });
    const idx = callIndex++;
    if (idx === 0) {
      // First call: two parallel tool calls, BOTH with an empty id — the
      // exact shape smoltalk produces for a Gemini parallel-tool round.
      return {
        success: true,
        value: {
          output: null,
          toolCalls: [
            new ToolCall("", "succeedTool", {}),
            new ToolCall("", "interruptTool", {}),
          ],
          model: "test",
          usage: SYNTHETIC_USAGE,
          cost: SYNTHETIC_COST,
        },
      };
    }
    // After both tool responses are pushed back, wrap up.
    return {
      success: true,
      value: {
        output: "all done",
        toolCalls: [],
        model: "test",
        usage: SYNTHETIC_USAGE,
        cost: SYNTHETIC_COST,
      },
    };
  },
  async *textStream(config) {
    const result = await this.text(config);
    if (result.success) {
      yield { type: "done", result: result.value };
    } else {
      yield { type: "error", error: result.error };
    }
  },
  async embed() {
    return { success: false, error: "captureClient does not implement embed" };
  },
};

__setLLMClient(captureClient);

const initial = await main();
if (!hasInterrupts(initial.data)) {
  // Would trip if the id-less branch keys collided (runBatch crash) — the
  // round never runs, so interruptTool never interrupts.
  throw new Error(
    `Expected interrupts from interruptTool, got: ${JSON.stringify(initial.data)}`,
  );
}

const final = await respondToInterrupts(initial.data, [approve()]);

// The post-resume llm call must carry BOTH tool responses, each exactly
// once. Sorting by content makes the fixture stable regardless of branch
// completion order.
const secondCall = captured[captured.length - 1];
const toolContents = secondCall.messages
  .filter((m) => m.role === "tool")
  .map((m) => m.content)
  .sort();

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      finalData: final.data,
      llmCallCount: captured.length,
      toolResponseContents: toolContents,
    },
    null,
    2,
  ),
);
