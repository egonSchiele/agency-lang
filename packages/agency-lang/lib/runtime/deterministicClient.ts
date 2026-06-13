import type { PromptResult, StreamChunk, Result } from "smoltalk";
import { ToolCall } from "smoltalk";
import { agencyStore } from "./asyncContext.js";
import type {
  EmbedConfig,
  EmbedResult,
  LLMClient,
  PromptConfig,
} from "./llmClient.js";

export type ReturnMock = {
  return: any;
};

export type ToolCallMock = {
  toolCall: {
    name: string;
    args?: Record<string, any>;
  };
};

/** Multi-tool variant: simulate the LLM returning multiple tool calls in
 *  one round (used to test concurrent tool execution in `runPrompt`). */
export type MultiToolCallMock = {
  toolCalls: Array<{ name: string; args?: Record<string, any> }>;
};

export type LLMMock = ReturnMock | ToolCallMock | MultiToolCallMock;

/**
 * Per-agent mock queues. Keys are matched against the executing module:
 * the exact module id ("lib/agents/mutatePrompt.agency"), then its
 * basename without the extension ("mutatePrompt"), then the "*" fallback
 * queue. Each queue is consumed in order, independently of the others,
 * so tests that span several agents (e.g. a full optimize iteration:
 * task agent + mutator + judge) don't have to predict the global
 * interleaving of llm() calls.
 */
export type ScopedLLMMocks = Record<string, LLMMock[]>;

const FALLBACK_SCOPE = "*";

// Synthetic non-zero usage/cost so tests that only assert "value is
// nonzero" still pass under the deterministic client. Tests that assert
// on exact token counts or precise costs are using a real LLM and won't
// hit this code path.
const SYNTHETIC_USAGE = {
  inputTokens: 1,
  outputTokens: 1,
  cachedInputTokens: 0,
  totalTokens: 2,
};
const SYNTHETIC_COST = {
  inputCost: 0.000001,
  outputCost: 0.000001,
  totalCost: 0.000002,
  currency: "USD",
};

type MockQueue = {
  mocks: LLMMock[];
  callIndex: number;
};

export class DeterministicClient implements LLMClient {
  private queues: Record<string, MockQueue>;
  /** Array form: one anonymous queue, original error messages. */
  private readonly scoped: boolean;

  constructor(mocks: LLMMock[] | ScopedLLMMocks) {
    this.scoped = !Array.isArray(mocks);
    this.queues = {};
    if (Array.isArray(mocks)) {
      this.queues[FALLBACK_SCOPE] = { mocks, callIndex: 0 };
    } else {
      for (const [scope, queueMocks] of Object.entries(mocks)) {
        this.queues[scope] = { mocks: queueMocks, callIndex: 0 };
      }
    }
  }

  /**
   * Picks the mock queue for the currently-executing module. The module
   * id comes from the ALS frame's callsite (seeded by `Runner.runInScope`
   * for every step body); outside any frame — or when no scope matches —
   * the "*" queue applies.
   */
  private resolveQueue(): { scope: string; queue: MockQueue } {
    if (!this.scoped) {
      return { scope: FALLBACK_SCOPE, queue: this.queues[FALLBACK_SCOPE] };
    }
    const moduleId = agencyStore.getStore()?.callsite?.moduleId;
    if (moduleId !== undefined) {
      if (this.queues[moduleId]) {
        return { scope: moduleId, queue: this.queues[moduleId] };
      }
      const basename = moduleId.split("/").pop()?.replace(/\.agency$/, "") ?? moduleId;
      if (this.queues[basename]) {
        return { scope: basename, queue: this.queues[basename] };
      }
    }
    if (this.queues[FALLBACK_SCOPE]) {
      return { scope: FALLBACK_SCOPE, queue: this.queues[FALLBACK_SCOPE] };
    }
    throw new Error(
      `DeterministicClient: no llmMocks queue matches module ${moduleId ?? "(no execution frame)"}. ` +
      `Available scopes: ${Object.keys(this.queues).join(", ")}. Add a "*" queue as a fallback.`
    );
  }

  async text(_config: PromptConfig): Promise<Result<PromptResult>> {
    const { scope, queue } = this.resolveQueue();
    // NOTE: increment-then-check is intentional. callIndex tracks the
    // 1-based index of the *current* call so error messages say
    // "call #N" where N matches what a user would expect when reading
    // their llmMocks list (call #1 = first mock, call #2 = second, ...).
    queue.callIndex++;
    if (queue.callIndex > queue.mocks.length) {
      const where = this.scoped ? ` in scope "${scope}"` : "";
      throw new Error(
        `DeterministicClient: no mock provided for llm() call #${queue.callIndex}${where}. Add an entry to llmMocks in your test.json.`
      );
    }

    const mock = queue.mocks[queue.callIndex - 1];
    const callIndex = queue.callIndex;

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
          usage: SYNTHETIC_USAGE,
          cost: SYNTHETIC_COST,
        },
      };
    }

    if ("toolCalls" in mock) {
      // `args` is typed optional in MultiToolCallMock; default to {} so
      // mocks for tools that take no arguments can omit it cleanly.
      const calls = mock.toolCalls.map(
        (tc, i) =>
          new ToolCall(`mock-tool-${callIndex}-${i}`, tc.name, tc.args ?? {}),
      );
      return {
        success: true,
        value: {
          output: null,
          toolCalls: calls,
          model: "deterministic",
          usage: SYNTHETIC_USAGE,
          cost: SYNTHETIC_COST,
        },
      };
    }

    // Single tool call mock — same args-default behavior as the
    // multi-tool branch above so callers don't have to write `args: {}`
    // for tools that take no arguments.
    const { name, args } = mock.toolCall;
    return {
      success: true,
      value: {
        output: null,
        toolCalls: [new ToolCall(`mock-tool-${callIndex}`, name, args ?? {})],
        model: "deterministic",
        usage: SYNTHETIC_USAGE,
        cost: SYNTHETIC_COST,
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

  // The deterministic client never makes network calls. Returning a
  // failure here lets the MemoryManager's best-effort try/catch silently
  // skip Tier 2 (vector) recall in tests rather than dialing a real
  // embedding provider when AGENCY_LLM_MOCKS is set. Tests that need to
  // exercise vector recall should register a custom client via
  // setLLMClient() with their own embed implementation.
  async embed(
    _input: string | string[],
    _config?: Partial<EmbedConfig>,
  ): Promise<Result<EmbedResult>> {
    return {
      success: false,
      error:
        "DeterministicClient does not implement embed. Register a client with embed() support via setLLMClient() if your test needs vector recall.",
    };
  }
}
