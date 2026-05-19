import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  __validateChain,
  __validateChainRecursive,
  type AgencyValidator,
  type TypeValidationDescriptor,
} from "./validateChain.js";
import { success, failure, isFailure, isSuccess } from "./result.js";

const ctx = {};

const isPos: AgencyValidator = async (_c, v) =>
  typeof v === "number" && v > 0 ? success(v) : failure("not positive");
const isEven: AgencyValidator = async (_c, v) =>
  typeof v === "number" && v % 2 === 0 ? success(v) : failure("not even");
const doubleIt: AgencyValidator = async (_c, v) =>
  typeof v === "number" ? success(v * 2) : failure("not number");

describe("__validateChain", () => {
  it("Zod parse passes then validators run in order", async () => {
    const r = await __validateChain(4, z.number(), [isPos, isEven], ctx);
    expect(isSuccess(r)).toBe(true);
  });

  it("returns Zod failure on structural mismatch", async () => {
    const r = await __validateChain("nope", z.number(), [], ctx);
    expect(isFailure(r)).toBe(true);
  });

  it("short-circuits on first validator failure", async () => {
    const later = vi.fn(
      async (_c: unknown, v: unknown) => success(v),
    ) as unknown as AgencyValidator;
    const r = await __validateChain(-1, z.number(), [isPos, later], ctx);
    expect(isFailure(r)).toBe(true);
    expect(later).not.toHaveBeenCalled();
  });

  it("threads transformed value through the chain", async () => {
    // 2 -> double -> 4 -> isEven
    const r = await __validateChain(2, z.number(), [doubleIt, isEven], ctx);
    expect(isSuccess(r)).toBe(true);
    expect((r as { value: number }).value).toBe(4);
  });

  it("forwards an incoming failure unchanged", async () => {
    const f = failure("upstream");
    const r = await __validateChain(f, z.number(), [isPos], ctx);
    expect(r).toBe(f);
  });

  it("empty validator list still runs Zod parse", async () => {
    const r = await __validateChain(3, z.number(), [], ctx);
    expect(isSuccess(r)).toBe(true);
    expect((r as { value: number }).value).toBe(3);
  });
});

describe("__validateChainRecursive", () => {
  it("runs per-element validators across an array", async () => {
    const desc: TypeValidationDescriptor = {
      kind: "array",
      schema: z.array(z.number()),
      validators: [],
      element: { kind: "leaf", schema: z.number(), validators: [isPos] },
    };
    const ok = await __validateChainRecursive([1, 2, 3], desc, ctx);
    expect(isSuccess(ok)).toBe(true);
    const bad = await __validateChainRecursive([1, -2, 3], desc, ctx);
    expect(isFailure(bad)).toBe(true);
  });

  it("recurses into object properties", async () => {
    const desc: TypeValidationDescriptor = {
      kind: "object",
      schema: z.object({ x: z.number() }),
      validators: [],
      properties: {
        x: { kind: "leaf", schema: z.number(), validators: [isEven] },
      },
    };
    expect(isSuccess(await __validateChainRecursive({ x: 4 }, desc, ctx))).toBe(
      true,
    );
    expect(isFailure(await __validateChainRecursive({ x: 5 }, desc, ctx))).toBe(
      true,
    );
  });

  it("dispatches union to matching branch only", async () => {
    const numCalled = vi.fn();
    const strCalled = vi.fn();
    const numV: AgencyValidator = async (_c, v) => {
      numCalled();
      return success(v);
    };
    const strV: AgencyValidator = async (_c, v) => {
      strCalled();
      return success(v);
    };
    const desc: TypeValidationDescriptor = {
      kind: "union",
      schema: z.union([z.number(), z.string()]),
      validators: [],
      branches: [
        {
          test: (v) => typeof v === "number",
          descriptor: { kind: "leaf", schema: z.number(), validators: [numV] },
        },
        {
          test: (v) => typeof v === "string",
          descriptor: { kind: "leaf", schema: z.string(), validators: [strV] },
        },
      ],
    };
    await __validateChainRecursive(7, desc, ctx);
    expect(numCalled).toHaveBeenCalledTimes(1);
    expect(strCalled).not.toHaveBeenCalled();
  });

  it("skips inner validators on null in a nullable", async () => {
    const inner = vi.fn(async (_c: unknown, v: unknown) => success(v));
    const desc: TypeValidationDescriptor = {
      kind: "nullable",
      schema: z.number().nullable(),
      validators: [],
      inner: {
        kind: "leaf",
        schema: z.number(),
        validators: [inner as unknown as AgencyValidator],
      },
    };
    expect(
      isSuccess(await __validateChainRecursive(null, desc, ctx)),
    ).toBe(true);
    expect(inner).not.toHaveBeenCalled();
  });

  it("enforces depth cap", async () => {
    // self-referential descriptor reachable via element
    type Mut = TypeValidationDescriptor & { element?: TypeValidationDescriptor };
    const desc: Mut = {
      kind: "array",
      schema: z.any(),
      validators: [],
      element: undefined as unknown as TypeValidationDescriptor,
    };
    desc.element = desc as TypeValidationDescriptor;

    // Build a value that's 5 levels deep
    let v: unknown = 1;
    for (let i = 0; i < 5; i++) v = [v];

    const r = await __validateChainRecursive(v, desc, ctx, { maxDepth: 3 });
    expect(isFailure(r)).toBe(true);
    expect((r as { error: string }).error).toMatch(/recursion depth/);
  });
});
