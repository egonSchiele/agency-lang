import { describe, it, expect } from "vitest";
import { _setMemoryId, _shouldRunMemory } from "./memory.js";

/**
 * Concurrency regression test for the `getContext()` migration.
 *
 * Before: stdlib helpers reached the active `MemoryManager` through a
 * module-level `currentContext` singleton. Two overlapping `runNode`
 * calls in the same Node.js process would trample the singleton across
 * `await` boundaries.
 *
 * After: every helper takes `ctx` as its first argument (sourced via
 * the `getContext()` builtin in agency-side wrappers, which lowers to
 * `__ctx`). There's no shared mutable state between concurrent runs.
 *
 * This test exercises the new contract directly without going through
 * the full runNode pipeline. It builds two minimal ctx-shaped objects,
 * each with its own fake memoryManager, and asserts that interleaved
 * `_setMemoryId` calls land on the correct manager.
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
      _setMemoryId(a.ctx, "scope-A"),
      _setMemoryId(b.ctx, "scope-B"),
      _setMemoryId(a.ctx, "scope-A-2"),
      _setMemoryId(b.ctx, "scope-B-2"),
    ]);

    expect(a.manager.setMemoryIdCalls).toEqual(["scope-A", "scope-A-2"]);
    expect(b.manager.setMemoryIdCalls).toEqual(["scope-B", "scope-B-2"]);
  });

  it("is a no-op when ctx has no memoryManager", async () => {
    await expect(_setMemoryId({} as any, "ignored")).resolves.toBeUndefined();
    await expect(_setMemoryId(null as any, "ignored")).resolves.toBeUndefined();
  });

  it("_shouldRunMemory reflects the ctx it was passed", () => {
    const a = makeFakeCtx();
    expect(_shouldRunMemory(a.ctx)).toBe(true);
    expect(_shouldRunMemory({} as any)).toBe(false);
    expect(_shouldRunMemory(null as any)).toBe(false);
  });
});
