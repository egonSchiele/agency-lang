import * as smoltalk from "smoltalk";
import type { SmolConfig } from "smoltalk";
import type { LLMClient } from "../llmClient.js";
import type { LlmClient as MemoryLlmClient } from "./manager.js";

type AdapterDeps = {
  llmClient: LLMClient;
  smoltalkDefaults: Partial<SmolConfig>;
};

/**
 * Adapt the runtime LLMClient + smoltalk.embed to the minimal interface
 * the MemoryManager depends on.
 *
 * Failures from `embed` (no API key, network error, non-embedding provider)
 * are caught and rethrown as plain Errors so the MemoryManager's `try/catch`
 * can silently no-op Tier 2 (resolved decision #8).
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
      const model =
        options?.model ?? deps.smoltalkDefaults.model ?? "text-embedding-3-small";
      const result = await smoltalk.embed(text, {
        model,
        openAiApiKey: (deps.smoltalkDefaults as any).openAiApiKey,
        googleApiKey: (deps.smoltalkDefaults as any).googleApiKey,
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
