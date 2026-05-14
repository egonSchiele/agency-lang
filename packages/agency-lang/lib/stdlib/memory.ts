import { getCurrentContext } from "../runtime/currentContext.js";

/**
 * std::memory implementations.
 *
 * These functions reach the active `MemoryManager` via the per-run
 * `currentContext` singleton (set in `runNode`, cleared in its `finally`).
 * If memory isn't configured in `agency.json`, every function is a no-op
 * — `setMemoryId` and `forget` resolve to `undefined`, `recall` to `""`.
 *
 * `remember`, `forget`, and `setMemoryId` are intentionally tolerant:
 * agents calling them without a configured memory layer should keep
 * running rather than crashing.
 */

export async function _setMemoryId(id: string): Promise<void> {
  const ctx = getCurrentContext();
  if (!ctx?.memoryManager) return;
  ctx.memoryManager.setMemoryId(id);
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
