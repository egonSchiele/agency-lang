import {
  main,
  hasInterrupts,
  approve,
  respondToInterrupts,
  __setLLMClient,
} from "./agent.js";
import { writeFileSync } from "fs";
import { ToolCall } from "smoltalk";

// Regression test for the messagesJSON-snapshot ordering bug surfaced
// in PR #186 (runBatch primitive migration).
//
// Bug: when a parallel-tool round had one tool succeed (pushing its
// tool_response to the message thread) AND a sibling tool interrupt,
// PromptRunner.parallel used to snapshot self.messagesJSON BEFORE
// stamping the bailout checkpoint. The runBatch migration inverted that
// — runBatch stamps the shared checkpoint internally, then parallel()
// assigns messagesJSON AFTER runBatch returns. Because
// `ctx.checkpoints.create` does a synchronous `stateStack.toJSON()`
// snapshot at call time (see checkpointStore.ts), the captured
// checkpoint contains the STALE messagesJSON from the previous
// _runPrompt — i.e. missing every successful sibling tool's
// tool_response.
//
// On resume the messages thread is restored from this stale snapshot
// (prompt.ts line 314), and because the successful sibling's branch is
// already marked done in completedSteps, its `messages.push(...)` body
// is skipped — so the tool_response is never re-added. The next
// _runPrompt then sees an assistant message with N tool_calls but only
// M < N matching tool messages. Real OpenAI/Anthropic APIs reject
// this; the deterministic mock used in unit/agency-js tests silently
// accepts it, which is why this bug never surfaced.
//
// This test wires up a custom LLM client that records every text()
// call's messages array, then asserts that the SECOND llm call (after
// resume) contains BOTH tool responses — succeedTool's and
// interruptTool's. With the bug, the test would observe only 1.

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
    // Capture the role + tool_call_id of every message sent to this
    // call so the assertions below can count tool responses.
    captured.push({
      callIndex,
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
      // First call: ask the (mocked) LLM to call BOTH tools in parallel.
      return {
        success: true,
        value: {
          output: null,
          toolCalls: [
            new ToolCall("call-succeed", "succeedTool", {}),
            new ToolCall("call-interrupt", "interruptTool", {}),
          ],
          model: "test",
          usage: SYNTHETIC_USAGE,
          cost: SYNTHETIC_COST,
        },
      };
    }
    // Subsequent calls: return a plain string. The runtime expects this
    // call to come AFTER both tool responses have been pushed back.
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
    return {
      success: false,
      error: "captureClient does not implement embed",
    };
  },
};

__setLLMClient(captureClient);

const initial = await main();
if (!hasInterrupts(initial.data)) {
  throw new Error(
    `Expected interrupts from interruptTool, got: ${JSON.stringify(initial.data)}`,
  );
}

const final = await respondToInterrupts(initial.data, [approve()]);

// We expect exactly TWO LLM calls total: the first that produces the
// parallel tool calls, and the second (after resume) that consumes
// both tool responses and returns "all done".
const secondCall = captured[captured.length - 1];
const toolMsgs = secondCall.messages.filter((m) => m.role === "tool");
const toolCallIds = toolMsgs.map((m) => m.tool_call_id).sort();

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      finalData: final.data,
      llmCallCount: captured.length,
      secondCallToolResponseCount: toolMsgs.length,
      toolCallIds,
    },
    null,
    2,
  ),
);
