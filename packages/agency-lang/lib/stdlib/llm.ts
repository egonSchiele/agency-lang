import { getRuntimeContext } from "../runtime/asyncContext.js";
import type { RetryConfig } from "../runtime/llmRetry.js";
import { loadProviderModuleByPath } from "../runtime/providerModules.js";
import {
  getAllModels,
  getModel,
  refreshModels,
  registerModelData,
} from "smoltalk";

/**
 * Fields that may be set as LLM defaults via `setLlmOptions`. A
 * deliberately small subset of the per-call `llm()` options. All ride
 * the same `stack.other.llmDefaults` bag; `runPrompt` routes
 * model/temperature/reasoningEffort/maxTokens into the smoltalk config
 * and `maxToolResultChars` into the tool-result cap.
 *
 * Extends `RetryConfig` (single source for `retries` / `timeout` / `backoff`,
 * shared with `LlmOpts` and the type-checker's `llmOptions` shape). Per-call
 * `llm()` options override these; these override the built-in defaults.
 */
export type LlmDefaults = RetryConfig & {
  model?: string;
  provider?: string;
  temperature?: number;
  reasoningEffort?: "low" | "medium" | "high";
  maxTokens?: number;
  maxToolResultChars?: number;
};

/**
 * Merge `opts` into the ACTIVE branch stack's LLM defaults
 * (`stack.other.llmDefaults`). Only present (non-undefined) keys are
 * written, so a partial update never clears an existing default.
 *
 * Branch-scoped: inside a fork/race/tool branch this writes that
 * branch's own slice (seeded from the parent at fork time by
 * `runBatch.inheritBranchMemory`), so the change is visible in-branch
 * and does not leak to siblings or the parent after join. It rides the
 * serialized `stack.other`, so it survives interrupt/resume. `runPrompt`
 * merges it over the baked `smoltalkDefaults` and under any per-call
 * `llm({...})` option.
 */
export function _setLlmOptions(opts: LlmDefaults): void {
  const { stack } = getRuntimeContext();
  if (!stack) return;
  // The branch's own llmDefaults object (seeded as a shallow copy of the
  // parent's at fork time), so mutating it here never touches the parent.
  const current = (stack.other.llmDefaults ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(opts)) {
    const value = (opts as Record<string, unknown>)[key];
    if (value !== undefined) {
      current[key] = value;
    }
  }
  stack.other.llmDefaults = current;
}

/** Load a provider module by path at runtime and register its provider into
 *  agency's own smoltalk — the runtime counterpart of `loadProviderModules`
 *  (which runs at bootstrap). Lets any program register a custom provider on
 *  demand. */
export async function _registerProviderModule(modulePath: string): Promise<void> {
  await loadProviderModuleByPath(modulePath);
}

/**
 * Stable, flat view of one hosted model for discovery/pickers. Maps smoltalk's
 * `ModelType` (union, optional-heavy fields) into a fixed shape the CLI, the
 * agent, and `std::llm` all share. Field order is mirrored by the Agency-side
 * `HostedModelInfo` in `stdlib/llm.agency` — keep the two in sync.
 */
export type HostedModelInfo = {
  name: string;
  provider: string;
  openWeights: boolean;
  inputCost: number;
  outputCost: number;
  contextWindow: number;
  family: string;
};

function toHostedInfo(model: any): HostedModelInfo {
  return {
    name: model.modelName,
    provider: model.provider ?? "",
    openWeights: model.openWeights ?? false,
    inputCost: model.inputTokenCost ?? 0,
    outputCost: model.outputTokenCost ?? 0,
    contextWindow: model.maxInputTokens ?? 0,
    family: model.family ?? "",
  };
}

/** All known hosted TEXT models (baked catalog + any refreshed data). Non-text
 *  members of the `ModelType` union lack pricing/context and are excluded. */
export function _listHostedModels(): HostedModelInfo[] {
  return getAllModels()
    .filter((model) => model.type === "text")
    .map(toHostedInfo);
}

/** Metadata for one hosted text model by name, or null if unknown/non-text. */
export function _hostedModelInfo(name: string): HostedModelInfo | null {
  const model = getModel(name as any);
  return model && model.type === "text" ? toHostedInfo(model) : null;
}

/** Fetch a fresh model-data blob and register it into smoltalk's in-memory
 *  catalog for this process. Returns a plain status (no smoltalk types leak
 *  out). NOTE: registration is process-local — it does not persist to disk. */
export async function _refreshHostedCatalog(
  url: string,
): Promise<{ ok: boolean; count: number; error: string }> {
  const res = await refreshModels(url ? { url } : {});
  if (res.success) {
    registerModelData(res.value);
    return { ok: true, count: res.value.models.length, error: "" };
  }
  return { ok: false, count: 0, error: res.error };
}
