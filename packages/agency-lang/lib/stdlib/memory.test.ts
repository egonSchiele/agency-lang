import { describe, it, expect } from "vitest";
import {
  __internal_setMemoryId,
  __internal_shouldRunMemory,
} from "./memory.js";

/**
 * Concurrency regression test for the context-injected builtins
 * migration.
 *
 * Before: stdlib helpers reached the active `MemoryManager` through a
 * module-level `currentContext` singleton. Two overlapping `runNode`
 * calls in the same Node.js process would trample the singleton across
 * `await` boundaries.
 *
 * After: every helper takes `ctx` as its first argument, threaded
 * through the call site by codegen (see
 * `lib/codegenBuiltins/contextInjected.ts`). There's no shared
 * mutable state between concurrent runs.
 *
 * This test exercises the new contract directly without going through
 * the full runNode pipeline. It builds two minimal ctx-shaped objects,
 * each with its own fake memoryManager, and asserts that interleaved
 * `__internal_setMemoryId` calls land on the correct manager.
 */

type FakeManager = {
  setMemoryIdCalls: string[];
  setMemoryId(id: string): void;
};

function makeFakeCtx(): { ctx: any; manager: FakeManager } {
  const manager: FakeManager = {
    setMemoryIdCalls: [],
    setMemoryId(id: string) {
      this.setMemoryIdCalls.push(id);
    },
  };
  return { ctx: { memoryManager: manager }, manager };
}

describe("std::memory ctx-passing concurrency", () => {
  it("each call uses the ctx it was passed, not a shared singleton", async () => {
    const a = makeFakeCtx();
    const b = makeFakeCtx();

    // Interleave the two calls, simulating two concurrent runNode runs.
    await Promise.all([
      __internal_setMemoryId(a.ctx, "scope-A"),
      __internal_setMemoryId(b.ctx, "scope-B"),
      __internal_setMemoryId(a.ctx, "scope-A-2"),
      __internal_setMemoryId(b.ctx, "scope-B-2"),
    ]);

    expect(a.manager.setMemoryIdCalls).toEqual(["scope-A", "scope-A-2"]);
    expect(b.manager.setMemoryIdCalls).toEqual(["scope-B", "scope-B-2"]);
  });

  it("is a no-op when ctx has no memoryManager", async () => {
    await expect(
      __internal_setMemoryId({} as any, "ignored"),
    ).resolves.toBeUndefined();
    await expect(
      __internal_setMemoryId(null as any, "ignored"),
    ).resolves.toBeUndefined();
  });

  it("__internal_shouldRunMemory reflects the ctx it was passed", () => {
    const a = makeFakeCtx();
    expect(__internal_shouldRunMemory(a.ctx)).toBe(true);
    expect(__internal_shouldRunMemory({} as any)).toBe(false);
    expect(__internal_shouldRunMemory(null as any)).toBe(false);
  });
});
