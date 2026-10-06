import { describe, it, expect } from "vitest";
import {
  estimatedNeed,
  fits,
  LOAD_HEADROOM_BYTES,
  memoryReserve,
  MEMORY_RESERVE_MAX_BYTES,
  parseMeminfo,
  parseVmStat,
} from "./availableMemory.js";

const GIB = 1024 ** 3;

/** `vm_stat` on an Apple Silicon Mac, cut after the lines that matter. */
const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                  9506084.
Pages active:                                2913537.
Pages inactive:                              2945149.
Pages speculative:                             19442.
Pages throttled:                                   0.
Pages wired down:                             507844.
Pages purgeable:                              297684.
`;

const MEMINFO = `MemTotal:       65536000 kB
MemFree:         1234567 kB
MemAvailable:   40000000 kB
Buffers:          123456 kB
`;

describe("parseVmStat", () => {
  it("adds the free, inactive, and speculative pages at the stated page size", () => {
    expect(parseVmStat(VM_STAT)).toBe((9506084 + 2945149 + 19442) * 16384);
  });

  it("reads nothing as zero", () => {
    expect(parseVmStat("")).toBe(0);
  });
});

describe("parseMeminfo", () => {
  it("reads MemAvailable in kB", () => {
    expect(parseMeminfo(MEMINFO)).toBe(40000000 * 1024);
  });
});

describe("estimatedNeed", () => {
  it("adds each kind's headroom to the size on disk, and a draft's size to its model", () => {
    expect(estimatedNeed({ sizeBytes: 10 * GIB, kind: "image" })).toBe(14 * GIB);
    expect(estimatedNeed({ sizeBytes: 10 * GIB, kind: "chat" })).toBe(11 * GIB);
    expect(
      estimatedNeed({ sizeBytes: 10 * GIB, kind: "chat", draft: { sizeBytes: 2 * GIB } }),
    ).toBe(13 * GIB);
    expect(LOAD_HEADROOM_BYTES.image).toBeGreaterThan(LOAD_HEADROOM_BYTES.chat);
  });
});

describe("memoryReserve and fits", () => {
  it("keeps 5% free on a small machine and 2 GiB on a large one", () => {
    expect(memoryReserve({ available: 0, total: 16 * GIB })).toBe(0.8 * GIB);
    expect(memoryReserve({ available: 0, total: 512 * GIB })).toBe(MEMORY_RESERVE_MAX_BYTES);
  });

  it("fits when the need and the reserve both have room", () => {
    const memory = { available: 12 * GIB, total: 512 * GIB };
    expect(fits(10 * GIB, memory)).toBe(true);
    expect(fits(10.5 * GIB, memory)).toBe(false);
  });
});
