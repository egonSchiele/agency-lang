import { fixedPath, resolveUnder, readText, type Located } from "./contained.js";
import { agencyStore, getRuntimeContext } from "../runtime/asyncContext.js";
import type { RetryConfig } from "../runtime/llmRetry.js";
import { loadProviderModuleByPath } from "../runtime/providerModules.js";
import {
  getAllModels,
  getHostedTools,
  getModel,
  refreshModels,
  registerModelData,
  getRegisteredModelData,
  mergeModelData,
  mergeHostedTools,
  modelSupportsInputModality,
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
  maxToolCallRounds?: number;
  /** Refuse a tool call after this many identical runs with the same result; 0 disables. */
  maxRepeatedToolCalls?: number;
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
 *  (which runs at bootstrap). The Agency wrapper raised
 *  `std::llm::registerProvider` on the real path, so the default `locate`
 *  refuses a link in it, and a link at the file itself is refused too. */
export async function _registerProviderModule(
  modulePath: string,
  locate: (p: string) => Located = fixedPath,
): Promise<void> {
  const located = locate(modulePath);
  await loadProviderModuleByPath(resolveUnder(located.root, located.target));
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

/** Hosted-search capability names to request for a call on `model` via
 *  `provider`, backing `std::agents/lib/search.hostedSearchTools`. Every
 *  smoltalk client keys the request on the literal string "web_search", so
 *  that is the only name this ever returns (the catalog's per-provider tool
 *  names like "google_search" are catalog entries, not request keys).
 *
 *  The answer depends on the ROUTE, not the model family: gpt-4o-mini has
 *  hosted search through "openai-responses" and none through the base
 *  "openai" client. This resolves the pair the way the call will (see
 *  `resolveLlmRoute`) and asks smoltalk's `getHostedTools` about exactly
 *  that pair, which is the same check that later rejects an unsupported
 *  request.
 *
 *  Two cases err open, because withholding search wrongly is the invisible
 *  failure: a model unknown to the catalog (brand new, custom) and an empty
 *  model with no default anywhere. */
export function _hostedSearchTools(model: string, provider: string = ""): string[] {
  const route = resolveLlmRoute(model, provider);
  if (route.model === "") {
    return ["web_search"];
  }
  if (!getModel(route.model as any)) {
    return ["web_search"];
  }
  const entries = getHostedTools({
    category: "web_search",
    model: route.model as any,
    ...(route.provider === "" ? {} : { provider: route.provider }),
  });
  return entries.length > 0 ? ["web_search"] : [];
}

/** The model/provider pair an `llm()` call would use given these explicit
 *  overrides ("" = none). A named model routes through the named provider,
 *  else its CATALOG provider — never the ambient one: `llmOptions` emits
 *  the (possibly empty) provider alongside the model, the per-call config
 *  overwrites the branch/baked pair, and smoltalk resolves an empty
 *  provider from the model. Only a call with no model override falls back
 *  to the ambient pair (branch `setLlmOptions`, then the baked agency.json
 *  defaults); an empty provider there again means the catalog. Reads
 *  `agencyStore` directly rather than `getRuntimeContext()`, which throws
 *  outside an execution frame; no frame just means no defaults. */
function resolveLlmRoute(model: string, provider: string): { model: string; provider: string } {
  if (model !== "") {
    return { model, provider };
  }
  const store = agencyStore.getStore();
  const branch = (store?.stack?.other.llmDefaults ?? {}) as { model?: string; provider?: string };
  const baked = (store?.ctx?.smoltalkDefaults ?? {}) as { model?: string; provider?: string };
  return {
    model: branch.model || baked.model || "",
    provider: provider || branch.provider || baked.provider || "",
  };
}

/** Tri-state modality probe backing `std::llm.modelSupportsInput`. Returns
 *  null (not undefined — Agency has no undefined) when the model is unknown
 *  or carries no modality data; that matches smoltalk's send-time gate,
 *  which only blocks on an explicit false. */
export function _modelSupportsInput(model: string, modality: string): boolean | null {
  if (modality !== "image" && modality !== "pdf") {
    return null;
  }
  return modelSupportsInputModality(model, modality) ?? null;
}

/** Fetch the latest model-data blob and return it pre-serialized. No
 *  registration — the CLI prints this to stdout for the user to save and later
 *  load with `std::llm.loadModelData`. */
export async function _fetchModelData(
  url: string,
): Promise<{ ok: boolean; json: string; error: string }> {
  const res = await refreshModels(url ? { url } : {});
  if (res.success) {
    return { ok: true, json: JSON.stringify(res.value, null, 2), error: "" };
  }
  return { ok: false, json: "", error: res.error };
}

/** Read a model-data JSON file (the shape `agency models refresh` prints) and
 *  register it, ACCUMULATING over any previously registered data (this file
 *  wins on provider+name collisions, deep-merging fields) and over the baked
 *  catalog. Errors are returned, never thrown, so the Agency wrapper can map
 *  them to a Result. Returns the number of models in THIS file.
 *
 *  `locate` splits the path into its parent and final name. The Agency
 *  wrapper raised `std::read` on the real spelling, so the default refuses
 *  a link in it; a CLI caller with no approval passes `wholePath`. */
export function _loadModelData(
  path: string,
  locate: (p: string) => Located = fixedPath,
): { ok: boolean; count: number; error: string } {
  let text: string;
  try {
    const located = locate(path);
    text = readText(located.root, located.target);
  } catch (err) {
    return { ok: false, count: 0, error: `cannot read ${path}: ${(err as Error).message}` };
  }
  let blob: any;
  try {
    blob = JSON.parse(text);
  } catch (err) {
    return { ok: false, count: 0, error: `${path} is not valid JSON: ${(err as Error).message}` };
  }
  if (!blob || !Array.isArray(blob.models)) {
    return { ok: false, count: 0, error: `${path} is not model data (missing "models" array)` };
  }
  const prior = getRegisteredModelData();
  // Refuse to stitch models of a different schema version onto the prior blob —
  // a cross-version merge could mix incompatible field shapes. Fail loudly.
  if (
    prior &&
    blob.schemaVersion != null &&
    prior.schemaVersion != null &&
    blob.schemaVersion !== prior.schemaVersion
  ) {
    return {
      ok: false,
      count: 0,
      error: `${path} has schemaVersion ${blob.schemaVersion} but ${prior.schemaVersion} is already loaded; re-run "agency models refresh" to regenerate the file at the current schema version`,
    };
  }
  const merged = prior
    ? {
        schemaVersion: blob.schemaVersion ?? prior.schemaVersion,
        generatedAt: blob.generatedAt ?? prior.generatedAt,
        // Overlay (this file) wins on provider:modelName and deep-merges, so a
        // partial hand-edited entry augments the prior one.
        models: mergeModelData(prior.models, blob.models),
        // `?? []` on the overlay means "no new tools" (base preserved), NOT
        // "clear" — mergeHostedTools merges overlay into base, so prior tools
        // survive a models-only file. Do not change to pass undefined.
        hostedTools: mergeHostedTools(prior.hostedTools ?? [], blob.hostedTools ?? []),
      }
    : blob;
  // registerModelData REPLACES smoltalk's single registered slot, so `merged`
  // must carry everything (hence the pre-merge). No double-apply.
  registerModelData(merged);
  return { ok: true, count: blob.models.length, error: "" };
}
