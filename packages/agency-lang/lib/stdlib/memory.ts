import { currentRun, logOf, type Run } from "../runtime/asyncContext.js";
import type { RuntimeContext } from "../runtime/state/context.js";
import type { ExtractionResult, ForgetResult, MemoryManager } from "../runtime/memory/index.js";
import { MemoryFrame } from "../runtime/memory/frame.js";
import type { MemoryConfig } from "../runtime/memory/types.js";
import type { StateStack } from "../runtime/state/stateStack.js";
import type { ThreadStore } from "../runtime/state/threadStore.js";

/**
 * std::memory TS implementations for the context-injected builtins
 * registered in `lib/codegenBuiltins/contextInjected.ts`. Each
 * function takes the per-run `RuntimeContext` as its first argument,
 * followed by the caller's local `StateStack` and `ThreadStore`
 * (unused here — needed by other context-injected builtins like
 * `std::thread`'s `getCost`/`*Message`). The agency-side wrappers in
 * `stdlib/memory.agency` call them without any of these prefix args;
 * the TypeScript builder prepends `__ctx`, `__stateStack`, and
 * `__threads` at every context-injected call site.
 *
 * If no memory frame is active (neither `agency.json` nor a code-side
 * `enableMemory(...)` has set one), every function is a no-op:
 * side-effecting helpers resolve to `undefined`,
 * `__internal_recall` to `""`, and the prompt-build helpers return
 * `""` so the agency-side guard short-circuits.
 */

// ---- ctx-passing variants (kept for the context-injected builtin migration) ----

export async function __internal_setMemoryId(
  ctx: RuntimeContext<any>,
  stack: StateStack,
  _threads: ThreadStore,
  id: string,
): Promise<void> {
  const manager = ctx?.getActiveMemoryManager?.(stack ?? undefined);
  if (!manager) return;
  manager.setMemoryId({ ctx, stack, log: logOf(ctx, ctx.globals) }, id);
}

export function __internal_shouldRunMemory(
  ctx: RuntimeContext<any>,
  stack: StateStack,
  _threads: ThreadStore,
): boolean {
  return ctx?.getActiveMemoryManager?.(stack ?? undefined) !== undefined;
}

export async function __internal_buildExtractionPrompt(
  ctx: RuntimeContext<any>,
  stack: StateStack,
  _threads: ThreadStore,
  content: string,
): Promise<string> {
  const manager = ctx?.getActiveMemoryManager?.(stack ?? undefined);
  if (!manager) return "";
  return manager.buildExtractionPromptFor({ ctx, stack, log: logOf(ctx, ctx.globals) }, content);
}

export async function __internal_applyExtractionResult(
  ctx: RuntimeContext<any>,
  stack: StateStack,
  _threads: ThreadStore,
  result: ExtractionResult,
): Promise<void> {
  const manager = ctx?.getActiveMemoryManager?.(stack ?? undefined);
  if (!manager) return;
  await manager.applyExtractionFromLLM({ ctx, stack, log: logOf(ctx, ctx.globals) }, result);
}

export async function __internal_buildForgetPrompt(
  ctx: RuntimeContext<any>,
  stack: StateStack,
  _threads: ThreadStore,
  query: string,
): Promise<string> {
  const manager = ctx?.getActiveMemoryManager?.(stack ?? undefined);
  if (!manager) return "";
  return manager.buildForgetPromptFor({ ctx, stack, log: logOf(ctx, ctx.globals) }, query);
}

export async function __internal_applyForgetResult(
  ctx: RuntimeContext<any>,
  stack: StateStack,
  _threads: ThreadStore,
  result: ForgetResult,
): Promise<void> {
  const manager = ctx?.getActiveMemoryManager?.(stack ?? undefined);
  if (!manager) return;
  await manager.applyForgetFromLLM({ ctx, stack, log: logOf(ctx, ctx.globals) }, result);
}

export async function __internal_remember(
  ctx: RuntimeContext<any>,
  stack: StateStack,
  _threads: ThreadStore,
  content: string,
): Promise<void> {
  const manager = ctx?.getActiveMemoryManager?.(stack ?? undefined);
  if (!manager) return;
  await manager.remember({ ctx, stack, log: logOf(ctx, ctx.globals) }, content);
}

export async function __internal_recall(
  ctx: RuntimeContext<any>,
  stack: StateStack,
  _threads: ThreadStore,
  query: string,
): Promise<string> {
  const manager = ctx?.getActiveMemoryManager?.(stack ?? undefined);
  if (!manager) return "";
  return manager.recall({ ctx, stack, log: logOf(ctx, ctx.globals) }, query);
}

export async function __internal_forget(
  ctx: RuntimeContext<any>,
  stack: StateStack,
  _threads: ThreadStore,
  query: string,
): Promise<void> {
  const manager = ctx?.getActiveMemoryManager?.(stack ?? undefined);
  if (!manager) return;
  await manager.forget({ ctx, stack, log: logOf(ctx, ctx.globals) }, query);
}

// ── Replacements for the `__internal_*` exports above ──
// Each takes the current run on its first line and hands it to the manager.
// One manager serves every fork branch, so it is told the run on each call.

/** The memory manager of the run's branch, or undefined when no memory
 *  frame is active there. */
function activeManager(run: Run): MemoryManager | undefined {
  return run.ctx?.getActiveMemoryManager?.(run.stack);
}

export async function _setMemoryId(id: string): Promise<void> {
  const run = currentRun();
  activeManager(run)?.setMemoryId(run, id);
}

export function _getMemoryId(): string {
  const run = currentRun();
  return activeManager(run)?.getMemoryId?.(run) ?? "default";
}

export function _shouldRunMemory(): boolean {
  return activeManager(currentRun()) !== undefined;
}

export async function _buildExtractionPrompt(content: string): Promise<string> {
  const run = currentRun();
  const manager = activeManager(run);
  if (!manager) return "";
  return manager.buildExtractionPromptFor(run, content);
}

export async function _applyExtractionResult(result: ExtractionResult): Promise<void> {
  const run = currentRun();
  await activeManager(run)?.applyExtractionFromLLM(run, result);
}

export async function _buildForgetPrompt(query: string): Promise<string> {
  const run = currentRun();
  const manager = activeManager(run);
  if (!manager) return "";
  return manager.buildForgetPromptFor(run, query);
}

export async function _applyForgetResult(result: ForgetResult): Promise<void> {
  const run = currentRun();
  await activeManager(run)?.applyForgetFromLLM(run, result);
}

export async function _remember(content: string): Promise<void> {
  const run = currentRun();
  await activeManager(run)?.remember(run, content);
}

export async function _recall(query: string): Promise<string> {
  const run = currentRun();
  const manager = activeManager(run);
  if (!manager) return "";
  return manager.recall(run, query);
}

export async function _forget(query: string): Promise<void> {
  const run = currentRun();
  await activeManager(run)?.forget(run, query);
}

// ── New: enable / disable / block ──
//
// "What" lives here. "How" lives in MemoryFrame's constructor +
// StateStack.{push,pop,active}MemoryFrame.

/**
 * Push a memory frame onto the current branch's stateStack.
 *
 * Process-wide stores are cached by absolute realpath'd dir, so
 * multiple calls with the same dir share one underlying store.
 * Repeating the same dir as the current top frame is a no-op (so the
 * common `static const _ = enableMemory(...)` plus an
 * `enableMemory(...)` in `main()` is safe). Pushing a different dir
 * stacks the new frame on top — pop it with `disableMemory()`.
 *
 * Auto-creates the dir if missing. Resolves `dir` against
 * `process.cwd()`, the same as `agency.json`'s `memory.dir` and
 * every path-taking stdlib function.
 */
export async function _enableMemory(config: MemoryConfig): Promise<void> {
  const run = currentRun();
  if (!run.stack) return;
  run.stack.pushMemoryFrame(new MemoryFrame(config));
  startLocalEmbeddingResolution(run, config);
}

/** A local embedding model may need a download. Start it at enable time
 *  rather than inside the first recall. */
function startLocalEmbeddingResolution(run: Run, config: MemoryConfig): void {
  const provider = config.embeddings?.provider ?? "";
  if (provider !== "mlx" && provider !== "llama-cpp") return;
  void activeManager(run)?.resolveEmbeddingTarget(run);
}

/** Pop the top memory frame from the current branch's stateStack.
 *  Frame-scoped: a `disableMemory()` inside a fork branch only
 *  affects that branch. Pops the JSON-seeded bottom frame too —
 *  library authors should avoid calling this casually. */
export function _disableMemory(): void {
  const { stack } = currentRun();
  stack?.popMemoryFrame();
}

/**
 * Push a memory frame, returning whether the push actually happened
 * (false on same-dir dedup). The Agency-side `memory({...}) as { ... }`
 * block pairs this with `_popMemoryFrame()` so a no-op push doesn't
 * unbalance the pop — mirrors the `_pushGuard`/`_popGuard` count
 * pattern in std::thread. Returns `false` and is a no-op outside any
 * runtime frame (consistent with `_enableMemory`).
 *
 * Lives in TS rather than as a thin wrapper around `_enableMemory`
 * because Agency callers need the boolean to decide whether to pop.
 */
export function _pushMemoryFrame(config: MemoryConfig): boolean {
  const run = currentRun();
  if (!run.stack) return false;
  const pushed = run.stack.pushMemoryFrame(new MemoryFrame(config));
  if (pushed) {
    startLocalEmbeddingResolution(run, config);
  }
  return pushed;
}

/** Pop the top memory frame. Counterpart to `_pushMemoryFrame`; the
 *  Agency-side `memory(){}` block calls this only when `_pushMemoryFrame`
 *  returned true so dedup-no-op pushes don't accidentally pop the
 *  caller's frame. */
export function _popMemoryFrame(): void {
  const { stack } = currentRun();
  stack?.popMemoryFrame();
}
