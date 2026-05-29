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
  return {
    ctx: { getActiveMemoryManager: () => manager },
    manager,
  };
}

describe("std::memory ctx-passing concurrency", () => {
  it("each call uses the ctx it was passed, not a shared singleton", async () => {
    const a = makeFakeCtx();
    const b = makeFakeCtx();

    // Interleave the two calls, simulating two concurrent runNode runs.
    // `_stack` and `_threads` are unused by memory builtins, so we pass
    // `null` here purely as a unit-test placeholder. In real generated
    // code these positions are ALWAYS filled with live `StateStack` and
    // `ThreadStore` instances (see lib/backends/typescriptBuilder.ts —
    // every context-injected call gets `[__ctx, __stateStack, __threads]`
    // prepended).
    await Promise.all([
      __internal_setMemoryId(a.ctx, null as any, null as any, "scope-A"),
      __internal_setMemoryId(b.ctx, null as any, null as any, "scope-B"),
      __internal_setMemoryId(a.ctx, null as any, null as any, "scope-A-2"),
      __internal_setMemoryId(b.ctx, null as any, null as any, "scope-B-2"),
    ]);

    expect(a.manager.setMemoryIdCalls).toEqual(["scope-A", "scope-A-2"]);
    expect(b.manager.setMemoryIdCalls).toEqual(["scope-B", "scope-B-2"]);
  });

  it("is a no-op when ctx has no memoryManager", async () => {
    await expect(
      __internal_setMemoryId({} as any, null as any, null as any, "ignored"),
    ).resolves.toBeUndefined();
    await expect(
      __internal_setMemoryId(null as any, null as any, null as any, "ignored"),
    ).resolves.toBeUndefined();
  });

  it("__internal_shouldRunMemory reflects the ctx it was passed", () => {
    const a = makeFakeCtx();
    expect(__internal_shouldRunMemory(a.ctx, null as any, null as any)).toBe(true);
    expect(__internal_shouldRunMemory({} as any, null as any, null as any)).toBe(false);
    expect(__internal_shouldRunMemory(null as any, null as any, null as any)).toBe(false);
  });
});

import {
  _enableMemory,
  _disableMemory,
} from "./memory.js";
import {
  _resetStoreRegistry,
} from "../runtime/memory/index.js";
import { runInTestContext } from "../runtime/asyncContext.js";
import { RuntimeContext } from "../runtime/state/context.js";
import { StateStack } from "../runtime/state/stateStack.js";
import { ThreadStore } from "../runtime/state/threadStore.js";
import { beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("std::memory enable/disable/block", () => {
  let tmpRoot: string;
  let dirA: string;
  let dirB: string;

  function makeCtx(memory?: { dir: string }) {
    return new RuntimeContext({
      statelogConfig: {
        host: "https://example.com",
        apiKey: "test-api-key",
        projectId: "test-project",
        debugMode: false,
      },
      smoltalkDefaults: {},
      dirname: tmpRoot,
      memory,
    });
  }

  async function withCtx(ctx: RuntimeContext<any>, fn: () => Promise<void>): Promise<void> {
    const execCtx = await ctx.createExecutionContext("r1");
    await runInTestContext(execCtx, execCtx.stateStack, new ThreadStore(), fn);
  }

  beforeEach(() => {
    _resetStoreRegistry();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "stdmem-"));
    dirA = path.join(tmpRoot, "a");
    dirB = path.join(tmpRoot, "b");
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    _resetStoreRegistry();
  });

  it("_enableMemory pushes a frame on top of nothing", async () => {
    const ctx = makeCtx();
    await withCtx(ctx, async () => {
      await _enableMemory({ dir: dirA });
    });
  });

  it("_enableMemory is a no-op when pushing the same dir as the top frame", async () => {
    const ctx = makeCtx();
    const execCtx = await ctx.createExecutionContext("r1");
    await runInTestContext(execCtx, execCtx.stateStack, new ThreadStore(), async () => {
      await _enableMemory({ dir: dirA });
      const beforeFrames = (execCtx.stateStack.other.memoryFrames as any[]).length;
      await _enableMemory({ dir: dirA });
      const afterFrames = (execCtx.stateStack.other.memoryFrames as any[]).length;
      expect(afterFrames).toBe(beforeFrames);
    });
  });

  it("_enableMemory with a different dir stacks on top", async () => {
    const ctx = makeCtx();
    const execCtx = await ctx.createExecutionContext("r1");
    await runInTestContext(execCtx, execCtx.stateStack, new ThreadStore(), async () => {
      await _enableMemory({ dir: dirA });
      await _enableMemory({ dir: dirB });
      const frames = execCtx.stateStack.other.memoryFrames as any[];
      expect(frames.length).toBe(2);
      expect(frames[1].configKey).toBe(fs.realpathSync(dirB));
    });
  });

  it("_disableMemory pops one frame", async () => {
    const ctx = makeCtx();
    const execCtx = await ctx.createExecutionContext("r1");
    await runInTestContext(execCtx, execCtx.stateStack, new ThreadStore(), async () => {
      await _enableMemory({ dir: dirA });
      await _enableMemory({ dir: dirB });
      _disableMemory();
      const frames = execCtx.stateStack.other.memoryFrames as any[];
      expect(frames.length).toBe(1);
      expect(frames[0].configKey).toBe(fs.realpathSync(dirA));
    });
  });

  it("frames survive serialize/deserialize with nested config intact", async () => {
    const ctx = makeCtx();
    const execCtx = await ctx.createExecutionContext("r1");
    const richConfig = {
      dir: dirA,
      model: "gpt-4o",
      autoExtract: { interval: 3 },
      compaction: { trigger: "messages" as const, threshold: 12 },
      embeddings: { model: "emb-1" },
    };
    await runInTestContext(execCtx, execCtx.stateStack, new ThreadStore(), async () => {
      await _enableMemory(richConfig);
    });
    const json = execCtx.stateStack.toJSON();
    const restored = StateStack.fromJSON(json);
    const top = restored.topMemoryFrame();
    expect(top?.configKey).toBe(fs.realpathSync(dirA));
    expect(top?.config).toEqual(richConfig);
  });

  it("_disableMemory against the JSON-seeded bottom frame turns memory off", async () => {
    const dirJson = path.join(tmpRoot, "json");
    fs.mkdirSync(dirJson);
    const ctx = makeCtx({ dir: dirJson });
    const execCtx = await ctx.createExecutionContext("r1");
    expect(execCtx.getActiveMemoryManager()).toBeDefined();
    await runInTestContext(execCtx, execCtx.stateStack, new ThreadStore(), async () => {
      _disableMemory();
    });
    expect(execCtx.getActiveMemoryManager()).toBeUndefined();
  });
});
