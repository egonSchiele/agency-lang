import { describe, expect, it } from "vitest";

import { canonicalize } from "@/utils/canonicalize.js";

import {
  makeAnnotationId,
  makeChecklistId,
  makeOccurrenceId,
  makeOutputId,
  makeQuestionId,
  makeSessionId,
} from "./ids.js";
import {
  AnnotationRowSchema,
  ChecklistQuestionSchema,
  CorpusRowSchema,
  FieldNameSchema,
  ManifestSchema,
  OccurrenceOriginSchema,
  occurrenceLocatorOf,
  type OccurrenceCandidate,
  type SessionIdentity,
} from "./types.js";

const fields = { task: "Summarize", output: "A summary" };

describe("statelog occurrence origin", () => {
  const statelog = (finalOutputIndex: number) =>
    OccurrenceOriginSchema.parse({ kind: "statelog", traceId: "T", finalOutputIndex });

  it("parses a statelog origin", () => {
    expect(statelog(0).kind).toBe("statelog");
  });

  it("leaves the existing run/file/json origins unchanged", () => {
    expect(OccurrenceOriginSchema.parse({ kind: "file", itemKey: "a.txt" }).kind).toBe("file");
    expect(
      OccurrenceOriginSchema.parse({ kind: "json", itemKey: "d.json", itemIndex: 1 }).kind,
    ).toBe("json");
  });

  it("gives one trace two distinct occurrence ids for two different output indexes", () => {
    const base = { outputId: makeOutputId(fields), source: "s" };
    const first = makeOccurrenceId({ ...base, origin: statelog(0) } as OccurrenceCandidate);
    const second = makeOccurrenceId({ ...base, origin: statelog(1) } as OccurrenceCandidate);
    expect(first).not.toBe(second);
  });
});

describe("makeOutputId", () => {
  it("is stable across calls, so re-ingesting is idempotent", () => {
    expect(makeOutputId(fields)).toBe(makeOutputId(fields));
  });

  it("ignores the order fields were added in", () => {
    const reordered = { output: "A summary", task: "Summarize" };
    expect(makeOutputId(reordered)).toBe(makeOutputId(fields));
  });

  it("changes when a value changes", () => {
    expect(makeOutputId({ ...fields, output: "different" })).not.toBe(makeOutputId(fields));
  });

  it("changes when a field NAME changes, because the record shape is content", () => {
    expect(makeOutputId({ task: "Summarize", response: "A summary" })).not.toBe(
      makeOutputId(fields),
    );
  });

  it("distinguishes a missing field from an empty one", () => {
    expect(makeOutputId({ output: "A summary" })).not.toBe(
      makeOutputId({ task: "", output: "A summary" }),
    );
  });

  it("cannot be confused by values that contain a field separator", () => {
    expect(makeOutputId({ a: 'x","b":"y', b: "z" })).not.toBe(makeOutputId({ a: "x", b: "y" }));
  });

  it("produces a filesystem-safe prefixed digest", () => {
    expect(makeOutputId(fields)).toMatch(/^out_[a-f0-9]{64}$/);
  });
});

const occurrence: OccurrenceCandidate = {
  outputId: `out_${"a".repeat(64)}`,
  source: "agent-v1",
  origin: { kind: "file", itemKey: "good-1.txt" },
};

describe("makeOccurrenceId", () => {
  it("is stable across calls", () => {
    expect(makeOccurrenceId(occurrence)).toBe(makeOccurrenceId(occurrence));
  });

  it("separates two files whose contents are equal", () => {
    const other: OccurrenceCandidate = {
      ...occurrence,
      origin: { kind: "file", itemKey: "good-2.txt" },
    };
    expect(makeOccurrenceId(other)).not.toBe(makeOccurrenceId(occurrence));
  });

  it("separates equal elements in two JSON documents", () => {
    const left: OccurrenceCandidate = {
      ...occurrence,
      origin: { kind: "json", itemKey: "a.json", itemIndex: 0 },
    };
    const right: OccurrenceCandidate = {
      ...occurrence,
      origin: { kind: "json", itemKey: "b.json", itemIndex: 0 },
    };
    expect(makeOccurrenceId(left)).not.toBe(makeOccurrenceId(right));
  });

  it("separates the same observation under two source names", () => {
    expect(makeOccurrenceId({ ...occurrence, source: "agent-v2" })).not.toBe(
      makeOccurrenceId(occurrence),
    );
  });

  it("produces a filesystem-safe prefixed digest", () => {
    expect(makeOccurrenceId(occurrence)).toMatch(/^occ_[a-f0-9]{64}$/);
  });
});

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
    outputIds: ["out_a", "out_b"],
    checklistId: "cl_one",
    annotator: { kind: "human", id: "adit" },
  };

  it("is stable for the same session inputs", () => {
    expect(makeSessionId(identity)).toBe(makeSessionId(identity));
  });

  it("depends on output ORDER, so a reordered source is a different session", () => {
    const reordered: SessionIdentity = { ...identity, outputIds: ["out_b", "out_a"] };
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
    expect(makeAnnotationId()).toMatch(/^ann_[A-Za-z0-9_-]+$/);
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
  it("pins the manifest schemaVersion to exactly 2", () => {
    expect(ManifestSchema.safeParse({ schemaVersion: 2, fieldOrder: [] }).success).toBe(true);
    expect(ManifestSchema.safeParse({ schemaVersion: 1, fieldOrder: [] }).success).toBe(false);
  });

  it("rejects unknown keys, so a typo cannot silently persist", () => {
    expect(
      ManifestSchema.safeParse({ schemaVersion: 2, fieldOrder: [], extra: true }).success,
    ).toBe(false);
  });

  it("rejects a manifest field order holding a malformed field name", () => {
    expect(ManifestSchema.safeParse({ schemaVersion: 2, fieldOrder: ["Bad"] }).success).toBe(false);
  });

  it("rejects a question weight that is zero, negative or not finite", () => {
    const base = { id: "q_a", text: "Accurate?", deleted: false };
    expect(ChecklistQuestionSchema.safeParse({ ...base, weight: 1 }).success).toBe(true);
    expect(ChecklistQuestionSchema.safeParse({ ...base, weight: 0 }).success).toBe(false);
    expect(ChecklistQuestionSchema.safeParse({ ...base, weight: -1 }).success).toBe(false);
    expect(
      ChecklistQuestionSchema.safeParse({ ...base, weight: Number.POSITIVE_INFINITY }).success,
    ).toBe(false);
  });

  it("rejects a corpus row whose outputId is not a well-formed digest", () => {
    const row = {
      schemaVersion: 2,
      outputId: "not-an-output-id",
      capturedAt: "2026-08-03T00:00:00.000Z",
      fields: { output: "v" },
    };
    expect(CorpusRowSchema.safeParse(row).success).toBe(false);
  });

  it("rejects a corpus row with no fields, which would be an unjudgeable record", () => {
    const row = {
      schemaVersion: 2,
      outputId: `out_${"a".repeat(64)}`,
      capturedAt: "2026-08-03T00:00:00.000Z",
      fields: {},
    };
    expect(CorpusRowSchema.safeParse(row).success).toBe(false);
  });

  it("rejects an annotation with duplicate covered question ids", () => {
    const row = {
      schemaVersion: 1,
      annotationId: "ann_a",
      outputId: `out_${"a".repeat(64)}`,
      annotator: { kind: "human", id: "adit" },
      checklistId: "cl_a",
      checklistVersion: 1,
      checklistHash: `sha256:${"0".repeat(64)}`,
      createdAt: "2026-08-03T00:00:00.000Z",
      activeMs: 0,
      coveredQuestionIds: ["q_a", "q_a"],
      answers: { q_a: true },
      note: "",
    };
    expect(AnnotationRowSchema.safeParse(row).success).toBe(false);
  });

  it("rejects a negative or non-finite activeMs", () => {
    const base = {
      schemaVersion: 1,
      annotationId: "ann_a",
      outputId: `out_${"a".repeat(64)}`,
      annotator: { kind: "human", id: "adit" },
      checklistId: "cl_a",
      checklistVersion: 1,
      checklistHash: `sha256:${"0".repeat(64)}`,
      createdAt: "2026-08-03T00:00:00.000Z",
      coveredQuestionIds: ["q_a"],
      answers: { q_a: true },
      note: "",
    };
    expect(AnnotationRowSchema.safeParse({ ...base, activeMs: 0 }).success).toBe(true);
    expect(AnnotationRowSchema.safeParse({ ...base, activeMs: -1 }).success).toBe(false);
    expect(AnnotationRowSchema.safeParse({ ...base, activeMs: Number.NaN }).success).toBe(false);
  });
});

describe("canonicalize is collision-resistant", () => {
  it("does not let a __proto__ key vanish, which would collide with its absence", () => {
    const withProto = JSON.parse('{"__proto__":{"x":1},"a":2}');
    const without = JSON.parse('{"a":2}');
    expect(canonicalize(withProto)).not.toBe(canonicalize(without));
  });

  it("gives two records different ids even when they differ only via __proto__", () => {
    const left = makeOutputId(JSON.parse('{"__proto__":{"x":1},"output":"same"}'));
    const right = makeOutputId(JSON.parse('{"output":"same"}'));
    expect(left).not.toBe(right);
  });

  it("keeps an undefined array element as null, as JSON.stringify does", () => {
    expect(canonicalize([undefined])).toBe("[null]");
  });
});

describe("occurrence identity uses only the stable locator", () => {
  const runOrigin = {
    kind: "run" as const,
    traceId: "t-1",
    inputId: "news-01",
    finalOutputIndex: 2,
    runStartedAtMs: 1000,
    models: ["gpt-4o"],
    agent: { file: "news.agency" },
    rawTask: "Summarize",
    rawValue: { s: 1 },
  };
  const base: OccurrenceCandidate = {
    outputId: `out_${"a".repeat(64)}`,
    source: "agent-v1",
    origin: runOrigin,
  };

  it("ignores a corrected model name", () => {
    // Hashing descriptive provenance would make this a SECOND observation of
    // the same execution, and per-source counts would overstate the run.
    expect(makeOccurrenceId({ ...base, origin: { ...runOrigin, models: ["gpt-4o-2024"] } })).toBe(
      makeOccurrenceId(base),
    );
  });

  it("ignores changed agent provenance, start time and raw values", () => {
    expect(
      makeOccurrenceId({
        ...base,
        origin: {
          ...runOrigin,
          agent: { file: "other.agency" },
          runStartedAtMs: 9999,
          rawTask: "changed",
          rawValue: null,
        },
      }),
    ).toBe(makeOccurrenceId(base));
  });

  it("still distinguishes a different execution", () => {
    expect(makeOccurrenceId({ ...base, origin: { ...runOrigin, traceId: "t-2" } })).not.toBe(
      makeOccurrenceId(base),
    );
    expect(makeOccurrenceId({ ...base, origin: { ...runOrigin, finalOutputIndex: 3 } })).not.toBe(
      makeOccurrenceId(base),
    );
  });
});
