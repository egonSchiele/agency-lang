import type { RuntimeContext } from "../runtime/state/context.js";
import type {
  ExtractionResult,
  ForgetResult,
} from "../runtime/memory/index.js";

/**
 * std::memory implementations.
 *
 * These are "context-injected builtins": the agency-side wrappers in
 * `stdlib/memory.agency` call them by their `__internal_*` names with
 * the user-visible argument list, and the TypeScript builder rewrites
 * each call to prepend the runtime context (`__ctx`) as the first
 * positional argument. See `lib/codegenBuiltins/contextInjected.ts`
 * for the registry that drives the rewrite.
 *
 * The previous design exposed the runtime context to user code via a
 * `getContext()` builder macro. That was bad for two reasons:
 *   - users could store the returned context in a global and recreate
 *     the original race-prone singleton across runs;
 *   - binding `getContext()` to a `const` triggered a runner-step
 *     skip bug because the assignment looked like an async point
 *     without actually being one.
 * Context-injection avoids both: user code never touches `__ctx`,
 * and the call site is emitted as a plain async call so the runner
 * sees it as a normal step.
 *
 * If memory isn't configured in `agency.json`, every function is a
 * no-op: `__internal_setMemoryId` and `__internal_forget` resolve to
 * `undefined`, `__internal_recall` to `""`, and the prompt-build
 * helpers return `""` so the agency-side guard short-circuits.
 *
 * `__internal_remember` / `__internal_forget` are kept as a
 * convenience for direct callers (e.g. legacy embedders that don't
 * route through the agency-side flow). The agency-side path
 * (`stdlib/memory.agency`) splits the work into prompt-build +
 * result-apply so the LLM call itself flows through agency
 * `runPrompt` for tracing, cost/token accounting, and
 * structured-output enforcement via the `responseFormat` schema
 * derived from the agency type system.
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
