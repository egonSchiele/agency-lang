import { describe, it, expect } from "vitest";
import { agencyStore } from "./asyncContext.js";
import { DeterministicClient } from "./deterministicClient.js";
import type { PromptConfig } from "./llmClient.js";

const baseConfig: PromptConfig = {
  messages: [],
};

/** Runs `fn` inside a minimal ALS frame whose callsite names `moduleId`,
 *  mimicking what `Runner.runInScope` seeds for a step body. */
function inModule<T>(moduleId: string, fn: () => T): T {
  return agencyStore.run(
    {
      ctx: {} as any,
      stack: {} as any,
      threads: {} as any,
      globals: {} as any,
      callsite: { moduleId, scopeName: "main", stepPath: "" },
    },
    fn,
  );
}

describe("DeterministicClient", () => {
  it("returns a return mock as output", async () => {
    const client = new DeterministicClient([{ return: "hello" }]);
    const result = await client.text(baseConfig);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.output).toBe("hello");
      expect(result.value.toolCalls).toEqual([]);
      expect(result.value.model).toBe("deterministic");
    }
  });

  it("returns an object return mock as JSON string", async () => {
    const client = new DeterministicClient([
      { return: { category: "reminder" } },
    ]);
    const result = await client.text(baseConfig);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.output).toBe('{"category":"reminder"}');
    }
  });

  it("returns a tool call mock", async () => {
    const client = new DeterministicClient([
      { toolCall: { name: "add", args: { a: 5, b: 3 } } },
    ]);
    const result = await client.text(baseConfig);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.output).toBeNull();
      expect(result.value.toolCalls).toHaveLength(1);
      expect(result.value.toolCalls[0].name).toBe("add");
      expect(result.value.toolCalls[0].arguments).toEqual({ a: 5, b: 3 });
    }
  });

  it("consumes mocks in order", async () => {
    const client = new DeterministicClient([
      { return: "first" },
      { return: "second" },
    ]);
    const r1 = await client.text(baseConfig);
    const r2 = await client.text(baseConfig);
    expect(r1.success && r1.value.output).toBe("first");
    expect(r2.success && r2.value.output).toBe("second");
  });

  it("throws when mocks are exhausted", async () => {
    const client = new DeterministicClient([{ return: "only one" }]);
    await client.text(baseConfig);
    await expect(client.text(baseConfig)).rejects.toThrow(
      "no mock provided for llm() call #2"
    );
  });

  it("throws when no mocks provided and llm() is called", async () => {
    const client = new DeterministicClient([]);
    await expect(client.text(baseConfig)).rejects.toThrow(
      "no mock provided for llm() call #1"
    );
  });

  it("defaults missing tool call args to an empty object", async () => {
    // Args are optional in the mock so callers don't have to write
    // `args: {}` for tools that take no arguments. See `deterministicClient.ts`.
    const client = new DeterministicClient([
      { toolCall: { name: "add" } },
    ]);
    const result = await client.text(baseConfig);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.toolCalls).toHaveLength(1);
      expect(result.value.toolCalls[0].name).toBe("add");
      expect(result.value.toolCalls[0].arguments).toEqual({});
    }
  });

  it("textStream yields a single done chunk", async () => {
    const client = new DeterministicClient([{ return: "streamed" }]);
    const chunks = [];
    for await (const chunk of client.textStream(baseConfig)) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(1);
    expect(chunks[0].type).toBe("done");
  });
});

describe("DeterministicClient scoped mocks", () => {
  it("selects the queue matching the executing module id exactly", async () => {
    const client = new DeterministicClient({
      "lib/agents/optimize/mutatePrompt.agency": [{ return: "from mutator queue" }],
      "*": [{ return: "from fallback" }],
    });

    const result = await inModule("lib/agents/optimize/mutatePrompt.agency", () => client.text(baseConfig));

    expect(result.success && result.value.output).toBe("from mutator queue");
  });

  it("selects the queue matching the module basename", async () => {
    const client = new DeterministicClient({
      mutatePrompt: [{ return: "from mutator queue" }],
      "*": [{ return: "from fallback" }],
    });

    const result = await inModule("lib/agents/optimize/mutatePrompt.agency", () => client.text(baseConfig));

    expect(result.success && result.value.output).toBe("from mutator queue");
  });

  it("falls back to the * queue when no scope matches", async () => {
    const client = new DeterministicClient({
      mutatePrompt: [{ return: "from mutator queue" }],
      "*": [{ return: "from fallback" }],
    });

    const result = await inModule("agents/taskAgent.agency", () => client.text(baseConfig));

    expect(result.success && result.value.output).toBe("from fallback");
  });

  it("falls back to the * queue outside any execution frame", async () => {
    const client = new DeterministicClient({ "*": [{ return: "from fallback" }] });

    const result = await client.text(baseConfig);

    expect(result.success && result.value.output).toBe("from fallback");
  });

  it("consumes each scope's queue independently of interleaving", async () => {
    const client = new DeterministicClient({
      mutatePrompt: [{ return: "m1" }, { return: "m2" }],
      judgePairwise: [{ return: "j1" }, { return: "j2" }],
    });

    const m1 = await inModule("lib/agents/optimize/mutatePrompt.agency", () => client.text(baseConfig));
    const j1 = await inModule("lib/agents/eval/judgePairwise.agency", () => client.text(baseConfig));
    const m2 = await inModule("lib/agents/optimize/mutatePrompt.agency", () => client.text(baseConfig));
    const j2 = await inModule("lib/agents/eval/judgePairwise.agency", () => client.text(baseConfig));

    expect(m1.success && m1.value.output).toBe("m1");
    expect(j1.success && j1.value.output).toBe("j1");
    expect(m2.success && m2.value.output).toBe("m2");
    expect(j2.success && j2.value.output).toBe("j2");
  });

  it("names the scope when its queue is exhausted", async () => {
    const client = new DeterministicClient({ mutatePrompt: [{ return: "only" }] });

    await inModule("lib/agents/optimize/mutatePrompt.agency", () => client.text(baseConfig));

    await expect(
      inModule("lib/agents/optimize/mutatePrompt.agency", () => client.text(baseConfig)),
    ).rejects.toThrow(/call #2.*"mutatePrompt"/);
  });

  it("lists available scopes when nothing matches and there is no fallback", async () => {
    const client = new DeterministicClient({ mutatePrompt: [{ return: "only" }] });

    await expect(
      inModule("agents/taskAgent.agency", () => client.text(baseConfig)),
    ).rejects.toThrow(/no llmMocks queue.*taskAgent.*mutatePrompt/s);
  });

  it("does not treat user-controlled scope keys as prototype properties", async () => {
    // "__proto__" must behave as an ordinary queue key (no prototype
    // mutation), and unmatched modules must not falsely resolve against
    // inherited Object.prototype names like "constructor".
    const client = new DeterministicClient(
      JSON.parse('{"__proto__": [{"return": "proto queue"}]}'),
    );

    const result = await inModule("agents/__proto__.agency", () => client.text(baseConfig));
    expect(result.success && result.value.output).toBe("proto queue");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    await expect(
      inModule("agents/constructor.agency", () => client.text(baseConfig)),
    ).rejects.toThrow(/no llmMocks queue/);
  });
});
