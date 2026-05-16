import type { RuntimeContext } from "../runtime/state/context.js";
import type {
  ExtractionResult,
  ForgetResult,
} from "../runtime/memory/index.js";

/**
 * std::memory TS implementations for the context-injected builtins
 * registered in `lib/codegenBuiltins/contextInjected.ts`. Each
 * function takes the per-run `RuntimeContext` as its first argument;
 * the agency-side wrappers in `stdlib/memory.agency` call them
 * without it, and the TypeScript builder prepends `__ctx` at every
 * call site.
 *
 * If memory isn't configured in `agency.json`, every function is a
 * no-op: side-effecting helpers resolve to `undefined`,
 * `__internal_recall` to `""`, and the prompt-build helpers return
 * `""` so the agency-side guard short-circuits.
 */

export async function __internal_setMemoryId(
  ctx: RuntimeContext<any>,
  id: string,
): Promise<void> {
  if (!ctx?.memoryManager) return;
  ctx.memoryManager.setMemoryId(id);
}

export function __internal_shouldRunMemory(ctx: RuntimeContext<any>): boolean {
  return ctx?.memoryManager !== undefined;
}

export async function __internal_buildExtractionPrompt(
  ctx: RuntimeContext<any>,
  content: string,
): Promise<string> {
  if (!ctx?.memoryManager) return "";
  return ctx.memoryManager.buildExtractionPromptFor(content);
}

export async function __internal_applyExtractionResult(
  ctx: RuntimeContext<any>,
  result: ExtractionResult,
): Promise<void> {
  if (!ctx?.memoryManager) return;
  await ctx.memoryManager.applyExtractionFromLLM(result);
}

export async function __internal_buildForgetPrompt(
  ctx: RuntimeContext<any>,
  query: string,
): Promise<string> {
  if (!ctx?.memoryManager) return "";
  return ctx.memoryManager.buildForgetPromptFor(query);
}

export async function __internal_applyForgetResult(
  ctx: RuntimeContext<any>,
  result: ForgetResult,
): Promise<void> {
  if (!ctx?.memoryManager) return;
  await ctx.memoryManager.applyForgetFromLLM(result);
}

export async function __internal_remember(
  ctx: RuntimeContext<any>,
  content: string,
): Promise<void> {
  if (!ctx?.memoryManager) return;
  await ctx.memoryManager.remember(content);
}

export async function __internal_recall(
  ctx: RuntimeContext<any>,
  query: string,
): Promise<string> {
  if (!ctx?.memoryManager) return "";
  return ctx.memoryManager.recall(query);
}

export async function __internal_forget(
  ctx: RuntimeContext<any>,
  query: string,
): Promise<void> {
  if (!ctx?.memoryManager) return;
  await ctx.memoryManager.forget(query);
}
