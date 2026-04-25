import { describe, it, expect } from "vitest";
import { SimpleOpenAIClient } from "./simpleOpenAIClient.js";

describe("SimpleOpenAIClient", () => {
  it("should throw if no API key is available", () => {
    const origKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      expect(() => new SimpleOpenAIClient()).toThrow("OPENAI_API_KEY not found");
    } finally {
      if (origKey) process.env.OPENAI_API_KEY = origKey;
    }
  });

  it("should create a client with a provided API key", () => {
    const client = new SimpleOpenAIClient({ apiKey: "test-key" });
    expect(typeof client.text).toBe("function");
    expect(typeof client.textStream).toBe("function");
  });

  it("should accept a custom model", () => {
    const client = new SimpleOpenAIClient({ apiKey: "test-key", model: "gpt-4o" });
    expect(client).toBeDefined();
  });
});
