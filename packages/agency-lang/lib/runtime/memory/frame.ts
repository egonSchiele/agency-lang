/**
 * Memory frames live on `StateStack.other.memoryFrames`. A frame
 * is the unit of "where memory is configured right now" — pushed
 * by `enableMemory(...)` (or the JSON-seeded bottom frame at
 * `createExecutionContext`), popped by `disableMemory()` or the
 * `memory(){}` block. The active frame is always "top of stack
 * or none."
 *
 * `MemoryFrame` is intentionally small. It carries:
 *  - `configKey`: the absolute, mkdir'd dir. Used both as the
 *    storage location (passed to `getOrCreateStore`) AND as the
 *    cache key for per-execCtx `MemoryManager` lookup. Two pushes
 *    of the same `configKey` are deduped by `StateStack.pushMemoryFrame`,
 *    so process-wide caching is consistent with stack-level identity.
 *  - `config`: the full user-supplied `MemoryConfig`. The manager
 *    needs the auxiliary fields (model, autoExtract, compaction,
 *    embeddings) that don't participate in identity.
 */
import fs from "node:fs";
import path from "node:path";
import type { MemoryConfig } from "./types.js";

export type MemoryFrame = {
  configKey: string;
  config: MemoryConfig;
};

/**
 * Single owner of "user-supplied MemoryConfig → MemoryFrame" policy.
 *
 *  - Resolves `config.dir` against `process.cwd()` (not the module
 *    dir, deliberately — `agency.json`'s `memory.dir` does the same,
 *    so the same string in JSON and in code points at the same
 *    place).
 *  - Auto-creates the directory tree if missing.
 *  - Resolves symlinks via `fs.realpathSync` so two different paths
 *    that point at the same physical dir dedupe through the
 *    process-wide store registry.
 *
 * Throws if `config.dir` is empty.
 */
export function normalizeMemoryFrame(config: MemoryConfig): MemoryFrame {
  if (!config.dir || config.dir.trim() === "") {
    throw new Error("enableMemory: `dir` is required and must be non-empty.");
  }
  const resolved = path.resolve(process.cwd(), config.dir);
  fs.mkdirSync(resolved, { recursive: true });
  const configKey = fs.realpathSync(resolved);
  return { configKey, config };
}
