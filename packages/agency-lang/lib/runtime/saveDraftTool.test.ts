import { describe, it, expect } from "vitest";
import { z } from "zod";
import { AgencyFunction } from "./agencyFunction.js";
import { findIntrinsic } from "./intrinsicTools.js";
import { saveDraftIntrinsic, draftCharCount } from "./saveDraftTool.js";

function fakeFn(name: string, module: string): AgencyFunction {
  return new AgencyFunction({
    name,
    module,
    fn: () => null,
    params: [
      {
        name: "value",
        hasDefault: false,
        defaultValue: undefined,
        variadic: false,
      } as any,
    ],
    toolDefinition: { name, description: "d", schema: z.object({}) },
  });
}

/** A stack stub that records draft writes — handle() only ever calls
 *  setSavedDraft, and the real frame math is fixture-tested. */
function stubStack() {
  const saved: unknown[] = [];
  return {
    saved,
    stack: { setSavedDraft: (v: unknown) => saved.push(v) } as any,
  };
}

function call(args: Record<string, unknown> | undefined) {
  return { id: "t1", name: "saveDraft", arguments: args as any };
}

describe("saveDraft intrinsic — recognition", () => {
  it("the registry finds the stdlib pair (name + module)", () => {
    expect(findIntrinsic(fakeFn("saveDraft", "stdlib/index.agency"))).toBe(
      saveDraftIntrinsic,
    );
  });

  it("a user function named saveDraft is NOT recognized", () => {
    expect(findIntrinsic(fakeFn("saveDraft", "my/module.agency"))).toBeUndefined();
  });

  it("a stdlib function with another name is NOT recognized", () => {
    expect(findIntrinsic(fakeFn("finalize", "stdlib/index.agency"))).toBeUndefined();
  });

  it("a renamed stdlib saveDraft IS recognized — registeredName survives .rename() (#654)", () => {
    const renamed = fakeFn("saveDraft", "stdlib/index.agency").rename("save_progress");
    expect(findIntrinsic(renamed)).toBe(saveDraftIntrinsic);
  });

  it("a renamed tool advertises its renamed name, so dispatch and the model agree", () => {
    const renamed = fakeFn("saveDraft", "stdlib/index.agency").rename("save_progress");
    const def = saveDraftIntrinsic.buildDefinition({ draftSchema: undefined, fn: renamed });
    expect(def.name).toBe("save_progress");
  });
});

describe("saveDraft intrinsic — synthesized definition", () => {
  it("declares exactly one required value param from the threaded schema", () => {
    const def = saveDraftIntrinsic.buildDefinition({ draftSchema: z.number(), fn: fakeFn("saveDraft", "stdlib/index.agency") });
    expect(def.name).toBe("saveDraft");
    expect(def.description).toMatch(/best-so-far/);
    const schema = def.schema as z.ZodObject<any>;
    expect(Object.keys(schema.shape)).toEqual(["value"]);
    expect(schema.shape.value.safeParse(3).success).toBe(true);
    expect(schema.shape.value.safeParse("x").success).toBe(false);
  });

  it("falls back to string when no schema was threaded", () => {
    const def = saveDraftIntrinsic.buildDefinition({ draftSchema: undefined, fn: fakeFn("saveDraft", "stdlib/index.agency") });
    const schema = def.schema as z.ZodObject<any>;
    expect(schema.shape.value.safeParse("x").success).toBe(true);
    expect(schema.shape.value.safeParse(3).success).toBe(false);
  });
});

describe("saveDraft intrinsic — handle (validation semantics)", () => {
  it("a matching value saves and acks with the char count", () => {
    const { saved, stack } = stubStack();
    const ack = saveDraftIntrinsic.handle({
      toolCall: call({ value: "hello" }),
      stateStack: stack,
      draftSchema: z.string(),
    });
    expect(saved).toEqual(["hello"]);
    expect(ack).toBe("Draft saved (5 characters).");
  });

  it("a missing value is an error and saves NOTHING", () => {
    const { saved, stack } = stubStack();
    const ack = saveDraftIntrinsic.handle({
      toolCall: call({}),
      stateStack: stack,
      draftSchema: z.string(),
    });
    expect(saved).toEqual([]);
    expect(ack).toMatch(/requires a "value" argument/);
  });

  it("a schema-mismatched value SAVES ANYWAY and acks with a helpful warning", () => {
    // The schema is a best-effort hint keyed to the declared function
    // type; the actual slot (a guard block) can legitimately differ.
    // Refusing the save could throw away real work on a wrong hint, so
    // the draft is kept and the warning teaches the model.
    const { saved, stack } = stubStack();
    const ack = saveDraftIntrinsic.handle({
      toolCall: call({ value: 42 }),
      stateStack: stack,
      draftSchema: z.string(),
    });
    expect(saved).toEqual([42]);
    expect(ack).toMatch(/^Draft saved \(\d+ characters\)\. Warning:/);
    expect(ack).toMatch(/does not match/);
  });
});

describe("draftCharCount", () => {
  it("counts string drafts directly", () => {
    expect(draftCharCount("hello")).toBe(5);
  });
  it("counts structured drafts by their JSON length", () => {
    expect(draftCharCount({ a: 1 })).toBe(JSON.stringify({ a: 1 }).length);
  });
  it("returns 0 for undefined (JSON.stringify yields undefined there)", () => {
    expect(draftCharCount(undefined)).toBe(0);
  });
  it("returns 0 instead of throwing on a circular value (exported-helper claim)", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(draftCharCount(circular)).toBe(0);
  });
});
