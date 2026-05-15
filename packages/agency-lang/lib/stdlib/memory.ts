import type { RuntimeContext } from "../runtime/state/context.js";
import type {
  ExtractionResult,
  ForgetResult,
} from "../runtime/memory/index.js";

/**
 * std::memory implementations.
 *
 * Each helper takes the per-run `RuntimeContext` as its first argument.
 * The agency-side wrappers (stdlib/memory.agency) obtain it via the
 * `getContext()` builtin, which lowers to the in-scope `__ctx` identifier
 * — no module-level singleton, no race window between concurrent runs.
 *
 * If memory isn't configured in `agency.json`, every function is a no-op:
 * `setMemoryId` and `forget` resolve to `undefined`, `recall` to `""`,
 * and the `_buildExtractionPrompt`/`_buildForgetPrompt` helpers return
 * an empty string so the agency-side guard short-circuits.
 *
 * `_remember` / `_forget` are kept as a convenience for direct callers
 * (e.g. legacy embedders that don't go through the agency-side flow).
 * The new agency-side path (`stdlib/memory.agency`) splits the work
 * into prompt-build + result-apply so the LLM call itself flows through
 * agency `runPrompt` for tracing, cost/token accounting, and
 * structured-output enforcement via the `responseFormat` schema
 * derived from the agency type system.
 */

export async function _setMemoryId(
  ctx: RuntimeContext<any>,
  id: string,
): Promise<void> {
  if (!ctx?.memoryManager) return;
  ctx.memoryManager.setMemoryId(id);
}

export function _shouldRunMemory(ctx: RuntimeContext<any>): boolean {
  return ctx?.memoryManager !== undefined;
}

export async function _buildExtractionPrompt(
  ctx: RuntimeContext<any>,
  content: string,
): Promise<string> {
  if (!ctx?.memoryManager) return "";
  return ctx.memoryManager.buildExtractionPromptFor(content);
}

export async function _applyExtractionResult(
  ctx: RuntimeContext<any>,
  result: ExtractionResult,
): Promise<void> {
  if (!ctx?.memoryManager) return;
  await ctx.memoryManager.applyExtractionFromLLM(result);
}

export async function _buildForgetPrompt(
  ctx: RuntimeContext<any>,
  query: string,
): Promise<string> {
  if (!ctx?.memoryManager) return "";
  return ctx.memoryManager.buildForgetPromptFor(query);
}

export async function _applyForgetResult(
  ctx: RuntimeContext<any>,
  result: ForgetResult,
): Promise<void> {
  if (!ctx?.memoryManager) return;
  await ctx.memoryManager.applyForgetFromLLM(result);
}

export async function _remember(
  ctx: RuntimeContext<any>,
  content: string,
): Promise<void> {
  if (!ctx?.memoryManager) return;
  await ctx.memoryManager.remember(content);
}

export async function _recall(
  ctx: RuntimeContext<any>,
  query: string,
): Promise<string> {
  if (!ctx?.memoryManager) return "";
  return ctx.memoryManager.recall(query);
}

export async function _forget(
  ctx: RuntimeContext<any>,
  query: string,
): Promise<void> {
  if (!ctx?.memoryManager) return;
  await ctx.memoryManager.forget(query);
}
