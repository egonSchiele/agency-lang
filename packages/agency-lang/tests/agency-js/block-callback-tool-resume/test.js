import {
  main,
  hasInterrupts,
  approve,
  respondToInterrupts,
  __setLLMClient,
} from "./agent.js";
import { writeFileSync } from "fs";
import { ToolCall } from "smoltalk";

// Regression test for "Cannot read properties of undefined (reading
// 'getOrCreateBranch')" crash that fired in PromptRunner.parallel on
// the SECOND LLM round after an interrupt+resume cycle.
//
// Root cause: the block-callable codegen template
// (lib/templates/backends/typescriptGenerator/blockSetup.mustache)
// emitted `__ctx.stateStack.pop()` in its finally block, while the
// matching `setupFunction()` push targeted the ALS-current stack.
// When a block ran inside a parallel/fork/race branch (e.g. as part
// of an `onToolCallEnd` callback during runPrompt's tool dispatch),
// the ALS stack was the branch stack — distinct from
// `__ctx.stateStack`. Popping `__ctx.stateStack` corrupted the
// parent's frame chain, eventually leaving the runPrompt frame off
// the stack so the next round's `pr.parallel` couldn't find a
// `parentFrame`.
//
// This test wires up a 3-round LLM client (interrupt tool / noop tool
// / done) and a callback that uses block syntax to exercise the
// blockSetup path. Pre-fix, the second tool-dispatch round crashes.

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

const llmClient = {
  async text() {
    const idx = callIndex++;
    if (idx === 0) {
      return {
        success: true,
        value: {
          output: null,
          toolCalls: [new ToolCall("c1", "interruptTool", {})],
          model: "test",
          usage: SYNTHETIC_USAGE,
          cost: SYNTHETIC_COST,
        },
      };
    }
    if (idx === 1) {
      return {
        success: true,
        value: {
          output: null,
          toolCalls: [new ToolCall("c2", "noopTool", {})],
          model: "test",
          usage: SYNTHETIC_USAGE,
          cost: SYNTHETIC_COST,
        },
      };
    }
    return {
      success: true,
      value: {
        output: "done",
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
    return { success: false, error: "not supported" };
  },
};

__setLLMClient(llmClient);

const initial = await main();
if (!hasInterrupts(initial.data)) {
  throw new Error(
    `Expected interrupts from interruptTool, got: ${JSON.stringify(initial.data)}`,
  );
}

const final = await respondToInterrupts(initial.data, [approve()]);

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      finalData: final.data,
      llmCallCount: callIndex,
    },
    null,
    2,
  ),
);
