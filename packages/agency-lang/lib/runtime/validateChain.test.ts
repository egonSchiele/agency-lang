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

const isPos: AgencyValidator = async (v) =>
  typeof v === "number" && v > 0 ? success(v) : failure("not positive");
const isEven: AgencyValidator = async (v) =>
  typeof v === "number" && v % 2 === 0 ? success(v) : failure("not even");
const doubleIt: AgencyValidator = async (v) =>
  typeof v === "number" ? success(v * 2) : failure("not number");

describe("__validateChain", () => {
  it("Zod parse passes then validators run in order", async () => {
    const r = await __validateChain(4, z.number(), [isPos, isEven]);
    expect(isSuccess(r)).toBe(true);
  });

  it("returns Zod failure on structural mismatch", async () => {
    const r = await __validateChain("nope", z.number(), []);
    expect(isFailure(r)).toBe(true);
  });

  it("short-circuits on first validator failure", async () => {
    const later = vi.fn(
      async (v: unknown) => success(v),
    ) as unknown as AgencyValidator;
    const r = await __validateChain(-1, z.number(), [isPos, later]);
    expect(isFailure(r)).toBe(true);
    expect(later).not.toHaveBeenCalled();
  });

  it("threads transformed value through the chain", async () => {
    // 2 -> double -> 4 -> isEven
    const r = await __validateChain(2, z.number(), [doubleIt, isEven]);
    expect(isSuccess(r)).toBe(true);
    expect((r as { value: number }).value).toBe(4);
  });

  it("forwards an incoming failure unchanged", async () => {
    const f = failure("upstream");
    const r = await __validateChain(f, z.number(), [isPos]);
    expect(r).toBe(f);
  });

  it("empty validator list still runs Zod parse", async () => {
    const r = await __validateChain(3, z.number(), []);
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
    const ok = await __validateChainRecursive([1, 2, 3], desc);
    expect(isSuccess(ok)).toBe(true);
    const bad = await __validateChainRecursive([1, -2, 3], desc);
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
    expect(isSuccess(await __validateChainRecursive({ x: 4 }, desc))).toBe(
      true,
    );
    expect(isFailure(await __validateChainRecursive({ x: 5 }, desc))).toBe(
      true,
    );
  });

  it("dispatches union to matching branch only", async () => {
    const numCalled = vi.fn();
    const strCalled = vi.fn();
    const numV: AgencyValidator = async (v) => {
      numCalled();
      return success(v);
    };
    const strV: AgencyValidator = async (v) => {
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
    await __validateChainRecursive(7, desc);
    expect(numCalled).toHaveBeenCalledTimes(1);
    expect(strCalled).not.toHaveBeenCalled();
  });

  it("skips inner validators on null in a nullable", async () => {
    const inner = vi.fn(async (v: unknown) => success(v));
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
      isSuccess(await __validateChainRecursive(null, desc)),
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

    const r = await __validateChainRecursive(v, desc, { maxDepth: 3 });
    expect(isFailure(r)).toBe(true);
    const err = (r as { error: { reason: string; limit: number; kind: string; valuePreview: unknown } }).error;
    expect(err.reason).toMatch(/recursion depth/);
    expect(err.limit).toBe(3);
    expect(err.kind).toBe("array");
    expect(typeof err.valuePreview === "string").toBe(true);
  });
});

describe("ref descriptors (deferred reads for recursive/forward aliases)", () => {
  it("resolves a self-referential ref at walk time and validates every level", async () => {
    // Mirrors the emitted shape for `type Tree = { @validate(pos) value,
    // children: Tree[] }`: the array element is a ref whose get() reads the
    // completed descriptor — the eager-read emission this replaced saw
    // `undefined` mid-assignment and nested validation vanished.
    const isPositive: AgencyValidator = async (v) =>
      typeof v === "number" && v > 0
        ? success(v)
        : failure("must be positive");
    const treeSchema: z.ZodType = z.object({
      value: z.number(),
      children: z.array(z.lazy(() => treeSchema)),
    });
    const tree: TypeValidationDescriptor = {
      kind: "object",
      schema: treeSchema,
      validators: [],
      properties: {
        value: { kind: "leaf", schema: z.number(), validators: [isPositive] },
        children: {
          kind: "array",
          schema: z.array(z.lazy(() => treeSchema)),
          validators: [],
          element: { kind: "ref", get: () => tree },
        },
      },
    };
    const ok = await __validateChainRecursive(
      { value: 1, children: [{ value: 2, children: [] }] },
      tree,
    );
    expect(isSuccess(ok)).toBe(true);
    const bad = await __validateChainRecursive(
      { value: 1, children: [{ value: -5, children: [] }] },
      tree,
    );
    expect(isFailure(bad)).toBe(true);
  });

  it("use-site validators merged onto the resolved descriptor still run through a ref", async () => {
    // The emitter wraps use-site validators INSIDE get() (the walker
    // dispatches ref before running validators). Simulate that shape.
    const rejectAll: AgencyValidator = async () => failure("nope");
    const leaf: TypeValidationDescriptor = {
      kind: "leaf",
      schema: z.number(),
      validators: [],
    };
    const ref: TypeValidationDescriptor = {
      kind: "ref",
      get: () => ({ ...leaf, validators: [rejectAll] }),
    };
    expect(isFailure(await __validateChainRecursive(1, ref))).toBe(true);
  });

  it("depth cap still bounds a cyclic ref walk", async () => {
    // A degenerate always-recursing descriptor must hit maxDepth, not hang.
    const selfRef: TypeValidationDescriptor = {
      kind: "ref",
      get: () => wrapper,
    };
    const wrapper: TypeValidationDescriptor = {
      kind: "object",
      schema: z.any(),
      validators: [],
      properties: { next: selfRef },
    };
    const deep: { next?: unknown } = {};
    let cursor = deep;
    for (let i = 0; i < 200; i++) {
      cursor.next = {};
      cursor = cursor.next as { next?: unknown };
    }
    const r = await __validateChainRecursive(deep, wrapper, { maxDepth: 16 });
    expect(isFailure(r)).toBe(true);
  });
});
