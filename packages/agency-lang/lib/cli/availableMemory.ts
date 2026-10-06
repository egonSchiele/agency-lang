import * as os from "node:os";
import * as fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ServeKind } from "./localServe.js";

/** How `agency local serve` decides whether a model fits in memory before
 *  it loads one on demand. */

const execute = promisify(execFile);

export type MemorySnapshot = { available: number; total: number };

const GIB = 1024 ** 3;

/** The memory kept free when a model is loaded: the smaller of this and
 *  `MEMORY_RESERVE_FRACTION` of the machine's memory. */
export const MEMORY_RESERVE_MAX_BYTES = 2 * GIB;
export const MEMORY_RESERVE_FRACTION = 0.05;

/** Memory a model needs beyond its size on disk, by kind. An image model
 *  holds the intermediate pictures of every step; the others hold little
 *  beyond their weights and a prompt cache. */
export const LOAD_HEADROOM_BYTES: Record<ServeKind, number> = {
  chat: 1 * GIB,
  embedding: 1 * GIB,
  speech: 1 * GIB,
  image: 4 * GIB,
  vision: 1 * GIB,
  controlnet: 1 * GIB,
};

/** The bytes macOS could give a new process, from the text `vm_stat`
 *  prints: the free, inactive, and speculative pages, times the page size
 *  in the first line. */
export function parseVmStat(text: string): number {
  const pageSize = Number(/page size of (\d+) bytes/.exec(text)?.[1] ?? 4096);
  const pages = ["free", "inactive", "speculative"].reduce(
    (total, kind) => total + Number(new RegExp(`Pages ${kind}:\\s+(\\d+)`).exec(text)?.[1] ?? 0),
    0,
  );
  return pages * pageSize;
}

/** The bytes Linux could give a new process, from `/proc/meminfo`, which
 *  states `MemAvailable` in kB. */
export function parseMeminfo(text: string): number {
  return Number(/MemAvailable:\s+(\d+)/.exec(text)?.[1] ?? 0) * 1024;
}

/** The memory available now, and the machine's total. On an error the
 *  error is logged and `os.freemem()` stands in, which counts only pages
 *  nothing has touched and so reads low. */
export async function availableMemory(log: (line: string) => void): Promise<MemorySnapshot> {
  const total = os.totalmem();
  try {
    if (os.platform() === "darwin") {
      const { stdout } = await execute("vm_stat");
      return { available: parseVmStat(stdout), total };
    }
    if (os.platform() === "linux") {
      return { available: parseMeminfo(fs.readFileSync("/proc/meminfo", "utf8")), total };
    }
  } catch (err) {
    log(`Could not read the available memory: ${(err as Error).message}`);
  }
  return { available: os.freemem(), total };
}

export function memoryReserve(memory: MemorySnapshot): number {
  return Math.min(MEMORY_RESERVE_MAX_BYTES, memory.total * MEMORY_RESERVE_FRACTION);
}

/** What `estimatedNeed` reads of a planned model. */
export type SizedModel = { sizeBytes: number; kind: ServeKind; draft?: { sizeBytes: number } };

/** The memory loading a model is expected to take: its size on disk, its
 *  draft's, and its kind's headroom. */
export function estimatedNeed(model: SizedModel): number {
  return model.sizeBytes + (model.draft?.sizeBytes ?? 0) + LOAD_HEADROOM_BYTES[model.kind];
}

/** Whether a model that needs `needBytes` can load now and leave the
 *  reserve free. */
export function fits(needBytes: number, memory: MemorySnapshot): boolean {
  return memory.available >= needBytes + memoryReserve(memory);
}
