import { describe, expect, it, vi } from "vitest";
import { parseShardSpec, partitionByShard, type Shard } from "./test.js";

const id = (s: string) => s;

// Collect the union of every shard's slice for an N-way split.
function unionAllShards(items: string[], total: number): string[] {
  const seen: string[] = [];
  for (let index = 1; index <= total; index++) {
    seen.push(...partitionByShard(items, { index, total }, id));
  }
  return seen;
}

describe("partitionByShard", () => {
  it("covers every item exactly once across all shards (13 items / 4 shards)", () => {
    const items = Array.from({ length: 13 }, (_, i) => `f${i}`);
    const union = unionAllShards(items, 4).sort();
    // No item dropped and none run twice: the union equals the input set.
    expect(union).toEqual([...items].sort());
    expect(union.length).toBe(13);
  });

  it("splits 13 items / 4 shards into sizes 4,3,3,3", () => {
    const items = Array.from({ length: 13 }, (_, i) => `f${i}`);
    const sizes = [1, 2, 3, 4].map(
      (index) => partitionByShard(items, { index, total: 4 }, id).length,
    );
    expect(sizes).toEqual([4, 3, 3, 3]);
  });

  it("keeps shards disjoint", () => {
    const items = Array.from({ length: 50 }, (_, i) => `f${i}`);
    const slices = [1, 2, 3, 4, 5].map((index) =>
      new Set(partitionByShard(items, { index, total: 5 }, id)),
    );
    for (let a = 0; a < slices.length; a++) {
      for (let b = a + 1; b < slices.length; b++) {
        const overlap = [...slices[a]].filter((x) => slices[b].has(x));
        expect(overlap).toEqual([]);
      }
    }
  });

  it("handles more shards than items (some shards empty, none dropped)", () => {
    const items = ["a", "b", "c"];
    const union = unionAllShards(items, 6).sort();
    expect(union).toEqual(["a", "b", "c"]);
    // Shard 4/6, 5/6, 6/6 get nothing; 1..3 each get one.
    expect(partitionByShard(items, { index: 6, total: 6 }, id)).toEqual([]);
  });

  it("is deterministic regardless of input order", () => {
    const items = ["m", "a", "z", "c", "b"];
    const shard: Shard = { index: 1, total: 2 };
    const shuffled = ["z", "b", "m", "c", "a"];
    expect(partitionByShard(items, shard, id)).toEqual(
      partitionByShard(shuffled, shard, id),
    );
  });

  it("a single shard of 1 returns everything", () => {
    const items = ["a", "b", "c"];
    expect(partitionByShard(items, { index: 1, total: 1 }, id).sort()).toEqual([
      "a",
      "b",
      "c",
    ]);
  });
});

describe("parseShardSpec", () => {
  it("parses a well-formed spec", () => {
    expect(parseShardSpec("2/4")).toEqual({ index: 2, total: 4 });
    expect(parseShardSpec(" 1/1 ")).toEqual({ index: 1, total: 1 });
  });

  it("rejects malformed or out-of-range specs", () => {
    // The real process.exit halts execution; make the mock throw so control
    // stops at the exit call the way it would in production.
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const bad of ["abc", "3/2", "0/4", "4", "4/0", "-1/4"]) {
      expect(() => parseShardSpec(bad)).toThrow("exit");
      expect(exit).toHaveBeenCalledWith(1);
      exit.mockClear();
    }
    vi.restoreAllMocks();
  });
});
