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
const halveIt: AgencyValidator = async (v) =>
  typeof v === "number" ? success(v / 2) : failure("not number");

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
    const later = vi.fn(async (v: unknown) => success(v)) as unknown as AgencyValidator;
    const r = await __validateChain(-1, z.number(), [isPos, later]);
    expect(isFailure(r)).toBe(true);
    expect(later).not.toHaveBeenCalled();
  });

  it("a transform-and-back chain throws: the contract check is per-validator", async () => {
    // 2 -> double -> 4 -> halve -> 2. An end-of-chain identity check would
    // see the input come back and pass; the per-validator check must throw
    // at the first link.
    await expect(__validateChain(2, z.number(), [doubleIt, halveIt])).rejects.toThrow(
      /validator 'doubleIt' modified the value/,
    );
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
    expect(isSuccess(await __validateChainRecursive({ x: 4 }, desc))).toBe(true);
    expect(isFailure(await __validateChainRecursive({ x: 5 }, desc))).toBe(true);
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
    expect(isSuccess(await __validateChainRecursive(null, desc))).toBe(true);
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
    const err = (
      r as { error: { reason: string; limit: number; kind: string; valuePreview: unknown } }
    ).error;
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
      typeof v === "number" && v > 0 ? success(v) : failure("must be positive");
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

  it("a pure ref -> ref cycle fails on the consecutive-hop cap instead of hanging", async () => {
    // Codegen rejects the alias shapes that emit this, but runtime
    // termination must not depend on that guard staying airtight.
    const a: TypeValidationDescriptor = { kind: "ref", get: () => b };
    const b: TypeValidationDescriptor = { kind: "ref", get: () => a };
    const r = await __validateChainRecursive(1, a);
    expect(isFailure(r)).toBe(true);
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

describe("record descriptor kind (#630)", () => {
  const ageDesc: TypeValidationDescriptor = {
    kind: "leaf",
    schema: z.number(),
    validators: [isPos],
  };
  const recordDesc: TypeValidationDescriptor = {
    kind: "record",
    schema: z.record(z.string(), z.number()),
    validators: [],
    value: ageDesc,
  };

  it("runs the value descriptor validators per entry", async () => {
    const ok = await __validateChainRecursive({ a: 1, b: 2 }, recordDesc);
    expect(isSuccess(ok)).toBe(true);
    const bad = await __validateChainRecursive({ a: 1, b: -5 }, recordDesc);
    expect(isFailure(bad)).toBe(true);
  });

  it("a modifying value-validator throws OUT of the recursive walk", async () => {
    // Was the write-back pin. The predicate contract retires write-back, and
    // the throw must escape __validateChainRecursive uncaught: that escape is
    // what makes the error visible from every caller (bang, patterns, is,
    // structured LLM output).
    const doublingDesc: TypeValidationDescriptor = {
      kind: "record",
      schema: z.record(z.string(), z.number()),
      validators: [],
      value: { kind: "leaf", schema: z.number(), validators: [doubleIt] },
    };
    await expect(__validateChainRecursive({ a: 1, b: 2 }, doublingDesc)).rejects.toThrow(
      /validator 'doubleIt' modified the value/,
    );
  });

  it("nested records validate through both levels", async () => {
    const nested: TypeValidationDescriptor = {
      kind: "record",
      schema: z.record(z.string(), z.record(z.string(), z.number())),
      validators: [],
      value: recordDesc,
    };
    expect(isSuccess(await __validateChainRecursive({ x: { a: 1 } }, nested))).toBe(true);
    expect(isFailure(await __validateChainRecursive({ x: { a: -1 } }, nested))).toBe(true);
  });

  it("record own validators run before per-entry walks", async () => {
    const nonEmpty: AgencyValidator = async (v) =>
      Object.keys(v as object).length > 0 ? success(v) : failure("empty record");
    const withOwn: TypeValidationDescriptor = {
      kind: "record",
      schema: z.record(z.string(), z.number()),
      validators: [nonEmpty],
      value: ageDesc,
    };
    expect(isFailure(await __validateChainRecursive({}, withOwn))).toBe(true);
    expect(isSuccess(await __validateChainRecursive({ a: 1 }, withOwn))).toBe(true);
  });

  it("record inside a ref resolves and validates", async () => {
    const viaRef: TypeValidationDescriptor = {
      kind: "ref",
      get: () => recordDesc,
    };
    expect(isFailure(await __validateChainRecursive({ a: -1 }, viaRef))).toBe(true);
  });
});

describe("record walker prototype safety", () => {
  it("stores a user-supplied __proto__ key as an own entry, never the prototype", async () => {
    // Zod's z.record drops own __proto__ keys, so reach the walker with a
    // permissive schema (as a ref-carried descriptor could) to prove the
    // walker is safe on its own.
    const permissiveRecord: TypeValidationDescriptor = {
      kind: "record",
      schema: z.any(),
      validators: [],
      value: { kind: "leaf", schema: z.number(), validators: [] },
    };
    const hostile = JSON.parse('{"__proto__": 7, "a": 1}');
    const r = await __validateChainRecursive(hostile, permissiveRecord);
    expect(isSuccess(r)).toBe(true);
    const out = (r as { value: Record<string, unknown> }).value;
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.getOwnPropertyNames(out).sort()).toEqual(["__proto__", "a"]);
    expect(Object.getOwnPropertyDescriptor(out, "__proto__")?.value).toBe(7);
  });
});

describe("the predicate contract (validators may not modify the value)", () => {
  it("a pass-through validator is unchanged, same-reference object included", async () => {
    const passRef: AgencyValidator = async (v) => success(v);
    const obj = { a: 1 };
    const r = await __validateChain(obj, z.any(), [passRef]);
    expect(isSuccess(r)).toBe(true);
  });

  it("a modifying validator throws, naming it", async () => {
    await expect(__validateChain(2, z.number(), [doubleIt])).rejects.toThrow(
      /validator 'doubleIt' modified the value/,
    );
  });

  it("a rebuilt-equal object counts as modification (identity, not equality)", async () => {
    const rebuild: AgencyValidator = async (v) => success({ ...(v as object) });
    await expect(__validateChain({ a: 1 }, z.any(), [rebuild])).rejects.toThrow(
      /modified the value/,
    );
  });

  it("success() with no value counts as modification", async () => {
    const emptyHanded: AgencyValidator = async () => success(undefined);
    await expect(__validateChain(1, z.number(), [emptyHanded])).rejects.toThrow(
      /modified the value/,
    );
  });

  it("a NaN pass-through does NOT throw (Object.is, not !==)", async () => {
    const passNaN: AgencyValidator = async (v) => success(v);
    const r = await __validateChain(NaN, z.any(), [passNaN]);
    expect(isSuccess(r)).toBe(true);
  });

  it("an anonymous validator reports (anonymous)", async () => {
    await expect(
      __validateChain(1, z.number(), [async (v) => success((v as number) + 1)]),
    ).rejects.toThrow(/validator '\(anonymous\)' modified the value/);
  });
});
