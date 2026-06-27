import { getRuntimeContext } from "../runtime/asyncContext.js";
import type { RetryConfig } from "../runtime/llmRetry.js";
import { loadProviderModuleByPath } from "../runtime/providerModules.js";

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
