import { describe, it, expect } from "vitest";
import { DeterministicClient } from "./deterministicClient.js";
import type { PromptConfig } from "./llmClient.js";

const baseConfig: PromptConfig = {
  messages: [],
};

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

  it("throws when tool call mock is missing args", async () => {
    const client = new DeterministicClient([
      { toolCall: { name: "add" } },
    ]);
    await expect(client.text(baseConfig)).rejects.toThrow(
      "missing args"
    );
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
