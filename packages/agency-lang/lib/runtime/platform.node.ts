// The runtime hooks that differ by platform and are not the host's
// business: loading provider modules from disk, the coverage collector, and
// resolving a local model. The runtime imports this file as "#platform", an
// entry in the "imports" field of package.json that resolves here by
// default and to platform.browser.ts under the "browser" condition. Each
// export here has the same name and type there.

import { CoverageCollector } from "./coverageCollector.js";
import { ensureConfiguredLocalProvider } from "./localProvider.js";
import { loadProviderModules } from "./providerModules.js";
import { _resolveLocalEmbeddingModel } from "../stdlib/localModels.js";
import type { ProviderLoadingContext } from "./platform.js";

/** Registers the configured LLM providers before a run starts: the
 *  modules named in `agency.json` and AGENCY_PROVIDER_MODULES, and the
 *  llama-cpp provider when the config routes calls to it. */
export async function loadConfiguredProviders(execCtx: ProviderLoadingContext): Promise<void> {
  await loadProviderModules(execCtx);
  await ensureConfiguredLocalProvider(execCtx);
}

/** A collector for step coverage, which `write` saves as a file. */
export function newCoverageCollector(): CoverageCollector {
  return new CoverageCollector();
}

/** The model a local provider serves for an embedding target: a .gguf
 *  path for llama-cpp, the served name for mlx. */
export function resolveLocalEmbeddingModel(provider: string, model: string): Promise<string> {
  return _resolveLocalEmbeddingModel(provider, model);
}
