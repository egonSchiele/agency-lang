import { getCurrentContext } from "../runtime/currentContext.js";
import type {
  ExtractionResult,
  ForgetResult,
} from "../runtime/memory/index.js";

/**
 * std::memory implementations.
 *
 * These functions reach the active `MemoryManager` via the per-run
 * `currentContext` singleton (set in `runNode`, cleared in its `finally`).
 * If memory isn't configured in `agency.json`, every function is a no-op
 * — `setMemoryId` and `forget` resolve to `undefined`, `recall` to `""`,
 * and the `_buildExtractionPrompt`/`_buildForgetPrompt` helpers return
 * an empty string so the agency-side guard short-circuits.
 *
 * `remember`, `forget`, and `setMemoryId` are intentionally tolerant:
 * agents calling them without a configured memory layer should keep
 * running rather than crashing.
 *
 * `_remember` / `_forget` are kept as a convenience for direct callers
 * (e.g. legacy embedders that don't go through the agency-side flow).
 * The new agency-side path (`stdlib/memory.agency`) splits the work
 * into prompt-build + result-apply so the LLM call itself flows through
 * agency `runPrompt` for tracing, cost/token accounting, and
 * structured-output enforcement via the `responseFormat` schema
 * derived from the agency type system.
 */

export async function _setMemoryId(id: string): Promise<void> {
  const ctx = getCurrentContext();
  if (!ctx?.memoryManager) return;
  ctx.memoryManager.setMemoryId(id);
}

export function _shouldRunMemory(): boolean {
  return getCurrentContext()?.memoryManager !== undefined;
}

export async function _buildExtractionPrompt(content: string): Promise<string> {
  const ctx = getCurrentContext();
  if (!ctx?.memoryManager) return "";
  return ctx.memoryManager.buildExtractionPromptFor(content);
}

export async function _applyExtractionResult(
  result: ExtractionResult,
): Promise<void> {
  const ctx = getCurrentContext();
  if (!ctx?.memoryManager) return;
  await ctx.memoryManager.applyExtractionFromLLM(result);
}

export async function _buildForgetPrompt(query: string): Promise<string> {
  const ctx = getCurrentContext();
  if (!ctx?.memoryManager) return "";
  return ctx.memoryManager.buildForgetPromptFor(query);
}

export async function _applyForgetResult(result: ForgetResult): Promise<void> {
  const ctx = getCurrentContext();
  if (!ctx?.memoryManager) return;
  await ctx.memoryManager.applyForgetFromLLM(result);
}

export async function _remember(content: string): Promise<void> {
  const ctx = getCurrentContext();
  if (!ctx?.memoryManager) return;
  await ctx.memoryManager.remember(content);
}

export async function _recall(query: string): Promise<string> {
  const ctx = getCurrentContext();
  if (!ctx?.memoryManager) return "";
  return ctx.memoryManager.recall(query);
}

export async function _forget(query: string): Promise<void> {
  const ctx = getCurrentContext();
  if (!ctx?.memoryManager) return;
  await ctx.memoryManager.forget(query);
}
