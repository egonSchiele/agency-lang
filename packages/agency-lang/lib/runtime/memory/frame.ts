/**
 * Memory frames live on `StateStack.other.memoryFrames`. A frame
 * is the unit of "where memory is configured right now" — pushed
 * by `enableMemory(...)` (or the JSON-seeded bottom frame at
 * `createExecutionContext`), popped by `disableMemory()` or the
 * `memory(){}` block. The active frame is always "top of stack
 * or none."
 *
 * `MemoryFrame` carries:
 *  - `configKey`: the absolute, mkdir'd dir. Used both as the
 *    storage location (passed to `getOrCreateStore`) AND as the
 *    cache key for per-execCtx `MemoryManager` lookup. Two pushes
 *    of the same `configKey` are deduped by
 *    `StateStack.pushMemoryFrame`, so process-wide caching is
 *    consistent with stack-level identity.
 *  - `config`: the full user-supplied `MemoryConfig`. The manager
 *    needs the auxiliary fields (model, autoExtract, compaction,
 *    embeddings) that don't participate in identity.
 *
 * The constructor owns the policy ("resolve dir against
 * `process.cwd()`, mkdir-p, realpath") — the same string in
 * `agency.json` and in code lands at the same physical store.
 *
 * `MemoryFrame.equals` is static (not an instance method) on
 * purpose: frames survive a JSON round-trip through StateStack
 * serialization, which drops the class prototype. A plain object
 * shape `{configKey, config}` still satisfies the type structurally,
 * so any caller that uses `frame.equals(other)` after a checkpoint
 * restore would `TypeError`. The static form works on both fresh
 * `new MemoryFrame(...)` instances and JSON-restored plain shapes,
 * which is what we need because checkpoint restore is real.
 */
import fs from "node:fs";
import path from "node:path";
import type { MemoryConfig } from "./types.js";

export class MemoryFrame {
  readonly configKey: string;
  readonly config: MemoryConfig;

  constructor(config: MemoryConfig) {
    if (!config.dir || config.dir.trim() === "") {
      throw new Error("enableMemory: `dir` is required and must be non-empty.");
    }
    const resolved = path.resolve(process.cwd(), config.dir);
    fs.mkdirSync(resolved, { recursive: true });
    this.configKey = fs.realpathSync(resolved);
    this.config = config;
  }

  /** Frame identity is purely the resolved dir — two frames pointing
   *  at the same realpath are interchangeable for stack-dedup and
   *  manager-cache lookup, regardless of auxiliary config like
   *  `model` or `compaction.threshold`. */
  static equals(a: MemoryFrame, b: MemoryFrame): boolean {
    return a.configKey === b.configKey;
  }
}
