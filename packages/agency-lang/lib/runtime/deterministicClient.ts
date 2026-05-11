import type { PromptResult, StreamChunk, Result } from "smoltalk";
import type { LLMClient, PromptConfig } from "./llmClient.js";

export type ReturnMock = {
  return: any;
};

export type ToolCallMock = {
  toolCall: {
    name: string;
    args?: Record<string, any>;
  };
};

export type LLMMock = ReturnMock | ToolCallMock;

export class DeterministicClient implements LLMClient {
  private mocks: LLMMock[];
  private callIndex = 0;

  constructor(mocks: LLMMock[]) {
    this.mocks = mocks;
  }

  async text(_config: PromptConfig): Promise<Result<PromptResult>> {
    // NOTE: increment-then-check is intentional. callIndex tracks the
    // 1-based index of the *current* call so error messages say
    // "call #N" where N matches what a user would expect when reading
    // their llmMocks list (call #1 = first mock, call #2 = second, ...).
    this.callIndex++;
    if (this.callIndex > this.mocks.length) {
      throw new Error(
        `DeterministicClient: no mock provided for llm() call #${this.callIndex}. Add an entry to llmMocks in your test.json.`
      );
    }

    const mock = this.mocks[this.callIndex - 1];

    if ("return" in mock) {
      const output =
        typeof mock.return === "string"
          ? mock.return
          : JSON.stringify(mock.return);
      return {
        success: true,
        value: {
          output,
          toolCalls: [],
          model: "deterministic",
        },
      };
    }

    // Tool call mock
    const { name, args } = mock.toolCall;
    if (!args) {
      throw new Error(
        `DeterministicClient: tool call mock for '${name}' is missing args.`
      );
    }
    return {
      success: true,
      value: {
        output: null,
        toolCalls: [{ id: `mock-tool-${this.callIndex}`, name, arguments: args }],
        model: "deterministic",
      },
    };
  }

  // TODO: textStream emits only a single "done" chunk and skips the
  // intermediate "text" / "tool_call" / "thinking" chunks that the
  // real client produces. Tests that assert on streaming progress
  // events will not see them. This is intentional for the current
  // CI use case (turning off the network in tests), but if a future
  // test needs streaming fidelity, extend the mock schema (e.g.
  // `{ stream: [{ type: "text", text: "..." }, ...] }`) and emit
  // those chunks here before the final "done".
  async *textStream(config: PromptConfig): AsyncGenerator<StreamChunk> {
    const result = await this.text(config);
    if (result.success) {
      yield { type: "done", result: result.value };
    } else {
      yield { type: "error", error: result.error };
    }
  }
}
