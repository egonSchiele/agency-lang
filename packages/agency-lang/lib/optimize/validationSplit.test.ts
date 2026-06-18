import { describe, expect, it } from "vitest";
import type { Input } from "@/eval/runTypes.js";
import { splitInputs } from "./validationSplit.js";

const inputs = (n: number): Input[] => Array.from({ length: n }, (_u, i) => ({ id: `i${i}`, args: {} }));

describe("splitInputs", () => {
  it("holds out floor(ratio * n) inputs for validation", () => {
    const { train, validation } = splitInputs(inputs(10), 0.3, 1);
    expect(validation).toHaveLength(3);
    expect(train).toHaveLength(7);
  });

  it("is deterministic for a given seed and partitions without overlap", () => {
    const a = splitInputs(inputs(10), 0.3, 42);
    const b = splitInputs(inputs(10), 0.3, 42);
    expect(a.validation.map((i) => i.id)).toEqual(b.validation.map((i) => i.id));
    const ids = new Set([...a.train, ...a.validation].map((i) => i.id));
    expect(ids.size).toBe(10);
  });

  it("never leaves train empty (keeps at least one) and clamps ratio", () => {
    const { train, validation } = splitInputs(inputs(2), 0.9, 1);
    expect(train.length).toBeGreaterThanOrEqual(1);
    expect(train.length + validation.length).toBe(2);
  });
});
