import { getRuntimeContext } from "../runtime/asyncContext.js";
import type { RuntimeContext } from "../runtime/state/context.js";
import type {
  ExtractionResult,
  ForgetResult,
} from "../runtime/memory/index.js";
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
  _stack: StateStack,
  _threads: ThreadStore,
  id: string,
): Promise<void> {
  const manager = ctx?.getActiveMemoryManager?.();
  if (!manager) return;
  manager.setMemoryId(id);
}

export function __internal_shouldRunMemory(
  ctx: RuntimeContext<any>,
  _stack: StateStack,
  _threads: ThreadStore,
): boolean {
  return ctx?.getActiveMemoryManager?.() !== undefined;
}

export async function __internal_buildExtractionPrompt(
  ctx: RuntimeContext<any>,
  _stack: StateStack,
  _threads: ThreadStore,
  content: string,
): Promise<string> {
  const manager = ctx?.getActiveMemoryManager?.();
  if (!manager) return "";
  return manager.buildExtractionPromptFor(content);
}

export async function __internal_applyExtractionResult(
  ctx: RuntimeContext<any>,
  _stack: StateStack,
  _threads: ThreadStore,
  result: ExtractionResult,
): Promise<void> {
  const manager = ctx?.getActiveMemoryManager?.();
  if (!manager) return;
  await manager.applyExtractionFromLLM(result);
}

export async function __internal_buildForgetPrompt(
  ctx: RuntimeContext<any>,
  _stack: StateStack,
  _threads: ThreadStore,
  query: string,
): Promise<string> {
  const manager = ctx?.getActiveMemoryManager?.();
  if (!manager) return "";
  return manager.buildForgetPromptFor(query);
}

export async function __internal_applyForgetResult(
  ctx: RuntimeContext<any>,
  _stack: StateStack,
  _threads: ThreadStore,
  result: ForgetResult,
): Promise<void> {
  const manager = ctx?.getActiveMemoryManager?.();
  if (!manager) return;
  await manager.applyForgetFromLLM(result);
}

export async function __internal_remember(
  ctx: RuntimeContext<any>,
  _stack: StateStack,
  _threads: ThreadStore,
  content: string,
): Promise<void> {
  const manager = ctx?.getActiveMemoryManager?.();
  if (!manager) return;
  await manager.remember(content);
}

export async function __internal_recall(
  ctx: RuntimeContext<any>,
  _stack: StateStack,
  _threads: ThreadStore,
  query: string,
): Promise<string> {
  const manager = ctx?.getActiveMemoryManager?.();
  if (!manager) return "";
  return manager.recall(query);
}

export async function __internal_forget(
  ctx: RuntimeContext<any>,
  _stack: StateStack,
  _threads: ThreadStore,
  query: string,
): Promise<void> {
  const manager = ctx?.getActiveMemoryManager?.();
  if (!manager) return;
  await manager.forget(query);
}

// ── ALS-reading replacements for the `__internal_*` exports above ──
// All memory helpers only need `ctx`; `stack`/`threads` are unused.

export async function _setMemoryId(id: string): Promise<void> {
  const { ctx } = getRuntimeContext();
  const manager = ctx?.getActiveMemoryManager?.();
  if (!manager) return;
  manager.setMemoryId(id);
}

export function _shouldRunMemory(): boolean {
  const { ctx } = getRuntimeContext();
  return ctx?.getActiveMemoryManager?.() !== undefined;
}

export async function _buildExtractionPrompt(content: string): Promise<string> {
  const { ctx } = getRuntimeContext();
  const manager = ctx?.getActiveMemoryManager?.();
  if (!manager) return "";
  return manager.buildExtractionPromptFor(content);
}

export async function _applyExtractionResult(result: ExtractionResult): Promise<void> {
  const { ctx } = getRuntimeContext();
  const manager = ctx?.getActiveMemoryManager?.();
  if (!manager) return;
  await manager.applyExtractionFromLLM(result);
}

export async function _buildForgetPrompt(query: string): Promise<string> {
  const { ctx } = getRuntimeContext();
  const manager = ctx?.getActiveMemoryManager?.();
  if (!manager) return "";
  return manager.buildForgetPromptFor(query);
}

export async function _applyForgetResult(result: ForgetResult): Promise<void> {
  const { ctx } = getRuntimeContext();
  const manager = ctx?.getActiveMemoryManager?.();
  if (!manager) return;
  await manager.applyForgetFromLLM(result);
}

export async function _remember(content: string): Promise<void> {
  const { ctx } = getRuntimeContext();
  const manager = ctx?.getActiveMemoryManager?.();
  if (!manager) return;
  await manager.remember(content);
}

export async function _recall(query: string): Promise<string> {
  const { ctx } = getRuntimeContext();
  const manager = ctx?.getActiveMemoryManager?.();
  if (!manager) return "";
  return manager.recall(query);
}

export async function _forget(query: string): Promise<void> {
  const { ctx } = getRuntimeContext();
  const manager = ctx?.getActiveMemoryManager?.();
  if (!manager) return;
  await manager.forget(query);
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
 * `process.cwd()` (deliberately the same as `agency.json`'s
 * `memory.dir`, NOT the module dir like `read`/`write`).
 */
export async function _enableMemory(config: MemoryConfig): Promise<void> {
  const { stack } = getRuntimeContext();
  if (!stack) return;
  stack.pushMemoryFrame(new MemoryFrame(config));
}

/** Pop the top memory frame from the current branch's stateStack.
 *  Frame-scoped: a `disableMemory()` inside a fork branch only
 *  affects that branch. Pops the JSON-seeded bottom frame too —
 *  library authors should avoid calling this casually. */
export function _disableMemory(): void {
  const { stack } = getRuntimeContext();
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
  const { stack } = getRuntimeContext();
  if (!stack) return false;
  return stack.pushMemoryFrame(new MemoryFrame(config));
}

/** Pop the top memory frame. Counterpart to `_pushMemoryFrame`; the
 *  Agency-side `memory(){}` block calls this only when `_pushMemoryFrame`
 *  returned true so dedup-no-op pushes don't accidentally pop the
 *  caller's frame. */
export function _popMemoryFrame(): void {
  const { stack } = getRuntimeContext();
  stack?.popMemoryFrame();
}
