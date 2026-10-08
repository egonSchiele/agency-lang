// The browser's side of "#platform"; platform.node.ts says what the entry
// is for. A browser loads no modules from disk and runs no local model, so
// each hook here either does nothing or refuses.

import type { CoverageCollector } from "./coverageCollector.js";
import type { ProviderLoadingContext } from "./platform.js";

export async function loadConfiguredProviders(execCtx: ProviderLoadingContext): Promise<void> {
  const configured = execCtx.providerModules ?? [];
  if (configured.length > 0) {
    throw new Error(
      `Provider modules load from disk, which a browser cannot do: ${configured.join(", ")}. Remove providerModules from the configuration for a browser build.`,
    );
  }
  if (execCtx.smoltalkDefaults?.provider === "llama-cpp") {
    throw new Error("The llama-cpp provider runs a local model, which a browser cannot do.");
  }
}

/** Coverage is tooling for the test runner, which runs on Node. */
export function newCoverageCollector(): CoverageCollector | null {
  return null;
}

export async function resolveLocalEmbeddingModel(provider: string, model: string): Promise<string> {
  throw new Error(`A local model (${provider}: ${model}) cannot run in a browser.`);
}
