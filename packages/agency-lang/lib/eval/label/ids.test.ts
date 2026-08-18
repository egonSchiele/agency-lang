import { describe, expect, it } from "vitest";

import { canonicalize } from "@/utils/canonicalize.js";

import { makeChecklistId, makeQuestionId, makeSessionId } from "./ids.js";
import { ChecklistQuestionSchema, FieldNameSchema, type SessionIdentity } from "./types.js";

describe("FieldNameSchema", () => {
  it("accepts a lowercase name with underscores and digits", () => {
    expect(FieldNameSchema.safeParse("review_2").success).toBe(true);
  });

  it("rejects a name carrying a style tag, so a name can never be markup", () => {
    expect(FieldNameSchema.safeParse("bad{name}").success).toBe(false);
  });

  it("rejects a name carrying a control character", () => {
    expect(FieldNameSchema.safeParse("bad\x1b[2Jname").success).toBe(false);
  });

  it("rejects a name starting with a digit or an uppercase letter", () => {
    expect(FieldNameSchema.safeParse("2nd").success).toBe(false);
    expect(FieldNameSchema.safeParse("Output").success).toBe(false);
  });
});

describe("makeSessionId", () => {
  const identity: SessionIdentity = {
    traceIds: ["trace-a", "trace-b"],
    checklistId: "cl_one",
    annotator: { kind: "human", id: "adit" },
  };

  it("is stable for the same session inputs", () => {
    expect(makeSessionId(identity)).toBe(makeSessionId(identity));
  });

  it("depends on trace ORDER, so a reordered directory is a different session", () => {
    const reordered: SessionIdentity = { ...identity, traceIds: ["trace-b", "trace-a"] };
    expect(makeSessionId(identity)).not.toBe(makeSessionId(reordered));
  });

  it("depends on the annotator", () => {
    const other: SessionIdentity = { ...identity, annotator: { kind: "human", id: "someone" } };
    expect(makeSessionId(identity)).not.toBe(makeSessionId(other));
  });

  it("depends on the checklist lineage", () => {
    const other: SessionIdentity = { ...identity, checklistId: "cl_two" };
    expect(makeSessionId(identity)).not.toBe(makeSessionId(other));
  });

  it("is filesystem-safe, because it names a draft file", () => {
    expect(makeSessionId(identity)).toMatch(/^session_[a-f0-9]{64}$/);
  });
});

describe("random entity ids", () => {
  it("are prefixed and unique", () => {
    expect(makeQuestionId()).toMatch(/^q_[A-Za-z0-9_-]+$/);
    expect(makeChecklistId()).toMatch(/^cl_[A-Za-z0-9_-]+$/);
    expect(makeQuestionId()).not.toBe(makeQuestionId());
  });
});

describe("canonicalize", () => {
  it("orders keys at every depth so equal values hash equally", () => {
    expect(canonicalize({ outer: { z: 1, a: 2 } })).toBe(canonicalize({ outer: { a: 2, z: 1 } }));
  });

  it("keeps array order, which is meaningful", () => {
    expect(canonicalize([1, 2])).not.toBe(canonicalize([2, 1]));
  });
});

describe("durable schemas", () => {
  it("rejects a question weight that is zero, negative or not finite", () => {
    const base = { id: "q_a", text: "Accurate?", deleted: false };
    expect(ChecklistQuestionSchema.safeParse({ ...base, weight: 1 }).success).toBe(true);
    expect(ChecklistQuestionSchema.safeParse({ ...base, weight: 0 }).success).toBe(false);
    expect(ChecklistQuestionSchema.safeParse({ ...base, weight: -1 }).success).toBe(false);
    expect(
      ChecklistQuestionSchema.safeParse({ ...base, weight: Number.POSITIVE_INFINITY }).success,
    ).toBe(false);
  });
});

describe("canonicalize is collision-resistant", () => {
  it("does not let a __proto__ key vanish, which would collide with its absence", () => {
    const withProto = JSON.parse('{"__proto__":{"x":1},"a":2}');
    const without = JSON.parse('{"a":2}');
    expect(canonicalize(withProto)).not.toBe(canonicalize(without));
  });

  it("keeps an undefined array element as null, as JSON.stringify does", () => {
    expect(canonicalize([undefined])).toBe("[null]");
  });
});
