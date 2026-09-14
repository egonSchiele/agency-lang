import { describe, it, expect } from "vitest";
import { _embedTexts, _cosineSimilarity } from "./embedding.js";
import { agencyStore } from "../runtime/asyncContext.js";
import { StateStack } from "../runtime/state/stateStack.js";
import { CostGuard } from "../runtime/guard.js";
import { InvocationUsageMeter } from "../runtime/invocationUsage.js";
import type { EmbedConfig, EmbedResult } from "../runtime/llmClient.js";
import type { Result } from "smoltalk";

const FAKE_COST = 0.002;

type Call = { input: string | string[]; config: Partial<EmbedConfig> | undefined };

/** A client whose embed() returns one fixed vector per input and records
 *  what it was asked, so tests can assert on the forwarded config. */
function fakeClient(
  respond: (inputs: string[]) => Result<EmbedResult> = (inputs) => ({
    success: true,
    value: {
      embeddings: inputs.map((t) => [t.length, 1, 0]),
      model: "fake-embed",
      tokenUsage: { inputTokens: 3, outputTokens: 0, totalTokens: 3 },
      costEstimate: { inputCost: FAKE_COST, outputCost: 0, totalCost: FAKE_COST, currency: "USD" },
    },
  }),
) {
  const calls: Call[] = [];
  const client = {
    async embed(input: string | string[], config?: Partial<EmbedConfig>) {
      calls.push({ input, config });
      return respond(Array.isArray(input) ? input : [input]);
    },
  };
  return { client, calls };
}

function frame(stack: StateStack, client: unknown, events: unknown[] = []) {
  return {
    ctx: {
      llmClient: client,
      statelogClient: { embedCompletion: (e: unknown) => events.push(e) },
      invocationUsage: new InvocationUsageMeter(),
    },
    stack,
    threads: {},
    globals: {},
    callsite: { moduleId: "t", scopeName: "main", stepPath: "" },
  } as any;
}

describe("_embedTexts", () => {
  it("returns one vector per input and bills the branch", async () => {
    const stack = new StateStack();
    const { client } = fakeClient();
    const events: unknown[] = [];
    const r = await agencyStore.run(frame(stack, client, events), () =>
      _embedTexts(["ab", "abcd"], "", "", 0, "", ""),
    );
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.value).toEqual({
        vectors: [
          [2, 1, 0],
          [4, 1, 0],
        ],
        model: "fake-embed",
      });
    }
    expect(stack.localCost).toBeCloseTo(FAKE_COST);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ inputCount: 2, dimensions: 3, phase: "std::embedding" });
  });

  it("forwards only the options the caller set", async () => {
    const stack = new StateStack();
    const { client, calls } = fakeClient();
    await agencyStore.run(frame(stack, client), () =>
      _embedTexts(["x"], "", "ollama", 0, "", "http://localhost:11434"),
    );
    expect(calls[0].config).toEqual({
      provider: "ollama",
      baseUrl: {
        ollama: "http://localhost:11434",
        mlx: "http://localhost:11434",
        deepInfra: "http://localhost:11434",
        liteLlm: "http://localhost:11434",
        openAiCompat: "http://localhost:11434",
      },
    });
  });

  it("forwards model and dimensions when set", async () => {
    const stack = new StateStack();
    const { client, calls } = fakeClient();
    await agencyStore.run(frame(stack, client), () =>
      _embedTexts(["x"], "text-embedding-3-large", "", 256, "", ""),
    );
    expect(calls[0].config).toEqual({ model: "text-embedding-3-large", dimensions: 256 });
  });

  it("refuses an empty list and a blank input before dispatch", async () => {
    const stack = new StateStack();
    const { client, calls } = fakeClient();
    const none = await agencyStore.run(frame(stack, client), () =>
      _embedTexts([], "", "", 0, "", ""),
    );
    const blank = await agencyStore.run(frame(stack, client), () =>
      _embedTexts(["ok", "   "], "", "", 0, "", ""),
    );
    expect(none.success).toBe(false);
    expect(blank.success).toBe(false);
    if (!blank.success) expect(blank.error).toContain("input 1");
    expect(calls).toHaveLength(0);
    expect(stack.localCost).toBe(0);
  });

  it("passes a provider failure through without billing", async () => {
    const stack = new StateStack();
    const { client } = fakeClient(() => ({ success: false, error: "no key" }));
    const r = await agencyStore.run(frame(stack, client), () =>
      _embedTexts(["x"], "", "", 0, "", ""),
    );
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toBe("Embedding failed: no key");
    expect(stack.localCost).toBe(0);
  });

  it("bills a short response and then reports the count mismatch", async () => {
    const stack = new StateStack();
    const { client } = fakeClient(() => ({
      success: true,
      value: {
        embeddings: [[1, 0]],
        model: "fake-embed",
        costEstimate: {
          inputCost: FAKE_COST,
          outputCost: 0,
          totalCost: FAKE_COST,
          currency: "USD",
        },
      },
    }));
    const r = await agencyStore.run(frame(stack, client), () =>
      _embedTexts(["a", "b"], "", "", 0, "", ""),
    );
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toContain("1 vectors for 2 inputs");
    expect(stack.localCost).toBeCloseTo(FAKE_COST);
  });

  it("counts input tokens toward the branch total when the provider sends no total", async () => {
    const stack = new StateStack();
    const { client } = fakeClient((inputs) => ({
      success: true,
      value: {
        embeddings: inputs.map(() => [1, 0]),
        model: "local-embed",
        tokenUsage: { inputTokens: 7, outputTokens: 0 },
        costEstimate: { inputCost: 0, outputCost: 0, totalCost: 0, currency: "USD" },
      },
    }));
    await agencyStore.run(frame(stack, client), () => _embedTexts(["x"], "", "", 0, "", ""));
    expect(stack.localTokens).toBe(7);
  });

  it("trips a guard tighter than the embedding cost", async () => {
    const stack = new StateStack();
    stack.guards.push(new CostGuard(FAKE_COST / 2));
    const { client } = fakeClient();
    await agencyStore.run(frame(stack, client), async () => {
      await expect(_embedTexts(["x"], "", "", 0, "", "")).rejects.toBeTruthy();
    });
  });
});

describe("_cosineSimilarity", () => {
  it("scores identical, orthogonal, and opposite vectors", () => {
    const same = _cosineSimilarity([1, 2, 3], [2, 4, 6]);
    const orthogonal = _cosineSimilarity([1, 0], [0, 1]);
    const opposite = _cosineSimilarity([1, 0], [-1, 0]);
    expect(same.success && same.value).toBeCloseTo(1);
    expect(orthogonal.success && orthogonal.value).toBeCloseTo(0);
    expect(opposite.success && opposite.value).toBeCloseTo(-1);
  });

  it("fails on mismatched lengths, empty, and all-zero vectors", () => {
    expect(_cosineSimilarity([1, 2], [1]).success).toBe(false);
    expect(_cosineSimilarity([], []).success).toBe(false);
    expect(_cosineSimilarity([0, 0], [1, 1]).success).toBe(false);
  });
});
