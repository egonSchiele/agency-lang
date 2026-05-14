import * as smoltalk from "smoltalk";
import type { SmolConfig } from "smoltalk";
import type { LLMClient } from "../llmClient.js";
import type { LlmClient as MemoryLlmClient } from "./manager.js";

type AdapterDeps = {
  llmClient: LLMClient;
  smoltalkDefaults: Partial<SmolConfig>;
};

/**
 * Adapt the runtime LLMClient to the minimal interface the MemoryManager
 * depends on.
 *
 * Embedding calls go through `deps.llmClient.embed` rather than calling
 * `smoltalk.embed` directly, so anyone who registers a custom client via
 * `setLLMClient()` (including the deterministic test client) controls
 * the embedding path too. Failures bubble up as plain Errors so the
 * MemoryManager's `try/catch` can silently no-op Tier 2.
 */
export function createMemoryLlmAdapter(deps: AdapterDeps): MemoryLlmClient {
  return {
    async text(
      prompt: string,
      options?: { model?: string }
    ): Promise<string> {
      const config = {
        ...deps.smoltalkDefaults,
        messages: [smoltalk.userMessage(prompt)],
        model: options?.model ?? deps.smoltalkDefaults.model,
      };
      const result = await deps.llmClient.text(config as any);
      if (!result.success) {
        throw new Error(`memory llm text call failed: ${result.error}`);
      }
      return result.value.output ?? "";
    },

    async embed(
      text: string,
      options?: { model?: string }
    ): Promise<number[]> {
      // Never fall back to `smoltalkDefaults.model` here: that's the chat
      // model (e.g. gpt-4o-mini), which embed providers will reject.
      // SmoltalkClient.embed already supplies a sensible default if no
      // model is passed.
      const result = await deps.llmClient.embed(text, {
        model: options?.model,
        apiKey: (deps.smoltalkDefaults as any).openAiApiKey,
      });
      if (!result.success) {
        throw new Error(`memory embed call failed: ${result.error}`);
      }
      const vector = result.value.embeddings[0];
      if (!vector) {
        throw new Error("memory embed returned no vectors");
      }
      return vector;
    },
  };
}
